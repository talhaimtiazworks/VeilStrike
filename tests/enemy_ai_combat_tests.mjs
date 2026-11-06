/**
 * enemy_ai_combat_tests.mjs — behavioural verification of the Phase-1 (enemy
 * detection / combat FSM) and Phase-2 (locomotion) fixes.
 *
 * Every check asserts an *observed trajectory* from the real update loops (real
 * EnemyManager, real physics, real weapon profiles, per-frame integration), not
 * a unit value or a stubbed re-implementation.
 *
 * Isolation: each check builds its own facility (fresh `makeGame`) because the
 * tests add walls and mutate player stance — sharing one world made one check's
 * geometry another check's result, which is a test bug, not an AI finding.
 *
 * Headless note: there is no browser in this environment, so "looks believable"
 * is quantified (turn rates, accel ramps, reversal counts, spacing margins)
 * rather than eyeballed.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AI_SENSE, AI_MOVE } from '../js/enemies.js';
import { MISSION_ORDER, DIFFICULTIES } from '../js/progress.js';
import { MISSION_DEFS, syncCampaignMissionDefs } from '../js/missions.js';
import {
  results, check, makeGame, spawnEnemy, findOpenSpot, retireEnemy, bodyAt, overlapXZ,
} from './world_harness.mjs';

const DEG = Math.PI / 180;
const DT = 1 / 60;

/** A fresh, isolated world with the player parked on verified open ground. */
function world(radius = 8, mapId = 'facility') {
  const g = makeGame(mapId);
  const spot = findOpenSpot(g, radius);
  const p = new THREE.Vector3(spot.x, spot.y, spot.z);
  g.player.reset(p, 0);
  g.player.health = 100;
  g.player.alive = true;
  return { g, spot, p };
}

/** Advance the real loop; `onFrame(i)` runs after perception/movement/animation. */
function sim(g, frames, onFrame, input) {
  for (let i = 0; i < frames; i++) {
    g.time += DT;
    g.scene.updateMatrixWorld(true);
    g.enemies.update(DT);
    g.player.update(DT, input || g.input);
    if (onFrame) onFrame(i);
  }
}

/** Spawn a soldier on clear ground with a *verified* sight line to the player. */
function placeVisible(g, playerPos, dist, kind = 'rifleman', facePlayer = true) {
  for (let a = 0; a < 96; a++) {
    const ang = (a / 96) * Math.PI * 2;
    const p = new THREE.Vector3(
      playerPos.x + Math.cos(ang) * dist, playerPos.y, playerPos.z + Math.sin(ang) * dist,
    );
    let e;
    try { e = spawnEnemy(g, p.x, p.y, p.z, kind); } catch { continue; }
    const chest = new THREE.Vector3(playerPos.x, playerPos.y + 1.02, playerPos.z);
    const clear = g.physics.hasLOS(e.eyePos(new THREE.Vector3()), chest);
    const d = Math.hypot(e.pos.x - playerPos.x, e.pos.z - playerPos.z);
    if (!clear || Math.abs(d - dist) > 4) { retireEnemy(g, e); continue; }
    const yaw = facePlayer ? Math.atan2(-(playerPos.x - e.pos.x), -(playerPos.z - e.pos.z)) : e.yaw + Math.PI;
    e.yaw = yaw; e.aimYaw = yaw;
    if (e.model && e.model.root) e.model.root.rotation.y = yaw;  // rig starts consistent: placement must not read as a spin
    e.lastPos.copy(e.pos);
    return e;
  }
  throw new Error(`no unobstructed ${dist} m placement for ${kind} in this map`);
}

/** Axis-aligned slab across the sight line; returns false if it failed to block. */
function wallBetween(g, from, to, y) {
  const mid = new THREE.Vector3((from.x + to.x) / 2, (y ?? from.y) + 1.2, (from.z + to.z) / 2);
  const alongX = Math.abs(to.x - from.x) >= Math.abs(to.z - from.z);
  const half = alongX ? new THREE.Vector3(0.25, 2.2, 9) : new THREE.Vector3(9, 2.2, 0.25);
  g.physics.addBox(mid, half, 'concrete', { tag: 'ai-test-wall' });
  const eye = new THREE.Vector3(from.x, from.y + 1.6, from.z);
  const chest = new THREE.Vector3(to.x, to.y + 1.02, to.z);
  return g.physics.hasLOS(eye, chest) === false;
}

