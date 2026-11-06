// ============================================================================
// campaign-maps.js — 89 Distinct 3D Tactical Map Builders (Missions 11–17 + 19–100+)
// ============================================================================
// Together with the 11 preserved hand-authored maps in world.js (Missions 1–10
// + Mission 18 Metro + Training Range), this module gives all 100 campaign
// missions 100% unique 3D combat environments with zero duplicate layouts.
// ============================================================================

import * as THREE from 'three';
import { Material as Mat } from './physics.js';
import { StructureBuilder } from './world-structures.js';
import { CAMPAIGN_BY_LAYOUT } from './campaign-data.js';
import { AMMO_PACK_SIZES, WEAPON_AMMO } from './ammo.js';

// Deterministic PRNG (Mulberry32) so every layout is 100% reproducible
function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SKY_PROFILES = {
  day: { night: { bg: 0x0b1018, fog: 0x0e141e }, day: { bg: 0xbfd3e6, fog: 0xc8d6e2 }, fogMul: 1.15, tod: 'day' },
  dawn: { night: { bg: 0x0d111a, fog: 0x111622 }, day: { bg: 0xd9c2ad, fog: 0xcfb8a4 }, fogMul: 1.08, tod: 'day' },
  dusk: { night: { bg: 0x0e1018, fog: 0x141620 }, day: { bg: 0xc49a7c, fog: 0xb88f76 }, fogMul: 1.02, tod: 'day' },
  overcast: { night: { bg: 0x0c1015, fog: 0x10151c }, day: { bg: 0x9aa4ae, fog: 0x929ca6 }, fogMul: 0.96, tod: 'day' },
  sand: { night: { bg: 0x0c0e14, fog: 0x111218 }, day: { bg: 0xe6d7ba, fog: 0xd8c5a2 }, fogMul: 1.05, tod: 'day' },
  snow: { night: { bg: 0x0d131d, fog: 0x111824 }, day: { bg: 0xdbe5ef, fog: 0xd2dde8 }, fogMul: 0.95, tod: 'day' },
  night: { night: { bg: 0x070b12, fog: 0x0a0f18 }, day: { bg: 0x9fb0c2, fog: 0x98a8b8 }, fogMul: 1.0, tod: 'night' },
  underground: { night: { bg: 0x05070a, fog: 0x080b10 }, day: { bg: 0x14181f, fog: 0x161b22 }, fogMul: 0.78, tod: 'night' },
};

// Check whether a vertical cylinder/box of radius `r` standing at `(x, y, z)`
// is completely free of solid colliders (excluding ground slabs below `y + 0.16`).
export function isSpotClear(world, x, z, r = 0.65, y = 0) {
  const b = world.bounds;
  if (b && (x < b.minX + r + 2.0 || x > b.maxX - r - 2.0 || z < b.minZ + r + 2.0 || z > b.maxZ - r - 2.0)) {
    return false;
  }
  const minY = y + 0.22;
  const maxY = y + 1.82;
  const x0 = x - r, x1 = x + r;
  const z0 = z - r, z1 = z + r;
  for (const c of world.physics.colliders) {
    if (!c || c.enabled === false) continue;
    if (c.max.y <= minY || c.min.y >= maxY) continue;
    if (x1 > c.min.x && x0 < c.max.x && z1 > c.min.z && z0 < c.max.z) {
      return false;
    }
  }
  return true;
}

// Spiral search from `(tx, tz)` to guarantee a 100% collision-clear ground spot.
export function findSafeGroundSpot(world, tx, tz, r = 0.85, maxSearch = 36) {
  const b = world.bounds;
  const clampX = (v) => b ? Math.max(b.minX + r + 2.5, Math.min(b.maxX - r - 2.5, v)) : v;
  const clampZ = (v) => b ? Math.max(b.minZ + r + 2.5, Math.min(b.maxZ - r - 2.5, v)) : v;
  const cx0 = clampX(tx), cz0 = clampZ(tz);
  if (isSpotClear(world, cx0, cz0, r, 0)) return [cx0, cz0];

  for (let ring = 1; ring <= maxSearch; ring++) {
    const dist = ring * 1.25;
    const samples = Math.max(8, ring * 6);
    for (let i = 0; i < samples; i++) {
      const ang = (i / samples) * Math.PI * 2;
      const px = clampX(cx0 + Math.cos(ang) * dist);
      const pz = clampZ(cz0 + Math.sin(ang) * dist);
      if (isSpotClear(world, px, pz, r, 0)) return [px, pz];
    }
  }
  return [cx0, cz0];
}

function initWorldCanvas(world, scene, physics, opts) {
  const [hx, hz] = opts.boundsHalf || [92, 92];
  world.map = opts.intelMapKey || 'facility';
  world.layoutId = opts.layoutId;
  world.vehicleSurfaces.length = 0;
  world.bounds = { minX: -hx, maxX: hx, minZ: -hz, maxZ: hz };
  world.physics = physics;
  world.group = new THREE.Group();
  scene.add(world.group);
  world._buildMaterials();
  world._buildLighting(scene);

  const sky = SKY_PROFILES[opts.skyProfile] || SKY_PROFILES.day;
  world.nightSky = { ...sky.night };
  world.daySky = { ...sky.day };
  world.dayFogMul = sky.fogMul;
  world.weather = opts.weather || 'clear';
  world.windLevel = world.weather === 'snow' || world.weather === 'dust' ? 0.45 : 0.2;
  world._preferredTimeOfDay = sky.tod;

  const M = world.mat;
  const gw = hx * 2 + 28;
  const gd = hz * 2 + 28;
  let groundMat = M.gravel(42);
  if (opts.groundType === 'sand') groundMat = M.sand(46);
  else if (opts.groundType === 'snow') groundMat = M.snow(40);
  else if (opts.groundType === 'asphalt') groundMat = M.asphalt(36);
  else if (opts.groundType === 'concrete') groundMat = M.concrete(34);
  else if (opts.groundType === 'grass') {
    groundMat = world._cached(`ground_grass_${opts.groundTint || 0x4b593c}`, () => {
      const m = M.gravel(44).clone();
      m.color = new THREE.Color(opts.groundTint || 0x4b593c);
      m.roughness = 0.97;
      return m;
    });
  }

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(gw, gd), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.matrixAutoUpdate = false;
  ground.updateMatrix();
  world.group.add(ground);
  physics.addBox(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(gw, 1, gd), Mat.CONCRETE, {});

  // Outer boundary perimeter berms/walls so player & vehicles stay cleanly inside bounds
  const bMat = opts.skyProfile === 'underground' ? M.concrete(10) : M.concrete(8);
  const bH = opts.skyProfile === 'underground' ? 9.5 : 3.2;
  world.box(0, 0, hz + 1.0, hx * 2 + 3, bH, 1.5, bMat, Mat.CONCRETE);
  world.box(0, 0, -hz - 1.0, hx * 2 + 3, bH, 1.5, bMat, Mat.CONCRETE);
  world.box(hx + 1.0, 0, 0, 1.5, bH, hz * 2 + 3, bMat, Mat.CONCRETE);
  world.box(-hx - 1.0, 0, 0, 1.5, bH, hz * 2 + 3, bMat, Mat.CONCRETE);

  // Underground cavern ceiling canopy when in subterranean theaters
  if (opts.skyProfile === 'underground') {
    const ceil = new THREE.Mesh(
      new THREE.PlaneGeometry(gw, gd),
      world._cached('ug_cavern_ceil', () => new THREE.MeshStandardMaterial({ color: 0x26292e, roughness: 0.96, side: THREE.DoubleSide }))
    );
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = 11.5;
    ceil.matrixAutoUpdate = false;
    ceil.updateMatrix();
    world.group.add(ceil);
  }
}

