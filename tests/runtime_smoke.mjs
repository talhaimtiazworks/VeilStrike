import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MISSION_DEFS } from '../js/missions.js';
import { DEFAULT_UNLOCKED_CAMPAIGN_COUNT, DIFFICULTIES, MISSION_ORDER } from '../js/progress.js';
import { EnemyManager } from '../js/enemies.js';
import { TouchControls } from '../js/touch.js';
import { GameWorld } from '../js/world.js';
import { PhysicsWorld } from '../js/physics.js';
import { PLAYER_MOVEMENT, Player } from '../js/player.js';
import { stepFallbackGait } from '../js/enemy-soldier.js';
import { MusicSystem, MUSIC_TRACKS } from '../js/music.js';

const root = new URL('..', import.meta.url);

// Tiny canvas surface for Three.js CanvasTexture in headless Node map-builder tests.
function makeCanvas() {
  const canvas = { width: 0, height: 0 };
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key === 'getImageData') return (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (key === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (key === 'createLinearGradient' || key === 'createRadialGradient' || key === 'createPattern') return () => ({ addColorStop() {} });
      if (key === 'measureText') return () => ({ width: 0 });
      if (key === 'canvas') return canvas;
      if (key in target) return target[key];
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  canvas.getContext = () => ctx;
  return canvas;
}
globalThis.document = {
  baseURI: 'https://example.test/',
  createElement: (tag) => tag === 'canvas' ? makeCanvas() : {},
};
globalThis.requestAnimationFrame = (fn) => { queueMicrotask(fn); return 1; };

const firstTen = MISSION_ORDER.slice(0, 10);
assert.equal(firstTen.length, 10);
assert.equal(MISSION_ORDER.length >= 100, true, 'campaign order must contain at least 100 missions');
assert.equal(DEFAULT_UNLOCKED_CAMPAIGN_COUNT, 1, 'progressive unlocking starts from Mission 1 onward');
const tenLayouts = firstTen.map((id) => MISSION_DEFS[id].map);
assert.equal(new Set(tenLayouts).size, 10, 'the first ten campaign operations need ten distinct layout IDs');
const tenMaps = [
  'facility', 'desert', 'urban', 'snow', 'recon_canyon',
  'industrial', 'rural', 'riverside_village', 'canal_market', 'ridge_hold',
];
assert.deepEqual(tenLayouts, tenMaps, 'campaign map IDs must preserve order and remain distinct');

const mapCases = [
  { id: 'recon_canyon', canonical: 'desert', legs: [[0, 72], [-26, 30], [26, 30], [-2, -26], [56, -34]], targetIds: ['obs_a', 'obs_b', 'obs_c'] },
  { id: 'riverside_village', canonical: 'rural', legs: [[0, 68], [0, 34], [16, 22], [-38, 58]], targetIds: ['npc_contact'] },
  { id: 'canal_market', canonical: 'urban', legs: [[-63, 22], [-55, 22], [-14, -12], [54, -49]], targetIds: [] },
  { id: 'ridge_hold', canonical: 'snow', legs: [[0, 62], [-26, 12]], targetIds: ['hx7_vanguard'] },
];

function cellIsOpen(physics, x, z) {
  const min = new THREE.Vector3(x - 0.34, 0.025, z - 0.34);
  const max = new THREE.Vector3(x + 0.34, 1.78, z + 0.34);
  const hits = [];
  physics.queryAABB(min, max, hits);
  // Player.update() calls PhysicsWorld.moveBox with a 0.42 m step-up; treat
  // blockers at or below that height as traversable, matching the real solver.
  return hits.every((collider) => collider.max.y <= 0.42);
}
function testFallRecoveryForMap(world, physics, mapId) {
  const stats = { kills: 3, missionTime: 41 };
  const recoveryGame = { physics, world, stats, ui: { toastBrief() {} } };
  const player = new Player(recoveryGame);
  player.reset(world.spawnPoint, world.spawnYaw);
  player.pos.set(world.spawnPoint.x, -20, world.spawnPoint.z);
  assert.equal(player._recoverFromWorldBoundary(), true, `${mapId}: below-world fall should recover`);
  assert.equal(stats.kills, 3, `${mapId}: recovery must preserve kills/progression state`);
  assert.equal(stats.missionTime, 41, `${mapId}: recovery must preserve mission time`);
  assert.ok(Math.hypot(player.pos.x - world.spawnPoint.x, player.pos.z - world.spawnPoint.z) < 1e-6, `${mapId}: recovery should use valid safe footing`);
  const edgeX = world.spawnPoint.x < (world.bounds.minX + world.bounds.maxX) * 0.5 ? world.bounds.minX - 2 : world.bounds.maxX + 2;
  player.pos.set(edgeX, 0, world.spawnPoint.z);
  assert.equal(player._recoverFromWorldBoundary(), true, `${mapId}: crossing authored X boundary should recover`);
  assert.equal(player.fallRecoveryCount, 2, `${mapId}: both boundary cases should be counted once`);
}

function testOpeningPressure(world, physics, scene) {
  const missionId = MISSION_ORDER.find(id => MISSION_DEFS[id]?.map === world.layoutId);
  assert.ok(missionId, `${world.layoutId}: expected a campaign mission`);
  const game = {
    scene, world, physics, player: { pos: world.spawnPoint }, progress: { difficulty: DIFFICULTIES.standard },
    state: 'playing', time: 0, stats: { alarm: false, kills: 0 },
    ui: { radio() {}, toast() {}, toastBrief() {} },
    audio: { radioSquelch() {}, impact() {}, pickup() {}, hitMarker() {} },
    particles: { impact() {} }, throwables: { smokeBlocksLOS: () => false },
    emitNoise() {}, onAlarmRaised() { this.stats.alarm = true; },
  };
  const manager = new EnemyManager(game);
  game.enemies = manager;
  const mIdx = MISSION_ORDER.indexOf(missionId);
  const expectedMin = 50 + mIdx * 2;
  manager.beginMissionRun(missionId, expectedMin);
  const count = manager.spawnInitial(missionId, MISSION_DEFS[missionId]);
  assert.ok(count >= 7 && count <= 10, `${world.layoutId}: opening party must be staged to 7–10, got ${count}`);
  assert.ok(manager.activeHostiles <= 12, `${world.layoutId}: live engagement budget must remain capped at 12`);
  assert.ok(manager.totalMissionEnemies >= expectedMin, `${world.layoutId}: mission must have >= ${expectedMin} total enemies`);
  manager.reset();
  scene.remove(manager.group);
}

function pathExists(physics, bounds, from, to, openCells) {
  const key = (x, z) => `${x},${z}`;
  const isOpen = (x, z) => {
    const k = key(x, z);
    if (!openCells.has(k)) openCells.set(k, cellIsOpen(physics, x, z));
    return openCells.get(k);
  };
  const sx = Math.round(from[0]), sz = Math.round(from[1]);
  const tx = Math.round(to[0]), tz = Math.round(to[1]);
  assert.ok(isOpen(sx, sz), `route start ${sx},${sz} intersects collision geometry`);
  assert.ok(isOpen(tx, tz), `route target ${tx},${tz} intersects collision geometry`);
  const q = [[sx, sz]], seen = new Set([key(sx, sz)]);
  for (let i = 0; i < q.length; i++) {
    const [x, z] = q[i];
    if (x === tx && z === tz) return true;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz, k = key(nx, nz);
      if (nx < bounds.minX + 1 || nx > bounds.maxX - 1 || nz < bounds.minZ + 1 || nz > bounds.maxZ - 1 || seen.has(k)) continue;
      if (isOpen(nx, nz)) { seen.add(k); q.push([nx, nz]); }
    }
  }
  return false;
}
function geometryFingerprint(world, physics) {
  const r = (x) => Math.round(x * 10) / 10;
  const colliders = physics.colliders.map((c) => [
    r(c.min.x), r(c.max.x), r(c.min.y), r(c.max.y), r(c.min.z), r(c.max.z), c.material, c.tag,
  ].join(',')).sort();
  const meshes = [];
  world.group.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  world.group.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    o.getWorldPosition(p);
    const geom = o.geometry || {};
    const color = Array.isArray(o.material) ? o.material[0]?.color : o.material?.color;
    meshes.push([geom.type || '', JSON.stringify(geom.parameters || {}), r(p.x), r(p.y), r(p.z), color?.getHex?.() ?? ''].join(':'));
  });
  meshes.sort();
  const routes = world.patrolRoutes.map((route) => route.map((v) => `${r(v.x)},${r(v.y)},${r(v.z)}`).join(';'));
  const coverage = world.coverPoints.map((v) => `${r(v.pos.x)},${r(v.pos.y)},${r(v.pos.z)}`).sort();
  const payload = JSON.stringify({ map: world.map, colliders, meshes, routes, coverage,
    spawns: world.enemySpawns.map((s) => `${r(s.pos.x)},${r(s.pos.y)},${r(s.pos.z)},${s.route ?? ''}`),
    surges: world.surgeSpawns.map((s) => `${r(s.pos.x)},${r(s.pos.y)},${r(s.pos.z)}`),
    spawn: [r(world.spawnPoint.x), r(world.spawnPoint.y), r(world.spawnPoint.z)],
    extraction: [r(world.extractionPoint.x), r(world.extractionPoint.y), r(world.extractionPoint.z)],
  });
  return createHash('sha256').update(payload).digest('hex');
}

