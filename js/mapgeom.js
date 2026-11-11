/**
 * mapgeom.js — the tactical map's data layer (v4.3).
 *
 * The map is only as trustworthy as its source, so this module invents nothing.
 * Everything it returns is read from the live mission:
 *
 *   · physics.colliders      every authored AABB the player collides with, with its
 *                            material and the semantic `tag` the world builder stamped
 *                            on it ('lab_room', 'rooftop', 'pillbox', 'door', …)
 *   · world.bounds           the playable terrain boundary
 *   · world.doors            door positions and open/closed state
 *   · world.patrolRoutes     authored AI pathways — the only "paths" the game knows
 *   · world.coverPoints      authored cover positions
 *   · world.interactables    interaction points and their live prompts
 *   · world.vehicleSpawns    authored vehicle placements
 *   · missions.mapTargets()  objective / optional / extraction positions
 *
 * Collision volumes are 3D solids, which is the wrong shape for a map, so they are
 * *classified and simplified* here — footprint + height band + role — and nothing is
 * smoothed, blurred or approximated beyond that. The same classified rectangles also
 * drive the walkability grid used for route finding, so the route the map draws and
 * the geometry the player bumps into can never disagree.
 *
 * Coordinate convention (shared with tacmap.js and asserted by its tests):
 *   world +X → east → screen right, world +Z → south → screen down, so **north is -Z**.
 */

/** Classification + navigation tuning. */
export const MAP_GEOM = {
  stepHeight: 1.15,   // a top surface at or below this is walkable-over (js/player.js M.crateMax)
  standHeight: 1.80,  // a volume starting above this can be walked under
  clearance: 0.55,    // route corridor half-width: the player capsule is 0.30–0.42
  navCell: 1.5,       // metres per navigation cell
  minWallThickness: 1.45,
  minBuildingArea: 26,
  minBuildingSpan: 3.2,
  maxRects: 2600,     // a mission never approaches this; guards a runaway draw
  maxNavCells: 260000,
  maxExpansions: 60000,
};

/** Collider tags that mean "an elevated walkable surface", not a solid block. */
const DECK_TAGS = new Set([
  'rooftop', 'tower_deck', 'ship_deck', 'overpass_deck', 'hangar_catwalk', 'catwalk',
  'container_top', 'warehouse_floor', 'bunker_roof', 'dam_crest', 'tunnel', 'bunker_gallery',
]);
/** Tags that mean "an interior space": drawn as a room, labelled with its name. */
const ROOM_TAGS = new Set([
  'lab_room', 'bunker_room', 'barracks_room', 'homestead_room', 'bunker_hall', 'hangar_bay',
]);
/** Tags that mean "a vehicle", so a truck is not mistaken for a building. */
const VEHICLE_TAGS = new Set([
  'vehicle', 'civ_truck', 'transit_truck', 'escort_truck', 'extract_apc', 'recovery_suv',
  'farm_pickup', 'snow_wreck', 'hx7_vanguard', 'spearhead_veh',
]);
/** Named structures worth a label of their own. */
const LANDMARK_TAGS = new Set(['pillbox', 'radar_plinth', 'bunker_hall', 'hangar_bay', 'tunnel', 'dam_crest']);

/**
 * Paved vs unpaved ground, read off the material name the mission itself gave the
 * surface record (`world.vehicleSurfaces`, js/world.js:1077). Anything not listed
 * here is drawn as open ground - the map never invents a road.
 */
const PAVED_MAT_RE = /asphalt|pave|road|street|tarmac|runway|bridge-deck|helipad|concrete|dock/i;

const MATERIAL_TINT = {
  concrete: 'structure', metal: 'metal', wood: 'wood', glass: 'glass',
  soil: 'ground', gravel: 'ground', fabric: 'soft',
};

/**
 * One collider → one map feature. `role` decides the styling in tacmap.js;
 * `nav` says whether the footprint stops a walking route.
 */
