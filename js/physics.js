/**
 * physics.js
 * Lightweight AABB physics: a uniform spatial grid of static colliders,
 * ray casting (slab test + grid traversal), box movement with per-axis
 * resolution and sliding, and overlap queries for triggers.
 *
 * Everything is axis-aligned boxes — sufficient for an architectural
 * environment and fast enough to avoid allocations in the hot loop.
 */
import * as THREE from 'three';

export const Material = {
  CONCRETE: 'concrete',
  METAL: 'metal',
  WOOD: 'wood',
  GLASS: 'glass',
  SOIL: 'soil',
  FABRIC: 'fabric',
  GRAVEL: 'gravel',
};

const CELL = 8; // grid cell size in metres
const BIG_SPAN = 40; // colliders touching more cells than this go in the "big" list
const ACTOR_CELL = 6; // actor/vehicle bodies live in their own, denser grid
const MAX_SUBSTEP = 0.5; // horizontal metres resolved per substep (anti-tunnelling)

let _nextId = 1;

export class Collider {
  constructor(min, max, material, opts = {}) {
    this.id = _nextId++;
    this.min = min.clone();
    this.max = max.clone();
    this.material = material || Material.CONCRETE;
    this.enabled = true;
    this.breakable = !!opts.breakable;   // glass panes etc.
    this.tag = opts.tag || 'static';     // 'static' | 'door' | 'glass' | 'prop' ...
    this.entity = opts.entity || null;   // optional back-reference (Door, prop…)
    this.cells = null;                   // filled by PhysicsWorld
    this.big = false;
    this.actor = false;                  // actor-field bodies set this true
  }
}

/**
 * A solid body that belongs to a *moving* entity: characters and vehicles.
 *
 * These are deliberately kept out of the static collider grid. Re-bucketing a
 * 200-strong roster in an 8 m static grid every frame is what made the original
 * architecture avoid actor collision altogether; instead the actor field is a
 * small, cheap, per-frame grid holding only bodies that actually move. Queries
 * return objects with the same { min, max, enabled, tag, entity } shape as a
 * Collider, so every resolver in this module treats them uniformly.
 */
export class ActorBody {
  constructor(min, max, opts = {}) {
    this.id = 'a' + (_nextId++);
    this.min = min.clone();
    this.max = max.clone();
    this.material = opts.material || Material.FABRIC;
    this.tag = opts.tag || 'actor';        // 'actor' | 'vehicle'
    this.entity = opts.entity || null;     // the Enemy / Vehicle / Player
    this.enabled = true;
    this.actor = true;
    /** Characters are not floors: a body never supports or blocks a vertical
     * sweep, so nobody can stand on a head or be launched by a crouch. */
    this.blocksVertical = false;
    /** How deep a move may push this body out when something embeds it. */
    this.maxDepenetrate = opts.maxDepenetrate != null ? opts.maxDepenetrate : 0.42;
    this.mass = opts.mass != null ? opts.mass : 80;
    this.cells = null;
    this.version = 0;
  }
}

/**
 * Uniform XZ grid of dynamic solid bodies. Rebuilt lazily: `sync()` re-inserts
 * only bodies whose AABB crossed a cell boundary since the last sync, so a
 * sprinting squad costs a handful of array pushes per frame, not a rebuild.
 */
export class ActorField {
  constructor() {
    this.grid = new Map();
    this.list = [];
    this.count = 0;
    /** Bumped whenever the field is wiped, so actors re-register after a
     * mission teardown instead of keeping a stale (already-removed) body. */
    this.generation = 1;
    this.dirty = true;
    this._min = new THREE.Vector3();
    this._max = new THREE.Vector3();
  }

  add(min, max, opts) {
    const body = new ActorBody(min, max, opts);
    body._cx0 = body._cx1 = body._cz0 = body._cz1 = NaN;
    this.list.push(body);
    this.count = this.list.length;
    this._insert(body, true);
    return body;
  }

  remove(body) {
    if (!body) return;
    this._uninsert(body);
    const i = this.list.indexOf(body);
    if (i >= 0) this.list.splice(i, 1);
    this.count = this.list.length;
    body.enabled = false;
    body.cells = null;
  }

  /** Move a body to a new AABB. Only re-buckets when the cell span changes. */
  setBounds(body, min, max) {
    if (!body) return;
    body.min.copy(min);
    body.max.copy(max);
    body.version++;
    const cx0 = Math.floor(min.x / ACTOR_CELL), cx1 = Math.floor(max.x / ACTOR_CELL);
    const cz0 = Math.floor(min.z / ACTOR_CELL), cz1 = Math.floor(max.z / ACTOR_CELL);
    if (cx0 === body._cx0 && cx1 === body._cx1 && cz0 === body._cz0 && cz1 === body._cz1) return;
    this._uninsert(body);
    this._insertSpan(body, cx0, cx1, cz0, cz1);
  }

  clear() {
    for (const b of this.list) { b.cells = null; b.enabled = false; }
    this.grid.clear();
    this.list.length = 0;
    this.count = 0;
    this.generation++;
  }