syncCampaignMissionDefs();

const wrap = (a) => { let x = a; while (x > Math.PI) x -= Math.PI * 2; while (x < -Math.PI) x += Math.PI * 2; return x; };
const bearingTo = (e, p) => Math.atan2(-(p.x - e.pos.x), -(p.z - e.pos.z));

/** Count shots from the audio cue the real firing path emits (audio.gunshot(profile, origin, opts)). */
function shotTap(g) {
  const taps = [];
  const real = g.audio.gunshot;
  g.audio.gunshot = (...a) => { taps.push({ t: g.time, pos: a[1] }); return real ? real(...a) : undefined; };
  return taps;
}

// ---------------------------------------------------------------------------
// A — perception: line of sight, configurable range, no clairvoyance
// ---------------------------------------------------------------------------
check('A1. an operator standing in the open at 18 m is recognised within 2.5 s', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 18, 'rifleman');
  let at = -1, t = 0;
  sim(g, 300, () => {
    t += DT;
    if (at < 0 && e.detection >= AI_SENSE.SPOT_THRESHOLD) at = t;
  });
  assert.ok(at >= 0, `never crossed the ${AI_SENSE.SPOT_THRESHOLD} recognition threshold in 5 s`);
  assert.ok(at <= 2.5, `recognised in ${at.toFixed(2)} s (threshold ${AI_SENSE.SPOT_THRESHOLD})`);
  retireEnemy(g, e);
});

check('A2. detection is line-of-sight based: a solid wall means never', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 12, 'rifleman');
  assert.ok(wallBetween(g, e.pos, p), 'test wall verifiably occludes the sight line (asserted, not assumed)');
  sim(g, 900);
  assert.ok(e.detection < 0.25, `detection ${e.detection.toFixed(2)} stayed near zero behind cover`);
  assert.equal(e.canSeePlayer, false, 'canSeePlayer false through a wall');
  assert.ok(!['combat', 'alert'].includes(e.state), `stayed calm (${e.state})`);
  retireEnemy(g, e);
});

check('A3. visual range is a real limit (rifleman) and is archetype-configurable', () => {
  const { g, p } = world();
  const far = 78;
  const rifle = placeVisible(g, p, far, 'rifleman');
  assert.ok(rifle.visionRange < far, `rifleman visionRange ${rifle.visionRange.toFixed(0)} m < ${far} m test distance`);
  sim(g, 600);
  assert.ok(rifle.detection < AI_SENSE.SPOT_THRESHOLD, `out-of-range soldier never reaches recognition (${rifle.detection.toFixed(2)})`);
  assert.ok(!['combat', 'alert'].includes(rifle.state), `out-of-range soldier stays calm (${rifle.state})`);
  retireEnemy(g, rifle);
  const sniper = placeVisible(g, p, far, 'marksman');
  assert.ok(sniper.visionRange > rifle.visionRange, `marksman optic is longer (${sniper.visionRange.toFixed(0)} > ${rifle.visionRange.toFixed(0)} m)`);
  sim(g, 600);
  assert.ok(sniper.detection >= AI_SENSE.SPOT_THRESHOLD, `same distance, longer range ⇒ recognised (${sniper.detection.toFixed(2)})`);
  retireEnemy(g, sniper);
});

check('A4. the tuning block is a live knob (AI_SENSE.BASE_GAIN speeds recognition)', () => {
  const measure = () => {
    const { g, p } = world();
    const e = placeVisible(g, p, 26, 'rifleman');
    let at = 10, t = 0;
    sim(g, 600, () => { t += DT; if (at === 10 && e.detection >= AI_SENSE.SPOT_THRESHOLD) at = t; });
    retireEnemy(g, e);
    return at;
  };
  const before = measure();
  const saved = AI_SENSE.BASE_GAIN;
  AI_SENSE.BASE_GAIN = saved * 3;
  const after = measure();
  AI_SENSE.BASE_GAIN = saved;
  assert.equal(AI_SENSE.BASE_GAIN, saved, 'tunable restored after the experiment');
  assert.ok(after < before, `tripling the gain speeds recognition (${before.toFixed(2)} s → ${after.toFixed(2)} s)`);
});

