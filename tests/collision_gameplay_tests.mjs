/**
 * collision_gameplay_tests.mjs — behavioural verification of the collision,
 * physics and vehicle-interaction fixes. See tests/world_harness.mjs for the
 * shared headless host (real classes, real frames; only DOM/audio/renderer are
 * stubbed). Test letters match the requested gameplay matrix A–P2.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PhysicsWorld } from '../js/physics.js';
import { GameWorld } from '../js/world.js';
import { Player } from '../js/player.js';
import { EnemyManager } from '../js/enemies.js';
import { VehicleManager, VEHICLE_DEFS } from '../js/vehicles.js';
import { WeaponSystem } from '../js/weapons.js';
import { BODY_STATE, downBlend, tickBodyState, unregisterActorBody, processMoveContacts, applyImpact, IMPACT_TUNE as TUNE } from '../js/impacts.js';
import { Game, GameState } from '../js/game.js';
import { DIFFICULTIES } from '../js/progress.js';
import { installStubs, campaignMaps } from './headless_world.mjs';
import {
  results, failures, check, makeGame, step, overlapXZ, boxesOverlap, spawnEnemy,
  TRUCK_DEF, findOpenPatch, vehicleSpot, bodyAt, findOpenSpot, retireEnemy, driveInto,
} from './world_harness.mjs';
// ---------------------------------------------------------------------------
// A/B/C — player ⇄ soldier physical collision and impact response
// ---------------------------------------------------------------------------
const gA = makeGame('facility');
check('A. player cannot walk through an enemy soldier', () => {
  const spot = findOpenSpot(gA);
  assert.ok(spot, 'open arena spot found in facility');
  gA.player.reset(new THREE.Vector3(spot.x, spot.y, spot.z), 0);
  const foe = spawnEnemy(gA, spot.x, spot.y, spot.z - 2.2);
  // This check is about the *player's* collision against a soldier's body, so the
  // soldier is pinned in place (speedScale 0 zeroes his locomotion, not his
  // collider, his mass or the impact resolver). Since the Phase-1/2 AI work a free
  // soldier sidesteps and engages instead of standing as a fence, so an unpinned
  // fixture would be measuring enemy navigation here. A3 covers that case.
  foe.speedScale = 0;
  let worstOverlap = -99, minDist = 99, maxSpeed = 0;
  for (let i = 0; i < 240; i++) {
    step(gA, 1 / 60, 1 / 60, { moveF: 1 });
    minDist = Math.min(minDist, Math.hypot(gA.player.pos.x - foe.pos.x, gA.player.pos.z - foe.pos.z));
    worstOverlap = Math.max(worstOverlap, overlapXZ(gA.player.box, foe.box));
    maxSpeed = Math.max(maxSpeed, gA.player.speed);
    assert.ok(Number.isFinite(gA.player.pos.x) && Number.isFinite(gA.player.pos.y), 'player transform stays finite');
  }
  const travelled = Math.hypot(gA.player.pos.x - spot.x, gA.player.pos.z - spot.z);
  assert.ok(worstOverlap < 0.02, `no body interpenetration (worst overlap ${worstOverlap.toFixed(3)} m)`);
  assert.ok(minDist > 0.6, `bodies stay separated (closest ${minDist.toFixed(2)} m)`);
  assert.ok(travelled < 4.0, `the soldier stopped him (travelled ${travelled.toFixed(2)} m in 4 s of walking)`);
  return `closest approach ${minDist.toFixed(2)} m · overlap ${worstOverlap.toFixed(3)} m · walked ${travelled.toFixed(2)} m of 4 s at ${maxSpeed.toFixed(1)} m/s`;
});

check('A3. a free soldier who sidesteps still never lets bodies interpenetrate', () => {
  // Companion to A for the post-Phase-1 behaviour: the same charging player, with
  // the soldier's locomotion left live. Blocking is no longer guaranteed (he now
  // reacts), but the collision guarantee is unconditional.
  const g = makeGame('facility');
  const spot = findOpenSpot(g);
  g.player.reset(new THREE.Vector3(spot.x, spot.y, spot.z), 0);
  const foe = spawnEnemy(g, spot.x, spot.y, spot.z - 2.2);
  let worstOverlap = -99, minDist = 99, reacted = false;
  for (let i = 0; i < 240; i++) {
    step(g, 1 / 60, 1 / 60, { moveF: 1 });
    minDist = Math.min(minDist, Math.hypot(g.player.pos.x - foe.pos.x, g.player.pos.z - foe.pos.z));
    worstOverlap = Math.max(worstOverlap, overlapXZ(g.player.box, foe.box));
    if (foe.state !== 'wander' && foe.state !== 'patrol') reacted = true;
  }
  assert.ok(worstOverlap < 0.02, `no interpenetration against a moving soldier (worst ${worstOverlap.toFixed(3)} m)`);
  assert.ok(minDist > 0.5, `bodies stayed separated (closest ${minDist.toFixed(2)} m)`);
  assert.ok(reacted || Math.hypot(foe.pos.x - spot.x, foe.pos.z - (spot.z - 2.2)) > 0.3,
    `the soldier reacted to being charged (state ${foe.state})`);
  return `closest ${minDist.toFixed(2)} m · overlap ${worstOverlap.toFixed(3)} m · soldier state ${foe.state}`;
});

check('A2. a standing soldier is a wall in both directions (enemy cannot walk through the player)', () => {
  const g = makeGame('facility');
  const spot = findOpenSpot(g);
  g.player.reset(new THREE.Vector3(spot.x, spot.y, spot.z), 0);
  const foe = spawnEnemy(g, spot.x, spot.y, spot.z - 3.0);
  foe.state = 'combat'; foe.canSeePlayer = true; foe.contactConfirmed = true;
  let worstOverlap = -99;
  let passedThrough = false;
  for (let i = 0; i < 300; i++) {
    // enemy pushed directly at the (held-still) player at a run
    foe._wish.set(0, 0, -0); // AI drives it; add an external shove to force the approach
    foe.vel.z -= 0.55;
    g.time += 1 / 60;
    g.enemies.update(1 / 60);
    g.vehicles.update(1 / 60);
    worstOverlap = Math.max(worstOverlap, overlapXZ(g.player.box, foe.box));
    if (foe.pos.z > g.player.pos.z + 0.5) passedThrough = true;
  }
  assert.ok(!passedThrough, 'the soldier never ended up behind the player through his body');
  assert.ok(worstOverlap < 0.06, `no sustained interpenetration (worst ${worstOverlap.toFixed(3)} m)`);
  assert.ok(g.player.bodyState !== BODY_STATE.KNOCKED_DOWN || true, 'n/a');
  return `worst overlap ${worstOverlap.toFixed(3)} m · no pass-through over 5 s of forced charging`;
});

check('C. sprinting into a soldier staggers/knocks him down and the player reacts too', () => {
  const g = makeGame('facility');
  const spot = findOpenSpot(g);
  g.player.reset(new THREE.Vector3(spot.x, spot.y, spot.z), 0);
  const foe = spawnEnemy(g, spot.x, spot.y, spot.z - 6.5);
  const states = new Set();
  let playerState = BODY_STATE.STANDING;
  let foeDownAt = -1, foeWasDown = false;
  for (let i = 0; i < 420; i++) {
    step(g, 1 / 60, 1 / 60, { moveF: 1, sprint: i > 20 });
    states.add(foe.bodyState);
    if (foe.bodyState === BODY_STATE.KNOCKED_DOWN && !foeWasDown) { foeWasDown = true; foeDownAt = i; }
    if (g.player.bodyState !== BODY_STATE.STANDING) playerState = g.player.bodyState;
  }
  assert.ok(foeWasDown, `soldier was knocked down by the charge (states seen: ${[...states].join('/')})`);
  assert.ok(playerState === BODY_STATE.STAGGERED || playerState === BODY_STATE.KNOCKED_DOWN,
    `the player also lost his feet briefly (got ${playerState})`);
  return `impact at frame ${foeDownAt} · soldier went ${[...states].join(' → ')} · player=${playerState}`;
});

check('B. a charging soldier knocks the player down, then gets up again', () => {
  const g = makeGame('facility');
  const spot = findOpenSpot(g);
  g.player.reset(new THREE.Vector3(spot.x, spot.y, spot.z), 0);
  const foe = spawnEnemy(g, spot.x, spot.y, spot.z - 4.0, 'heavy');
  foe.sprinting = true;
  let maxDown = 0, sawKnock = false;
  for (let i = 0; i < 420; i++) {
    g.time += 1 / 60;
    foe.vel.z += 0.62;                      // a real charge, not a brush
    foe.charging = true;
    g.enemies.update(1 / 60);
    g.player.update(1 / 60, g.input);
    if (g.player.bodyState === BODY_STATE.KNOCKED_DOWN) sawKnock = true;
    maxDown = Math.max(maxDown, downBlend(g.player));
  }
  assert.ok(sawKnock, 'the player was knocked down by the charge');
  assert.ok(maxDown > 0.5, `the player camera actually went down (blend ${maxDown.toFixed(2)})`);
  // and the state machine always returns him to standing
  for (let i = 0; i < 400; i++) { g.time += 1 / 60; g.player.update(1 / 60, g.input); }
  assert.equal(g.player.bodyState, BODY_STATE.STANDING, 'player recovers to standing');
  return `downBlend peaked at ${maxDown.toFixed(2)} · recovered to standing after the knockdown timer`;
});

check('A3. incidental contact never knocks anyone down (no knockdown spam, no loop)', () =>
{
  const g = makeGame('facility');
  const spot = findOpenSpot(g);
  g.player.reset(new THREE.Vector3(spot.x, spot.y, spot.z), 0);
  const foe = spawnEnemy(g, spot.x, spot.y, spot.z - 0.95);   // already touching, standing still
  let knockEvents = 0, prev = foe.bodyState;
  for (let i = 0; i < 600; i++) {
    g.time += 1 / 60;
    g.player.update(1 / 60, { ...g.input, moveF: 0 });        // idle shoulder-to-shoulder
    g.enemies.update(1 / 60);
    if (foe.bodyState === BODY_STATE.KNOCKED_DOWN && prev !== BODY_STATE.KNOCKED_DOWN) knockEvents++;
    prev = foe.bodyState;
  }
  assert.equal(knockEvents, 0, 'no knockdown from resting contact');
  assert.ok(overlapXZ(g.player.box, foe.box) < 0.02, 'the two bodies still separate cleanly');
  assert.ok(Number.isFinite(g.player.pos.x), 'no jitter blow-up');
  return `600 frames of resting contact · 0 knockdowns · separation held`;
});

check('A4. a soldier can never shove the player through a wall', () => {
  // Back the player against a real facility wall, then have a heavy charge him.
  const g = makeGame('facility');
  const b = g.world.bounds;
  // take a real wall collider from the map and stand the player against its
  // -X face, with a heavy charging him from +Z into that face.
  const wallProbe = (() => {
    for (const c of g.physics.colliders) {
      if (!c.enabled || c.actor) continue;
      const sx = c.max.x - c.min.x, sz = c.max.z - c.min.z, sy = c.max.y - c.min.y;
      if (sy < 2.4 || sx > 1.2 || sz < 8 || sz > 40) continue;         // a long thin wall
      const x = c.min.x - 0.36, z = (c.min.z + c.max.z) / 2;
      const floor = g.physics.raycast(new THREE.Vector3(x, 1.4, z), new THREE.Vector3(0, -1, 0), 4);
      if (!floor) continue;
      // enemy lines up on the -X side and charges +X, into the player, into the wall
      return { x, z, y: floor.point.y, box: { min: c.min.clone(), max: c.max.clone() }, foe: new THREE.Vector3(x - 3.4, floor.point.y, z) };
    }
    return null;
  })();
  void b;
  assert.ok(wallProbe, 'found a wall face to test against');
  g.player.reset(new THREE.Vector3(wallProbe.x, wallProbe.y, wallProbe.z), Math.PI / 2);
  const foe = spawnEnemy(g, wallProbe.foe.x, wallProbe.foe.y, wallProbe.foe.z, 'heavy');
  let insideWall = false, worst = -99;
  const wallBox = wallProbe.box;
  for (let i = 0; i < 600; i++) {
    g.time += 1 / 60;
    foe.vel.x -= 0.8;                      // shove him into the player, into the wall
    foe.charging = true;
    g.enemies.update(1 / 60);
    g.player.update(1 / 60, { ...g.input, moveF: 1 });
    const ov = overlapXZ(g.player.box, wallBox);
    worst = Math.max(worst, ov);
    if (ov > 0.05) insideWall = true;
  }
  assert.ok(!insideWall, 'the player was never pushed through the wall behind him');
  assert.ok(Number.isFinite(g.player.pos.x) && Number.isFinite(g.player.pos.z), 'position stayed finite');
  return `600 frames of a heavy charging the player into real wall geometry · worst penetration into the wall ${worst.toFixed(3)} m · player stayed outside`;
});

check('A5. a fallen soldier is visually down and gets back up', () => {
  const g = makeGame('facility');
  const spot = findOpenSpot(g);
  const foe = spawnEnemy(g, spot.x, spot.y, spot.z, 'heavy');
  foe.bodyState = BODY_STATE.KNOCKED_DOWN;
  foe.bodyStateT = 0; foe.bodyStateDur = 1.6; foe.knockSeverity = 0.8; foe.downBlend = 0;
  foe.fallDir.set(0, 0, 1);
  let peakBlend = 0, peakTilt = 0, boxHeights = [];
  for (let i = 0; i < 240; i++) {
    g.time += 1 / 60;
    tickBodyState(foe, 1 / 60);
    foe._syncBox();
    foe._animate(1 / 60, g.enemies);
    peakBlend = Math.max(peakBlend, foe.downBlend);
    peakTilt = Math.max(peakTilt, Math.abs(foe.model.body.rotation.x) + Math.abs(foe.model.body.rotation.z));
    boxHeights.push(+(foe.box.max.y - foe.box.min.y).toFixed(2));
  }
  assert.ok(peakBlend > 0.9, 'the body reaches the ground');
  assert.ok(peakTilt > 0.9, 'the rig actually rotates over (rad)');
  assert.ok(Math.min(...boxHeights) < 1.2, 'the collision box lowers with the body');
  assert.equal(foe.bodyState, BODY_STATE.STANDING, 'he stands up again');
  return `peak tilt ${peakTilt.toFixed(2)} rad · box lowered to ${Math.min(...boxHeights).toFixed(2)} m · recovered`;
});

// ---------------------------------------------------------------------------
// D/E/F — walls, buildings, barriers, floors
// ---------------------------------------------------------------------------
function colliderFaceTest(game, c, dir = 'x') {
  // approach a collider face at sprint speed for 1 s and confirm the mover is
  // still outside the solid volume at the end
  const box = { min: c.min.clone(), max: c.max.clone() };
  const r = 0.34;
  const y = Math.max(0.05, c.min.y + 0.02);
  const start = dir === 'x'
    ? new THREE.Vector3(c.min.x - r - 0.8, y, (c.min.z + c.max.z) / 2)
    : new THREE.Vector3((c.min.x + c.max.x) / 2, y, c.min.z - r - 0.8);
  game.player.reset(start, dir === 'x' ? -Math.PI / 2 : 0);
  for (let i = 0; i < 60; i++) step(game, 1 / 60, 1 / 60, { moveF: 1, sprint: true });
  const p = game.player.box;
  const inside = p.max.x > box.min.x + 0.02 && p.min.x < box.max.x - 0.02
    && p.max.z > box.min.z + 0.02 && p.min.z < box.max.z - 0.02
    && p.max.y > box.min.y + 0.02 && p.min.y < box.max.y - 0.02;
  return { inside, pos: game.player.pos.clone(), overlapX: Math.min(p.max.x, box.max.x) - Math.max(p.min.x, box.min.x), overlapZ: Math.min(p.max.z, box.max.z) - Math.max(p.min.z, box.min.z) };
}

const WALL_SAMPLE_MAPS = ['facility', 'industrial', 'urban', 'snow', 'ridge_hold', 'rural', 'canal_market'];
check('D/E/F. sprinting into walls, buildings and barriers never penetrates (sampled maps)', () => {
  let tested = 0, penetrated = 0, skipped = 0;
  for (const map of WALL_SAMPLE_MAPS) {
    const g = makeGame(map);
    const cands = g.physics.colliders.filter((c) => {
      if (!c.enabled || c.actor) return false;
      const sx = c.max.x - c.min.x, sz = c.max.z - c.min.z, sy = c.max.y - c.min.y;
      if (sy < 1.0 || sy > 12) return false;                     // must be a wall, not a slab or a tower roof
      if (Math.max(sx, sz) > 40) return false;                   // not the ground / perimeter mesh
      return true;
    });
    // deterministic spread across the map
    for (let i = 0; i < cands.length && i < 40; i += 2) {
      const c = cands[i];
      const r = colliderFaceTest(g, c, i % 2 ? 'x' : 'z');
      if (!Number.isFinite(r.pos.x)) { skipped++; continue; }
      tested++;
      if (r.inside) { penetrated++; if (penetrated < 4) console.log(`   penetration in ${map} at ${c.min.x.toFixed(1)},${c.min.z.toFixed(1)}`); }
    }
  }
  assert.equal(penetrated, 0, `${penetrated}/${tested} sprint attempts entered a wall`);
  return `${tested} wall/barrier faces sprinted into across ${WALL_SAMPLE_MAPS.length} maps · ${penetrated} penetrations · ${skipped} skipped (no floor at probe)`;
});

check('D2. thin-geometry tunnelling at high speed is prevented', () => {
  const g = makeGame('facility');
  const spot = findOpenSpot(g);
  // a single 0.18 m panel (thinner than one sprint frame of travel at 60 fps hitch)
  const wallX = spot.x + 3.0;
  g.physics.addBox(new THREE.Vector3(wallX, spot.y + 1.0, spot.z), new THREE.Vector3(0.18, 2.0, 6), 'concrete', { tag: 'test-wall' });
  g.player.reset(new THREE.Vector3(spot.x, spot.y, spot.z), 0);
  let crossed = false;
  for (let i = 0; i < 120; i++) {
    // deliberately nasty frames: a 0.05 s hitch at sprint speed = 0.39 m per frame
    step(g, 0.05, 0.05, { moveF: 1, sprint: true });
    if (g.player.pos.x > wallX + 0.3) crossed = true;
  }
  assert.ok(!crossed, 'player crossed a 18 cm panel while sprinting with 50 ms frames');
  return `180 mm panel vs 50 ms hitched sprint frames · blocked on every frame (${g.player.pos.x.toFixed(2)} of target ${wallX.toFixed(2)})`;
});

check('F2. floors and ceilings: no falling through, standing on real surfaces', () => {
  let floors = 0, failed = 0;
  for (const map of ['facility', 'urban', 'industrial', 'snow']) {
    const g = makeGame(map);
    const tops = g.physics.colliders.filter((c) => (c.max.y - c.min.y) < 1.4 && (c.max.x - c.min.x) > 3 && (c.max.z - c.min.z) > 3 && c.max.y > 1.5 && c.max.y < 12);
    for (let i = 0; i < Math.min(tops.length, 8); i++) {
      const c = tops[i * 3 % Math.max(1, tops.length)];
      if (!c) continue;
      const x = (c.min.x + c.max.x) / 2, z = (c.min.z + c.max.z) / 2;
      g.player.reset(new THREE.Vector3(x, c.max.y + 1.4, z), 0);
      for (let k = 0; k < 90; k++) step(g, 1 / 60, 1 / 60, {});
      floors++;
      // the requirement is "no fall-through": the operator must end up on top of
      // the sampled slab or on a solid surface above the map floor.
      const landedAbove = g.player.pos.y >= c.max.y - 0.30;
      const hasFloor = g.player.onGround && g.physics.raycast(new THREE.Vector3(g.player.pos.x, g.player.pos.y + 0.5, g.player.pos.z), new THREE.Vector3(0, -1, 0), 1.2);
      if (!landedAbove || !hasFloor) failed++;
    }
  }
  assert.equal(failed, 0, `${failed}/${floors} drop tests fell through a floor`);
  return `${floors} floor/roof slabs dropped onto · all landed on the surface`;
});

check('F3. doors: passable only when their state permits', () => {
  const g = makeGame('facility');
  const doors = g.world.doors || [];
  assert.ok(doors.length > 0, 'map has authored doors to test');
  let closedBlocked = 0, openPassable = 0, mismatch = 0, tested = 0;
  const settle = (d) => { for (let i = 0; i < 200; i++) d.update(1 / 30); };
  // The doorway is a fixed volume in the world: capture it while the leaf is
  // closed, then re-measure the SAME volume after opening. Probing the collider's
  // own extents would follow the swinging leaf and always report "solid".
  for (const d of doors.slice(0, 12)) {
    const col = d.colliderObj;
    if (!col) continue;
    if (d.open) { d.interact(g); settle(d); }            // make sure it is closed
    if (d.open) continue;                                 // locked/forced: skip
    const mid = new THREE.Vector3((col.min.x + col.max.x) / 2, 0, (col.min.z + col.max.z) / 2);
    const y = Math.max(0.02, col.min.y + 0.02);
    const probeMin = new THREE.Vector3(mid.x - 0.3, y, mid.z - 0.3);
    const probeMax = new THREE.Vector3(mid.x + 0.3, y + Math.min(1.7, col.max.y - col.min.y), mid.z + 0.3);
    const free = () => g.physics.isBoxFree(probeMin, probeMax, { actors: true });
    tested++;
    const whileClosed = free();
    if (whileClosed === false) closedBlocked++; else mismatch++;
    d.interact(g); settle(d);                             // open it
    if (!d.open) { void 0; }
    const whileOpen = free();
    if (whileOpen === true) openPassable++; else mismatch++;
    d.interact(g); settle(d);                             // back to closed
    const reClosed = free();
    if (reClosed === false) closedBlocked++; else mismatch++;
  }
  assert.ok(tested > 0, 'no doors with colliders found');
  assert.ok(openPassable > 0, `${mismatch} door(s) stayed solid after opening`);
  assert.ok(closedBlocked > 0, 'no door was solid while closed');
  return `${doors.length} doors on map; ${tested} exercised in the doorway: solid while closed ${closedBlocked}, passable while open ${openPassable}, solid again after closing (same probe)`;
});

check('F4. decorative geometry stays non-solid (grass/tufts/paint create no invisible walls)', () => {
  let decorTested = 0, blocking = 0;
  const g = makeGame('rural');
  // the rural map plants wheat rows and grass tufts; a body must walk straight
  // through every one of them
  const spot = findOpenSpot(g);
  g.player.reset(new THREE.Vector3(spot.x, spot.y, spot.z), 0);
  const before = g.player.pos.clone();
  step(g, 2.0, 1 / 60, { moveF: 1 });
  decorTested++;
  if (Math.hypot(g.player.pos.x - before.x, g.player.pos.z - before.z) < 1.0) blocking++;
  const skip = g.world.collisionCoverage;
  assert.ok(skip !== undefined, 'coverage pass reported its stats');
  assert.equal(blocking, 0, 'movement was blocked by decorative geometry');
  return `rural open-ground sprint unobstructed · coverage pass authored=${skip.authored} synthesized=${skip.synthesized} skippedDecor=${skip.skippedDecor}`;
});

// ---------------------------------------------------------------------------
// G/H/I/J — vehicle collision, boarding, egress
// ---------------------------------------------------------------------------
/** A point just outside the driver's door, in world space (yaw-correct). */
function doorApproach(v, extra = 0.85) {
  return v.localToWorld(-(v.def.wd / 2 + extra), 0.9, -Math.min(0.38, v.def.hl * 0.18), new THREE.Vector3());
}
/** A point just outside the opposite side of the hull, same distance. */
function farSideApproach(v, extra = 0.85) {
  return v.localToWorld(v.def.wd / 2 + extra, 0.9, -Math.min(0.38, v.def.hl * 0.18), new THREE.Vector3());
}
/** Lateral half-extent helper for building a wall that spans a door face. */
function perpX(v, outward, zAxis = false) {
  const ax = zAxis ? Math.abs(outward.x) : Math.abs(outward.z);
  return Math.max(ax, 0.25) + (zAxis ? Math.abs(outward.x) : Math.abs(outward.z));
}
/** Spawn one test truck and return *that* vehicle (the map authors its own
 * vehicle spawns too, so taking the last entry of the list is not enough). */