  _key(cx, cz) { return cx * 1000003 ^ cz * 40503; }

  _insert(body, force) {
    const cx0 = Math.floor(body.min.x / ACTOR_CELL), cx1 = Math.floor(body.max.x / ACTOR_CELL);
    const cz0 = Math.floor(body.min.z / ACTOR_CELL), cz1 = Math.floor(body.max.z / ACTOR_CELL);
    this._insertSpan(body, cx0, cx1, cz0, cz1);
    void force;
  }

  _insertSpan(body, cx0, cx1, cz0, cz1) {
    body._cx0 = cx0; body._cx1 = cx1; body._cz0 = cz0; body._cz1 = cz1;
    body.cells = [];
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const k = this._key(cx, cz);
        let arr = this.grid.get(k);
        if (!arr) { arr = []; this.grid.set(k, arr); }
        arr.push(body);
        body.cells.push(k);
      }
    }
  }

  _uninsert(body) {
    if (!body.cells) return;
    for (const k of body.cells) {
      const arr = this.grid.get(k);
      if (!arr) continue;
      const i = arr.indexOf(body);
      if (i >= 0) arr.splice(i, 1);
    }
    body.cells = null;
    body._cx0 = body._cx1 = body._cz0 = body._cz1 = NaN;
  }

  /** Overlapping bodies for an AABB. `out` is cleared and reused. */
  /** Append every enabled body overlapping the range to `out` (the caller owns
   * the array and clears it). Clearing here used to silently discard the static
   * colliders a caller had already collected in the same array, which made
   * every `{ actors: true }` query report open space where there were walls. */
  query(min, max, out, self) {
    if (!this.count || !out) return out || [];
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    const cx0 = Math.floor(min.x / ACTOR_CELL), cx1 = Math.floor(max.x / ACTOR_CELL);
    const cz0 = Math.floor(min.z / ACTOR_CELL), cz1 = Math.floor(max.z / ACTOR_CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const arr = this.grid.get(this._key(cx, cz));
        if (!arr) continue;
        for (const b of arr) {
          if (!b.enabled || b === self || seen.has(b.id)) continue;
          if (b.max.x < min.x || b.min.x > max.x) continue;
          if (b.max.z < min.z || b.min.z > max.z) continue;
          if (b.max.y < min.y || b.min.y > max.y) continue;
          seen.add(b.id);
          out.push(b);
        }
      }
    }
    return out;
  }

  /** True when an AABB is free of every enabled actor/vehicle body. */
  isFree(min, max, self) {
    if (!this.count) return true;
    const out = this._freeList || (this._freeList = []);
    this.query(min, max, out, self);
    for (const b of out) {
      // Actors are shoulder-blockers, not floors; clearance checks care about
      // both, so anything overlapping the tested volume counts.
      if (b.max.y > min.y + 0.001 && b.min.y < max.y - 0.001) return false;
    }
    return true;
  }
}

export class PhysicsWorld {
  constructor() {
    this.colliders = [];
    this.bigColliders = [];
    this.grid = new Map(); // "cx,cz" -> Collider[]
    /** Dynamic solid bodies: every character and vehicle in the mission. */
    this.actors = new ActorField();
    // scratch objects reused across calls (no GC churn in the loop)
    this._ray = { hit: null };
    this._expandedMin = new THREE.Vector3();
    this._expandedMax = new THREE.Vector3();
    this._expandedBounds = { min: this._expandedMin, max: this._expandedMax };
    this._sweepDelta = new THREE.Vector3();
    this._sweepOptions = { radius: 0, ignore: null };
    this._sweptMin = new THREE.Vector3();
    this._sweptMax = new THREE.Vector3();
    this._actorList = [];
    this._startMin = new THREE.Vector3();
    this._startMax = new THREE.Vector3();
    this._depMin = new THREE.Vector3();
    this._depMax = new THREE.Vector3();
  }

  clear() {
    this.colliders.length = 0;
    this.bigColliders.length = 0;
    this.grid.clear();
    this.actors.clear();
  }

  _key(cx, cz) { return cx * 73856093 ^ cz * 19349663; }

  // ----- actor / vehicle bodies -------------------------------------------
  /** Register a solid moving body (character capsule proxy or vehicle hull). */
  addActorBody(min, max, opts) { return this.actors.add(min, max, opts); }
  removeActorBody(body) { this.actors.remove(body); }
  /** Keep a body's collision in lock-step with its rendered transform. */
  syncActorBody(body, min, max) { this.actors.setBounds(body, min, max); }
  /** True when nothing solid blocks a box. opts.actors includes characters
   * and vehicles; opts.ignore is a predicate over candidate bodies. */
  isBoxFree(min, max, opts = {}) {
    const list = this._freeCheck || (this._freeCheck = []);
    this.queryAABB(min, max, list, opts.actors ? ACTOR_QUERY_OPTS : undefined);
    for (const c of list) {
      if (c.enabled === false) continue;
      if (opts.ignore && opts.ignore(c)) continue;
      if (c.max.y > min.y + 0.001 && c.min.y < max.y - 0.001) return false;
    }
    return true;
  }

