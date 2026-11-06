/**
 * impacts.js — solid-body contact response for every actor in the mission.
 *
 * The engine already swept characters against static geometry, but nothing in
 * the world had a body: an actor was a *consumer* of collision (moveBox) and
 * never a *provider*. This module closes that loop and adds the physical
 * consequence of a hard contact: a four-stage body state machine
 *
 *     standing → staggered → knocked_down → recovering → standing
 *
 * driven by the closing speed along the contact normal, mass-weighted, with
 * per-actor and per-pair cooldowns so incidental brushing never topples anyone
 * and a knockdown can never re-trigger itself into a loop.
 *
 * Deliberate constraints (each one guards a failure mode seen in the field):
 *  - impulses are horizontal only and capped, so nobody is launched;
 *  - before an impulse is applied the destination is tested against static
 *    geometry, so a body can never be shoved through a wall;
 *  - timers advance on their own clock, independent of collision results, so a
 *    body wedged against geometry still stands up (no permanent stuck state);
 *  - a downed actor keeps a (lowered) solid box, so you cannot walk through a
 *    fallen body either.
 */
import * as THREE from 'three';

export const BODY_STATE = Object.freeze({
  STANDING: 'standing',
  STAGGERED: 'staggered',
  KNOCKED_DOWN: 'knocked_down',
  RECOVERING: 'recovering',
});

export const IMPACT_TUNE = Object.freeze({
  /** Below this closing speed a contact is a brush: blocked, no reaction. A
   * walking body brushing a shoulder is therefore never a knockdown event. */
  INCIDENTAL_SPEED: 4.0,
  /** Above this, balance is lost (stagger). */
  STAGGER_SPEED: 4.0,
  /** Above this (mass-scaled) the subject goes down: sprinting pace, a charge,
   * or a vehicle rolling into you. */
  KNOCKDOWN_SPEED: 4.6,
  /** A moving actor that hits something hard staggers itself above this speed. */
  SELF_STAGGER_SPEED: 5.0,
  /** …and goes down above this, but only into something markedly heavier. */
  SELF_KNOCKDOWN_SPEED: 6.4,
  SELF_KNOCKDOWN_MASS_RATIO: 1.45,
  /** Fall / hold / get-up durations (s). `severity` (0..1) stretches the hold. */
  FALL_TIME: 0.42,
  DOWN_HOLD: 0.78,
  DOWN_HOLD_EXTRA: 0.62,
  GETUP_TIME: 0.62,
  STAGGER_TIME: 0.46,
  STAGGER_TIME_EXTRA: 0.3,
  /** Refractory periods (s). */
  COOLDOWN: 0.85,
  PAIR_COOLDOWN: 1.6,
  /** Impulse ceiling: closing speed × IMPULSE_GAIN, clamped to MAX_IMPULSE. */
  IMPULSE_GAIN: 0.3,
  MAX_IMPULSE: 2.2,
  /** How far a knockback may travel before the wall-safe clamp kicks in. */
  IMPULSE_PROBE: 0.55,
  /** Collision box height while lying down (still solid: no walking through). */
  DOWN_BOX_HEIGHT: 0.98,
  /** A hull rolling faster than this topples a body outright (m/s closing). */
  VEHICLE_KNOCK_SPEED: 3.4,
  /** Closing speed above which a vehicle also injures what it hits. */
  VEHICLE_DAMAGE_SPEED: 5.5,
  /** A charging actor (sprint/charge) counts a bit heavier for believability. */
  CHARGE_MASS_BONUS: 1.18,
});

const _tmpMin = new THREE.Vector3();
let _ejectMin = null;
let _ejectMax = null;
const _tmpMax = new THREE.Vector3();

/** Attach the impact state to an actor (player, soldier, NPC, vehicle crew). */
export function initImpactState(actor, opts = {}) {
  actor.mass = opts.mass != null ? opts.mass : 80;
  actor.bodyState = BODY_STATE.STANDING;
  actor.bodyStateT = 0;
  actor.bodyStateDur = 0;
  actor.impactCd = 0;
  actor.knockSeverity = 0;
  actor.fallDir = actor.fallDir || new THREE.Vector3();
  actor.downBlend = 0;                 // 0 upright → 1 fully on the ground
  actor._pairCd = actor._pairCd || new Map();
  actor._wasTouching = actor._wasTouching || null;
  // marker: this body participates in the knockdown FSM (a vehicle hull or a
  // prop deliberately does not — it is solid, but it cannot be toppled)
  actor.impactFsm = true;
  return actor;
}