check('A5. stance changes how fast a clear-sight target is noticed', () => {
  // Time to *recognition*, not the capped detection value: comparing 1.000 with
  // 1.000 measures nothing, which is how this check first "failed".
  const run = (crouch) => {
    const { g, p } = world();
    const e = placeVisible(g, p, 24, 'rifleman');
    const input = crouch ? { crouch: true } : {};
    let t = 0, at = Infinity;
    // Stance goes through the real input path (player.update lerps crouchT from
    // input.crouch); assigning crouchT by hand is overwritten on the next frame,
    // which is why this check first measured the same 1.60 s for both stances.
    sim(g, 45, null, input);
    sim(g, 560, () => {
      t += DT;
      if (at === Infinity && e.detection >= AI_SENSE.SPOT_THRESHOLD) at = t;
    }, input);
    return at;
  };
  const standing = run(false);
  const crouched = run(true);
  assert.ok(Number.isFinite(standing), 'a standing target in the open is recognised');
  assert.ok(crouched > standing, `crouching buys time: ${standing.toFixed(2)} s standing → ${Number.isFinite(crouched) ? crouched.toFixed(2) + ' s crouched' : 'not recognised in 10 s'}`);
});

check('A6. gunfire draws attention: a distant enemy reacts to the report', () => {
  const { g, spot, p } = world();
  const e = placeVisible(g, p, 40, 'rifleman', false);   // facing away: only the sound is a cue
  e.detection = 0;
  const before = { x: e.pos.x, z: e.pos.z };
  g.emitNoise(new THREE.Vector3(spot.x, spot.y + 1.2, spot.z), 70, 'gunshot');
  sim(g, 420);
  const moved = Math.hypot(e.pos.x - before.x, e.pos.z - before.z);
  assert.ok(e.lastKnownValid || moved > 0.4 || e.state !== 'wander',
    `noise left a memory and/or a reaction (state ${e.state}, moved ${moved.toFixed(1)} m, lastKnown ${e.lastKnownValid})`);
  retireEnemy(g, e);
});

// ---------------------------------------------------------------------------
// B — combat: face then fire, finite ammo, stop when contact ends
// ---------------------------------------------------------------------------
check('B1. a soldier in contact engages, fires and damages the player', () => {
  const { g, p } = world();
  const hp0 = g.player.health;
  const taps = shotTap(g);
  const e = placeVisible(g, p, 14, 'rifleman');
  let dmgEvents = 0;
  const realAdp = g.applyDamageToPlayer.bind(g);
  g.applyDamageToPlayer = (...a) => { dmgEvents++; return realAdp(...a); };
  sim(g, 900);
  assert.equal(e.state, 'combat', `reached combat (${e.state})`);
  assert.ok(taps.length >= 3, `fired ${taps.length} shots in 15 s`);
  assert.ok(dmgEvents >= 1 || g.player.health < hp0,
    `damage routed through the player damage system (${hp0.toFixed(0)} → ${g.player.health.toFixed(0)}, events ${dmgEvents})`);
  retireEnemy(g, e);
});

check('B2. soldiers orient before firing (no snap-shot mid-turn)', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 16, 'assault');
  const offsets = [];
  const realShoot = e._shoot.bind(e);
  e._shoot = (d) => {
    const r = realShoot(d);
    if (r) offsets.push(Math.abs(wrap(e.aimYaw - bearingTo(e, p))));
    return r;
  };
  sim(g, 600);
  assert.ok(offsets.length >= 1, `observed ${offsets.length} fired shots`);
  const worst = Math.max(...offsets);
  assert.ok(worst < 0.32, `worst aim offset on a fired shot ${worst.toFixed(3)} rad (< 18°)`);
  retireEnemy(g, e);
});