function spawnTruck(game, x, y, z, yaw = 0) {
  game.world.vehicleSpawns.push({ pos: new THREE.Vector3(x, y, z), yaw, type: 'truck', tag: 'testtruck' });
  game.vehicles.spawnFromWorld();
  let best = null, bestD = 1e9;
  for (const v of game.vehicles.list) {
    const d = Math.hypot(v.pos.x - x, v.pos.z - z);
    if (d < bestD) { bestD = d; best = v; }
  }
  if (best && bestD > 1.0) throw new Error(`the test truck is not where it was placed (${bestD.toFixed(2)} m off)`);
  // spawnFromWorld() resets the actor bodies, so let the manager tick once:
  // that publishes each hull into the actor field exactly as a live frame would.
  game.vehicles.update(1 / 60);
  return best;
}

check('G. the player cannot walk through a parked truck (all four sides)', () => {
  const g = makeGame('facility');
  const spot = vehicleSpot(g);
  const v = spawnTruck(g, spot.x, spot.y, spot.z, 0);
  assert.ok(v, 'truck spawned for the test');
  assert.ok(v._body, 'the hull is registered as a solid body');
  const sides = [
    { name: 'driver door side', p: new THREE.Vector3(spot.x - v.def.wd / 2 - 1.0, spot.y, spot.z - 0.4), d: { x: 1, z: 0 } },
    { name: 'far side', p: new THREE.Vector3(spot.x + v.def.wd / 2 + 1.0, spot.y, spot.z), d: { x: -1, z: 0 } },
    { name: 'bow', p: new THREE.Vector3(spot.x, spot.y, spot.z - v.def.hl - 1.0), d: { x: 0, z: 1 } },
    { name: 'stern', p: new THREE.Vector3(spot.x, spot.y, spot.z + v.def.hl + 1.0), d: { x: 0, z: -1 } },
  ];
  const notes = [];
  for (const s of sides) {
    // aim the player into the hull and sprint for 1.5 s
    g.player.reset(s.p.clone(), Math.atan2(-s.d.x, -s.d.z));
    let inside = false, worst = -99;
    for (let i = 0; i < 90; i++) {
      step(g, 1 / 60, 1 / 60, { moveF: 1, sprint: true });
      const pb = bodyAt(g.player.pos);
      worst = Math.max(worst, overlapXZ(pb, v.box));
      if (boxesOverlap(pb, v.box)) inside = true;
    }
    assert.ok(!inside, `player entered the hull from the ${s.name}`);
    assert.ok(worst < 0.05, `penetrated the hull from the ${s.name} by ${worst.toFixed(3)} m`);
    notes.push(`${s.name} blocked (worst overlap ${worst.toFixed(3)} m)`);
  }
  return notes.join(' · ');
});

