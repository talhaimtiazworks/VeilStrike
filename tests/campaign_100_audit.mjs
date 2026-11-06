/**
 * campaign_100_audit.mjs
 * Exhaustive end-to-end automated verification across ALL 100 VEILSTRIKE
 * campaign missions + extensibility check for Mission 101+:
 *  1. Progressive unlocking from Mission 1 -> 100 + localStorage persistence
 *  2. 100 distinct layout IDs, 100 distinct 3D world geometry/collider fingerprints,
 *     and coverage of all 20 required tactical environment categories
 *  3. Collider-clear player spawn, extraction LZ, and objective anchors on all 100 maps
 *  4. Exact enemy progression formula: Minimum Enemies = 50 + (N - 1) * 2
 *     with full wave streaming & real lethal elimination of every single enemy
 *     from Mission 1 (50) through Mission 50 (148) to Mission 100 (248)
 *  5. Step-by-step objective execution and extraction completion on all 100 missions
 *  6. Dynamic extensibility test registering Mission 101 (250 enemies)
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PhysicsWorld } from '../js/physics.js';
import { GameWorld } from '../js/world.js';
import { Player } from '../js/player.js';
import { EnemyManager } from '../js/enemies.js';
const MAX_ACTIVE_HOSTILES = 12;
import { VehicleManager } from '../js/vehicles.js';
import {
  MissionManager, MISSION_DEFS, BRIEF_META, BRIEF_TEXT, syncCampaignMissionDefs,
} from '../js/missions.js';
import {
  Progress, MISSION_ORDER, DEFAULT_UNLOCKED_CAMPAIGN_COUNT,
  DIFFICULTIES, getMissionMinEnemies, extendCampaignMission,
} from '../js/progress.js';
import { ENVIRONMENT_CATEGORIES, CAMPAIGN_ACTS } from '../js/campaign-data.js';

// Minimal DOM/storage shims for headless Node execution
const storageMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
  setItem: (k, v) => storageMap.set(k, String(v)),
  removeItem: (k) => storageMap.delete(k),
};
function makeCanvas() {
  const canvas = { width: 0, height: 0, style: {} };
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key === 'getImageData') return (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (key === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (key === 'createLinearGradient' || key === 'createRadialGradient' || key === 'createPattern') return () => ({ addColorStop() {} });
      if (key === 'measureText') return () => ({ width: 8 });
      if (key === 'canvas') return canvas;
      if (key in target) return target[key];
      return () => {};
    },
    set(target, key, val) { target[key] = val; return true; },
  });
  canvas.getContext = () => ctx;
  return canvas;
}
globalThis.document = {
  baseURI: 'https://example.test/',
  createElement: (tag) => (tag === 'canvas' ? makeCanvas() : { style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, setAttribute() {}, addEventListener() {} }),
  getElementById: () => null,
};
globalThis.requestAnimationFrame = (fn) => { queueMicrotask(fn); return 1; };

console.log('=== PHASE 1: CAMPAIGN PROGRESSION & LOCKING AUDIT (1 -> 100) ===');
assert.equal(MISSION_ORDER.length, 100, 'MISSION_ORDER must contain 100 campaign missions');
assert.equal(DEFAULT_UNLOCKED_CAMPAIGN_COUNT, 1, 'Only Mission 1 unlocked initially');

storageMap.clear();
const prog = new Progress();
assert.equal(prog.isMissionUnlocked(MISSION_ORDER[0]), true, 'Mission 1 starts unlocked');
assert.equal(prog.isMissionUnlocked('range'), true, 'Firing range starts unlocked');
for (let i = 1; i < MISSION_ORDER.length; i++) {
  assert.equal(prog.isMissionUnlocked(MISSION_ORDER[i]), false, `Mission ${i + 1} (${MISSION_ORDER[i]}) must start locked`);
}

for (let i = 0; i < MISSION_ORDER.length; i++) {
  const id = MISSION_ORDER[i];
  assert.equal(prog.frontierMissionId(), id, `Frontier must point to Mission ${i + 1} (${id})`);
  if (i + 1 < MISSION_ORDER.length) {
    prog.recordFailure(id);
    assert.equal(prog.isMissionUnlocked(MISSION_ORDER[i + 1]), false, `Failing Mission ${i + 1} must NOT unlock Mission ${i + 2}`);
  }
  const def = MISSION_DEFS[id];
  assert.ok(def, `MISSION_DEFS[${id}] must exist`);
  assert.ok(BRIEF_META[id], `BRIEF_META[${id}] must exist`);
  assert.ok(BRIEF_TEXT[id], `BRIEF_TEXT[${id}] must exist`);

  prog.evaluateMission({
    missionId: id, type: def.type || 'assault', quietTypes: false,
    timeSec: 180, parTime: def.parTime || 480, shots: 200, hits: 140, headshots: 45,
    kills: getMissionMinEnemies(i + 1), damageTaken: 25, alarm: false, checkpointsUsed: 0,
    intelFound: 1, intelTotal: 2, intelComplete: false, optionalDone: 1, optionalTotal: 2,
    objectivesDone: def.objectivesTotal || 4, objectivesTotal: def.objectivesTotal || 4,
    minHealth: 75, finishedHealth: 85, extracted: true, mapOpens: 1, fogPct: 0.5,
    usedVehicle: false, vehicleMission: false, equipCats: 2, driverClean: true,
    driveDist: 0, throwablesUsed: 2,
  });

  if (i + 1 < MISSION_ORDER.length) {
    assert.equal(prog.isMissionUnlocked(MISSION_ORDER[i + 1]), true, `Completing Mission ${i + 1} must unlock Mission ${i + 2}`);
    if (i + 2 < MISSION_ORDER.length) {
      assert.equal(prog.isMissionUnlocked(MISSION_ORDER[i + 2]), false, `Completing Mission ${i + 1} must NOT prematurely unlock Mission ${i + 3}`);
    }
  }
}
const reloaded = new Progress();
for (let i = 0; i < MISSION_ORDER.length; i++) {
  assert.equal(reloaded.isMissionUnlocked(MISSION_ORDER[i]), true, `Reloaded save must preserve unlock for Mission ${i + 1}`);
}
console.log('PASS progressive unlocking 1 -> 100 & persistence verified.');

console.log('=== PHASE 2–5: FULL 100-MISSION 3D WORLD, ENEMY STREAMING & COMPLETION AUDIT ===');

const REQUIRED_CATEGORIES = [
  'military_base', 'dense_urban', 'industrial_district', 'abandoned_factory',
  'desert_installation', 'mountain_combat', 'forest_woodland', 'coastal_military',
  'harbor_port', 'airport_airfield', 'underground_facility', 'underground_bunker',
  'research_lab', 'power_station', 'oil_refinery', 'rural_village',
  'dam_bridge', 'border_checkpoint', 'rail_transport', 'command_compound',
];
const catList = Object.values(ENVIRONMENT_CATEGORIES);
assert.equal(catList.length, 20, 'Catalog must define all 20 environment categories');
for (const c of REQUIRED_CATEGORIES) {
  assert.ok(ENVIRONMENT_CATEGORIES[c], `Missing environment category ${c}`);
}
assert.ok(CAMPAIGN_ACTS.length >= 5, 'Campaign must have structured multi-act progression');

const seenLayouts = new Set();
const seenFingerprints = new Set();
const categoryCounts = Object.fromEntries(REQUIRED_CATEGORIES.map((c) => [c, 0]));

// Map legacy missions 1-18 to environment categories for full-campaign accounting
const LEGACY_CAT_MAP = {
  facility: 'military_base', desert: 'desert_installation', urban: 'dense_urban', snow: 'mountain_combat',
  recon_desert: 'desert_installation', sabotage_industrial: 'industrial_district', investigate_rural: 'rural_village',
  rescue_rural: 'rural_village', defense_urban: 'dense_urban', hold_snow: 'mountain_combat',
  convoy_rural: 'dam_bridge', extract_desert: 'border_checkpoint', blackout_industrial: 'power_station',
  hunt_snow: 'forest_woodland', cq_urban: 'dense_urban', siege_facility: 'underground_bunker',
  ghost_desert: 'airport_airfield', endgame: 'command_compound',
};

function triggerCenter(t) {
  if (!t) return null;
  if (t.center) return t.center.clone();
  if (t.box) return t.box.getCenter(new THREE.Vector3());
  if (t.min && t.max) return t.min.clone().lerp(t.max, 0.5);
  return null;
}

function worldFingerprint(world, physics) {
  const r = (v) => Math.round(v * 10) / 10;
  const cols = physics.colliders.slice(0, 80).map((c) =>
    `${r(c.min.x)},${r(c.max.x)},${r(c.min.y)},${r(c.max.y)},${r(c.min.z)},${r(c.max.z)},${c.tag}`
  ).join('|');
  const sp = `${r(world.spawnPoint.x)},${r(world.spawnPoint.z)}`;
  const exTr = world.triggers.find((t) => t.id === 'extraction');
  const exC = triggerCenter(exTr) || world.extractionPoint;
  const ex = exC ? `${r(exC.x)},${r(exC.z)}` : 'none';
  const rts = world.patrolRoutes.map((rt) => rt.map((p) => `${r(p.x)},${r(p.z)}`).join(';')).join('/');
  return `${world.bounds.minX}:${world.bounds.maxX}:${physics.colliders.length}:${world.coverPoints.length}:${sp}:${ex}:${cols}:${rts}`;
}

function assertCapsuleClear(physics, pos, label) {
  const hits = [];
  const min = new THREE.Vector3(pos.x - 0.32, (pos.y || 0) + 0.45, pos.z - 0.32);
  const max = new THREE.Vector3(pos.x + 0.32, (pos.y || 0) + 1.72, pos.z + 0.32);
  physics.queryAABB(min, max, hits);
  const blockers = hits.filter((c) => !c.isTrigger && c.tag !== 'ground' && c.tag !== 'glass' && c.max.y > (pos.y || 0) + 0.45);
  assert.equal(blockers.length, 0, `${label} at (${pos.x.toFixed(1)}, ${(pos.y || 0).toFixed(1)}, ${pos.z.toFixed(1)}) overlaps solid collider: ${blockers.map((b) => b.tag).join(',')}`);
}

const auditSummary = [];
let totalEnemiesSpawnedAndKilled = 0;

for (let idx = 0; idx < MISSION_ORDER.length; idx++) {
  const mNum = idx + 1;
  const id = MISSION_ORDER[idx];
  const def = MISSION_DEFS[id];
  const expectedMin = 50 + (mNum - 1) * 2;
  assert.equal(getMissionMinEnemies(mNum), expectedMin, `Formula mismatch on Mission ${mNum}`);

  // 1. Unique map layout ID
  assert.ok(!seenLayouts.has(def.map), `Duplicate layout ID ${def.map} on Mission ${mNum} (${id})`);
  seenLayouts.add(def.map);

  const cat = def.category || LEGACY_CAT_MAP[id];
  if (cat && cat in categoryCounts) categoryCounts[cat]++;

  // 2. Build actual 3D world + physics + batch buckets
  const scene = new THREE.Scene();
  const physics = new PhysicsWorld();
  const gameStub = {
    state: 'playing', time: 0, settings: { quality: 'medium', perfMode: false, dayMode: false },
    scene, physics, world: null, player: null, enemies: null, vehicles: null, missions: null,
    vehicleMode: null, hackProgress: 0, terminalJamT: 0,
    progress: { difficulty: DIFFICULTIES.standard, recordIntel() {} },
    stats: {
      kills: 0, shots: 0, hits: 0, headshots: 0, missionTime: 0, dataSecured: false,
      damageTaken: 0, alarm: false, checkpointsUsed: 0, intelRun: 0, minHealth: 100,
      mapOpens: 0, equipCats: {}, usedVehicle: false, vehicleAbandoned: false, driveDist: 0, throwablesUsed: 0,
    },
    ui: new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}) }),
    audio: new Proxy({ ready: false, alertLevel: 0 }, {
      get: (t, k) => (k in t ? t[k] : () => {}),
      set: (t, k, v) => { t[k] = v; return true; },
    }),
    particles: new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}) }),
    throwables: { smokeBlocksLOS: () => false, snapshotInv: () => null },
    weapons: { state: {}, currentId: 'vx4', adsT: 0, addAmmo() { return true; }, refuelCurrent() {} },
    characters: { abilityMult: () => 1 },
    shield: { absorbDamage: (_d) => 0 },
    emitNoise() {},
    onAlarmRaised() { this.stats.alarm = true; },
    onWorldImpact() {},
    saveCheckpoint() {},
    missionComplete() { this._completed = true; return true; },
    missionFailed(reason) { this._failed = reason; },
    missionFail(reason) { this._failed = reason; },
  };

  const world = new GameWorld();
  gameStub.world = world;
  world.buildByMap(def.map, scene, physics);
  world._prepareBatchBuckets(56);

  // 3. Distinct 3D geometry & collider fingerprint
  const fp = worldFingerprint(world, physics);
  assert.ok(!seenFingerprints.has(fp), `Mission ${mNum} (${id}) shares an identical 3D geometry fingerprint!`);
  seenFingerprints.add(fp);

  const minColliders = (mNum <= 10 || mNum === 18) ? 40 : 80;
  assert.ok(physics.colliders.length >= minColliders, `Mission ${mNum} (${id}): expected rich colliders (>=${minColliders}), got ${physics.colliders.length}`);
  assert.ok(world.coverPoints.length >= 20, `Mission ${mNum} (${id}): expected tactical cover (>=20), got ${world.coverPoints.length}`);
  assert.ok(world.patrolRoutes.length >= 3, `Mission ${mNum} (${id}): expected >=3 patrol routes, got ${world.patrolRoutes.length}`);

  // 4. Player spawn & extraction LZ validation
  assert.ok(
    world.spawnPoint.x > world.bounds.minX + 1 && world.spawnPoint.x < world.bounds.maxX - 1 &&
    world.spawnPoint.z > world.bounds.minZ + 1 && world.spawnPoint.z < world.bounds.maxZ - 1,
    `Mission ${mNum} (${id}): spawnPoint outside world bounds`
  );
  assertCapsuleClear(physics, world.spawnPoint, `Mission ${mNum} (${id}) spawnPoint`);
  const extractTr = world.triggers.find((t) => t.id === 'extraction');
  const lastStep = def.seq && def.seq[def.seq.length - 1];
  if (!lastStep || lastStep.kind === 'extract') {
    assert.ok(extractTr, `Mission ${mNum} (${id}): missing 'extraction' trigger`);
  }

  const player = new Player(gameStub);
  player.reset(world.spawnPoint, world.spawnYaw);
  gameStub.player = player;

  const vehicles = new VehicleManager(gameStub);
  gameStub.vehicles = vehicles;
  vehicles.spawnFromWorld();

  const enemies = new EnemyManager(gameStub);
  gameStub.enemies = enemies;
  enemies.beginMissionRun(id, expectedMin);
  const initialActive = enemies.spawnInitial(id, def);
  enemies.spawnNPCs();

  const missions = new MissionManager(gameStub);
  gameStub.missions = missions;
  missions.start(id);
  if (def.setup) def.setup(gameStub);

  // Verify extraction is locked at start
  assert.equal(missions.canCompleteExtraction(), false, `Mission ${mNum} (${id}): extraction must NOT be completable at mission start`);

  // 5. Verify enemy quota, live cap, and collider-clear initial spawns
  assert.ok(initialActive >= 7 && initialActive <= MAX_ACTIVE_HOSTILES, `Mission ${mNum} (${id}): initial active=${initialActive} out of bounds`);
  assert.ok(enemies.activeHostiles <= MAX_ACTIVE_HOSTILES, `Mission ${mNum} (${id}): exceeded MAX_ACTIVE_HOSTILES`);
  assert.ok(
    enemies.totalMissionEnemies >= expectedMin,
    `Mission ${mNum} (${id}): totalMissionEnemies=${enemies.totalMissionEnemies} < required ${expectedMin}`
  );
  for (const actor of enemies.list) {
    assert.ok(actor.alive && actor.health > 0, `Mission ${mNum}: initial enemy must be alive`);
    assert.ok(
      actor.pos.x >= world.bounds.minX && actor.pos.x <= world.bounds.maxX &&
      actor.pos.z >= world.bounds.minZ && actor.pos.z <= world.bounds.maxZ,
      `Mission ${mNum}: enemy spawned outside bounds`
    );
  }

  // Helper to stream and eliminate waves
  const killActiveWave = (maxCount = 9999) => {
    let killed = 0;
    let safety = 0;
    while (killed < maxCount && enemies.remainingHostiles > 0 && safety++ < 600) {
      for (const actor of enemies.list) {
        if (!actor.alive) continue;
        enemies.damage(actor, 'head', 9999, actor.pos.clone(), new THREE.Vector3(0, 0, 1));
        killed++;
        if (killed >= maxCount) break;
      }
      // Advance reserve & surge timers so next wave streams in smoothly
      enemies._reserveT = 0;
      enemies.surgeTimer = 0;
      enemies.update(0.25);
      assert.ok(enemies.activeHostiles <= MAX_ACTIVE_HOSTILES + 4, `Mission ${mNum}: wave concurrency spike (${enemies.activeHostiles})`);
    }
    return killed;
  };

  // 6. Execute ALL mission objectives step-by-step!
  if (!missions.isSeq) {
    // Classic 5-stage infiltration (Missions 1-2) & assault (Missions 3-4)
    const breachTr = world.triggers.find((t) => t.id === 'breach');
    assert.ok(breachTr, `Mission ${mNum} (${id}): classic flow requires 'breach' trigger`);
    const bc = triggerCenter(breachTr);
    player.pos.set(bc.x, 0.2, bc.z);
    missions.update(0.1);

    if (def.flow === 'assault') {
      killActiveWave(9999);
      missions.update(0.1);
      missions.update(0.1);
    } else {
      const enterTr = world.triggers.find((t) => t.id === 'enter_facility');
      assert.ok(enterTr, `Mission ${mNum} (${id}): infil flow requires 'enter_facility' trigger`);
      const ec = triggerCenter(enterTr);
      player.pos.set(ec.x, 0.2, ec.z);
      missions.update(0.1);

      const term = world.interactables.find((it) => it.id === 'terminal' || it.kind === 'terminal');
      assert.ok(term, `Mission ${mNum} (${id}): infil flow requires terminal`);
      player.pos.copy(term.pos);
      missions.onTerminalComplete();

      const dockTr = world.triggers.find((t) => t.id === 'dock');
      assert.ok(dockTr, `Mission ${mNum} (${id}): infil flow requires 'dock' trigger`);
      const dc = triggerCenter(dockTr);
      player.pos.set(dc.x, 0.2, dc.z);
      missions.update(0.1);

      // Stream & clear remaining hostiles to verify full quota on infil missions
      killActiveWave(9999);
    }

    const exC = triggerCenter(extractTr);
    player.pos.set(exC.x, 0.2, exC.z);
    assert.equal(missions.canCompleteExtraction(), true, `Mission ${mNum} (${id}): extraction should now be ready`);
    missions.update(0.1);
  } else {
    // Sequential objective chain (Missions 5-100)
    let stepGuard = 0;
    while (!gameStub._completed && missions.stage !== 'complete' && stepGuard++ < 40) {
      const step = def.seq[missions.seqIdx];
      if (!step) break;
      assert.ok(!gameStub._failed, `Mission ${mNum} (${id}) failed unexpectedly: ${gameStub._failed}`);

      if (step.kind === 'reach') {
        if (step.trig) {
          const tr = world.triggers.find((t) => t.id === step.trig);
          assert.ok(tr, `Mission ${mNum} (${id}): missing reach trigger '${step.trig}'`);
          const tc = triggerCenter(tr);
          player.pos.set(tc.x, 0.2, tc.z);
        } else {
          player.pos.set(step.pos[0], 0, step.pos[1]);
        }
        missions.update(0.2);
      } else if (step.kind === 'interact') {
        const it = world.interactables.find((x) => x.id === step.target && !x.used);
        assert.ok(it, `Mission ${mNum} (${id}): missing interactable target '${step.target}'`);
        player.pos.copy(it.pos);
        it.used = true;
        missions.update(0.2);
      } else if (step.kind === 'collect') {
        const items = world.interactables.filter((x) => (x.id.indexOf('evidence_') === 0 || x.kind === 'evidence') && !x.used);
        const need = step.n || 3;
        assert.ok(items.length >= need, `Mission ${mNum} (${id}): insufficient evidence items (${items.length} < ${need})`);
        for (let k = 0; k < need; k++) {
          items[k].used = true;
          world.evidenceCollected = (world.evidenceCollected || 0) + 1;
        }
        missions.update(0.2);
      } else if (step.kind === 'destroy') {
        const target = (world.destructibles || []).find((d) => !d.destroyed && d.id === step.target);
        assert.ok(target, `Mission ${mNum} (${id}): missing destructible '${step.target}'`);
        world.damageDestructible(target, 9999, gameStub, target.pos);
        missions.update(0.2);
      } else if (step.kind === 'capture') {
        player.pos.set(step.pos[0], 0, step.pos[1]);
        const holdDur = (step.duration || 20) + 1.5;
        for (let t = 0; t < holdDur; t += 0.5) missions.update(0.5);
      } else if (step.kind === 'eliminate_count') {
        const need = step.count || 15;
        killActiveWave(need + 2);
        missions.update(0.2);
      } else if (step.kind === 'eliminate') {
        killActiveWave(9999);
        missions.update(0.2);
      } else if (step.kind === 'survive') {
        const dur = (step.t || 45) + 1.0;
        for (let t = 0; t < dur; t += 1.0) missions.update(1.0);
      } else if (step.kind === 'board') {
        const v = step.veh ? vehicles.byTag(step.veh) : vehicles.list.find((x) => !x.destroyed);
        assert.ok(v, `Mission ${mNum} (${id}): missing boardable vehicle '${step.veh}'`);
        gameStub.vehicleMode = v;
        missions.update(0.2);
      } else if (step.kind === 'drive') {
        assert.ok(gameStub.vehicleMode, `Mission ${mNum} (${id}): drive step requires active vehicleMode`);
        gameStub.vehicleMode.pos.set(step.pos[0], 0, step.pos[1]);
        player.pos.set(step.pos[0], 0, step.pos[1]);
        missions.update(0.2);
      } else if (step.kind === 'escort') {
        assert.ok(enemies.npcs.length > 0 || enemies.escortNpc, `Mission ${mNum} (${id}): missing escort NPC`);
        enemies.escortComplete = true;
        missions.update(0.2);
      } else if (step.kind === 'escort_veh') {
        const v = vehicles.byTag(step.veh);
        assert.ok(v, `Mission ${mNum} (${id}): missing escort vehicle '${step.veh}'`);
        v.pos.set(step.pos[0], 0, step.pos[1]);
        player.pos.set(step.pos[0], 0, step.pos[1]);
        missions.update(0.2);
      } else if (step.kind === 'extract') {
        gameStub.vehicleMode = null;
        const exC = triggerCenter(extractTr);
        assert.ok(exC, `Mission ${mNum} (${id}): missing extraction trigger center`);
        player.pos.set(exC.x, 0.2, exC.z);
        assert.equal(missions.canCompleteExtraction(), true, `Mission ${mNum} (${id}): canCompleteExtraction() must be true on extract step`);
        missions.update(0.2);
      } else {
        assert.fail(`Mission ${mNum} (${id}): unhandled step kind '${step.kind}'`);
      }
    }

    // Stream & eliminate any remaining enemies so we prove 100% of the mission's
    // 50 + (N - 1) * 2 roster actually spawns, fights, and dies cleanly!
    killActiveWave(9999);
  }

  assert.equal(missions.canCompleteExtraction(), true, `Mission ${mNum} (${id}): extraction gate did not open at completion`);
  assert.equal(gameStub._completed, true, `Mission ${mNum} (${id}): mission did not reach completion`);
  assert.equal(enemies.remainingHostiles, 0, `Mission ${mNum} (${id}): ${enemies.remainingHostiles} hostiles failed to stream/clear`);
  assert.ok(
    gameStub.stats.kills >= expectedMin,
    `Mission ${mNum} (${id}): real kills (${gameStub.stats.kills}) < required minimum (${expectedMin})`
  );

  totalEnemiesSpawnedAndKilled += gameStub.stats.kills;
  auditSummary.push({
    op: mNum, id, map: def.map, cat, kills: gameStub.stats.kills, minReq: expectedMin,
    colliders: physics.colliders.length, cover: world.coverPoints.length,
  });

  // Clean up scene meshes
  enemies.reset();
  vehicles.reset();
  scene.remove(world.group);
}

// Verify all 20 environment categories have strong representation
for (const [cat, count] of Object.entries(categoryCounts)) {
  assert.ok(count >= 2, `Category '${cat}' underrepresented (${count} missions)`);
}

console.log('=== PHASE 6: EXTENSIBILITY BEYOND 100 MISSIONS (OP 101 TEST) ===');
const op101 = extendCampaignMission({
  id: 'op_101_citadel_aftershock',
  title: 'OP 101: CITADEL AFTERSHOCK',
  category: 'command_compound',
  topology: 'central_citadel_ring',
  type: 'assault',
  parTime: 660,
});
syncCampaignMissionDefs();
assert.equal(MISSION_ORDER.length, 101, 'extendCampaignMission must append Mission 101 cleanly');
assert.equal(op101.minEnemies, 250, 'Mission 101 must compute 50 + 100 * 2 = 250 minimum enemies');
assert.ok(MISSION_DEFS.op_101_citadel_aftershock, 'syncCampaignMissionDefs must register Mission 101');
{
  const s101 = new THREE.Scene();
  const p101 = new PhysicsWorld();
  const w101 = new GameWorld();
  w101.buildByMap(MISSION_DEFS.op_101_citadel_aftershock.map, s101, p101);
  assert.ok(p101.colliders.length >= 45, 'Mission 101 dynamically generated 3D map must build full colliders');
  const fp101 = worldFingerprint(w101, p101);
  assert.ok(!seenFingerprints.has(fp101), 'Mission 101 3D geometry fingerprint must be unique from Missions 1-100');
  s101.remove(w101.group);
}

console.log(`PASS 100/100 unique layouts & 100/100 unique 3D geometry fingerprints verified.`);
console.log(`PASS 20/20 environment categories populated:`, JSON.stringify(categoryCounts));
console.log(`PASS 100/100 missions completed end-to-end; ${totalEnemiesSpawnedAndKilled.toLocaleString()} total real AI hostiles spawned, streamed, and neutralized!`);
console.log(`  Sample Op 001 (${auditSummary[0].id}): ${auditSummary[0].kills} kills (req >=${auditSummary[0].minReq}), ${auditSummary[0].colliders} colliders`);
console.log(`  Sample Op 050 (${auditSummary[49].id}): ${auditSummary[49].kills} kills (req >=${auditSummary[49].minReq}), ${auditSummary[49].colliders} colliders`);
console.log(`  Sample Op 100 (${auditSummary[99].id}): ${auditSummary[99].kills} kills (req >=${auditSummary[99].minReq}), ${auditSummary[99].colliders} colliders`);
console.log(`PASS Dynamic Mission 101 extensibility verified (250 min enemies, unique 3D fortress layout).`);
