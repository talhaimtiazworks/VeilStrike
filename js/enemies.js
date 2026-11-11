/**
 * enemies.js
 * Hostile AI for the facility: members of the fictional private security
 * contractor "ARGUS GROUP" (original faction — no real-world organisation).
 *
 * State machine:
 *   PATROL → SUSPICIOUS → INVESTIGATE → COMBAT ⇄ (TAKE COVER / REPOSITION)
 *          → PLAYER LOST → SEARCH → PATROL
 *
 * Perception is imperfect by design: field-of-view cone, distance falloff,
 * line-of-sight occlusion checks, hearing events with radius + precision,
 * last-known-position memory and bounded search. Squad reports use delayed,
 * approximate local radio messages and cover spacing so actors do not share
 * live coordinates, clump or act identically.
 */
import * as THREE from 'three';
import { rayAABBLocal } from './physics.js';
import {
  BODY_STATE, IMPACT_TUNE, applyImpact, bodyModifiers, clearContacts, initImpactState,
  processMoveContacts, syncActorBody, tickBodyState, unregisterActorBody,
} from './impacts.js';
import { buildSoldierModel, poseSoldierArms, disposeSoldierModel, stepFallbackGait } from './enemy-soldier.js';
import { attachSoldierRig } from './soldier-rig.js';

// States in which a soldier is not yet reacting to a threat.
const CALM_STATES = new Set(['patrol', 'wander', 'suspicious', 'recovering']);

/**
 * Perception tuning (Phase-1 fix). These were hard-coded and far too slow: a
 * stationary operator standing in the open, 18 m in front of a rifleman with
 * nothing between them, took 6.5 s to be recognised — and at 55 m was never
 * recognised at all, because the accrual rate fell off linearly with range and
 * the "sees you" threshold (0.84) was *higher* than the "raise the alarm"
 * threshold (0.98). Soldiers therefore wandered while clearly in contact.
 *
 * Every value is multiplied by the per-archetype `sense` and the difficulty's
 * `detection`, so the campaign knobs still do what they say.
 */
/**
 * Locomotion tuning (Phase-2 fix). Steering used to write the *desired*
 * velocity straight into `_wish`, so a soldier went 0 → full speed in one
 * frame (the "sliding / walking on the spot" look, because the rig's legs chase
 * collision-resolved travel) and turned at up to 6.5 rad/s even while simply
 * patrolling. Rates are m/s² and rad/s.
 */
export const AI_MOVE = {
  ACCEL: 7.5,               // m/s² ramp up to the commanded speed
  DECEL: 10.5,              // m/s² ramp down (arrivals and stops)
  CALM_TURN: 2.4,           // rad/s while patrolling / loitering / searching
  ALERT_TURN: 3.6,          // rad/s while alerted and moving to contact
  COMBAT_TURN: 6.0,         // rad/s — tracking a visible target may be quick
  REVERSAL_DWELL: 0.35,     // s spent slowing down before a >135° heading flip
};

export const AI_SENSE = {
  BASE_GAIN: 1.55,          // detection units/s for a mid-range, in-cone, standing target
  RANGE_MIN: 0.34,          // accrual never falls below this fraction of BASE_GAIN
  RANGE_DECAY: 0.72,        // linear range term: 1.12 − 0.72·(d/visionRange)
  PERIPHERAL_GAIN: 0.5,     // clear sight line but outside the FOV cone
  BLIND_GAIN: 0.16,         // outside the cone and beyond peripheral sense
  SCAN_TURN: 0.85,          // rad/s "something moved" body scan for far-off-axis cues
  NEAR_VISIBLE_DIST: 8,     // closer than this and in the open: noticed anyway
  NEAR_VISIBLE_GAIN: 0.8,
  OBVIOUS_DIST: 0.5,        // × vision range: an active target here counts as seen
  OBVIOUS_GAIN: 0.85,
  GLANCE_MIN_DETECTION: 0.12,
  LOS_FLOOR: 0.8,           // clear sight line ⇒ eventually noticed, any angle
  NEAR_FLOOR: 0.9,          // up close, LOW SIGNATURE cannot make you invisible
  SPOT_THRESHOLD: 0.62,     // recognition — the ONE threshold for seeing and reacting
  RECALL_THRESHOLD: 0.21,   // once engaged, memory keeps tracking at a lower bar
  ALARM_THRESHOLD: 0.92,    // squad broadcast / alarm escalation level
  REFLEX_TURN: 2.3,         // rad/s spent turning to look at a peripheral cue
  REFLEX_ARC: 1.9,          // × the half-FOV, how far off-axis still earns a glance
};

// Skinned-soldier presentation per palette (multiplied over the CC0 camo
// texture; all dark, muted, never yellow) — the procedural rig stays the
// invisible gameplay/logic rig and the visible fallback if the asset fails.
const RIG_TINTS = [0xffffff, 0xd6ccbc, 0xa2a8ad, 0xaeb7a4, 0xd0c6a8];
function rigColors(mats) {
  const hex = (m, d) => (m && m.color ? m.color.getHex() : d);
  return {
    armor: hex(mats.armor, 0x34372f), webbing: hex(mats.webbing, 0x22251f), cloth: hex(mats.cloth, 0x44483a),
    dark: hex(mats.dark, 0x1c1e20), pack: hex(mats.pack, 0x30352e), visor: 0x14191b,
  };
}
function disposeActorModel(actor) {
  if (actor.rig) { actor.rig.dispose(); actor.rig = null; }
  if (actor.game && actor.game.physics) unregisterActorBody(actor.game.physics, actor);
  disposeSoldierModel(actor.model);
}

const DEG = Math.PI / 180;
const GRAVITY = 16;
// Phase 17 (P3): garrison density per map grew strongly (urban 46, rural 71)
// so the global live cap moves up too — but it stays the SIM_ONLY guardrail:
// spawns are still throttled by destination-free-checks and surge pacing, so
// the AI/physics subsystems never face a worst-case swarm they can't afford.
// A smaller live combat budget reduces simultaneous incoming fire. The
// per-mission lifetime spawn limits (30 / 40) remain separately enforced.
const MAX_ACTIVE_HOSTILES = 12;
const MAX_PENDING_SURGES = 24;
const MIN_INITIAL_SPAWN_DISTANCE = 22;
const MIN_SURGE_SPAWN_DISTANCE = 45;

const ZONE_MULT = { head: 4.0, torso: 1.0, arms: 0.7, legs: 0.6 };

// Six readable roles with distinct kit, doctrine, perception, mobility and
// weapon handling. Values multiply the selected game difficulty, not damage
// alone. Legacy world hints are mapped below so old mission spawns remain valid.
const ARCHETYPES = Object.freeze({
  rifleman: { label: 'RIFLEMAN', vision: 62, fov: 108, sense: 1, hearing: 1, skill: 1, reaction: 1, spread: 1, aggression: 0.52, speed: 1, armor: 12, mag: 30, reserve: 90, reload: 1.85, burst: 3, morale: 1, weapon: 'rifle', kit: 'line' },
  assault:  { label: 'ASSAULT', vision: 56, fov: 102, sense: 0.98, hearing: 1.08, skill: 0.98, reaction: 0.82, spread: 1.16, aggression: 0.84, speed: 1.04, armor: 8, mag: 30, reserve: 75, reload: 1.62, burst: 4, morale: 1.18, weapon: 'smg', kit: 'light' },
  breacher: { label: 'BREACHER', vision: 48, fov: 100, sense: 0.96, hearing: 1.14, skill: 0.92, reaction: 0.84, spread: 1.28, aggression: 0.80, speed: 0.98, armor: 20, mag: 8, reserve: 40, reload: 2.35, burst: 1, morale: 1.05, weapon: 'shotgun', kit: 'armored' },
  heavy:    { label: 'HEAVY', vision: 56, fov: 96, sense: 0.92, hearing: 0.96, skill: 0.98, reaction: 1.12, spread: 1.06, aggression: 0.55, speed: 0.68, armor: 42, mag: 60, reserve: 120, reload: 3.0, burst: 7, morale: 0.62, weapon: 'lmg', kit: 'heavy' },
  recon:    { label: 'RECON', vision: 82, fov: 128, sense: 1.24, hearing: 1.22, skill: 1.05, reaction: 0.82, spread: 0.96, aggression: 0.48, speed: 1.08, armor: 2, mag: 30, reserve: 75, reload: 1.7, burst: 3, morale: 1.24, weapon: 'smg', kit: 'recon' },
  marksman: { label: 'MARKSMAN', vision: 105, fov: 118, sense: 1.18, hearing: 1.08, skill: 1.18, reaction: 1.26, spread: 0.52, aggression: 0.32, speed: 0.74, armor: 10, mag: 10, reserve: 40, reload: 2.4, burst: 1, morale: 0.92, weapon: 'marksman', kit: 'marksman' },
  leader:   { label: 'SQUAD LEADER', vision: 74, fov: 120, sense: 1.12, hearing: 1.2, skill: 1.08, reaction: 0.9, spread: 0.88, aggression: 0.58, speed: 0.96, armor: 18, mag: 30, reserve: 90, reload: 1.9, burst: 3, morale: 1.16, weapon: 'rifle', kit: 'radio' },
});
const ARCHETYPE_ROSTER = ['rifleman', 'assault', 'rifleman', 'recon', 'marksman', 'heavy', 'leader'];
const ARCHETYPE_ALIASES = Object.freeze({ defender: 'rifleman', scout: 'recon', support: 'heavy', commander: 'leader', guard: null, patrol: null, surge: null, breacher: 'assault' });

const WEAPON_PROFILES = Object.freeze({
  rifle:    { cadence: 0.22, range: 92, damage: 12, spread: 1.0, audio: 'vx4', burstPause: [1.2, 2.4], pellets: 1 },
  smg:      { cadence: 0.15, range: 52, damage: 8.5, spread: 1.28, audio: 'mpx5', burstPause: [1.0, 1.8], pellets: 1 },
  lmg:      { cadence: 0.17, range: 78, damage: 9, spread: 1.12, audio: 'lb9', burstPause: [1.5, 2.8], pellets: 1 },
  marksman: { cadence: 1.15, range: 125, damage: 22, spread: 0.48, audio: 'mr7', burstPause: [1.4, 2.6], pellets: 1 },
  shotgun:  { cadence: 1.0, range: 31, damage: 3.2, spread: 3.6, audio: 'st12', burstPause: [1.5, 2.5], pellets: 8 },
});

const MISSION_ROLE_PLANS = Object.freeze({
  infiltration: ['rifleman', 'recon', 'assault', 'marksman', 'rifleman', 'heavy', 'leader'],
  recon: ['recon', 'marksman', 'recon', 'rifleman', 'leader', 'assault'],
  assault: ['rifleman', 'heavy', 'assault', 'rifleman', 'marksman', 'leader'],
  sabotage: ['assault', 'rifleman', 'heavy', 'marksman', 'leader', 'recon'],
  investigation: ['recon', 'rifleman', 'marksman', 'recon', 'assault', 'leader'],
  rescue: ['assault', 'rifleman', 'recon', 'leader', 'marksman'],
  defense: ['heavy', 'marksman', 'rifleman', 'assault', 'leader', 'heavy'],
  transport: ['assault', 'rifleman', 'heavy', 'recon', 'leader', 'marksman'],
  escort: ['rifleman', 'assault', 'marksman', 'leader', 'heavy'],
  recovery: ['recon', 'rifleman', 'marksman', 'assault', 'leader'],
  extraction: ['assault', 'heavy', 'rifleman', 'marksman', 'leader'],
});

// ---------------------------------------------------------------------------
// Single enemy
// ---------------------------------------------------------------------------
class Enemy {
  constructor(game, spawn, kind, personalitySeed) {
    this.game = game;
    this.spawnKind = kind;
    this.spawnId = spawn.id || null;
    this.spawnReason = spawn.reason || 'authored';
    this.spawnEventId = spawn.eventId || null;
    this.alive = true;
    this.health = 100;

    // Stable per-actor seed keeps squad composition and animation variation
    // reproducible without synchronising behavior across every actor.
    const rnd = this.rng = mulberry(personalitySeed);
    const hinted = spawn.classId || spawn.role || kind;
    const aliased = ARCHETYPE_ALIASES[hinted];
    this.archetype = ARCHETYPES[hinted] ? hinted :
      ARCHETYPES[aliased] ? aliased : ARCHETYPE_ROSTER[Math.abs(personalitySeed) % ARCHETYPE_ROSTER.length];
    this.kind = this.archetype;
    this.profile = ARCHETYPES[this.archetype];
    this.weaponType = spawn.weaponOverride || this.profile.weapon;
    this.weaponProfile = WEAPON_PROFILES[this.weaponType] || WEAPON_PROFILES.rifle;
    this.aiState = 'PATROL';
    this.stateReason = spawn.reason || 'mission spawn';
    const diff = game.progress.difficulty;
    this.skill = THREE.MathUtils.clamp((0.56 + rnd() * 0.42) * diff.skill * this.profile.skill, 0.3, 1.45);
    this.aggression = THREE.MathUtils.clamp(this.profile.aggression * (diff.aggression ?? 1) + (rnd() - 0.5) * 0.2, 0.18, 1.2);
    this.reactionBase = THREE.MathUtils.clamp((0.92 - this.skill * 0.42) * diff.reaction * this.profile.reaction * 1.18, 0.30, 1.6);
    this.reactionMod = diff.reaction;
    this.spreadMod = diff.spread * this.profile.spread;
    this.detectMod = diff.detection * this.profile.sense;
    this.hearMod = diff.hearing * this.profile.hearing;
    this.coverUse = diff.coverUse ?? 1;
    this.coordination = diff.coordination ?? 1;
    this.suppressionResistance = diff.suppression ?? 1;
    this.reinforcementScale = diff.reinforcements ?? 1;
    this.visionRange = this.profile.vision;
    this.fov = this.profile.fov;
    this.moveScale = this.profile.speed;
    this.burstLen = this.weaponType === 'marksman' || this.weaponType === 'shotgun'
      ? 1 : Math.max(2, this.profile.burst + Math.floor(rnd() * 3) - 1);
    this.maxHealth = 100;
    this.armor = this.profile.armor;
    this.maxArmor = this.armor;
    const weaponMag = this.weaponType === 'shotgun' ? 8 : this.profile.mag;
    const weaponReserve = this.weaponType === 'shotgun' ? 40 : this.profile.reserve;
    this.magSize = weaponMag;
    this.ammo = this.magSize;
    this.reserveAmmo = Math.round(weaponReserve * diff.reserve);
    this.reloadDuration = this.weaponType === 'shotgun' ? 2.35 : this.profile.reload;
    this.morale = this.profile.morale * (diff.suppression ?? 1);
    this.visual = {
      classId: this.archetype,
      kit: this.profile.kit,
      weaponStyle: this.weaponType,
      gear: true,
      pack: ['heavy', 'radio', 'marksman'].includes(this.profile.kit),
      // Every combatant wears a ballistic helmet; recon/marksman use a cloth
      // helmet cover so the silhouette stays distinct without soft caps.
      headwear: 'helmet',
      helmetCover: this.archetype === 'recon' || this.archetype === 'marksman',
      faceCover: this.archetype === 'heavy' || this.archetype === 'breacher' || rnd() < 0.28,
      headScale: 0.94 + rnd() * 0.12,
      width: this.archetype === 'heavy' ? 1.08 : this.archetype === 'recon' ? 0.95 : 0.98 + rnd() * 0.05,
      depth: this.archetype === 'heavy' ? 1.06 : 0.97 + rnd() * 0.06,
      height: this.archetype === 'heavy' ? 1.02 : 0.97 + rnd() * 0.06,
      strobe: this.archetype === 'leader' || rnd() < 0.28,
    };

    this.pos = spawn.pos.clone();
    this.vel = new THREE.Vector3();
    this.yaw = rnd() * Math.PI * 2;
    this.pitch = 0;
    this.onGround = true;
    this.crouchT = 0;
    this.crouching = false;

    this.box = { min: new THREE.Vector3(), max: new THREE.Vector3() };
    this._moveOut = { onGround: false, hitX: false, hitZ: false, hitCeil: false, steppedUp: false, groundCollider: null };
    this._moveOpts = { ignoreBody: null, actors: true };
    // Bodies are mass-weighted so a charging heavy gunner actually bowls people
    // over while a recon scout merely bounces off the operator.
    const ARCHETYPE_MASS = { heavy: 116, breacher: 98, armored: 98, guard: 86, patrol: 82, rifleman: 84, flanker: 78, marksman: 76, recon: 72, leader: 92, radio: 84 };
    initImpactState(this, { mass: ARCHETYPE_MASS[this.archetype] || 84 });
    this.charging = false;
    this._halfWidth = 0.32;
    this._body = null;
    // No actor may materialise inside a wall, a vehicle or another body: nudge
    // to the nearest open, floor-backed spot instead. This is the single choke
    // point for authored spawns, wave surges and garrison echelons alike.
    if (!game.physics.repairSpawnPoint(this.pos, 0.32, this._standingHeight())) {
      // crowded escape (a squad already standing in the gaps around a vehicle):
      // widen the search rather than leaving a soldier embedded in a hull
      game.physics.repairSpawnPoint(this.pos, 0.32, this._standingHeight(), 9.5);
    }
    this._syncBox();

    // AI state: route-less mission actors pick short, collision-aware patrol
    // arcs rather than idling or receiving the player's live position.
    this.route = spawn.route != null ? game.world.patrolRoutes[spawn.route] : null;
    this.state = this.route && this.route.length ? 'patrol' : 'wander';
    this.routeIdx = 0;
    this.wanderOrigin = this.pos.clone();
    this.wanderPoint = new THREE.Vector3();
    this.hasWanderPoint = false;
    this.stateT = 0;
    this.pauseT = 0.4 + rnd() * 1.3;
    this.speedScale = 1;

    this.lastKnown = new THREE.Vector3();
    this.lastKnownValid = false;
    this.lastKnownConfidence = 0;
    this.lastKnownUncertainty = 0;
    this.lastKnownAt = -99;
    this.lastKnownSource = 'none';
    this.lastSeenT = -99;
    this.detection = 0;          // gradual visual accumulation, 0..1
    this.suspicionPoint = new THREE.Vector3();
    this.searchT = 0;
    this.searchPoint = new THREE.Vector3();
    this.searchAttempts = 0;
    this.investigateMaxTime = 22;
    this.navPath = null;
    this.navPathIndex = 0;
    this.navPathEndMode = null;
    this.navReplanRequested = false;
    this.navReplanCount = 0;
    this.navBestDistance = Infinity;
    this.navNoProgressT = 0;
    this._motionBlocked = false;
    this.recoveryT = 0;
    this.alertT = 0;
    this.contactConfirmed = false;
    this.canSeePlayer = false;
    this.hasLOS = false;
    this._perceptionElapsed = 0;
    this.nextPercept = 0.08 + rnd() * 0.24;
    this._aiAccumulator = 0;
    this._nextRadioAt = 0;
    this._queryHits = [];

    // combat
    this.combatAction = 'engage';   // engage | cover | reposition | reload
    this.actionT = 0;
    this.coverPoint = null;
    this.peekPoint = new THREE.Vector3();
    this.peeking = false;
    this.peekT = 1.15 + rnd() * 1.0;
    this.windupT = 0;
    this.suppressT = 0;
    this.stress = 0;
    this.stressT = 0;
    this.stunT = 0;        // flashbang stun (C3)
    this.grenadeCd = 12 + rnd() * 16;
    this.throwT = 0;
    this.chatterCd = 0;
    this.moraleT = 0;
    this.surrendered = false;
    this.fleeing = false;
    this.fled = false;
    this.reloadT = 0;
    this.reloadsCompleted = 0;
    this.fireKickT = 0;
    this.lastFireAt = -99;
    this.burstLeft = 0;
    this.burstT = 0;
    this.burstPause = this.weaponProfile.burstPause[0] + rnd() *
      (this.weaponProfile.burstPause[1] - this.weaponProfile.burstPause[0]);
    this.repositionT = 0;
    this.strafeSide = rnd() < 0.5 ? -1 : 1;
    this._combatStrafeTarget = new THREE.Vector3();
    this._combatStrafeReady = false;
    this._combatStrafeWait = 0;
    this.reposTarget = new THREE.Vector3();
    this.hasReposTarget = false;
    this.aimYaw = this.yaw;
    this.flinchT = 0;
    this.flinchDir = new THREE.Vector3();
    this.armHitT = 0;
    this.legHitT = 0;
    this.deathT = 0;
    this.deathAxis = new THREE.Vector3(1, 0, 0);
    this.deathDuration = 0.62;
    this.corpseT = 0;
    this.corpseExpired = false;
    this.deathYaw = 0;
    this.deathStyle = 0;

    // locomotion anim
    this.walkPhase = rnd() * 10;
    this.scanSeed = this.walkPhase;          // constant per-actor phase for idle scanning
    this._actualVX = 0; this._actualVZ = 0;
    this.moveSpeed = 0;
    this.stuckT = 0;
    this.lastPos = this.pos.clone();
    this.avoidYaw = 0;

    // Shared low-poly geometry and faction palettes keep the articulated
    // anatomy and each weapon class reusable across the mission roster.
    const paletteIndex = (this.archetype === 'heavy' ? 2 : this.archetype === 'recon' ? 3 : this.archetype === 'marksman' ? 4 : Math.floor(rnd() * game.enemies.paletteMats.length));
    const mats = game.enemies.paletteMats[paletteIndex] || game.enemies.mats;
    this.model = buildSoldierModel(mats, this.visual);
    poseSoldierArms(this.model, false, false, false, 0, 0);
    if (spawn.flash) {
      const fl = new THREE.SpotLight(0xfff0cc, 0, 20, 0.42, 0.55, 1.7);
      fl.position.set(0.16, 0.42, -0.12);
      const tgt = new THREE.Object3D();
      tgt.position.set(0.1, 0.1, -8);
      this.model.torso.add(fl, tgt);
      fl.target = tgt;
      this.flash = fl;
    }
    this.model.root.position.copy(this.pos);
    this.model.root.rotation.y = this.yaw;
    // Rigged CC0 soldier + retargeted UAL clips (null => procedural fallback).
    this.rig = attachSoldierRig(this.model, {
      kit: this.archetype, faceCover: !!this.visual.faceCover,
      tint: RIG_TINTS[paletteIndex] || 0xffffff, paletteKey: paletteIndex, colors: rigColors(mats),
    });
    this._rigState = { time: 0, vx: 0, vz: 0, crouch: 0, aiming: false, reloading: false, fireKick: 0, flinch: 0, hitSerial: 0, hitZone: 'torso', surrendered: false, alive: true, camDist: 0 };
    game.enemies.group.add(this.model.root);

    this._muzzleWorld = new THREE.Vector3();
    this._shotDir = new THREE.Vector3();
    this._shotRight = new THREE.Vector3();
    this._shotUp = new THREE.Vector3();
    this._shotFrom = new THREE.Vector3();
    this._shotEnd = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._toPlayer = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    this._targetScratch = new THREE.Vector3();
    this._reposScratch = new THREE.Vector3();
    this._shotLocal = { x: 0, y: 0, z: 0, dist: 0 };
  }

  _syncBox() {
    const h = this._standingHeight();
    this._height = h;
    this.box.min.set(this.pos.x - 0.32, this.pos.y, this.pos.z - 0.32);
    this.box.max.set(this.pos.x + 0.32, this.pos.y + h, this.pos.z + 0.32);
    // Publish the body once per position update: soldiers collide with each
    // other, with the operator, and with every vehicle hull in the mission.
    const g = this.game;
    if (g && g.physics && g.physics.actors) {
      if (this.alive === false) { if (this._body) unregisterActorBody(g.physics, this); return; }
      syncActorBody(g.physics, this, this.box, { tag: 'actor', material: 'fabric', mass: this.mass });
    }
  }

  /** Height of the solid volume: a knocked-down soldier stays solid (you
   * cannot walk through a body) but lies down, so his box lowers. */
  _standingHeight() {
    if (this.bodyState === BODY_STATE.KNOCKED_DOWN || this.bodyState === BODY_STATE.RECOVERING) {
      return IMPACT_TUNE.DOWN_BOX_HEIGHT;
    }
    return THREE.MathUtils.lerp(1.82, 1.2, this.crouchT);
  }

  _moveOptions() {
    this._moveOpts.ignoreBody = this._body;
    return this._moveOpts;
  }

  /** True while this soldier can shoot and take cover decisions. */
  canAct() { return this.bodyState === BODY_STATE.STANDING || this.bodyState === BODY_STATE.STAGGERED; }