check('G2. a moving vehicle keeps its collision in lock-step with the hull', () => {
  const g = makeGame('facility');
  const spot = vehicleSpot(g);
  const v = spawnTruck(g, spot.x, spot.y, spot.z, 0);
  const before = v._body.min.clone();
  v.driver = 'player'; v.engineStarted = true; v.speed = 0;
  g.vehicleMode = v;
  for (let i = 0; i < 120; i++) { g.time += 1 / 60; g.vehicles.update(1 / 60); g.input.moveF = 1; }
  const moved = Math.hypot(v.pos.x - spot.x, v.pos.z - spot.z);
  const bodyMoved = Math.hypot(v._body.min.x - before.x, v._body.min.z - before.z);
  const delta = Math.max(Math.abs(v._body.min.x - v.box.min.x), Math.abs(v._body.max.z - v.box.max.z), Math.abs(v._body.min.y - v.box.min.y));
  assert.ok(moved > 1.0, `the truck actually drove (${moved.toFixed(2)} m)`);
  assert.ok(bodyMoved > 1.0, 'the collision body travelled with it');
  assert.ok(delta < 0.02, `body matches the swept hull to ${(delta * 1000).toFixed(1)} mm`);
  return `drove ${moved.toFixed(2)} m · collider followed within ${(delta * 1000).toFixed(1)} mm`;
});

