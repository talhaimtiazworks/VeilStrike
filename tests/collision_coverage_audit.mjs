/**
 * collision_coverage_audit.mjs — measures how well physics colliders cover the
 * visible geometry of every map in the campaign (legacy 1-10 + operations 11-100).
 *
 * For each rendered solid mesh we ask: does at least one enabled collider enclose
 * its centre region? A solid mesh with no covering collider is a wall the player
 * can walk through. Colliders with no matching render mesh are reported as
 * "phantom" coverage (invisible walls) for the decorative categories.
 *
 * Output: reports/collision_coverage.json (+ a markdown summary table).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Box3, Vector3 } from 'three';
import { buildMap, campaignMaps, meshWorldBox, classifyNode } from './headless_world.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT_DIR = path.join(ROOT, 'reports');
fs.mkdirSync(OUT_DIR, { recursive: true });

const _meshBox = new Box3();
const _probeMin = new Vector3();
const _probeMax = new Vector3();

function auditMap(label, mapId) {
  const { world, physics, scene } = buildMap(mapId);
  const colliders = physics.colliders.filter((c) => c.enabled);
  // Bucket colliders by XZ cell for a fast "does anything cover this point" test.
  const CELL = 8;
  const buckets = new Map();
  for (const c of colliders) {
    const x0 = Math.floor(c.min.x / CELL), x1 = Math.floor(c.max.x / CELL);
    const z0 = Math.floor(c.min.z / CELL), z1 = Math.floor(c.max.z / CELL);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const k = `${x}|${z}`;
      let arr = buckets.get(k);
      if (!arr) buckets.set(k, (arr = []));
      arr.push(c);
    }
  }
  const seen = new Set();
  function covering(min, max) {
    seen.clear();
    let hits = 0;
    const x0 = Math.floor(min.x / CELL), x1 = Math.floor(max.x / CELL);
    const z0 = Math.floor(min.z / CELL), z1 = Math.floor(max.z / CELL);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const arr = buckets.get(`${x}|${z}`);
      if (!arr) continue;
      for (const c of arr) {
        if (seen.has(c)) continue;
        seen.add(c);
        if (c.max.x < min.x || c.min.x > max.x) continue;
        if (c.max.z < min.z || c.min.z > max.z) continue;
        if (c.max.y < min.y || c.min.y > max.y) continue;
        hits++;
      }
    }
    return hits;
  }

  world.group.updateMatrixWorld(true);
  let solid = 0, covered = 0, decor = 0;
  const offenders = new Map();   // mesh-name -> {count, sample, size}
  const stack = [...world.group.children];
  while (stack.length) {
    const node = stack.pop();
    if (node.children && node.children.length) for (const ch of node.children) stack.push(ch);
    if (!node.isMesh && !node.isInstancedMesh) continue;
    if (node.visible === false) continue;
    const box = meshWorldBox(node, _meshBox);
    if (!box || box.isEmpty()) continue;
    if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.y)) continue;
    const cls = classifyNode(node, box);
    if (!cls.solid) { decor++; continue; }
    solid++;
    // probe the inner core of the visible volume (skin-deep edges may legitimately
    // stick out of a simplified collision box)
    const sx = (box.max.x - box.min.x), sz = (box.max.z - box.min.z), sy = (box.max.y - box.min.y);
    const ix = Math.min(0.35, sx * 0.25), iz = Math.min(0.35, sz * 0.25);
    _probeMin.set(box.min.x + ix, box.min.y + Math.min(0.2, sy * 0.2), box.min.z + iz);
    _probeMax.set(box.max.x - ix, box.max.y - Math.min(0.2, sy * 0.2), box.max.z - iz);
    if (_probeMax.x <= _probeMin.x) { _probeMin.x = box.min.x; _probeMax.x = box.max.x; }
    if (_probeMax.z <= _probeMin.z) { _probeMin.z = box.min.z; _probeMax.z = box.max.z; }
    if (covering(_probeMin, _probeMax) > 0) { covered++; continue; }
    const key = (node.name || node.geometry?.type || 'mesh').toLowerCase().replace(/[-_ ]?\d+$/, '');
    const rec = offenders.get(key) || { count: 0, sample: '', sx: 0, sy: 0, sz: 0 };
    rec.count++;
    if (!rec.sample) {
      rec.sample = `${box.min.x.toFixed(1)},${box.min.y.toFixed(1)},${box.min.z.toFixed(1)}`;
      rec.sx = +sx.toFixed(2); rec.sy = +sy.toFixed(2); rec.sz = +sz.toFixed(2);
    }
    offenders.set(key, rec);
  }

  const result = {
    label,
    map: mapId,
    colliders: physics.colliders.length,
    colliderCells: buckets.size,
    meshesSolid: solid,
    meshesCovered: covered,
    meshesDecorative: decor,
    coveragePct: solid ? +(100 * covered / solid).toFixed(2) : 100,
    uncovered: [...offenders.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 12)
      .map(([name, v]) => ({ name, count: v.count, size: `${v.sx}x${v.sy}x${v.sz}`, at: v.sample })),
  };
  scene.clear();
  physics.clear();
  return result;
}

const rows = [];
const legacy = ['facility', 'desert', 'urban', 'snow', 'recon_canyon', 'industrial', 'rural', 'riverside_village', 'canal_market', 'ridge_hold'];
for (const id of legacy) rows.push(auditMap(`legacy:${id}`, id));
const ops = campaignMaps();
for (const entry of ops) rows.push(auditMap(`op${String(entry.op).padStart(3, '0')}`, entry.layoutId));

const totalSolid = rows.reduce((a, r) => a + r.meshesSolid, 0);
const totalCovered = rows.reduce((a, r) => a + r.meshesCovered, 0);
const summary = {
  mapsAudited: rows.length,
  totalSolidMeshes: totalSolid,
  totalCovered: totalCovered,
  coveragePct: +(100 * totalCovered / Math.max(1, totalSolid)).toFixed(2),
  mapsBelow100: rows.filter((r) => r.coveragePct < 100).length,
  worstOffenders: (() => {
    const agg = new Map();
    for (const r of rows) for (const o of r.uncovered) {
      const rec = agg.get(o.name) || { name: o.name, count: 0, maps: new Set(), size: o.size };
      rec.count += o.count; rec.maps.add(r.map); agg.set(o.name, rec);
    }
    return [...agg.values()].sort((a, b) => b.count - a.count).slice(0, 25)
      .map((r) => ({ name: r.name, count: r.count, maps: r.maps.size, size: r.size }));
  })(),
};

fs.writeFileSync(path.join(OUT_DIR, 'collision_coverage.json'), JSON.stringify({ summary, rows }, null, 2));

const md = [];
md.push('# VEILSTRIKE — Collision Coverage Report');
md.push('');
md.push(`Maps audited: **${summary.mapsAudited}** (10 legacy layouts + 100 campaign operations)`);
md.push(`Solid render meshes: **${summary.totalSolidMeshes}**, enclosed by a collider: **${summary.totalCovered}** → **${summary.coveragePct}%** coverage`);
md.push(`Maps with incomplete coverage before fix: **${summary.mapsBelow100}**`);
md.push('');
md.push('## Per-map coverage');
md.push('');
md.push('| map | colliders | solid meshes | covered | coverage % | top uncovered group |');
md.push('|---|---|---|---|---|---|');
for (const r of rows) {
  const top = r.uncovered[0] ? `${r.uncovered[0].name} ×${r.uncovered[0].count}` : '—';
  md.push(`| ${r.map} | ${r.colliders} | ${r.meshesSolid} | ${r.meshesCovered} | ${r.coveragePct}% | ${top} |`);
}
md.push('');
md.push('## Most frequent uncovered mesh families');
md.push('');
md.push('| mesh family | instances | maps affected | typical size (m) |');
md.push('|---|---|---|---|');
for (const o of summary.worstOffenders) md.push(`| ${o.name} | ${o.count} | ${o.maps} | ${o.size} |`);
md.push('');
fs.writeFileSync(path.join(OUT_DIR, 'COLLISION_COVERAGE.md'), md.join('\n'));

console.log(JSON.stringify(summary, null, 2));
console.log('\n--- per-map ---');
for (const r of rows) console.log(`${r.map.padEnd(26)} cov=${String(r.coveragePct).padStart(6)}%  solid=${String(r.meshesSolid).padStart(6)}  colliders=${String(r.colliders).padStart(5)}  top-uncovered=${r.uncovered[0] ? r.uncovered[0].name + '×' + r.uncovered[0].count : '-'}`);
console.log('\nWROTE reports/collision_coverage.json + reports/COLLISION_COVERAGE.md');

// Regression gate: solid mesh coverage must not fall below the floor. The
// residual is authored decor marked userData.col='skip'; a *drop* means new
// geometry arrived without a collider, which is exactly how invisible walls and
// walk-through walls come back. Override with MIN_COVERAGE_PCT=<n>.
const FLOOR = Number(process.env.MIN_COVERAGE_PCT || 95);
if (summary.coveragePct < FLOOR) {
  console.log(`FAIL solid-mesh coverage ${summary.coveragePct}% is below the ${FLOOR}% floor`);
  process.exitCode = 1;
} else {
  console.log(`PASS solid-mesh coverage ${summary.coveragePct}% (${summary.totalCovered}/${summary.totalSolidMeshes} across ${summary.mapsAudited} maps) ≥ ${FLOOR}% floor`);
}