  eyePos(out) {
    return out.set(this.pos.x, this.pos.y + THREE.MathUtils.lerp(1.62, 1.05, this.crouchT), this.pos.z);
  }

  // =========================================================================
  update(dt, manager) {
    const g = this.game;
    this._currentDt = dt;
    if (!this.alive) {
      this._updateDeath(dt);
      return;
    }
    // Knock/stagger timers always advance, even while a body is wedged against
    // geometry — the only guarantee that prevents a permanent stuck state.
    tickBodyState(this, dt);
    if (this.bodyState === BODY_STATE.KNOCKED_DOWN || this.bodyState === BODY_STATE.RECOVERING) {
      // Down: no perception, no aim, no fire, no pathing. Motion integration
      // and the fall pose still run so the body settles against the ground.
      this._wish.set(0, 0, 0);
      this.moveSpeed = 0;
      this.canSeePlayer = false;
      this.windupT = 0;
      this.burstLeft = 0;
      this._stepMotion(dt, manager);
      return;
    }
    this.stateT += dt;
    this.suppressT = Math.max(0, this.suppressT - dt);
    this.stressT = Math.max(0, this.stressT - dt);
    this.stress = Math.max(0, this.stress - dt * 0.025);
    this.armHitT = Math.max(0, this.armHitT - dt);
    this.legHitT = Math.max(0, this.legHitT - dt);
    this.flinchT = Math.max(0, this.flinchT - dt * 3);
    this.fireKickT = Math.max(0, this.fireKickT - dt * 5.5);
    this.chatterCd = Math.max(0, this.chatterCd - dt);
    this.glueT = Math.max(0, (this.glueT || 0) - dt);          // Phase-14 adhesive decay
    this.flashKillT = Math.max(0, (this.flashKillT || 0) - dt); // Phase-14 EMP blackout decay

    if (this.flash) {
      const want = g.world.lightMode === 'night' && this.flashKillT <= 0 && !this.surrendered && !this.fled &&
        (this.state === 'patrol' || this.state === 'suspicious' || this.state === 'investigate' || this.state === 'search');
      this.flash.intensity += ((want ? 48 : 0) - this.flash.intensity) * Math.min(1, dt * 5);
    }

    // Perception is sampled sparsely; elapsed time is accumulated so detection
    // remains stable when the manager throttles distant actors.
    this._perceptionElapsed += dt;
    this.nextPercept -= dt;
    if (this.nextPercept <= 0) {
      this.nextPercept = (this.state === 'combat' || this.state === 'alert' ? 0.11 : 0.19) + this.rng() * 0.13;
      this._perceive(manager, this._perceptionElapsed);
      this._perceptionElapsed = 0;
    }

    if (this.lastKnownValid && !this.canSeePlayer) {
      this.lastKnownConfidence = Math.max(0, this.lastKnownConfidence - dt * (this.state === 'combat' ? 0.035 : 0.055));
      this.lastKnownUncertainty = Math.min(24, this.lastKnownUncertainty + dt * (this.state === 'combat' ? 0.38 : 0.55));
      if (this.lastKnownConfidence < 0.06 && this.state !== 'combat' && this.state !== 'alert' && this.state !== 'investigate' && this.state !== 'search') {
        this.lastKnownValid = false;
      }
    }

    if (this.stunT > 0) {
      this.stunT = Math.max(0, this.stunT - dt);
      this.canSeePlayer = false;
      this.hasLOS = false;
      this._setMoveTarget(null, 0);
      this._stepMotion(dt, manager);
      return;
    }

    switch (this.state) {
      case 'patrol': this._patrol(dt); break;
      case 'wander': this._wander(dt); break;
      case 'suspicious': this._suspicious(dt); break;
      case 'alert': this._alert(dt, manager); break;
      case 'investigate': this._investigate(dt, manager); break;
      case 'combat': this._combat(dt, manager); break;
      case 'search': this._search(dt, manager); break;
      case 'flee': {
        const arrived = this._setMoveTarget(this.searchPoint, 0.5, 4.2);
        this.crouching = false;
        if (arrived || this.pos.distanceToSquared(this.searchPoint) < 2.25) {
          this.fleeing = false;
          this.fled = false;
          this.state = 'recovering';
          this.recoveryT = 0;
          this.stress *= 0.4;
          this.lastKnownValid = false;
        }
        break;
      }
      case 'surrendering': {
        this.crouching = true;
        this._setMoveTarget(null, 0);
        break;
      }
      case 'recovering': {
        this._setMoveTarget(null, 0);
        this.crouching = false;
        this.recoveryT += dt;
        this._scanYaw(0.22, 0.8, dt);
        if (this.recoveryT > 3.5) {
          this.state = 'patrol';
          this.stateT = 0;
          this.contactConfirmed = false;
          this.detection = 0;
        }
        break;
      }
      default:
        this.state = 'patrol';
        break;
    }

    this._stepMotion(dt, manager);
  }

  /** True if this soldier already made an alert stand-still pause in the last
   *  4 s. The first reaction keeps its orienting pause; repeated reports or
   *  shots during a search no longer freeze him every couple of seconds. */
  _recentAlertPause() {
    return this.game.time - (this._alertPauseAt == null ? -99 : this._alertPauseAt) < 4;
  }

  /** Idle "glance around" heading sway. The old code used walkPhase (the
   *  running gait phase, ~2.3 rad/s even when standing) as the phase, so each
   *  sway ran 3-4x faster than written: a +/-9-12 deg wobble every ~2 s that
   *  read as dancing. Same sweep amplitude (amp / (freq + 2.3): unchanged
   *  perception coverage), now at the intended slow rate with a fixed phase. */
  _scanYaw(amp, freq, dt) {
    // Idle glance is handled naturally by head rotation in _animate (m.headGrp / bn.head).
    // The soldier's feet and body remain stable on the ground to prevent dancing/swaying.
  }

  /** Movement + presentation for an AI tick. Actors in per-frame mode
   *  (inside the camera draw distance) are integrated and presented by the manager every frame
   *  instead, so the tick must not move them a second time. */
  _stepMotion(dt, manager) {
    if (this._perFrame) return;
    this._move(dt);
    this._animate(dt, manager);
  }

  _rememberPoint(point, confidence, uncertainty, source = 'evidence') {
    if (!point) return;
    // Keep an active route when the estimate merely shifts (< 5 m): dropping it
    // on every refined sound/report sent soldiers back onto the direct line
    // into the obstacle the route had just taken them around.
    const shifted = this.lastKnownValid && Math.hypot(point.x - this.lastKnown.x, point.z - this.lastKnown.z) < 5;
    if (this.navPath && source !== 'mission-reinforcement report' && !shifted) {
      this.navPath = null;
      this.navPathIndex = 0;
      this.navPathEndMode = null;
    }
    this.lastKnown.copy(point);
    this.lastKnownValid = true;
    this.lastKnownConfidence = THREE.MathUtils.clamp(confidence, 0, 1);
    this.lastKnownUncertainty = Math.max(0, uncertainty);
    this.lastKnownAt = this.game.time;
    this.lastKnownSource = source;
  }

  _perceive(manager, elapsed = 0.2) {
    const g = this.game;
    const player = g.player;
    this.canSeePlayer = false;
    this.hasLOS = false;
    if (!player.alive || g.state !== 'playing') {
      this.detection = Math.max(0, this.detection - elapsed * 0.2);
      return;
    }

    const eye = this.eyePos(this._eye);
    const chest = _pv1.set(player.pos.x, player.pos.y + THREE.MathUtils.lerp(1.02, 0.76, player.crouchT || 0), player.pos.z);
    const toP = _pv2.copy(chest).sub(eye);
    const dist = toP.length();
    if (dist < 0.001) {
      this.hasLOS = true;
      this.canSeePlayer = true;
      this._spotPlayer(manager, player.pos);
      return;
    }
    toP.multiplyScalar(1 / dist);

    // Yaw cone is archetype-specific; even a very close target must be roughly
    // in front and must pass collision + smoke occlusion before recognition.
    const facingYaw = this.state === 'combat' || (this.state === 'alert' && this.contactConfirmed) ? this.aimYaw : this.yaw;
    const fwd = _pv3.set(-Math.sin(facingYaw), 0, -Math.cos(facingYaw));
    const flat = _pv4.set(toP.x, 0, toP.z).normalize();
    const dot = fwd.dot(flat);
    const halfFov = this.fov * DEG * 0.5;
    // Angle between this soldier's facing and the operator, in radians. Used by
    // both the accrual falloff and the turn-to-look reflex, so the two can never
    // disagree about whether the target is "to the side" or "behind".
    const offAxis = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
    const inCone = dot >= Math.cos(halfFov);
    const peripheral = dot >= Math.cos(halfFov * 1.38);
    const weatherVision = g.world.weather === 'fog' ? 0.72 : g.world.weather === 'dust' ? 0.84 : g.world.weather === 'snow' ? 0.9 : 1;
    const range = this.visionRange * weatherVision;
    // "Look at it" reflex: a clear sight line inside vision range earns a head
    // and body turn, but only while the soldier is not already aiming.
    const reflexEligible = dist <= range;

    let los = false;
    if (dist <= range && dist < 90) {
      los = g.physics.hasLOS(eye, chest) &&
        !(g.throwables && g.throwables.smokeBlocksLOS(eye, chest));
    }
    this.hasLOS = los;

    if (!los) {
      this.detection = Math.max(0, this.detection - elapsed * 0.22);
      return;
    }

    let movementFactor = 0.6;
    if (player.sprinting) movementFactor = 1.65;
    else if ((player.speed || 0) > 2.3) movementFactor = 1.25;
    else if ((player.speed || 0) > 0.8) movementFactor = 0.96;
    else if ((player.speed || 0) > 0.25) movementFactor = 0.76;
    const stanceFactor = player.crouching ? 0.38 : 1;
    const rangeFactor = THREE.MathUtils.clamp(1.12 - AI_SENSE.RANGE_DECAY * (dist / range), AI_SENSE.RANGE_MIN, 1);
    const lightFactor = this._playerInLight() ? 1.15 : (g.world.lightMode === 'night' ? 0.62 : 0.86);
    let gainPerSecond = AI_SENSE.BASE_GAIN * rangeFactor * movementFactor * stanceFactor * lightFactor * this.detectMod;
    // Phase-14: character visibility package (ghost LOW SIGNATURE floors it).
    gainPerSecond *= (player.visibilityMult !== undefined ? player.visibilityMult : 1);
    if (player.flashlightOn) gainPerSecond *= 1.3;   // Master upgrade P4: a lit flashlight is easier to spot
    if (!inCone) {
      // Continuous falloff with off-axis angle instead of a cliff. The old two
      // tier model (×0.2 inside the peripheral band, ×0.03 outside) made
      // detection a lottery on where the patrol yaw happened to point: a soldier
      // could stand 6 m from an operator in the clear, looking 70° away, and
      // never notice him. Awareness now scales with how *obvious* the target is.
      const beyond = Math.max(0, offAxis / Math.max(0.01, halfFov) - 1);
      let factor = THREE.MathUtils.clamp(AI_SENSE.PERIPHERAL_GAIN - beyond * 0.3, AI_SENSE.BLIND_GAIN, AI_SENSE.PERIPHERAL_GAIN);
      if (dist < AI_SENSE.NEAR_VISIBLE_DIST) factor = Math.max(factor, AI_SENSE.NEAR_VISIBLE_GAIN);
      if (dist < range * AI_SENSE.OBVIOUS_DIST && (player.sprinting || (player.speed || 0) > 2.4 || player.flashlightOn)) {
        factor = Math.max(factor, AI_SENSE.OBVIOUS_GAIN);
      }
      gainPerSecond *= factor;
    }
    if (dist < 4.5) gainPerSecond = Math.max(gainPerSecond, AI_SENSE.NEAR_FLOOR * this.detectMod);
    // Floor for "in the open, nothing between us": without it, whether you were
    // seen depended on where the patrol yaw happened to point, which is what made
    // soldiers wander past a clearly visible operator. Genuine concealment still
    // scales the floor, so crouching, darkness, LOW SIGNATURE and lower
    // difficulties keep stealth working — an occluded target never accrues at all
    // (the no-LOS branch returns before this).
    const concealment = stanceFactor * lightFactor * this.detectMod
      * (player.visibilityMult !== undefined ? player.visibilityMult : 1);
    const losFloor = AI_SENSE.LOS_FLOOR * concealment
      * THREE.MathUtils.clamp(1.15 - dist / range, 0.35, 1);
    gainPerSecond = Math.max(gainPerSecond, losFloor);
    // Moving fast in the open is the loudest visual cue there is.
    if (dist < range * 0.45 && (player.sprinting || (player.speed || 0) > 3.2)) {
      gainPerSecond = Math.max(gainPerSecond, AI_SENSE.BASE_GAIN * 0.85 * this.detectMod);
    }
    this.detection = THREE.MathUtils.clamp(this.detection + gainPerSecond * elapsed, 0, 1);

    // A soldier who *could* see you, and has a clear line, turns to look rather
    // than stalling out-of-cone forever. Suppressed while engaged: `_aimAt`
    // owns the facing in combat, and two writers on `yaw` is how spinning starts.
    if (reflexEligible && !inCone && this.detection > AI_SENSE.GLANCE_MIN_DETECTION && this.state !== 'combat'
      && this.state !== 'surrendering' && this.state !== 'flee') {
      const lookYaw = Math.atan2(-toP.x, -toP.z);
      // Turning to look is a *peripheral* reflex: a soldier must not snap around
      // at someone creeping up directly behind him, or stealth would be dead.
      if (offAxis <= halfFov * AI_SENSE.REFLEX_ARC) {
      let d = lookYaw - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const step = THREE.MathUtils.clamp(d, -AI_SENSE.REFLEX_TURN * elapsed, AI_SENSE.REFLEX_TURN * elapsed);
      if (Number.isFinite(step)) this.yaw += step;
      } else if (CALM_STATES.has(this.state) || this.state === 'investigate' || this.state === 'search') {
        // A cue well outside the cone does not earn a snap-turn, but a soldier on
        // patrol does keep sweeping his watch sector: without this, an actor who
        // happened to be walking away from the operator could stay facing away
        // indefinitely, and "enemies never attack" is exactly what that reads as.
        let d2 = lookYaw - this.yaw;
        while (d2 > Math.PI) d2 -= Math.PI * 2;
        while (d2 < -Math.PI) d2 += Math.PI * 2;
        const slow = THREE.MathUtils.clamp(d2, -AI_SENSE.SCAN_TURN * elapsed, AI_SENSE.SCAN_TURN * elapsed);
        if (Number.isFinite(slow)) this.yaw += slow;
      }
    }

    // Recognition and reaction are one event: the old split (canSee at 0.84,
    // alarm at 0.98) left soldiers visually on the player yet still patrolling.
    const confirmThreshold = this.contactConfirmed ? AI_SENSE.RECALL_THRESHOLD : AI_SENSE.SPOT_THRESHOLD;
    // Awareness, not geometry, decides "I see him". The old `inCone &&` clause
    // meant a soldier could saturate detection to 1.0 with a clear sight line and
    // still stay in `wander` because his patrol yaw happened to be 30° off — the
    // single most visible symptom of "enemies do not attack me". The cone still
    // governs how *fast* recognition accrues; an off-axis target only confirms
    // once the presence is undeniable, which the turn-to-look reflex normally
    // resolves long before that.
    this.canSeePlayer = this.detection >= confirmThreshold && (inCone || this.detection >= 0.97);
    if (this.canSeePlayer) {
      this.lastSeenT = g.time;
      this._rememberPoint(player.pos, 1, 0.55, 'visual');
      if (this.state === 'combat') {
        this.aimYaw = Math.atan2(-(player.pos.x - this.pos.x), -(player.pos.z - this.pos.z));
      }
      if (this.detection >= AI_SENSE.SPOT_THRESHOLD && !this.contactConfirmed) this._spotPlayer(manager, player.pos);
      if (this.state === 'combat') manager.shareLastKnown(this.lastKnown, this);
    } else if (this.detection > 0.32 && (CALM_STATES.has(this.state) || this.state === 'investigate')) {
      // Every calm state must be able to escalate. This used to test
      // `state === 'patrol'` while patrols actually run in `wander`, so partial
      // awareness had nowhere to go and the soldier just kept loitering.
      this._goSuspicious(chest);
    }
  }

  _playerInLight() {
    const p = this.game.player.pos;
    if (this.game.world.lightMode === 'night') {
      const insideLitZone = p.x > -26 && p.x < 26 && p.z > -44 && p.z < 14 && p.y >= 0;
      return insideLitZone;
    }
    // Daylight is broadly readable; the authored warehouse is brighter still.
    const insideWarehouse = p.x > -30 && p.x < 30 && p.z > -45 && p.z < 15;
    return insideWarehouse || this.game.world.lightMode !== 'fog';
  }

  _spotPlayer(manager, playerPos) {
    const first = !this.contactConfirmed;
    this._rememberPoint(playerPos || this.game.player.pos, 1, 0.55, 'visual');
    this.lastSeenT = this.game.time;
    this.detection = 1;
    this.canSeePlayer = true;
    this.contactConfirmed = true;
    if (first) {
      this.state = 'alert';
      this.stateT = 0;
      this.alertT = THREE.MathUtils.clamp(this.reactionBase * (0.5 + this.rng() * 0.55), 0.18, 0.95);
      this.combatAction = 'engage';
      this.actionT = 0;
      this.windupT = this.reactionBase + this.rng() * 0.25;
      this.aimYaw = Math.atan2(-(this.lastKnown.x - this.pos.x), -(this.lastKnown.z - this.pos.z));
      manager.onPlayerSpotted(this);
    }
  }

  _goSuspicious(point, evidenceSource = 'visual-cue') {
    if (this.state === 'combat' || this.state === 'surrendering' || this.state === 'flee') return;
    this.state = 'suspicious';
    this.stateT = 0;
    this.suspicionPoint.copy(point);
    if (evidenceSource === 'visual-cue') {
      this._rememberPoint(point, Math.max(0.24, this.detection * 0.6), 5.5, evidenceSource);
    } else if (!this.lastKnownValid) {
      this._rememberPoint(point, 0.28, 6.5, evidenceSource);
    }
    this.detection = Math.max(this.detection, 0.34);
  }

  _alert(dt, manager) {
    this._alertPauseAt = this.game.time;      // see _recentAlertPause()
    this._checkMorale(dt, manager);
    if (this.state === 'flee' || this.state === 'surrendering') return;
    this._setMoveTarget(null, 0);
    if (this.lastKnownValid) this._aimAt(this.lastKnown, dt, this.contactConfirmed ? 0.85 : 0.55);
    else this._scanYaw(0.22, 1.1, dt);
    this.crouching = !this.contactConfirmed && this.lastKnownConfidence < 0.6;
    this.alertT -= dt;
    if (this.contactConfirmed) {
      if (this.alertT <= 0) {
        this.state = 'combat';
        this.stateT = 0;
        this.actionT = 0;
      }
    } else if (this.alertT <= 0) {
      if (this.lastKnownValid && this.lastKnownConfidence > 0.16) {
        this.state = 'investigate';
        this.stateT = 0;
      } else {
        this.state = 'suspicious';
        this.stateT = 0;
        this.detection = Math.max(this.detection, 0.24);
      }
    }
    void manager;
  }

  receiveContact(message) {
    if (!this.alive || this.surrendered || this.fled || this.state === 'combat' || !message || !message.position) return false;
    const confidence = message.confidence * (0.8 + this.rng() * 0.2);
    if (this.lastKnownValid && this.lastKnownConfidence > confidence && this.game.time - this.lastKnownAt < 3) return;
    this._rememberPoint(message.position, confidence, message.uncertainty + 2 + this.rng() * 3, 'squad-report');
    this.suspicionPoint.copy(message.position);
    if (this.state === 'investigate' || (this.state === 'alert' && !this.contactConfirmed)) {
      // Already moving on / reacting to the contact: take the better estimate
      // without re-entering the alert stand-still (prevents stop/go loops).
      this.detection = Math.max(this.detection, 0.12 + confidence * 0.25);
      return true;
    }
    if (this.state === 'search' && this._recentAlertPause() && this.lastKnownConfidence > 0.16) {
      // Already paused to orient a moment ago (e.g. searching after a lost
      // contact): move on the report now instead of freezing again.
      this.state = 'investigate';
      this.stateT = 0;
      this.detection = Math.max(this.detection, 0.12 + confidence * 0.25);
      return true;
    }
    this.state = 'alert';
    this.stateT = 0;
    this.alertT = 0.45 + this.rng() * 0.45;
    this.contactConfirmed = false;
    this.detection = Math.max(this.detection, 0.12 + confidence * 0.25);
    this.stress = Math.min(1, this.stress + 0.08);
    return true;
  }

  /** Timestamped hearing callback. Sound gives an uncertain bearing, not GPS. */
  hear(noise, manager) {
    if (!this.alive || this.surrendered || this.fled || !noise || noise.source === this) return;
    const age = Math.max(0, this.game.time - (noise.time == null ? this.game.time : noise.time));
    if (age > 3.5) return;
    const d = this.pos.distanceTo(noise.pos);
    const weather = this.game.world.weather;
    const weatherMuffle = weather === 'rain' ? 0.84 : weather === 'snow' ? 0.9 : weather === 'dust' ? 0.92 : 1;
    const windMuffle = 1 - Math.min(0.16, (this.game.world.windLevel || 0) * 0.18);
    const radius = Math.max(0.1, noise.radius * this.hearMod * weatherMuffle * windMuffle * (1 - Math.min(0.55, age * 0.16)));
    if (d > radius) return;
    const proximity = THREE.MathUtils.clamp(1 - d / radius, 0, 1);
    const intensity = THREE.MathUtils.clamp((noise.intensity == null ? noise.radius / 60 : noise.intensity) * weatherMuffle * (1 - Math.min(0.65, age * 0.2)), 0, 1);
    const hostileShot = noise.kind === 'gunshot' || noise.kind === 'gunfire' || noise.kind === 'player_shot' || noise.kind === 'shot';
    const vehicleNoise = noise.kind === 'machine' || noise.kind === 'rotor' || noise.kind === 'horn';

    // Friendly fire, impacts, or blasts can suppress a nearby guard, but an
    // enemy's own muzzle report is not a precise player-location update.
    if (noise.kind === 'enemy_shot' || noise.kind === 'explosion' || noise.kind === 'impact') {
      if (proximity > 0.15) {
        this.suppressT = Math.max(this.suppressT, (0.45 + intensity * 1.1) / Math.max(0.6, this.suppressionResistance));
        this.stress = Math.min(1, this.stress + 0.12 * intensity);
        this.stressT = Math.max(this.stressT, 2.5 + intensity * 2);
      }
      if (noise.kind === 'enemy_shot') {
        // Only CALM soldiers are startled into a fresh alert pause. Soldiers
        // already reacting (alert/investigate/search) previously had their
        // target wiped and were re-frozen by every squadmate shot, producing
        // an alert<->investigate stop/go loop. Suppression above still applies.
        if (CALM_STATES.has(this.state) && proximity > 0.42) {
          this.state = 'alert'; this.stateT = 0; this.alertT = 0.35 + this.rng() * 0.3;
          this.lastKnownValid = false;
        }
        return;
      }
    }

    const strong = hostileShot || noise.kind === 'glass' || noise.kind === 'alarm' || noise.kind === 'explosion';
    const useful = strong ? proximity > 0.04 : vehicleNoise ? (proximity > 0.17 && intensity > 0.12) : noise.kind === 'door' ? proximity > 0.2 : proximity > 0.32;
    if (!useful) return;
    if (this.state === 'combat' && this.canSeePlayer) return;
    const wasCombat = this.state === 'combat';

    // Distance-dependent error models direction/bearing and reverberation.
    const uncertainty = (strong ? 2.2 : 4.5) + d * (0.12 + (1 - intensity) * 0.12) + (1 - proximity) * 3;
    const angle = this.rng() * Math.PI * 2;
    const error = uncertainty * (0.25 + this.rng() * 0.75);
    const estimate = _pv5.set(noise.pos.x + Math.cos(angle) * error, this.pos.y, noise.pos.z + Math.sin(angle) * error);
    const confidence = THREE.MathUtils.clamp((strong ? 0.58 : 0.38) * proximity * (0.5 + intensity * 0.5), 0.08, 0.8);
    if (!this.lastKnownValid || confidence > this.lastKnownConfidence) {
      this._rememberPoint(estimate, confidence, uncertainty, 'sound');
    }
    this.suspicionPoint.copy(estimate);
    if (wasCombat) {
      if (hostileShot) manager.squadAlert = Math.max(manager.squadAlert, 0.48 + intensity * 0.22);
      return;
    }

    if (strong) {
      // A soldier already reacting to an unconfirmed contact keeps reacting:
      // the estimate above is refined, but the stand-still pause is NOT
      // restarted. Before, every shot of a burst reset alertT, pinning
      // soldiers in place (or bouncing investigate->alert) under sustained fire.
      const reacting = this.state === 'investigate' || (this.state === 'alert' && !this.contactConfirmed);
      if (!reacting && this.state === 'search' && this._recentAlertPause() && this.lastKnownValid && this.lastKnownConfidence > 0.16) {
        this.state = 'investigate';            // oriented moments ago: no second freeze
        this.stateT = 0;
      } else if (!reacting) {
        this.state = 'alert';
        this.stateT = 0;
        this.alertT = hostileShot ? 0.35 + this.rng() * 0.4 : 0.6 + this.rng() * 0.6;
        this.contactConfirmed = false;
      }
      this.detection = Math.max(this.detection, 0.16 + confidence * 0.22);
      if (hostileShot || noise.kind === 'explosion' || noise.kind === 'glass') manager.squadAlert = Math.max(manager.squadAlert, 0.48 + intensity * 0.28);
    } else if (noise.kind === 'door' || proximity > 0.58) {
      if (this.state === 'patrol' || this.state === 'suspicious') {
        this.state = 'investigate';
        this.stateT = 0;
      }
    } else if (this.state === 'patrol') {
      this._goSuspicious(estimate, 'sound');
    }
  }