  /** Static collider registration: the mesh+box pair every builder funnels
   * through. `opts.dedupe` suppresses an exactly-identical AABB so the coverage
   * passes stay idempotent (re-running them can never stack duplicate boxes)
   * without changing any hand-authored collider. */
  add(min, max, material, opts) {
    const lo = Collider._dedupeMin || (Collider._dedupeMin = new THREE.Vector3());
    const hi = Collider._dedupeMax || (Collider._dedupeMax = new THREE.Vector3());
    lo.set(Math.min(min.x, max.x), Math.min(min.y, max.y), Math.min(min.z, max.z));
    hi.set(Math.max(min.x, max.x), Math.max(min.y, max.y), Math.max(min.z, max.z));
    const tag = (opts && opts.tag) || 'static';
    if (opts && opts.dedupe) {
      const near = this._dupList || (this._dupList = []);
      this.queryAABB(lo, hi, near);
      for (const c of near) {
        if (c.actor || c.tag !== tag) continue;
        if (Math.abs(c.min.x - lo.x) < 0.02 && Math.abs(c.max.x - hi.x) < 0.02 &&
            Math.abs(c.min.y - lo.y) < 0.02 && Math.abs(c.max.y - hi.y) < 0.02 &&
            Math.abs(c.min.z - lo.z) < 0.02 && Math.abs(c.max.z - hi.z) < 0.02) {
          return c;   // identical collider already exists
        }
      }
    }
    const c = new Collider(lo, hi, material, opts);
    this.colliders.push(c);

    const cx0 = Math.floor(c.min.x / CELL), cx1 = Math.floor(c.max.x / CELL);
    const cz0 = Math.floor(c.min.z / CELL), cz1 = Math.floor(c.max.z / CELL);
    const span = (cx1 - cx0 + 1) * (cz1 - cz0 + 1);

    if (span > BIG_SPAN) {
      // Very large colliders (ground slabs, long walls) are always tested.
      c.big = true;
      this.bigColliders.push(c);
      return c;
    }

    c.cells = [];
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const k = this._key(cx, cz);
        let arr = this.grid.get(k);
        if (!arr) { arr = []; this.grid.set(k, arr); }
        arr.push(c);
        c.cells.push(k);
      }
    }
    return c;
  }
  /**
   * Nearest open, floor-backed standing spot around a point. Used to repair a
   * spawn/insertion/ejection that would otherwise place an actor inside solid
   * geometry, so a blocked position never becomes a permanent trap.
   */
  findOpenNear(origin, radius = 4, halfWidth = 0.36, height = 1.85, stepUp = 0.42) {
    const probeMin = this._findMin || (this._findMin = new THREE.Vector3());
    const probeMax = this._findMax || (this._findMax = new THREE.Vector3());
    const rayOrigin = this._findRay || (this._findRay = new THREE.Vector3());
    const list = this._freeCheck || (this._freeCheck = []);
    const maxR = Math.max(0.75, radius);

    // Stage 0 — step over the obstruction we are actually inside. Rings alone
    // miss it: a vehicle hull or a building footprint is several metres across,
    // and a ring only escapes it if one of its sample angles happens to point at
    // a face. So look at what blocks the origin and try the four faces of it.
    probeMin.set(origin.x - halfWidth, origin.y + 0.03, origin.z - halfWidth);
    probeMax.set(origin.x + halfWidth, origin.y + height - 0.04, origin.z + halfWidth);
    this.queryAABB(probeMin, probeMax, list, ACTOR_QUERY_OPTS);
    let best = null;
    for (const c of list) {
      if (c.max.y <= origin.y + stepUp) continue;                 // steppable clutter
      if (c.min.y >= origin.y + height - 0.04) continue;           // overhead only
      const faces = [
        [c.min.x - halfWidth - 0.03, (c.min.z + c.max.z) * 0.5],
        [c.max.x + halfWidth + 0.03, (c.min.z + c.max.z) * 0.5],
        [(c.min.x + c.max.x) * 0.5, c.min.z - halfWidth - 0.03],
        [(c.min.x + c.max.x) * 0.5, c.max.z + halfWidth + 0.03],
      ];
      for (const f of faces) {
        const d2 = (f[0] - origin.x) ** 2 + (f[1] - origin.z) ** 2;
        if (best && d2 >= best.d2) continue;
        rayOrigin.set(f[0], origin.y + 0.6, f[1]);
        const hit = this.raycast(rayOrigin, DOWN, 4.2);
        if (!hit || hit.normal.y < 0.5) continue;
        const footY = hit.point.y + 0.02;
        probeMin.set(f[0] - halfWidth, footY + 0.03, f[1] - halfWidth);
        probeMax.set(f[0] + halfWidth, footY + height - 0.04, f[1] + halfWidth);
        const probe = this._findList || (this._findList = []);
        this.queryAABB(probeMin, probeMax, probe, ACTOR_QUERY_OPTS);
        let blocked = false;
        for (const c2 of probe) {
          if (c2.max.y <= footY + stepUp) continue;
          if (c2.min.y >= footY + height - 0.04) continue;
          blocked = true; break;
        }
        if (blocked) continue;
        best = { x: f[0], y: footY, z: f[1], d2 };
      }
    }
    if (best) return { x: best.x, y: best.y, z: best.z };

    for (let ring = 0; ring < 12; ring++) {
      const r = maxR * (ring / 11);
      const steps = ring === 0 ? 1 : Math.max(6, Math.round(r * 3));
      for (let s = 0; s < steps; s++) {
        const a = (s / steps) * Math.PI * 2;
        const x = origin.x + Math.cos(a) * r;
        const z = origin.z + Math.sin(a) * r;
        rayOrigin.set(x, origin.y + 0.6, z);
        const hit = this.raycast(rayOrigin, DOWN, 4.2);
        if (!hit || hit.normal.y < 0.5) continue;
        const footY = hit.point.y + 0.02;
        probeMin.set(x - halfWidth, footY + 0.03, z - halfWidth);
        probeMax.set(x + halfWidth, footY + height - 0.04, z + halfWidth);
        this.queryAABB(probeMin, probeMax, list, ACTOR_QUERY_OPTS);
        let blocked = false;
        for (const c of list) {
          if (c.max.y <= footY + stepUp) continue;   // steppable debris is fine
          if (c.min.y >= footY + height - 0.04) continue;
          blocked = true; break;
        }
        if (blocked) continue;
        if (Math.abs(x - origin.x) < 1e-4 && Math.abs(z - origin.z) < 1e-4 && ring === 0) continue;
        return { x, y: footY, z };
      }
    }
    return null;
  }

  /** Convenience: add a box from centre + size. */
  /**
   * Push a spawn/ejection point out of solid geometry. Every actor placement
   * (authored mission spawns, wave surges, garrison echelons, vehicle egress)
   * funnels through here, so nobody can appear inside a wall, a vehicle hull or
   * another body — and an actor that is embedded never has to escape by force.
   * Returns true when the position had to be moved.
   */
  repairSpawnPoint(pos, halfWidth = 0.34, height = 1.85, radius = 3.6, stepUp = 0.42) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return false;
    const min = this._repMin || (this._repMin = new THREE.Vector3());
    const max = this._repMax || (this._repMax = new THREE.Vector3());
    const okAt = (x, y, z) => {
      min.set(x - halfWidth, y + 0.03, z - halfWidth);
      max.set(x + halfWidth, y + height - 0.04, z + halfWidth);
      return this.isBoxFree(min, max, { actors: true });
    };
    if (okAt(pos.x, pos.y, pos.z)) return false;
    const open = this.findOpenNear(pos, radius, halfWidth, height, stepUp);
    if (open && Math.abs(open.x - pos.x) < 1e-4 && Math.abs(open.z - pos.z) < 1e-4 && Math.abs(open.y - pos.y) < 1e-4) {
      open.x = pos.x; open.y = pos.y; open.z = pos.z;      // ring-0 no-op: treat as no repair
      open._noop = true;
    }
    if (!open || open._noop) {
      // last resort: raise out of the obstruction a little and hope for a floor
      const y2 = pos.y + Math.max(0.0, height - 0.05);
      if (okAt(pos.x, y2, pos.z)) { pos.set(pos.x, y2, pos.z); return true; }
      return false;
    }
    pos.set(open.x, open.y, open.z);
    return true;
  }

  addBox(center, size, material, opts) {
    const hs = size.clone().multiplyScalar(0.5);
    return this.add(center.clone().sub(hs), center.clone().add(hs), material, opts);
  }

  remove(c) {
    const i = this.colliders.indexOf(c);
    if (i >= 0) this.colliders.splice(i, 1);
    if (c.big) {
      const j = this.bigColliders.indexOf(c);
      if (j >= 0) this.bigColliders.splice(j, 1);
    } else if (c.cells) {
      for (const k of c.cells) {
        const arr = this.grid.get(k);
        if (arr) {
          const idx = arr.indexOf(c);
          if (idx >= 0) arr.splice(idx, 1);
        }
      }
    }
  }

  /** Gather candidate colliders overlapping a world-space AABB.
   * With `opts.actors` the dynamic actor/vehicle bodies in the same volume are
   * appended, so movement queries and clearance tests see the same world that
   * the player sees. */
  queryAABB(min, max, out, opts) {
    out.length = 0;
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    // Very large colliders (ground slabs, long walls) bypass the spatial grid,
    // so they are always CONSIDERED here - but they still have to pass the same
    // overlap test as grid colliders. Returning them unconditionally meant a
    // big collider anywhere in the world registered as a hit for every query,
    // so e.g. a roof slab at y=10 blocked the player from standing up at y=1.8.
    for (const c of this.bigColliders) {
      if (!c.enabled || seen.has(c.id)) continue;
      if (c.max.x < min.x || c.min.x > max.x) continue;
      if (c.max.z < min.z || c.min.z > max.z) continue;
      if (c.max.y < min.y || c.min.y > max.y) continue;
      seen.add(c.id);
      out.push(c);
    }
    const cx0 = Math.floor(min.x / CELL), cx1 = Math.floor(max.x / CELL);
    const cz0 = Math.floor(min.z / CELL), cz1 = Math.floor(max.z / CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const arr = this.grid.get(this._key(cx, cz));
        if (!arr) continue;
        for (const c of arr) {
          if (!c.enabled || seen.has(c.id)) continue;
          if (c.max.x < min.x || c.min.x > max.x) continue;
          if (c.max.z < min.z || c.min.z > max.z) continue;
          if (c.max.y < min.y || c.min.y > max.y) continue;
          seen.add(c.id);
          out.push(c);
        }
      }
    }
    if (opts && opts.actors) this.actors.query(min, max, out, opts.self);
    return out;
  }

  /**
   * Amanatides–Woo style grid walk collecting candidates along a ray,
   * then exact slab tests. Returns the nearest hit:
   * { dist, point, normal, collider } or null.
   */
  raycast(origin, dir, maxDist, opts = {}) {
    const ignore = opts.ignore || null; // Set of collider ids, or predicate(collider)
    const radius = Math.max(0, opts.radius || 0);
    const withActors = !!opts.actors && this.actors.count > 0;
    const actorGrid = withActors ? this.actors.grid : null;
    const actorKey = withActors ? this.actors._key : null;
    let best = null;
    let bestDist = maxDist;

    const test = (c) => {
      if (!c.enabled) return;
      if (ignore) {
        if (typeof ignore === 'function') { if (ignore(c)) return; }
        else if (ignore.has(c.id)) return;
      }
      let min = c.min, max = c.max, bounds = c;
      if (radius > 0) {
        min = this._expandedMin.copy(c.min).addScalar(-radius);
        max = this._expandedMax.copy(c.max).addScalar(radius);
        bounds = this._expandedBounds;
      }
      const d = rayAABB(origin, dir, min, max, bestDist);
      if (d !== null && d < bestDist) {
        bestDist = d;
        if (!best) best = { dist: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), collider: null };
        best.dist = d;
        best.collider = c;
        best.point.copy(origin).addScaledVector(dir, d);
        hitNormal(origin, dir, bounds, best.point, best.normal);
      }
    };

    const seen = this._raySeen || (this._raySeen = new Set());
    seen.clear();

    for (const c of this.bigColliders) {
      seen.add(c.id);
      test(c);
    }
    if (withActors) {
      // dynamic bodies are few and local; test the ones around the origin cell
      const ox = Math.floor(origin.x / CELL), oz = Math.floor(origin.z / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const arr = actorGrid.get(actorKey(ox + dx, oz + dz));
        if (!arr) continue;
        for (const c of arr) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          test(c);
        }
      }
    }

    // Walk grid cells along the ray (XZ plane; Y handled by exact tests).
    let cx = Math.floor(origin.x / CELL);
    let cz = Math.floor(origin.z / CELL);
    const stepX = dir.x > 0 ? 1 : -1;
    const stepZ = dir.z > 0 ? 1 : -1;
    const tDeltaX = dir.x !== 0 ? Math.abs(CELL / dir.x) : Infinity;
    const tDeltaZ = dir.z !== 0 ? Math.abs(CELL / dir.z) : Infinity;
    let tMaxX = dir.x !== 0
      ? ((stepX > 0 ? (cx + 1) * CELL - origin.x : origin.x - cx * CELL) / Math.abs(dir.x))
      : Infinity;
    let tMaxZ = dir.z !== 0
      ? ((stepZ > 0 ? (cz + 1) * CELL - origin.z : origin.z - cz * CELL) / Math.abs(dir.z))
      : Infinity;

    let t = 0;
    let guard = 0;
    while (t <= bestDist && guard++ < 512) {
      const arr = this.grid.get(this._key(cx, cz));
      if (arr) {
        for (const c of arr) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          test(c);
        }
      }
      if (actorGrid) {
        const aarr = actorGrid.get(actorKey(cx, cz));
        if (aarr) {
          for (const c of aarr) {
            if (seen.has(c.id)) continue;
            seen.add(c.id);
            test(c);
          }
        }
      }
      if (tMaxX < tMaxZ) { t = tMaxX; tMaxX += tDeltaX; cx += stepX; }
      else { t = tMaxZ; tMaxZ += tDeltaZ; cz += stepZ; }
    }

    return best;
  }

  /** Sweep a small sphere along a segment. The returned point is the swept
   * sphere centre at first contact; its normal is from the expanded AABB.
   * This is used by low-count physical projectiles to prevent tunnelling. */
  sweepSphere(start, end, radius = 0, ignore = null) {
    const delta = this._sweepDelta.copy(end).sub(start);
    const dist = delta.length();
    if (dist < 0.0001) return null;
    delta.multiplyScalar(1 / dist);
    this._sweepOptions.radius = Math.max(0, radius);
    this._sweepOptions.ignore = ignore;
    return this.raycast(start, delta, dist, this._sweepOptions);
  }

  /** Quick boolean line-of-sight test. */
  hasLOS(a, b, ignore) {
    const delta = _losVec.copy(b).sub(a);
    const dist = delta.length();
    if (dist < 0.001) return true;
    delta.divideScalar(dist);
    const hit = this.raycast(a, delta, dist, { ignore });
    return hit === null;
  }

  /**
   * Move an AABB by (dx,dy,dz) resolving collisions per-axis so the box
   * slides along surfaces. Mutates box.min / box.max in place.
   * stepHeight: if > 0 (and the mover is grounded), low obstructions such as
   * stair treads are stepped onto instead of blocking movement.
   *
   * opts:
   *   ignoreBody  - actor body belonging to the mover (never self-collide).
   *   actors      - false to resolve against static geometry only.
   *   selfPush    - scale applied to the depenetration push (1 for movers that
   *                 should also shove others aside; default 1).
   *   onContact   - callback(body, nx, nz, closingSpeed) for actor impacts.
   *
   * Returns { onGround, hitX, hitZ, hitCeil, steppedUp, groundCollider,
   *           contactedActor, depenetrated }.
   */
  moveBox(box, dx, dy, dz, out, stepHeight = 0, opts = EMPTY_OPTS) {
    out.onGround = false; out.hitX = false; out.hitZ = false; out.hitCeil = false;
    out.steppedUp = false;
    out.groundCollider = null;
    out.contactedActor = false;
    out.depenetrated = false;
    out.blockedSolid = false;
    const contacts = out.actorContacts || (out.actorContacts = []);
    contacts.length = 0;
    out.actorContact = null;

    const list = this._moveList || (this._moveList = []);
    const actorList = this._actorList;
    const useActors = opts.actors !== false && this.actors.count > 0;
    const selfBody = opts.ignoreBody || null;
    const EPS = 0.001;
    const SKIN = 0.002;

    // Horizontal travel is sub-stepped so a fast mover (sprint, vehicle) can
    // never cross a thin wall between two frames.
    const hMag = Math.hypot(dx, dz);   // requested travel; contacts carry it so an
                                          // impact reads the *intent*, not the damped residue
    const steps = hMag > MAX_SUBSTEP ? Math.min(8, Math.ceil(hMag / MAX_SUBSTEP)) : 1;
    const sx = dx / steps, sz = dz / steps;

    this._startMin.copy(box.min);
    this._startMax.copy(box.max);

    for (let step = 0; step < steps; step++) {
      // --- X axis ---
      if (sx !== 0) {
        box.min.x += sx; box.max.x += sx;
        this.queryAABB(box.min, box.max, list);
        actorList.length = 0;
        if (useActors) this.actors.query(box.min, box.max, actorList, selfBody);
        for (let pass = 0; pass < 2; pass++) {
          const src = pass === 0 ? list : actorList;
          for (const c of src) {
            if (c.max.x <= box.min.x || c.min.x >= box.max.x) continue;
            if (c.max.y <= box.min.y + EPS || c.min.y >= box.max.y - EPS) continue;
            if (c.max.z <= box.min.z + SKIN || c.min.z >= box.max.z - SKIN) continue;
            if (stepHeight > 0 && pass === 0) {
              const rise = c.max.y - box.min.y;
              if (rise > EPS && rise <= stepHeight) {
                const h = box.max.y - box.min.y;
                box.min.y = c.max.y + EPS; box.max.y = box.min.y + h;
                out.steppedUp = true;
                continue;
              }
            }
            if (sx > 0) { const w = box.max.x - box.min.x; box.max.x = c.min.x - EPS; box.min.x = box.max.x - w; }
            else { const w = box.max.x - box.min.x; box.min.x = c.max.x + EPS; box.max.x = box.min.x + w; }
            out.hitX = true;
            if (pass === 1) {
              out.contactedActor = true;
              out.actorContact = c;
              out.actorNormalX = sx > 0 ? -1 : 1;
              out.actorNormalZ = 0;
              contacts.push(c, sx > 0 ? -1 : 1, 0, hMag);
            }
          }
        }
      }

      // --- Z axis ---
      if (sz !== 0) {
        box.min.z += sz; box.max.z += sz;
        this.queryAABB(box.min, box.max, list);
        actorList.length = 0;
        if (useActors) this.actors.query(box.min, box.max, actorList, selfBody);
        for (let pass = 0; pass < 2; pass++) {
          const src = pass === 0 ? list : actorList;
          for (const c of src) {
            if (c.max.z <= box.min.z || c.min.z >= box.max.z) continue;
            if (c.max.y <= box.min.y + EPS || c.min.y >= box.max.y - EPS) continue;
            if (c.max.x <= box.min.x + SKIN || c.min.x >= box.max.x - SKIN) continue;
            if (stepHeight > 0 && pass === 0) {
              const rise = c.max.y - box.min.y;
              if (rise > EPS && rise <= stepHeight) {
                const h = box.max.y - box.min.y;
                box.min.y = c.max.y + EPS; box.max.y = box.min.y + h;
                out.steppedUp = true;
                continue;
              }
            }
            const w = box.max.z - box.min.z;
            if (sz > 0) { box.max.z = c.min.z - EPS; box.min.z = box.max.z - w; }
            else { box.min.z = c.max.z + EPS; box.max.z = box.min.z + w; }
            out.hitZ = true;
            if (pass === 1) {
              out.contactedActor = true;
              out.actorContact = c;
              out.actorNormalX = 0;
              out.actorNormalZ = sz > 0 ? -1 : 1;
              contacts.push(c, 0, sz > 0 ? -1 : 1, hMag);
            }
          }
        }
      }
      if (steps > 1 && (out.hitX || out.hitZ)) break;   // slide resumes from here
    }

    // --- Y axis ---
    // Sweep the full vertical segment, not only the final AABB. Large falls
    // could otherwise cross a thin floor between frames. Only accept a floor/
    // ceiling whose surface was approached from outside, so a box spawned
    // deeply embedded in a prop is not launched to its top.
    if (dy !== 0) {
      const oldMinY = box.min.y, oldMaxY = box.max.y;
      const newMinY = oldMinY + dy, newMaxY = oldMaxY + dy;
      const sweptMin = this._sweptMin.set(box.min.x, Math.min(oldMinY, newMinY), box.min.z);
      const sweptMax = this._sweptMax.set(box.max.x, Math.max(oldMaxY, newMaxY), box.max.z);
      this.queryAABB(sweptMin, sweptMax, list);
      let resolved = false;
      if (dy < 0) {
        let floorY = -Infinity, floor = null;
        for (const c of list) {
          if (c.max.x <= box.min.x + EPS || c.min.x >= box.max.x - EPS) continue;
          if (c.max.z <= box.min.z + EPS || c.min.z >= box.max.z - EPS) continue;
          if (c.max.y <= oldMinY + EPS && c.max.y >= newMinY - EPS && c.max.y > floorY) {
            floorY = c.max.y; floor = c;
          }
        }
        if (floor) {
          const h = oldMaxY - oldMinY;
          box.min.y = floorY + EPS; box.max.y = box.min.y + h;
          out.onGround = true; out.groundCollider = floor; resolved = true;
        }
      } else {
        let ceilingY = Infinity, ceiling = null;
        for (const c of list) {
          if (c.max.x <= box.min.x + EPS || c.min.x >= box.max.x - EPS) continue;
          if (c.max.z <= box.min.z + EPS || c.min.z >= box.max.z - EPS) continue;
          if (c.min.y >= oldMaxY - EPS && c.min.y <= newMaxY + EPS && c.min.y < ceilingY) {
            ceilingY = c.min.y; ceiling = c;
          }
        }
        if (ceiling) {
          const h = oldMaxY - oldMinY;
          box.max.y = ceilingY - EPS; box.min.y = box.max.y - h;
          out.hitCeil = true; resolved = true;
        }
      }
      if (!resolved) { box.min.y = newMinY; box.max.y = newMaxY; }
    } else {
      // standing still vertically — probe just below the feet for ground state
      const probeMin = _probeMin.set(box.min.x, box.min.y - 0.06, box.min.z);
      const probeMax = _probeMax.set(box.max.x, box.min.y + 0.01, box.max.z);
      this.queryAABB(probeMin, probeMax, list);
      for (const c of list) {
        if (c.max.y <= box.min.y - 0.06 || c.min.y >= box.max.y) continue;
        if (c.max.x <= box.min.x + EPS || c.min.x >= box.max.x - EPS) continue;
        if (c.max.z <= box.min.z + EPS || c.min.z >= box.max.z - EPS) continue;
        if (Math.abs(c.max.y - box.min.y) < 0.07) { out.onGround = true; out.groundCollider = c; break; }
      }
    }

    // --- horizontal depenetration (spawned-inside / squeeze cases) ---
    //
    // Bounded and wall-aware on purpose. An unbounded min-penetration push is
    // how an actor being shoved by another actor ends up teleported through the
    // wall behind it: the push distance equals the overlap, which for a deep
    // overlap exceeds the wall thickness. Each candidate is therefore pushed out
    // along the axis needing the least travel, only when that travel is within
    // maxDepenetrate, and only when the resulting box is free of static geometry.
    // When neither axis qualifies, the mover keeps this frame's pre-move XZ (a
    // blocked frame) instead of being flung, and the caller's stuck-recovery runs.
    this.queryAABB(box.min, box.max, list, useActors ? ACTOR_QUERY_OPTS : undefined);
    if (list.length) {
      const maxPush = opts.maxDepenetrate != null ? opts.maxDepenetrate : 0.42;
      const depMin = this._depMin, depMax = this._depMax;
      const checkFree = () => {
        depMin.copy(box.min); depMax.copy(box.max);
        return this.isBoxFree(depMin, depMax, {
          ignore: (cand) => cand === selfBody || (cand.tag === 'actor' && !!selfBody && cand.entity === selfBody.entity),
          ignoreActors: true,
        });
      };
      for (const c of list) {
        if (c === selfBody || !c.enabled) continue;
        if (c.actor && c.blocksVertical === false) {
          // Characters block shoulders, not ankles: a brush against the boots is
          // not a squeeze event and must not trigger a depenetration shove.
          const torso = Math.min(box.max.y, c.max.y) - Math.max(box.min.y + 0.35, c.min.y + 0.35);
          if (torso < 0.12) continue;
        }
        const ox = Math.min(box.max.x - c.min.x, c.max.x - box.min.x);
        const oy = Math.min(box.max.y - c.min.y, c.max.y - box.min.y);
        const oz = Math.min(box.max.z - c.min.z, c.max.z - box.min.z);
        if (ox <= EPS || oy <= EPS || oz <= EPS) continue; // no real overlap
        const hw = box.max.x - box.min.x, hd = box.max.z - box.min.z;
        const preMinX = this._startMin.x, preMaxX = this._startMax.x;
        const preMinZ = this._startMin.z, preMaxZ = this._startMax.z;
        const toMinX = (box.min.x + box.max.x) * 0.5 < (c.min.x + c.max.x) * 0.5;
        const toMinZ = (box.min.z + box.max.z) * 0.5 < (c.min.z + c.max.z) * 0.5;
        const pushX = toMinX ? (c.min.x - EPS - box.max.x) : (c.max.x + EPS - box.min.x);
        const pushZ = toMinZ ? (c.min.z - EPS - box.max.z) : (c.max.z + EPS - box.min.z);
        let done = false;
        const tryPush = (axis, amount) => {
          if (!Number.isFinite(amount) || Math.abs(amount) > maxPush + EPS || Math.abs(amount) <= EPS) return false;
          if (axis === 0) { box.min.x += amount; box.max.x += amount; }
          else { box.min.z += amount; box.max.z += amount; }
          if (!checkFree()) {
            if (axis === 0) { box.min.x -= amount; box.max.x -= amount; }
            else { box.min.z -= amount; box.max.z -= amount; }
            return false;
          }
          out.depenetrated = true;
          done = true;
          return true;
        };
        if (Math.abs(pushX) <= Math.abs(pushZ)) { if (!tryPush(0, pushX)) tryPush(1, pushZ); }
        else { if (!tryPush(1, pushZ)) tryPush(0, pushX); }
        if (!done) {
          box.min.x = preMinX; box.max.x = preMinX + hw;
          box.min.z = preMinZ; box.max.z = preMinZ + hd;
          out.blockedSolid = true;
        }
      }
    }

    return out;
  }
}
// ---------------------------------------------------------------
// Ray / AABB helpers
// ---------------------------------------------------------------