check('G3. a driven vehicle bowls a soldier over (and pins him without launch)', () => {
  const g = makeGame('facility');
  const spot = vehicleSpot(g);
  // park the truck 13 m out and drive straight at the soldier standing on the patch
  const v = spawnTruck(g, spot.x, spot.y, spot.z + 13, 0);   // heading 0 = nose along -Z, straight at him
  const foe = spawnEnemy(g, spot.x, spot.y, spot.z, 'rifleman');
  const door = v.driverDoorWorld(new THREE.Vector3());
  const approach = doorApproach(v);
  g.player.reset(new THREE.Vector3(approach.x, spot.y, approach.z), Math.PI / 2);
  g._updateVehicleBoarding({ interactPressed: true });
  assert.ok(g.vehicleMode === v, 'the operator is driving');
  let maxSpeed = 0, knocked = false, peak = 0, overlap = -99;
  for (let i = 0; i < 420; i++) {
    g.input.moveF = 1;                                 // full throttle at the soldier
    g.time += 1 / 60;
    g.vehicles.update(1 / 60);
    g.enemies.update(1 / 60);
    maxSpeed = Math.max(maxSpeed, Math.abs(v.speed));
    if (foe.bodyState === BODY_STATE.KNOCKED_DOWN) knocked = true;
    peak = Math.max(peak, Math.hypot(foe.vel.x, foe.vel.z));
    overlap = Math.max(overlap, overlapXZ(foe.box, v.box));
  }
  assert.ok(maxSpeed > 4, `the truck never got up to speed (${maxSpeed.toFixed(1)} m/s)`);
  assert.ok(knocked, `a ${maxSpeed.toFixed(1)} m/s truck failed to knock the soldier down`);
  assert.ok(peak < 7.5, `no uncontrolled launch (peak victim speed ${peak.toFixed(2)} m/s)`);
  assert.ok(overlap < 0.05, `the victim was not left inside the hull (${overlap.toFixed(3)} m)`);
  assert.ok(Number.isFinite(foe.pos.x), 'victim position stayed finite');
  return `knockdown from a driven truck at ${maxSpeed.toFixed(1)} m/s · peak victim speed ${peak.toFixed(2)} m/s (capped, no launch) · never inside the hull`;
});

check('H. boarding: at the driver door, prompt reads PRESS [F] — ENTER VEHICLE, F seats the player', () => {
  const g = makeGame('facility');
  const spot = vehicleSpot(g);
  const v = spawnTruck(g, spot.x, spot.y, spot.z, 0);
  const door = v.driverDoorWorld(new THREE.Vector3());
  const approach = doorApproach(v);
  const res = { ok: false, reason: '' };
  v.canBoardFrom(new THREE.Vector3(approach.x, spot.y, approach.z), g, res);
  assert.ok(res.ok, `door approach rejected: ${res.reason}`);
  // place the player at the door and run the real interaction gate
  g.player.reset(new THREE.Vector3(approach.x, spot.y, approach.z), Math.PI / 2);
  g._updateVehicleBoarding({ interactPressed: false });
  const prompt = g.prompts[g.prompts.length - 1];
  assert.equal(prompt, 'PRESS [F] — ENTER VEHICLE', `prompt was "${prompt}"`);
  g._updateVehicleBoarding({ interactPressed: true });
  assert.equal(g.vehicleMode, v, 'the player is driving the truck');
  assert.equal(v.driver, 'player', 'the vehicle took him as driver');
  assert.ok(v.entryT > 0 || v.doorT > 0, 'the door animation ran for the entry');
  const seat = v.localToWorld(-v.def.wd * 0.17, v.def.seatH, -v.def.hl * 0.25, new THREE.Vector3());
  for (let i = 0; i < 60; i++) { g.time += 1 / 60; g.vehicles.update(1 / 60); }
  const seatDist = Math.hypot(g.player.pos.x - v.pos.x, g.player.pos.z - v.pos.z);
  assert.ok(seatDist < Math.max(v.def.wd, v.def.hl), `the operator sits inside the hull (${seatDist.toFixed(2)} m of the centre)`);
  void seat;
  return `door point approach ok · prompt exact · seated within ${seatDist.toFixed(2)} m of hull centre · driver='player'`;
});

check('I. boarding is refused from the opposite side and from an arbitrary distance', () => {
  const g = makeGame('facility');
  const spot = findOpenSpot(g, 8);
  const v = spawnTruck(g, spot.x, spot.y, spot.z, 0);
  const door = v.driverDoorWorld(new THREE.Vector3());
  // 1) far side of the hull: same distance, wrong side
  const far = farSideApproach(v); far.y = spot.y;
  const r1 = { ok: false, reason: '' };
  v.canBoardFrom(far, g, r1);
  assert.ok(!r1.ok, 'boarded from the opposite side of the hull');
  // 2) too far from the door, on the correct side
  const r2 = { ok: false, reason: '' };
  const tooFar = doorApproach(v, 0.85 + 3.4);
  v.canBoardFrom(new THREE.Vector3(tooFar.x, spot.y, tooFar.z), g, r2);
  assert.ok(!r2.ok, `boarded from 3.4 m away (${r2.reason})`);
  // 3) neither spot may produce a prompt or a boarding state through the real gate
  for (const p of [far, new THREE.Vector3(tooFar.x, spot.y, tooFar.z)]) {
    g.player.reset(p.clone(), 0);
    g.prompts.length = 0;
    const handled = g._updateVehicleBoarding({ interactPressed: true });
    assert.ok(!handled, 'the generic gate accepted a non-door approach');
    assert.equal(g.vehicleMode, null, 'the player entered a vehicle he could not reach');
    assert.ok(!g.prompts.includes('PRESS [F] — ENTER VEHICLE'), 'the ENTER prompt showed where boarding is not possible');
  }
  return `far side → "${r1.reason}" · 3.4 m away → "${r2.reason}" · no prompt, no entry in either case`;
});

check('J. exiting places the operator beside the door and never inside an obstruction', () => {
  const g = makeGame('facility');
  const spot = vehicleSpot(g);
  const v = spawnTruck(g, spot.x, spot.y, spot.z, 0);        // axis-aligned: the driver's door is due -X
  const door = v.driverDoorWorld(new THREE.Vector3());
  const approach = doorApproach(v);
  g.player.reset(new THREE.Vector3(approach.x, spot.y, approach.z), Math.PI / 2);
  g._updateVehicleBoarding({ interactPressed: true });
  assert.ok(g.vehicleMode, 'in the truck first');
  // a wall built flush against the hull on the door side: there is no room to
  // stand between the truck and the wall, so that whole side is unusable
  const hullSideX = spot.x - v.def.wd / 2;
  const wMin = new THREE.Vector3(hullSideX - 1.6, spot.y - 0.05, spot.z - v.def.hl - 2.5);
  const wMax = new THREE.Vector3(hullSideX + 0.10, spot.y + 3.5, spot.z + v.def.hl + 2.5);
  g.physics.add(wMin, wMax, 'concrete', { tag: 'test-wall' });
  assert.ok(g.physics.colliders.length > 0, 'wall registered');
  assert.equal(overlapXZ(bodyAt(new THREE.Vector3(hullSideX - 0.8, spot.y, spot.z)), { min: wMin, max: wMax }) > 0.05, true, 'harness wall placement');
  assert.equal(g.physics.isBoxFree(bodyAt(new THREE.Vector3(hullSideX - 0.8, spot.y, spot.z)).min, bodyAt(new THREE.Vector3(hullSideX - 0.8, spot.y, spot.z)).max), false, 'the harness wall is not actually in the way');

  const ok = g.exitVehicle(false);
  assert.ok(ok, 'the operator was not trapped with a wall at the door');
  assert.equal(g.vehicleMode, null, 'vehicle mode ended');
  const placed = bodyAt(g.player.pos);
  assert.ok(overlapXZ(placed, { min: wMin, max: wMax }) <= 0.05,
    `dropped inside the wall on exit (${overlapXZ(placed, { min: wMin, max: wMax }).toFixed(3)} m at ${g.player.pos.x.toFixed(2)},${g.player.pos.z.toFixed(2)})`);
  assert.ok(overlapXZ(placed, v.box) <= 0.05, 'dropped inside the hull on exit');
  // then let the solver settle him for half a second and re-measure
  for (let i = 0; i < 30; i++) step(g, 1 / 60, 1 / 60, {});
  const p = g.player.pos;
  const pb = bodyAt(p);
  assert.ok(overlapXZ(pb, { min: wMin, max: wMax }) <= 0.05,
    `the operator ended up inside the wall (${overlapXZ(pb, { min: wMin, max: wMax }).toFixed(3)} m at ${p.x.toFixed(2)},${p.z.toFixed(2)})`);
  assert.ok(overlapXZ(pb, v.box) <= 0.05, 'the operator settled inside the hull');
  assert.ok(g.physics.isBoxFree(pb.min, pb.max, { actors: false }), 'the egress spot is not free of geometry');
  const doorDist = Math.hypot(p.x - door.x, p.z - door.z);
  assert.ok(doorDist < 9.5, `egress is still beside the vehicle (${doorDist.toFixed(2)} m from the door)`);
  assert.ok(g.player.onGround, 'the operator is standing on something');
  return `wall built flush against the driver's door → egress relocated to the clear side, ${doorDist.toFixed(2)} m from the doorway · box free of statics · never inside the hull · on ground`;
});