check('B3. enemies never shoot through solid geometry', () => {
  const { g, p } = world();
  const taps = shotTap(g);
  const e = placeVisible(g, p, 12, 'heavy');
  const blocked = wallBetween(g, e.pos, p);
  assert.ok(blocked, 'wall verified to occlude the sight line');
  e.detection = 1; e.canSeePlayer = true; e.hasLOS = true;   // try to fire on a stale "I see him" flag
  e.state = 'combat'; e.combatAction = 'engage'; e.windupT = 0;
  sim(g, 600);
  assert.ok(taps.length === 0, `${taps.length} shots fired while occluded (firing gate re-checks LOS per shot)`);
  retireEnemy(g, e);
});

check('B4. fire rate is weapon-specific and burst-paced', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 16, 'assault');
  const cadence = e.weaponProfile.cadence;
  const gaps = [];
  let last = null;
  const realShoot = e._shoot.bind(e);
  e._shoot = (d) => {
    const r = realShoot(d);
    if (r) { if (last !== null) gaps.push(g.time - last); last = g.time; }
    return r;
  };
  sim(g, 900);
  assert.ok(gaps.length >= 2, `${gaps.length + 1} shots at cadence ${cadence.toFixed(3)} s`);
  const minGap = Math.min(...gaps);
  assert.ok(minGap >= cadence * 0.9, `shortest gap ${minGap.toFixed(3)} s ≥ weapon cadence ${cadence.toFixed(3)} s`);
  assert.ok(e.burstLen >= 1 && e.burstLen <= 9, `burst length ${e.burstLen} (a burst, not a stream)`);
  retireEnemy(g, e);
});

check('B5. ammo is finite: they reload, and a dry soldier stops firing', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 12, 'heavy');
  e.ammo = 3; e.reserveAmmo = 6;
  let sawReload = false;
  sim(g, 700, () => { if (e.reloadT > 0) sawReload = true; });
  assert.ok(sawReload || e.reloadsCompleted >= 1, `reloaded during the fight (completed ${e.reloadsCompleted})`);
  assert.ok(e.reserveAmmo < 6 || e.reloadsCompleted >= 1, `reload consumed reserve (mag ${e.ammo}, reserve ${e.reserveAmmo})`);
  const taps = shotTap(g);
  e.ammo = 0; e.reserveAmmo = 0; e.reloadT = 0;
  sim(g, 300);
  assert.equal(e.ammo, 0, 'mag still empty (nothing refills it from nowhere)');
  assert.equal(e.reserveAmmo, 0, 'reserve still empty (ammo is finite)');
  assert.equal(taps.length, 0, 'dry weapon fires zero shots');
  retireEnemy(g, e);
});

check('B6. accuracy is not perfect: some rounds miss a stationary target', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 34, 'rifleman');
  let shots = 0, hits = 0;
  const realHit = g.applyDamageToPlayer.bind(g);
  g.applyDamageToPlayer = (...a) => { hits++; return realHit(...a); };
  const realShoot = e._shoot.bind(e);
  e._shoot = (d) => { const r = realShoot(d); if (r) shots++; return r; };
  g.player.health = 1000;
  sim(g, 960);
  assert.ok(shots >= 4, `${shots} shots taken at 34 m in 16 s`);
  assert.ok(hits < shots, `${hits} hits from ${shots} shots — spread is real, not a hitscan laser`);
  retireEnemy(g, e);
});

check('B7. firing stops when the player dies', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 14, 'rifleman');
  sim(g, 420);
  assert.equal(e.state, 'combat', `engaged first (state ${e.state})`);
  const taps = shotTap(g);
  g.player.alive = false; g.player.health = 0;
  sim(g, 300);
  assert.ok(taps.length <= 1, `${taps.length} shots after the player died`);
  assert.ok(e.detection < 0.2, `visual memory decayed with a dead target (${e.detection.toFixed(2)})`);
  retireEnemy(g, e);
});

check('B8. losing contact goes to the last known position, not back to patrol', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 16, 'rifleman');
  sim(g, 360);
  assert.equal(e.state, 'combat', `engaged first (state ${e.state})`);
  assert.ok(e.lastKnownValid, 'last-known position recorded');
  const known = e.lastKnown.clone();
  const start = e.pos.clone();
  wallBetween(g, e.pos, p);
  let sawSearchish = false;
  sim(g, 600, () => { if (e.state === 'search' || e.state === 'investigate' || e.combatAction === 'advance') sawSearchish = true; });
  const drift = Math.hypot(e.pos.x - known.x, e.pos.z - known.z);
  const moved = Math.hypot(e.pos.x - start.x, e.pos.z - start.z);
  assert.ok(sawSearchish || drift < 8,
    `moved to/toward the last known point (state ${e.state}, action ${e.combatAction}, dist to it ${drift.toFixed(1)} m, moved ${moved.toFixed(1)} m)`);
  retireEnemy(g, e);
});