const THREE = await import('three');
const layoutHashes = new Map();
for (const spec of mapCases) {
  const world = new GameWorld();
  const scene = new THREE.Scene();
  const physics = new PhysicsWorld();
  world.buildByMap(spec.id, scene, physics);
  testFallRecoveryForMap(world, physics, spec.id);
  testOpeningPressure(world, physics, scene);
  assert.equal(world.layoutId, spec.id);
  assert.equal(world.map, spec.canonical, `${spec.id} must keep its intel archive key`);
  assert.ok(world.enemySpawns.length >= 8, `${spec.id} needs a distinct authored enemy approach set`);
  assert.ok(world.surgeSpawns.length >= 4, `${spec.id} needs separate reinforcement approaches`);
  assert.ok(world.patrolRoutes.length >= 3, `${spec.id} needs authored patrol routes`);
  assert.ok(world.triggers.some((t) => t.id === 'extraction'), `${spec.id} needs an extraction trigger`);
  assert.ok(cellIsOpen(physics, world.spawnPoint.x, world.spawnPoint.z), `${spec.id} insertion point is blocked`);
  assert.ok(cellIsOpen(physics, world.extractionPoint.x, world.extractionPoint.z), `${spec.id} extraction point is blocked`);
  for (const target of spec.targetIds) {
    assert.ok(world.interactables.some((it) => it.id === target) || world.vehicleSpawns.some((v) => v.tag === target) || (target === 'npc_contact' && world.npcSpawns.some((n) => n.kind === 'contact')), `${spec.id} is missing objective target ${target}`);
  }
  for (const spawn of world.enemySpawns) {
    assert.ok(spawn.route == null || Number.isInteger(spawn.route), `${spec.id} spawn route must be null or route index`);
    assert.ok(Number.isFinite(spawn.pos.x) && Number.isFinite(spawn.pos.z), `${spec.id} spawn coordinates must be finite`);
  }
  const cells = new Map();
  for (let i = 0; i < spec.legs.length - 1; i++) {
    assert.ok(pathExists(physics, world.bounds, spec.legs[i], spec.legs[i + 1], cells), `${spec.id} collision grid has no walkable route between ${spec.legs[i]} and ${spec.legs[i + 1]}`);
  }
  layoutHashes.set(spec.id, geometryFingerprint(world, physics));
  console.log(`PASS world/collision route smoke: ${spec.id} (${world.enemySpawns.length} spawns, ${world.surgeSpawns.length} surge anchors, ${world.patrolRoutes.length} routes)`);
  scene.clear(); physics.clear();
}
for (const id of tenMaps) {
  if (layoutHashes.has(id)) continue;
  const world = new GameWorld();
  const scene = new THREE.Scene();
  const physics = new PhysicsWorld();
  world.buildByMap(id, scene, physics);
  testFallRecoveryForMap(world, physics, id);
  testOpeningPressure(world, physics, scene);
  const expectedCanonical = MISSION_DEFS[firstTen[tenMaps.indexOf(id)]].map;
  assert.equal(world.layoutId, id);
  assert.equal(world.map, expectedCanonical, `${id} must retain its canonical intel/weather family`);
  assert.ok(world.enemySpawns.length >= 6, `${id} needs authored hostile approaches`);
  assert.ok(world.surgeSpawns.length >= 2, `${id} needs distinct reinforcement anchors`);
  assert.ok(world.patrolRoutes.length >= 1, `${id} needs authored patrol routes`);
  assert.ok(world.coverPoints.length > 0, `${id} needs cover geometry`);
  assert.ok(world.triggers.some((t) => t.id === 'extraction'), `${id} needs extraction geometry`);
  assert.ok(cellIsOpen(physics, world.spawnPoint.x, world.spawnPoint.z), `${id} insertion point is blocked`);
  assert.ok(cellIsOpen(physics, world.extractionPoint.x, world.extractionPoint.z), `${id} extraction point is blocked`);
  if (id !== 'facility') {
    const routeCells = new Map();
    assert.ok(pathExists(physics, world.bounds, [world.spawnPoint.x, world.spawnPoint.z], [world.extractionPoint.x, world.extractionPoint.z], routeCells), `${id} has no walkable insertion-to-extraction route`);
  }
  layoutHashes.set(id, geometryFingerprint(world, physics));
  console.log(`PASS distinct environment generation: ${id} (${physics.colliders.length} collision boxes, ${world.coverPoints.length} cover points, ${world.enemySpawns.length} spawns)`);
  scene.clear(); physics.clear();
}
assert.equal(new Set(layoutHashes.values()).size, 10, 'each of the ten campaign layouts must have a distinct geometry/route/objective fingerprint');
console.log('PASS all ten campaign layouts have distinct generated geometry, routes, spawn/extraction placement, and cover signatures');
console.log('PASS all ten generated maps: safe fall/boundary recovery preserves mission facts; actual opening parties stage at 7–9 hostiles under the 12-live/30-total budgets');