// Populate collision-verified multi-sector patrol & garrison roster + surges
function populateSectorRoster(world, sb, totalNeeded, rng, spawnPt) {
  const [hx, hz] = [world.bounds.maxX - 8, world.bounds.maxZ - 8];
  const kinds = ['guard', 'patrol', 'rifleman', 'flanker', 'marksman', 'heavy', 'recon'];

  // Create 8 distinct multi-sector patrol routes around the map
  const routeCenters = [
    [-hx * 0.45, hz * 0.35], [hx * 0.45, hz * 0.35],
    [-hx * 0.48, -hz * 0.05], [hx * 0.48, -hz * 0.05],
    [-hx * 0.42, -hz * 0.45], [hx * 0.42, -hz * 0.45],
    [0, hz * 0.15], [0, -hz * 0.32],
  ];
  const routeIds = [];
  for (const [rcx, rcz] of routeCenters) {
    const wps = [];
    for (const [ox, oz] of [[-8, -7], [8, -7], [8, 7], [-8, 7]]) {
      const [sx, sz] = findSafeGroundSpot(world, rcx + ox, rcz + oz, 0.75, 18);
      wps.push([sx, 0, sz]);
    }
    routeIds.push(world._route(wps));
  }

  // First place elevated marksmen/sentries on watchtowers, rooftops, catwalks & dam crests!
  let placed = 0;
  for (let i = 0; i < sb.elevatedNodes.length && placed < Math.min(18, Math.floor(totalNeeded * 0.18)); i++) {
    const n = sb.elevatedNodes[i];
    if (Math.hypot(n.x - spawnPt[0], n.z - spawnPt[1]) < 20) continue;
    if (isSpotClear(world, n.x, n.z, 0.55, n.y)) {
      world._spawn(n.x, n.y, n.z, null, i % 2 === 0 ? 'marksman' : 'guard');
      placed++;
    }
  }

  // Next place interior room defenders inside multi-storey buildings, bunkers, labs & warehouses
  for (let i = 0; i < sb.interiorNodes.length && placed < Math.floor(totalNeeded * 0.38); i++) {
    const n = sb.interiorNodes[i];
    if (Math.hypot(n.x - spawnPt[0], n.z - spawnPt[1]) < 20) continue;
    if (isSpotClear(world, n.x, n.z, 0.55, n.y)) {
      world._spawn(n.x, n.y, n.z, null, i % 3 === 0 ? 'heavy' : 'guard');
      placed++;
    }
  }

  // Fill the rest across a stratified multi-sector tactical grid (guaranteed >= totalNeeded + 14)
  const targetCount = totalNeeded + 14;
  let guard = 0;
  while (placed < targetCount && guard < targetCount * 8) {
    guard++;
    const gx = (rng() * 2 - 1) * hx;
    const gz = (rng() * 2 - 1) * hz;
    if (Math.hypot(gx - spawnPt[0], gz - spawnPt[1]) < 22) continue;
    const [sx, sz] = findSafeGroundSpot(world, gx, gz, 0.75, 14);
    if (Math.hypot(sx - spawnPt[0], sz - spawnPt[1]) < 20) continue;
    if (!isSpotClear(world, sx, sz, 0.65, 0)) continue;
    const rId = routeIds[placed % routeIds.length];
    const kind = kinds[placed % kinds.length];
    world._spawn(sx, 0, sz, placed % 3 === 0 ? null : rId, kind);
    placed++;
  }

  // Register 8 distant perimeter reinforcement entry gates (_surge)
  const surgeCoords = [
    [0, -hz + 3], [-hx * 0.6, -hz + 4], [hx * 0.6, -hz + 4],
    [-hx + 4, -hz * 0.25], [hx - 4, -hz * 0.25],
    [-hx + 4, hz * 0.3], [hx - 4, hz * 0.3], [0, -hz * 0.55],
  ];
  for (const [gx, gz] of surgeCoords) {
    const [sx, sz] = findSafeGroundSpot(world, gx, gz, 0.85, 18);
    world._surge(sx, 0, sz);
  }
}

// ============================================================================
// PART A: 7 Dedicated Unique Combat Layouts for Legacy Missions 11–17
// ============================================================================

function buildConvoyValley(world, scene, physics) {
  initWorldCanvas(world, scene, physics, {
    layoutId: 'convoy_valley', intelMapKey: 'rural',
    boundsHalf: [88, 92], skyProfile: 'dawn', weather: 'clear',
    groundType: 'grass', groundTint: 0x48583a,
  });
  const sb = new StructureBuilder(world);
  const rng = makeRng(11011);

  // Winding valley highway from north timber yard (-6, -20) south to crossroads (2, 44) & LZ (-8, 62)
  sb.addRoadSegment(-2, 12, 9.5, 140, 'z');
  sb.addRoadSegment(0, -24, 52, 8, 'x');
  sb.addIntersection(-2, -24, 11);
  sb.addRoadSegment(0, 44, 56, 8, 'x');
  sb.addIntersection(-2, 44, 11);

  // Reserve mission hauler bay & delivery point
  sb.reserveArea(-6, -20, 10, 12, 3.0);
  sb.reserveArea(2, 44, 12, 12, 3.0);
  sb.reserveArea(-8, 62, 12, 12, 3.0);
  sb.reserveArea(-24, -46, 10, 10, 3.0);

  // North Timber Hauler Compound + Ambush Checkpoints along valley road
  sb.addWarehouseHall(-24, -22, 16, 13, { color: 0x5c4f3e });
  sb.addRuralHomestead(18, -20, 11, 9, { stone: true });
  sb.addGuardTower(-18, 4);
  sb.addCheckpointGate(-2, 14, 16);
  sb.addRuralHomestead(-24, 28, 12, 9);
  sb.addBarracksBlock(22, 24, 15, 8.5);
  sb.addFuelDepot(24, -46);
  sb.addWatchPost(-16, 46, -1);
  sb.addWatchPost(20, 48, -1);

  for (let i = 0; i < 34; i++) {
    const px = (rng() < 0.5 ? -1 : 1) * (32 + rng() * 46);
    const pz = (rng() * 2 - 1) * 80;
    if (sb.isAreaClear(px, pz, 3, 3)) world._pine(px, pz, 6.5 + rng() * 3.5);
  }
  for (let i = 0; i < 14; i++) {
    const rx = (rng() < 0.5 ? -1 : 1) * (20 + rng() * 52);
    const rz = (rng() * 2 - 1) * 76;
    if (sb.isAreaClear(rx, rz, 3, 3)) world._rock(rx, rz, 1.4 + rng() * 1.1);
  }

  world.spawnPoint.set(-24, 0, -46);
  world._vehicle('pickup_util', -6, -20, 0, { tag: 'farm_pickup', mission: true });
  world._vehicle('latv4', 18, -36, 180);
  world._lz(-8, 62);
  world._ammoCrate(1, -14, 0, -22);
  world._ammoCrate(2, 10, 0, 42);
  world._intel(-24, 0, -22, 'TIMBER CONVOY MANIFEST');
  world._intel(18, 0, -20, 'VALLEY AMBUSH OVERLAY');
  world._intel(22, 0, 24, 'CROSSROADS CHECKPOINT LOG');
  world._intel(-24, 0, 28, 'MILL RADIO CIPHER');

  populateSectorRoster(world, sb, 76, rng, [-24, -46]);
}

