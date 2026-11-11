/**
 * world_harness.mjs — shared headless host for the gameplay suites.
 *
 * Builds a real PhysicsWorld + GameWorld + Player + EnemyManager +
 * VehicleManager around a mock `game` shell, then lets tests drive real
 * simulated frames. Used by collision_gameplay_tests.mjs,
 * enemy_ai_combat_tests.mjs and ammunition_tests.mjs so every suite measures
 * the same production code path.
 *
 * Original provenance:
 * collision_gameplay_tests.mjs — behavioural verification of the physics,
 * collision and vehicle-interaction fixes.
 *
 * These are not code-existence checks. Every test instantiates the real
 * `PhysicsWorld`, `GameWorld`, `Player`, `Enemy`, `EnemyManager`, `Vehicle` and
 * `VehicleManager`, binds the real `Game.prototype` methods that own boarding
 * and egress, and then *simulates frames*: input is fed to `Player.update()`,
 * soldiers tick through `EnemyManager.update()`, vehicles through
 * `VehicleManager.update()`, and the assertions read the resulting transforms
 * and collision state. That is the same code path a browser runs; the numbers
 * below are measured from the simulation, not asserted from grep.
 *
 * Test letters match the requested gameplay matrix A–L.
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

installStubs();

export const results = [];
export let failures = 0;
export function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
export function check(name, fn) {
  try { record(name, true, fn() || ''); }
  catch (e) {
    if (process.env.VEIL_TEST_DEBUG) console.log('\n--- stack for: ' + name + '\n' + (e && e.stack || e));
    record(name, false, String(e && e.message || e).split('\n')[0]);
  }
}

// ---------------------------------------------------------------------------
// Mock host: the subsystems a Player / Enemy / Vehicle touches per frame.
// ---------------------------------------------------------------------------
/** A mock subsystem: known keys keep their explicit values, anything else the
 * real code asks for resolves to a no-op function. Keeps the harness honest
 * about the properties it cares about without chasing every cosmetic hook. */
export function withNoopFallback(target) {
  return new Proxy(target, {
    get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? deepNoop() : undefined)),
  });
}
/** A callable, indexable no-op: `a.b.c()` works at any depth, so the mock never
 * has to enumerate the cosmetic hooks the real systems reach for. */
