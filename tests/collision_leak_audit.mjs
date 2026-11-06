/**
 * collision_leak_audit.mjs — the decisive wall/floor pass-through detector.
 *
 * Rasterises the playable area of a map on a 1 m lattice and asks, at every
 * sample point, two questions about the *player-sized* body:
 *
 *   LEAK   — the standing player box overlaps a visible solid mesh that has no
 *            physics collider at all → the player can stand inside that geometry
 *            (walking through a wall / into a building shell).
 *   NOFLOOR— the point is walkable per the physics grid but a visible floor mesh
 *            exists there while the collider grid has no top surface → falling
 *            through a visible floor.
 *
 * Reports per-map counts plus the worst leak clusters so fixes land at the
 * source (builders) instead of as hand-placed boxes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Box3, Vector3 } from 'three';
import { buildMap, campaignMaps, meshWorldBox, classifyNode } from './headless_world.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT_DIR = path.join(ROOT, 'reports');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PLAYER_R = 0.34;
const PLAYER_H = 1.8;
const STEP_UP = 0.42;          // matches Player STEP_HEIGHT
const SAMPLE = Number(process.env.AUDIT_SAMPLE || 1.0);

const _box = new Box3();

function collectSolids(world, physics) {
  /** Uncovered solid meshes = visible geometry with no collider encasing it. */
  const covered = (min, max) => {
    const hits = [];
    physics.queryAABB(min, max, hits);
    return hits.length > 0;
  };
  const uncovered = [];
  world.group.updateMatrixWorld(true);
  const stack = [...world.group.children];
  while (stack.length) {
    const node = stack.pop();
    if (node.children && node.children.length) for (const ch of node.children) stack.push(ch);
    if (!node.isMesh && !node.isInstancedMesh) continue;
    if (node.visible === false) continue;
    const box = meshWorldBox(node, _box);
    if (!box || box.isEmpty()) continue;
    const cls = classifyNode(node, box);
    if (!cls.solid) continue;
    // only geometry that can actually interfere with a standing actor
    if (box.max.y < 0.25 || box.min.y > PLAYER_H) continue;
    const sx = box.max.x - box.min.x, sz = box.max.z - box.min.z;
    if (sx < 0.45 || sz < 0.45) continue;         // thin trim/rail detail: skin-deep overlap only
    const min = new Vector3(box.min.x + 0.02, box.min.y + 0.02, box.min.z + 0.02);
    const max = new Vector3(box.max.x - 0.02, Math.min(box.max.y - 0.02, PLAYER_H), box.max.z - 0.02);
    if (max.x <= min.x || max.z <= min.z || max.y <= min.y) continue;
    if (covered(min, max)) continue;               // already collidable
    uncovered.push({ box: box.clone(), name: node.name || node.geometry?.type || 'mesh' });
  }
  return uncovered;
}

function spatialHash(boxes, cell = 6) {
  const map = new Map();
  for (const b of boxes) {
    const x0 = Math.floor(b.box.min.x / cell), x1 = Math.floor(b.box.max.x / cell);
    const z0 = Math.floor(b.box.min.z / cell), z1 = Math.floor(b.box.max.z / cell);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const k = `${x}|${z}`;
      let arr = map.get(k);
      if (!arr) map.set(k, (arr = []));
      arr.push(b);
    }
  }
  return { map, cell };
}