export function isDowned(actor) {
  return !!actor && (actor.bodyState === BODY_STATE.KNOCKED_DOWN || actor.bodyState === BODY_STATE.RECOVERING);
}
export function isImpaired(actor) {
  return !!actor && actor.bodyState !== BODY_STATE.STANDING;
}

/** Movement / action modifiers for the current body state. */
export function bodyModifiers(actor) {
  if (!actor) return IMPACT_MODS_FREE;
  switch (actor.bodyState) {
    case BODY_STATE.STAGGERED: return { speedMul: 0.34, canSprint: false, canJump: false, canAim: true, canFire: true, aimSpreadMul: 1.75, mobility: 0.34 };
    case BODY_STATE.KNOCKED_DOWN: return { speedMul: 0, canSprint: false, canJump: false, canAim: false, canFire: false, aimSpreadMul: 3, mobility: 0 };
    case BODY_STATE.RECOVERING: return { speedMul: 0.42, canSprint: false, canJump: false, canAim: false, canFire: false, aimSpreadMul: 2.2, mobility: 0.42 };
    default: return IMPACT_MODS_FREE;
  }
}
const IMPACT_MODS_FREE = Object.freeze({ speedMul: 1, canSprint: true, canJump: true, canAim: true, canFire: true, aimSpreadMul: 1, mobility: 1 });

/**
 * Put an actor on the ground (or off balance) in response to a contact.
 * `closingSpeed` is the approach speed along the contact normal, `nx/nz` the
 * normal pointing *away* from the object hit (i.e. the push direction).
 */