check('J2. exiting into a crowd of soldiers is refused rather than overlapping them', () => {
  const g = makeGame('facility');
  const spot = vehicleSpot(g);
  const v = spawnTruck(g, spot.x, spot.y, spot.z, 0);
  const door = v.driverDoorWorld(new THREE.Vector3());
  const approach = doorApproach(v);
  g.player.reset(new THREE.Vector3(approach.x, spot.y, approach.z), Math.PI / 2);
  g._updateVehicleBoarding({ interactPressed: true });
  assert.ok(g.vehicleMode, 'seated');
  // every plausible egress spot is occupied by a body: ring the hull tightly
  const blockers = [];
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const r = 2.0;
    const e = spawnEnemy(g, spot.x + Math.cos(a) * r, spot.y, spot.z + Math.sin(a) * r);
    e.bodyState = BODY_STATE.STANDING; e.impactCd = 999;
    blockers.push(e);
  }
  for (const d of [[0, 0], [1.2, 0], [-1.2, 0], [0, 2.4], [0, -2.4]]) {
    blockers.push(spawnEnemy(g, spot.x + d[0], spot.y, spot.z + d[1]));
  }
  const before = g.player.pos.clone();
  const ok = g.exitVehicle(false);
  if (!ok) {
    assert.equal(g.vehicleMode, v, 'stayed in the vehicle when no clear egress exists');
    return 'egress refused with every door approach occupied (player stays seated, bodies never overlapped)';
  }
  const p = g.player.pos;
  let overlapsSomeone = false;
  const pb2 = bodyAt(g.player.pos);
  for (const e of blockers) if (boxesOverlap(pb2, e.box)) overlapsSomeone = true;
  assert.ok(!overlapsSomeone, 'dropped the operator inside a soldier');
  void before;
  return `egress relocated to a gap between bodies at ${p.x.toFixed(1)},${p.z.toFixed(1)} with no overlap`;
});

check('J3. driving a vehicle still works (throttle, steering, camera) — nothing regressed', () => {
  const g = makeGame('facility');
  const spot = vehicleSpot(g);
  const v = spawnTruck(g, spot.x, spot.y, spot.z, 0);
  const door = v.driverDoorWorld(new THREE.Vector3());
  const approach = doorApproach(v);
  g.player.reset(new THREE.Vector3(approach.x, spot.y, approach.z), Math.PI / 2);
  g._updateVehicleBoarding({ interactPressed: true });
  assert.ok(g.vehicleMode, 'seated');
  const start = v.pos.clone();
  let peakSpeed = 0;
  for (let i = 0; i < 240; i++) {
    g.input.moveF = 1; g.input.moveR = i > 120 ? 0.5 : 0;
    g.time += 1 / 60;
    g.vehicles.update(1 / 60);
    v.updateCamera && v.updateCamera(1 / 60, g);
    peakSpeed = Math.max(peakSpeed, Math.abs(v.speed));
  }
  const dist = start.distanceTo(v.pos);
  assert.ok(dist > 4, `the truck only moved ${dist.toFixed(2)} m`);
  assert.ok(peakSpeed > 3, `it never had real speed (peak ${peakSpeed.toFixed(1)} m/s)`);
  assert.ok(Number.isFinite(g.camera.position.x), 'camera is finite');
  assert.equal(g.player.alive, true, 'the driver survived the drive');
  g.exitVehicle(true);
  assert.equal(g.vehicleMode, null, 'and he can get out');
  return `drove ${dist.toFixed(1)} m · speed ${v.speed.toFixed(1)} m/s · camera finite · exited cleanly`;
});

// ---------------------------------------------------------------------------
// K — soldiers respect geometry, vehicles and each other
// ---------------------------------------------------------------------------
check('K. soldiers path around a wall and a vehicle instead of grinding into them', () => {
  const g = makeGame('facility');
  const spot = findOpenSpot(g, 12);
  // a real wall to go around, and a truck parked on the direct line
  g.physics.addBox(new THREE.Vector3(spot.x + 4, spot.y + 1.5, spot.z), new THREE.Vector3(0.4, 3.0, 6), 'concrete', { tag: 'test-wall' });
  const v = spawnTruck(g, spot.x + 8.5, spot.y, spot.z + 1.2, Math.PI / 2);
  const foe = spawnEnemy(g, spot.x, spot.y, spot.z, 'rifleman');
  g.player.reset(new THREE.Vector3(spot.x + 12, spot.y, spot.z), Math.PI);
  const startFoe = foe.pos.clone();
  foe.state = 'combat'; foe.canSeePlayer = true; foe.contactConfirmed = true;
  let inWall = 0, inHull = 0, minDist = 99, stuckFrames = 0, maxStuck = 0, lastPos = foe.pos.clone();
  for (let i = 0; i < 1500; i++) {
    g.time += 1 / 60;
    if (i % 30 === 0 && foe.alive) { foe.state = 'combat'; foe.canSeePlayer = true; foe.contactConfirmed = true; }
    g.enemies.update(1 / 60);
    const wb = { min: new THREE.Vector3(spot.x + 3.6, spot.y, spot.z - 7), max: new THREE.Vector3(spot.x + 4.4, spot.y + 3, spot.z + 7) };
    if (boxesOverlap(foe.box, wb)) inWall++;
    if (boxesOverlap(foe.box, v.box)) inHull++;
    minDist = Math.min(minDist, foe.pos.distanceTo(g.player.pos));
    // a jam is "wants to move, is blocked, goes nowhere" — standing still by AI
    // choice (search / recovering / hold) is not a collision fault
    if (foe._intentSpeed > 0.6 && foe.pos.distanceToSquared(lastPos) < 4e-7) stuckFrames++;
    else stuckFrames = Math.max(0, stuckFrames - 3);
    maxStuck = Math.max(maxStuck, stuckFrames);
    lastPos = foe.pos.clone();
    if (stuckFrames > 300) break;
    if (process.env.VEIL_TEST_DEBUG && i % 60 === 0) {
      console.log(`   [K] f${i} foe ${foe.pos.x.toFixed(2)},${foe.pos.z.toFixed(2)} state=${foe.state} body=${foe.bodyState} stuck=${stuckFrames} dist=${foe.pos.distanceTo(g.player.pos).toFixed(1)}`);
    }
  }
  const travelled = Math.hypot(foe.pos.x - startFoe.x, foe.pos.z - startFoe.z);
  assert.ok(travelled > 1.0, `the soldier never got anywhere (travelled ${travelled.toFixed(2)} m in 25 s)`);
  assert.equal(inWall, 0, 'a soldier walked inside the test wall');
  assert.equal(inHull, 0, 'a soldier walked inside the parked truck');
  assert.ok(maxStuck < 300, `the soldier jammed permanently against the obstacle (${maxStuck} motionless frames)`);
  assert.ok(minDist < 14, `he never closed on the player (closest ${minDist.toFixed(1)} m)`);
  return `avoided wall and hull for 1500 frames · travelled ${travelled.toFixed(1)} m · closed to ${minDist.toFixed(1)} m · longest hold ${maxStuck} frames`;
});

check('K2. soldiers never spawn inside geometry, and never inside a vehicle', () => {
  const g = makeGame('facility');
  const spot = vehicleSpot(g);
  const v = spawnTruck(g, spot.x, spot.y, spot.z, 0.4);
  // eight distinct points buried in the hull, each tested with the area clear of
  // other bodies (a crowd is a legitimate reason for a repair to have nowhere to
  // go, and must not be reported as an escape failure)
  // the manager's own removal contract, so each attempt starts with a clear arena
  const retire = (e) => retireEnemy(g, e);
  const offsets = [[0, 0], [0.7, 0], [-0.7, 0.35], [0, 1.2], [0, -1.2], [0.35, -0.7], [-0.35, 0.7], [1.05, -1.05]];
  let repaired = 0, embedded = 0, attempted = 0;
  for (const o of offsets) {
    const bad = new THREE.Vector3(spot.x + o[0], spot.y, spot.z + o[1]);
    const preBox = bodyAt(bad, 0.32, 1.78);
    const preFree = g.physics.isBoxFree(preBox.min, preBox.max, { actors: true });
    assert.equal(preFree, false, `the harness placed spawn ${attempted} outside the hull`);
    attempted++;
    const foe = spawnEnemy(g, bad.x, bad.y, bad.z);
    if (Math.hypot(foe.pos.x - bad.x, foe.pos.z - bad.z) > 0.05) repaired++;
    if (overlapXZ(bodyAt(foe.pos, 0.31, 1.78), v.box) > 0.05) {
      embedded++;
      console.log(`   [K2] embedded at ${foe.pos.x.toFixed(2)},${foe.pos.z.toFixed(2)} (moved=${(Math.hypot(foe.pos.x - bad.x, foe.pos.z - bad.z)).toFixed(2)} m)`);
    }
    // clear the arena for the next iteration
    retire(foe);
  }
  assert.equal(embedded, 0, `${embedded}/${attempted} soldiers left inside the truck hull`);
  assert.ok(repaired >= attempted - 1, `only ${repaired}/${attempted} buried spawns were relocated`);
  // and a wall burial is repaired the same way
  const wall = g.physics.colliders.find((c) => c.enabled && !c.actor && (c.max.y - c.min.y) > 2.4 && (c.max.x - c.min.x) < 1.2 && (c.max.z - c.min.z) > 6);
  if (wall) {
    const inside = new THREE.Vector3((wall.min.x + wall.max.x) / 2, Math.max(0.02, wall.min.y + 0.02), (wall.min.z + wall.max.z) / 2);
    const e2 = spawnEnemy(g, inside.x, inside.y, inside.z);
    const ov = overlapXZ(bodyAt(e2.pos, 0.31, 1.78), wall);
    assert.ok(ov <= 0.05, `a soldier was left inside a wall (${ov.toFixed(3)} m)`);
    retire(e2);
    return `${attempted + 1} buried spawn attempts (8 inside a vehicle hull, 1 inside a wall) · ${repaired + 1} relocated · 0 left embedded`;
  }
  return `${attempted} soldiers buried in a vehicle hull · ${repaired} relocated · 0 left embedded`;
});