  // ---- states -------------------------------------------------------------
  _wander(dt) {
    this.crouching = false;
    if (this.pauseT > 0) {
      this.pauseT -= dt;
      this._setMoveTarget(null, 0);
      this._scanYaw(0.26, 0.7, dt);
      return;
    }
    const arrived = this.hasWanderPoint && this._setMoveTarget(this.wanderPoint, 0.8, 1.05);
    if (!this.hasWanderPoint || arrived || this.stateT > 14) {
      this.hasWanderPoint = false;
      for (let i = 0; i < 9; i++) {
        // Pick a point *ahead* of the current facing (±100°) instead of in any
        // random direction. Random star-patterns made a loitering soldier
        // reverse his heading every few seconds — the visible symptom was
        // constant spinning, and the invisible one was that his vision cone
        // swept away from the very direction he should have been watching.
        const angle = this.yaw + Math.PI + (this.rng() - 0.5) * 3.5;
        const radius = 2.4 + this.rng() * 4.6;
        this._targetScratch.set(
          this.wanderOrigin.x + Math.cos(angle) * radius,
          this.pos.y,
          this.wanderOrigin.z + Math.sin(angle) * radius,
        );
        if (this.pos.distanceToSquared(this._targetScratch) < 1.2 * 1.2 || !this._isClearPosition(this._targetScratch)) continue;
        this.wanderPoint.copy(this._targetScratch);
        this.hasWanderPoint = true;
        break;
      }
      this.pauseT = this.hasWanderPoint ? 0 : 1.1;
      this.stateT = 0;
      if (this.hasWanderPoint) this._setMoveTarget(this.wanderPoint, 0.8, 1.05);
    }
  }

  _patrol(dt) {
    this.crouching = false;
    if (!this.route || this.route.length === 0) {
      // no route: idle guard, scan around
      this._scanYaw(0.2, 0.4, dt);
      this._setMoveTarget(null, 0);
      return;
    }
    if (this.pauseT > 0) {
      this.pauseT -= dt;
      this._setMoveTarget(null, 0);
      // glance around while paused
      this._scanYaw(0.5, 0.9, dt);
      return;
    }
    const wp = this.route[this.routeIdx % this.route.length];
    const arrived = this._setMoveTarget(wp, 1.55);
    if (arrived) {
      this.routeIdx = (this.routeIdx + 1) % this.route.length;
      this.pauseT = 0.8 + this.rng() * 2.4;
    }
  }

  _suspicious(dt) {
    this._aimAt(this.suspicionPoint, dt, 0.38);
    const arrived = this._setMoveTarget(this.suspicionPoint, 1.8, 0.78);
    if (arrived) {
      this._setMoveTarget(null, 0);
      this._scanYaw(0.65, 1.15, dt);
    }
    if (this.stateT > 2.4) {
      if (this.detection > 0.44 && this.lastKnownValid) {
        this.state = 'investigate';
        this.stateT = 0;
      } else {
        this.state = 'patrol';
        this.stateT = 0;
        this.detection = Math.max(0, this.detection - 0.18);
        if (this.lastKnownConfidence < 0.2) this.lastKnownValid = false;
      }
    }
  }

  _investigate(dt, manager) {
    if (manager) this._checkMorale(dt, manager);
    if (this.state === 'flee' || this.state === 'surrendering') return;
    if (this.navReplanRequested) {
      this.navReplanRequested = false;
      const replanned = manager && manager._planGroundPath && this.navReplanCount < 3
        ? manager._planGroundPath(this.pos, this.lastKnown) : null;
      this.navReplanCount++;
      if (replanned && replanned.waypoints.length) {
        this.navPath = replanned.waypoints;
        this.navPathIndex = 0;
        this.navPathEndMode = 'search';
        this.navBestDistance = Infinity;
        this.navNoProgressT = 0;
        this.investigateMaxTime = Math.min(180, Math.max(22, 18 + replanned.distance / 1.9));
      } else {
        this.navPath = null;
        this.navPathEndMode = null;
        this.state = 'search';
        this.stateT = 0;
        this.searchT = 6.5 + this.rng() * 4.5;
        this.searchAttempts = 0;
        this._pickSearchPoint();
        return;
      }
    }
    if (!this.lastKnownValid || this.lastKnownConfidence < 0.08) {
      this.state = 'search';
      this.stateT = 0;
      this.searchT = 3.5;
      this._pickSearchPoint();
      return;
    }
    if (this.navPath && this.navPathIndex < this.navPath.length) {
      const waypoint = this.navPath[this.navPathIndex];
      const distance = Math.hypot(waypoint.x - this.pos.x, waypoint.z - this.pos.z);
      if (distance < this.navBestDistance - 0.04) {
        this.navBestDistance = distance;
        this.navNoProgressT = 0;
      } else this.navNoProgressT += dt;
      if (this.navNoProgressT > 1.8) {
        this.navPath = null;
        this.navPathIndex = 0;
        this.navPathEndMode = 'search';
        this.navReplanRequested = true;
        this.navNoProgressT = 0;
        this._setMoveTarget(null, 0);
        return;
      }
      const reached = this._setMoveTarget(waypoint, 0.92, 1.85);
      this._aimAt(this.lastKnown, dt, 0.25);
      if (reached) {
        this.navPathIndex++;
        this.navBestDistance = Infinity;
        this.navNoProgressT = 0;
        if (this.navPathIndex >= this.navPath.length) {
          this.navPath = null;
          this.navPathIndex = 0;
          if (this.navPathEndMode === 'search') {
            this.navPathEndMode = null;
            this.state = 'search';
            this.stateT = 0;
            this.searchT = 6.5 + this.rng() * 4.5;
            this.searchAttempts = 0;
            this.pauseT = 0;
            this._pickSearchPoint();
            return;
          }
        }
      }
      if (this.navPath) return;
    }
    const speed = this.pos.distanceTo(this.lastKnown) > 14 ? 1.75 : 1.2;
    const arrived = this._setMoveTarget(this.lastKnown, 1.5 + Math.min(1.5, this.lastKnownUncertainty * 0.08), speed);
    this._aimAt(this.lastKnown, dt, 0.25);
    if (arrived || this.stateT > this.investigateMaxTime) {
      this.state = 'search';
      this.stateT = 0;
      this.searchT = 6.5 + this.rng() * 4.5;
      this.searchAttempts = 0;
      this.pauseT = 0;
      this._pickSearchPoint();
    }
  }

  _search(dt, manager) {
    if (manager) this._checkMorale(dt, manager);
    this.searchT -= dt;
    const arrived = this._setMoveTarget(this.searchPoint, 1.0, 1.35);
    if (arrived) {
      this._setMoveTarget(null, 0);
      this._scanYaw(0.75, 1.3, dt);
      this.pauseT -= dt;
      if (this.pauseT <= 0 && this.searchAttempts < 5) {
        this.pauseT = 0.75 + this.rng() * 0.9;
        this.searchAttempts++;
        this._pickSearchPoint();
      }
    }
    if (this.searchT <= 0 || (this.searchAttempts >= 5 && this.searchT < 1.5)) {
      this.state = 'recovering';
      this.stateT = 0;
      this.recoveryT = 0;
      this.detection = 0;
      this.contactConfirmed = false;
      this.lastKnownValid = false;
      this.lastKnownConfidence = 0;
      manager?.combatTimeout(this);
    }
  }

  _isClearPosition(point, height = 1.8) {
    const min = _pv2.set(point.x - 0.32, point.y + 0.08, point.z - 0.32);
    const max = _pv3.set(point.x + 0.32, point.y + height, point.z + 0.32);
    const hits = this.game.physics.queryAABB(min, max, this._queryHits);
    return !hits.some(c => c.enabled && c.max.y > point.y + 0.35);
  }

  _pickSearchPoint() {
    const base = this.lastKnownValid ? this.lastKnown : this.pos;
    const radius = THREE.MathUtils.clamp(4 + this.lastKnownUncertainty * 0.35, 4, 9);
    const cover = this.game.world.coverPoints || [];
    let best = null;
    let bestScore = Infinity;
    const start = cover.length ? Math.floor(this.rng() * cover.length) : 0;
    const count = Math.min(16, cover.length);
    for (let n = 0; n < count; n++) {
      const cp = cover[(start + n) % cover.length];
      const fromEvidence = Math.hypot(cp.pos.x - base.x, cp.pos.z - base.z);
      if (fromEvidence > radius + 3 || this.pos.distanceToSquared(cp.pos) > 22 * 22) continue;
      if (!this._isClearPosition(cp.pos)) continue;
      const score = fromEvidence + this.pos.distanceTo(cp.pos) * 0.14 + (cp.normal ? 0 : 0.5);
      if (score < bestScore) { bestScore = score; best = cp.pos; }
    }
    if (best) {
      this.searchPoint.copy(best);
      return;
    }

    for (let tries = 0; tries < 8; tries++) {
      const angle = this.rng() * Math.PI * 2;
      const r = radius * (0.35 + this.rng() * 0.65);
      _pv1.set(base.x + Math.cos(angle) * r, this.pos.y, base.z + Math.sin(angle) * r);
      if (this._isClearPosition(_pv1)) {
        this.searchPoint.copy(_pv1);
        return;
      }
    }
    this.searchPoint.copy(base);
  }

  _combat(dt, manager) {
    const g = this.game;
    const player = g.player;
    this.actionT += dt;
    this.grenadeCd = Math.max(0, this.grenadeCd - dt);
    this._checkMorale(dt, manager);
    if (this.state === 'flee' || this.state === 'surrendering' || !this.alive) return;

    const sinceSeen = Math.max(0, g.time - this.lastSeenT);
    const target = this.canSeePlayer ? player.pos : (this.lastKnownValid ? this.lastKnown : this.searchPoint);
    const contactDist = this.pos.distanceTo(target);

    // Magazine management is finite and audible. While reloading the actor
    // holds/reaches cover and cannot fire; reserve ammunition is not infinite.
    if (this.reloadT > 0) {
      this.reloadT = Math.max(0, this.reloadT - dt);
      this.combatAction = 'reload';
      this.crouching = !!this.coverPoint || this.suppressT > 0;
      this._setMoveTarget(null, 0);
      if (this.canSeePlayer) this._aimAt(player.pos, dt, 0.55);
      else if (this.lastKnownValid) this._aimAt(this.lastKnown, dt, 0.4);
      if (this.reloadT <= 0) {
        const transfer = Math.min(this.magSize - this.ammo, this.reserveAmmo);
        this.ammo += transfer;
        this.reserveAmmo -= transfer;
        this.reloadsCompleted++;
        this.burstLeft = 0;
        this.burstT = 0;
        this.burstPause = 0.3 + this.rng() * 0.5;
        this.combatAction = this.canSeePlayer ? 'engage' : 'advance';
      }
      return;
    }
    if (this.ammo <= 0) {
      if (this.reserveAmmo > 0) {
        this._startReload(manager);
        return;
      }
      this.burstLeft = 0;
      this.combatAction = 'retreat'; // dry weapon: break contact and seek a safe reload position
      this.hasReposTarget = false;
    }

    // Contact is lost immediately for firing. After a short last-known window,
    // move to evidence and then search; never steer or aim at live player.pos.
    if (!this.canSeePlayer && sinceSeen > 1.8) {
      if (this.lastKnownValid && this.lastKnownConfidence > 0.13 && contactDist > 2.2 && sinceSeen < 9) {
        this.combatAction = 'advance';
        const arrived = this._setMoveTarget(this.lastKnown, 1.7 + Math.min(1, this.lastKnownUncertainty * 0.08), 1.9);
        this._aimAt(this.lastKnown, dt, 0.28);
        this.crouching = this.suppressT > 0;
        // Blocked on the straight line (stuck recovery fired): search now
        // instead of standing against the obstacle until the 8.5 s timeout.
        const blocked = this.game.time - (this._stuckAt || -9) < 0.6;
        if (arrived || blocked || sinceSeen > 8.5) {
          this._beginSearch(manager, 7 + this.rng() * 4);
        }
        return;
      }
      this._beginSearch(manager, 6 + this.rng() * 4);
      return;
    }

    if (this.actionT > (this.combatAction === 'engage' ? 1.8 : 2.8) || (this.combatAction === 'cover' && !this.coverPoint)) {
      this.actionT = 0;
      const hurt = this.health < 48 || this.armor <= 0;
      const stressed = this.suppressT > 0 || this.stress > 0.45;
      const roll = this.rng();
      if (!this.canSeePlayer) {
        this.combatAction = this.lastKnownConfidence > 0.24 && roll < 0.72 ? 'advance' : 'reposition';
      } else if (this.ammo <= 0 && this.reserveAmmo <= 0) {
        this.combatAction = 'retreat';
      } else if (this.archetype === 'marksman' && contactDist < 15) {
        this.combatAction = hurt || stressed ? 'cover' : 'retreat';
      } else if (contactDist > this.weaponProfile.range * 0.86) {
        this.combatAction = 'advance';
      } else {
        // Explicit weights. The old chain tested 'cover' twice with high
        // cumulative thresholds (0.74·coverUse for heavies and marksmen), so
        // 'engage' was only the leftover and a soldier in contact could spend a
        // whole engagement diving between cover points without firing. Now
        // returning fire always carries real probability mass, cover is only
        // chosen when a cover point actually exists, and nobody plays hide at
        // knife range.
        const coverAvailable = !!(this.coverPoint || manager.findCover
          || (this._coverCache && this._coverCache.length));
        let wEngage = 0.42 + this.aggression * 0.5 + (contactDist < 12 ? 0.35 : 0);
        let wCover = ((hurt || stressed) ? 0.46 : 0.2) * this.coverUse * (coverAvailable ? 1 : 0);
        let wRepos = (this.archetype === 'assault' || this.archetype === 'recon' ? 0.34 : 0.18)
          + (contactDist < 8 ? -0.12 : 0);
        if (contactDist < 8) wCover *= 0.35;
        wCover = Math.max(0, wCover); wRepos = Math.max(0.02, wRepos);
        const total = wEngage + wCover + wRepos;
        const r = roll * total;
        if (r < wEngage) this.combatAction = 'engage';
        else if (r < wEngage + wCover) this.combatAction = 'cover';
        else this.combatAction = 'reposition';
        if (this.combatAction === 'cover' && !this.coverPoint) this._pickCover(manager, contactDist);
        if (this.combatAction === 'cover' && !this.coverPoint) this.combatAction = 'engage';
      }
      this._combatStrafeReady = false;
      this._combatStrafeWait = 0;
      if (this.combatAction === 'cover') this._pickCover(manager, contactDist);
      if (this.combatAction === 'reposition' || this.combatAction === 'retreat') { this.repositionT = 0; this.hasReposTarget = false; }
    }

    if (this.throwT > 0) {
      this.throwT -= dt;
      if (this.throwT <= 0) {
        if (this.canSeePlayer) manager.throwGrenade(this);
        else this.throwT = 0;
      }
    } else if (this.grenadeCd <= 0 && this.canSeePlayer && contactDist > 8 && contactDist < 23 && player.alive && this.rng() < dt * 0.12) {
      this.throwT = 0.9;
      this.grenadeCd = 22 + this.rng() * 18;
      g.audio.radioSquelch(this.pos.clone().setY(this.pos.y + 1.3));
      g.ui.radio('GRENADE OUT — MOVE!');
    }

    switch (this.combatAction) {
      case 'engage': {
        if (this.canSeePlayer) {
          const effectiveRange = this.weaponProfile.range * 0.82;
          if (contactDist > effectiveRange) {
            // Close only while visual line of sight is current; use the normal
            // collision/whisker steering rather than running through cover.
            this._combatStrafeReady = false;
            this._combatStrafeWait = 0;
            this._setMoveTarget(player.pos, effectiveRange * 0.82, this.archetype === 'assault' || this.archetype === 'recon' ? 1.85 : 1.4);
            this.crouching = false;
          } else if (this.archetype === 'marksman' || this.archetype === 'heavy') {
            this._combatStrafeReady = false;
            this._combatStrafeWait = 0;
            this._setMoveTarget(null, 0);
            this.crouching = this.archetype === 'marksman' || this.suppressT > 0.55;
          } else {
            // Commit each short strafe to a fixed endpoint. Rebuilding the
            // target from this.pos every AI tick moved it along with the actor,
            // so it could never arrive and enemies walked sideways forever.
            this._combatStrafeWait = Math.max(0, this._combatStrafeWait - dt);
            if (this._combatStrafeWait > 0) {
              this._setMoveTarget(null, 0);
            } else {
              if (!this._combatStrafeReady) {
                const aimY = Number.isFinite(this.aimYaw) ? this.aimYaw : this.yaw;
                const right = _pv1.set(Math.cos(aimY), 0, -Math.sin(aimY));
                this._combatStrafeTarget.copy(this.pos).addScaledVector(right, this.strafeSide * 1.05);
                this._combatStrafeTarget.y = this.pos.y;
                this._combatStrafeReady = true;
              }
              const arrived = this._setMoveTarget(this._combatStrafeTarget, 0.38, 0.9);
              if (arrived) {
                this._combatStrafeReady = false;
                this._combatStrafeWait = 0.45 + this.rng() * 0.35;
                this.strafeSide *= -1;
              }
            }
            this.crouching = this.suppressT > 0.7;
          }
          const tracking = this.archetype === 'marksman' ? 0.54 : this.archetype === 'recon' ? 0.9 : 0.74;
          this._aimAt(player.pos, dt, tracking);
          if (contactDist <= this.weaponProfile.range) this._trigger(dt, contactDist);
        } else {
          this._combatStrafeReady = false;
          this._combatStrafeWait = 0;
          if (this.lastKnownValid) this._setMoveTarget(this.lastKnown, 1.8, 1.2);
          else this._setMoveTarget(null, 0);
          this.crouching = true;
          if (this.lastKnownValid) this._aimAt(this.lastKnown, dt, 0.24);
        }
        break;
      }
      case 'cover': {
        if (!this.coverPoint) { this.combatAction = 'advance'; break; }
        const cover = this.coverPoint.pos;
        if (this.pos.distanceToSquared(cover) > 1.15 * 1.15) {
          this._setMoveTarget(cover, 0.65, 1.8);
          this.crouching = false;
          if (this.canSeePlayer) this._aimAt(player.pos, dt, 0.56);
          else if (this.lastKnownValid) this._aimAt(this.lastKnown, dt, 0.22);
          break;
        }

        this._setMoveTarget(null, 0);
        this.peekT -= dt;
        if (this.peekT <= 0) {
          this.peeking = !this.peeking;
          this.peekT = this.peeking ? 0.55 + this.rng() * 0.8 : 1.15 + this.rng() * 1.8;
          if (this.peeking) {
            const evidence = this.canSeePlayer ? player.pos : this.lastKnownValid ? this.lastKnown : null;
            if (!this._peekFromCover(evidence)) this.peeking = false;
          }
        }
        const firingPoint = this.peeking ? this.peekPoint : cover;
        this._setMoveTarget(firingPoint, 0.38, this.peeking ? 1.0 : 0.72);
        this.crouching = !this.peeking || this.suppressT > 0.7;
        if (this.canSeePlayer && this.peeking) {
          this._aimAt(player.pos, dt, 0.74);
          if (contactDist <= this.weaponProfile.range) this._trigger(dt, contactDist);
        } else if (this.lastKnownValid) this._aimAt(this.lastKnown, dt, 0.28);
        break;
      }
      case 'reposition': {
        this.repositionT += dt;
        if (!this.hasReposTarget || this.repositionT > 5.5 || this.pos.distanceTo(this.reposTarget) < 1.2) {
          this.repositionT = 0;
          this.reposTarget.copy(this._pickReposPoint(manager, contactDist));
          this.hasReposTarget = true;
        }
        this._setMoveTarget(this.reposTarget, 0.85, 2.1);
        this.crouching = false;
        // Acquire on the way, not only on arrival. This used to be
        // `if (this.rng() < dt * 0.36) this._trigger(...)`, i.e. roughly a 3 %
        // per-tick chance to even attempt a shot, and only while standing at the
        // destination — so a heavy or marksman (which pick 'reposition' often)
        // could spend a whole engagement walking without firing. Suppressing fire
        // while moving is legitimate; the movement spread penalty in _shoot is
        // what makes it inaccurate rather than free.
        if (this.canSeePlayer) {
          this._aimAt(player.pos, dt, 0.68);
          if (contactDist <= this.weaponProfile.range) this._trigger(dt, contactDist);
        } else if (this.lastKnownValid && this.pos.distanceTo(this.reposTarget) < 1.4) {
          this._aimAt(this.lastKnown, dt, 0.22);
        }
        break;
      }
      case 'advance': {
        if (this.canSeePlayer) {
          this._setMoveTarget(player.pos, Math.max(5.5, this.profile.vision * 0.24), 1.75);
          this._aimAt(player.pos, dt, 0.65);
          if (contactDist <= this.weaponProfile.range) this._trigger(dt, contactDist);
        } else if (this.lastKnownValid) {
          this._setMoveTarget(this.lastKnown, 1.7, 1.6);
          this._aimAt(this.lastKnown, dt, 0.25);
        } else this._setMoveTarget(null, 0);
        this.crouching = this.suppressT > 0.5;
        break;
      }
      case 'retreat': {
        this.repositionT += dt;
        if (!this.hasReposTarget || this.repositionT > 4.8 || this.pos.distanceTo(this.reposTarget) < 1.1) {
          this.repositionT = 0;
          this.reposTarget.copy(this._pickRetreatPoint(manager));
          this.hasReposTarget = true;
        }
        this._setMoveTarget(this.reposTarget, 0.75, 1.9);
        this.crouching = this.suppressT > 0.18 || this.health < 55;
        // While retreating, run toward cover; only turn and snap fire if already arrived
        if (this.pos.distanceTo(this.reposTarget) < 1.2 && this.canSeePlayer) {
          this._aimAt(player.pos, dt, 0.48);
          if (this.ammo > 0 && contactDist <= this.weaponProfile.range && this.rng() < dt * 0.16) this._trigger(dt, contactDist);
        }
        break;
      }
      case 'reload':
        break;
    }
  }

  _beginSearch(manager, duration) {
    this.state = 'search';
    this.stateT = 0;
    this.searchT = duration;
    this.searchAttempts = 0;
    this.pauseT = 0;
    this._pickSearchPoint();
    if (manager) manager.combatTimeout(this);
  }

  _startReload(manager) {
    if (this.reloadT > 0 || this.ammo >= this.magSize || this.reserveAmmo <= 0) return false;
    this.reloadT = this.reloadDuration * (1 + (this.suppressT > 0 ? 0.12 : 0));
    this.combatAction = 'reload';
    this.burstLeft = 0;
    this.burstT = 0;
    this._setMoveTarget(null, 0);
    this.crouching = !!this.coverPoint || this.suppressT > 0;
    this.lastReloadAt = this.game.time;
    if (this.game.audio && this.game.audio.radioSquelch && this.rng() < 0.35) this.game.audio.radioSquelch(this.pos);
    void manager;
    return true;
  }