export function applyImpact(actor, opts) {
  const { physics, closingSpeed = 0, nx = 0, nz = 0, source = null, forceState = null, subjectMassScale = 1, attackerMass = 80 } = opts;
  // Only bodies that run the impact state machine can react: a vehicle hull,
  // a turret mount or a debris prop is solid but has no balance to lose.
  if (!actor || actor.alive === false || !actor.impactFsm) return null;
  const { ignorePairCd = false } = opts;
  const speed = Math.max(0, closingSpeed);
  const T = IMPACT_TUNE;
  if (actor.impactCd == null) actor.impactCd = 0;
  if (actor._pairCd == null) actor._pairCd = new Map();
  const bypassCd = !!forceState || ignorePairCd;
  if (actor.impactCd > 0 && !bypassCd) return null;
  if (!forceState && actor.bodyState !== BODY_STATE.STANDING && actor.bodyStateT < 0.12) return null;
  // Getting up is a protected window. Without this, one relentless charger can
  // land the next knockdown ~1.7 s after the first — before the get-up has
  // finished — and the victim never regains control. A vehicle hit (forceState)
  // still lands, because standing up into a truck should not make you immune.
  if (!forceState && actor.bodyState === BODY_STATE.RECOVERING) return null;
  // A body already on the floor is not re-hypnotised every frame; a fresh hit
  // still escalates through the state machine above.
  if (ignorePairCd && actor.bodyState === BODY_STATE.KNOCKED_DOWN) return null;
  if (!bypassCd && actor._pairCd.size && actor._pairCd.get(pairKey(actor, source)) > 0) return null;

  const mass = Math.max(20, actor.mass || 80) * subjectMassScale;
  const massFactor = THREE.MathUtils.clamp(mass / 80, 0.6, 2.6);
  // The *attacker's* weight matters as much as its speed: a charging heavy
  // gunner or a truck bowls a body over where a scout merely bounces off.
  const attackPower = speed * THREE.MathUtils.clamp(Math.max(20, attackerMass || 80) / 80, 0.7, 6) ** 0.5;
  const knockAt = T.KNOCKDOWN_SPEED * (0.72 + 0.28 * massFactor);

  let state = forceState;
  if (!state) {
    if (speed < T.INCIDENTAL_SPEED) return null;             // brushing past: nothing
    else if (attackPower >= knockAt) state = BODY_STATE.KNOCKED_DOWN;
    else state = BODY_STATE.STAGGERED;
  }  if (state === actor.bodyState && actor.bodyStateT < actor.bodyStateDur * 0.35) return null; // no re-trigger spam

  const severity = THREE.MathUtils.clamp((Math.max(speed, attackPower) - T.STAGGER_SPEED) / 5.2, 0, 1);
  actor.knockSeverity = Math.max(state === BODY_STATE.KNOCKED_DOWN ? 0.35 : 0, severity);
  actor.bodyState = state;
  actor.bodyStateT = 0;
  actor.bodyStateDur = state === BODY_STATE.KNOCKED_DOWN
    ? T.FALL_TIME + T.DOWN_HOLD + T.DOWN_HOLD_EXTRA * severity + T.GETUP_TIME
    : T.STAGGER_TIME + T.STAGGER_TIME_EXTRA * severity;
  actor.impactCd = T.COOLDOWN + (state === BODY_STATE.KNOCKED_DOWN ? 0.5 : 0);
  // The pair budget is spent by an *attack*, not by a body paying for its own
  // blocked ram. A self-reaction (ignorePairCd) that wrote it would refresh the
  // cooldown every cycle and lock the defender out of ever being knocked down
  // again by that attacker.
  if (!ignorePairCd) {
    if (source && source._pairCd) source._pairCd.set(pairKey(actor, source), T.PAIR_COOLDOWN);
    if (actor._pairCd && source) actor._pairCd.set(pairKey(actor, source), T.PAIR_COOLDOWN);
  }

  // ---- impulse: horizontal, capped, and never into geometry --------------
  const gain = T.IMPULSE_GAIN / Math.max(0.6, massFactor);
  let mag = Math.min(T.MAX_IMPULSE, speed * gain);
  const len = Math.hypot(nx, nz);
  let ux = len > 1e-5 ? nx / len : 0;
  let uz = len > 1e-5 ? nz / len : 0;
  if (ux === 0 && uz === 0) { ux = 0; uz = 1; }
  if (physics && mag > 0.05) {
    const pos = actor.pos;
    const probe = wallSafePush(physics, actor, pos.x, pos.y, pos.z, ux, uz, mag, actor._body || null);
    ux = probe.x; uz = probe.z; mag = probe.mag;
  }
  if (mag > 0.02 && actor.vel) {
    actor.vel.x += ux * mag;
    actor.vel.z += uz * mag;
    if (state === BODY_STATE.KNOCKED_DOWN && actor.vel.y < 0.2) actor.vel.y = Math.max(actor.vel.y, 0.15);
  }
  if (state === BODY_STATE.KNOCKED_DOWN) {
    actor.fallDir.set(ux, 0, uz);
    if (actor.fallDir.lengthSq() < 0.04) actor.fallDir.set(nx || 1, 0, nz || 0);
    actor.fallDir.normalize();
    // a body going down stops trying to walk
    if (actor._wish) actor._wish.set(0, 0, 0);
    if (actor.moveSpeed != null) actor.moveSpeed = 0;
    if (actor.aiMode && actor.aiMode === 'route') actor.aiMode = 'staggered';
  }
  if (actor.game && actor.game.onBodyImpact) {
    actor.game.onBodyImpact(actor, state, speed, severity);
  }
  return { state, severity, impulse: mag };
}

function pairKey(a, b) {
  const ia = a && a.id != null ? a.id : (a && a.tag) || 0;
  const ib = b && b.id != null ? b.id : (b && b.tag) || 0;
  return ia < ib ? `${ia}|${ib}` : `${ib}|${ia}`;
}

/**
 * Slide a knockback along a wall instead of into it: if the straight push would
 * end inside static geometry, keep only the tangential component; if that is
 * also blocked, drop the impulse. Never returns a move that enters a wall.
 */