let _deep = null;
export function deepNoop() {
  if (_deep) return _deep;
  const fn = function noopFn() { return undefined; };
  _deep = new Proxy(fn, {
    get: (t, k) => {
      if (typeof k === 'symbol') return t[k];
      if (k === 'length' || k === 'name' || k === 'prototype' || k === 'call' || k === 'apply' || k === 'bind') return t[k];
      return _deep;
    },
    apply: () => undefined,
  });
  return _deep;
}
export function makeGame(mapId = 'facility') {
  const physics = new PhysicsWorld();
  const world = new GameWorld();
  const scene = new THREE.Scene();
  world.buildByMap(mapId, scene, physics);
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 220);
  camera.rotation.order = 'YXZ';
  scene.add(camera);

  const noop = () => {};
  const toasts = [];
  const prompts = [];
  const ui = {
    toastBrief: (m) => toasts.push(m),
    toast: (a, b) => toasts.push(`${a}: ${b}`),
    radio: noop, setInteract: (p) => prompts.push(p), setHackProgress: noop,
    playerDamaged: noop, armorFlash: noop, hitMarker: noop, killConfirm: noop,
    showVehicleHUD: noop, hideVehicleHUD: noop, updateVehicleHUD: noop,
    update: noop, promptObjective: noop,
  };
  const audio = withNoopFallback({ ready: true });
  const particles = withNoopFallback({ decals: { spawn: noop }, impact: noop, blood: noop, spark: noop, debris: { spawn: noop }, footDust: noop, muzzle: noop, trail: noop, tracer: noop });
  const weapons = {
    adsT: 0, zoomFactor: 1, easeInOut: (v) => v, rig: { visible: true },
    state: {}, defs: { vx4: { magSize: 30, reserveMax: 300, name: 'VX-4' } },
    currentId: 'vx4',
    def: { handling: 1, id: 'vx4', name: 'VX-4', range: 60, magSize: 30, reserveMax: 300 },
    cancelForEquipment: noop, rebuildOwned: noop, _restoreWeaponVisual: noop,
    state_: 'ready', stateT: 0, stateDur: 0, nextShotAt: 0,
    projectiles: [], reloadEvents: [], models: {},
  };
  const stats = {
    kills: 0, damageTaken: 0, damageDealt: 0, driveDist: 0, usedVehicle: false,
    equipCats: { vehicle: false }, vehicleAbandoned: false, fallRecoveries: 0,
  };
  const game = {
    scene, camera, physics, world, stats, ui, audio, particles,
    time: 0, state: GameState.PLAYING, suppress: 0, shake: 0, handsMode: 'gun', paused: false,
    settings: { sensitivity: 1, aimSens: 0.8, vehSteerSens: 1, shakeScale: 1, vehSteerInvert: false },
    input: {
      moveF: 0, moveR: 0, lookX: 0, lookY: 0, sprint: false, crouch: false,
      leanL: false, leanR: false, jump: false, jumpPressed: false, spaceHeld: false,
      interactPressed: false, interactHeld: false, bandageHeld: false,
      camPressed: false, grenadePressed: false, grenadeBackPressed: false,
      vehicleHover: false, vehicleCollective: 0, mouse0: false, mouse2: false,
    },
    weapons,
    characters: withNoopFallback({ liveSpeedMult: () => 1, onDamaged: noop, update: noop, onShoot: noop, onReload: noop, abilityActive: false, list: [] }),
    shield: withNoopFallback({ heldUnit: null, heldBlocks: () => false, update: noop, interact: noop }),
    touch: null,
    throwables: withNoopFallback({ smokeBlocksLOS: () => false, update: noop, list: [] }),
    missions: { isDriveStepActive: false },
    vehicleMode: null,
    toasts, prompts,
    progress: { difficulty: DIFFICULTIES.standard, difficultyId: 'standard', cleared: new Set(), clearedCount: 100, loadout: {}, weaponMods: {}, best: {} },
    loadout: { has: () => false, count: () => 0, cycle: noop },
    fx: withNoopFallback({ tracer: noop, muzzleFlash: noop, hitSpark: noop }),
    post: withNoopFallback({ setVehicleBlur: noop }),
    damage: withNoopFallback({ popups: { push: noop } }),
    objectives: [],
    noiseMask: 1, onAlarmRaised: noop, onEnemyDowned: noop, onEnemyKilled: noop,
    setActiveFov: noop, setWeaponFOV: noop, applyAimFov: noop, baseFov: 75,
    onWeaponShot: noop, registerHitscan: noop, hitscan: () => ({ hit: false }),
    tracerOpts: null, damageTracer: noop, onHit: noop, showHitMark: noop,
    onHostileSpotted: noop, notify: noop, markObjective: noop, refreshHUD: noop,
    addShake(a) { game.shake = Math.min(1, game.shake + a); },
    _tmpV1: new THREE.Vector3(), _tmpV2: new THREE.Vector3(), _tmpV3: new THREE.Vector3(),
    body: withNoopFallback({
      setThirdPerson: noop, setVisible: noop, update: noop, updateVehicle: noop, snug: noop,
      root: new THREE.Group(), built: false,
    }),
    hackTarget: null, hackProgress: 0, terminalJamT: 0,
  };
  // Any method the real GameState owns that this harness has not modelled
  // explicitly becomes a no-op, so the mock always presents the production
  // object surface. Anything the test needs for real behaviour is bound from
  // Game.prototype below and overrides these.
  for (const k of Object.getOwnPropertyNames(Game.prototype)) {
    if (k in game) continue;
    const v = Game.prototype[k];
    if (typeof v === 'function') game[k] = noop;
  }
  game.player = new Player(game);
  game.enemies = new EnemyManager(game);
  game.vehicles = new VehicleManager(game);
  game.onPlayerDeath = noop;
  // Real noise routing (Game.prototype.emitNoise → EnemyManager.hearNoise) so
  // "gunshots attract nearby enemies" is exercised, not stubbed out.
  game.emitNoise = Game.prototype.emitNoise.bind(game);
  game._worldEvent = noop;
  // The real orchestrator methods — boarding, egress, the door gate, damage
  // routing and impact feedback — are bound from Game.prototype so the tests
  // execute production code rather than a re-implementation.
  for (const m of ['enterVehicle', 'exitVehicle', '_updateVehicleBoarding', 'onBodyImpact', 'applyDamageToPlayer', '_clearVehicleMode']) {
    game[m] = Game.prototype[m].bind(game);
  }
  game.player.reset(world.spawnPoint.clone(), world.spawnYaw || 0);
  return game;
}

export function step(game, seconds, dt = 1 / 60, input = {}) {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) {
    Object.assign(game.input, input);
    game.time += dt;
    if (game.vehicleMode) {
      game.vehicles.update(dt);
      game.enemies.update(dt);
      continue;
    }
    game.player.update(dt, game.input);
    game.enemies.update(dt);
    game.vehicles.update(dt);
    if (game.vehicleMode) game._clearVehicleMode();
  }
}

/** Penetration depth on the horizontal plane: the *minimum* of the two axis
 * overlaps, i.e. how far one box would have to move to separate. Negative means
 * the boxes are apart. Measuring one axis alone reports "overlap" for bodies
 * standing side by side, which is not a penetration. */
export function overlapXZ(a, b) {
  const ox = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  const oz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
  return Math.min(ox, oz);
}
export function boxesOverlap(a, b) {
  return overlapXZ(a, b) > 0 && Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z) > 0
    && Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y) > 0;
}
export function spawnEnemy(game, x, y, z, kind = 'rifleman') {
  const m = game.enemies;
  m.missionSpawnLimit = 4000; m.spawnedThisRun = 0; m.currentMissionId = 'test';
  const ok = m._spawnAuthoredAt({ kind, route: null, id: `t${Math.random()}` }, new THREE.Vector3(x, y, z), 'behaviour-test');
  assert.ok(ok, 'test enemy must spawn');
  return m.list[m.list.length - 1];
}