export function classifyCollider(c) {
  const tag = c.tag || 'static';
  const x0 = c.min.x, x1 = c.max.x, z0 = c.min.z, z1 = c.max.z;
  const w = x1 - x0, d = z1 - z0;
  const area = w * d;
  const h = c.max.y - c.min.y;
  const top = c.max.y, bottom = c.min.y;
  const span = Math.min(w, d);
  const mat = MATERIAL_TINT[c.material] || 'structure';
  const solidForNav = top > MAP_GEOM.stepHeight && bottom < MAP_GEOM.standHeight;

  if (!c.enabled) return null;                                  // destroyed / opened away
  if (c.actor) return null;                                     // moving bodies are markers, not terrain
  if (VEHICLE_TAGS.has(tag)) return { role: 'vehicle', nav: false, tint: 'metal', tag, x0, z0, x1, z1, h, top };
  if (tag === 'door') return { role: 'door', nav: true, tint: 'glass', tag, x0, z0, x1, z1, h, top };
  if (tag === 'glass' || c.breakable || mat === 'glass') {
    return { role: 'glass', nav: top > MAP_GEOM.stepHeight, tint: 'glass', tag, x0, z0, x1, z1, h, top };
  }
  if (tag === 'ground' || (area > 900 && h < 0.6)) {
    return { role: 'ground', nav: false, tint: 'ground', tag, x0, z0, x1, z1, h, top };
  }
  if (DECK_TAGS.has(tag)) {
    return { role: 'deck', nav: false, tint: mat, tag, x0, z0, x1, z1, h, top };
  }
  if (ROOM_TAGS.has(tag)) {
    return { role: 'room', nav: false, tint: mat, tag, name: tag.replace(/_/g, ' '), x0, z0, x1, z1, h, top };
  }
  if (LANDMARK_TAGS.has(tag)) {
    return { role: 'landmark', nav: solidForNav, tint: mat, tag, name: tag.replace(/_/g, ' '), x0, z0, x1, z1, h, top };
  }
  if (span <= MAP_GEOM.minWallThickness) {
    if (h < 0.5) return { role: 'curb', nav: false, tint: mat, tag, x0, z0, x1, z1, h, top };
    return h >= 1.6 ? { role: 'wall', nav: true, tint: mat, tag, x0, z0, x1, z1, h, top }
      : { role: 'barrier', nav: solidForNav, tint: mat, tag, x0, z0, x1, z1, h, top };
  }
  if (area >= MAP_GEOM.minBuildingArea && span >= MAP_GEOM.minBuildingSpan && top >= 2.2) {
    return { role: 'building', nav: true, tint: mat, tag, x0, z0, x1, z1, h, top };
  }
  if (top <= MAP_GEOM.stepHeight + 0.35 && area > 64) {
    return { role: 'lowdeck', nav: false, tint: mat, tag, x0, z0, x1, z1, h, top };
  }
  if (h >= 0.45) return { role: 'prop', nav: solidForNav, tint: mat, tag, x0, z0, x1, z1, h, top };
  return { role: 'flat', nav: false, tint: mat, tag, x0, z0, x1, z1, h, top };
}

/**
 * Build the display model for the current mission. `game` only needs `world` and
 * `physics`, which keeps this usable from a test harness as well as the live game.
 */