  _pickCover(manager, distToContact) {
    const points = this.game.world.coverPoints || [];
    if (!this.canSeePlayer && !this.lastKnownValid) { this.coverPoint = null; return; }
    const threat = this.canSeePlayer ? this.game.player.pos : this.lastKnown;
    const dirToThreat = _pv1.copy(threat).sub(this.pos).setY(0).normalize();
    let best = null;
    let bestScore = -1e9;
    const start = points.length ? Math.floor(this.rng() * points.length) : 0;
    const count = Math.min(points.length, 6);
    for (let n = 0; n < count; n++) {
      const cp = points[(start + n) % points.length];
      const d = this.pos.distanceTo(cp.pos);
      if (d > 18 || d < 0.9 || !this._isClearPosition(cp.pos, 1.72)) continue;
      const normal = cp.normal || _pv2.set(0, 0, 1);
      let score = -d * 0.32 + normal.dot(dirToThreat) * 3.8;
      const coverEye = _pv2.set(cp.pos.x, cp.pos.y + 1.15, cp.pos.z);
      const threatEye = _pv3.set(threat.x, threat.y + 1.05, threat.z);
      if (!this.game.physics.hasLOS(coverEye, threatEye)) score += 3.1;
      else score -= 1.8;
      if (this.health < 48 || this.suppressT > 0) score += d * 0.12;
      if (distToContact < 9) score -= normal.dot(dirToThreat) * 0.8;
      if (this.archetype === 'marksman') {
        score += THREE.MathUtils.clamp(cp.pos.y, -1, 5) * 0.62;
        score += Math.min(1.5, d * 0.07); // prefers a little stand-off distance
      }
      if (this.archetype === 'heavy') score += 0.65;
      if (this.archetype === 'recon') score += Math.abs(normal.dot(dirToThreat)) * 0.6;
      for (const e of manager.list) {
        if (e === this || !e.alive || e.fled || e.surrendered) continue;
        const ed = e.pos.distanceTo(cp.pos);
        if (ed < 2.1) score -= 5.5;
        else if (ed < 4) score -= 1.3;
        if (e.coverPoint === cp) score -= 4.5;
      }
      if (score > bestScore) { bestScore = score; best = cp; }
    }
    this.coverPoint = bestScore > -2.8 ? best : null;
    if (!this.coverPoint) this.combatAction = 'reposition';
  }

  _peekFromCover(threat) {
    if (!this.coverPoint || !this.coverPoint.normal || !threat) return false;
    const cp = this.coverPoint;
    const normal = cp.normal;
    const tangent = _pv1.set(-normal.z, 0, normal.x).normalize();
    const threatEye = _pv3.set(threat.x, threat.y + 1.0, threat.z);
    const signs = [this.strafeSide || 1, -(this.strafeSide || 1)];
    for (const sign of signs) {
      for (const offset of [0.85, 1.35, 0.52]) {
        _pv2.copy(cp.pos).addScaledVector(tangent, sign * offset);
        _pv2.addScaledVector(normal, 0.18);
        if (!this._isClearPosition(_pv2, 1.65)) continue;
        const eye = _pv4.set(_pv2.x, _pv2.y + 1.35, _pv2.z);
        if (!this.game.physics.hasLOS(eye, threatEye)) continue;
        if (this.game.throwables && this.game.throwables.smokeBlocksLOS(eye, threatEye)) continue;
        this.peekPoint.copy(_pv2);
        this.strafeSide = sign;
        return true;
      }
    }
    this.peekPoint.copy(cp.pos);
    return false;
  }