check('B9. DEAD: a killed soldier stops moving, aiming and shooting', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 12, 'rifleman');
  sim(g, 300);
  const taps = shotTap(g);
  const { x, z, yaw } = { x: e.pos.x, z: e.pos.z, yaw: e.yaw };
  g.enemies.damage(e, 'torso', 9999, e.pos, null);
  sim(g, 300);
  assert.equal(e.alive, false, 'dead');
  const moved = Math.hypot(e.pos.x - x, e.pos.z - z);
  assert.ok(moved < 0.3, `body did not walk it off (${moved.toFixed(2)} m)`);
  assert.ok(Math.abs(wrap(e.yaw - yaw)) < 0.4, `facing settled (${Math.abs(wrap(e.yaw - yaw)).toFixed(2)} rad drift)`);
  assert.equal(taps.length, 0, 'no shots after death');
  retireEnemy(g, e);
});

// ---------------------------------------------------------------------------
// C — locomotion: ramps, rates, spacing, obstacle handling, collisions intact
// ---------------------------------------------------------------------------
check('C1. acceleration and deceleration are ramped, not instantaneous', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 20, 'rifleman');
  e.state = 'wander'; e.detection = 0; e.canSeePlayer = false; e.hasLOS = false;
  const limit = Math.max(AI_MOVE.ACCEL, AI_MOVE.DECEL) * 1.4;
  let worst = 0, peak = 0, prev = e.moveSpeed || 0;
  sim(g, 600, () => {
    const s = e.moveSpeed || 0;
    if (!e._motionBlocked) worst = Math.max(worst, Math.abs(s - prev) / DT);
    e._motionBlocked = false;
    peak = Math.max(peak, s);
    prev = s;
  });
  assert.ok(peak > 0.4, `actually walked (peak ${peak.toFixed(2)} m/s)`);
  assert.ok(worst <= limit,
    `worst per-frame speed change ${worst.toFixed(1)} m/s² within the ${AI_MOVE.ACCEL}/${AI_MOVE.DECEL} m/s² ramp`);
  retireEnemy(g, e);
});

check('C2. rendered turning rate stays inside the AI turn caps (no spin)', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 10, 'assault');
  const root = e.model && e.model.root;
  assert.ok(root, 'soldier has a visible rig to measure');
  let worst = 0, travel = 0, prev = root.rotation.y;
  sim(g, 900, (i) => {
    if (i < 30) { prev = root.rotation.y; return; }   // ignore the placement warm-up
    const d = wrap(root.rotation.y - prev);
    worst = Math.max(worst, Math.abs(d) / DT);
    travel += Math.abs(d);
    prev = root.rotation.y;
  });
  assert.ok(worst <= AI_MOVE.COMBAT_TURN * 1.3,
    `peak rendered turn rate ${worst.toFixed(2)} rad/s ≤ ${AI_MOVE.COMBAT_TURN} rad/s (+30 % easing margin)`);
  assert.ok(travel < 60, `total turn travel ${travel.toFixed(1)} rad over 14.5 s of contact (was 12.2 rad for a 15 s stationary-target case before the fix, with sustained thrash)`);
  retireEnemy(g, e);
});

check('C3. heading does not oscillate while pursuing', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 22, 'rifleman');
  let flips = 0, sign = 0, prev = e.yaw;
  sim(g, 900, () => {
    const d = wrap(e.yaw - prev);
    const s = Math.abs(d) > 0.02 ? Math.sign(d) : 0;
    if (s && sign && s !== sign) flips++;
    if (s) sign = s;
    prev = e.yaw;
  });
  assert.ok(flips <= 45, `${flips} heading sign changes in 15 s (≤45 allows normal cornering, rejects thrash)`);
  retireEnemy(g, e);
});