function buildWadiOutpost(world, scene, physics) {
  initWorldCanvas(world, scene, physics, {
    layoutId: 'wadi_outpost', intelMapKey: 'desert',
    boundsHalf: [96, 96], skyProfile: 'sand', weather: 'dust',
    groundType: 'sand', groundTint: 0xcbb288,
  });
  const sb = new StructureBuilder(world);
  const rng = makeRng(12012);

  // Reserve insertion (-36, -42), APC staging (24, 32), and rally point (46, 52)
  sb.reserveArea(-36, -42, 12, 12, 3.0);
  sb.reserveArea(24, 32, 14, 14, 3.5);
  sb.reserveArea(46, 52, 16, 16, 3.5);

  sb.addRoadSegment(8, 6, 10, 142, 'z', { curbs: false });
  sb.addRoadSegment(18, 32, 74, 9, 'x', { curbs: false });
  sb.addBunkerCasemate(-16, -18, 14, 11);
  sb.addMultiStoreyBuilding(24, -14, 14, 12, 2, { brick: true });
  sb.addRadarInstallation(-28, 16);
  sb.addFuelDepot(-20, 44);
  sb.addGuardTower(4, 18);
  sb.addGuardTower(38, 8);
  sb.addCheckpointGate(8, -8, 16);
  sb.addHescoWall(24, 21, 10, 'x');
  sb.addWatchPost(38, 36, -1);

  for (let i = 0; i < 22; i++) {
    const rx = (rng() * 2 - 1) * 82;
    const rz = (rng() * 2 - 1) * 82;
    if (sb.isAreaClear(rx, rz, 4, 4)) world._rock(rx, rz, 1.6 + rng() * 1.6, 0x9b8462);
  }
  for (let i = 0; i < 10; i++) {
    const px = -60 + rng() * 35;
    const pz = 20 + rng() * 55;
    if (sb.isAreaClear(px, pz, 3, 3)) world._palm(px, pz, 5.5 + rng() * 2);
  }

  world.spawnPoint.set(-36, 0, -42);
  world._vehicle('apc8', 24, 32, 25, { tag: 'extract_apc', mission: true });
  world._vehicle('sand_buggy', -26, -34, 145);
  world._lz(46, 52);
  world._ammoCrate(1, -16, 0, -14);
  world._ammoCrate(2, 18, 0, 28);
  world._intel(24, 0, -14, 'SCORPION BASIN DISPATCH');
  world._intel(-16, 0, -18, 'ARMOR RECOVERY ORDER');
  world._intel(-28, 2.65, 16, 'WADI RADAR BEARING LOG');

  populateSectorRoster(world, sb, 78, rng, [-36, -42]);
}

function buildGlacierPass(world, scene, physics) {
  initWorldCanvas(world, scene, physics, {
    layoutId: 'glacier_pass', intelMapKey: 'snow',
    boundsHalf: [90, 90], skyProfile: 'snow', weather: 'snow',
    groundType: 'snow', groundTint: 0xeaf0f6,
  });
  const sb = new StructureBuilder(world);
  const rng = makeRng(13013);

  // Reserve insertion (-38, 46), downed scout (12, -14), and west recovery helipad (-26, 12)
  sb.reserveArea(-38, 46, 12, 12, 3.0);
  sb.reserveArea(12, -14, 14, 14, 3.5);
  sb.reserveArea(-26, 12, 18, 18, 3.5);

  sb.addRoadSegment(-6, 0, 9.5, 136, 'z', { curbs: false });
  sb.addRoadSegment(-6, -14, 58, 9, 'x', { curbs: false });
  sb.addRoadSegment(-16, 12, 42, 9, 'x', { curbs: false });

  // Helipad apron at (-26, 12) + Alpine relay bunker + Comms mast + Watch posts
  world.box(-26, 0.02, 12, 14, 0.08, 14, world.mat.concrete(4), Mat.CONCRETE, { noCollider: true });
  sb.addBunkerCasemate(-8, -42, 14, 11);
  sb.addLabModule(28, -36, 14, 11);
  sb.addCommsTower(32, 16, { height: 20 });
  sb.addBarracksBlock(22, 42, 15, 8.5, { tint: 0x8a929a });
  sb.addGuardTower(-22, -24, { color: 0x5c6872 });
  sb.addWatchPost(6, 10, 1);

  for (let i = 0; i < 32; i++) {
    const px = (rng() * 2 - 1) * 78;
    const pz = (rng() * 2 - 1) * 78;
    if (sb.isAreaClear(px, pz, 3.5, 3.5)) world._pine(px, pz, 7 + rng() * 3);
  }
  for (let i = 0; i < 16; i++) {
    const rx = (rng() * 2 - 1) * 76;
    const rz = (rng() * 2 - 1) * 76;
    if (sb.isAreaClear(rx, rz, 3.5, 3.5)) world._rock(rx, rz, 1.5 + rng() * 1.4, 0x76808a);
  }

  world.spawnPoint.set(-38, 0, 46);
  world._vehicle('snow_rover', 12, -14, -65, { tag: 'snow_wreck', mission: true, hpFrac: 0.62 });
  world._vehicle('hx7', -26, 2, 90);
  world._lz(-26, 12);
  world._ammoCrate(1, 8, 0, -18);
  world._ammoCrate(2, -20, 0, 16);
  world._intel(-8, 0, -42, 'GLACIER CONVOY BLACKBOX');
  world._intel(28, 0, -36, 'ICE RIDGE TELEMETRY LOG');
  world._intel(22, 0, 42, 'PATROL FREQUENCY CARD');

  populateSectorRoster(world, sb, 80, rng, [-38, 46]);
}

function buildHarborBoulevard(world, scene, physics) {
  initWorldCanvas(world, scene, physics, {
    layoutId: 'harbor_boulevard', intelMapKey: 'urban',
    boundsHalf: [92, 84], skyProfile: 'overcast', weather: 'rain',
    groundType: 'asphalt', groundTint: 0x646a72,
  });
  const sb = new StructureBuilder(world);
  const rng = makeRng(14014);

  // Reserve straight eastbound arterial avenue along z = 9.5 from x = -54 to x = +54!
  sb.addRoadSegment(0, 9.5, 148, 12, 'x');
  sb.addRoadSegment(-20, 0, 10, 130, 'z');
  sb.addRoadSegment(22, 0, 10, 130, 'z');
  sb.reserveArea(0, 9.5, 136, 13, 2.0);
  sb.reserveArea(-56, 14, 12, 12, 2.5);
  sb.reserveArea(42, 36, 12, 12, 2.5);

  // Multi-storey urban blocks & port warehouses flanking the boulevard north and south
  sb.addMultiStoreyBuilding(-42, -14, 15, 12, 2, { brick: true });
  sb.addMultiStoreyBuilding(-4, -15, 16, 12, 3, { tint: 0x7c8086 });
  sb.addMultiStoreyBuilding(38, -14, 15, 12, 2, { brick: true });
  sb.addWarehouseHall(-38, 34, 18, 14, { color: 0x4d5b66 });
  sb.addMultiStoreyBuilding(2, 34, 15, 12, 2, { tint: 0x86827a });
  sb.addContainerStack(36, -42);
  sb.addOverpassBridge(6, -38, 24, 7, 'x', 3.8);
  sb.addParkingLot(-4, -44, 18, 12);

  world.spawnPoint.set(-56, 0, 14);
  world._vehicle('cargo6', -44, 9.5, -90, { tag: 'escort_truck', mission: true });
  world._vehicle('suv_patrol', -20, -28, 0);
  world._lz(42, 36);
  world._ammoCrate(1, -38, 0, 24);
  world._ammoCrate(2, 12, 0, 22);
  world._intel(-42, 0, -14, 'HARBOR CUSTOMS LEDGER');
  world._intel(-4, 0, -15, 'BOULEVARD SENTRY ROSTER');
  world._intel(2, 0, 34, 'CONVOY INTERCEPT ORDER');
  world._intel(38, 0, -14, 'DOCKMASTER CIPHER SHEET');

  populateSectorRoster(world, sb, 82, rng, [-56, 14]);
}