  _pickRetreatPoint(manager) {
    // Retreat only from a visual threat or remembered evidence; if sight is
    // lost, the live player transform is deliberately not consulted.
    const threat = this.canSeePlayer ? this.game.player.pos : this.lastKnownValid ? this.lastKnown : null;
    const away = threat
      ? _pv1.copy(this.pos).sub(threat).setY(0)
      : _pv1.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    if (away.lengthSq() < 0.001) away.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    away.normalize();
    let best = null, bestScore = -Infinity;
    const cover = this.game.world.coverPoints || [];
    for (let i = 0; i < Math.min(cover.length, 28); i++) {
      const cp = cover[i];
      const dx = cp.pos.x - this.pos.x, dz = cp.pos.z - this.pos.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 3 || distance > 16 || !this._isClearPosition(cp.pos, 1.7)) continue;
      const directionScore = (dx * away.x + dz * away.z) / distance;
      if (directionScore < 0.16) continue;
      let score = directionScore * 3.2 - distance * 0.16;
      if (threat && !this.game.physics.hasLOS(
        _pv2.set(cp.pos.x, cp.pos.y + 1.05, cp.pos.z),
        _pv3.set(threat.x, threat.y + 1.05, threat.z))) score += 2.5;
      for (const ally of manager.list) {
        if (ally === this || !ally.alive || ally.fled || ally.surrendered) continue;
        const gap = ally.pos.distanceTo(cp.pos);
        if (gap < 2.2) score -= 4;
        if (ally.coverPoint === cp) score -= 3;
      }
      if (score > bestScore) { bestScore = score; best = cp.pos; }
    }
    if (best) return best;
    for (let i = 0; i < 8; i++) {
      const side = this.rng() < 0.5 ? -1 : 1;
      const perp = _pv2.set(-away.z * side, 0, away.x * side);
      this._reposScratch.copy(this.pos).addScaledVector(away, 5 + this.rng() * 5).addScaledVector(perp, (this.rng() - 0.5) * 5);
      this._reposScratch.y = this.pos.y;
      if (this._isClearPosition(this._reposScratch, 1.7)) return this._reposScratch;
    }
    return this._reposScratch.copy(this.pos).addScaledVector(away, 4);
  }

  _pickReposPoint(manager, distToContact) {
    const dir = this.canSeePlayer
      ? _pv1.copy(this.game.player.pos).sub(this.pos).setY(0)
      : this.lastKnownValid ? _pv1.copy(this.lastKnown).sub(this.pos).setY(0)
        : _pv1.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    if (dir.lengthSq() < 0.001) dir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    dir.normalize();
    const side = this.rng() < 0.5 ? 1 : -1;
    const perp = _pv2.set(-dir.z * side, 0, dir.x * side);
    const forward = THREE.MathUtils.clamp((distToContact - 15) * 0.18, -3.5, 4.5) * (0.65 + this.aggression * 0.45);
    for (let tries = 0; tries < 7; tries++) {
      this._reposScratch.copy(this.pos)
        .addScaledVector(perp, 3.5 + this.rng() * 4.8)
        .addScaledVector(dir, forward * (0.55 + this.rng() * 0.55));
      this._reposScratch.y = this.pos.y;
      let ok = true;
      for (const e of manager.list) {
        if (e === this || !e.alive || e.fled || e.surrendered) continue;
        if (e.pos.distanceToSquared(this._reposScratch) < 7.5) { ok = false; break; }
      }
      if (ok && this._isClearPosition(this._reposScratch)) return this._reposScratch;
    }
    this._reposScratch.copy(this.pos).addScaledVector(perp, 2.8);
    return this._reposScratch;
  }

  _aimAt(target, dt, tracking) {
    const to = _pv5.set(target.x - this.pos.x, 0, target.z - this.pos.z);
    // Bearing is undefined at ~zero range (atan2 of a near-zero vector jumps
    // between arbitrary angles): hold the current aim instead of spinning.
    if (to.x * to.x + to.z * to.z < 0.0625) return;
    const targetYaw = Math.atan2(-to.x, -to.z);
    if (!Number.isFinite(this.aimYaw)) this.aimYaw = 0;
    let diff = targetYaw - this.aimYaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const turn = THREE.MathUtils.clamp(diff, -5.5 * dt * tracking, 5.5 * dt * tracking);
    this.aimYaw += turn;
    while (this.aimYaw > Math.PI) this.aimYaw -= Math.PI * 2;
    while (this.aimYaw < -Math.PI) this.aimYaw += Math.PI * 2;
    // The body follows the aim at a *body* rate. This used to be a plain
    // `this.yaw = this.aimYaw` copy every aim tick, so a strafing soldier's
    // torso whipped around at up to 5.5 rad/s while his feet were heading
    // somewhere else — precisely the "spinning / walking sideways while facing
    // another direction" report. A small lead belongs to the aim alone: that is
    // what the upper-body aim yaw is for.
    let bd = this.aimYaw - this.yaw;
    while (bd > Math.PI) bd -= Math.PI * 2;
    while (bd < -Math.PI) bd += Math.PI * 2;
    const bodyRate = Math.abs(bd) > 0.22
      ? (this.state === 'combat' ? AI_MOVE.COMBAT_TURN : AI_MOVE.ALERT_TURN)
      : 0;
    if (bodyRate > 0) {
      this.yaw += THREE.MathUtils.clamp(bd, -bodyRate * dt, bodyRate * dt);
      while (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
      while (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    }
  }

  _trigger(dt, distToPlayer) {
    // A burst may only progress while the actor has fresh, in-cone visual
    // contact and unobstructed sight. Last-known memory is never a firing cue.
    if (!this.alive || this.state !== 'combat' || !this.canSeePlayer || !this.hasLOS) {
      this.burstLeft = 0;
      return;
    }
    if (this.reloadT > 0) return;
    if (this.ammo <= 0) {
      this._startReload(null);
      return;
    }
    if (this.windupT > 0) { this.windupT = Math.max(0, this.windupT - dt); return; }
    if (this.burstLeft <= 0) {
      this.burstPause -= dt;
      if (this.burstPause <= 0) {
        this.burstLeft = Math.min(this.ammo, this.burstLen + (this.weaponType === 'marksman' || this.weaponType === 'shotgun' ? 0 : this.skill > 1.1 ? 1 : 0));
        this.burstT = 0;
        const pause = this.weaponProfile.burstPause;
        const skillScale = THREE.MathUtils.clamp(1.22 - this.skill * 0.22, 0.72, 1.18);
        this.burstPause = (pause[0] + this.rng() * (pause[1] - pause[0])) * skillScale;
      }
      return;
    }
    this.burstT -= dt;
    if (this.burstT <= 0) {
      if (this.ammo <= 0) { this.burstLeft = 0; this._startReload(null); return; }
      this.burstT = this.weaponProfile.cadence * (1 + Math.max(0, 1 - this.skill) * 0.28);
      const fired = this._shoot(distToPlayer);
      if (fired === null) { this.burstT = 0.06; return; } // bore is still rotating onto the sight line
      if (!fired) {
        this.burstLeft = 0;
        this.canSeePlayer = false;
        this.hasLOS = false;
        return;
      }
      this.burstLeft--;
      this.ammo--;
      this.lastFireAt = this.game.time;
      this.fireKickT = 1;
    }
  }

  _checkMorale(dt, manager) {
    if (this.surrendered || this.fleeing || this.fled || this.state === 'surrendering') return;
    const pressured = this.suppressT > 0 || this.stress > 0.42;
    if (this.health > 29 && this.armor > 0 && !pressured) return;
    for (const ally of manager.list) {
      if (ally === this || !ally.alive || ally.surrendered || ally.fled) continue;
      if (ally.pos.distanceToSquared(this.pos) < 12.5 * 12.5) {
        this.moraleT = Math.max(0, this.moraleT - dt * 1.8);
        return;
      }
    }
    const threat = this.canSeePlayer ? this.game.player.pos : (this.lastKnownValid ? this.lastKnown : null);
    const knownRange = threat ? this.pos.distanceTo(threat) : Infinity;
    const severelyWounded = this.health < 23 || (this.health < 42 && this.armor <= 0);
    if (!severelyWounded && !pressured) return;
    this.moraleT += dt * (0.8 + this.stress * 0.5) / Math.max(0.55, this.morale);
    const threshold = 2.4 + this.morale * 2.2;
    if (this.moraleT < threshold) return;
    this.moraleT = -20; // a single decision per encounter; do not roll every frame
    const breakChance = THREE.MathUtils.clamp(0.2 + this.stress * 0.32 + (this.health < 15 ? 0.22 : 0), 0.18, 0.82);
    if (this.rng() > breakChance) return;
    if (this.canSeePlayer && knownRange < 8 && this.rng() < 0.55) this._surrender();
    else this._flee(manager);
  }

  _surrender() {
    this.surrendered = true;
    this.fleeing = false;
    this.state = 'surrendering';
    this.stateT = 0;
    this.crouching = true;
    this.model.rifle.visible = false;
    this.throwT = 0;
    this.reloadT = 0;
    this.burstLeft = 0;
    this.contactConfirmed = false;
    if (this.flash) this.flash.intensity = 0;
  }

  _flee(manager) {
    this.fleeing = true;
    this.state = 'flee';
    this.stateT = 0;
    this.throwT = 0;
    this.reloadT = 0;
    this.contactConfirmed = false;
    const hasEvidence = this.canSeePlayer || this.lastKnownValid;
    const threat = this.canSeePlayer ? this.game.player.pos : (this.lastKnownValid ? this.lastKnown : null);
    const away = threat
      ? _pv1.copy(this.pos).sub(threat).setY(0)
      : _pv1.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    if (away.lengthSq() < 0.001) away.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    away.normalize();
    const side = _pv2.set(-away.z, 0, away.x).multiplyScalar(this.rng() < 0.5 ? -1 : 1);
    this.searchPoint.copy(this.pos).addScaledVector(away, 13 + this.rng() * 9).addScaledVector(side, 3 + this.rng() * 5);

    // Existing authored escape spawns are only a fallback, selected against
    // the remembered threat point—not the player's hidden live coordinates.
    const spawns = this.game.world.surgeSpawns || [];
    if (hasEvidence && spawns.length) {
      let best = null, bestScore = -Infinity;
      for (const s of spawns) {
        if (!s || !s.pos || !this._isClearPosition(s.pos)) continue;
        const fromThreat = s.pos.distanceToSquared(threat);
        const travelCost = s.pos.distanceToSquared(this.pos) * 0.08;
        const score = fromThreat - travelCost;
        if (score > bestScore) { bestScore = score; best = s.pos; }
      }
      if (best && best.distanceToSquared(this.pos) > 12 * 12) this.searchPoint.copy(best);
    }
    void manager;
  }

  _shoot(distToPlayer) {
    const g = this.game;
    const player = g.player;
    if (!player.alive || !this.alive || !this.canSeePlayer || !this.hasLOS || this.state !== 'combat') return false;
    if (!this.canAct()) return false;          // staggered/downed soldiers cannot shoot
    const eye = this.eyePos(_pv8);
    const chest = _pv9.set(player.pos.x, player.pos.y + THREE.MathUtils.lerp(1.02, 0.76, player.crouchT || 0), player.pos.z);
    const directDist = eye.distanceTo(chest);
    const viewForward = _pv3.set(-Math.sin(this.aimYaw), 0, -Math.cos(this.aimYaw));
    const viewTo = _pv4.copy(chest).sub(eye).setY(0).normalize();
    if (directDist > this.visionRange || directDist > this.weaponProfile.range ||
        viewForward.dot(viewTo) < Math.cos(this.fov * DEG * 0.5) ||
        !g.physics.hasLOS(eye, chest) || (g.throwables && g.throwables.smokeBlocksLOS(eye, chest))) {
      if (directDist > this.visionRange || !g.physics.hasLOS(eye, chest)) {
        this.canSeePlayer = false;
        this.hasLOS = false;
        return false;
      }
      return null; // still orient/advance; do not fake a long-range hit
    }

    const muzzle = this.model.muzzle;
    muzzle.getWorldPosition(this._muzzleWorld);
    const origin = this._muzzleWorld;
    const target = _pv1.set(
      player.pos.x + (player.vel ? player.vel.x * 0.10 : 0),
      player.pos.y + THREE.MathUtils.lerp(0.86, 1.20, player.crouchT || 0),
      player.pos.z + (player.vel ? player.vel.z * 0.10 : 0),
    );
    const desired = _pv2.copy(target).sub(origin);
    const directLength = desired.length();
    if (directLength < 0.1) return null;
    desired.multiplyScalar(1 / directLength);
    const bore = muzzle.getWorldDirection(_pv3).normalize();
    // Fire from the weapon's actual bore, never a separate eye-ray. The small
    // readiness tolerance gives the articulated hands time to settle after a
    // turn instead of allowing an instantaneous weapon/shot snap.
    const alignment = bore.dot(desired);
    if (alignment < 0.88) return null;

    let spreadDeg = (0.62 + Math.max(0, 1.15 - this.skill) * 1.18) * this.weaponProfile.spread * this.spreadMod;
    spreadDeg *= THREE.MathUtils.clamp(directLength / 30, 0.78, 1.72);
    if (this.suppressT > 0) spreadDeg *= 1.8;
    if (this.moveSpeed > 1.0) spreadDeg *= 1.42;
    if (this.armHitT > 0) spreadDeg *= 1.7;
    if (this.crouching) spreadDeg *= 0.78;
    spreadDeg *= 1 + Math.max(0, this.burstLen - this.burstLeft) * 0.12;
    if (this.stress > 0.55) spreadDeg *= 1 + this.stress * 0.4;
    const spread = spreadDeg * DEG;

    // A stable tangent frame creates a cone about the displayed muzzle axis.
    const right = this._shotRight.crossVectors(bore, _pv4.set(0, 1, 0));
    if (right.lengthSq() < 1e-4) right.set(1, 0, 0);
    right.normalize();
    const up = this._shotUp.crossVectors(right, bore).normalize();
    const pboxMin = _pv5.set(player.pos.x - 0.34, player.pos.y, player.pos.z - 0.34);
    const pboxMax = _pv6.set(player.pos.x + 0.34, player.pos.y + THREE.MathUtils.lerp(1.8, 1.2, player.crouchT), player.pos.z + 0.34);
    const vehicle = g.vehicleMode && g.vehicleMode.drivable ? g.vehicleMode : null;
    const pellets = this.weaponProfile.pellets;
    const range = this.weaponProfile.range;
    const damageByZone = { head: 0, torso: 0, arms: 0, legs: 0 };
    let vehicleDamage = 0;
    let firstImpact = null;
    let firstImpactNormal = null;
    let firstImpactMaterial = 'concrete';
    let tracerEnd = null;
    let crackedNearPlayer = false;
    let totalHits = 0;

    g.particles.muzzleFlash(origin, bore, false, this.weaponType === 'lmg' || this.weaponType === 'shotgun' ? 1.25 : 0.9);
    g.audio.gunshot(this.weaponProfile.audio, origin, { gain: this.weaponType === 'marksman' || this.weaponType === 'lmg' ? 0.95 : 0.82 });
    g.emitNoise(origin, this.weaponType === 'marksman' || this.weaponType === 'lmg' ? 78 : 56, 'enemy_shot', this, 1);

    for (let pellet = 0; pellet < pellets; pellet++) {
      const dir = this._shotDir.copy(bore);
      // Uniform-ish disk sampling around the bore; one ray for rifles, eight
      // individually collision-tested pellets for the tactical shotgun.
      const angle = this.rng() * Math.PI * 2;
      const radius = Math.sqrt(this.rng()) * spread * (pellets > 1 ? 1.55 : 1);
      dir.addScaledVector(right, Math.cos(angle) * radius);
      dir.addScaledVector(up, Math.sin(angle) * radius);
      dir.normalize();

      let dPlayer = null, dVehicle = null;
      let localHit = null;
      if (vehicle) {
        const vh = vehicle.visibleHit(origin, dir, range);
        if (vh) dVehicle = vh.dist;
      } else {
        dPlayer = rayAABBLocal(origin, dir, pboxMin, pboxMax, range, this._shotLocal);
        if (dPlayer !== null) localHit = { x: this._shotLocal.x, y: this._shotLocal.y, z: this._shotLocal.z, dist: dPlayer };
      }
      const targetDist = vehicle ? dVehicle : dPlayer;

      // Test actual world surfaces along the bullet ray. Breakable glass may
      // pass the round after shattering; solid walls/terrain stop it before a
      // player/vehicle hit. worldHit distances are translated back to muzzle space.
      this._shotFrom.copy(origin);
      let travelled = 0;
      let remaining = targetDist !== null ? targetDist : range;
      let surfaceHit = null;
      let glassMult = 1;
      for (let pass = 0; pass < 4 && remaining > 0.08; pass++) {
        const wh = g.physics.raycast(this._shotFrom, dir, remaining);
        if (!wh) break;
        const absoluteDist = travelled + wh.dist;
        if (wh.collider && wh.collider.breakable) {
          g.world.breakGlass(wh.collider);
          g.particles.glassBurst(wh.point, wh.normal);
          g.audio.impact('glass', wh.point);
          glassMult *= 0.85;
          const advance = wh.dist + 0.065;
          travelled += advance;
          remaining -= advance;
          this._shotFrom.copy(wh.point).addScaledVector(dir, 0.065);
          continue;
        }
        // Phase-14: barrier walls absorb hostile fire (placement matters).
        if (wh.collider && wh.collider.tag === 'shield' && g.shield) {
          g.shield.onHit(wh.collider, wh.point, this.weaponProfile.damage * 0.9);
        }
        surfaceHit = { hit: wh, dist: absoluteDist };
        break;
      }

      const playerFirst = targetDist !== null && (!surfaceHit || targetDist < surfaceHit.dist);
      let pelletHit = false;
      if (playerFirst && vehicle && dVehicle !== null) {
        vehicleDamage += this.weaponProfile.damage * glassMult;
        totalHits++;
        pelletHit = true;
        if (!tracerEnd) tracerEnd = this._shotEnd.copy(origin).addScaledVector(dir, dVehicle).clone();
      } else if (playerFirst && dPlayer !== null && localHit) {
        const height = THREE.MathUtils.lerp(1.8, 1.2, player.crouchT);
        const hy = (localHit.y - player.pos.y) / height;
        const lateral = Math.max(Math.abs(localHit.x - player.pos.x), Math.abs(localHit.z - player.pos.z));
        let zone = 'legs';
        if (hy > 0.84) zone = 'head';
        else if (hy > 0.42) zone = lateral > 0.3 ? 'arms' : 'torso';
        const falloff = directLength > 35 ? THREE.MathUtils.clamp(1 - (directLength - 35) / Math.max(1, range - 35) * 0.45, 0.52, 1) : 1;
        // CRITICAL FIX: a raised (held) AEGIS shield inside its frontal cover
        // cone takes the round on its own HP instead of the operator.
        if (g.shield && g.shield.heldBlocks && g.shield.heldBlocks(dir, zone)) {
          const hitPt = this._shotEnd.copy(origin).addScaledVector(dir, Math.max(0, dPlayer - 0.45)).clone();
          g.shield.absorbHeld(this.weaponProfile.damage * glassMult * falloff, hitPt);
          if (!tracerEnd) tracerEnd = hitPt;
        } else {
          damageByZone[zone] += this.weaponProfile.damage * ZONE_MULT[zone] * glassMult * falloff;
          if (!tracerEnd) tracerEnd = this._shotEnd.copy(origin).addScaledVector(dir, dPlayer).clone();
        }
        totalHits++;
        pelletHit = true;
      }

      if (!playerFirst && surfaceHit) {
        if (!firstImpact) {
          firstImpact = surfaceHit.hit.point.clone();
          firstImpactNormal = surfaceHit.hit.normal.clone();
          firstImpactMaterial = surfaceHit.hit.collider.material || 'concrete';
          tracerEnd = firstImpact.clone();
        }
      } else if (!tracerEnd && pellet === 0) {
        tracerEnd = this._shotEnd.copy(origin).addScaledVector(dir, Math.min(range, directLength + 2)).clone();
      }

      // A near miss can suppress; proximity never deals health damage.
      if (!pelletHit) {
        const px = player.pos.x - origin.x;
        const py = player.pos.y + 1.15 - origin.y;
        const pz = player.pos.z - origin.z;
        const along = px * dir.x + py * dir.y + pz * dir.z;
        if (along > 0 && along < range) {
          const dx = px - dir.x * along, dy = py - dir.y * along, dz = pz - dir.z * along;
          if (dx * dx + dy * dy + dz * dz < (pellets > 1 ? 2.4 : 1.55)) crackedNearPlayer = true;
        }
      }
    }

    if (vehicleDamage > 0 && vehicle) {
      const point = tracerEnd || origin;
      vehicle.damage(vehicleDamage * 1.5, g, point);
    }
    for (const zone of ['head', 'torso', 'arms', 'legs']) {
      if (damageByZone[zone] > 0) {
        const point = tracerEnd || target;
        player.damage(zone, damageByZone[zone], this.pos.clone());
        g.particles.impact(point, _pv7.copy(this._shotDir).negate(), 'fabric', 0.55);
      }
    }
    if (firstImpact) g.onWorldImpact(firstImpact, firstImpactNormal, firstImpactMaterial, 0.75);
    if (crackedNearPlayer) player.addSuppress(pellets > 1 ? 0.20 : 0.28);
    if (!tracerEnd) tracerEnd = this._shotEnd.copy(origin).addScaledVector(bore, Math.min(range, directLength + 2)).clone();
    // Player's pooled tracer shortens the streak to the impact end; its endpoint
    // is therefore the same wall/player point at which this hitscan stopped.
    if (this.weaponType !== 'shotgun' || this.rng() < 0.25) g.particles.tracer(origin, tracerEnd);
    this.shotsFired = (this.shotsFired || 0) + 1;
    this.shotHits = (this.shotHits || 0) + totalHits;
    this.lastShotImpact = firstImpact ? 'world' : totalHits ? 'target' : 'miss';
    return true;
  }

  // =========================================================================
  damageTaken(zone, amount, point, dir, manager) {
    if (!this.alive) return false;
    const g = this.game;
    const rawDamage = Math.max(0, amount * (ZONE_MULT[zone] || 1));
    const armorEfficiency = zone === 'head' ? 0.08 : zone === 'legs' ? 0.3 : 0.46;
    const absorbed = Math.min(this.armor, rawDamage * armorEfficiency);
    this.armor = Math.max(0, this.armor - absorbed);
    this.health -= rawDamage - absorbed;
    this.flinchT = zone === 'head' ? 1.4 : 0.9;
    this.hitSerial = (this.hitSerial || 0) + 1;   // presentation only (skinned hit reaction)
    this.lastHitZone = zone;
    this.flinchDir.copy(dir || _pv2.set(0, 0, 1)).setY(0).normalize();
    this.suppressT = Math.max(this.suppressT, (zone === 'head' ? 1.2 : 0.8) / Math.max(0.6, this.suppressionResistance));
    this.stress = Math.min(1, this.stress + 0.24);
    this.stressT = Math.max(this.stressT, 4.5);

    if (zone === 'legs') this.legHitT = 4.5;
    if (zone === 'arms') this.armHitT = 4;

    // A hit gives a direction/bearing and approximate range, never the live
    // player transform. Visual contact must still be acquired through LOS/FOV.
    const sourceRange = 7 + this.rng() * 18;
    _pv1.copy(this.pos).addScaledVector(this.flinchDir, -sourceRange);
    _pv1.y = this.pos.y;
    const uncertainty = 7 + this.rng() * 9;
    this._rememberPoint(_pv1, 0.46, uncertainty, 'incoming-fire');
    this.contactConfirmed = false;
    this.canSeePlayer = false;
    this.state = 'alert';
    this.stateT = 0;
    this.alertT = 0.22 + this.rng() * 0.4;
    this.detection = Math.max(this.detection, 0.22);
    if (manager) manager.onAllyShot(this, _pv1);

    this.vel.addScaledVector(this.flinchDir, zone === 'head' ? 0.6 : 1.4);
    if (this.health <= 0) {
      this.health = 0;
      this.die(point, dir);
      return true;
    }
    return false;
  }

  die(point, dir) {
    if (!this.alive) return;
    this.alive = false;
    // A corpse stops being a solid body: no walking into a dead weight, and no
    // corridor permanently blocked by a body that can never get up.
    if (this.game && this.game.physics) unregisterActorBody(this.game.physics, this);
    this.bodyState = BODY_STATE.STANDING;
    this.downBlend = 0;
    this.state = 'dead';
    this.canSeePlayer = false;
    this.hasLOS = false;
    this.deathT = 0.001;
    this.corpseT = 0;
    this.deathDuration = 0.58 + this.rng() * 0.32;
    this.deathStyle = this.rng();
    this.deathYaw = this.model.root.rotation.y;
    this.deathAxis.set(dir ? -dir.z : 1, 0, dir ? dir.x : 0).normalize();
    if (this.deathAxis.lengthSq() < 0.1) this.deathAxis.set(1, 0, 0);
    this.game.audio.radioSquelch(this.pos.clone().setY(this.pos.y + 1.2));
    this.game.audio.impact('fabric', this.pos.clone().setY(this.pos.y + 0.9), 0.8);
    this.game.particles.impact(
      point || this.pos.clone().setY(this.pos.y + 1.2),
      dir ? dir.clone().negate() : new THREE.Vector3(0, 1, 0),
      'fabric', 0.7
    );
    if (this.game.enemies) this.game.enemies.onAllyDown(this);
  }

  _updateDeath(dt) {
    const root = this.model.root;
    if (this.rig) {
      // Skinned death clip (in place); the root is NOT tilted so the corpse
      // lies where the actor died. Corpse timing is unchanged.
      this._actualVX = 0;
      this._actualVZ = 0;
      this._driveRig();
      if (this.deathT < 1) { this.deathT = Math.min(1, this.deathT + dt / this.deathDuration); return; }
      this.corpseT += dt;
      if (this.corpseT > 20) this.corpseExpired = true;
      return;
    }
    if (this.deathT < 1) {
      this.deathT = Math.min(1, this.deathT + dt / this.deathDuration);
      const eased = this.deathT * this.deathT * (3 - 2 * this.deathT);
      const fall = eased * (0.82 + this.deathStyle * 0.16);
      root.rotation.set(0, this.deathYaw, 0);
      root.rotateOnWorldAxis(this.deathAxis, fall * Math.PI * 0.46);
      root.position.y = this.pos.y - Math.sin(fall * Math.PI * 0.5) * 0.24;
      this.model.armL.shoulder.rotation.x = fall * (0.5 + this.deathStyle * 0.5);
      this.model.armR.shoulder.rotation.x = -fall * (0.4 + (1 - this.deathStyle) * 0.4);
      this.model.legL.rotation.x = fall * 0.24;
      this.model.legR.rotation.x = -fall * 0.16;
      return;
    }
    this.corpseT += dt;
    if (this.corpseT > 20) this.corpseExpired = true;
  }

  // =========================================================================
  _setMoveTarget(target, arriveDist = 1.0, speed = 1.6) {
    if (!target) { this._wish.set(0, 0, 0); this._cmdSpeed = 0; return true; }
    // Keep alerted/combat pursuit deliberate instead of sprinting down a target;
    // searching actors have a slightly higher cap so they remain responsive.
    speed = Math.min(speed, this.state === 'combat' || this.state === 'alert' ? 1.65 : 2.25);
    const to = _pv1.set(target.x - this.pos.x, 0, target.z - this.pos.z);
    const dist = to.length();
    if (dist < arriveDist) { this._wish.set(0, 0, 0); this._cmdSpeed = 0; return true; }
    to.multiplyScalar(1 / dist);

    // Reused three-ray whisker probe: prefer the more open side without
    // allocating temporary vectors/functions in the per-actor update loop.
    const probeLen = 1.35 + speed * 0.3;
    const eye = this.eyePos(_pv2);
    const origin = _pv4.copy(eye).setY(this.pos.y + 0.72);
    // Actor bodies and vehicle hulls are part of what must be steered around,
    // otherwise a soldier walks head-first into a parked truck forever.
    const probeOpts = this.game.physics.actors.count ? ACTOR_PROBE_OPTS : NO_PROBE_OPTS;
    const hit = this.game.physics.raycast(origin, to, probeLen, probeOpts);
    this._steerBlocked = !!(hit && hit.dist < probeLen * 0.55);
    if (hit && hit.dist < probeLen) {
      const left = _pv5.set(-to.z, 0, to.x);
      const hitL = this.game.physics.raycast(origin, left, probeLen * 0.8, probeOpts);
      const dL = hitL ? hitL.dist : probeLen;
      const right = _pv6.set(to.z, 0, -to.x);
      const hitR = this.game.physics.raycast(origin, right, probeLen * 0.8, probeOpts);
      const dR = hitR ? hitR.dist : probeLen;
      // Side choice with hysteresis. Re-deciding from scratch every tick made
      // soldiers at a corner flip sides whenever one whisker grazed the edge
      // (measured: +/-0.8 rad heading swings every ~0.2 s, zero progress).
      // Keep the committed side for ~1 s unless the other is clearly more open.
      let sideSign = dL > dR ? 1 : -1;
      const now = this.game.time;
      if (this._avoidSide && now - this._avoidAt < 1.0 && sideSign !== this._avoidSide) {
        const keepD = this._avoidSide > 0 ? dL : dR, otherD = this._avoidSide > 0 ? dR : dL;
        if (otherD - keepD < probeLen * 0.3) sideSign = this._avoidSide;
      }
      this._avoidSide = sideSign;
      this._avoidAt = now;
      const side = sideSign > 0 ? left : right;
      const blend = THREE.MathUtils.clamp(1 - hit.dist / probeLen, 0.2, 0.9);
      to.addScaledVector(side, blend * 1.15).normalize();
    } else if (this._avoidSide && this.game.time - this._avoidAt < 0.45) {
      // Finish the side-step for a moment after the probe clears: dropping it
      // the instant the ray grazed past the corner put the body straight back
      // against it (clear/blocked dither on alternate ticks, no progress).
      const sx = this._avoidSide > 0 ? -to.z : to.z, sz = this._avoidSide > 0 ? to.x : -to.x;
      to.x += sx * 0.45; to.z += sz * 0.45; to.normalize();
    }

    if (this.state !== 'combat' || !this.canSeePlayer) {
      const targetYaw = Math.atan2(-to.x, -to.z);
      if (!Number.isFinite(this.yaw)) this.yaw = 0;
      let diff = targetYaw - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const stepDt = this._currentDt || 0.08;
      const turnCap = this.state === 'combat' ? AI_MOVE.COMBAT_TURN
        : this.state === 'alert' ? AI_MOVE.ALERT_TURN : AI_MOVE.CALM_TURN;
      const turnRate = Math.min(
        THREE.MathUtils.clamp(4.6 / (this.profile.reaction * (this.reactionMod || 1)), 2.8, 6.0),
        turnCap,
      );
      // A near-reversal is a turn-around, not a slide: bleed speed through it so
      // the feet (which follow actual travel) stay in step with the body.
      if (Math.abs(diff) > 2.35 && this.moveSpeed > 1.2) {
        this._reverseDwell = AI_MOVE.REVERSAL_DWELL;
      } else if (this._reverseDwell > 0) {
        this._reverseDwell -= stepDt;
        speed *= 0.55;
      }
      this.yaw += THREE.MathUtils.clamp(diff, -turnRate * stepDt, turnRate * stepDt);
      while (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
      while (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
      // Smoothly turn toward travel direction before sprinting full speed
      const turnFactor = THREE.MathUtils.clamp((Math.cos(diff) + 0.3) / 1.3, 0.2, 1);
      speed *= turnFactor;
    }

    // Target-progress watchdog (complements the displacement one in _move):
    // zig-zagging inside a concave pocket slides > 0.6 m per sweep yet never
    // gets closer. Same target (re-estimates < 2 m count as the same) and no
    // 0.4 m improvement within 3.5 s -> the existing stuck recovery.
    if (!(this.state === 'combat' && this.canSeePlayer)) {
      const pt = this._progTgt || (this._progTgt = new THREE.Vector3(Infinity, 0, 0));
      if (Math.abs(pt.x - target.x) + Math.abs(pt.z - target.z) > 2) { pt.copy(target); this._progBest = dist; this._progTT = 0; }
      else if (dist < this._progBest - 0.4) { this._progBest = dist; this._progTT = 0; }
      else if ((this._progTT += (this._currentDt || 0.08)) > 3.5) {
        this._progTT = 0; this._progBest = dist;
        this._stuckRecover();
      }
    }

    const injuryScale = this.legHitT > 0 ? 0.58 : 1;
    const glueScale = this.glueT > 0 ? 0.45 : 1;  // Phase-14 AD-9 adhesive field
    this._wish.copy(to).multiplyScalar(speed * this.speedScale * this.moveScale * injuryScale * glueScale);
    // `_cmdSpeed` is intent; `moveSpeed` is what the accel ramp in _move has
    // actually brought the body up to. Overwriting moveSpeed here with the raw
    // wish made it flicker between ramped and unramped inside a single tick,
    // which the movement-spread penalty and the animation both read.
    this._cmdSpeed = this._wish.length();
    // A soldier closing at a run is a charging body: heavier in an impact.
    this.charging = this.moveSpeed > 3.0 && (this.state === 'combat' || this.state === 'alert' || this.state === 'flee');
    // Wedged against a body/vehicle with no side to slip past: ask the route
    // planner for a new path rather than grinding on the spot.
    if (this._steerBlocked && this.moveSpeed > 0.1) {
      this._blockT = (this._blockT || 0) + (this._currentDt || 0.08);
      if (this._blockT > 0.9) { this._blockT = 0; this.navReplanRequested = true; this._stuckRecover(); }
    } else if (this._blockT) this._blockT = Math.max(0, this._blockT - (this._currentDt || 0.08) * 2);
    return false;
  }

  _move(dt) {
    // Smooth accel/decel (Phase 2): `_wish` carries the *desired* planar
    // velocity. Ramping its magnitude — direction untouched — is what turns a
    // teleporting slide into a walk. Knockback lives in `vel`, not `_wish`, so
    // impact impulses keep their snap.
    const wishSpeed = Math.hypot(this._wish.x, this._wish.z);
    if (wishSpeed > 1e-4 && dt > 1e-5) {
      const prev = this._rampedSpeed || 0;
      const rate = wishSpeed > prev ? AI_MOVE.ACCEL : AI_MOVE.DECEL;
      const stepv = rate * dt;
      const next = Math.abs(wishSpeed - prev) <= stepv
        ? wishSpeed
        : prev + Math.sign(wishSpeed - prev) * stepv;
      const k = next / wishSpeed;
      this._wish.x *= k; this._wish.z *= k;
      this._brakeX = this._wish.x / next;
      this._brakeZ = this._wish.z / next;
      this._rampedSpeed = next;
      this.moveSpeed = next;
    } else if ((this._rampedSpeed || 0) > 1e-4 && dt > 1e-5 && this._brakeX !== undefined) {
      // Braking. The command went away (arrival, state change, lost contact) but
      // the body still has to shed its speed over a few frames; without this an
      // actor stops dead the instant the target is reached, which is the other
      // half of the "sliding" look.
      const prev = this._rampedSpeed || 0;
      const next = Math.max(0, prev - AI_MOVE.DECEL * dt);
      this._wish.x = this._brakeX * next;
      this._wish.z = this._brakeZ * next;
      this._rampedSpeed = next;
      this.moveSpeed = next;
    } else {
      this._rampedSpeed = 0;
      this.moveSpeed = 0;
    }
    // gravity + integrate with collision (same solver as the player)
    this.vel.y -= GRAVITY * dt;
    if (this.vel.y < -40) this.vel.y = -40;

    // damping on knockback impulses
    this.vel.x *= Math.exp(-6 * dt);
    this.vel.z *= Math.exp(-6 * dt);

    const dx = (this._wish.x + this.vel.x) * dt;
    const dz = (this._wish.z + this.vel.z) * dt;
    const dy = this.vel.y * dt;
    // requested planar speed for the impact resolver (a blocked move empties
    // `vel`, so the reaction must be judged on intent, not on the residue)
    this._intentSpeed = dt > 1e-4 ? Math.hypot(dx, dz) / dt : 0;

    this._syncBox();
    const oldX = this.pos.x, oldZ = this.pos.z;
    this.game.physics.moveBox(this.box, dx, dy, dz, this._moveOut, this.onGround ? 0.42 : 0, this._moveOptions());
    // Physical contact with the operator, another soldier, or a vehicle hull.
    if (this._moveOut.contactedActor) {
      processMoveContacts(this, this.game.physics, this._moveOut, dt, { defenderMassScale: 1 });
    } else {
      clearContacts(this);
    }
    const resolvedX = this.box.min.x + 0.32, resolvedZ = this.box.min.z + 0.32;
    const maxHorizontal = Math.hypot(dx, dz) + 0.48;
    if (Math.hypot(resolvedX - oldX, resolvedZ - oldZ) > maxHorizontal) {
      // Collision recovery is never allowed to eject an actor across the map.
      // Hold the last simulated point and ask the route planner for a new path.
      this._syncBox();
      this._motionBlocked = true;
      this.vel.x = 0;
      this.vel.z = 0;
      this._wish.set(0, 0, 0);
      this.moveSpeed = 0;
      if (this.navPath) this.navReplanRequested = true;
    } else {
      this.pos.set(resolvedX, this.box.min.y, resolvedZ);
      if (this._moveOut.blockedSolid && this.navPath) this.navReplanRequested = true;
    }
    // Actual (collision-resolved) ground velocity, read by the presentation
    // rig so legs follow real travel: a soldier pushing into a wall no longer
    // walks on the spot. Teleport-sized jumps (spawn/recovery) read as zero.
    if (dt > 1e-4) {
      const avx = (this.pos.x - oldX) / dt, avz = (this.pos.z - oldZ) / dt;
      const ok = Number.isFinite(avx) && Number.isFinite(avz) && avx * avx + avz * avz < 144;
      this._actualVX = ok ? avx : 0;
      this._actualVZ = ok ? avz : 0;
    }
    this.onGround = this._moveOut.onGround;
    // Gravity is applied every simulation step. Without clearing the downward
    // impulse when the collision solver lands us, it accumulates while grounded
    // until one frame tunnels the actor through the floor collider.
    if (this.onGround && this.vel.y < 0) this.vel.y = 0;
    if (this._moveOut.hitCeil) this.vel.y = Math.min(0, this.vel.y);

    // stuck detection (patrol waypoints can be unreachable)
    const moved = this.pos.distanceTo(this.lastPos);
    this.lastPos.copy(this.pos);
    // Threshold scales with the step length (moves now run per frame for
    // nearby actors; a fixed 4 mm/step would read slow walkers at high
    // frame rates as stuck). 2.5 % of the commanded step == the old value at
    // 1.6 m/s on a 0.1 s tick.
    if (this._motionBlocked || (this.moveSpeed > 0.5 && moved < Math.max(0.0008, this.moveSpeed * dt * 0.025))) {
      this.stuckT += dt;
      if (this.stuckT > 1.6) {
        this.stuckT = 0;
        this._stuckRecover();
      }
    } else this.stuckT = 0;
    // Progress watchdog: dithering against geometry moves a few cm per step
    // (so the per-step test above never trips) but goes nowhere. Commanded to
    // move for 2.5 s without leaving a 0.6 m radius -> same stuck recovery.
    // Not applied while engaging a visible player: advancing fire against a
    // wall is legitimate combat (legs already stop: rig follows real travel).
    if (this.moveSpeed > 0.5 && !(this.state === 'combat' && this.canSeePlayer)) {
      if (!this._progAnchor) this._progAnchor = this.pos.clone();
      const ax = this.pos.x - this._progAnchor.x, az = this.pos.z - this._progAnchor.z;
      if (ax * ax + az * az > 0.36) { this._progAnchor.copy(this.pos); this._progT = 0; }
      else if ((this._progT = (this._progT || 0) + dt) > 2.5) {
        this._progT = 0;
        this._progAnchor.copy(this.pos);
        this.stuckT = 0;
        this._stuckRecover();
      }
    } else if (this._progAnchor) { this._progAnchor.copy(this.pos); this._progT = 0; }
    this._motionBlocked = false;

    // crouch blend
    const cTarget = this.crouching ? 1 : 0;
    this.crouchT = THREE.MathUtils.lerp(this.crouchT, cTarget, 1 - Math.exp(-10 * dt));
  }

  /** Existing stuck response (unchanged behaviour), shared by both detectors. */
  _stuckRecover() {
    this._stuckAt = this.game.time;
    if (this.navPath && this.navPathIndex < this.navPath.length) {
      this.navPath = null;
      this.navPathIndex = 0;
      this.navPathEndMode = 'search';
      this.navReplanRequested = true;
    } else if (this.state === 'patrol' && this.route) this.routeIdx = (this.routeIdx + 1) % this.route.length;
    // Direct (path-less) investigation walks straight at lastKnown, which a new
    // search point doesn't change: ask the existing ground planner for a route
    // around the obstacle (it falls back to 'search' itself after 3 attempts).
    else if (this.state === 'investigate' && !this.navPath) this.navReplanRequested = true;
    else if (this.state === 'investigate' || this.state === 'search') { this._pickSearchPoint(); this.stateT = 0; }
    else this.combatAction = 'reposition';
  }

  _syncAIState() {
    if (!this.alive || this.state === 'dead') { this.aiState = 'DEAD'; return; }
    if (this.state === 'flee') { this.aiState = 'FLEE'; return; }
    if (this.state === 'surrendering') { this.aiState = 'SURRENDER'; return; }
    if (this.health < 46 || this.legHitT > 0) { this.aiState = 'INJURED'; return; }
    if (this.state === 'patrol') { this.aiState = this.pauseT > 0 ? 'IDLE' : 'PATROL'; return; }
    if (this.state === 'wander') { this.aiState = this.pauseT > 0 ? 'IDLE' : 'WANDER'; return; }
    if (this.state === 'suspicious') { this.aiState = 'SUSPICIOUS'; return; }
    if (this.state === 'alert') { this.aiState = 'ALERT'; return; }
    if (this.state === 'investigate') { this.aiState = 'INVESTIGATE'; return; }
    if (this.state === 'search') { this.aiState = 'SEARCH'; return; }
    if (this.state === 'recovering') { this.aiState = 'IDLE'; return; }
    if (this.state === 'combat') {
      if (this.suppressT > 0.18) this.aiState = 'SUPPRESSED';
      else if (this.reloadT > 0) this.aiState = 'RELOAD';
      else if (this.combatAction === 'cover') this.aiState = 'TAKE_COVER';
      else if (this.combatAction === 'retreat') this.aiState = 'RETREAT';
      else if (this.combatAction === 'reposition') this.aiState = this.archetype === 'assault' || this.archetype === 'recon' ? 'FLANK' : 'RETREAT';
      else if (this.combatAction === 'advance' && !this.canSeePlayer) this.aiState = this.lastKnownValid ? 'CHASE' : 'SEARCH';
      else if (this.burstLeft > 0) this.aiState = 'ATTACK';
      else if (this.canSeePlayer) this.aiState = 'AIM';
      else this.aiState = 'CHASE';
      return;
    }
    this.aiState = 'IDLE';
  }

  _animate(dt, manager) {
    void manager;
    const m = this.model;
    m.root.position.set(this.pos.x, this.pos.y, this.pos.z);

    const isEngaging = this.state === 'combat' && (this.combatAction === 'engage' || this.combatAction === 'cover');
    const isAlertAiming = this.state === 'alert' && this.contactConfirmed;
    const aiming = isEngaging || isAlertAiming;

    const moveSpeedSq = this._actualVX * this._actualVX + this._actualVZ * this._actualVZ;
    const isMoving = moveSpeedSq > 0.30;

    // Facing is decided by the brain, never by the mesh. This block used to
    // derive `facing` from actual velocity while moving and then write the
    // smoothed result back into `this.yaw` — a presentation → AI feedback loop:
    // a strafe turned the *logical* facing sideways, which re-aimed the cone,
    // the speed taper and the next steering step, so body and rig chased each
    // other (the reported spinning / sliding / sideways-while-facing), and it
    // overrode the AI turn-rate limits outright. The rig now only eases toward
    // the authoritative yaw; the legs already read `_actualVX/_actualVZ`.
    const facing = aiming ? this.aimYaw : this.yaw;
    if (Number.isFinite(facing)) {
      let d = facing - m.root.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const turnRate = this.archetype === 'marksman' ? 5.5 : 7.2;
      const maxStep = AI_MOVE.COMBAT_TURN * dt;
      m.root.rotation.y += THREE.MathUtils.clamp(d * (1 - Math.exp(-turnRate * dt)), -maxStep, maxStep);
      while (m.root.rotation.y > Math.PI) m.root.rotation.y -= Math.PI * 2;
      while (m.root.rotation.y < -Math.PI) m.root.rotation.y += Math.PI * 2;
    }

    const c = this.crouchT;
    m.body.position.y = -c * 0.37;
    m.legs.scale.y = 1 - c * 0.16;
    const speed = Math.hypot(this._actualVX, this._actualVZ);
    const gait = stepFallbackGait(this.walkPhase, dt, speed);
    this.walkPhase = gait.phase;
    const swing = gait.swing;
    m.legL.rotation.x = swing;
    m.legR.rotation.x = -swing;
    if (m.kneeL) m.kneeL.rotation.x = Math.max(0, -swing) * 0.78;
    if (m.kneeR) m.kneeR.rotation.x = Math.max(0, swing) * 0.78;
    if (m.ankles) {
      m.ankles[0].rotation.x = -swing * 0.32;
      m.ankles[1].rotation.x = swing * 0.32;
    }
    m.body.position.y += gait.bob;

    const surrendered = this.state === 'surrendering';
    const reloading = this.reloadT > 0;
    poseSoldierArms(m, aiming, speed > 0.3, reloading, c, this.fireKickT, surrendered);
    m.rifle.visible = !surrendered && this.weaponType !== 'none';
    const reloadProgress = reloading ? 1 - this.reloadT / Math.max(0.1, this.reloadDuration) : 0;
    const reloadPose = reloading ? Math.sin(THREE.MathUtils.clamp(reloadProgress, 0, 1) * Math.PI) : 0;
    if (m.mag) m.mag.position.y = -0.108 - reloadPose * 0.12;

    let pitchTo = 0;
    let pitchTarget = null;
    if (this.canSeePlayer) pitchTarget = this.game.player.pos;
    else if (this.lastKnownValid && (this.state === 'combat' || this.state === 'alert' || this.state === 'investigate' || this.state === 'search')) pitchTarget = this.lastKnown;
    if (pitchTarget) {
      const horizontal = Math.max(2, Math.hypot(pitchTarget.x - this.pos.x, pitchTarget.z - this.pos.z));
      pitchTo = THREE.MathUtils.clamp((pitchTarget.y + 1.0 - (this.pos.y + 1.35)) / horizontal, -0.32, 0.32);
    }
    // Local +X pitches the forward (-Z) weapon bore upward in Three.js.
    const pitchBlend = 1 - Math.exp(-7 * dt);
    m.torso.rotation.x = THREE.MathUtils.lerp(m.torso.rotation.x, pitchTo * (c ? 0.72 : 1), pitchBlend);

    const headBlend = 1 - Math.exp(-6 * dt);
    // Idle head scan uses a constant per-actor phase. walkPhase is the running
    // gait phase (2.3-6 rad/s), which made heads wobble every 1-2 s.
    const headTo = aiming ? 0 : Math.sin(this.game.time * 0.7 + this.scanSeed) * 0.29;
    m.headGrp.rotation.y = THREE.MathUtils.lerp(m.headGrp.rotation.y, headTo, headBlend);
    if (this.flinchT > 0) {
      const f = Math.sin(this.flinchT * 24) * this.flinchT * 0.13;
      m.torso.rotation.z = f;
      m.headGrp.rotation.z = f * 1.3;
    } else {
      m.torso.rotation.z = THREE.MathUtils.lerp(m.torso.rotation.z, 0, headBlend);
      m.headGrp.rotation.z = THREE.MathUtils.lerp(m.headGrp.rotation.z, 0, headBlend);
    }

    // ---- knockdown / stagger pose ------------------------------------------
    // The whole body pivots about the hips toward the direction it was hit, so
    // a fallen soldier is genuinely on the ground: the visual and the (lowered)
    // collision box are driven by the same downBlend value.
    const down = this.downBlend || 0;
    if (down > 0.002) {
      const fd = this.fallDir;
      const fallYaw = Math.atan2(-fd.x, -fd.z);
      const rel = fallYaw - m.root.rotation.y;
      const angle = down * (1.28 + this.knockSeverity * 0.12);      // ~73 deg, face/hip down
      m.body.rotation.x = Math.cos(rel) * angle;
      m.body.rotation.z = -Math.sin(rel) * angle;
      m.body.position.y = -down * 0.46;
      m.legs.rotation.x = -down * 0.34;
      m.legL.rotation.x = down * 0.52;
      m.legR.rotation.x = -down * 0.22;
      if (m.kneeL) m.kneeL.rotation.x = down * 0.66;
      if (m.kneeR) m.kneeR.rotation.x = down * 0.24;
      m.armL.shoulder.rotation.x = down * 1.18;
      m.armR.shoulder.rotation.x = down * 0.86;
      m.armL.shoulder.rotation.z = down * 0.42;
      m.armR.shoulder.rotation.z = -down * 0.36;
      m.torso.rotation.x = -down * 0.3;
      m.headGrp.rotation.x = -down * 0.22;
      m.rifle.visible = false;
    } else {
      m.body.rotation.x = 0;
      m.body.rotation.z = 0;
      m.legs.rotation.x = 0;
    }

    m.strobe.visible = this.visual.strobe && Math.sin(this.game.time * 3 + this.walkPhase) > 0.2 && down < 0.2;
    if (this.rig) this._driveRig();
    this._syncAIState();
  }

  /** Feed read-only gameplay state to the skinned presentation rig. */
  _driveRig() {
    const s = this._rigState;
    const g = this.game;
    s.time = g.time;
    s.vx = this._actualVX || 0;     // collision-resolved travel, not the command
    s.vz = this._actualVZ || 0;
    s.crouch = Math.max(this.crouchT, this.downBlend || 0);
    s.aiming = this.state === 'combat' || (this.state === 'alert' && this.contactConfirmed);
    s.reloading = this.reloadT > 0;
    s.fireKick = this.fireKickT;
    s.flinch = this.flinchT;
    s.hitSerial = this.hitSerial || 0;
    s.hitZone = this.lastHitZone || 'torso';
    s.surrendered = this.state === 'surrendering';
    s.alive = this.alive;
    const pp = g.player && g.player.pos;
    s.camDist = pp ? Math.hypot(pp.x - this.pos.x, pp.z - this.pos.z) : 0;
    this.rig.update(0, s);
  }
}

// ---------------------------------------------------------------------------
// Manager: spawning, squad coordination, noise distribution
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Civilian / friendly NPC — wanders waypoints, flees gunfire, can be escorted
// ---------------------------------------------------------------------------
class NPC {
  constructor(manager, spawn, index) {
    this.manager = manager;
    this.game = manager.game;
    this.kind = spawn.kind;                     // 'contact' | 'civ'
    this.pos = spawn.pos.clone();
    this.yaw = Math.random() * Math.PI * 2;
    this.state = 'wander';                      // wander | follow | flee
    this.waypoints = spawn.waypoints.length ? spawn.waypoints : [spawn.pos.clone()];
    this.wpIdx = 0;
    this.pauseT = Math.random() * 2;
    this.walkPhase = Math.random() * 6;
    this.fleeT = 0;
    this.fleeDir = new THREE.Vector3();
    this.contacted = false;

    const mats = manager.npcMats[index % manager.npcMats.length];
    this.model = buildSoldierModel(mats, {
      classId: 'civilian', civilian: true, kit: 'civilian', headwear: 'none',
      faceCover: false, gear: false, strobe: false, weaponStyle: 'none',
      headScale: 0.96 + (index % 3) * 0.04,
      width: 0.96 + (index % 2) * 0.06, height: 0.97 + (index % 3) * 0.025,
    });
    this.model.rifle.visible = false;
    this.model.strobe.visible = false;
    this.model.root.position.copy(this.pos);
    manager.group.add(this.model.root);

    this.box = { min: new THREE.Vector3(), max: new THREE.Vector3() };
    this._moveOut = { onGround: false, hitX: false, hitZ: false, hitCeil: false, steppedUp: false, groundCollider: null };
    this._wish = new THREE.Vector3();
    this.mass = 70;
    this.bodyState = 'standing';
    this.downBlend = 0;
    manager.game.physics.repairSpawnPoint(this.pos, 0.3, 1.78);
    this._syncBox();
  }

  _syncBox() {
    this.box.min.set(this.pos.x - 0.3, this.pos.y, this.pos.z - 0.3);
    this.box.max.set(this.pos.x + 0.3, this.pos.y + 1.78, this.pos.z + 0.3);
    // Civilians and escorted contacts block movement like any other body, and
    // they are included in the soldier steering probes so a crowd parts around
    // them instead of trampling through.
    const g = this.game;
    if (g && g.physics && g.physics.actors) syncActorBody(g.physics, this, this.box, { tag: 'actor', material: 'fabric', mass: 70 });
  }

  contact() {
    if (this.contacted) return;
    this.contacted = true;
    this.state = 'follow';
    this.pauseT = 0;
    this.game.ui.radio('SURVIVOR: "You came — take me south, to the road bend. Quickly."');
    this.game.audio.pickup(this.pos);
  }

  hear(pos, radius, kind) {
    if (this.state === 'follow') return;                 // escorted NPC stays with player
    if (kind !== 'shot' && kind !== 'gunshot' && kind !== 'player_shot' && kind !== 'enemy_shot' && kind !== 'glass' && kind !== 'explosion' && kind !== 'impact') return;
    if (this.pos.distanceToSquared(pos) > (radius + 6) * (radius + 6)) return;
    this.fleeDir.copy(this.pos).sub(pos);
    this.fleeDir.y = 0;
    if (this.fleeDir.lengthSq() < 0.01) this.fleeDir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    this.fleeDir.normalize();
    this.fleeDir.x += (Math.random() - 0.5) * 0.6;
    this.fleeDir.z += (Math.random() - 0.5) * 0.6;
    this.fleeDir.normalize();
    this.fleeT = 4 + Math.random() * 3;
    this.state = 'flee';
  }

  update(dt) {
    const speed = this.state === 'flee' ? 4.4 : this.state === 'follow' ? 2.6 : 1.4;
    this._wish.set(0, 0, 0);

    if (this.state === 'wander') {
      if (this.pauseT > 0) this.pauseT -= dt;
      else {
        const wp = this.waypoints[this.wpIdx];
        const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.7) {
          this.wpIdx = (this.wpIdx + 1) % this.waypoints.length;
          this.pauseT = 1.6 + Math.random() * 3;
        } else {
          this._wish.set(dx / d, 0, dz / d);
        }
      }
    } else if (this.state === 'follow') {
      const p = this.game.player.pos;
      const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 2.1) {
        const s = Math.min(1, (d - 2.1) / 6);            // ease up to a jog when far behind
        this._wish.set(dx / d * (0.6 + 0.4 * s), 0, dz / d * (0.6 + 0.4 * s));
      }
    } else if (this.state === 'flee') {
      this._wish.copy(this.fleeDir);
      this.fleeT -= dt;
      if (this.fleeT <= 0) this.state = 'wander';
    }

    const sp = this._wish.length();
    if (sp > 0.01) {
      this._wish.normalize();
      this.yaw = Math.atan2(-this._wish.x, -this._wish.z);
    }
    const step = speed * dt;
    this._intentSpeed = speed;
    this._syncBox();
    this._moveOpts = this._moveOpts || { ignoreBody: null, actors: true };
    this._moveOpts.ignoreBody = this._body;
    this.game.physics.moveBox(this.box, this._wish.x * step, -2.4 * dt, this._wish.z * step, this._moveOut, 0.4, this._moveOpts);
    this.pos.set(
      (this.box.min.x + this.box.max.x) / 2,
      this.box.min.y,
      (this.box.min.z + this.box.max.z) / 2
    );

    // presentation
    const m = this.model;
    m.root.position.copy(this.pos);
    let dyaw = this.yaw - m.root.rotation.y;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    m.root.rotation.y += dyaw * Math.min(1, 8 * dt);
    this.walkPhase += dt * (2 + sp * speed * 2.4);
    const swing = Math.sin(this.walkPhase * 2) * Math.min(0.6, 0.08 + sp * speed * 0.13);
    m.legL.rotation.x = swing;
    m.legR.rotation.x = -swing;
    m.armL.shoulder.rotation.x = Math.sin(this.walkPhase * 2) * 0.3 * sp;
    m.armR.shoulder.rotation.x = -Math.sin(this.walkPhase * 2) * 0.3 * sp;
    m.body.position.y = Math.abs(Math.cos(this.walkPhase * 2)) * 0.03 * sp;
  }
}

export class EnemyManager {
  constructor(game) {
    this._recoverT = 0;
    this.game = game;
    this.list = [];
    this.group = new THREE.Group();
    game.scene.add(this.group);

    const sharedMats = {
      dark: new THREE.MeshStandardMaterial({ color: 0x1c1e20, roughness: 0.91 }),
      boots: new THREE.MeshStandardMaterial({ color: 0x252321, roughness: 0.94 }),
      gun: new THREE.MeshStandardMaterial({ color: 0x1d2023, roughness: 0.48, metalness: 0.48 }),
      strobe: new THREE.MeshStandardMaterial({ color: 0x331111, emissive: 0xd02020, emissiveIntensity: 1.1 }),
      armor: new THREE.MeshStandardMaterial({ color: 0x34372f, roughness: 0.76, metalness: 0.08 }),
      pouch: new THREE.MeshStandardMaterial({ color: 0x242720, roughness: 0.93 }),
      pack: new THREE.MeshStandardMaterial({ color: 0x30352e, roughness: 0.96 }),
      webbing: new THREE.MeshStandardMaterial({ color: 0x22251f, roughness: 0.95 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x686d68, roughness: 0.4, metalness: 0.68 }),
      optic: new THREE.MeshStandardMaterial({ color: 0x365c54, roughness: 0.22, metalness: 0.22, emissive: 0x07120f, emissiveIntensity: 0.25 }),
      glove: new THREE.MeshStandardMaterial({ color: 0x282923, roughness: 0.97 }),
      weaponAccent: new THREE.MeshStandardMaterial({ color: 0x454a43, roughness: 0.72, metalness: 0.16 }),
    };
    const makePalette = (cloth, vest, helmet, skin, pack) => ({
      ...sharedMats,
      cloth: new THREE.MeshStandardMaterial({ color: cloth, roughness: 0.94 }),
      vest: new THREE.MeshStandardMaterial({ color: vest, roughness: 0.84, metalness: 0.06 }),
      helmet: new THREE.MeshStandardMaterial({ color: helmet, roughness: 0.78, metalness: 0.08 }),
      skin: new THREE.MeshStandardMaterial({ color: skin, roughness: 0.92 }),
      pack: new THREE.MeshStandardMaterial({ color: pack, roughness: 0.96 }),
    });
    this.paletteMats = [
      makePalette(0x44483a, 0x2d3128, 0x33372c, 0x927359, 0x33382e),
      makePalette(0x565044, 0x39362e, 0x474237, 0x9b7a5e, 0x403b32),
      makePalette(0x3a4142, 0x282e30, 0x30383a, 0x886c59, 0x2d3436),
      makePalette(0x34383a, 0x232729, 0x2a2e31, 0xa17d61, 0x2c3032),
      makePalette(0x4a4537, 0x302e26, 0x3f3a2f, 0x795d4b, 0x38362d),
    ];
    this.mats = this.paletteMats[0];
    this.npcMats = [
      {
        ...sharedMats,
        cloth: new THREE.MeshStandardMaterial({ color: 0x4d5a68, roughness: 0.95 }),
        vest: new THREE.MeshStandardMaterial({ color: 0x3d4650, roughness: 0.9 }),
        helmet: new THREE.MeshStandardMaterial({ color: 0x363c43, roughness: 0.9 }),
        skin: new THREE.MeshStandardMaterial({ color: 0x9a7a5e, roughness: 0.9 }),
      },
      {
        ...sharedMats,
        cloth: new THREE.MeshStandardMaterial({ color: 0x6b5d4a, roughness: 0.95 }),
        vest: new THREE.MeshStandardMaterial({ color: 0x53412e, roughness: 0.9 }),
        helmet: new THREE.MeshStandardMaterial({ color: 0x4a3b2a, roughness: 0.9 }),
        skin: new THREE.MeshStandardMaterial({ color: 0x8d6c53, roughness: 0.9 }),
      },
    ];

    this.npcs = [];
    this.escortComplete = false;
    this.escortNpc = null;
    this.squadAlert = 0;             // 0..1 shared alert level
    this.squadLastKnown = new THREE.Vector3();
    this.squadLastKnownT = -99;
    this.surgeQueue = 0;
    this.surgeTimer = 0;
    this._surgeBatches = [];
    this._surgeEvents = new Set();
    this._surgeSpawnCursor = 0;
    this._surgeBatchSeq = 0;
    this._vehicleCrewEvents = new Set();
    this._initialSpawnedKey = null;
    this._npcsSpawnedFor = null;
    this._spawnRng = mulberry(0x0b1ac7);
    this.spawnLog = [];
    this.spawnFailures = [];
    this.kills = 0;
    this._flashCount = 0;
    this._noiseScratch = { pos: new THREE.Vector3(), radius: 0, kind: '', intensity: 0, time: 0, source: null, id: 0 };
    this._noiseCounter = 0;
    this._comms = [];
    this._spawnScratch = new THREE.Vector3();
    this._spawnHits = [];
    this._navHits = [];
    this._navMin = new THREE.Vector3();
    this._navMax = new THREE.Vector3();
    this._navFrom = new THREE.Vector3();
    this._navTo = new THREE.Vector3();
    this.currentMissionId = null;
    this.currentRolePlan = ARCHETYPE_ROSTER;
    this.spawnedThisRun = 0;
    this.missionSpawnLimit = 30;
    this._surgeRoleCursor = 0;
    this._breacherAssigned = false;
  }

  reset(options = {}) {
    const preserveMissionRun = options.preserveMissionRun === true;
    for (const e of this.list) {
      this.group.remove(e.model.root);
      disposeActorModel(e);
    }
    this.list.length = 0;
    for (const n of this.npcs) {
      this.group.remove(n.model.root);
      unregisterActorBody(this.game.physics, n);
      disposeSoldierModel(n.model);
    }
    this.npcs.length = 0;
    this.escortComplete = false;
    this.escortNpc = null;
    const wi = this.game.world.interactables;
    const ni = wi.findIndex(i => i.id === 'npc_contact');
    if (ni >= 0) wi.splice(ni, 1);
    this.squadAlert = 0;
    this._recoverT = 0;
    this.squadLastKnown.set(0, 0, 0);
    this.squadLastKnownT = -99;
    this._comms.length = 0;
    this._noiseCounter = 0;
    this.surgeQueue = 0;
    this.surgeTimer = 0;
    this._surgeBatches.length = 0;
    this._surgeEvents.clear();
    this._surgeSpawnCursor = 0;
    this._surgeBatchSeq = 0;
    this._vehicleCrewEvents.clear();
    this._initialSpawnedKey = null;
    this._npcsSpawnedFor = null;
    // Every attempt starts with a clean staged-spawn ledger. Keeping these
    // queues across a retry can duplicate reserve entries or consume the next
    // attempt's budget with events from the failed run.
    this._reserve = [];
    this._reserveEchelons = 0;
    this._reserveT = 0;
    this._reserveReason = [];
    this._echelonRequested = 0;
    this._totalPlannedHostiles = 0;
    this._lastEchelonRadioAt = -99;
    this._flashCount = 0;
    this._spawnRng = mulberry(0x0b1ac7);
    if (!preserveMissionRun) {
      this.spawnLog.length = 0;
      this.spawnFailures.length = 0;
      this.spawnedThisRun = 0;
      this.missionSpawnLimit = 30;
      this.currentMissionId = null;
    }
    this.kills = 0;
    this._flashCount = 0;
    this.currentRolePlan = ARCHETYPE_ROSTER;
    this._surgeRoleCursor = 0;
    this._breacherAssigned = false;
  }

  /** Start a fresh attempt budget from the campaign-index target. */
  beginMissionRun(missionId, spawnLimit = 30) {
    this.currentMissionId = missionId || null;
    this.missionSpawnLimit = Math.max(0, Math.floor(Number(spawnLimit) || 0));
    this.spawnedThisRun = 0;
    this.spawnLog.length = 0;
    this.spawnFailures.length = 0;
    this._initialSpawnedKey = null;
    this._reserve = [];
    this._reserveEchelons = 0;
    this._reserveT = 0;
    this._reserveReason = [];
    this._echelonRequested = 0;
    this._totalPlannedHostiles = 0;
    this._lastEchelonRadioAt = -99;
    this._flashCount = 0;
    this._surgeSpawnCursor = 0;
    this._surgeBatchSeq = 0;
    this._npcsSpawnedFor = null;
    this._spawnRng = mulberry(0x0b1ac7);
    this.surgeQueue = 0;
    this.surgeTimer = 0;
    this._surgeBatches.length = 0;
    this._surgeEvents.clear();
    this._vehicleCrewEvents.clear();
  }

  get remainingMissionSpawns() {
    return Math.max(0, this.missionSpawnLimit - this.spawnedThisRun);
  }

  /** All hostile-actor creation paths pass through this per-run cap gate. */
  _spawnWithRunCap(create, source, eventId, spawnId, distanceAnchor = null, configure = null) {
    if (this.spawnedThisRun >= this.missionSpawnLimit) {
      this._recordSpawnFailure(source, eventId, spawnId, 'per-run enemy spawn cap reached');
      return null;
    }
    const enemy = create();
    if (!enemy) return null;
    if (configure) configure(enemy);
    this.list.push(enemy);
    this.spawnedThisRun++;
    this._recordSpawn(enemy, source, eventId, spawnId, distanceAnchor);
    return enemy;
  }

  _spawnPositionClear(pos, height = 1.8) {
    const physics = this.game.physics;
    if (!physics || !physics.queryAABB) return true;
    const min = _pv1.set(pos.x - 0.34, pos.y + 0.08, pos.z - 0.34);
    const max = _pv2.set(pos.x + 0.34, pos.y + height, pos.z + 0.34);
    // actors: true — a parked vehicle hull or a crowd of bodies is an
    // obstruction to a spawn just as much as a wall is
    const hits = physics.queryAABB(min, max, this._spawnHits, { actors: true });
    return !hits.some(c => c.enabled && c.max.y > pos.y + 0.35);
  }

  _spawnPositionValid(pos, options = {}) {
    if (!this._spawnPositionClear(pos, options.height || 1.8)) return false;
    const world = this.game.world;
    const bounds = world && world.bounds;
    if (bounds && (pos.x < bounds.minX + 0.55 || pos.x > bounds.maxX - 0.55 ||
        pos.z < bounds.minZ + 0.55 || pos.z > bounds.maxZ - 0.55)) return false;

    const anchor = options.playerAnchor || (this.game.player && this.game.player.pos);
    const minPlayerDistance = Math.max(0, options.minPlayerDistance || 0);
    if (anchor && minPlayerDistance > 0 && Math.hypot(pos.x - anchor.x, pos.z - anchor.z) < minPlayerDistance) return false;

    const actorGap = Math.max(0, options.minActorDistance || 0);
    if (actorGap > 0) {
      const gap2 = actorGap * actorGap;
      for (const other of this.list) {
        if (!other.alive || other.surrendered || other.fled) continue;
        const dx = other.pos.x - pos.x, dz = other.pos.z - pos.z;
        if (dx * dx + dz * dz < gap2) return false;
      }
    }

    const vehicleGap = Math.max(0, options.minVehicleDistance || 0);
    if (vehicleGap > 0) {
      const gap2 = vehicleGap * vehicleGap;
      for (const vehicle of this.game.vehicles?.list || []) {
        if (vehicle === options.ignoreVehicle || vehicle.hp <= 0 || !vehicle.box) continue;
        const dx = Math.max(vehicle.box.min.x - pos.x, 0, pos.x - vehicle.box.max.x);
        const dz = Math.max(vehicle.box.min.z - pos.z, 0, pos.z - vehicle.box.max.z);
        if (dx * dx + dz * dz < gap2) return false;
      }
      if (options.avoidStaticVehicles) {
        for (const vehicle of world?.vehicleSpawns || []) {
          if (options.ignoreVehicle && (vehicle.tag === options.ignoreVehicle.tag || vehicle.tag === options.ignoreVehicle.idTag)) continue;
          const dx = vehicle.pos.x - pos.x, dz = vehicle.pos.z - pos.z;
          const staticGap = options.staticVehicleDistance || vehicleGap;
          if (dx * dx + dz * dz < staticGap * staticGap) return false;
        }
      }
    }
    return true;
  }

  _findSpawnPosition(requested, options = {}) {
    this._spawnScratch.copy(requested);
    if (this._spawnPositionValid(this._spawnScratch, options)) return this._spawnScratch;
    const maxRings = options.maxRings || 4;
    for (let ring = 1; ring <= maxRings; ring++) {
      const radius = ring * 1.25;
      const samples = ring <= 3 ? 8 : 12;
      for (let i = 0; i < samples; i++) {
        const angle = (i / samples) * Math.PI * 2;
        this._spawnScratch.set(requested.x + Math.cos(angle) * radius, requested.y, requested.z + Math.sin(angle) * radius);
        if (this._spawnPositionValid(this._spawnScratch, options)) return this._spawnScratch;
      }
    }
    return null;
  }

  _recordSpawn(enemy, source, eventId, spawnId, distanceAnchor = null) {
    const p = distanceAnchor || (this.game.player && this.game.player.pos);
    const pos = enemy.pos;
    this.spawnLog.push({
      missionId: this.currentMissionId,
      map: this.game.world?.map || null,
      source,
      eventId: eventId || null,
      spawnId: spawnId || null,
      x: Number(pos.x.toFixed(2)), y: Number(pos.y.toFixed(2)), z: Number(pos.z.toFixed(2)),
      playerDistance: p ? Number(Math.hypot(pos.x - p.x, pos.z - p.z).toFixed(2)) : null,
      time: Number((this.game.time || 0).toFixed(2)),
    });
    if (this.spawnLog.length > 256) this.spawnLog.shift();
  }

  _recordSpawnFailure(source, eventId, spawnId, reason) {
    this.spawnFailures.push({
      missionId: this.currentMissionId,
      map: this.game.world?.map || null,
      source,
      eventId: eventId || null,
      spawnId: spawnId || null,
      time: Number((this.game.time || 0).toFixed(2)),
      reason,
    });
    if (this.spawnFailures.length > 128) this.spawnFailures.shift();
  }

  /** Bounded A* on a coarse, clearance-inflated physics grid. It runs only for
   * explicit reinforcement routes (or a genuine stuck replan), never per frame.
   * Every edge is collision-sampled; movement still uses Enemy._move and the
   * shared PhysicsWorld.moveBox solver. */
  _planGroundPath(start, target) {
    const physics = this.game.physics;
    const bounds = this.game.world?.bounds;
    if (!physics?.queryAABB || !bounds || !start || !target) return null;
    const cell = 3.0;
    const minIx = Math.ceil((bounds.minX + 0.7) / cell);
    const maxIx = Math.floor((bounds.maxX - 0.7) / cell);
    const minIz = Math.ceil((bounds.minZ + 0.7) / cell);
    const maxIz = Math.floor((bounds.maxZ - 0.7) / cell);
    const width = maxIx - minIx + 1, height = maxIz - minIz + 1;
    if (width <= 0 || height <= 0 || width * height > 90000) return null;
    const total = width * height;
    const occupancy = new Uint8Array(total); // 0 unknown, 1 blocked, 2 clear
    const cost = new Float32Array(total);
    cost.fill(Infinity);
    const parent = new Int32Array(total);
    parent.fill(-1);
    const key = (ix, iz) => (iz - minIz) * width + ix - minIx;
    const inBounds = (ix, iz) => ix >= minIx && ix <= maxIx && iz >= minIz && iz <= maxIz;
    const walkable = (ix, iz) => {
      if (!inBounds(ix, iz)) return false;
      const k = key(ix, iz);
      if (occupancy[k]) return occupancy[k] === 2;
      const x = ix * cell, z = iz * cell;
      const min = this._navMin.set(x - 0.9, Math.max(0, start.y) + 0.08, z - 0.9);
      const max = this._navMax.set(x + 0.9, Math.max(0, start.y) + 1.82, z + 0.9);
      const hits = physics.queryAABB(min, max, this._navHits);
      const clear = !hits.some(c => c.enabled && c.max.y > Math.max(0, start.y) + 0.35);
      occupancy[k] = clear ? 2 : 1;
      return clear;
    };
    const segmentClear = (ix0, iz0, ix1, iz1) => {
      const y = Math.max(0, start.y) + 0.95;
      const from = this._navFrom.set(ix0 * cell, y, iz0 * cell);
      const to = this._navTo.set(ix1 * cell, y, iz1 * cell);
      // The physics sweep expands each collider by the mover clearance, so a
      // single continuous test catches thin walls between coarse grid nodes.
      return !physics.sweepSphere(from, to, 0.9);
    };
    const nearestClear = (point, maxRadius) => {
      const cx = Math.round(point.x / cell), cz = Math.round(point.z / cell);
      for (let r = 0; r <= maxRadius; r++) {
        let best = null, bestD2 = Infinity;
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const ix = cx + dx, iz = cz + dz;
          if (!walkable(ix, iz)) continue;
          const wx = ix * cell - point.x, wz = iz * cell - point.z;
          const d2 = wx * wx + wz * wz;
          if (d2 < bestD2) { best = [ix, iz]; bestD2 = d2; }
        }
        if (best) return best;
      }
      return null;
    };
    const startCell = nearestClear(start, 2);
    if (!startCell) return null;
    const startId = key(startCell[0], startCell[1]);
    const heapIds = new Int32Array(total);
    const heapPos = new Int32Array(total);
    const heapF = new Float32Array(total);
    const closed = new Uint8Array(total);
    const heuristic = (ix, iz, radius) => Math.max(0,
      Math.hypot(ix * cell - target.x, iz * cell - target.z) - radius) / cell;
    const less = (a, b) => heapF[a] < heapF[b] || (heapF[a] === heapF[b] && cost[a] < cost[b]);
    let heapSize = 0;
    const pushOrDecrease = (id, f) => {
      heapF[id] = f;
      let i = heapPos[id];
      if (i < 0) {
        i = heapSize++;
        heapIds[i] = id;
        heapPos[id] = i;
      }
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(heapIds[i], heapIds[p])) break;
        const a = heapIds[i], b = heapIds[p];
        heapIds[i] = b; heapIds[p] = a;
        heapPos[a] = p; heapPos[b] = i;
        i = p;
      }
    };
    const pop = () => {
      const root = heapIds[0];
      heapPos[root] = -1;
      heapSize--;
      if (heapSize > 0) {
        const last = heapIds[heapSize];
        heapIds[0] = last;
        heapPos[last] = 0;
        let i = 0;
        while (true) {
          const l = i * 2 + 1, r = l + 1;
          if (l >= heapSize) break;
          const c = r < heapSize && less(heapIds[r], heapIds[l]) ? r : l;
          if (!less(heapIds[c], heapIds[i])) break;
          const a = heapIds[i], b = heapIds[c];
          heapIds[i] = b; heapIds[c] = a;
          heapPos[a] = c; heapPos[b] = i;
          i = c;
        }
      }
      return root;
    };
    const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
      [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
    let foundId = -1, found = false;
    let closestId = startId, closestDist = heuristic(startCell[0], startCell[1], 0);
    const maxExpanded = Math.min(total, 380);
    heapSize = 0;
    heapPos.fill(-1);
    closed.fill(0);
    cost.fill(Infinity);
    parent.fill(-1);
    cost[startId] = 0;
    pushOrDecrease(startId, heuristic(startCell[0], startCell[1], 14));
    let expanded = 0;
    while (heapSize > 0 && expanded < maxExpanded) {
      const id = pop();
      if (closed[id]) continue;
      const ix = id % width + minIx;
      const iz = Math.floor(id / width) + minIz;
      const dToTarget = Math.hypot(ix * cell - target.x, iz * cell - target.z);
      if (dToTarget < closestDist) {
        closestDist = dToTarget;
        closestId = id;
      }
      if (dToTarget <= 14) {
        foundId = id; found = true; break;
      }
      closed[id] = 1;
      expanded++;
      for (const [dx, dz, stepCost] of dirs) {
        const nx = ix + dx, nz = iz + dz;
        if (!walkable(nx, nz)) continue;
        if (dx && dz && (!walkable(ix + dx, iz) || !walkable(ix, iz + dz))) continue;
        if (!segmentClear(ix, iz, nx, nz)) continue;
        const ni = key(nx, nz);
        if (closed[ni]) continue;
        const nextCost = cost[id] + stepCost;
        if (nextCost >= cost[ni]) continue;
        cost[ni] = nextCost;
        parent[ni] = id;
        pushOrDecrease(ni, nextCost + heuristic(nx, nz, 14));
      }
    }
    if (!found && closestDist <= 24 && closestId !== startId) {
      foundId = closestId;
      found = true;
    }
    if (!found) return null;

    const cells = [];
    for (let id = foundId; id !== startId && id >= 0; id = parent[id]) {
      const iz = Math.floor(id / width) + minIz;
      const ix = id % width + minIx;
      cells.push([ix * cell, iz * cell]);
    }
    cells.reverse();
    if (!cells.length) return { waypoints: [], distance: 0 };

    // Collapse only collinear cells. This preserves the searched corridor and
    // cannot cut a corner through a wall as line-of-sight simplifiers can.
    const turns = [];
    let previous = [start.x, start.z], direction = null;
    for (let i = 0; i < cells.length; i++) {
      const point = cells[i];
      const next = cells[i + 1] || null;
      const dirX = Math.sign(point[0] - previous[0]);
      const dirZ = Math.sign(point[1] - previous[1]);
      const nextDir = next ? [Math.sign(next[0] - point[0]), Math.sign(next[1] - point[1])] : null;
      if (!direction) direction = [dirX, dirZ];
      if (!nextDir || nextDir[0] !== dirX || nextDir[1] !== dirZ) {
        turns.push(new THREE.Vector3(point[0], Math.max(0, start.y), point[1]));
        direction = nextDir;
      }
      previous = point;
    }
    return { waypoints: turns, distance: cost[foundId] * cell };
  }

  spawnInitial(missionId = this.game._lastMission, missionDef = null) {
    const world = this.game.world;
    const spawns = world.enemySpawns || [];
    const spawnKey = `${missionId || 'unknown'}:${world.map || 'unknown'}`;
    if (this._initialSpawnedKey === spawnKey) return 0;
    this._initialSpawnedKey = spawnKey;
    const rolePlan = MISSION_ROLE_PLANS[missionDef && missionDef.type] || ARCHETYPE_ROSTER;
    this.currentMissionId = missionId;
    this.currentRolePlan = rolePlan;
    this._surgeRoleCursor = 0;
    this._breacherAssigned = false;
    // Phase 17 (P3): garrisons per map now exceed what one coherent engagement
    // should open with (urban 46, rural 71). Stage them into an ADVANCE PARTY
    // (live immediately) and GARRISON RESERVES (enter in echelons as steps
    // complete, alarms fire or reserves spots free up), instead of presenting
    // every hostile at t=0. Waves/space/sightlines stay authored; ordering is
    // stable, seeded by route participation so patrols arrive first.
    const entries = spawns.map((s, i) => ({ s, i }));
    // Ensure every campaign mission contains at least its progression-formula minimum
    // (50 + (missionNumber - 1) * 2) distinct, collision-validated, killable enemies.
    const minFormulaHostiles = Math.max(50, this.missionSpawnLimit || 50);
    if (this.missionSpawnLimit < minFormulaHostiles && world.map !== 'range') {
      this.missionSpawnLimit = minFormulaHostiles;
    }
    // The authored roster is the exact mission target. Older code added a
    // +24 spawn reserve to missionSpawnLimit below; that made the actual spawn
    // cap disagree with the campaign target (and made any leaked run counter
    // especially visible on retries). Keep the streamed reserve architecture,
    // but never increase the total roster beyond this attempt's fixed target.
    if (world.map !== 'range' && entries.length > minFormulaHostiles) {
      entries.length = minFormulaHostiles;
    } else if (entries.length < minFormulaHostiles && world.map !== 'range') {
      const needed = minFormulaHostiles - entries.length;
      const basePoints = [];
      for (const s of spawns) if (s && s.pos) basePoints.push(s);
      for (const g of world.surgeSpawns || []) if (g && g.pos) basePoints.push({ pos: g.pos, route: g.route || null });
      if (!basePoints.length) basePoints.push({ pos: new THREE.Vector3(0, 0, -28), route: null });
      for (let k = 0; k < needed; k++) {
        const src = basePoints[k % basePoints.length];
        const angle = (k * 137.508) * (Math.PI / 180);
        const radius = 2.8 + (k % 5) * 2.2;
        const reqPos = new THREE.Vector3(
          src.pos.x + Math.cos(angle) * radius,
          Math.max(0, src.pos.y || 0),
          src.pos.z + Math.sin(angle) * radius
        );
        const clear = this._findSpawnPosition(reqPos, {
          playerAnchor: world.spawnPoint,
          minPlayerDistance: MIN_INITIAL_SPAWN_DISTANCE * 0.85,
          maxRings: 14,
        });
        const finalPos = clear ? clear.clone() : src.pos.clone();
        const role = rolePlan[(entries.length + k) % rolePlan.length];
        entries.push({
          s: {
            pos: finalPos,
            route: src.route != null ? src.route : null,
            kind: role,
            id: `${world.map || 'map'}:garrison-reserve:${entries.length + 1}`,
          },
          i: entries.length,
        });
      }
    }
    entries.sort((a, b) =>
      ((b.s.route === null || b.s.route === undefined ? 0 : 1) - (a.s.route === null || a.s.route === undefined ? 0 : 1)) ||
      (a.i - b.i));
    const ADVANCE = { facility: 8, range: 7, snow: 8, desert: 8, urban: 9, metro: 9, industrial: 9, rural: 9 };
    const advanceCount = ADVANCE[world.map] || 10;
    const advance = entries.slice(0, advanceCount);
    this._advanceCount = advanceCount;
    this._reserve = entries.slice(advanceCount).map(e => e.s);
    if (world.map !== 'range') {
      // The campaign formula is the hard per-attempt ceiling, not a minimum.
      this.missionSpawnLimit = minFormulaHostiles;
    }
    this._totalPlannedHostiles = world.map === 'range' ? entries.length : minFormulaHostiles;
    this._reserveEchelons = 0;
    this._lastEchelonRadioAt = -99;
    this._reserveT = 10;                      // opening tactical window before first reserve wave
    this._reserveBatch = 5;                   // responsive multi-sector wave size (capped by MAX_ACTIVE_HOSTILES = 12)
    this._reserveReason = [];
    let spawned = 0;
    for (let i = 0; i < advance.length; i++) {
      const s = advance[i].s;
      const spawnId = s.id || `${world.map || 'map'}:garrison:${i + 1}`;
      const eventId = `${missionId || 'mission'}:initial:${spawnId}`;
      const pos = this._findSpawnPosition(s.pos, {
        playerAnchor: world.spawnPoint,
        minPlayerDistance: MIN_INITIAL_SPAWN_DISTANCE,
        minActorDistance: 2.6,
        minVehicleDistance: 3.2,
        staticVehicleDistance: 4.0,
        avoidStaticVehicles: true,
        maxRings: 10,
      });
      if (!pos) {
        // Never discard an enemy from the mission minimum: defer into staged reserve!
        this._reserve.unshift(s);
        continue;
      }
      if (this._spawnAuthoredAt(s, pos, 'authored-garrison', spawnId, eventId, i)) spawned++;
    }
    this._surgeRoleCursor = this.list.length % rolePlan.length;
    return spawned;
  }

  /**
   * Staged multi-sector garrison waves — maintains smooth 60 FPS active cap
   * (MAX_ACTIVE_HOSTILES = 12) while streaming all 50..248+ mission hostiles
   * across sectors without stalling or dropping any enemy from the roster.
   */
  _tickReserve(dt) {
    if (!this._reserve || !this._reserve.length) return;
    if (this.remainingMissionSpawns <= 0) { this._reserve.length = 0; return; }
    const g = this.game;
    if (!g.missions) { this._reserve.length = 0; return; }
    this._reserveT -= dt;
    const alive = this.activeHostiles;
    if (alive === 0) this._reserveT = Math.min(this._reserveT, 1.2);
    const echelonPressure = alive <= Math.max(7, MAX_ACTIVE_HOSTILES - 4);
    const timerExpired = this._reserveT <= 0;
    if (!(timerExpired && (echelonPressure || this._echelonRequested > 0 || alive <= 3))) return;
    if (alive >= MAX_ACTIVE_HOSTILES) { this._reserveT = 2.5; return; }

    const slotsFree = Math.max(0, MAX_ACTIVE_HOSTILES - alive);
    const want = Math.min(this._reserveBatch, slotsFree, this._reserve.length, this.remainingMissionSpawns);
    const world = g.world;
    const fallbackGates = [...(world.surgeSpawns || []), ...(world.enemySpawns || [])];
    let n = 0;
    const deferred = [];

    for (let k = 0; k < want; k++) {
      const s = this._reserve.shift();
      if (!s) break;
      let pos = this._findSpawnPosition(s.pos, {
        playerAnchor: g.player.pos,
        minPlayerDistance: MIN_INITIAL_SPAWN_DISTANCE * 0.55,
        minActorDistance: 2.5,
        minVehicleDistance: 3.0,
        staticVehicleDistance: 3.8,
        avoidStaticVehicles: true,
        maxRings: 8,
      });
      // If player is standing near s.pos, deploy from a distant clear sector gate so no enemy is ever lost!
      if (!pos && fallbackGates.length) {
        const startIdx = (this._reserveEchelons * 3 + k) % fallbackGates.length;
        for (let gi = 0; gi < fallbackGates.length; gi++) {
          const gate = fallbackGates[(startIdx + gi) % fallbackGates.length];
          if (!gate || !gate.pos) continue;
          pos = this._findSpawnPosition(gate.pos, {
            playerAnchor: g.player.pos,
            minPlayerDistance: MIN_INITIAL_SPAWN_DISTANCE * 0.65,
            minActorDistance: 2.4,
            maxRings: 8,
          });
          if (pos) break;
        }
      }
      if (!pos) {
        deferred.push(s);
        continue;
      }
      const spawnedOk = this._spawnAuthoredAt(s, pos, 'garrison-echelon');
      if (spawnedOk) {
        n++;
        const actor = this.list[this.list.length - 1];
        // If combat/alarm is underway, orient newly arrived wave toward the engagement zone
        if (actor && (this.squadAlert > 0.22 || (g.stats && g.stats.alarm))) {
          actor._rememberPoint(g.player.pos, 0.36, 15, 'wave-dispatch');
          actor.state = 'investigate';
          actor.stateT = 0;
        }
      } else {
        deferred.push(s);
      }
    }
    for (let d = deferred.length - 1; d >= 0; d--) this._reserve.unshift(deferred[d]);

    this._reserveEchelons = (this._reserveEchelons || 0) + 1;
    this._reserveT = this.activeHostiles <= 3 ? 2.2 : 5.5;
    this._echelonRequested = 0;
    const now = g.time || 0;
    if (n > 0 && g.ui && g.ui.radio && (now - (this._lastEchelonRadioAt || -99)) > 18) {
      this._lastEchelonRadioAt = now;
      g.ui.radio(`HOSTILE WAVE DEPLOYING — ${this.remainingHostiles} SIGNATURES IN SECTOR`);
    }
  }

  /** Called by the mission manager on every completed objective (P3 pacing). */
  notifyObjectiveComplete() {
    if (!this._reserve || !this._reserve.length) return;
    this._echelonRequested = (this._echelonRequested || 0) + 1;
    this._reserveT = Math.min(this._reserveT, 3.5);
  }

  /** Instantiate one authored garrison entry at a resolved clear position. */
  _spawnAuthoredAt(s, pos, reason, spawnId, eventId, seedIdx) {
    const world = this.game.world;
    const rolePlan = this.currentRolePlan || ARCHETYPE_ROSTER;
    const i = seedIdx != null ? seedIdx : this.list.length;
    const flash = i % 4 === 0 && this._flashCount < 5;
    if (flash) this._flashCount++;
    const legacyAlias = ARCHETYPE_ALIASES[s.kind];
    let role = ARCHETYPES[s.kind] ? s.kind : ARCHETYPES[legacyAlias] ? legacyAlias : rolePlan[i % rolePlan.length];
    if (role === 'assault' && !this._breacherAssigned &&
        (this.currentMissionId === 'cq_urban' || this.currentMissionId === 'defense_urban')) {
      role = 'breacher';
      this._breacherAssigned = true;
    }
    const spawn = { pos, route: s.route, kind: s.kind, classId: role, flash,
      id: spawnId || s.id, reason, eventId };
    const enemy = this._spawnWithRunCap(
      () => new Enemy(this.game, spawn, s.kind, i * 7919 + 13),
      reason, eventId, spawnId || s.id, world.spawnPoint,
    );
    return !!enemy;
  }

  /** Dismounted crew are permitted only by a hostile vehicle's LOS-confirmed stop. */
  spawnVehicleCrew(vehicle, kinds = ['rifleman', 'assault']) {
    if (!vehicle || !this.game.player || !this.game.player.alive) return 0;
    const vehicleId = vehicle.idTag || vehicle.tag || 'hostile-vehicle';
    const eventId = `vehicle-crew:${this.currentMissionId || 'mission'}:${vehicleId}`;
    if (this._vehicleCrewEvents.has(eventId)) return 0;
    this._vehicleCrewEvents.add(eventId);
    const remaining = Math.max(0, MAX_ACTIVE_HOSTILES - this.activeHostiles);
    const count = Math.min(kinds.length, remaining, this.remainingMissionSpawns, 4);
    if (!count) return 0;
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const localX = vehicle.isHelicopter ? side * 2.15 : side * (vehicle.def.wd * 0.5 + 1.05);
      const localZ = i > 1 ? vehicle.def.hl * 0.55 : -0.15;
      vehicle.localToWorld(localX, 0, localZ, this._spawnScratch);
      const spawnId = `${vehicleId}:crew:${i + 1}`;
      const pos = this._findSpawnPosition(this._spawnScratch, {
        minPlayerDistance: 3.4,
        minActorDistance: 2.8,
        minVehicleDistance: 0.15,
        ignoreVehicle: vehicle,
      });
      if (!pos) {
        this._recordSpawnFailure('vehicle-dismount', eventId, spawnId, 'no safe dismount position');
        continue;
      }
      const kind = kinds[i] || 'rifleman';
      const seed = Math.floor(this._spawnRng() * 0x7fffffff) ^ (this.list.length * 7919 + 17);
      const e = this._spawnWithRunCap(
        () => new Enemy(this.game, { pos, route: null, flash: false, id: spawnId,
          reason: 'vehicle-dismount', eventId }, kind, seed),
        'vehicle-dismount', eventId, spawnId,
        null,
        actor => {
          const dx = this.game.player.pos.x - actor.pos.x, dz = this.game.player.pos.z - actor.pos.z;
          actor.yaw = Math.atan2(-dx, -dz);
          actor.aimYaw = actor.yaw;
          actor.contactConfirmed = true;
          actor.detection = 1;
          actor.canSeePlayer = true;
          actor.hasLOS = true;
          actor.state = 'alert';
          actor.stateReason = 'LOS-confirmed hostile vehicle dismount';
          actor.stateT = 0;
          actor.alertT = 0.15;
          actor.lastSeenT = this.game.time;
          actor._rememberPoint(this.game.player.pos, 0.92, 0.7, 'vehicle-contact');
          actor.combatAction = 'engage';
        },
      );
      if (!e) break;
      spawned++;
    }
    if (spawned) this.squadAlert = Math.max(this.squadAlert, 0.72);
    return spawned;
  }

  /** civilians + escort contacts authored in world.npcSpawns */
  spawnNPCs() {
    const missionKey = `${this.currentMissionId || this.game.missions?.missionId || 'mission'}:${this.game.world?.map || 'map'}`;
    if (this._npcsSpawnedFor === missionKey) return 0;
    this._npcsSpawnedFor = missionKey;
    const spawns = this.game.world.npcSpawns || [];
    for (let i = 0; i < spawns.length; i++) {
      const npc = new NPC(this, spawns[i], i);
      this.npcs.push(npc);
      if (npc.kind === 'contact') {
        this.escortNpc = npc;
        this.game.world.interactables.push({
          id: 'npc_contact',
          pos: npc.pos.clone().setY(npc.pos.y + 1.2),
          radius: 2.4,
          prompt: 'SPEAK TO THE SURVIVOR',
          getPrompt: () => 'SPEAK TO THE SURVIVOR',
          hold: 0.6,
          used: false,
          reusable: false,
          npc,
          action: () => { npc.contact(); return true; },
        });
      }
    }
    return this.npcs.length;
  }

  get activeHostiles() {
    let n = 0;
    for (const e of this.list) if (e.alive && !e.surrendered && !e.fled) n++;
    return n;
  }

  /** lob a frag toward the player's predicted position */
  throwGrenade(by) {
    if (!by || !by.alive || !by.canSeePlayer || !by.hasLOS || !this.game.player.alive) return false;
    const g = this.game;
    const T = 1.15;
    const target = _pv1.copy(g.player.pos).addScaledVector(g.player.vel, 0.55);
    const from = _pv2.copy(by.pos).setY(by.pos.y + 1.5);
    const vel = _pv3.copy(target).sub(from).divideScalar(T);
    vel.y += 0.5 * 9.81 * T;
    g.spawnGrenade(from.clone(), vel.clone(), 'vxfrag', by);
    g.ui.radio('HOSTILE GRENADE INBOUND');
    return true;
  }

  /** Queue one explicitly triggered, bounded reinforcement wave. Event IDs make
   * replayed mission callbacks idempotent; no wave is generated autonomously. */
  queueSurge(count, delay = 0, eventId = null, report = null) {
    const requested = Math.max(0, Math.floor(Number(count) || 0));
    if (!requested) return 0;
    const missionId = this.currentMissionId || this.game.missions?.missionId || 'mission';
    const key = eventId ? `${missionId}:${eventId}` : null;
    if (key && this._surgeEvents.has(key)) return 0;

    const capacity = Math.max(0, Math.min(MAX_PENDING_SURGES - this.surgeQueue, this.remainingMissionSpawns - this.surgeQueue));
    const accepted = Math.min(requested, capacity);
    if (!accepted) return 0;
    if (key) this._surgeEvents.add(key);

    let reportPos = null;
    let confidence = 0.38;
    let uncertainty = 14;
    let reportSource = 'mission-order';
    if (report && report.position) {
      reportPos = report.position.clone();
      confidence = report.confidence == null ? confidence : report.confidence;
      uncertainty = report.uncertainty == null ? uncertainty : report.uncertainty;
      reportSource = report.source || reportSource;
    } else if (report && report.isVector3) {
      reportPos = report.clone();
      reportSource = 'alarm-bearing';
    } else if (this.squadLastKnownT > -50 && this.game.time - this.squadLastKnownT < 18) {
      reportPos = this.squadLastKnown.clone();
      confidence = 0.42;
      uncertainty = 11;
      reportSource = 'squad-report';
    } else {
      const objective = this.game.missions?.currentObjectivePos?.();
      if (objective) {
        reportPos = objective.clone();
        confidence = 0.42;
        uncertainty = 13;
      } else if (this.game.player?.pos) {
        reportPos = this.game.player.pos.clone();
        confidence = 0.28;
        uncertainty = 20;
        reportSource = 'alarm-bearing';
      }
    }

    const response = Math.max(0.65, this.game.progress?.difficulty?.reinforcements || 1);
    const wait = Math.max(0, Number(delay) || 0) / response;
    const batch = {
      id: key || `${missionId}:surge:${++this._surgeBatchSeq}`,
      remaining: accepted,
      reportPos,
      approachTarget: null,
      routeCache: new Map(),
      routeFailures: new Set(),
      confidence,
      uncertainty,
      reportSource,
    };
    this._surgeBatches.push(batch);
    this.surgeQueue += accepted;
    if (this._surgeBatches.length === 1) this.surgeTimer = Math.max(this.surgeTimer, wait);
    return accepted;
  }

  _trySpawnSurge(dt) {
    const batch = this._surgeBatches[0];
    if (!batch || this.surgeQueue <= 0) { this.surgeQueue = 0; this.surgeTimer = 0; return; }
    if (this.remainingMissionSpawns <= 0) { this.surgeQueue = 0; this.surgeTimer = 0; this._surgeBatches.length = 0; return; }
    this.surgeTimer = Math.max(0, this.surgeTimer - dt);
    if (this.surgeTimer > 0) return;
    const g = this.game;
    if (!g.player || !g.player.alive) { this.surgeTimer = 1; return; }
    if (this.activeHostiles >= MAX_ACTIVE_HOSTILES) { this.surgeTimer = 1.5; return; }

    const spawns = g.world.surgeSpawns || [];
    if (!spawns.length) {
      this._recordSpawnFailure('reinforcement', batch.id, null, 'mission has no authored reinforcement entry points');
      this.surgeQueue -= batch.remaining;
      this._surgeBatches.shift();
      this.surgeTimer = this._surgeBatches.length ? 1.5 : 0;
      return;
    }

    let selected = null;
    let bestRouteCost = Infinity;
    if (batch.reportPos && !batch.approachTarget) {
      const angle = this._spawnRng() * Math.PI * 2;
      const error = Math.min(18, batch.uncertainty) * (0.18 + this._spawnRng() * 0.38);
      batch.approachTarget = new THREE.Vector3(batch.reportPos.x + Math.cos(angle) * error, batch.reportPos.y,
        batch.reportPos.z + Math.sin(angle) * error);
    }
    const reportTarget = batch.approachTarget;
    for (let n = 0; n < spawns.length; n++) {
      const idx = (this._surgeSpawnCursor + n) % spawns.length;
      const s = spawns[idx];
      if (!s || !s.pos) continue;
      const pos = this._findSpawnPosition(s.pos, {
        minPlayerDistance: MIN_SURGE_SPAWN_DISTANCE,
        minActorDistance: 5.5,
        minVehicleDistance: 5.0,
        staticVehicleDistance: 5.5,
        avoidStaticVehicles: true,
      });
      if (!pos || Math.hypot(pos.x - g.player.pos.x, pos.z - g.player.pos.z) < MIN_SURGE_SPAWN_DISTANCE) continue;
      const eye = _pv1.set(pos.x, pos.y + 1.6, pos.z);
      const pEye = _pv2.set(g.player.pos.x, g.player.pos.y + 1.2, g.player.pos.z);
      if (g.physics && g.physics.hasLOS(eye, pEye)) continue;
      let path = null;
      if (reportTarget) {
        const routeKey = `${s.id || idx}:${pos.x.toFixed(1)}:${pos.z.toFixed(1)}:${reportTarget.x.toFixed(1)}:${reportTarget.z.toFixed(1)}`;
        if (batch.routeCache.has(routeKey)) {
          path = batch.routeCache.get(routeKey) || null;
        } else {
          path = this._planGroundPath(pos, reportTarget);
          if (batch.routeCache.size >= 64) batch.routeCache.delete(batch.routeCache.keys().next().value);
          batch.routeCache.set(routeKey, path || false);
        }
        if (!path) {
          if (!batch.routeFailures.has(routeKey)) {
            if (batch.routeFailures.size >= 64) batch.routeFailures.delete(batch.routeFailures.values().next().value);
            batch.routeFailures.add(routeKey);
            this._recordSpawnFailure('reinforcement-route', batch.id, s.id || idx,
              'no collision-clear ground route from this authored entry to the reported area');
          }
          continue;
        }
      }
      if (!reportTarget) {
        selected = { spawn: s, pos: pos.clone(), idx, path };
        break;
      }
      if (path.distance < bestRouteCost) {
        bestRouteCost = path.distance;
        selected = { spawn: s, pos: pos.clone(), idx, path };
        if (bestRouteCost < 60) break; // First good route found; avoid searching remaining spawns
      }
    }
    if (!selected) {
      batch.retries = (batch.retries || 0) + 1;
      if (batch.retries >= 3) {
        // Fallback pass across surge + garrison gates at farthest valid distance so a
        // blocked random approachTarget offset never soft-locks clear/eliminate stages.
        const allGates = [...spawns, ...(g.world.enemySpawns || [])];
        let bestD = -1;
        for (let gi = 0; gi < allGates.length; gi++) {
          const gs = allGates[gi];
          if (!gs || !gs.pos) continue;
          const gPos = this._findSpawnPosition(gs.pos, {
            minPlayerDistance: MIN_SURGE_SPAWN_DISTANCE * 0.65,
            minActorDistance: 2.8,
            minVehicleDistance: 3.5,
            staticVehicleDistance: 4.0,
            avoidStaticVehicles: true,
          });
          if (!gPos) continue;
          const d = Math.hypot(gPos.x - g.player.pos.x, gPos.z - g.player.pos.z);
          if (d > bestD) {
            bestD = d;
            selected = { spawn: gs, pos: gPos.clone(), idx: gi % Math.max(1, spawns.length), path: null };
          }
        }
      }
      if (!selected) {
        if (batch.retries >= 6) {
          this.surgeQueue = Math.max(0, this.surgeQueue - batch.remaining);
          this._surgeBatches.shift();
          this.surgeTimer = this._surgeBatches.length ? 1.0 : 0;
          return;
        }
        this.surgeTimer = 1.8;
        return;
      }
    }

    const plan = this.currentRolePlan.length ? this.currentRolePlan : ARCHETYPE_ROSTER;
    let classId = plan[this._surgeRoleCursor % plan.length];
    this._surgeRoleCursor = (this._surgeRoleCursor + 1) % plan.length;
    if (classId === 'assault' && !this._breacherAssigned &&
        (this.currentMissionId === 'cq_urban' || this.currentMissionId === 'defense_urban')) {
      classId = 'breacher';
      this._breacherAssigned = true;
    }
    const spawnId = selected.spawn.id || `${g.world.map || 'map'}:reinforcement:${selected.idx + 1}`;
    const actorEventId = `${batch.id}:actor-${batch.remaining}`;
    const e = this._spawnWithRunCap(
      () => new Enemy(g, { pos: selected.pos, route: selected.spawn.route || null, flash: false, classId,
        id: spawnId, reason: 'mission-reinforcement', eventId: actorEventId }, 'surge', Math.floor(this._spawnRng() * 1e6)),
      'mission-reinforcement', batch.id, spawnId,
      null,
      actor => {
        if (!batch.reportPos) return;
        actor._rememberPoint(reportTarget || batch.reportPos, batch.confidence, batch.uncertainty, 'mission-reinforcement report');
        if (selected.path && selected.path.waypoints) {
          actor.navPath = selected.path.waypoints;
          actor.navPathIndex = 0;
          actor.navPathEndMode = 'search';
          actor.navReplanRequested = false;
          actor.navReplanCount = 0;
          actor.navBestDistance = Infinity;
          actor.navNoProgressT = 0;
          actor.investigateMaxTime = Math.min(180, Math.max(22, 18 + selected.path.distance / 1.9));
        } else {
          actor.investigateMaxTime = 45;
        }
        actor.state = 'investigate';
        actor.stateReason = batch.reportSource;
        actor.stateT = 0;
        actor.pauseT = 0;
        actor.hasWanderPoint = false;
      },
    );
    if (!e) return;
    batch.remaining--;
    this.surgeQueue--;
    this._surgeSpawnCursor = (selected.idx + 1) % spawns.length;

    const response = Math.max(0.65, g.progress?.difficulty?.reinforcements || 1);
    const nextDelay = (2.5 + this._spawnRng() * 3) / response;
    if (batch.remaining <= 0) {
      this._surgeBatches.shift();
      this.surgeTimer = this._surgeBatches.length ? nextDelay : 0;
    } else this.surgeTimer = nextDelay;
  }

  _queueCommunication(source, point, confidence, uncertainty, range, delay, allowRelay = false) {
    if (!source || !point) return false;
    const angle = source.rng ? source.rng() * Math.PI * 2 : this._spawnRng() * Math.PI * 2;
    const coordination = source.coordination || this.game.progress?.difficulty?.coordination || 1;
    const fuzz = Math.max(1.2, uncertainty * 0.22 + (1 - confidence) * 2.5);
    const offset = fuzz * (0.45 + (source.rng ? source.rng() : this._spawnRng()) * 0.9);
    const report = new THREE.Vector3(
      point.x + Math.cos(angle) * offset,
      point.y,
      point.z + Math.sin(angle) * offset,
    );
    if (this._comms.length >= 32) this._comms.shift();
    this._comms.push({
      source,
      senderPos: source.pos.clone(),
      position: report,
      confidence: THREE.MathUtils.clamp(confidence, 0.08, 0.92),
      uncertainty: uncertainty + fuzz,
      range: range * THREE.MathUtils.clamp(coordination, 0.65, 1.5),
      deliverAt: this.game.time + Math.max(0.08, delay / Math.max(0.65, coordination)),
      allowRelay,
    });
    return true;
  }

  _deliverCommunications() {
    const now = this.game.time;
    for (let i = this._comms.length - 1; i >= 0; i--) {
      const msg = this._comms[i];
      if (now < msg.deliverAt) continue;
      let delivered = 0;
      let relay = null;
      for (const e of this.list) {
        if (e === msg.source || !e.alive || e.surrendered || e.fled || e.state === 'combat') continue;
        const d2 = e.pos.distanceToSquared(msg.senderPos);
        if (d2 > msg.range * msg.range) continue;
        const dist = Math.sqrt(d2);
        let attenuation = 1;
        if (dist > 18 && this.game.physics && !this.game.physics.hasLOS(
          _pv1.set(msg.senderPos.x, msg.senderPos.y + 1.2, msg.senderPos.z),
          _pv2.set(e.pos.x, e.pos.y + 1.2, e.pos.z))) {
          attenuation = 0.58;
          if (dist > 30) continue;
        }
        const contact = {
          position: msg.position,
          confidence: msg.confidence * attenuation * (1 - Math.min(0.35, dist / Math.max(1, msg.range) * 0.35)),
          uncertainty: msg.uncertainty + (attenuation < 1 ? 3.5 : dist * 0.035),
        };
        if (e.receiveContact(contact)) {
          delivered++;
          if (!relay) relay = e;
          if (delivered >= 4) break;
        }
      }
      if (msg.allowRelay && relay) {
        this._queueCommunication(relay, msg.position, msg.confidence * 0.55, msg.uncertainty + 4, 19, 0.62, false);
      }
      this._comms.splice(i, 1);
    }
  }

  shareLastKnown(pos, by) {
    if (!by || !pos || !by.canSeePlayer) return;
    const g = this.game;
    const angle = by.rng() * Math.PI * 2;
    const err = 1.8 + by.rng() * 1.8;
    this.squadLastKnown.set(pos.x + Math.cos(angle) * err, pos.y, pos.z + Math.sin(angle) * err);
    this.squadLastKnownT = g.time;
    this.squadAlert = Math.max(this.squadAlert, 0.78);
    if (g.time < by._nextRadioAt) return;
    by._nextRadioAt = g.time + (2.8 + by.rng() * 1.5) / Math.max(0.65, by.coordination || 1);
    const radioRange = by.archetype === 'leader' ? 52 : 32;
    this._queueCommunication(by, pos, 0.82, 2.4, radioRange, 0.28 + by.rng() * 0.38, true);
  }

  /** A visual report starts a local alert; allies receive it after radio delay. */
  onPlayerSpotted(by, quiet = false) {
    const g = this.game;
    if (!by || !by.lastKnownValid) return;
    this.shareLastKnown(by.lastKnown, by);
    if (quiet) return;
    g.audio.radioSquelch(by.pos.clone().setY(by.pos.y + 1.3));
    if (by.chatterCd <= 0) {
      by.chatterCd = 9;
      const lines = ['CONTACT — MOVING TO ENGAGE', 'MOVEMENT AT LAST POSITION', 'CHECK THE NORTH APPROACH', 'SUPPRESSING — WATCH YOUR ANGLE'];
      g.ui.radio(lines[Math.floor(by.rng() * lines.length)]);
    }
    g.onAlarmRaised();
  }

  /** A hit supplies an uncertain bearing/range and raises only a local report. */
  onAllyShot(victim, shooterGuess) {
    if (victim && shooterGuess) {
      this._queueCommunication(victim, shooterGuess, 0.38, 11, 24, 0.45 + this._spawnRng() * 0.45, false);
    }
    this.squadAlert = Math.max(this.squadAlert, 0.62);
  }

  onAllyDown(victim) {
    if (!victim) return;
    this.squadAlert = Math.max(this.squadAlert, 0.48);
    let relay = false;
    for (const e of this.list) {
      if (e === victim || !e.alive || e.surrendered || e.fled) continue;
      const d = e.pos.distanceTo(victim.pos);
      if (d > 28) continue;
      e.stress = Math.min(1, e.stress + 0.2);
      e.stressT = Math.max(e.stressT, 5);
      e.suppressT = Math.max(e.suppressT, 0.45 / Math.max(0.6, e.suppressionResistance));
      if (victim.lastKnownValid && this.game.time - victim.lastKnownAt < 9 && !relay) {
        this._queueCommunication(victim, victim.lastKnown, victim.lastKnownConfidence * 0.55,
          victim.lastKnownUncertainty + 5, 22, 0.55, false);
        relay = true;
      }
    }
  }

  combatTimeout(e) {
    // one enemy giving up slowly calms the squad
    this.squadAlert = Math.max(0, this.squadAlert - 0.15);
    void e;
  }

  /** Timestamped local noise dispatch from game.emitNoise. */
  hearNoise(pos, radius, kind, source = null, intensity = null) {
    const noise = this._noiseScratch;
    noise.pos.copy(pos);
    noise.radius = Math.max(0, radius);
    noise.kind = kind || 'impact';
    noise.intensity = THREE.MathUtils.clamp(intensity == null ? noise.radius / 60 : intensity, 0, 1);
    noise.time = this.game.time;
    noise.source = source;
    noise.id = ++this._noiseCounter;
    for (const e of this.list) {
      if (!e.alive || e.surrendered || e.fled) continue;
      const gate = radius * e.hearMod + 7;
      if (e.pos.distanceToSquared(pos) > gate * gate) continue;
      e.hear(noise, this);
    }
    for (const n of this.npcs) n.hear(pos, radius, kind);
  }

  /**
   * Phase-14 live-contact feed: project every hostile currently covered by a
   * friendly reveal volume (TS-7 pulse / tracker sweep) into screen space for
   * the HUD tactical markers. Reuses the producer of truth (revealCovers) so
   * markers and tac map always show the same contacts. Fills `out` (reused
   * scratch, no per-frame allocs) with
   *   { kind, dist, screenPos:THREE.Vector3 } and returns the count.
   */
  emitEnemyTelemetry(fromPos, THREE, out) {
    const g = this.game;
    out.length = 0;
    if (!g.throwables || !g.throwables.revealVolumes.length) return 0;
    const cam = g.camera;
    let n = 0;
    for (const e of this.list) {
      if (!e.alive) continue;
      if (!g.throwables.revealCovers(e.pos, false)) continue;
      const v = e.pos.clone();
      v.y += 1.55;
      v.project(cam);
      out.push({ kind: e.kind || 'hostile', dist: e.pos.distanceTo(fromPos), screenPos: v });
      if (++n >= 8) break;
    }
    return n;
  }

  damage(enemy, zone, amount, point, dir) {
    const killed = enemy.damageTaken(zone, amount, point, dir, this);
    const g = this.game;
    g.ui.hitMarker(killed);
    g.audio.hitMarker(killed);
    if (killed && !enemy._killCounted) {
      // Master upgrade P7: exactly one confirmation per enemy, emitted only
      // from the authoritative death result (damageTaken → die). Hits that
      // don't kill never reach this branch; a second lethal call on an
      // already-dead actor can't re-count (die() is alive-guarded, and the
      // _killCounted latch makes the counter + KILLED feed idempotent).
      enemy._killCounted = true;
      this.kills++;
      g.stats.kills++;
      if (g.ui && g.ui.killConfirm) g.ui.killConfirm({ headshot: zone === 'head', kind: enemy.kind || enemy.role || 'hostile', total: g.stats.kills });
    }
  }

  /** squad-wide alert state for the minimal HUD readout */
  get alertLevel() {
    const g = this.game;
    let lvl = 'unaware';
    for (const e of this.list) {
      if (!e.alive || e.surrendered || e.fled) continue;
      if (e.state === 'combat') { this._recoverT = 18; return 'combat'; }
      if (e.state === 'alert' && lvl === 'unaware') lvl = 'alert';
      else if (e.state === 'search') lvl = 'searching';
      else if (e.state === 'investigate' && lvl !== 'searching') lvl = 'investigating';
      else if (e.state === 'suspicious' && lvl === 'unaware') lvl = 'suspicious';
      else if (e.state === 'recovering' && lvl === 'unaware') lvl = 'recovering';
    }
    if (lvl !== 'unaware') return lvl;
    if (g.stats && g.stats.alarm) return 'alert';
    if (this._recoverT > 0) return 'recovering';
    return 'unaware';
  }

  get aliveCount() {
    let n = 0;
    for (const e of this.list) if (e.alive) n++;
    return n;
  }

  get reserveRemaining() {
    return this._reserve ? this._reserve.length : 0;
  }

  get remainingHostiles() {
    return this.activeHostiles + this.reserveRemaining + (this.surgeQueue || 0);
  }

  get totalMissionEnemies() {
    return this._totalPlannedHostiles || this.missionSpawnLimit || 50;
  }

  update(dt) {
    this._recoverT = Math.max(0, this._recoverT - dt);
    this.squadAlert = Math.max(0, this.squadAlert - dt * 0.035);
    this.game.audio.alertLevel = this.squadAlert;
    this._trySpawnSurge(dt);
    this._tickReserve(dt);          // Phase 17: staged garrison echelons (P3)
    this._deliverCommunications();

    // Cap settled corpses at 10 so large 150-248+ enemy missions stay bounded in memory & draw calls
    let settledCorpses = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const c = this.list[i];
      if (!c.alive && c.deathT >= 1 && !c.corpseExpired) {
        settledCorpses++;
        if (settledCorpses > 10) c.corpseExpired = true;
      }
    }

    const playerPos = this.game.player.pos;
    const pfRange = 52;   // High-fidelity per-frame animation and motion integration within 52m
    const pfRange2 = pfRange * pfRange;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.fled && this.game.time >= e.fledRemoveAt) {
        this.group.remove(e.model.root);
        disposeActorModel(e);
        this.list.splice(i, 1);
        continue;
      }
      if (e.corpseExpired) {
        this.group.remove(e.model.root);
        disposeActorModel(e);
        this.list.splice(i, 1);
        continue;
      }
      if (!e.alive) {
        e.update(dt, this);
        continue;
      }
      const d2 = e.pos.distanceToSquared(playerPos);
      const interval = e.state === 'combat' || e.state === 'alert' || e.canSeePlayer ? 0.085
        : d2 < 28 * 28 ? 0.12
          : d2 < 72 * 72 ? 0.23 : 0.46;
      e._aiAccumulator = Math.min(0.55, e._aiAccumulator + dt);
      // v16.4.2: AI DECISIONS stay on the staggered cadence above (perception,
      // targets, desired velocity), but for every actor inside the camera's
      // draw distance the MOVEMENT integration and presentation run every
      // frame (beyond it nothing is visible, so the cheap tick path remains). Previously position and
      // yaw only advanced on AI ticks (0.085-0.46 s apart), so the body
      // lurched forward in steps and snapped its heading by up to ~1 rad in a
      // single frame while the legs animated continuously. Hit box, muzzle and
      // visual model now always share one continuously-updated position.
      // The motion mode is fixed per AI interval so no movement time is ever
      // integrated twice or dropped when an actor crosses the range boundary.
      const perFrame = !!e._perFrame;
      if (e._aiAccumulator >= interval) {
        const simDt = Math.min(0.22, e._aiAccumulator);
        e._aiAccumulator -= simDt;
        e.update(simDt, this);                 // per-frame actors skip _move/_animate inside
        e._perFrame = d2 < pfRange2 || (e.canSeePlayer && d2 < 75 * 75);
      }
      if (perFrame && e.alive) {
        e._move(dt);
        e._animate(dt, this);
      }
    }

    if (this.npcs.length) {
      for (const n of this.npcs) n.update(dt);
      const wi = this.game.world.interactables;
      for (const it of wi) {
        if (it.id === 'npc_contact' && it.npc) it.pos.copy(it.npc.pos).setY(it.npc.pos.y + 1.2);
      }
      if (this.escortNpc && this.escortNpc.contacted && !this.escortComplete) {
        const lz = this.game.world.triggers.find(t => t.id === 'extraction' && t.center);
        if (lz && this.escortNpc.pos.distanceToSquared(lz.center) < 25) {
          this.escortComplete = true;
          this.game.ui.radio('SURVIVOR: "This is far enough — signal them. Thank you."');
          this.game.audio.pickup(this.escortNpc.pos);
        }
      }
    }
  }
}

// scratch vectors (module-level, reused — never captured across calls)
const ACTOR_PROBE_OPTS = Object.freeze({ actors: true });
const NO_PROBE_OPTS = Object.freeze({});
const _pv1 = new THREE.Vector3();
const _pv2 = new THREE.Vector3();
const _pv3 = new THREE.Vector3();
const _pv4 = new THREE.Vector3();
const _pv5 = new THREE.Vector3();
const _pv6 = new THREE.Vector3();
const _pv7 = new THREE.Vector3();
const _pv8 = new THREE.Vector3();
const _pv9 = new THREE.Vector3();

function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