export function buildMapGeometry(game) {
  const world = game.world;
  const b = (world && world.bounds) || { minX: -70, maxX: 70, minZ: -70, maxZ: 70 };
  const pad = 4;
  const bounds = {
    minX: b.minX - pad, maxX: b.maxX + pad, minZ: b.minZ - pad, maxZ: b.maxZ + pad,
  };
  const geom = {
    key: geometryKey(game),
    bounds,
    width: bounds.maxX - bounds.minX,
    depth: bounds.maxZ - bounds.minZ,
    cx: (bounds.minX + bounds.maxX) / 2,
    cz: (bounds.minZ + bounds.maxZ) / 2,
    features: [],                       // every classified rect, in draw order priority
    byRole: {},                         // role → features (the renderer's layers)
    doors: [],
    paths: [],
    cover: [],
    interactables: [],
    vehicles: [],
    spawns: null,
    surfaces: [],                        // paved/open ground, from world.vehicleSurfaces
    nav: null,
    stats: { colliders: 0, classified: 0, surfaces: 0, roads: 0 },
  };
  for (const k in BY_ROLE_ORDER) geom.byRole[k] = [];

  const cols = (game.physics && game.physics.colliders) || [];
  for (let i = 0; i < cols.length && geom.features.length < MAP_GEOM.maxRects; i++) {
    const c = cols[i];
    geom.stats.colliders++;
    const f = classifyCollider(c);
    if (!f) continue;
    geom.stats.classified++;
    geom.features.push(f);
    (geom.byRole[f.role] || (geom.byRole[f.role] = [])).push(f);
  }

  // Ground surfaces the mission registered for vehicle physics: real rectangles
  // with real material names, which is exactly what a map should show as road.
  const vsurf = (world.vehicleSurfaces || []);
  for (let i = 0; i < vsurf.length && geom.surfaces.length < MAP_GEOM.maxRects; i++) {
    const s = vsurf[i];
    if (s.minX > s.maxX || s.minZ > s.maxZ) continue;
    const material = String(s.material || 'ground');
    const role = PAVED_MAT_RE.test(material) ? 'road' : 'open';
    geom.surfaces.push({ role, material, x0: s.minX, z0: s.minZ, x1: s.maxX, z1: s.maxZ });
    geom.stats.surfaces++;
    if (role === 'road') geom.stats.roads++;
  }

  // Authored semantic records (never derived from a guess).
  for (const d of (world.doors || [])) {
    geom.doors.push({ x: d.pos.x, z: d.pos.z, open: !!d.open, powered: d.powered !== false });
  }
  for (const r of (world.patrolRoutes || [])) {
    if (!Array.isArray(r) || r.length < 2) continue;
    const pts = [];
    for (const p of r) pts.push({ x: p.x, z: p.z });
    geom.paths.push(pts);
  }
  for (const cp of (world.coverPoints || [])) {
    if (cp && cp.pos) geom.cover.push({ x: cp.pos.x, z: cp.pos.z, nx: cp.normal ? cp.normal.x : 0, nz: cp.normal ? cp.normal.z : 0 });
  }
  for (const it of (world.interactables || [])) {
    const id = it.id || '';
    const kind = INTERACTABLE_KIND(id, it);
    geom.interactables.push({
      x: it.pos.x, z: it.pos.z, id, kind, used: !!it.used,
      label: ((it.getPrompt && it.getPrompt()) || it.prompt || id).toString().toUpperCase(),
    });
  }
  for (const v of (world.vehicleSpawns || [])) {
    if (v && v.pos) geom.vehicles.push({ x: v.pos.x, z: v.pos.z, yaw: v.yaw || 0, name: v.name || v.kind || 'VEHICLE', taken: !!v.taken });
  }
  if (world.spawns && world.spawns.extraction) {
    geom.spawns = { extraction: { x: world.spawns.extraction.x, z: world.spawns.extraction.z } };
  }
  return geom;
}

/** Feature roles in the order they are painted (bottom first). */
const BY_ROLE_ORDER = {
  ground: 1, lowdeck: 1, deck: 1, room: 1, path: 1, curb: 1, cover: 1,
  prop: 1, barrier: 1, wall: 1, building: 1, landmark: 1, glass: 1, vehicle: 1, door: 1,
};

/**
 * Interaction points get a role from the mission vocabulary the game already
 * uses — no new naming, so the legend can explain exactly these kinds.
 */