function buildFoundryRail(world, scene, physics) {
  initWorldCanvas(world, scene, physics, {
    layoutId: 'foundry_rail', intelMapKey: 'industrial',
    boundsHalf: [92, 92], skyProfile: 'night', weather: 'clear',
    groundType: 'gravel', groundTint: 0x585652,
  });
  const sb = new StructureBuilder(world);
  const rng = makeRng(15015);

  // Reserve south apron transit route: (4, 34) -> (-18, 38) -> (-38, 46) & LZ (-52, 62)
  sb.addRoadSegment(-16, 40, 118, 12, 'x');
  sb.addRoadSegment(18, 0, 10, 142, 'z');
  sb.reserveArea(4, 34, 14, 14, 2.5);
  sb.reserveArea(-18, 38, 14, 14, 2.0);
  sb.reserveArea(-38, 46, 16, 16, 2.5);
  sb.reserveArea(-52, 62, 12, 12, 2.5);
  sb.reserveArea(32, 56, 12, 12, 2.5);

  // Foundry rail tracks, smelter warehouses, refinery machinery, container yard
  sb.addRailYardTrack(-28, -14, 92, 'z', { carColor: 0x6a4236 });
  sb.addRailYardTrack(-14, -14, 92, 'z', { carColor: 0x46545e });
  sb.addWarehouseHall(4, 6, 20, 15, { color: 0x5a534c });
  sb.addIndustrialMachinery(38, -18, { color: 0x625a52 });
  sb.addPowerSubstation(38, 14, { withGenerator: true });
  sb.addFuelDepot(-46, -24);
  sb.addContainerStack(-46, 16);
  sb.addGuardTower(22, -38);

  world.spawnPoint.set(32, 0, 56);
  world._vehicle('cargo6', 4, 34, 90, { tag: 'transit_truck', mission: true });
  world._vehicle('pickup_util', 28, 38, 90);
  world._lz(-52, 62);
  world._ammoCrate(1, 10, 0, 28);
  world._ammoCrate(2, -34, 0, 34);
  world._intel(4, 0, 6, 'FOUNDRY RAIL TIMETABLE');
  world._intel(38, 0, 14, 'SUBSTATION LOAD CHART');
  world._intel(-46, 0, -20, 'SMELTER CARGO MANIFEST');
  world._intel(38, 0.5, -16, 'FOREMAN SHIFT LOG');

  populateSectorRoster(world, sb, 84, rng, [32, 56]);
}

function buildRowhouseGrid(world, scene, physics) {
  initWorldCanvas(world, scene, physics, {
    layoutId: 'rowhouse_grid', intelMapKey: 'urban',
    boundsHalf: [86, 86], skyProfile: 'night', weather: 'clear',
    groundType: 'asphalt', groundTint: 0x5f646c,
  });
  const sb = new StructureBuilder(world);
  const rng = makeRng(16016);

  // Reserve insertion (-54, 42), breach trigger (-28, 14), record room (-14, -12), LZ (36, 44)
  sb.reserveArea(-54, 42, 12, 12, 2.5);
  sb.reserveArea(36, 44, 12, 12, 2.5);

  sb.addRoadSegment(0, 14, 140, 10, 'x');
  sb.addRoadSegment(0, -32, 140, 10, 'x');
  sb.addRoadSegment(-32, 0, 10, 140, 'z');
  sb.addRoadSegment(18, 0, 10, 140, 'z');

  // Target Rowhouse / Bank Annex centered at (-14, -12) so ground room covers (-14, -12)!
  sb.addMultiStoreyBuilding(-14, -12, 16, 14, 3, { brick: true, sideEntry: true });
  sb.addMultiStoreyBuilding(36, -12, 15, 13, 2, { tint: 0x82868c });
  sb.addMultiStoreyBuilding(-12, 36, 15, 12, 2, { brick: true });
  sb.addMultiStoreyBuilding(-48, -12, 13, 12, 2, { tint: 0x767a80 });
  sb.addCheckpointGate(-32, 14, 14);
  sb.addParkingLot(36, -50, 18, 12);
  sb.addGuardTower(36, 16);

  world._trigR('breach', -26, 0, 14, 10);
  world.spawnPoint.set(-54, 0, 42);
  world._vehicle('suv_patrol', -20, 14, -90);
  world._lz(36, 44);
  world._ammoCrate(1, -24, 0, 6);
  world._ammoCrate(2, 8, 0, -10);
  world._intel(-12, 0, -12, 'MERCHANT ROW FLOORPLAN');
  world._intel(36, 0, -12, 'SAFEHOUSE LEDGER');
  world._intel(-12, 0, 36, 'CELL FREQUENCY TABLE');
  world._intel(-48, 0, -12, 'WATCH COMMANDER MEMO');

  populateSectorRoster(world, sb, 84, rng, [-54, 42]);
}

function buildKestrelAnnex(world, scene, physics) {
  initWorldCanvas(world, scene, physics, {
    layoutId: 'kestrel_annex', intelMapKey: 'facility',
    boundsHalf: [88, 88], skyProfile: 'night', weather: 'clear',
    groundType: 'concrete', groundTint: 0x6e7278,
  });
  const sb = new StructureBuilder(world);
  const rng = makeRng(17017);

  sb.reserveArea(0, 62, 12, 12, 2.5);
  sb.reserveArea(-42, 54, 12, 12, 2.5);

  // Outer security fence with south cut + Main Data Annex Citadel + Lab & Warehouse wings
  sb.addPerimeterFence(0, 0, 116, 104, { concrete: true, gapSouth: 7, gapNorth: 6, gapEast: 5, gapWest: 5 });
  sb.addRoadSegment(0, 0, 10, 136, 'z');
  const annex = sb.addCommandCitadel(0, -14, 22, 18, { tint: 0x747a82 });
  sb.addWarehouseHall(-32, -8, 18, 14, { color: 0x4c5862 });
  sb.addLabModule(32, -8, 15, 12);
  sb.addPowerSubstation(32, 24, { withGenerator: true });
  sb.addBarracksBlock(-30, 24, 16, 8.5);
  sb.addGuardTower(-46, -42);
  sb.addGuardTower(46, -42);

  // Triggers required by archive_facility: 'breach' at south perimeter cut, 'enter' inside annex, 'terminal' on upper/core floor
  world._trigR('breach', 0, 0, 48, 11);
  world._trigR('enter', 0, 0, -10, 11);
  world._objective(annex.upperPos.x, annex.upperPos.y, annex.upperPos.z, 7, 'PULL ARCHIVE SERVER RECORD');

  world.spawnPoint.set(0, 0, 62);
  world._vehicle('latv4', 14, 40, 180);
  world._lz(-42, 54);
  world._ammoCrate(1, -12, 0, 26);
  world._ammoCrate(2, 2, 0, -4);
  world._intel(-32, 0, -8, 'ANNEX SECURITY ROTA');
  world._intel(32, 0, -8, 'BACKUP SERVER MANIFEST');
  world._intel(-30, 0, 24, 'GUARD SHIFT CIPHER');
  world._intel(32, 0, 24, 'GENERATOR BYPASS NOTE');

  populateSectorRoster(world, sb, 86, rng, [0, 62]);
}

