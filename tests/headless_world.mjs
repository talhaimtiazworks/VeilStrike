/**
 * headless_world.mjs — shared headless bootstrap for geometry/collision audits.
 *
 * Provides the minimum DOM stubs Three.js needs for procedural CanvasTextures,
 * plus a factory that builds a finished map (legacy or one of the 100 campaign
 * operations) exactly the way `GameWorld.buildByMap()` does at runtime, so every
 * audit below measures the real shipping geometry and the real PhysicsWorld.
 */
import * as THREE from 'three';
import { GameWorld } from '../js/world.js';
import { PhysicsWorld } from '../js/physics.js';
import { MISSION_DEFS } from '../js/missions.js';
import { MISSION_ORDER } from '../js/progress.js';

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

let _stubsInstalled = false;
export function installStubs() {
  if (_stubsInstalled) return;
  _stubsInstalled = true;
  globalThis.THREE = THREE;
  globalThis.document = {
    baseURI: 'https://example.test/',
    createElement: (tag) => (tag === 'canvas' ? makeCanvas() : {}),
  };
  globalThis.window = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
  globalThis.requestAnimationFrame = (fn) => { queueMicrotask(fn); return 1; };
  globalThis.localStorage = {
    _s: new Map(),
    getItem(k) { return this._s.has(k) ? this._s.get(k) : null; },
    setItem(k, v) { this._s.set(k, String(v)); },
    removeItem(k) { this._s.delete(k); },
  };
  globalThis.navigator = { getGamepads: () => [], userAgent: 'node' };
}

/** Build one map. Returns { world, physics, scene }. */
export function buildMap(mapId) {
  installStubs();
  const world = new GameWorld();
  const scene = new THREE.Scene();
  const physics = new PhysicsWorld();
  world.buildByMap(mapId, scene, physics);
  world.group.updateMatrixWorld(true);
  return { world, physics, scene };
}

/** All 100 campaign operations in play order: { op, id, layoutId }. */
export function campaignMaps() {
  installStubs();
  return MISSION_ORDER.slice(0, 100).map((id, i) => ({
    op: i + 1,
    id,
    layoutId: MISSION_DEFS[id].map,
    act: MISSION_DEFS[id].act ?? (1 + Math.floor(i / 20)),
  }));
}

export { THREE };

// ---------------------------------------------------------------------------
// Scene-graph → AABB extraction shared by the coverage audit and the tests.
// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

/** World-space AABB of one (possibly instanced) mesh, merged across instances. */
export function meshWorldBox(node, out) {
  const geo = node.geometry;
  if (!geo) return null;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const local = geo.boundingBox;
  if (!local) return null;
  out.copy(local);
  if (node.isInstancedMesh && node.count > 0) {
    // merge a bounded sample of instance transforms (full merge is exact and
    // still cheap for the counts used by the kit batches)
    const union = new THREE.Box3();
    const limit = Math.min(node.count, 512);
    let first = true;
    for (let i = 0; i < limit; i++) {
      node.getMatrixAt(i, _m);
      _m.premultiply(node.matrixWorld);
      const b = local.clone().applyMatrix4(_m);
      if (first) { union.copy(b); first = false; } else union.union(b);
    }
    out.copy(union);
    return out;
  }
  out.applyMatrix4(node.matrixWorld);
  return out;
}

/** Classify a render node for collision purposes. */
export function classifyNode(node, box) {
  // A surface whose builder recorded an explicit decision is never reported as
  // a gap: 'skip' means "deliberately non-solid" (grass, paint, curbs, pipes).
  const authored = node.userData && node.userData.col !== undefined;
  const name = (node.name || '').toLowerCase();
  const mat = Array.isArray(node.material) ? node.material[0] : node.material;
  const matName = ((mat && mat.name) || '').toLowerCase();
  const geoType = (node.geometry && node.geometry.type) || '';
  const blob = `${name} ${matName}`;
  const NON_SOLID = /grass|foliage|leaf|mote|dust|smoke|flame|fire|glow|light|beam|decal|stripe|paint|mark|line|shadow|glass_shard|bird|bird|sprite|particle|hint|label|text|arrow|hologram|scan|ripple|wake|water_surface/;
  if (mat && (mat.transparent === true && mat.opacity < 0.92)) return { solid: false, reason: 'transparent' };
  if (NON_SOLID.test(blob)) return { solid: false, reason: 'named-decor' };
  if (geoType === 'PlaneGeometry' && box.max.y - box.min.y < 0.05) return { solid: false, reason: 'flat-plane' };
  const sx = box.max.x - box.min.x, sy = box.max.y - box.min.y, sz = box.max.z - box.min.z;
  const volume = sx * sy * sz;
  // Anything with real thickness and mass-equivalent footprint is solid.
  const thick = [sx, sy, sz].filter((v) => v >= 0.12).length;
  if (authored && node.userData.col === 'skip') return { solid: false, reason: 'authored-nonsolid' };
  if (authored) return { solid: true, reason: 'authored-solid', collider: true };
  if (thick >= 2 && volume >= 0.02) return { solid: true, reason: 'volume' };
  return { solid: false, reason: 'sub-threshold' };
}

export function overlapAreaXZ(a, b) {
  const ox = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  const oz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
  return ox > 0 && oz > 0 ? ox * oz : 0;
}
export function boxVolume(b) {
  return Math.max(0, b.max.x - b.min.x) * Math.max(0, b.max.y - b.min.y) * Math.max(0, b.max.z - b.min.z);
}
export { _pos, _quat, _scale, _m };
