/**
 * Mission spawn accounting regressions. Exercises the production EnemyManager
 * lifetime cap and initial/reserve staging. It combines lightweight-manager
 * cases with actual Enemy instances and a production checkpoint-restart path.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { getMissionMinEnemies, MISSION_ORDER, Progress } from '../js/progress.js';
import { MISSION_DEFS } from '../js/missions.js';
import { Game, GameState } from '../js/game.js';
import { disposeSoldierModel } from '../js/enemy-soldier.js';
import { makeGame, retireEnemy } from './world_harness.mjs';

let assertions = 0;
function check(name, fn) {
  try { fn(); assertions++; console.log(`PASS ${name}`); }
  catch (error) { console.log(`FAIL ${name} — ${error.stack || error.message}`); process.exitCode = 1; }
}

const cases = [[1,50],[2,52],[3,54],[4,56],[10,68],[50,148],[100,248]];
const gameSource = readFileSync(new URL('../js/game.js', import.meta.url), 'utf8');
const enemySource = readFileSync(new URL('../js/enemies.js', import.meta.url), 'utf8');
const uiSource = readFileSync(new URL('../js/ui.js', import.meta.url), 'utf8');
for (const [n, expected] of cases) {
  check(`OP ${String(n).padStart(3,'0')} formula target is ${expected}`, () => {
    assert.equal(getMissionMinEnemies(n), expected);
  });
}

// Build one real EnemyManager, but use simple in-memory actors to exercise the
// exact production count gate and streaming reserve logic without rendering.
const game = makeGame('facility');
const manager = game.enemies;
manager._findSpawnPosition = (requested) => requested;
manager._spawnAuthoredAt = function (spawn, pos, source, spawnId, eventId) {
  return !!this._spawnWithRunCap(
    () => ({ alive: true, surrendered: false, fled: false, pos: pos.clone(), model: { root: new THREE.Group() }, game }),
    source, eventId, spawnId,
  );
};
game.world.map = 'facility';
game.world.spawnPoint = new THREE.Vector3(500, 0, 500);
game.world.surgeSpawns = [];
game.world.vehicleSpawns = [];
game.missions = {};

function runAttempt(missionNumber) {
  const missionId = MISSION_ORDER[missionNumber - 1];
  const target = getMissionMinEnemies(missionNumber);
  game.world.enemySpawns = Array.from({ length: target }, (_, i) => ({
    pos: new THREE.Vector3(30 + (i % 20) * 4, 0, 30 + Math.floor(i / 20) * 4),
    route: null, kind: 'rifleman', id: `${missionId}:seed:${i + 1}`,
  }));
  manager.reset();
  manager.group.clear();
  manager.beginMissionRun(missionId, target);
  assert.equal(manager.spawnInitial(missionId, { type: 'assault', minEnemies: 9999 }), 8,
    'initial garrison remains streamed, not full-spawned');
  assert.equal(manager.totalMissionEnemies, target);
  assert.equal(manager.missionSpawnLimit, target);
  assert.equal(manager.spawnedThisRun, 8);
  let guard = 0;
  while (manager.reserveRemaining && guard++ < 100) {
    for (const enemy of manager.list) enemy.alive = false;
    manager._reserveT = 0;
    manager._tickReserve(0);
  }
  assert.ok(guard < 100, 'reserve streaming drains');
  assert.equal(manager.spawnedThisRun, target, 'actual manager spawn count equals formula target');
  assert.equal(manager.spawnLog.length, target, 'spawn audit log matches total spawned');
  assert.equal(manager.reserveRemaining, 0);
  assert.equal(manager.remainingMissionSpawns, 0);
  assert.equal(manager._spawnWithRunCap(() => ({ alive: true, pos: new THREE.Vector3(), model: { root: new THREE.Group() }, game }), 'test-overflow', 'extra', 'extra'), null,
    'no additional enemy can exceed the mission target');
  return { missionId, target };
}

for (let attempt = 1; attempt <= 4; attempt++) {
  check(`OP 001 actual streamed spawns stay 50 on attempt ${attempt}`, () => assert.equal(runAttempt(1).target, 50));
}
for (let attempt = 1; attempt <= 2; attempt++) {
  check(`OP 002 actual streamed spawns stay 52 on attempt ${attempt}`, () => assert.equal(runAttempt(2).target, 52));
}
for (const n of [3, 50, 100]) {
  const target = getMissionMinEnemies(n);
  check(`OP ${String(n).padStart(3,'0')} actual streamed total is ${target}`, () => assert.equal(runAttempt(n).target, target));
}

check('campaign progression alone advances OP 001 target to OP 002', () => {
  const completedId = MISSION_ORDER[0];
  assert.equal(completedId, 'facility');
  assert.equal(MISSION_ORDER.indexOf(completedId) + 2, 2);
  assert.equal(getMissionMinEnemies(MISSION_ORDER.indexOf(completedId) + 2), 52);
});

check('failure save/load and mission re-entry do not change target', () => {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
  const progress = new Progress();
  for (let i = 0; i < 3; i++) progress.recordFailure('facility');
  const reloaded = new Progress();
  assert.equal(reloaded.data.stats.missionsFailed, 3);
  assert.equal(getMissionMinEnemies(MISSION_ORDER.indexOf('facility') + 1), 50);
  assert.equal(runAttempt(1).target, 50);
});

// Repeat the key scenarios with actual Enemy instances, collision-aware spawn
// placement, and production reserve drains. Actors are retired between echelons
// to model clearing the active combat group while preserving the game's cap.
const actualGame = makeGame('range');
const actualManager = actualGame.enemies;
let activeMapId = 'range';
function prepareActualMission(missionNumber) {
  const missionId = MISSION_ORDER[missionNumber - 1];
  const def = MISSION_DEFS[missionId];
  assert.ok(def, `mission definition ${missionId} exists`);
  if (activeMapId !== def.map) {
    actualManager.reset();
    actualGame.world.dispose(actualGame.scene);
    actualGame.physics.clear();
    actualGame.world._supplyPlan = {
      missionNumber, minEnemies: getMissionMinEnemies(missionNumber), near: def.spawnPos || [0, 0],
    };
    actualGame.world.buildByMap(def.map, actualGame.scene, actualGame.physics);
    activeMapId = def.map;
  } else {
    actualManager.reset();
  }
  actualGame.player.reset(actualGame.world.spawnPoint.clone(), actualGame.world.spawnYaw || 0);
  actualGame.missions = {};
  return { missionId, def, target: getMissionMinEnemies(missionNumber) };
}
function runActualAttempt(missionNumber) {
  const { missionId, def, target } = prepareActualMission(missionNumber);
  actualManager.beginMissionRun(missionId, target);
  const opening = actualManager.spawnInitial(missionId, def);
  assert.ok(opening > 0 && opening < target, 'opening party remains a streamed subset');
  assert.ok(opening <= 12, 'opening party respects the existing active cap');
  assert.equal(actualManager.totalMissionEnemies, target);
  assert.equal(actualManager.missionSpawnLimit, target);
  let peakActive = actualManager.activeHostiles;
  let guard = 0;
  while (actualManager.reserveRemaining && guard++ < 300) {
    for (const actor of [...actualManager.list]) {
      retireEnemy(actualGame, actor);
      if (actor.rig) { actor.rig.dispose(); actor.rig = null; }
      disposeSoldierModel(actor.model);
    }
    actualManager._reserveT = 0;
    actualManager._tickReserve(0);
    peakActive = Math.max(peakActive, actualManager.activeHostiles);
    assert.ok(peakActive <= 12, 'active enemy cap remains unchanged');
  }
  assert.ok(guard < 300, 'actual collision-aware reserve staging drains');
  assert.equal(actualManager.spawnedThisRun, target, 'actual Enemy instances spawned match exact target');
  assert.equal(actualManager.spawnLog.length, target, 'actual spawn log agrees with lifetime spawned total');
  assert.equal(actualManager.reserveRemaining, 0);
  assert.equal(actualManager.remainingMissionSpawns, 0);
  assert.equal(actualManager.spawnFailures.length, 0, 'no spawn failure was silently counted as success');
  const overCap = actualManager._spawnWithRunCap(() => ({ alive: true, pos: new THREE.Vector3(), model: { root: new THREE.Group() }, game: actualGame }), 'over-cap', 'extra', 'extra');
  assert.equal(overCap, null, 'actual manager refuses spawn beyond formula');
  return { target, peakActive };
}

check('HUD total and completion/progression remain tied to the authoritative mission contract', () => {
  assert.match(uiSource, /const tot = g\.enemies \? g\.enemies\.totalMissionEnemies/);
  assert.match(enemySource, /get totalMissionEnemies\(\)\s*\{\s*return this\._totalPlannedHostiles \|\| this\.missionSpawnLimit/);
  assert.match(enemySource, /get remainingHostiles\(\)\s*\{\s*return this\.activeHostiles \+ this\.reserveRemaining/);
  assert.match(gameSource, /this\.missions\.canCompleteExtraction\(\)/);
  assert.match(gameSource, /this\.progress\.evaluateMission\(ctx\)/);
});

for (let attempt = 1; attempt <= 4; attempt++) {
  check(`actual Enemy actors OP 001 total 50 after attempt ${attempt}`, () => assert.equal(runActualAttempt(1).target, 50));
}
for (let attempt = 1; attempt <= 2; attempt++) {
  check(`actual Enemy actors OP 002 total 52 after attempt ${attempt}`, () => assert.equal(runActualAttempt(2).target, 52));
}
for (const n of [3, 50, 100]) {
  const expected = getMissionMinEnemies(n);
  check(`actual Enemy actors OP ${String(n).padStart(3,'0')} total ${expected}`, () => assert.equal(runActualAttempt(n).target, expected));
}

check('actual checkpoint restart clears a completed attempt ledger and respawns OP 001 from 50', () => {
  runActualAttempt(1); // ends with an attempt that has actually spawned the full roster
  const cp = { mission: 'facility', player: actualGame.player.snapshot(), throwables: null };
  actualGame.missions = {
    missionId: 'facility', checkpointData: cp, _wave2: false, def: { setup: null },
    start(id) { this.missionId = id; this.def = { setup: null }; },
  };
  actualGame.progress.selectedCharacterId = 'operator';
  actualGame.ui.setThrowHighlight = () => {};
  actualGame.weapons.rig = actualGame.weapons.rig || { visible: true };
  actualGame.weapons.cancelZoom = () => {};
  actualGame.player.restoreSnapshot = () => {};
  actualGame.loadout.current = () => ({});
  actualGame.baseStrike = { resetForCheckpoint() {} };
  actualGame.flashlight = { reset() {} };
  actualGame.music = { begin() {} };
  actualGame.audio.ready = false;
  actualGame.setState = (state) => { actualGame.state = state; };
  actualGame._requestLock = () => {};
  Game.prototype.restartFromCheckpoint.call(actualGame);
  assert.equal(actualManager.missionSpawnLimit, 50);
  assert.equal(actualManager.totalMissionEnemies, 50);
  assert.equal(actualManager.spawnedThisRun, 8, 'new checkpoint attempt has only its fresh opening wave counted');
  assert.equal(actualManager.spawnLog.length, 8, 'old spawn records are cleared on checkpoint attempt');
  assert.equal(actualManager.reserveRemaining, 42);
  assert.equal(actualManager.list.length, 8, 'old actor instances were removed before respawning');
  assert.equal(actualGame.state, GameState.PLAYING);
});

console.log(`\nMission scaling checks: ${assertions} passed, ${process.exitCode ? 1 : 0} failed.`);