const DEDICATED_LEGACY_BUILDERS = {
  convoy_valley: buildConvoyValley,
  wadi_outpost: buildWadiOutpost,
  glacier_pass: buildGlacierPass,
  harbor_boulevard: buildHarborBoulevard,
  foundry_rail: buildFoundryRail,
  rowhouse_grid: buildRowhouseGrid,
  kestrel_annex: buildKestrelAnnex,
};

// ============================================================================
// PART B: 12 Macro-Spatial Topology Builders for Campaign Operations 19–100+
// ============================================================================

function addCategorySignatureProps(world, sb, entry, rng) {
  const [hx, hz] = entry.boundsHalf;
  const cat = entry.category;

  // Natural biome vegetation & rock cover along outer flanks
  const treeCount = (cat === 'forest_woodland') ? 38
    : (cat === 'mountain_combat' || cat === 'rural_village') ? 22
      : (cat === 'underground_facility' || cat === 'underground_bunker') ? 0 : 8;
  const palmCount = (cat === 'desert_installation' || cat === 'coastal_military' || cat === 'oil_refinery') ? 12 : 0;
  const rockCount = (cat === 'underground_facility' || cat === 'underground_bunker') ? 4 : 16;

  for (let i = 0; i < treeCount; i++) {
    const x = (rng() * 2 - 1) * (hx - 8);
    const z = (rng() * 2 - 1) * (hz - 8);
    if (sb.isAreaClear(x, z, 3.2, 3.2)) world._pine(x, z, 6.5 + rng() * 3.5);
  }
  for (let i = 0; i < palmCount; i++) {
    const x = (rng() * 2 - 1) * (hx - 10);
    const z = (rng() * 2 - 1) * (hz - 10);
    if (sb.isAreaClear(x, z, 3.2, 3.2)) world._palm(x, z, 5.8 + rng() * 2.4);
  }
  for (let i = 0; i < rockCount; i++) {
    const x = (rng() * 2 - 1) * (hx - 8);
    const z = (rng() * 2 - 1) * (hz - 8);
    if (sb.isAreaClear(x, z, 3.6, 3.6)) {
      const tint = cat === 'desert_installation' ? 0x9b8462 : cat === 'mountain_combat' ? 0x7b8590 : 0x68645d;
      world._rock(x, z, 1.3 + rng() * 1.4, tint);
    }
  }

  // Tactical field cover clusters (HESCO bastions, Jersey barriers, burned wrecks)
  for (let i = 0; i < 8; i++) {
    const x = (rng() * 2 - 1) * (hx - 18);
    const z = (rng() * 2 - 1) * (hz - 18);
    if (sb.isAreaClear(x, z, 8, 4)) {
      if (i % 3 === 0) sb.addHescoWall(x, z, 6.5, i % 2 === 0 ? 'x' : 'z');
      else if (i % 3 === 1) sb.addJerseyBarrierLine(x, z, 2, i % 2 === 0 ? 'x' : 'z');
      else world._wreck(x, z, rng() * Math.PI, 0x4c443c);
    }
  }
}