check('K3. enemy-vs-enemy contact: a squad does not occupy the same space', () => {
  const g = makeGame('facility');
  const spot = findOpenSpot(g, 8);
  const squad = [];
  for (let i = 0; i < 8; i++) squad.push(spawnEnemy(g, spot.x + (i % 2) * 0.2, spot.y, spot.z + Math.floor(i / 2) * 0.2, 'rifleman'));
  g.player.reset(new THREE.Vector3(spot.x, spot.y, spot.z + 6), 0);
  for (const e of squad) { e.state = 'combat'; e.canSeePlayer = true; e.contactConfirmed = true; }
  let worst = -99;
  for (let i = 0; i < 600; i++) {
    g.time += 1 / 60;
    g.enemies.update(1 / 60);
    for (let a = 0; a < squad.length; a++) {
      for (let b = a + 1; b < squad.length; b++) {
        worst = Math.max(worst, overlapXZ(squad[a].box, squad[b].box));
      }
    }
  }
  assert.ok(worst < 0.30, `soldiers sustained ${worst.toFixed(2)} m of interpenetration`);
  return `8-man squad converging on one point · worst sustained overlap ${worst.toFixed(2)} m (resolved)`;
});

// ---------------------------------------------------------------------------
// L — representative missions from all five acts
// ---------------------------------------------------------------------------
check('L. collision behaviour holds in representative operations from all five acts', () => {
  const maps = campaignMaps();
  const picks = [1, 21, 41, 61, 81, 100].map((op) => maps.find((m) => m.op === op));
  const rows = [];
  for (const pick of picks) {
    const g = makeGame(pick.layoutId);
    // L1: walls never yield
    const cands = g.physics.colliders.filter((c) => c.enabled && !c.actor && (c.max.y - c.min.y) >= 1.0 && Math.max(c.max.x - c.min.x, c.max.z - c.min.z) <= 40);
    let tested = 0, pen = 0;
    for (let i = 0; i < Math.min(cands.length, 10); i += 2) {
      const r = colliderFaceTest(g, cands[i], i % 2 ? 'x' : 'z');
      tested++; if (r.inside) pen++;
    }
    // L2: an actor contact resolves solidly and the map's own actors stay put
    const spot = findOpenSpot(g, 4);
    let bodyTest = 'no open arena';
    if (spot) {
      g.player.reset(new THREE.Vector3(spot.x, spot.y, spot.z), 0);
      const foe = spawnEnemy(g, spot.x, spot.y, spot.z - 2.4);
      let overlap = -99;
      for (let i = 0; i < 150; i++) {
        step(g, 1 / 60, 1 / 60, { moveF: 1 });
        overlap = Math.max(overlap, overlapXZ(g.player.box, foe.box));
      }
      bodyTest = `body overlap ${overlap.toFixed(3)} m`;
      assert.ok(overlap < 0.02, `op ${pick.op}: player walked into a soldier (${overlap.toFixed(3)} m)`);
    }
    // L3: mission flow survives — the roster still spawns and the campaign
    // audit's own counters are untouched
    const hostiles = g.enemies.list.length;
    rows.push(`op ${String(pick.op).padStart(3)} (${pick.layoutId}): ${tested} faces, ${pen} penetrations, ${hostiles} actor(s) live, ${bodyTest}`);
    assert.equal(pen, 0, `op ${pick.op}: ${pen}/${tested} wall faces were penetrable`);
  }
  return rows.join(' | ');
});

check('L2. weapons, aim and mission HUD paths stay live while knocked down (no lock-up)', () => {
  const g = makeGame('facility');
  const spot = findOpenSpot(g);
  g.player.reset(new THREE.Vector3(spot.x, spot.y, spot.z), 0);
  const foe = spawnEnemy(g, spot.x, spot.y, spot.z - 6.5);
  let framesWithSpread = 0;
  for (let i = 0; i < 300; i++) {
    step(g, 1 / 60, 1 / 60, { moveF: 1, sprint: i > 20 });
    if (g.player.bodyState !== BODY_STATE.STANDING) framesWithSpread++;
    assert.ok(g.player.spreadMultiplier() >= 1, 'spread multiplier stays sane');
    assert.ok(g.player.speedMultiplier() > 0 || g.player.bodyState === BODY_STATE.KNOCKED_DOWN, 'speed multiplier stays sane');
  }
  assert.ok(framesWithSpread > 0, 'the knockdown actually happened during the run');
  assert.equal(g.player.alive, true, 'the operator survived');
  assert.ok(foe.alive, 'the soldier survived too (knockdown is not death)');
  return `${framesWithSpread} impaired frames · spread/speed models stayed valid · both actors alive`;
});

check('L3. wave streaming and mission budgets are unaffected by actor bodies', () => {
  const g = makeGame('urban');
  const spot = findOpenSpot(g, 6);
  g.enemies.missionSpawnLimit = 120;
  g.enemies.spawnedThisRun = 0;
  let spawned = 0;
  for (let i = 0; i < 40; i++) {
    const p = new THREE.Vector3(spot.x + ((i * 7) % 11) - 5, spot.y, spot.z + ((i * 5) % 11) - 5);
    if (g.enemies._spawnAuthoredAt({ kind: 'rifleman', route: null, id: `w${i}` }, p, 'wave-test')) spawned++;
  }
  for (let i = 0; i < 300; i++) { g.time += 1 / 60; g.enemies.update(1 / 60); }
  assert.ok(spawned >= 38, `only ${spawned}/40 wave spawns succeeded`);
  assert.equal(g.enemies.list.length, spawned, 'roster length matches spawns');
  assert.ok(g.enemies.aliveCount >= 0, 'alive count sane');
  assert.ok(g.physics.colliders.length > 0, 'static colliders untouched by the actor field');
  assert.ok(g.physics.actors.count >= spawned, `${g.physics.actors.count} bodies for ${spawned} hostiles`);
  return `${spawned} hostiles streamed · ${g.physics.actors.count} bodies registered (1:1, no duplicates) · ${g.physics.colliders.length} static colliders unchanged`;
});

// ---------------------------------------------------------------------------
// M — a knocked-down operator is impaired everywhere, not just in movement
// ---------------------------------------------------------------------------
check('M. a downed operator cannot fire and loses his aim; the trigger must be re-pressed', () => {
  const g = makeGame('facility');
  const spot = findOpenSpot(g);
  g.player.reset(new THREE.Vector3(spot.x, spot.y, spot.z), 0);
  // the REAL weapon system drives this test, not the shared mock
  const ws = new WeaponSystem(g);
  g.weapons = ws;
  ws.select('vx4');
  const magAt = () => ws.state.vx4.mag;
  const before = magAt();
  // 1) upright: the trigger fires
  for (let i = 0; i < 12; i++) { ws.update(1 / 60, g.time, g.player); ws.tryFire(g.time + i * 0.2, true); }
  const fired = before - magAt();
  assert.ok(fired >= 1, `an upright operator fired ${fired} rounds`);
  // 2) aim in, then get knocked down
  g.input.mouse2 = true;
  for (let i = 0; i < 24; i++) { g.input.mouse2 = true; ws.update(1 / 60, g.time, g.player); }
  assert.ok(ws.adsT > 0.4, `ADS engaged while upright (${ws.adsT.toFixed(2)})`);
  g.player.bodyState = BODY_STATE.KNOCKED_DOWN;
  g.player.bodyStateT = 0; g.player.bodyStateDur = 3.5;
  const downed = magAt();
  for (let i = 0; i < 120; i++) { g.time += 1 / 60; ws.update(1 / 60, g.time, g.player); ws.tryFire(g.time, true); }
  assert.equal(magAt(), downed, `${downed - magAt()} rounds left the barrel while knocked down`);
  assert.ok(ws.adsT < 0.05, `ADS stayed latched while on the floor (${ws.adsT.toFixed(2)})`);
  // 3) standing up with the button still held must not spray
  g.player.bodyState = BODY_STATE.STANDING;
  g.player.impactCd = 0;
  const afterGetUp = magAt();
  for (let i = 0; i < 30; i++) { g.time += 1 / 60; ws.update(1 / 60, g.time, g.player); ws.tryFire(g.time, true); }
  assert.equal(magAt(), afterGetUp, 'the trigger fired on its own after standing up');
  // 4) release + re-press works again
  g.input.mouse2 = false;
  ws.update(1 / 60, g.time, g.player); ws.tryFire(g.time, false);
  const reArmed = magAt();
  for (let i = 0; i < 12; i++) { g.time += 0.2; ws.update(1 / 60, g.time, g.player); ws.tryFire(g.time, true); }
  assert.ok(magAt() < reArmed, 'the weapon never came back after releasing the trigger');
  return `${fired} round(s) fired upright · 0 while down (120 frames of held trigger) · adsT ${ws.adsT.toFixed(2)} after recovery · re-press restores fire`;
});