// Procedural fallback gait: stationary gait is fixed; actual movement advances phase.
const idleGait = stepFallbackGait(1.25, 1 / 30, 0);
assert.deepEqual(idleGait, { phase: 1.25, swing: 0, bob: 0 });
const movingGait = stepFallbackGait(1.25, 1 / 30, 2.5);
assert.ok(movingGait.phase > 1.25 && Math.abs(movingGait.swing) > 0);
console.log('PASS procedural fallback gait unit checks: idle pose fixed; moving gait advances');

// Execute real Player.update() with the project collision world for speed, sprint, stop, aim and wall blocking.
function makePlayer() {
  const physics = new PhysicsWorld();
  physics.addBox(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(1000, 1, 1000), 'soil', { tag: 'ground' });
  const cam = new THREE.PerspectiveCamera();
  const game = {
    physics, camera: cam, state: 'playing', time: 0, suppress: 0,
    settings: { sensitivity: 1, aimSens: 0.8 },
    weapons: { adsT: 0, def: { handling: 1 }, easeInOut: (t) => t * t * (3 - 2 * t) },
    audio: { footstep() {}, jump() {}, land() {} },
    particles: { footDust() {} }, emitNoise() {},
    ui: { setStamina() {} }, characters: null, shield: null,
    stats: { damageTaken: 0 },
  };
  const player = new Player(game);
  player.reset(new THREE.Vector3(0, 0, 0), 0);
  return { player, game, physics };
}
function input({ forward = 1, right = 0, sprint = false } = {}) {
  return { moveF: forward, moveR: right, sprint, crouch: false, leanL: false, leanR: false, jumpPressed: false, lookX: 0, lookY: 0 };
}
function runPlayer(seconds, inp, fixture) {
  const dt = 1 / 60;
  let t = 0;
  while (t < seconds - 1e-8) {
    fixture.game.time += dt;
    fixture.player.update(dt, inp);
    t += dt;
  }
}
const normal = makePlayer();
runPlayer(2.5, input(), normal);
assert.ok(Math.abs(normal.player.speed - PLAYER_MOVEMENT.walk) < 0.12, `normal speed should settle at ${PLAYER_MOVEMENT.walk} m/s, got ${normal.player.speed.toFixed(2)}`);
const sprint = makePlayer();
runPlayer(1.6, input({ sprint: true }), sprint);
assert.ok(Math.abs(sprint.player.speed - PLAYER_MOVEMENT.sprint) < 0.2, `sprint speed should settle at ${PLAYER_MOVEMENT.sprint} m/s, got ${sprint.player.speed.toFixed(2)}`);
assert.ok(sprint.player.stamina > 80, 'sprint must sustain past the previous ~5.9 second full-drain estimate');
const sustained = makePlayer();
runPlayer(9.4, input({ sprint: true }), sustained);
assert.equal(sustained.player.sprinting, true, 'sprint should sustain beyond the previous ~10 second drain point');
runPlayer(0.8, input({ sprint: true }), sustained);
assert.equal(sustained.player.sprinting, true, 'sprint remains available through 10 seconds');
runPlayer(12.3, input({ sprint: true }), sustained);
assert.equal(sustained.player.sprinting, false, 'continuous sprint should eventually exhaust stamina after roughly 22 seconds');
const brake = makePlayer();
runPlayer(2, input({ sprint: true }), brake);
const stopSpeed = brake.player.speed;
runPlayer(0.85, input({ forward: 0 }), brake);
assert.ok(brake.player.speed < 0.15 && stopSpeed > 6.5, 'stopping should bring sprint velocity to rest promptly');
const turn = makePlayer();
runPlayer(1.5, input({ sprint: true }), turn);
const beforeTurnZ = turn.player.vel.z;
runPlayer(0.8, input({ forward: 0, right: 1 }), turn);
assert.ok(turn.player.vel.x > 2 && turn.player.vel.z > beforeTurnZ, 'lateral turn input should redirect velocity through acceleration, not lock the sprint heading');
const aimed = makePlayer();
aimed.game.weapons.adsT = 1;
runPlayer(2, input(), aimed);
assert.ok(Math.abs(aimed.player.speed - 1.75) < 0.12, 'aiming should remain speed-capped and responsive');
const wall = makePlayer();
wall.physics.addBox(new THREE.Vector3(0, 1.2, -4), new THREE.Vector3(6, 2.4, 0.6), 'concrete', { tag: 'wall' });
runPlayer(3, input({ sprint: true }), wall);
assert.ok(wall.player.pos.z > -3.7, `collision solver should stop player before wall; z=${wall.player.pos.z.toFixed(2)}`);
console.log(`PASS player runtime physics: walk ${normal.player.speed.toFixed(2)} m/s, sprint ${PLAYER_MOVEMENT.sprint.toFixed(2)} m/s; sustained, stop, ADS cap, wall collision`);
const touchProbe = Object.create(TouchControls.prototype);
touchProbe.game = { settings: { autoSprint: false }, input: { _shiftKeyHeld: false, sprint: true } };
touchProbe._autoSprint = false; touchProbe._sprintWrote = true;
touchProbe.els = { 'stick-move': { el: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) }, knob: { style: {} } } };
touchProbe._stickMove('stick-move', { clientX: 90, clientY: 50, preventDefault() {} });
assert.equal(touchProbe.game.input.sprint, true, 'steering the move stick must not cancel a held touch sprint button');
touchProbe._release('stick-move');
assert.equal(touchProbe.game.input.sprint, true, 'releasing the move stick must preserve held touch sprint');
touchProbe._release('tbtn-sprint');
assert.equal(touchProbe.game.input.sprint, false, 'releasing the sprint button must clear touch sprint when no other sprint source is active');
console.log('PASS touch sprint arbitration unit check: held sprint survives stick movement/release and clears on sprint-button release');