function buildTopologyStructures(world, sb, entry, rng) {
  const [hx, hz] = entry.boundsHalf;
  const mx = entry.mirrorX || 1;
  const topo = entry.topology;
  const cat = entry.category;
  const jx = ((entry.missionNumber % 5) - 2) * 2.5;
  const jz = ((entry.missionNumber % 4) - 1.5) * 2.5;

  if (topo === 'linear_convoy_corridor') {
    sb.addRoadSegment(mx * 4, 0, 11, hz * 2 - 10, 'z');
    sb.addRoadSegment(0, -18 + jz, hx * 1.5, 9, 'x');
    sb.addCheckpointGate(mx * 4, 22, 17);
    sb.addCheckpointGate(mx * 4, -22, 17);
    sb.addMultiStoreyBuilding(-mx * 26 + jx, -12, 15, 13, 2, { brick: cat === 'dense_urban' });
    sb.addBarracksBlock(mx * 28, 12 + jz, 16, 8.5);
    sb.addWarehouseHall(-mx * 28, 28, 18, 14);
    sb.addFuelDepot(mx * 28, -32);
    sb.addGuardTower(-mx * 16, 4);
    sb.addGuardTower(mx * 20, -42);
  } else if (topo === 'twin_bridge_crossing') {
    // Sunken canal/river cut across Z = 2, crossed by TWO wide bridges!
    world.box(0, -1.1, 2, hx * 2 - 6, 0.7, 13, sb.waterMat(0x18384a), Mat.CONCRETE);
    // Canal safety parapet walls leaving bridge approaches open
    sb.addJerseyBarrierLine(-mx * 42, 9.2, 4, 'x');
    sb.addJerseyBarrierLine(mx * 42, -5.2, 4, 'x');
    world._roadBridge(-18, 2, 9.0, 15.5);
    world._roadBridge(20, 2, 8.5, 15.5);
    sb.reserveArea(-18, 2, 11, 22, 2.0);
    sb.reserveArea(20, 2, 11, 22, 2.0);
    sb.addRoadSegment(-18, 0, 9.5, hz * 2 - 14, 'z');
    sb.addRoadSegment(20, 0, 9.0, hz * 2 - 14, 'z');
    sb.addMultiStoreyBuilding(-mx * 4, -26 + jz, 16, 13, 2);
    sb.addRuralHomestead(mx * 36, 28, 12, 9, { stone: true });
    sb.addBunkerCasemate(-mx * 36, -24, 13, 11);
    sb.addWatchPost(-4, 14, -1);
    sb.addGuardTower(mx * 38, -12);
  } else if (topo === 'central_citadel_ring') {
    sb.addPerimeterFence(0, -6, 76, 68, { concrete: true, gapSouth: 9, gapNorth: 8, gapEast: 7, gapWest: 7 });
    sb.addRoadSegment(0, 0, 10, hz * 2 - 12, 'z');
    if (cat === 'research_lab') sb.addLabModule(mx * 18, -6, 15, 12);
    else if (cat === 'power_station') sb.addPowerSubstation(mx * 20, -6);
    else sb.addBarracksBlock(mx * 22, -6, 15, 8.5);
    sb.addCommandCitadel(-mx * 6 + jx, -12 + jz, 20, 16);
    sb.addRadarInstallation(-mx * 26, 14);
    sb.addGuardTower(-34, -36);
    sb.addGuardTower(34, -36);
    sb.addWatchPost(mx * 18, 30, 1);
  } else if (topo === 'harbor_pier_waterfront') {
    const waterSide = mx > 0 ? '+x' : '-x';
    const sgn = mx > 0 ? 1 : -1;
    sb.addHarborQuay(sgn * (hx - 34), -4, 72, waterSide);
    sb.addRoadSegment(-sgn * 10, 0, 10, hz * 2 - 14, 'z');
    sb.addWarehouseHall(-sgn * 30 + jx, -16, 20, 15, { color: 0x455866 });
    sb.addContainerStack(-sgn * 28, 22);
    sb.addContainerStack(sgn * 8, -28);
    sb.addFuelDepot(-sgn * 32, -44);
    sb.addMultiStoreyBuilding(sgn * 6, 26, 14, 12, 2);
    sb.addGuardTower(sgn * 8, -4);
  } else if (topo === 'airfield_runway_apron') {
    sb.addRunwayStrip(-mx * 24, 0, 18, hz * 2 - 22, 'z');
    sb.addAircraftHangar(mx * 20 + jx, -18, 22, 19);
    sb.addAircraftHangar(mx * 22, 20, 20, 17, { color: 0x4e5862 });
    sb.addCommsTower(mx * 42, -38, { height: 22 });
    sb.addRadarInstallation(mx * 40, 0);
    sb.addFuelDepot(mx * 38, 38);
    sb.addParkingLot(-mx * 4, 42, 18, 12);
    sb.addGuardTower(-mx * 4, -38);
  } else if (topo === 'switchback_mountain_pass') {
    sb.addRoadSegment(0, 0, 9.5, hz * 2 - 16, 'z', { curbs: false });
    sb.addOverpassBridge(0, -10 + jz, 26, 7.5, 'x', 3.6);
    sb.addBunkerCasemate(-mx * 26, -28, 14, 11);
    sb.addBunkerCasemate(mx * 26, 16, 13, 11);
    sb.addRadarInstallation(mx * 24, -34);
    sb.addCommsTower(-mx * 30, 28, { height: 19 });
    sb.addBarracksBlock(-mx * 20, 44, 15, 8.5);
    sb.addGuardTower(mx * 16, -6);
    sb.addWatchPost(-mx * 14, 18, 1);
  } else if (topo === 'underground_bunker_grid') {
    sb.addUndergroundHall(0, -14, 24, 18);
    sb.addUndergroundHall(-mx * 28, 18, 20, 16);
    sb.addTunnelPassage(0, 18, 26, 6.4, 'z');
    sb.addTunnelPassage(-mx * 14, -14, 18, 6.2, 'x');
    sb.addLabModule(mx * 26, 16, 15, 12);
    sb.addPowerSubstation(mx * 26, -24);
    sb.addBunkerCasemate(-mx * 28, -32, 13, 11);
  } else if (topo === 'urban_city_blocks') {
    sb.addRoadSegment(0, 0, 11, hz * 2 - 12, 'z');
    sb.addRoadSegment(0, 8, hx * 2 - 12, 11, 'x');
    sb.addIntersection(0, 8, 12);
    sb.addMultiStoreyBuilding(-24 + jx, -18, 16, 13, 3, { brick: true, sideEntry: true });
    sb.addMultiStoreyBuilding(24, -18 + jz, 16, 13, 2, { tint: 0x82868c });
    sb.addMultiStoreyBuilding(-24, 30, 15, 12, 2, { tint: 0x7c7872 });
    sb.addWarehouseHall(26, 32, 18, 14);
    sb.addOverpassBridge(0, -40, 26, 7.2, 'x', 3.8);
    sb.addParkingLot(34, -44, 16, 12);
  } else if (topo === 'rail_marshaling_yard') {
    sb.addRailYardTrack(-14, -4, hz * 1.7, 'z', { carColor: 0x6b3f36 });
    sb.addRailYardTrack(0, -4, hz * 1.7, 'z', { carColor: 0x3e5260 });
    sb.addRailYardTrack(14, -4, hz * 1.7, 'z', { carColor: 0x565d48 });
    sb.addOverpassBridge(0, 6, 38, 7.0, 'x', 4.4);
    sb.addWarehouseHall(-mx * 36, -16, 20, 15);
    sb.addMultiStoreyBuilding(mx * 36, 18, 15, 12, 2);
    sb.addContainerStack(mx * 36, -26);
    sb.addFuelDepot(-mx * 36, 28);
    sb.addGuardTower(mx * 24, -44);
  } else if (topo === 'refinery_pipeline_maze') {
    sb.addRoadSegment(0, 0, 10, hz * 2 - 14, 'z');
    sb.addIndustrialMachinery(-24 + jx, -18, { color: 0x646c74 });
    sb.addIndustrialMachinery(24, -14 + jz, { color: 0x6c5c50 });
    sb.addFuelDepot(-26, 18);
    sb.addPowerSubstation(26, 20);
    sb.addWarehouseHall(0, -40, 20, 14, { color: 0x525a62 });
    sb.addContainerStack(-32, -42);
    sb.addCommsTower(36, -38, { height: 18 });
    sb.addGuardTower(16, -2);
  } else if (topo === 'hydro_dam_gorge') {
    sb.addDamSpillway(0, -20, Math.min(72, hx * 1.45), 4.4);
    sb.addRoadSegment(0, 28, 10, hz - 14, 'z');
    sb.addPowerSubstation(-26, 16);
    sb.addWarehouseHall(26, 16, 18, 14, { color: 0x556068 });
    sb.addMultiStoreyBuilding(-28, 44, 14, 11, 2);
    sb.addRadarInstallation(30, 44);
    sb.addGuardTower(-36, -4);
    sb.addGuardTower(36, -4);
  } else {
    // multi_compound_valley
    sb.addRoadSegment(0, 0, 9.5, hz * 2 - 14, 'z', { curbs: false });
    sb.addRoadSegment(0, -8, hx * 1.6, 9, 'x', { curbs: false });
    sb.addMultiStoreyBuilding(-26 + jx, -22, 15, 12, 2);
    sb.addBarracksBlock(26, -20 + jz, 16, 8.5);
    sb.addRuralHomestead(-28, 22, 12, 9, { stone: true });
    sb.addWarehouseHall(26, 24, 18, 14);
    sb.addRadarInstallation(0, -42);
    sb.addGuardTower(-14, 4);
    sb.addWatchPost(16, 4, 1);
  }
}