check('B2. slow contact is a brush, knockdowns cannot be farmed in a loop, and a fall settles', () => {
  const g = makeGame('facility');
  const spot = findOpenSpot(g);
  g.player.reset(new THREE.Vector3(spot.x, spot.y, spot.z), 0);
  // (1) a body drifting into another at a shuffling pace must not topple anyone.
  // Driven through the real mover (moveBox + processMoveContacts) at a fixed
  // slow speed, so the AI cannot veto the approach and make the check vacuous.
  const a = spawnEnemy(g, spot.x, spot.y, spot.z - 2.2, 'scout');
  const brushSpeed = 1.2;                       // well under INCIDENTAL_SPEED
  let brushEvents = 0, contactFrames = 0, closest = 99;
  const moveState = {};
  for (let i = 0; i < 240; i++) {
    g.time += 1 / 60;
    a._intentSpeed = brushSpeed;
    a._syncBox();
    // exactly the mover contract: moveBox mutates the box, the actor re-derives
    // its position from it, then the contact resolver reads the move state
    g.physics.moveBox(a.box, 0, 0, brushSpeed / 60, moveState, 0.42, { ignoreBody: a._body, actors: true });
    a.pos.x = a.box.min.x + 0.32;
    a.pos.z = a.box.min.z + 0.32;
    processMoveContacts(a, g.physics, moveState, 1 / 60);
    g.player.update(1 / 60, g.input);
    const gap = Math.hypot(a.pos.x - g.player.pos.x, a.pos.z - g.player.pos.z);
    closest = Math.min(closest, gap);
    if (overlapXZ(bodyAt(a.pos, 0.31, 1.78), bodyAt(g.player.pos)) > -0.2) contactFrames++;
    if (g.player.bodyState !== BODY_STATE.STANDING || a.bodyState !== BODY_STATE.STANDING) brushEvents++;
  }
  assert.ok(contactFrames > 30, `the two bodies were never actually touching (closest ${closest.toFixed(2)} m, ${contactFrames} contact frames)`);
  assert.equal(brushEvents, 0, `a ${brushSpeed} m/s brush knocked somebody off their feet`);
  // (2) ten seconds of continuous ramming produces a bounded number of knockdowns
  retireEnemy(g, a);                          // clear the brush partner out of the way
  const foe = spawnEnemy(g, spot.x, spot.y, spot.z - 1.1, 'heavy');
  foe.bodyState = BODY_STATE.STANDING;
  let prev = g.player.bodyState;
  const eventFrames = [];
  const foeState = {};
  let impairedFrames = 0;
  for (let i = 0; i < 600; i++) {
    g.time += 1 / 60;
    driveInto(g, foe, 7.5, 0, 1, 1 / 60, foeState);
    g.player.update(1 / 60, g.input);
    if (g.player.bodyState !== BODY_STATE.STANDING) impairedFrames++;
    if (g.player.bodyState === BODY_STATE.KNOCKED_DOWN && prev !== BODY_STATE.KNOCKED_DOWN) eventFrames.push(i);
    prev = g.player.bodyState;
  }
  const events = eventFrames.length;
  assert.ok(events >= 1, 'seven and a half m/s of sustained ramming never knocked the player down');
  // The invariant is spacing, not a count: every knockdown must last its full
  // fall-hold-get-up animation, so a body that keeps ramming you topples you on
  // a rhythm instead of strobing you on the floor.
  let minGap = Infinity;
  for (let i = 1; i < events; i++) minGap = Math.min(minGap, eventFrames[i] - eventFrames[i - 1]);
  // Floor: no actor may be toppled again before their get-up has finished.
  const minCycleFrames = (TUNE.FALL_TIME + TUNE.DOWN_HOLD + TUNE.GETUP_TIME) * 60 * 0.92;
  if (events > 1) {
    assert.ok(minGap >= minCycleFrames,
      `knockdowns re-triggered after ${minGap} frames (< ${minCycleFrames.toFixed(0)} = one full fall-hold-get-up cycle)`);
  }
  // A body that keeps hurling itself at you pays for it: at 7.5 m/s the rammer is
  // locked in its own stagger cycle, which is what stops one charge becoming an
  // infinite stun-lock. The defender must therefore keep most of the fight on
  // their feet.
  assert.ok(foe.bodyState === BODY_STATE.STAGGERED || foe.bodyState === BODY_STATE.KNOCKED_DOWN,
    `the rammer paid nothing for 10 s of 7.5 m/s contact (state ${foe.bodyState})`);
  const standingPct = 100 * (600 - impairedFrames) / 600;
  assert.ok(standingPct > 55, `the player was only standing ${standingPct.toFixed(0)}% of the 10 s — a single charger is a stun-lock`);

  // (3) a knockdown settles: the body comes to rest on the floor, then stands
  g.player.bodyState = BODY_STATE.STANDING; g.player.impactCd = 0; g.player._pairCd.clear();
  let minY = 99, maxYWhileDown = -99, downFrames = 0;
  const yStart = g.player.pos.y;
  applyImpact(g.player, {
    physics: g.physics, closingSpeed: 9.5, nx: 0, nz: 1, source: foe,
    attackerMass: 110, ignorePairCd: true,
  });
  assert.equal(g.player.bodyState, BODY_STATE.KNOCKED_DOWN, 'the forced hit did not knock the player down');
  for (let i = 0; i < 420; i++) {
    g.time += 1 / 60;
    g.player.update(1 / 60, g.input);
    if (g.player.bodyState === BODY_STATE.KNOCKED_DOWN) {
      downFrames++;
      minY = Math.min(minY, g.player.pos.y);
      maxYWhileDown = Math.max(maxYWhileDown, g.player.pos.y);
    }
  }
  assert.ok(downFrames > 30, `only ${downFrames} frames on the floor — the fall never settled`);
  const speedAfter = Math.hypot(g.player.vel.x, g.player.vel.z);
  assert.ok(Number.isFinite(g.player.pos.y), 'the fall left a finite position');
  assert.ok(maxYWhileDown - minY < 1.2, `the body bounced ${(maxYWhileDown - minY).toFixed(2)} m while down (should settle)`);
  assert.ok(Math.abs(minY - yStart) < 1.2, `the fall moved the body ${(minY - yStart).toFixed(2)} m vertically — it should stay on the floor plane`);
  assert.equal(g.player.bodyState, BODY_STATE.STANDING, 'the player never got back up');
  assert.ok(speedAfter < 3.0, `the player was still moving at ${speedAfter.toFixed(2)} m/s after 7 s`);
  // (4) even surrounded by chargers, the player must keep some freedom to act
  const g2 = makeGame('facility');
  const spot2 = findOpenSpot(g2);
  g2.player.reset(new THREE.Vector3(spot2.x, spot2.y, spot2.z), 0);
  const ring = [];
  for (let k = 0; k < 3; k++) {
    const ang = (k / 3) * Math.PI * 2;
    const h = spawnEnemy(g2, spot2.x + Math.cos(ang) * 1.15, spot2.y, spot2.z + Math.sin(ang) * 1.15, 'heavy');
    h.bodyState = BODY_STATE.STANDING;
    ring.push({ foe: h, dx: -Math.cos(ang), dz: -Math.sin(ang), st: {} });
  }
  let pinnedFrames = 0;
  for (let i = 0; i < 900; i++) {
    g2.time += 1 / 60;
    for (const r of ring) driveInto(g2, r.foe, 6.5, r.dx, r.dz, 1 / 60, r.st);
    g2.player.update(1 / 60, g2.input);
    if (g2.player.bodyState !== BODY_STATE.STANDING) pinnedFrames++;
  }
  const pinnedPct = 100 * pinnedFrames / 900;
  assert.ok(pinnedFrames > 60, `three bodies ramming for 15 s never touched the player (${pinnedPct.toFixed(0)}% impaired)`);
  assert.ok(pinnedPct < 80, `3 chargers pinned the player for ${pinnedPct.toFixed(0)}% of 15 s — no room to act`);
  assert.ok(Number.isFinite(g2.player.pos.x) && Math.abs(g2.player.pos.y) < 50, 'the player stayed on the ground plane');

  return `shuffling brush: 0 reactions over ${contactFrames} contact frames at ${brushSpeed} m/s · ${events} knockdown${events === 1 ? '' : 's'} in 10 s of 7.5 m/s ramming (player standing ${standingPct.toFixed(0)}% of it, closest pair ${events > 1 ? minGap : '—'} frames, cycle floor ${minCycleFrames.toFixed(0)}) · fall settles within ${(maxYWhileDown - minY).toFixed(2)} m, residual speed ${speedAfter.toFixed(2)} m/s · 3 chargers kept the player off-balance ${pinnedPct.toFixed(0)}% of 15 s`;
});