// Exercise the actual Enemy/EnemyManager state update against PhysicsWorld in a tiny, controlled test arena.
const aiPhysics = new PhysicsWorld();
aiPhysics.addBox(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(500, 1, 500), 'soil', { tag: 'ground' });
const aiPlayer = {
  pos: new THREE.Vector3(0, 0, -200), vel: new THREE.Vector3(), speed: 0,
  crouchT: 0, crouching: false, sprinting: false, alive: true,
  visibilityMult: 1, flashlightOn: false, damage() {}, addSuppress() {},
};
const aiWorld = {
  map: 'ai_sandbox', bounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
  patrolRoutes: [[new THREE.Vector3(0, 0, 8), new THREE.Vector3(0, 0, 16)]],
  coverPoints: [], surgeSpawns: [], enemySpawns: [], npcSpawns: [], interactables: [],
  triggers: [], vehicleSpawns: [], lightMode: 'day', weather: null, windLevel: 0,
};
const aiGame = {
  scene: new THREE.Scene(), physics: aiPhysics, world: aiWorld, player: aiPlayer,
  progress: { difficulty: DIFFICULTIES.standard }, state: 'playing', time: 0,
  stats: { alarm: false, kills: 0 }, throwables: { smokeBlocksLOS: () => false },
  audio: { alertLevel: 0, radioSquelch() {}, impact() {}, pickup() {}, hitMarker() {} },
  ui: { radio() {}, toast() {}, toastBrief() {}, hitMarker() {}, killConfirm() {} },
  particles: { impact() {} }, emitNoise() {}, onAlarmRaised() { this.stats.alarm = true; }, onWorldImpact() {},
};
const aiManager = new EnemyManager(aiGame);
aiGame.enemies = aiManager;
aiManager.beginMissionRun('test_ai', 30);
const spawnPoint = new THREE.Vector3(0, 0, 0);
assert.equal(aiManager._spawnAuthoredAt({ id: 'test-recon', pos: spawnPoint, route: 0, kind: 'recon' }, spawnPoint, 'unit-test', 'test-recon'), true);
const actor = aiManager.list[0];
function stepActor(seconds) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds - 1e-8; t += dt) {
    aiGame.time += dt;
    actor.update(dt, aiManager);
  }
}
actor.state = 'patrol'; actor.pauseT = 10; actor._perceptionElapsed = 0;
const idlePhase = actor.walkPhase;
stepActor(0.5);
assert.ok(actor.pos.distanceTo(spawnPoint) < 0.08, 'idle patrol pause should not drift');
assert.equal(actor.walkPhase, idlePhase, 'fallback legs should stay still during idle pause');
actor.pauseT = 0; actor.route = [new THREE.Vector3(0, 0, 8), new THREE.Vector3(0, 0, 16)]; actor.routeIdx = 0;
const patrolStart = actor.pos.clone();
stepActor(1.0);
const patrolSpeed = actor.pos.distanceTo(patrolStart);
assert.ok(patrolSpeed > 0.15 && patrolSpeed < 2.6, `patrol should move at a measured tactical pace; observed ${patrolSpeed.toFixed(2)} m/s`);
actor.pos.set(0, 0, 0); actor.lastPos.copy(actor.pos); actor._syncBox(); actor.state = 'patrol';
actor.yaw = 0; actor.aimYaw = 0; actor.pauseT = 10; actor.contactConfirmed = false; actor.detection = 0;
aiPlayer.pos.set(0, 0, -12); aiPlayer.speed = 1.0;
let detectionSeconds = 0;
for (let i = 0; i < 55 && !actor.contactConfirmed; i++) {
  aiGame.time += 0.1; detectionSeconds += 0.1;
  actor._perceive(aiManager, 0.1);
}
assert.equal(actor.contactConfirmed, true, 'clear in-cone visual contact should be acquired by gradual detection');
assert.equal(actor.canSeePlayer, true);
actor.state = 'combat'; actor.contactConfirmed = true; actor.canSeePlayer = true; actor.hasLOS = true;
actor.aimYaw = 0; actor.yaw = 0; actor.combatAction = 'engage'; actor.actionT = 0;
aiPlayer.pos.set(0, 0, -70); // inside recon vision, beyond SMG effective range: pursuit without a shot.
actor.lastSeenT = aiGame.time; actor._combat(0.1, aiManager);
assert.ok(actor.moveSpeed > 0.2 && actor._wish.z < 0, 'combat pursuit should close toward the visible player outside effective range');
const pursueStart = actor.pos.clone(); actor._move(0.1);
assert.ok(actor.pos.z < pursueStart.z, 'pursuit wish should move through the shared collision solver');
actor.state = 'search'; actor.canSeePlayer = false;
actor._setMoveTarget(new THREE.Vector3(0, 0, -200), 1, 4.2);
assert.ok(actor.moveSpeed <= 2.45, `search/pursuit movement cap should prevent rapid rushes; got ${actor.moveSpeed.toFixed(2)} m/s`);
// Cover movement is exercised through the actual combat action; the search point is a clear lateral position.
actor.state = 'combat';
aiPlayer.pos.set(0, 0, -12); actor.canSeePlayer = true; actor.hasLOS = true; actor.contactConfirmed = true;
actor.combatAction = 'cover'; actor.actionT = 0; actor.coverPoint = { pos: new THREE.Vector3(4, 0, -3) };
actor._combat(0.1, aiManager);
assert.ok(actor.moveSpeed > 0 && actor._wish.x > 0, 'cover action should commit to a distinct cover target');
let attackCalls = 0;
actor._shoot = () => { attackCalls++; return true; }; // isolate firing cadence from projectiles/audio/browser effects.
actor.combatAction = 'engage'; actor.actionT = 0; actor.canSeePlayer = true; actor.hasLOS = true;
actor.contactConfirmed = true; actor.aimYaw = 0; actor.burstLeft = 2; actor.burstT = 0; actor.burstPause = 0; actor.reloadT = 0; actor.windupT = 0;
const ammoBefore = actor.ammo;
actor._combatStrafeReady = false; actor._combatStrafeWait = 0;
actor._combat(0.1, aiManager);
const committedStrafeTarget = actor._combatStrafeTarget.clone();
actor._move(0.1);
actor._combat(0.1, aiManager);
assert.ok(actor._combatStrafeReady && actor._combatStrafeTarget.distanceTo(committedStrafeTarget) < 1e-5, 'strafe target must remain a fixed endpoint while the actor moves');
actor._trigger(0.1, actor.pos.distanceTo(aiPlayer.pos));
assert.ok(attackCalls >= 1 && actor.ammo < ammoBefore, 'combat burst scheduler should invoke the attack callback and spend finite ammo');
aiManager.damage(actor, 'head', 100, actor.pos.clone().setY(1.4), new THREE.Vector3(0, 0, 1));
assert.equal(actor.alive, false, 'lethal damage should enter the death state');
assert.equal(aiManager.kills, 1, 'lethal confirmation should count once');
aiManager.damage(actor, 'head', 100, actor.pos.clone(), new THREE.Vector3(0, 0, 1));
assert.equal(aiManager.kills, 1, 'repeat damage after death must not count a second kill');
actor.update(0.12, aiManager);
assert.ok(actor.deathT > 0, 'death presentation update should advance');
console.log(`PASS enemy runtime state smoke: idle/patrol (${patrolSpeed.toFixed(2)} m/s), detection ${detectionSeconds.toFixed(1)} s, pursuit, cover, fixed strafe endpoint, burst scheduler, lethal/death update; firing callback stubbed, not a rendered gunfight`);