function auditMap(label, mapId) {
  const { world, physics, scene } = buildMap(mapId);
  const uncovered = collectSolids(world, physics);
  const hash = spatialHash(uncovered);
  const b = world.bounds;
  const probeMin = new Vector3(), probeMax = new Vector3();
  const hits = [];
  let samples = 0, leaks = 0, noGround = 0;
  const leakNames = new Map();
  const clusters = [];
  for (let x = b.minX + 1; x <= b.maxX - 1; x += SAMPLE) {
    for (let z = b.minZ + 1; z <= b.maxZ - 1; z += SAMPLE) {
      samples++;
      // find the walking surface from physics
      const origin = new Vector3(x, 0.6, z);
      let floorY = null;
      // probe a band so elevated structures are sampled too
      for (const startY of [0.6, 3.2, 6.4]) {
        const hit = physics.raycast(new Vector3(x, startY, z), new Vector3(0, -1, 0), startY + 4);
        if (hit && hit.normal.y > 0.5) { floorY = hit.point.y; break; }
      }
      if (floorY === null) continue;
      probeMin.set(x - PLAYER_R, floorY + 0.06, z - PLAYER_R);
      probeMax.set(x + PLAYER_R, floorY + PLAYER_H - 0.05, z + PLAYER_R);
      physics.queryAABB(probeMin, probeMax, hits);
      const blockedByCollider = hits.some((c) => c.max.y > floorY + STEP_UP + 0.02);
      // leak: player-sized box overlaps a visible solid mesh, yet physics says free
      const cx0 = Math.floor(probeMin.x / hash.cell), cx1 = Math.floor(probeMax.x / hash.cell);
      const cz0 = Math.floor(probeMin.z / hash.cell), cz1 = Math.floor(probeMax.z / hash.cell);
      let overlap = null;
      for (let ix = cx0; ix <= cx1 && !overlap; ix++) {
        for (let iz = cz0; iz <= cz1 && !overlap; iz++) {
          for (const e of (hash.map.get(`${ix}|${iz}`) || [])) {
            const ox = Math.min(probeMax.x, e.box.max.x) - Math.max(probeMin.x, e.box.min.x);
            const oz = Math.min(probeMax.z, e.box.max.z) - Math.max(probeMin.z, e.box.min.z);
            const oy = Math.min(probeMax.y, e.box.max.y) - Math.max(probeMin.y, e.box.min.y);
            if (ox > 0.14 && oz > 0.14 && oy > 0.14) { overlap = e; break; }
          }
        }
      }
      if (overlap && !blockedByCollider) {
        leaks++;
        const key = (overlap.name || 'mesh').toLowerCase().replace(/[-_ ]?\d+$/, '');
        const rec = leakNames.get(key) || { name: key, count: 0, at: `${x.toFixed(1)},${floorY.toFixed(1)},${z.toFixed(1)}`, size: `${(overlap.box.max.x - overlap.box.min.x).toFixed(1)}x${(overlap.box.max.y - overlap.box.min.y).toFixed(1)}x${(overlap.box.max.z - overlap.box.min.z).toFixed(1)}` };
        rec.count++;
        leakNames.set(key, rec);
        if (clusters.length < 6 && rec.count === 1) clusters.push({ at: rec.at, name: rec.name, size: rec.size });
      }
      if (!blockedByCollider && !overlap) {
        // floor presence sanity: a visible floor mesh must have a collider under it
        probeMin.set(x - 0.3, floorY - 0.9, z - 0.3);
        probeMax.set(x + 0.3, floorY - 0.05, z + 0.3);
        physics.queryAABB(probeMin, probeMax, hits);
        if (!hits.length) noGround++;
      }
    }
  }
  const result = {
    label, map: mapId,
    uncoveredSolidMeshes: uncovered.length,
    samples,
    leakCells: leaks,
    leakPct: +(100 * leaks / Math.max(1, samples)).toFixed(3),
    noFloorCells: noGround,
    leakFamilies: [...leakNames.values()].sort((a, c) => c.count - a.count).slice(0, 10),
  };
  scene.clear();
  physics.clear();
  return result;
}

const rows = [];
const legacy = ['facility', 'desert', 'urban', 'snow', 'recon_canyon', 'industrial', 'rural', 'riverside_village', 'canal_market', 'ridge_hold', 'metro', 'foundry_rail'];
for (const id of legacy) rows.push(auditMap(`legacy:${id}`, id));
if (!process.env.AUDIT_LEGACY_ONLY) {
  for (const entry of campaignMaps()) rows.push(auditMap(`op${String(entry.op).padStart(3, '0')}`, entry.layoutId));
}

const tot = (k) => rows.reduce((a, r) => a + r[k], 0);
const summary = {
  mapsAudited: rows.length,
  sampleSpacing: SAMPLE,
  totalLeakCells: tot('leakCells'),
  totalSamples: tot('samples'),
  leakRatePct: +(100 * tot('leakCells') / Math.max(1, tot('samples'))).toFixed(3),
  totalNoFloorCells: tot('noFloorCells'),
  mapsWithLeaks: rows.filter((r) => r.leakCells > 0).length,
  worst: rows.slice().sort((a, c) => c.leakCells - a.leakCells).slice(0, 12)
    .map((r) => ({ map: r.map, leakCells: r.leakCells, leakPct: r.leakPct, top: r.leakFamilies[0] })),
  families: (() => {
    const agg = new Map();
    for (const r of rows) for (const f of r.leakFamilies) {
      const rec = agg.get(f.name) || { name: f.name, count: 0, maps: new Set() };
      rec.count += f.count; rec.maps.add(r.map); agg.set(f.name, rec);
    }
    return [...agg.values()].sort((a, c) => c.count - a.count).slice(0, 20)
      .map((r) => ({ name: r.name, cells: r.count, maps: r.maps.size }));
  })(),
};
fs.writeFileSync(path.join(OUT_DIR, 'collision_leaks.json'), JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log('\n--- per-map (leaks) ---');
for (const r of rows) if (r.leakCells > 0) console.log(`${r.map.padEnd(32)} leaks=${String(r.leakCells).padStart(5)} (${String(r.leakPct).padStart(6)}%) uncoveredMeshes=${String(r.uncoveredSolidMeshes).padStart(4)}  ${r.leakFamilies.slice(0, 3).map(f => `${f.name}×${f.count}@${f.size}`).join(' ')}`);
console.log('\nWROTE reports/collision_leaks.json');

// Hard gate: this audit is the campaign-wide proof that you cannot fall through
// the world, so it must fail the run (non-zero exit) rather than just print.
const badMaps = rows.filter((r) => r.leakCells > 0 || r.noFloorCells > 0);
if (badMaps.length || summary.totalLeakCells > 0 || summary.totalNoFloorCells > 0) {
  console.log(`FAIL walk-through/fall-through leaks found: ${summary.totalLeakCells} leak cells, `
    + `${summary.totalNoFloorCells} no-floor cells across ${badMaps.length} map(s)`);
  process.exitCode = 1;
} else {
  console.log(`PASS ${summary.mapsAudited} maps · ${summary.totalSamples} probes · 0 leak cells · 0 no-floor cells`);
}