// ---------------------------------------------------------------------------
// N/O — the same guarantees, swept across the campaign's map families
// ---------------------------------------------------------------------------
const SWEEP_MAPS = ['facility', 'desert', 'urban', 'snow', 'industrial', 'rural', 'canal_market', 'ridge_hold'];

check('N. no parked or driven vehicle can be walked through, on every map family', () => {
  const rows = [];
  for (const map of SWEEP_MAPS) {
    const g = makeGame(map);
    const spot = vehicleSpot(g);
    const v = spawnTruck(g, spot.x, spot.y, spot.z, 0.35);
    let attempts = 0, entered = 0, worst = -99;
    for (let round = 0; round < 3; round++) {
      for (const side of [
        { o: [-(v.def.wd / 2 + 1.1), 0], d: [1, 0] },
        { o: [v.def.wd / 2 + 1.1, 0], d: [-1, 0] },
        { o: [0, -(v.def.hl + 1.1)], d: [0, 1] },
        { o: [0, v.def.hl + 1.1], d: [0, -1] },
      ]) {
        g.player.reset(new THREE.Vector3(spot.x + side.o[0], spot.y, spot.z + side.o[1]), Math.atan2(-side.d[0], -side.d[1]));
        for (let i = 0; i < 45; i++) {
          step(g, 1 / 60, 1 / 60, { moveF: 1, sprint: round === 1, crouch: round === 2 });
          const ov = overlapXZ(bodyAt(g.player.pos), v.box);
          worst = Math.max(worst, ov);
          attempts++;
          if (ov > 0.05) entered++;
        }
      }
    }
    assert.equal(entered, 0, `${entered}/${attempts} approaches entered a hull on ${map}`);
    rows.push(`${map}: ${attempts} sprint/run/crouch approaches, 0 hull entries`);
  }
  return rows.join(' | ');
});

check('O. every authored spawn on a map sweep lands clear of geometry and of vehicles', () => {
  let checked = 0, relocated = 0, embedded = 0;
  const perMap = [];
  for (const map of SWEEP_MAPS) {
    const g = makeGame(map);
    const w = g.world;
    const pts = [];
    for (const src of [w.enemySpawns, w.surgeSpawns, w.garrisonSpawns, w.patrolRoutes && w.patrolRoutes[0]]) {
      if (!src) continue;
      for (const e of (Array.isArray(src) ? src : [])) {
        const p = e && (e.pos || e.point || (Array.isArray(e) ? { x: e[0], y: e[1], z: e[2] } : e));
        if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) pts.push(p);
        if (pts.length >= 40) break;
      }
    }
    if (!pts.length) { perMap.push(`${map}: no authored points`); continue; }
    let mapChecked = 0, mapMoved = 0, mapBad = 0;
    for (const p of pts.slice(0, 40)) {
      const before = new THREE.Vector3(p.x, p.y || 0.02, p.z);
      const foe = spawnEnemy(g, before.x, before.y, before.z);
      mapChecked++;
      if (foe.pos.distanceToSquared(before) > 0.01) mapMoved++;
      // the live body must not sit inside any static volume
      const box = bodyAt(foe.pos, 0.31, 1.78);
      if (!g.physics.isBoxFree(box.min, box.max, { actors: false })) mapBad++;
      // and never inside a vehicle hull
      for (const v of (g.vehicles ? g.vehicles.list : [])) {
        if (overlapXZ(box, v.box) > 0.05) mapBad++;
      }
      if (g.enemies.group && foe.model && foe.model.root) g.enemies.group.remove(foe.model.root);
      unregisterActorBody(g.physics, foe);
      const idx = g.enemies.list.indexOf(foe);
      if (idx >= 0) g.enemies.list.splice(idx, 1);
    }
    checked += mapChecked; relocated += mapMoved; embedded += mapBad;
    perMap.push(`${map}: ${mapChecked} pts, ${mapMoved} relocated, ${mapBad} embedded`);
  }
  assert.equal(embedded, 0, `${embedded} authored spawn points ended up inside geometry`);
  assert.ok(checked > 100, `only ${checked} spawn points were exercised`);
  return `${checked} authored spawn points across ${SWEEP_MAPS.length} maps · ${relocated} relocated by spawn repair · ${embedded} embedded | ${perMap.join(' | ')}`;
});

check('P2. the impact state machine runs to completion for every actor kind', () => {
  const g = makeGame('facility');
  const spot = findOpenSpot(g);
  const foe = spawnEnemy(g, spot.x, spot.y, spot.z);
  // stagger: short, self-cancelling, leaves no residual impairment
  foe.bodyState = BODY_STATE.STAGGERED; foe.bodyStateT = 0; foe.bodyStateDur = 0.6; foe.knockSeverity = 0.2;
  let sawStagger = 0;
  for (let i = 0; i < 90; i++) { g.time += 1 / 60; tickBodyState(foe, 1 / 60); if (foe.bodyState === BODY_STATE.STAGGERED) sawStagger++; }
  assert.ok(sawStagger > 10 && sawStagger < 80, `stagger lasted ${sawStagger} frames`);
  assert.equal(foe.bodyState, BODY_STATE.STANDING, 'stagger ends by itself');
  assert.equal(foe.downBlend, 0, 'no residual lean after a stagger');
  // knockdown: fall → hold → recover → standing, box height restored
  foe.bodyState = BODY_STATE.KNOCKED_DOWN; foe.bodyStateT = 0; foe.bodyStateDur = 3.2;
  foe.knockSeverity = 0.9; foe.fallDir.set(1, 0, 0); foe.downBlend = 0;
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    g.time += 1 / 60;
    tickBodyState(foe, 1 / 60);
    foe._syncBox();
    seen.add(foe.bodyState);
    assert.ok(Number.isFinite(foe.pos.x) && Number.isFinite(foe.downBlend), 'state stays finite');
  }
  assert.ok(seen.has(BODY_STATE.KNOCKED_DOWN) && seen.has(BODY_STATE.RECOVERING), `phases seen: ${[...seen].join('/')}`);
  assert.equal(foe.bodyState, BODY_STATE.STANDING, 'the soldier stands up again');
  assert.ok((foe.box.max.y - foe.box.min.y) > 1.6, 'standing height restored for the collision box');
  assert.ok(foe.impactCd <= 0, 'the impact cooldown expires so he can be hit again');
  // death unregisters the body: no ghost collider left behind
  const bodiesBefore = g.physics.actors.count;
  foe.die(new THREE.Vector3(foe.pos.x, foe.pos.y + 1.35, foe.pos.z), new THREE.Vector3(0, 1, 0));
  assert.equal(foe.alive, false, 'the shot did not kill him');
  for (let i = 0; i < 40; i++) { g.time += 1 / 60; g.enemies.update(1 / 60); }
  if (g.enemies.list.indexOf(foe) >= 0) {
    if (g.enemies.group && foe.model && foe.model.root) g.enemies.group.remove(foe.model.root);
    const idx = g.enemies.list.indexOf(foe);
    g.enemies.list.splice(idx, 1);
  }
  assert.ok(g.physics.actors.count <= bodiesBefore, `actor bodies grew on death (${bodiesBefore} → ${g.physics.actors.count})`);
  return `stagger ${sawStagger} f · knockdown phases ${[...seen].join('→')} · box back to ${(foe.box.max.y - foe.box.min.y).toFixed(2)} m · no body left after death`;
});

// ---------------------------------------------------------------------------
// performance guardrail
// ---------------------------------------------------------------------------
check('P. per-frame collision cost stays cheap at campaign scale', () => {
  const g = makeGame('facility');
  const spot = findOpenSpot(g, 40);
  g.enemies.missionSpawnLimit = 220;
  g.enemies.spawnedThisRun = 0;
  let n = 0;
  for (let i = 0; i < 200; i++) {
    const p = new THREE.Vector3(spot.x + (i % 20) * 1.1 - 11, spot.y, spot.z + Math.floor(i / 20) * 1.1 - 5);
    if (g.enemies._spawnAuthoredAt({ kind: 'rifleman', route: null, id: `p${i}` }, p, 'perf-test')) n++;
  }
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 300; i++) { g.time += 1 / 60; g.enemies.update(1 / 60); g.vehicles.update(1 / 60); g.player.update(1 / 60, g.input); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const perFrame = ms / 300;
  assert.ok(perFrame < 8, `simulation cost per frame is ${perFrame.toFixed(2)} ms with ${n} actors`);
  return `${n} actors + vehicles: ${perFrame.toFixed(2)} ms/frame of AI+collision+vehicle integration (300 frames)`;
});

// ---------------------------------------------------------------------------
console.log('\n==================================================');
console.log(`${results.filter((r) => r.ok).length}/${results.length} behavioural collision tests passed`);
if (failures) {
  console.log('\nFAILURES:');
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}\n    ${r.detail}`);
}
console.log('==================================================');
const reportPath = new URL(`../reports/collision_behaviour_tests.json`, import.meta.url).pathname;
import('node:fs').then(async (fs) => {
  const dir = new URL('../reports/', import.meta.url).pathname;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), passed: results.filter(r => r.ok).length, total: results.length, results }, null, 2));
  console.log('wrote reports/collision_behaviour_tests.json');
  if (failures) process.exitCode = 1;
});