export function INTERACTABLE_KIND(id, it) {
  if (id === 'generator') return 'power';
  if (id === 'terminal') return 'terminal';
  if (id === 'npc_contact') return 'contact';
  if (id === 'radio_records') return 'intel';
  if (id.startsWith('charge_')) return 'charge';
  if (id.startsWith('evidence_')) return 'intel';
  if (id.startsWith('obs_')) return 'observe';
  if (id.startsWith('intel_')) return 'intel';
  if (id.startsWith('crate_')) return 'supply';
  if (id.startsWith('ammo_')) return 'ammo';
  if (id.startsWith('wpn_')) return 'weapon';
  if (id.startsWith('trunk_')) return 'cache';
  if (id.startsWith('lab_sample')) return 'objective';
  return it && it.objective ? 'objective' : 'item';
}

/** Interaction kinds worth a map symbol (the rest would be clutter). */
export const MAP_ITEM_KINDS = new Set([
  'power', 'terminal', 'contact', 'intel', 'charge', 'observe', 'supply', 'ammo', 'weapon', 'cache', 'objective',
]);

/** Cheap identity for "is the world still the one this map was built from". */
export function geometryKey(game) {
  const w = game.world || {};
  const cols = (game.physics && game.physics.colliders) || [];
  let live = 0;
  for (let i = 0; i < cols.length; i++) if (cols[i].enabled) live++;
  const doors = (w.doors || []);
  let openDoors = 0;
  for (let i = 0; i < doors.length; i++) if (doors[i].open) openDoors++;
  const dem = game.demolitions && game.demolitions.chargeCount ? game.demolitions.chargeCount() : 0;
  return `${w.mapId || '?'}|${cols.length}|${live}|${openDoors}|${(w.objectivesVersion || 0)}|${dem}`;
}

/** Reuse `geom` while the world still matches the key it was built from. */
export function ensureMapGeometry(game, prev) {
  if (prev && prev.key === geometryKey(game)) return prev;
  return buildMapGeometry(game);
}

// ---------------------------------------------------------------------------
// Walkability grid + route finding
// ---------------------------------------------------------------------------

/**
 * Rasterise the classified footprints into a blocked/free grid. A feature blocks
 * the route when it is taller than the player's step height and low enough to
 * be a wall for the capsule — the same rule the mover uses, so a drawn route is
 * a route the player can actually walk.
 */
export function buildNavGrid(geom, opts = {}) {
  if (opts && opts.throughDoors && geom.navDoors) return geom.navDoors;
  if (!(opts && opts.throughDoors) && geom.nav) return geom.nav;
  const cell = MAP_GEOM.navCell;
  const b = geom.bounds;
  const nx = Math.max(4, Math.ceil((b.maxX - b.minX) / cell));
  const nz = Math.max(4, Math.ceil((b.maxZ - b.minZ) / cell));
  if (nx * nz > MAP_GEOM.maxNavCells) return null;
  const blocked = new Uint8Array(nx * nz);
  const clear = MAP_GEOM.clearance;
  for (const f of geom.features) {
    if (!f.nav) continue;
    if (opts && opts.throughDoors && f.role === 'door') continue;   // planned through an opening
    const i0 = Math.max(0, Math.floor((f.x0 - clear - b.minX) / cell));
    const i1 = Math.min(nx - 1, Math.floor((f.x1 + clear - b.minX) / cell));
    const j0 = Math.max(0, Math.floor((f.z0 - clear - b.minZ) / cell));
    const j1 = Math.min(nz - 1, Math.floor((f.z1 + clear - b.minZ) / cell));
    for (let j = j0; j <= j1; j++) {
      const row = j * nx;
      for (let i = i0; i <= i1; i++) blocked[row + i] = 1;
    }
  }
  const nav = {
    cell, nx, nz, blocked, minX: b.minX, minZ: b.minZ,
    isBlocked(i, j) {
      if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return true;   // outside the mission area
      return this.blocked[j * this.nx + i] === 1;
    },
    cellOf(x, z) { return { i: Math.floor((x - this.minX) / this.cell), j: Math.floor((z - this.minZ) / this.cell) }; },
    center(i, j) { return { x: this.minX + (i + 0.5) * this.cell, z: this.minZ + (j + 0.5) * this.cell }; },
  };
  if (opts && opts.throughDoors) geom.navDoors = nav; else geom.nav = nav;
  return nav;
}