export function wallSafePush(physics, actor, x, y, z, ux, uz, mag, selfBody) {
  const reach = Math.min(IMPACT_TUNE.IMPULSE_PROBE, Math.max(0.18, mag * 0.28));
  const hw = actor._halfWidth != null ? actor._halfWidth : 0.34;
  const hh = actor.bodyState === BODY_STATE.KNOCKED_DOWN
    ? IMPACT_TUNE.DOWN_BOX_HEIGHT
    : (actor._height != null ? actor._height : 1.8);
  const test = (px, pz) => {
    _tmpMin.set(px - hw, y + 0.06, pz - hw);
    _tmpMax.set(px + hw, y + hh - 0.06, pz + hw);
    return physics.isBoxFree(_tmpMin, _tmpMax, {
      ignore: (c) => c === selfBody || (!!actor._body && c.entity === actor),
    });
  };
  if (test(x + ux * reach, z + uz * reach)) return { x: ux, z: uz, mag };
  // tangential slide (perpendicular to the push, in the ground plane)
  const tx = -uz, tz = ux;
  const fwdOk = test(x + tx * reach, z + tz * reach);
  const backOk = test(x - tx * reach, z - tz * reach);
  if (fwdOk || backOk) {
    const s = fwdOk === backOk ? (actor.rng ? (actor.rng() < 0.5 ? -1 : 1) : 1) : (fwdOk ? 1 : -1);
    return { x: tx * s, z: tz * s, mag: mag * 0.45 };
  }
  return { x: 0, z: 0, mag: 0 };
}

/**
 * Advance the body-state timers. Called once per actor per frame, on the actor's
 * own clock so a wedged body always stands up again.
 */
export function tickBodyState(actor, dt) {
  if (!actor) return;
  if (actor.impactCd > 0) actor.impactCd = Math.max(0, actor.impactCd - dt);
  if (actor._pairCd && actor._pairCd.size) {
    for (const [k, v] of actor._pairCd) {
      const nv = v - dt;
      if (nv <= 0) actor._pairCd.delete(k); else actor._pairCd.set(k, nv);
    }
  }
  const state = actor.bodyState;
  if (state === BODY_STATE.STANDING) {
    if (actor.downBlend) actor.downBlend = Math.max(0, actor.downBlend - dt * 3.4);
    return;
  }
  actor.bodyStateT += dt;
  const T = IMPACT_TUNE;
  if (state === BODY_STATE.KNOCKED_DOWN) {
    const fall = T.FALL_TIME;
    const holdEnd = fall + T.DOWN_HOLD + T.DOWN_HOLD_EXTRA * actor.knockSeverity;
    if (actor.bodyStateT < fall) actor.downBlend = Math.min(1, actor.downBlend + dt / Math.max(0.0001, fall));
    else if (actor.bodyStateT < holdEnd) actor.downBlend = 1;
    else actor.downBlend = Math.max(0, actor.downBlend - dt / Math.max(0.0001, T.GETUP_TIME));
    if (actor.bodyStateT >= holdEnd) {
      actor.bodyState = BODY_STATE.RECOVERING;
      actor.bodyStateT = 0;
      actor.bodyStateDur = T.GETUP_TIME;
    }
    return;
  }
  if (state === BODY_STATE.RECOVERING) {
    actor.downBlend = Math.max(0, 1 - actor.bodyStateT / Math.max(0.0001, actor.bodyStateDur));
    if (actor.bodyStateT >= actor.bodyStateDur) {
      actor.bodyState = BODY_STATE.STANDING;
      actor.bodyStateT = 0;
      actor.bodyStateDur = 0;
      actor.knockSeverity = 0;
      actor.downBlend = 0;
    }
    return;
  }
  // STAGGERED: wobble upright
  actor.downBlend = Math.max(0, Math.min(0.24, actor.downBlend + dt * 0.4) - actor.bodyStateT * 0.2);
  if (actor.bodyStateT >= actor.bodyStateDur) {
    actor.bodyState = BODY_STATE.STANDING;
    actor.bodyStateT = 0;
    actor.bodyStateDur = 0;
    actor.knockSeverity = 0;
    actor.downBlend = 0;
  }
}