check('C4. strafing keeps the target in front (no sideways glide facing nowhere)', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 13, 'assault');
  sim(g, 420);
  assert.equal(e.state, 'combat', `in combat first (${e.state})`);
  let samples = 0, worstWhileFast = 0;
  sim(g, 480, () => {
    const speed = Math.hypot(e._actualVX || 0, e._actualVZ || 0);
    if (e.state !== 'combat' || !e.canSeePlayer) return;
    samples++;
    if (speed > 0.6) worstWhileFast = Math.max(worstWhileFast, Math.abs(wrap(e.yaw - bearingTo(e, p))));
  });
  assert.ok(samples > 60, `${samples} sampled combat frames`);
  assert.ok(worstWhileFast < 1.0,
    `facing error while moving stayed ${worstWhileFast.toFixed(2)} rad < 57° (the rig no longer overwrites AI facing)`);
  retireEnemy(g, e);
});

check('C5. obstacles are routed around, never penetrated', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 9, 'rifleman');
  const mid = new THREE.Vector3((e.pos.x + p.x) / 2, p.y + 1.2, (e.pos.z + p.z) / 2);
  const alongX = Math.abs(e.pos.x - p.x) >= Math.abs(e.pos.z - p.z);
  const half = alongX ? new THREE.Vector3(0.3, 2.2, 6) : new THREE.Vector3(6, 2.2, 0.3);
  g.physics.addBox(mid, half, 'concrete', { tag: 'ai-test-route' });
  const solid = new THREE.Box3(
    new THREE.Vector3(mid.x - half.x, mid.y - half.y, mid.z - half.z),
    new THREE.Vector3(mid.x + half.x, mid.y + half.y, mid.z + half.z),
  );
  let inside = 0, maxStep = 0;
  const prev = e.pos.clone();
  sim(g, 900, () => {
    maxStep = Math.max(maxStep, Math.hypot(e.pos.x - prev.x, e.pos.z - prev.z));
    prev.copy(e.pos);
    if (e.pos.y < solid.max.y && e.pos.y + 1.7 > solid.min.y
      && overlapXZ(bodyAt(e.pos, 0.32, 1.78), { min: solid.min, max: solid.max }) > 0.02) inside++;
  });
  assert.equal(inside, 0, `frames spent inside the wall: ${inside} (collision left enabled, not bypassed)`);
  assert.ok(maxStep < 1.0, `largest single-frame step ${maxStep.toFixed(2)} m — no teleporting through geometry`);
  retireEnemy(g, e);
});

check('C6. a soldier pinned against geometry recovers instead of grinding forever', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 7, 'rifleman');
  const cx = e.pos.x, cz = e.pos.z;
  g.physics.addBox(new THREE.Vector3(cx + 1.5, p.y + 1.2, cz), new THREE.Vector3(0.3, 2.2, 2.2), 'concrete', { tag: 'ai-in1' });
  g.physics.addBox(new THREE.Vector3(cx, p.y + 1.2, cz + 1.5), new THREE.Vector3(2.2, 2.2, 0.3), 'concrete', { tag: 'ai-in2' });
  g.physics.addBox(new THREE.Vector3(cx, p.y + 1.2, cz - 1.5), new THREE.Vector3(2.2, 2.2, 0.3), 'concrete', { tag: 'ai-in3' });
  let cur = 0, worstStreak = 0, recoveries = 0, lastRecover = e._stuckAt || -99;
  sim(g, 900, () => {
    if (e.stuckT > 0.35) { cur++; worstStreak = Math.max(worstStreak, cur); } else cur = 0;
    if (e._stuckAt > lastRecover) { recoveries++; lastRecover = e._stuckAt; }
  });
  const escaped = Math.hypot(e.pos.x - cx, e.pos.z - cz) > 1.6;
  assert.ok(recoveries > 0 || escaped || worstStreak * DT < 4,
    `longest uninterrupted stuck streak ${(worstStreak * DT).toFixed(1)} s, ${recoveries} recoveries, escaped ${escaped}`);
  retireEnemy(g, e);
});