/** Nearest free cell to (x, z), searching outwards. Null when nothing is free near. */
function nearestFree(nav, x, z, maxRing = 6) {
  const c0 = nav.cellOf(x, z);
  if (!nav.isBlocked(c0.i, c0.j)) return c0;
  for (let ring = 1; ring <= maxRing; ring++) {
    let best = null, bd = Infinity;
    for (let dj = -ring; dj <= ring; dj++) {
      for (let di = -ring; di <= ring; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
        const i = c0.i + di, j = c0.j + dj;
        if (nav.isBlocked(i, j)) continue;
        const d = di * di + dj * dj;
        if (d < bd) { bd = d; best = { i, j }; }
      }
    }
    if (best) return best;
  }
  return null;
}

/** Supercover line walk: does the segment cross a blocked cell? */
export function segmentClear(nav, ax, az, bx, bz) {
  const a = nav.cellOf(ax, az), b = nav.cellOf(bx, bz);
  let x0 = a.i, y0 = a.j;
  const x1 = b.i, y1 = b.j;
  const dx = Math.abs(x1 - x0), dz = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dz;
  let guard = 0;
  while (guard++ < 40000) {
    if (nav.isBlocked(x0, y0)) return false;
    if (x0 === x1 && y0 === y1) return true;
    const e2 = 2 * err;
    let crossedCorner = false;
    if (e2 > -dz) { err -= dz; x0 += sx; crossedCorner = true; }
    if (e2 < dx) { err += dx; y0 += sy; crossedCorner = crossedCorner && true; }
    if (crossedCorner) {
      // A diagonal that clips a corner is not a clear line of travel.
      if (nav.isBlocked(x0 - sx, y0) && nav.isBlocked(x0, y0 - sy)) return false;
    }
  }
  return false;
}

/** Drop waypoints that the line of travel can see past, so the route reads as a
 *  route and not as a staircase of one-cell jogs. */
function smoothPath(nav, pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  let anchor = 0;
  for (let i = 2; i < pts.length; i++) {
    const a = pts[anchor], b = pts[i];
    if (!segmentClear(nav, a.x, a.z, b.x, b.z)) { out.push(pts[i - 1]); anchor = i - 1; }
  }
  out.push(pts[pts.length - 1]);
  // The endpoints are the exact player/target positions, which can sit inside a
  // wall the cell path stepped around — verify every link and fall back to the
  // unsmoothed path rather than draw a route through geometry.
  for (let i = 1; i < out.length; i++) {
    if (!segmentClear(nav, out[i - 1].x, out[i - 1].z, out[i].x, out[i].z)) return pts;
  }
  return out;
}

/**
 * Octile-heuristic A* over the walkability grid.
 * Returns [{x,z},…] in world metres, or null when there is no walkable line —
 * callers must show "no route", never draw a wishful straight line.
 */