export const TRUCK_DEF = VEHICLE_DEFS.truck;
/** Open ground wide enough to park a whole hull (vehicles are far bigger than a
 * body, so the body-sized probe above is not enough for vehicle tests). */
export function findOpenPatch(game, halfW, halfL, tries = 6000) {
  const b = game.world.bounds;
  const rng = (() => { let a = 99991; return () => ((a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
  const r = Math.max(halfW, halfL) + 0.6;
  for (let i = 0; i < tries; i++) {
    const x = b.minX + 10 + rng() * (b.maxX - b.minX - 20);
    const z = b.minZ + 10 + rng() * (b.maxZ - b.minZ - 20);
    const hit = game.physics.raycast(new THREE.Vector3(x, 1.5, z), new THREE.Vector3(0, -1, 0), 4.0);
    if (!hit) continue;
    const y = hit.point.y;
    const min = new THREE.Vector3(x - r, y + 0.05, z - r);
    const max = new THREE.Vector3(x + r, y + 2.6, z + r);
    if (!game.physics.isBoxFree(min, max, { actors: true })) continue;
    if (Math.hypot(x - game.player.pos.x, z - game.player.pos.z) < 12) continue;
    return { x, y, z };
  }
  return null;
}
export function vehicleSpot(game, def = TRUCK_DEF) {
  const s = findOpenPatch(game, def.wd * 0.5 + 1.6, def.hl * 0.5 + 1.6);
  assert.ok(s, 'an open patch wide enough for the hull exists on this map');
  return s;
}
/** A box around a position, for measuring clearance without a stale collider. */
export function bodyAt(p, half = 0.34, h = 1.82) {
  return { min: new THREE.Vector3(p.x - half, p.y + 0.03, p.z - half), max: new THREE.Vector3(p.x + half, p.y + h, p.z + half) };
}

// A flat "arena" world for unambiguous contact maths: reuse the real facility
// but place actors in an open cell found by scanning the collision grid.
export function findOpenSpot(game, radius = 2.5, tries = 4000) {
  const b = game.world.bounds;
  const rng = (() => { let a = 12345; return () => ((a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
  for (let i = 0; i < tries; i++) {
    const x = b.minX + 8 + rng() * (b.maxX - b.minX - 16);
    const z = b.minZ + 8 + rng() * (b.maxZ - b.minZ - 16);
    const hit = game.physics.raycast(new THREE.Vector3(x, 1.2, z), new THREE.Vector3(0, -1, 0), 3.0);
    if (!hit) continue;
    const y = hit.point.y;
    const min = new THREE.Vector3(x - 0.4, y + 0.05, z - 0.4);
    const max = new THREE.Vector3(x + 0.4, y + 1.9, z + 0.4);
    if (!game.physics.isBoxFree(min, max, { actors: true })) continue;
    let clear = true;
    for (const d of [[2, 0], [-2, 0], [0, 2], [0, -2], [1.5, 1.5], [-1.5, -1.5]]) {
      const m2 = new THREE.Vector3(x + d[0] - 0.4, y + 0.05, z + d[1] - 0.4);
      const M2 = new THREE.Vector3(x + d[0] + 0.4, y + 1.9, z + d[1] + 0.4);
      if (!game.physics.isBoxFree(m2, M2, { actors: true })) { clear = false; break; }
    }
    if (!clear) continue;
    if (Math.hypot(x - game.player.pos.x, z - game.player.pos.z) < radius) continue;
    return { x, y, z };
  }
  return null;
}

/** Take an enemy out of the world completely: model, actor body, and list. */
export function retireEnemy(g, e) {
  if (g.enemies.group && e.model && e.model.root) g.enemies.group.remove(e.model.root);
  unregisterActorBody(g.physics, e);
  const i = g.enemies.list.indexOf(e);
  if (i >= 0) g.enemies.list.splice(i, 1);
}

/** Drive a body straight into a target using the mover contract, bypassing AI
 * pathing: this measures the impact system, not whether a soldier chose to
 * close the last metre. */
export function driveInto(g, actor, speed, dirX, dirZ, dt, state) {
  const st = state || (state = {});
  actor._intentSpeed = speed;
  actor._syncBox();
  g.physics.moveBox(actor.box, dirX * speed * dt, 0, dirZ * speed * dt, st, 0.42,
    { ignoreBody: actor._body, actors: true });
  const hw = actor._halfWidth != null ? actor._halfWidth : 0.32;
  actor.pos.x = actor.box.min.x + hw;
  actor.pos.z = actor.box.min.z + hw;
  actor._syncBox();
  processMoveContacts(actor, g.physics, st, dt);
  return st;
}