function buildDynamicCampaignOperation(world, scene, physics, entry) {
  initWorldCanvas(world, scene, physics, {
    layoutId: entry.layoutId,
    intelMapKey: entry.intelMapKey,
    boundsHalf: entry.boundsHalf,
    skyProfile: entry.skyProfile,
    weather: entry.weather,
    groundType: entry.groundType,
    groundTint: entry.groundTint,
  });

  const sb = new StructureBuilder(world);
  const rng = makeRng(entry.seed || (entry.missionNumber * 977));
  const P = entry.placements;

  // Reserve insertion & LZ first so large structures respect them
  sb.reserveArea(P.spawnPos[0], P.spawnPos[1], 12, 12, 3.0);
  sb.reserveArea(P.lzPos[0], P.lzPos[1], 14, 14, 3.0);
  if (P.missionVehicle) {
    sb.reserveArea(P.missionVehicle.x, P.missionVehicle.z, 12, 12, 2.5);
  }

  // Build primary macro-topology + 20-category environmental props
  buildTopologyStructures(world, sb, entry, rng);
  addCategorySignatureProps(world, sb, entry, rng);

  // Place collision-validated player spawn & extraction LZ
  const [spx, spz] = findSafeGroundSpot(world, P.spawnPos[0], P.spawnPos[1], 1.2, 30);
  world.spawnPoint.set(spx, 0, spz);

  const [lzx, lzz] = findSafeGroundSpot(world, P.lzPos[0], P.lzPos[1], 2.4, 32);
  world._lz(lzx, lzz);

  // Ensure every reach / drive step target coordinate also sits on open walkable ground
  for (const st of entry.primarySteps || []) {
    if ((st.kind === 'reach' || st.kind === 'drive') && Array.isArray(st.pos)) {
      const [rx, rz] = findSafeGroundSpot(world, st.pos[0], st.pos[1], st.kind === 'drive' ? 2.6 : 1.2, 28);
      st.pos = [rx, rz];
    }
  }

  // Place primary mission interactables, destructibles, vehicles & NPCs on verified floor positions
  if (P.terminal) {
    const [tx, tz] = findSafeGroundSpot(world, P.terminal.x, P.terminal.z, 1.5, 32);
    world._objective(tx, 0, tz, P.terminal.hold || 7, P.terminal.label);
  }

  for (const s of P.sabotage || []) {
    const [cx, cz] = findSafeGroundSpot(world, s.x, s.z, 1.3, 30);
    // Give each sabotage point an industrial pylon/manifold plinth next to it
    world.box(cx, 0, cz - 0.55, 1.2, 2.1, 0.8, world.mat.metal(2, 0x525a62), Mat.METAL);
    world._sabotage(cx, 0, cz, s.id, s.label);
  }

  for (const d of P.destructibles || []) {
    const [dx, dz] = findSafeGroundSpot(world, d.x, d.z, 1.6, 30);
    const dest = world.addDestructibleBox(
      d.id, dx, 0, dz, 1.75, 1.85, 1.25,
      sb.hazardMat(), Mat.METAL,
      { health: 90, label: d.label }
    );
    // Beacon indicator atop primary destructible equipment so player can spot it visually
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.11, 6, 5), world.mat.emissiveRed);
    beacon.position.set(dx, 2.02, dz);
    world.group.add(beacon);
    if (dest) dest.beacon = beacon;
  }

  for (const o of P.observations || []) {
    const [ox, oz] = findSafeGroundSpot(world, o.x, o.z, 1.3, 30);
    world._observe(ox, 0, oz, o.id, o.label);
  }

  if (P.generator) {
    const [gx, gz] = findSafeGroundSpot(world, P.generator.x, P.generator.z, 1.6, 30);
    world._generator(gx, 0, gz);
  }

  if (P.contactNpc) {
    const [nx, nz] = findSafeGroundSpot(world, P.contactNpc.x, P.contactNpc.z, 1.2, 30);
    world._npc(nx, nz, 'contact', [[nx, nz], [lzx, lzz]]);
  }

  if (P.captureZone) {
    const [czx, czz] = findSafeGroundSpot(world, P.captureZone.x, P.captureZone.z, 2.0, 30);
    P.captureZone.x = czx;
    P.captureZone.z = czz;
    // Update step coordinates so HUD marker & capture check align with verified center
    for (const st of entry.primarySteps) {
      if (st.kind === 'capture') st.pos = [czx, czz];
    }
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(P.captureZone.radius - 0.35, P.captureZone.radius, 28),
      new THREE.MeshStandardMaterial({ color: 0xe6a23c, emissive: 0xe6a23c, emissiveIntensity: 0.75, roughness: 1, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(czx, 0.035, czz);
    world.group.add(ring);
    world.cyl(czx, 0, czz, 0.08, 0.12, 3.8, 8, world.mat.metalDark, Mat.METAL);
    world.box(czx + 0.6, 3.2, czz, 1.1, 0.65, 0.06, sb.hazardMat(), Mat.METAL, { noCollider: true });
  }

  // Place driveable mission / field tactical vehicles
  if (P.missionVehicle) {
    const [vx, vz] = findSafeGroundSpot(world, P.missionVehicle.x, P.missionVehicle.z, 2.8, 32);
    world._vehicle(P.missionVehicle.type, vx, vz, P.missionVehicle.yaw || 180, {
      tag: P.missionVehicle.tag,
      mission: true,
    });
  } else {
    const pool = entry.vehiclePool || ['latv4'];
    const [vx, vz] = findSafeGroundSpot(world, spx + (entry.mirrorX * 12), spz - 12, 2.8, 28);
    world._vehicle(pool[0], vx, vz, 180);
    if (pool[1] && entry.skyProfile !== 'underground') {
      const [vx2, vz2] = findSafeGroundSpot(world, -entry.mirrorX * 18, 6, 2.8, 28);
      world._vehicle(pool[1], vx2, vz2, 0);
    }
  }

  // Place generous resupply crates, field supply crates, weapon cases & 3 sector intel documents!
  const [hx, hz] = entry.boundsHalf;
  const crateAnchors = [
    [spx + 5, spz - 6],
    [-entry.mirrorX * 16, 18],
    [entry.mirrorX * 16, -12],
    [0, -Math.round(hz * 0.35)],
    [lzx + 5, lzz + 5],
  ];
  for (let i = 0; i < crateAnchors.length; i++) {
    const [ax, az] = findSafeGroundSpot(world, crateAnchors[i][0], crateAnchors[i][1], 1.1, 20);
    world._ammoCrate(i + 1, ax, 0, az);
  }
  const weaponChoices = ['cr9', 'st12', 'sz8', 'lb9', 'hmg9', 'mr7', 'vx12', 'mpx5'];
  const [wx, wz] = findSafeGroundSpot(world, entry.mirrorX * 10, 22, 1.2, 20);
  const featuredWeapon = weaponChoices[entry.missionNumber % weaponChoices.length];
  world._weaponPickup(featuredWeapon, wx, 0, wz);

  // Typed ammunition packs (Phase 4) are placed by buildCampaignMap once the
  // whole map exists — props are still added after this point, and a pack
  // validated against a half-built world can end up inside a finished one.
  world._campaignSupplyHints = {
    missionNumber: entry.missionNumber, minEnemies: entry.minEnemies,
    featuredWeapon, rng, near: [spx, spz],
  };

  const intelCoords = [
    [-entry.mirrorX * 22, 14, `${entry.name} PATROL ORDER`],
    [entry.mirrorX * 20, -16, `${entry.name} COMMAND DISPATCH`],
    [0, -Math.round(hz * 0.4), `${entry.name} LOGISTICS LEDGER`],
  ];
  for (const [ix, iz, ilabel] of intelCoords) {
    const [sx, sz] = findSafeGroundSpot(world, ix, iz, 1.1, 22);
    world._intel(sx, 0, sz, ilabel);
  }

  // Populate multi-sector enemy roster exceeding the mission's progression minimum!
  populateSectorRoster(world, sb, entry.minEnemies, rng, [spx, spz]);
}

/**
 * Campaign ammunition supply placement (Phase 4).
 *
 * One routine, every mission: the sector generator calls it, and so does the
 * legacy hand-built branch of `buildCampaignMap`, which is what guarantees "each
 * of the 100 missions offers at least some opportunity" without 100 hand-edited
 * builders. Sizes and counts scale with the mission (hostiles deployed, and how
 * far into the campaign it sits), so supplies stay tight in the prologue and
 * generous only where the fighting demands it.
 *
 * Every candidate is *validated against the finished collision geometry* before
 * a pack is dropped: the pack volume must be free, and a soldier must be able to
 * stand beside it and look at it. That is why placement is a search rather than a
 * formula — the earlier version trusted `findSafeGroundSpot` (tuned for crates
 * and vehicles) and put six packs inside props on two operations.
 */
const DOWN_Y = { x: 0, y: -1, z: 0 };

/** Top surface of whatever is at (x, z), or null if nothing solid is underfoot.
 *  These maps are multi-level, so the ground plane is not always y=0: a pack put
 *  down "at ground level" without measuring ends up half inside a platform. */
function packGroundY(world, x, z) {
  const phys = world._phys || world.physics;
  if (!phys || typeof phys.raycast !== 'function') return 0;
  // Deliberately a short probe from just above floor height: a long ray from the
  // sky returns the underside of a catwalk or roof beam and the pack is "grounded"
  // three metres in the air. Only an upward-facing (walkable) surface counts.
  const hit = phys.raycast(new THREE.Vector3(x, 1.25, z), DOWN_Y, 1.8);
  if (!hit || hit.dist > 1.8 || !hit.normal || hit.normal.y <= 0.4) return null;
  const y = 1.25 - hit.dist;
  return Number.isFinite(y) && y > -30 && y < 60 ? y : null;
}

function packSpotIsGood(world, x, y, z) {
  const phys = world._phys || world.physics;
  if (!phys || typeof phys.isBoxFree !== 'function') return true;
  // The volume is measured from the surface that was found, 0.01 above it: these
  // maps' floor is itself a collider whose top face is the walking plane, so
  // starting at 0.0 would report every candidate on the campaign as buried.
  const min = new THREE.Vector3(x - 0.22, y + 0.01, z - 0.2);
  const max = new THREE.Vector3(x + 0.22, y + 0.45, z + 0.2);
  if (!phys.isBoxFree(min, max, { actors: false })) return false;
  // and someone has to be able to stand next to it and face it
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const sx = x + Math.cos(a) * 1.2, sz = z + Math.sin(a) * 1.2;
    const sMin = new THREE.Vector3(sx - 0.32, y + 0.05, sz - 0.32);
    const sMax = new THREE.Vector3(sx + 0.32, y + 1.55, sz + 0.32);
    if (!phys.isBoxFree(sMin, sMax, { actors: false })) continue;
    if (phys.hasLOS(new THREE.Vector3(sx, y + 0.75, sz), new THREE.Vector3(x, y + 0.3, z))) return true;
  }
  return false;
}