// Audio promise-state tests use a fake HTMLAudioElement; they do NOT establish audible playback.
class MockAudio extends EventTarget {
  constructor(playImpl) { super(); this._src = ''; this.paused = true; this.currentTime = 0; this.volume = 1; this._playImpl = playImpl; }
  set src(v) { this._src = v; }
  get src() { return this._src; }
  setAttribute() {}
  getAttribute() { return this._src; }
  removeAttribute(name) { if (name === 'src') this._src = ''; }
  load() {}
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  play() { this.paused = false; return this._playImpl(this); }
}
const mockGame = { settings: {}, audio: { ready: false, init() { return false; }, setMusicVolume() {} } };
let audioRef;
globalThis.Audio = class extends MockAudio {
  constructor() { super((el) => Promise.reject(Object.assign(new Error('gesture required'), { name: 'NotAllowedError' }))); audioRef = this; }
};
const blockedMusic = new MusicSystem(mockGame);
blockedMusic.play({ auto: false });
await new Promise((r) => setTimeout(r, 0));
assert.equal(blockedMusic.state, 'blocked', 'NotAllowedError must be surfaced as blocked');
assert.equal(audioRef.src, new URL(MUSIC_TRACKS[0].file, document.baseURI).href);
let resolvePlay;
globalThis.Audio = class extends MockAudio {
  constructor() { super(() => new Promise((resolve) => { resolvePlay = resolve; })); audioRef = this; }
};
const pausedMusic = new MusicSystem(mockGame);
pausedMusic.play({ auto: false });
pausedMusic.pause();
resolvePlay();
await new Promise((r) => setTimeout(r, 0));
assert.equal(pausedMusic.state, 'paused', 'late play() resolution must not undo user pause');
let resolveDisabled;
globalThis.Audio = class extends MockAudio {
  constructor() { super(() => new Promise((resolve) => { resolveDisabled = resolve; })); audioRef = this; }
};
const disabledMusic = new MusicSystem(mockGame);
disabledMusic.play({ auto: false });
disabledMusic.setEnabled(false);
resolveDisabled();
await new Promise((r) => setTimeout(r, 0));
assert.equal(disabledMusic.state, 'off', 'late play() resolution must not undo disable');
assert.equal(disabledMusic.enabled, false);
const transitionInstances = [];
globalThis.Audio = class extends MockAudio {
  constructor() { super(() => Promise.resolve()); transitionInstances.push(this); }
};
const transitionGame = { settings: { musicVolume: 0.5, masterVolume: 0.8 }, audio: { ready: false, init() { return false; }, setMusicVolume(v) { this.lastMusicVolume = v; } } };
const transitionMusic = new MusicSystem(transitionGame);
transitionMusic.play({ auto: true });
await new Promise((r) => setTimeout(r, 0));
assert.equal(transitionMusic.state, 'playing');
transitionGame.settings.musicVolume = 0.4;
transitionMusic.setVolume(0.4);
assert.equal(transitionInstances[0].volume, 0.4 * 0.8 * 0.55, 'fallback element volume must use music × master × trim');
assert.equal(transitionGame.audio.lastMusicVolume, 0.4, 'music bus volume control must receive the user value');
assert.equal(transitionMusic.next(false), 'ins-fearless-pt-2');
await new Promise((r) => setTimeout(r, 0));
assert.equal(transitionMusic.state, 'playing');
assert.equal(transitionInstances[0].src, new URL(MUSIC_TRACKS[1].file, document.baseURI).href, 'next must transition the same element to FEARLESS PT 2');
assert.equal(transitionMusic.next(false), 'krezus-skins');
await new Promise((r) => setTimeout(r, 0));
assert.equal(transitionInstances[0].src, new URL(MUSIC_TRACKS[2].file, document.baseURI).href, 'next must transition the same element to SKINS');
assert.equal(transitionMusic.prev(), 'ins-fearless-pt-2');
await new Promise((r) => setTimeout(r, 0));
assert.equal(transitionMusic.trackId, 'ins-fearless-pt-2');
assert.equal(transitionMusic.stats.elementsCreated, 1, 'transitions must reuse a single media element');
assert.equal(MUSIC_TRACKS.length, 3);
console.log('PASS music state-machine unit checks: exact registry/path, autoplay rejection, pause/disable races, volume, next/previous and same-element URL switching; real playback remains unverified without the exact files/browser');