/** 0..1 "how far down is this body" for animation/pose code. */
export function downBlend(actor) {
  return actor && Number.isFinite(actor.downBlend) ? THREE.MathUtils.clamp(actor.downBlend, 0, 1) : 0;
}

/**
 * Contact bookkeeping for a mover that just ran `moveBox`: raises the impact on
 * both sides of every solid actor contact, using the real closing speed.
 * `contacts` is the flat [body, nx, nz, …] list produced by the solver.
 */
export function processMoveContacts(mover, physics, out, dt, opts = {}) {
  if (!out || !out.contactedActor || !out.actorContacts || !out.actorContacts.length) {
    if (mover) mover._touchingAny = false;
    return null;
  }
  const list = out.actorContacts;
  const vx = mover.vel ? mover.vel.x : 0;
  const vz = mover.vel ? mover.vel.z : 0;
  // moveBox already zeroed/damped nothing, but a *blocked* mover's velocity is
  // unreliable on the blocked axis, so the requested travel (4th slot of each
  // contact record) is the honest measure of how hard this frame hit.
  const wasTouching = mover._touching || (mover._touching = new Set());
  const nowTouching = new Set();
  let strongest = null;
  for (let i = 0; i < list.length; i += 4) {
    const body = list[i];
    const nx = list[i + 1], nz = list[i + 2], travel = list[i + 3] || 0;
    const other = body && body.entity;
    if (!other || other === mover) continue;
    if (other.alive === false) continue;
    if (opts.skip && opts.skip(mover, other)) continue;
    nowTouching.add(body.id);
    // relative closing speed along the contact normal (mover into other)
    const ovx = other.vel ? other.vel.x : 0;
    const ovz = other.vel ? other.vel.z : 0;
    const closing = (vx - ovx) * -nx + (vz - ovz) * -nz;
    const intent = Math.max(travel > 0 ? travel / Math.max(1e-4, dt) : 0, mover._intentSpeed || 0);
    // the victim's own motion away from us relieves the impact
    const relief = (ovx * -nx + ovz * -nz) < 0 ? 0 : (ovx * -nx + ovz * -nz);
    const speed = Math.max(Math.abs(closing), intent - relief, Math.hypot(vx, vz) * 0.55);
    if (!strongest || speed > strongest.speed) strongest = { body, other, nx, nz, speed };
  }
  mover._touching = nowTouching;  if (!strongest) return null;
  const fresh = !wasTouching.has(strongest.body.id);
  const cd = (mover._pairCd && mover._pairCd.get(pairKey(mover, strongest.other))) || 0;
  if (!fresh && cd > 0) return { resting: true, other: strongest.other };

  const T = IMPACT_TUNE;
  const speed = strongest.speed;
  if (speed < T.INCIDENTAL_SPEED) return { resting: true, other: strongest.other };

  // The moving actor is the aggressor: its own mass/charge decides who falls.
  const moverCharge = speed * (mover.sprinting || mover.charging ? T.CHARGE_MASS_BONUS : 1);
  // A hull or a mount is not a balance-bearing body: it blocks, it does not fall.
  const canTopple = !!strongest.other.impactFsm;
  const hit = canTopple
    ? applyImpact(strongest.other, {
      physics,
      closingSpeed: moverCharge,
      nx: -strongest.nx,
      nz: -strongest.nz,
      source: mover,
      subjectMassScale: opts.defenderMassScale || 1,
      attackerMass: mover.mass || 80,
    })
    : null;
  // and the aggressor pays for hitting something solid, if it hit hard enough
  const otherMass = strongest.other.mass || strongest.other.collisionMass || 80;
  const myMass = mover.mass || 80;
  let self = null;
  if (speed >= T.SELF_STAGGER_SPEED) {
    const selfState = speed >= T.SELF_KNOCKDOWN_SPEED && otherMass >= myMass * T.SELF_KNOCKDOWN_MASS_RATIO
      ? BODY_STATE.KNOCKED_DOWN
      : BODY_STATE.STAGGERED;
    self = applyImpact(mover, {
      physics,
      closingSpeed: speed * (myMass / Math.max(myMass, otherMass)) * 0.9,
      nx: strongest.nx,
      nz: strongest.nz,
      source: strongest.other,
      forceState: selfState,
      // the pair cooldown this very call just wrote must not veto the recoil
      ignorePairCd: true,
    });
  }
  return { hit, self, other: strongest.other, speed };
}