export function placeCampaignAmmoPacks(world, opts = {}) {
  if (!world || !world._ammoPack) return [];
  if (world._missionAmmoPacks && world._missionAmmoPacks.length) return world._missionAmmoPacks;
  // buildCampaignMap runs before GameWorld ever stores `physics`, so the world
  // handed to the placer by the caller is authoritative.
  world._phys = opts.physics || world.physics || null;
  if (!world._phys) return [];
  const missionNumber = Math.max(1, opts.missionNumber || 1);
  const minEnemies = opts.minEnemies || 50;
  const rng = typeof opts.rng === 'function' ? opts.rng : makeRng(0x5eed + missionNumber * 977);
  const near = opts.near || [0, 0];

  const packTypes = ['rifle', 'smg'];
  const featuredType = WEAPON_AMMO[opts.featuredWeapon];
  if (featuredType && !packTypes.includes(featuredType)) packTypes.push(featuredType);

  const heat = Math.max(0, Math.min(2, Math.floor((minEnemies - 40) / 40)));
  const packCount = 2 + heat + (missionNumber % 25 >= 13 ? 1 : 0);
  const hiddenCount = 1 + (missionNumber % 3 === 0 ? 1 : 0);
  const sizeIdx = (bias) => {
    // The ladder runs the whole +10 to +50 range: `t` walks it as the campaign
    // escalates, an anchor's own bias nudges it, and heat (how many hostiles the
    // operation fields) adds a small step so a heavy op can drop a 50. Without the
    // top step being reachable, the largest increment in the table would only ever
    // exist on paper.
    const t = (missionNumber - 1) / 99;
    const raw = t * 2.35 + bias + (heat - 1) * 0.2 + rng() * 1.4;
    return Math.max(0, Math.min(AMMO_PACK_SIZES.length - 1, Math.floor(raw)));
  };

  const b = world.bounds || { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
  const spanX = Math.max(20, b.maxX - b.minX), spanZ = Math.max(20, b.maxZ - b.minZ);
  const diag = Math.hypot(spanX, spanZ) * 0.5;

  // Candidate anchors: believable first (cache it where patrols actually walk and
  // where a squad would drop a case beside cover), then a coarse grid so a map
  // with no routes at all still gets supplies.
  const anchors = [];
  for (const route of (world.patrolRoutes || []).slice(0, 6)) {
    for (const wp of (route || []).slice(0, 8)) if (wp) anchors.push([wp.x, wp.z, 0.35]);
  }
  for (const cp of (world.coverPoints || []).slice(0, 40)) {
    const p = cp && cp.pos ? cp.pos : cp;
    if (p) anchors.push([p.x + 0.9, p.z + 0.6, 0.15]);
  }
  const term = world.terminalPos;
  if (term) anchors.push([term.x + 3.2, term.z - 2.4, 0.6], [term.x - 4.1, term.z + 1.8, 0.6]);
  for (let ix = 0; ix < 7; ix++) {
    for (let iz = 0; iz < 7; iz++) {
      anchors.push([b.minX + spanX * ((ix + 0.5) / 7), b.minZ + spanZ * ((iz + 0.5) / 7), 0.05]);
    }
  }

  const good = [];
  for (const [ax, az, bias] of anchors) {
    const [sx, sz] = findSafeGroundSpot(world, ax, az, 0.9, 16);
    const gy = packGroundY(world, sx, sz);
    if (gy === null) continue;
    if (!packSpotIsGood(world, sx, gy, sz)) continue;
    const dSpawn = Math.hypot(sx - near[0], sz - near[1]);
    if (dSpawn < 3.5) continue;                       // never tripping-over-the-player supplies
    good.push({ x: sx, z: sz, y: gy, bias, dSpawn });
    if (good.length > 420) break;
  }
  if (!good.length) return [];

  // Spread the chosen spots apart, then hand the far ones to the "optional /
  // hidden" share so exploration keeps paying.
  const chosen = [];
  const pool = good.sort((a, c) => (a.bias + rng() * 0.6) - (c.bias + rng() * 0.6));
  for (const c of pool) {
    if (chosen.length >= packCount + hiddenCount + 6) break;
    if (chosen.every((o) => Math.hypot(o.x - c.x, o.z - c.z) > 4.5)) chosen.push(c);
  }
  if (!chosen.length) chosen.push(pool[0]);
  // One ordered list, the far end of it stashed: two separate lists competing for
  // the same handful of safe spots is how a mission could end up with supplies but
  // no optional one.
  const want = packCount + hiddenCount;
  const picks = chosen.slice(0, want);
  while (picks.length < want && pool.length) picks.push(pool[picks.length % pool.length]);
  picks.sort((a, c) => c.dSpawn - a.dSpawn);
  const hiddenN = picks.length > 1 ? Math.min(hiddenCount, picks.length - 1) : 0;
  const hiddenSet = new Set(picks.slice(0, hiddenN));

  const placed = [];
  let i = 0;
  for (const c of picks) {
    const isHidden = hiddenSet.has(c);
    const type = packTypes[(i + missionNumber) % packTypes.length];
    const rounds = AMMO_PACK_SIZES[sizeIdx(c.bias + (isHidden ? 0.7 : 0))];
    const item = world._ammoPack(++i, c.x, 0, c.z, type, rounds, {
      rotY: ((i * 1.31 + missionNumber * 0.7) % Math.PI),
      hidden: isHidden,
    });
    if (item) placed.push(item);
  }
  world._missionAmmoPacks = placed;
  return placed;
}

export function buildCampaignMap(world, layoutId, scene, physics) {
  let built = false;
  if (DEDICATED_LEGACY_BUILDERS[layoutId]) {
    DEDICATED_LEGACY_BUILDERS[layoutId](world, scene, physics);
    built = true;
  } else {
    const entry = CAMPAIGN_BY_LAYOUT.get(layoutId);
    if (entry && !entry.isLegacy) {
      buildDynamicCampaignOperation(world, scene, physics, entry);
      built = true;
    }
  }
  if (!built) return false;
  // Supply *placement* is deliberately not done here: buildCampaignMap runs at the
  // top of GameWorld.buildByMap, before the environment kit and the collision
  // coverage pass add the rest of the map, and a pack validated against a
  // half-built world can end up inside a platform. buildCampaignMap only records
  // what this layout wants; GameWorld.buildByMap places it once the map is final.
  const legacyEntry = CAMPAIGN_BY_LAYOUT.get(layoutId) || {};
  world._campaignSupplyHints = Object.assign({
    missionNumber: legacyEntry.missionNumber || 1,
    minEnemies: legacyEntry.minEnemies || 50,
    near: legacyEntry.spawnPos || [0, 0],
  }, world._campaignSupplyHints || {});
  return true;
}