check('C7. squad spacing: soldiers do not stack inside one another', () => {
  const { g, spot, p } = world(12);
  const squad = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    squad.push(spawnEnemy(g, spot.x + Math.cos(a) * 12, spot.y, spot.z + Math.sin(a) * 12, k % 2 ? 'assault' : 'rifleman'));
  }
  let worstOverlap = -9, minGap = 99;
  sim(g, 720, () => {
    for (let i = 0; i < squad.length; i++) {
      for (let j = i + 1; j < squad.length; j++) {
        const a = squad[i], b = squad[j];
        if (!a.alive || !b.alive) continue;
        const ov = overlapXZ(bodyAt(a.pos, 0.32, 1.78), bodyAt(b.pos, 0.32, 1.78));
        if (ov > worstOverlap) worstOverlap = ov;
        minGap = Math.min(minGap, Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z));
      }
    }
  });
  assert.ok(worstOverlap <= 0.05, `worst body overlap ${worstOverlap.toFixed(2)} m (negative ⇒ always separated)`);
  assert.ok(minGap > 0.55, `closest pair stayed ${minGap.toFixed(2)} m apart while converging on ${minGap === 99 ? 'nobody' : 'the operator'}`);
  void p;
  for (const e of squad) retireEnemy(g, e);
});

check('C8. state transitions do not teleport the body', () => {
  const { g, p } = world();
  const e = placeVisible(g, p, 15, 'rifleman');
  const seen = new Set();
  let jump = 0;
  const prev = e.pos.clone();
  sim(g, 840, () => {
    seen.add(e.state);
    jump = Math.max(jump, Math.hypot(e.pos.x - prev.x, e.pos.z - prev.z));
    prev.copy(e.pos);
  });
  assert.ok(seen.has('combat'), `visited ${[...seen].join('/')}`);
  assert.ok(jump < 0.9, `largest single-frame displacement across transitions ${jump.toFixed(2)} m`);
  retireEnemy(g, e);
});

// ---------------------------------------------------------------------------
// D — the same behaviour in real campaign environments, not only in `facility`
// ---------------------------------------------------------------------------
check('D1. detection and engagement work the same way across campaign operations', () => {
  const picks = [1, 25, 50, 77, 100];
  const report = [];
  let tested = 0, failures = [];
  for (const n of picks) {
    const def = MISSION_DEFS[MISSION_ORDER[n - 1]];
    if (!def) { failures.push(`op${n}: no mission def`); continue; }
    let g, p;
    try {
      const world_ = world(8, def.map);
      g = world_.g; p = world_.p;
    } catch (err) { failures.push(`op${n}: ${err.message}`); continue; }
    let e;
    for (const dist of [18, 12, 8]) {
      try { e = placeVisible(g, p, dist, 'rifleman'); break; } catch { /* try a closer band */ }
    }
    if (!e) { report.push(`op${n} (${def.map}): no clear firing lane, skipped`); continue; }
    tested++;
    const hp0 = g.player.health;
    let at = -1, t = 0;
    const taps = shotTap(g);
    sim(g, 900, () => {
      t += DT;
      if (at < 0 && e.detection >= AI_SENSE.SPOT_THRESHOLD) at = t;
    });
    const ok = at >= 0 && at <= 3.0 && (taps.length >= 1 || g.player.health < hp0);
    report.push(`op${n} (${def.map}): spot ${at < 0 ? 'never' : at.toFixed(1) + 's'}, shots ${taps.length}, hp ${hp0.toFixed(0)}→${g.player.health.toFixed(0)}`);
    if (!ok) failures.push(`op${n} on ${def.map}: ${report[report.length - 1]}`);
    retireEnemy(g, e);
  }
  assert.ok(tested >= 4, `only ${tested}/${picks.length} operations could be measured: ${report.join(' | ')}`);
  assert.equal(failures.length, 0, failures.join('; '));
  return report.join(' | ');
});