/**
 * Push a character out of a vehicle hull that has swept over it. A body caught
 * by a rolling hull is knocked down by `applyImpact`, but knockback alone cannot
 * clear a 6 m hull in the six frames it takes to pass, so the contact is also
 * resolved geometrically along the axis of least penetration. Wall-safe: if the
 * escape is blocked on one side the other side is tried, and a body that has
 * nowhere to go is left where the impact FSM put it rather than shoved into a wall.
 */
export function ejectFromHull(victim, hullBox, physics, selfBody) {
  if (!victim || !victim.pos || !hullBox || !physics) return false;
  const half = victim.radius || 0.34;
  const c = victim.pos;
  const penPx = hullBox.max.x - (c.x - half);
  const penNx = (c.x + half) - hullBox.min.x;
  const penPz = hullBox.max.z - (c.z - half);
  const penNz = (c.z + half) - hullBox.min.z;
  if (Math.min(penPx, penNx, penPz, penNz) <= 0.001) return false;
  const cand = [
    ['x', penPx, half], ['x', -penNx, -half],
    ['z', penPz, half], ['z', -penNz, -half],
  ].filter((k) => Number.isFinite(k[1])).sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]));
  const skin = 0.02;
  const tryAt = (x, y, z) => {
    const min = _ejectMin || (_ejectMin = new THREE.Vector3());
    const max = _ejectMax || (_ejectMax = new THREE.Vector3());
    min.set(x - half, y + 0.03, z - half);
    max.set(x + half, y + Math.max(1.2, victim.height || 1.8) - 0.04, z + half);
    if (!physics.isBoxFree(min, max, { actors: true, ignore: (cc) => cc === selfBody })) return false;
    victim.pos.set(x, y, z);
    if (victim._wish) victim._wish.set(0, 0, 0);
    if (victim.vel) { victim.vel.x *= 0.25; victim.vel.z *= 0.25; }
    return true;
  };
  for (const k of cand) {
    if (tryAt(c.x + (k[0] === 'x' ? k[1] + skin : 0), c.y, c.z + (k[0] === 'z' ? k[1] + skin : 0))) return true;
  }
  return false;
}

/** Contact edge bookkeeping when a move did NOT report a contact. */
export function clearContacts(mover) {
  if (!mover) return;
  if (mover._touching) mover._touching.clear();
}

/**
 * Register (or refresh) an actor's solid body in the physics actor field.
 * Call it every frame right after the actor recomputes its AABB: the body is
 * re-bucketed only when it crosses a cell boundary, so keeping collision in
 * lock-step with a moving vehicle costs one AABB copy per frame.
 */
export function syncActorBody(physics, actor, box, opts = {}) {
  if (!physics || !physics.actors || !actor) return null;
  const gen = physics.actors.generation;
  if (!actor._body || actor._bodyGen !== gen) {
    if (actor._body) physics.removeActorBody(actor._body);
    actor._body = physics.addActorBody(box.min, box.max, {
      tag: opts.tag || 'actor',
      entity: actor,
      mass: actor.mass || 80,
      material: opts.material,
    });
    actor._bodyGen = gen;
    actor._bodySpanVersion = actor._body.version;
    return actor._body;
  }
  if (actor._bodySkip) return actor._body;
  physics.syncActorBody(actor._body, box.min, box.max);
  return actor._body;
}

export function unregisterActorBody(physics, actor) {
  if (!actor || !actor._body) return;
  if (physics) physics.removeActorBody(actor._body);
  actor._body = null;
  actor._bodyGen = -1;
}

/** A body that must temporarily stop colliding (e.g. the operator seated in a
 * vehicle hull) keeps its registration but is excluded from queries. */
export function setActorBodyEnabled(actor, enabled) {
  if (!actor || !actor._body) return;
  actor._body.enabled = !!enabled;
  actor._bodySkip = !enabled;
}