export function routeTo(geom, from, to, opts = {}) {
  opts = opts || {};
  const nav = buildNavGrid(geom, opts);
  if (!nav || !from || !to) return null;
  if (segmentClear(nav, from.x, from.z, to.x, to.z)) {
    return {
      pts: [{ x: from.x, z: from.z }, { x: to.x, z: to.z }],
      meters: Math.hypot(to.x - from.x, to.z - from.z),
      startGap: 0, endGap: 0, startSnapped: false, endSnapped: false,
      viaDoors: !!opts.throughDoors,
    };
  }
  const s = nearestFree(nav, from.x, from.z);
  const t = nearestFree(nav, to.x, to.z, opts.snapRing || 8);
  if (!s || !t) return null;
  if (s.i === t.i && s.j === t.j) {
    return {
      pts: [{ x: from.x, z: from.z }, { x: to.x, z: to.z }],
      meters: Math.hypot(to.x - from.x, to.z - from.z),
      startGap: 0, endGap: 0, startSnapped: false, endSnapped: false,
      viaDoors: !!opts.throughDoors,
    };
  }

  const nx = nav.nx, total = nx * nav.nz;
  const gScore = new Float32Array(total).fill(Infinity);
  const came = new Int32Array(total).fill(-1);
  const closed = new Uint8Array(total);
  const start = s.j * nx + s.i, goal = t.j * nx + t.i;
  const h = (i, j) => {
    const dx = Math.abs(i - t.i), dz = Math.abs(j - t.j);
    return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
  };
  // Small binary heap keyed on f: cheaper than sorting a 20k frontier each pop.
  const heapI = [], heapF = [];
  const push = (node, f) => {
    heapI.push(node); heapF.push(f);
    let c = heapI.length - 1;
    while (c > 0) { const p = (c - 1) >> 1; if (heapF[p] <= heapF[c]) break;
      [heapF[p], heapF[c]] = [heapF[c], heapF[p]]; [heapI[p], heapI[c]] = [heapI[c], heapI[p]]; c = p; }
  };
  const pop = () => {
    const top = heapI[0];
    const n = heapI.length - 1;
    heapI[0] = heapI[n]; heapF[0] = heapF[n]; heapI.pop(); heapF.pop();
    let p = 0;
    for (;;) {
      const l = 2 * p + 1, r = l + 1;
      let m = p;
      if (l < heapF.length && heapF[l] < heapF[m]) m = l;
      if (r < heapF.length && heapF[r] < heapF[m]) m = r;
      if (m === p) break;
      [heapF[p], heapF[m]] = [heapF[m], heapF[p]]; [heapI[p], heapI[m]] = [heapI[m], heapI[p]]; p = m;
    }
    return top;
  };
  gScore[start] = 0;
  push(start, h(s.i, s.j));
  let expansions = 0;
  let found = false;
  while (heapI.length) {
    const cur = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) { found = true; break; }
    if (++expansions > MAP_GEOM.maxExpansions) return null;
    const ci = cur % nx, cj = (cur - ci) / nx;
    const cg = gScore[cur];
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (nav.isBlocked(ni, nj)) continue;
        if (di && dj && (nav.isBlocked(ci + di, cj) || nav.isBlocked(ci, cj + dj))) continue; // no corner cutting
        const node = nj * nx + ni;
        if (closed[node]) continue;
        const step = (di && dj) ? Math.SQRT2 : 1;
        const ng = cg + step;
        if (ng < gScore[node] - 1e-6) {
          gScore[node] = ng;
          came[node] = cur;
          push(node, ng + h(ni, nj));
        }
      }
    }
  }
  if (!found) return null;
  const cells = [];
  for (let node = goal; node !== -1; node = came[node]) {
    const i = node % nx;
    cells.push(nav.center(i, (node - i) / nx));
    if (node === start) break;
  }
  cells.reverse();
  // The polyline is built from cell centres — every one of them walkable — and the
  // exact player / target positions are only appended when their leg is clear. An
  // intel marker inside a locked room therefore gets a route to its door plus an
  // honest `endGap`, not a line through the wall.
  const pts = cells.slice();
  let startSnapped = false, endSnapped = false;
  if (segmentClear(nav, from.x, from.z, pts[0].x, pts[0].z)) pts.unshift({ x: from.x, z: from.z });
  else startSnapped = true;
  const last = pts[pts.length - 1];
  if (segmentClear(nav, last.x, last.z, to.x, to.z)) pts.push({ x: to.x, z: to.z });
  else endSnapped = true;
  const path = smoothPath(nav, pts);
  const end = path[path.length - 1];
  return {
    pts: path,
    meters: pathLength(path),
    startSnapped, endSnapped,
    endGap: Math.hypot(end.x - to.x, end.z - to.z),
    startGap: Math.hypot(path[0].x - from.x, path[0].z - from.z),
    viaDoors: !!opts.throughDoors,
  };
}

/** Length of a polyline, in metres. */
export function pathLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return s;
}