check('D2. cover blocks sight in campaign maps too (no shooting through buildings)', () => {
  const picks = [12, 44, 88];
  const notes = [];
  for (const n of picks) {
    const def = MISSION_DEFS[MISSION_ORDER[n - 1]];
    const { g, p } = world(8, def.map);
    const e = placeVisible(g, p, 11, 'rifleman');
    e.windupT = 0; e.detection = 1; e.canSeePlayer = true; e.hasLOS = true;
    e.state = 'combat'; e.combatAction = 'engage';
    assert.ok(wallBetween(g, e.pos, p), `op${n}: wall verified to occlude`);
    const taps = shotTap(g);
    sim(g, 420);
    notes.push(`op${n}: ${taps.length} shots`);
    assert.equal(taps.length, 0, `op${n} on ${def.map}: ${taps.length} shots through a verified wall`);
    retireEnemy(g, e);
  }
  return notes.join(' | ');
});

check('A7. reaction speed is a real difficulty setting, not a label', () => {
  // A stationary target in the open, one rifleman with a verified sight line, per
  // difficulty. What must hold is *ordering*: easier settings notice and shoot
  // later, and no setting leaves the player untouched while a soldier looks at him.
  const firstHit = {};
  for (const key of Object.keys(DIFFICULTIES)) {
    const { g, p } = world();
    g.progress.difficulty = DIFFICULTIES[key];
    g.player.health = 140; g.player.maxHealth = 140; g.player.armor = 100;
    const e = placeVisible(g, p, 20, 'rifleman');
    e.yaw = Math.atan2(-(p.x - e.pos.x), -(p.z - e.pos.z)); e.aimYaw = e.yaw;
    let hit = -1;
    sim(g, 60 * 45, (i) => { if (hit < 0 && g.player.health < 140) hit = i; });
    assert.ok(hit >= 0, `${DIFFICULTIES[key].name}: a soldier with 20 m of clear sight never damaged the player`);
    firstHit[key] = hit / 60;
    retireEnemy(g, e);
  }
  const order = Object.keys(DIFFICULTIES);            // recruit -> veteran
  for (let i = 1; i < order.length; i++) {
    const prev = firstHit[order[i - 1]], cur = firstHit[order[i]];
    assert.ok(cur <= prev + 0.75, `first hit got slower as difficulty rose (${order[i - 1]} ${prev.toFixed(2)}s -> ${order[i]} ${cur.toFixed(2)}s)`);
  }
  assert.ok(firstHit.recruit > firstHit.veteran, `recruit (${firstHit.recruit.toFixed(2)}s) must be slower on the draw than veteran (${firstHit.veteran.toFixed(2)}s)`);
  return order.map((k) => `${k} ${firstHit[k].toFixed(2)}s`).join(' | ');
});

check('B10. enemy fire consumes exactly one round per shot and must reload', () => {
  // Same one-bullet rule the player is held to, on the enemy side: muzzle flash,
  // sound, the hit roll and the tracer must not each debit the magazine.
  const { g, p } = world();
  const e = placeVisible(g, p, 14, 'rifleman');
  e.yaw = Math.atan2(-(p.x - e.pos.x), -(p.z - e.pos.z)); e.aimYaw = e.yaw;
  // A 4-round magazine so the window must also contain a reload, not just shots.
  e.magSize = 4; e.ammo = 4; e.reserveAmmo = 20;
  const startAmmo = e.ammo + e.reserveAmmo;
  let firedPastMagazine = false;
  sim(g, 60 * 45, () => { if (e.ammo < e.magSize && startAmmo - (e.ammo + e.reserveAmmo) > e.magSize) firedPastMagazine = true; });
  const spent = startAmmo - (e.ammo + e.reserveAmmo);
  assert.ok(e.shotsFired > 0, 'the soldier fired during the run');
  assert.equal(spent, e.shotsFired, `${e.shotsFired} shots debited ${spent} rounds from his stores`);
  assert.ok(e.ammo >= 0 && e.reserveAmmo >= 0, `no negative stores (mag ${e.ammo}, reserve ${e.reserveAmmo})`);
  if (firedPastMagazine) assert.ok(e.reloadsCompleted >= 1, 'he emptied a magazine and never reloaded');
  return `${e.shotsFired} shots / ${spent} rounds, ${e.reloadsCompleted} reload(s)`;
});

// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.ok).length;
console.log('\n' + '='.repeat(66));
console.log(`${passed}/${results.length} enemy AI / combat / movement tests passed`);
console.log('='.repeat(66));
if (results.length !== passed) process.exitCode = 1;