/** Slab test. Returns entry distance within [0, maxDist] or null. */
export function rayAABB(origin, dir, min, max, maxDist) {
  let tmin = 0;
  let tmax = maxDist;

  for (let i = 0; i < 3; i++) {
    const o = i === 0 ? origin.x : i === 1 ? origin.y : origin.z;
    const d = i === 0 ? dir.x : i === 1 ? dir.y : dir.z;
    const lo = i === 0 ? min.x : i === 1 ? min.y : min.z;
    const hi = i === 0 ? max.x : i === 1 ? max.y : max.z;

    if (Math.abs(d) < 1e-8) {
      if (o < lo || o > hi) return null;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

/** Determine which face was entered to get a proper normal. */
function hitNormal(origin, dir, c, point, normal) {
  const EPS = 0.005;
  normal.set(0, 1, 0);
  if (Math.abs(point.x - c.min.x) < EPS && dir.x > 0) normal.set(-1, 0, 0);
  else if (Math.abs(point.x - c.max.x) < EPS && dir.x < 0) normal.set(1, 0, 0);
  else if (Math.abs(point.y - c.min.y) < EPS && dir.y > 0) normal.set(0, -1, 0);
  else if (Math.abs(point.y - c.max.y) < EPS && dir.y < 0) normal.set(0, 1, 0);
  else if (Math.abs(point.z - c.min.z) < EPS && dir.z > 0) normal.set(0, 0, -1);
  else if (Math.abs(point.z - c.max.z) < EPS && dir.z < 0) normal.set(0, 0, 1);
  return normal;
}

/** Ray vs oriented-ish test against an entity AABB with local hit info (used for hit zones). */
export function rayAABBLocal(origin, dir, min, max, maxDist, outLocal) {
  const d = rayAABB(origin, dir, min, max, maxDist);
  if (d === null) return null;
  if (outLocal) {
    outLocal.x = origin.x + dir.x * d;
    outLocal.y = origin.y + dir.y * d - min.y;   // height above the entity's feet
    outLocal.z = origin.z + dir.z * d;
    outLocal.dist = d;
  }
  return d;
}

const _losVec = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);
const EMPTY_OPTS = Object.freeze({});
const ACTOR_QUERY_OPTS = Object.freeze({ actors: true });
const _probeMin = new THREE.Vector3();
const _probeMax = new THREE.Vector3();
