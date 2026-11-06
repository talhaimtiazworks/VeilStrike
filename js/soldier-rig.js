/**
 * VEILSTRIKE — skinned soldier presentation layer.
 *
 * The CC0 Grab3D "Soldier" (rigged) mesh, decimated to ~9k triangles, is
 * driven by CC0 Quaternius Universal Animation Library clips that were
 * retargeted offline onto its 24-joint skeleton (see tools/README in the
 * report). This module is PRESENTATION ONLY:
 *   - AI, movement, hit boxes, damage, muzzle/shot origin and timings stay in
 *     enemies.js and the invisible procedural "logic rig" (enemy-soldier.js).
 *   - The skinned body reads gameplay state every frame (speed from actual
 *     displacement, crouch, aim pitch, reload, fire kick, flinch, death) and
 *     never writes it back. No root motion is applied: clips are in-place.
 *   - If the asset fails to load, attachSoldierRig() returns null and the
 *     procedural soldier is rendered exactly as before.
 *
 * Per-frame code is allocation free (module scratch objects only).
 */
import * as THREE from 'three';
import { GLTFLoader } from '../assets/vendor/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from '../assets/vendor/jsm/utils/SkeletonUtils.js';

const ASSET_URL = new URL('../assets/characters/vs_soldier.glb', import.meta.url).href;
const TARGET_HEIGHT = 1.76;          // metres, matches the procedural soldier / hit box
// Wrist-bone targets in held-weapon space (origin = trigger grip, -Z = bore).
// The wrist joint sits ~7 cm behind/below the palm that wraps the grip.
const GRIP_R = new THREE.Vector3(0.012, -0.045, 0.07);
const GRIP_L = new THREE.Vector3(-0.045, -0.025, 0.06);
const HANDGUARD = { rifle: 0.25, smg: 0.13, lmg: 0.31, marksman: 0.38, shotgun: 0.16 };
// Driving_Loop hips sit at floor+~0.62 m; the PlayerBody seat root is the seat base.
const VEHICLE_SEAT_DROP = -0.12;
const TUNE = { rollR: 0, rollL: -1.7, lean: 0.1 };
if (typeof window !== 'undefined' && window.__vsRigTune) Object.assign(TUNE, window.__vsRigTune);
const GAITS = ['walk', 'jog', 'sprint', 'crouch_walk'];
const LOCO = ['idle', 'walk', 'jog', 'sprint', 'crouch_idle', 'crouch_walk'];
const ONESHOT = ['hit_chest', 'hit_head', 'death'];
const REQUIRED_BONES = ['Hips', 'Spine02', 'Spine01', 'Spine', 'neck', 'Head',
  'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand'];

// Stance-foot speeds (m/s at timeScale 1) measured from the retargeted clips;
// used to sync gait cadence to real ground speed so feet do not slide.
// Measured with a stance-foot test (rigcal): ground speed of the planted toe
// at timeScale 1. Cadence = speed / natural, clamped to a believable range so
// slow AI movement never plays the long-stride UAL jog in slow motion.
const STRIDE_SPEED = { walk: 0.89, jog: 5.41, sprint: 8.21, crouch_walk: 0.654 };
const TS_RANGE = { walk: [0.65, 2.0], jog: [0.55, 1.25], sprint: [0.6, 1.2], crouch_walk: [0.6, 2.3] };

const state = {
  status: 'idle',       // idle | loading | ready | failed
  promise: null,
  error: null,
  template: null,       // wrapper Group (unit scale, faces -Z)
  clips: null,          // name -> AnimationClip
  baseMaterial: null,
  tintMats: new Map(),
  meta: null,
  bindBoneWorld: null,  // name -> { pos, quat, scale } in template space
  kitCache: new Map(),
  loadMs: 0,
};

/** Begin (or join) loading the shared soldier asset. Never rejects. */
export function loadSoldierAsset() {
  if (state.promise) return state.promise;
  if (typeof window !== 'undefined' && /[?&]vsprocedural\b/.test(window.location.search)) {
    state.status = 'failed'; state.error = 'disabled by ?vsprocedural';
    state.promise = Promise.resolve(false);
    return state.promise;
  }
  state.status = 'loading';
  const t0 = performance.now();
  state.promise = new GLTFLoader().loadAsync(ASSET_URL).then((gltf) => {
    prepareTemplate(gltf);
    state.loadMs = Math.round(performance.now() - t0);
    state.status = 'ready';
    return true;
  }).catch((err) => {
    state.status = 'failed';
    state.error = String(err && err.message || err);
    console.warn('[soldier-rig] asset unavailable, using procedural soldiers:', state.error);
    return false;
  });
  return state.promise;
}

/** Resolve when the asset is ready, or after `ms` (procedural fallback). */
export function awaitSoldierAsset(ms = 8000) {
  const p = loadSoldierAsset();
  if (state.status === 'ready' || state.status === 'failed') return Promise.resolve(state.status === 'ready');
  return Promise.race([p, new Promise((r) => setTimeout(() => r(false), ms))]);
}

export function soldierAssetStatus() {
  return {
    status: state.status, error: state.error, loadMs: state.loadMs,
    clips: state.clips ? Object.keys(state.clips) : [],
    tris: state.meta ? state.meta.tris : 0,
  };
}

function prepareTemplate(gltf) {
  const scene = gltf.scene;
  let skinned = null;
  scene.traverse((o) => { if (o.isSkinnedMesh && !skinned) skinned = o; });
  if (!skinned) throw new Error('no skinned mesh in soldier asset');
  for (const name of REQUIRED_BONES) {
    if (!scene.getObjectByName(name)) throw new Error(`missing bone ${name}`);
  }
  const clips = {};
  for (const clip of gltf.animations) clips[clip.name] = clip;
  for (const name of LOCO.concat(ONESHOT)) if (!clips[name]) throw new Error(`missing clip ${name}`);

  // Model faces +Z in the source; the game convention is -Z forward.
  const wrapper = new THREE.Group();
  wrapper.name = 'vs-skinned-soldier';
  scene.rotation.y = Math.PI;
  wrapper.add(scene);
  wrapper.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(skinned, true);
  const height = Math.max(0.5, box.max.y - box.min.y);
  const s = TARGET_HEIGHT / height;
  scene.scale.setScalar(s);
  scene.position.y = -box.min.y * s;
  wrapper.updateMatrixWorld(true);

  skinned.castShadow = true;
  skinned.receiveShadow = false;
  // Conservative culling sphere in the skinned mesh's OWN space (it sits
  // under the cm-scaled Armature): bind-pose skinned sphere, centred on the
  // body axis and enlarged so crouch/sprint/death poses are never culled.
  skinned.computeBoundingSphere();
  skinned.boundingSphere.center.x = 0;
  skinned.boundingSphere.center.z = 0;
  skinned.boundingSphere.radius *= 1.35;

  const mat = skinned.material;
  mat.metalness = 0;
  mat.roughness = 0.86;
  mat.envMapIntensity = 0.6;
  state.baseMaterial = mat;

  // Bind-pose bone frames (in wrapper space) for building kit attachments.
  const bind = new Map();
  const inv = new THREE.Matrix4().copy(wrapper.matrixWorld).invert();
  scene.traverse((o) => {
    if (!o.isBone) return;
    const m = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
    m.decompose(pos, quat, scale);
    bind.set(o.name, { pos, quat, scale });
  });
  state.bindBoneWorld = bind;
  state.template = wrapper;
  state.clips = clips;
  state.meta = (scene.userData && scene.userData.vsSoldier) || gltf.parser?.json?.scenes?.[0]?.extras?.vsSoldier || {};
  if (!state.meta.tris) state.meta.tris = (skinned.geometry.index ? skinned.geometry.index.count : 0) / 3;
}

function tintedMaterial(hex) {
  if (!hex || hex === 0xffffff) return state.baseMaterial;
  let m = state.tintMats.get(hex);
  if (!m) {
    m = state.baseMaterial.clone();
    m.color.setHex(hex);
    m.name = `vs_soldier_tint_${hex.toString(16)}`;
    state.tintMats.set(hex, m);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Class kit: rigid armour pieces parented to bones. Geometry is built once per
// (kit, palette) in bind-pose wrapper space, converted to bone-local space and
// merged into ONE vertex-coloured mesh per bone, shared by all instances.
// ---------------------------------------------------------------------------
const KIT_MATERIAL = { mat: null };
function kitMaterial() {
  if (!KIT_MATERIAL.mat) {
    KIT_MATERIAL.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.08, side: THREE.DoubleSide });
    KIT_MATERIAL.mat.name = 'vs_soldier_kit';
  }
  return KIT_MATERIAL.mat;
}

const _boxGeo = new THREE.BoxGeometry(1, 1, 1);
const _cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1);
const _sphGeo = new THREE.SphereGeometry(0.5, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.62);
// Open half-cylinder facing -Z: wraps the jaw/eyes (masks, mandible, visor).
const _arcGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 14, 1, true, Math.PI / 2, Math.PI);

/**
 * Piece spec: { bone, shape: 'box'|'cyl'|'dome', at: [x,y,z] offset from the
 * bone's bind position in metres (wrapper space, -Z = front, +X = model
 * right), size: [x,y,z], rot: [x,y,z] radians, color }.
 */
function kitPieces(kit, colors, faceCover = false) {
  const P = [];
  const add = (bone, shape, at, size, color, rot = null) => P.push({ bone, shape, at, size, color, rot });
  const armour = colors.armor, strap = colors.webbing, cloth = colors.cloth, dark = colors.dark, pack = colors.pack;
  const helmetCover = () => {
    add('Head', 'dome', [0, 0.085, 0.005], [0.262, 0.215, 0.29], cloth);
    add('Head', 'box', [0, 0.115, 0.13], [0.09, 0.05, 0.035], dark);           // counterweight pouch
  };
  const faceMask = (c = dark) => add('Head', 'arc', [0, -0.04, -0.012], [0.195, 0.085, 0.215], c, [0.1, 0, 0]);
  const thighPlates = () => {
    for (const side of ['Left', 'Right']) {
      const sx = side === 'Left' ? -1 : 1;
      add(`${side}UpLeg`, 'box', [sx * 0.012, -0.17, -0.085], [0.14, 0.2, 0.026], armour, [-0.06, 0, 0]);
      add(`${side}UpLeg`, 'box', [sx * 0.004, -0.255, -0.0], [0.17, 0.022, 0.19], strap);
    }
  };
  const groin = () => add('Hips', 'box', [0, -0.1, -0.13], [0.16, 0.14, 0.024], armour, [0.1, 0, 0]);
  const collar = () => add('Spine', 'box', [0, 0.17, -0.02], [0.3, 0.07, 0.26], armour);
  switch (kit) {
    case 'heavy':
      // Heavier protection than the base carrier: groin and thigh armour and
      // a wrap-around ballistic visor over a hard mask (plus charcoal tint, LMG).
      groin(); thighPlates();
      add('Head', 'arc', [0, 0.035, -0.008], [0.218, 0.075, 0.238], colors.visor, [-0.05, 0, 0]);
      faceMask(armour);
      break;
    case 'breacher':
      add('Head', 'arc', [0, -0.065, -0.014], [0.225, 0.055, 0.24], armour, [0.12, 0, 0]);  // mandible guard
      faceMask();
      groin(); thighPlates(); collar();
      add('Spine01', 'box', [0, -0.02, 0.16], [0.26, 0.24, 0.07], pack);               // breaching charge pack
      break;
    case 'leader':
      add('Spine', 'box', [0, -0.02, 0.18], [0.26, 0.3, 0.1], pack);                   // radio pack
      add('Spine', 'cyl', [0.09, 0.32, 0.2], [0.012, 0.5, 0.012], dark);              // whip antenna
      add('Head', 'box', [0.1, -0.005, 0], [0.04, 0.07, 0.08], dark);                  // comms headset
      add('Head', 'box', [-0.1, -0.005, 0], [0.04, 0.07, 0.08], dark);
      break;
    case 'marksman':
      helmetCover();
      add('Spine', 'box', [0, -0.04, 0.19], [0.28, 0.34, 0.13], pack);                 // field pack
      add('Spine', 'box', [0, 0.14, 0.22], [0.3, 0.07, 0.12], cloth);                  // rolled ghillie scarf
      break;
    case 'recon':
      helmetCover();
      add('Spine', 'box', [0, 0.0, 0.17], [0.2, 0.26, 0.06], pack);                    // hydration carrier
      break;
    case 'assault':
      faceMask();
      break;
    case 'medic':
      add('Spine', 'box', [0, -0.03, 0.18], [0.27, 0.32, 0.12], pack);                 // aid bag
      add('Spine', 'box', [0, 0.0, 0.243], [0.07, 0.07, 0.006], 0x5a2a28);             // subdued cross patch
      add('RightUpLeg', 'box', [0.1, -0.13, 0], [0.05, 0.15, 0.11], pack);             // IFAK drop pouch
      break;
    case 'ghost':
      helmetCover();
      faceMask();
      add('Head', 'arc', [0, 0.035, -0.006], [0.21, 0.045, 0.232], colors.visor);        // low-light goggles
      break;
    case 'tracker':
      helmetCover();
      add('Spine', 'box', [0, -0.02, 0.17], [0.24, 0.28, 0.08], pack);
      add('Spine', 'cyl', [-0.08, 0.27, 0.19], [0.01, 0.4, 0.01], dark);               // sensor whip
      break;
    default:
      break;
  }
  if (faceCover && !['heavy', 'breacher', 'assault', 'ghost'].includes(kit)) faceMask();
  return P;
}

function buildKit(kitKey, kit, colors, faceCover) {
  let cached = state.kitCache.get(kitKey);
  if (cached) return cached;
  const byBone = new Map();
  const m4 = new THREE.Matrix4(), boneInv = new THREE.Matrix4(), boneM = new THREE.Matrix4();
  const q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const col = new THREE.Color();
  for (const piece of kitPieces(kit, colors, faceCover)) {
    const bind = state.bindBoneWorld.get(piece.bone);
    if (!bind) continue;
    const geo = (piece.shape === 'cyl' ? _cylGeo : piece.shape === 'dome' ? _sphGeo : piece.shape === 'arc' ? _arcGeo : _boxGeo).clone();
    e.set(...(piece.rot || [0, 0, 0]));
    q.setFromEuler(e);
    p.set(bind.pos.x + piece.at[0], bind.pos.y + piece.at[1], bind.pos.z + piece.at[2]);
    sc.set(piece.size[0], piece.size[1], piece.size[2]);
    m4.compose(p, q, sc);
    boneM.compose(bind.pos, bind.quat, bind.scale);
    boneInv.copy(boneM).invert();
    geo.applyMatrix4(m4.premultiply(boneInv));
    col.setHex(piece.color);
    const n = geo.getAttribute('position').count;
    const colors3 = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { colors3[i * 3] = col.r; colors3[i * 3 + 1] = col.g; colors3[i * 3 + 2] = col.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(colors3, 3));
    geo.deleteAttribute('uv');
    const list = byBone.get(piece.bone) || [];
    list.push(geo);
    byBone.set(piece.bone, list);
  }
  cached = [];
  for (const [bone, geos] of byBone) {
    cached.push({ bone, geometry: mergeSimple(geos) });
    for (const g of geos) g.dispose();
  }
  state.kitCache.set(kitKey, cached);
  return cached;
}

function mergeSimple(geos) {
  let vCount = 0, iCount = 0;
  for (const g of geos) { vCount += g.getAttribute('position').count; iCount += g.index ? g.index.count : g.getAttribute('position').count; }
  const pos = new Float32Array(vCount * 3), nrm = new Float32Array(vCount * 3), colr = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of geos) {
    const gp = g.getAttribute('position'), gn = g.getAttribute('normal'), gc = g.getAttribute('color');
    pos.set(gp.array, vo * 3); nrm.set(gn.array, vo * 3); colr.set(gc.array, vo * 3);
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo; io += g.index.count; }
    else { for (let i = 0; i < gp.count; i++) idx[io + i] = i + vo; io += gp.count; }
    vo += gp.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(colr, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

// ---------------------------------------------------------------------------
// Scratch (allocation-free per frame)
// ---------------------------------------------------------------------------
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _t = new THREE.Vector3(), _dir = new THREE.Vector3(), _tgt = new THREE.Vector3(), _pole = new THREE.Vector3(), _e = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3(), _fwd = new THREE.Vector3();

function smooth01(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Rotate `bone` by `angle` about a WORLD axis, preserving its children's offsets. */
function rotateBoneWorld(bone, axisWorld, angle) {
  if (!angle) return;
  bone.parent.getWorldQuaternion(_q2);
  _q1.setFromAxisAngle(axisWorld, angle);
  // local' = inv(P) * R * P * local
  _q3.copy(_q2).invert().multiply(_q1).multiply(_q2);
  bone.quaternion.premultiply(_q3);
  // Only this bone; descendants refresh lazily via getWorld*() parent walks
  // and the renderer's single scene update (no per-layer subtree walks).
  bone.updateMatrix();
  bone.matrixWorld.multiplyMatrices(bone.parent.matrixWorld, bone.matrix);
}

/** Aim the world direction (child - bone) at `targetWorld`, minimal rotation. */
function aimBone(bone, childWorld, targetWorld) {
  bone.getWorldPosition(_v1);
  _v2.subVectors(childWorld, _v1);
  _v3.subVectors(targetWorld, _v1);
  const l2 = _v2.length(), l3 = _v3.length();
  if (l2 < 1e-5 || l3 < 1e-5) return;
  _v2.multiplyScalar(1 / l2); _v3.multiplyScalar(1 / l3);
  _q1.setFromUnitVectors(_v2, _v3);
  bone.parent.getWorldQuaternion(_q2);
  _q3.copy(_q2).invert().multiply(_q1).multiply(_q2);
  bone.quaternion.premultiply(_q3);
  // Only this bone; descendants refresh lazily via getWorld*() parent walks
  // and the renderer's single scene update (no per-layer subtree walks).
  bone.updateMatrix();
  bone.matrixWorld.multiplyMatrices(bone.parent.matrixWorld, bone.matrix);
}

class SoldierRig {
  constructor(model, opts) {
    this.model = model;
    this.weaponType = model.weaponType || 'rifle';
    this.handguard = HANDGUARD[this.weaponType] || 0.25;
    this.root = cloneSkinned(state.template);
    this.root.name = 'vs-skinned-soldier-instance';
    this.inner = this.root.children[0];
    this.mesh = null;
    this.root.traverse((o) => { if (o.isSkinnedMesh) this.mesh = o; });
    this.mesh.material = tintedMaterial(opts.tint);
    const B = (n) => this.root.getObjectByName(n);
    this.bones = {
      hips: B('Hips'), spine02: B('Spine02'), spine01: B('Spine01'), spine: B('Spine'), neck: B('neck'), head: B('Head'),
      armL: B('LeftArm'), foreL: B('LeftForeArm'), handL: B('LeftHand'),
      armR: B('RightArm'), foreR: B('RightForeArm'), handR: B('RightHand'),
    };
    // Counter the procedural root's Y-only height scale so the skin scales uniformly.
    const h = model.root.scale.y || 1;
    this.root.scale.set(h, 1, h);
    model.root.add(this.root);

    // Hide the procedural body; keep weapon, magazine, strobe and lights.
    this.hidden = [];
    const keep = new Set();
    if (model.rifle) model.rifle.traverse((o) => keep.add(o));
    if (model.strobe) keep.add(model.strobe);
    model.root.traverse((o) => {
      if (o.isMesh && !keep.has(o) && !this._isOwn(o)) { o.visible = false; this.hidden.push(o); }
    });

    // Class kit.
    this.kitMeshes = [];
    attachKit(this.root, opts.kit, opts.kitKey, opts.colors, opts.faceCover, this.kitMeshes);
    // Faction ID strobe rides on the chest of the skinned body.
    if (model.strobe) {
      this._strobeHome = model.strobe.parent;
      this.bones.spine.add(model.strobe);
      const bind = state.bindBoneWorld.get('Spine');
      const inv = 1 / bind.scale.x;
      // left-chest / shoulder strap, wrapper space offset converted to bone-local
      _v1.set(-0.13, 0.12, -0.15).applyQuaternion(_q1.copy(bind.quat).invert()).multiplyScalar(inv);
      model.strobe.position.copy(_v1);
      model.strobe.quaternion.copy(_q1);
      model.strobe.scale.multiplyScalar(inv);   // keep the box() size baked in scale
    }

    this.mixer = new THREE.AnimationMixer(this.inner);
    this.actions = {};
    for (const name of LOCO.concat(ONESHOT)) {
      const a = this.mixer.clipAction(state.clips[name]);
      a.enabled = true;
      a.setEffectiveWeight(0);
      a.play();
      this.actions[name] = a;
    }
    for (const name of LOCO) {
      if (name === 'idle' || name === 'crouch_idle') continue;
      this.actions[name].timeScale = 0;   // driven by gait phase
    }
    for (const name of ONESHOT) {
      const a = this.actions[name];
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.stop();
    }
    this.actions.idle.time = Math.random() * state.clips.idle.duration;
    this.actions.crouch_idle.time = Math.random() * state.clips.crouch_idle.duration;
    this.phase = Math.random();
    this.speed = 0;
    this.moveYaw = 0;       // smoothed hip yaw (relative to facing)
    this.backward = 0;      // 0..1 backward blend
    this._back = false;     // hysteretic backward-gait state
    this.lastTime = NaN;
    this.lastSerial = undefined;
    this.hit = null; this.hitT = 0;
    this.dead = false; this.deathT = 0; this.frozen = false;
    this.lodAcc = 0;
    this.weights = { idle: 1, walk: 0, jog: 0, sprint: 0, crouch_idle: 0, crouch_walk: 0 };
  }

  _isOwn(o) {
    let p = o;
    while (p) { if (p === this.root) return true; p = p.parent; }
    return false;
  }

  /**
   * @param {number} dt
   * @param {object} s  { time, vx, vz, crouch, aiming, reloading, fireKick, flinch, surrendered, alive, camDist }
   */
  update(_dtIgnored, s) {
    // Own clock: the AI calls _animate both per frame and on staggered AI
    // ticks (with an accumulated dt); game time makes repeated calls in one
    // frame a no-op and keeps clip playback at real speed.
    if (Number.isFinite(this.lastTime) && s.time < this.lastTime - 1e-4) this.lastTime = s.time - 1 / 60; // clock reset: resync
    const dt = Number.isFinite(this.lastTime) ? Math.min(0.25, Math.max(0, s.time - this.lastTime)) : 1 / 60;
    if (Number.isFinite(this.lastTime) && dt <= 0) return;
    this.lastTime = s.time;
    if (this.frozen) return;
    if (!s.alive && !this.dead) this._startDeath();
    if (this.dead) { this._updateDeath(dt); return; }

    // --- locomotion state from the commanded ground velocity (read only) ---
    const m = this.model;
    const vx = s.vx, vz = s.vz;
    const rawSpeed = Math.min(10, Math.hypot(vx, vz));
    if (rawSpeed < 0.08) {
      this.speed *= Math.exp(-14 * dt);
      if (this.speed < 0.01) this.speed = 0;
    } else {
      this.speed += (rawSpeed - this.speed) * (1 - Math.exp(-12 * dt));
    }
    const v = this.speed;

    // Movement direction relative to facing (-Z forward). yaw of root:
    const facing = m.root.rotation.y;
    let rel = 0;
    if (rawSpeed > 0.2 && s.aiming) {
      // world move angle in the same convention as root.rotation.y (forward = -Z)
      const moveAng = Math.atan2(-vx, -vz);
      rel = moveAng - facing;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      // Controlled, subtle pelvic rotation while strafing (max ~14 deg), no violent flips
      const hip = Math.max(-0.25, Math.min(0.25, rel));
      this.moveYaw += (hip - this.moveYaw) * (1 - Math.exp(-8 * dt));
    } else {
      this.moveYaw *= Math.exp(-12 * dt);
      if (Math.abs(this.moveYaw) < 0.005) this.moveYaw = 0;
    }

    // --- weights ---
    const c = Math.min(1, Math.max(0, s.crouch));
    const moving = smooth01(0.08, 0.45, v);
    const jogT = smooth01(2.0, 2.9, v);
    const sprintT = smooth01(5.0, 6.5, v);
    const W = this.weights;
    W.idle = (1 - moving) * (1 - c);
    W.walk = moving * (1 - jogT) * (1 - c);
    W.jog = moving * jogT * (1 - sprintT) * (1 - c);
    W.sprint = moving * jogT * sprintT * (1 - c);
    W.crouch_idle = (1 - moving) * c;
    W.crouch_walk = moving * c;

    // Shared gait phase (keeps blended clips' footfalls in sync). Each clip's
    // cadence follows ground speed (no-slide), clamped to TS_RANGE.
    const wsum = W.walk + W.jog + W.sprint + W.crouch_walk;
    if (wsum > 1e-3) {
      const vv = Math.max(v, 0.35);
      let cps = 0;
      for (let i = 0; i < GAITS.length; i++) {
        const k = GAITS[i], w = W[k];
        if (w <= 0) continue;
        const r = TS_RANGE[k];
        cps += w * Math.min(r[1], Math.max(r[0], vv / STRIDE_SPEED[k])) / state.clips[k].duration;
      }
      cps /= wsum;
      // Believable forward locomotion with stride cadence (no reversed gait)
      this.phase = (this.phase + cps * dt) % 1;
      if (this.phase < 0) this.phase += 1;
    }

    // --- hit reaction: one shot per real damage event (enemy hitSerial) ---
    const serial = s.hitSerial || 0;
    if (serial !== this.lastSerial) {
      if (this.lastSerial !== undefined) {
        this.hit = s.hitZone === 'head' ? this.actions.hit_head : this.actions.hit_chest;
        const other = this.hit === this.actions.hit_head ? this.actions.hit_chest : this.actions.hit_head;
        other.stop();
        this.hit.reset().play();
        this.hitT = 0;
      }
      this.lastSerial = serial;
    }
    let hitW = 0;
    if (this.hit) {
      this.hitT += dt;
      const dur = this.hit.getClip().duration;
      const k = this.hitT / dur;
      if (k >= 1) { this.hit.stop(); this.hit.setEffectiveWeight(0); this.hit = null; }
      else hitW = Math.sin(Math.PI * k) * 0.55;
    }

    // --- distance LOD: far actors update the mixer at a reduced rate ---
    const far = s.camDist > 45;
    this.lodAcc += dt;
    if (far && this.lodAcc < 0.1) return;
    const step = this.lodAcc;
    this.lodAcc = 0;

    for (const name of LOCO) {
      const a = this.actions[name];
      const w = W[name] * (1 - hitW);
      a.setEffectiveWeight(w);
      if (a.timeScale === 0) a.time = this.phase * a.getClip().duration;
    }
    if (this.hit) this.hit.setEffectiveWeight(hitW);
    this.mixer.update(step);

    // --- procedural layers on top of the clip pose ---
    // (bone world matrices are refreshed lazily along each parent chain)
    const bn = this.bones;
    m.root.getWorldQuaternion(_q1);
    _right.set(1, 0, 0).applyQuaternion(_q1);
    // Hips yaw toward the travel direction; upper body counter-rotates to keep aim.
    // The counter-twist is spread over three spine joints (max ~19 deg each)
    // instead of a single up-to-74 deg wrench at Spine02; chest/aim yaw is
    // unchanged (net upper-body rotation is still exactly -moveYaw).
    if (Math.abs(this.moveYaw) > 0.01) {
      const t = -this.moveYaw / 3;
      // Chain: Hips > Spine02 > Spine01 > Spine (shoulders hang off Spine).
      rotateBoneWorld(bn.hips, _up, this.moveYaw);
      rotateBoneWorld(bn.spine02, _up, t);
      rotateBoneWorld(bn.spine01 || bn.spine02, _up, t);
      rotateBoneWorld(bn.spine || bn.spine02, _up, t);
    }
    // Aim pitch (from the logic rig torso) split over two spine joints.
    const pitch = m.torso.rotation.x;
    const roll = m.torso.rotation.z;
    m.root.getWorldQuaternion(_q1);
    _fwd.set(0, 0, -1).applyQuaternion(_q1);
    const lean = s.aiming ? TUNE.lean : TUNE.lean * 0.5;
    rotateBoneWorld(bn.spine01, _right, pitch * 0.5 - lean);
    rotateBoneWorld(bn.spine, _right, pitch * 0.5);
    if (roll) rotateBoneWorld(bn.spine, _fwd, -roll);
    // Head look (idle scanning) from the logic rig head pivot.
    if (m.headGrp) rotateBoneWorld(bn.head, _up, m.headGrp.rotation.y);

    // Arm IK to the ACTUAL weapon: right wrist to the pistol grip, left wrist
    // under the handguard (or to the magazine while reloading). The gun and
    // muzzle themselves stay exactly where the logic rig puts them.
    if (!far || s.camDist < 60) {
      const gun = m.rifle;
      const armed = gun && gun.visible && !s.surrendered && this.weaponType !== 'none';
      if (armed) {
        gun.updateWorldMatrix(true, false);
        _t.copy(GRIP_R);
        gun.localToWorld(_t);
        this._solveArm(bn.armR, bn.foreR, bn.handR, _t, 1);
        if (s.reloading && m.mag) {
          m.mag.updateWorldMatrix(true, false);
          m.mag.getWorldPosition(_t);
          _t.y -= 0.05;
        } else {
          _t.set(GRIP_L.x, GRIP_L.y, -(0.2 + this.handguard * 0.5) + GRIP_L.z);
          gun.localToWorld(_t);
        }
        this._solveArm(bn.armL, bn.foreL, bn.handL, _t, -1);
        this._rollHand(bn.foreR, bn.handR, TUNE.rollR);
        this._rollHand(bn.foreL, bn.handL, TUNE.rollL);
      } else if (s.surrendered) {
        m.root.getWorldQuaternion(_q1);
        bn.armR.getWorldPosition(_t); _t.add(_v1.set(0.12, 0.42, -0.08).applyQuaternion(_q1));
        this._solveArm(bn.armR, bn.foreR, bn.handR, _t, 1);
        bn.armL.getWorldPosition(_t); _t.add(_v1.set(-0.12, 0.42, -0.08).applyQuaternion(_q1));
        this._solveArm(bn.armL, bn.foreL, bn.handL, _t, -1);
      }
    }
  }

  _solveArm(upper, fore, hand, target, side) {
    upper.getWorldPosition(_a);
    fore.getWorldPosition(_b);
    hand.getWorldPosition(_c);
    const l1 = _a.distanceTo(_b), l2 = _b.distanceTo(_c);
    _dir.subVectors(target, _a);
    let d = _dir.length();
    if (d < 1e-4) return;
    _dir.multiplyScalar(1 / d);
    d = Math.min(l1 + l2 - 0.005, Math.max(Math.abs(l1 - l2) + 0.01, d));
    _tgt.copy(_a).addScaledVector(_dir, d);
    // Pole: elbows out, down and slightly back from the shoulder.
    this.model.root.getWorldQuaternion(_q1);
    _pole.set(side * 0.55, -1.0, 0.25).applyQuaternion(_q1);
    _pole.addScaledVector(_dir, -_pole.dot(_dir));
    if (_pole.lengthSq() < 1e-6) return;
    _pole.normalize();
    const axial = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const hgt = Math.sqrt(Math.max(0, l1 * l1 - axial * axial));
    _e.copy(_a).addScaledVector(_dir, axial).addScaledVector(_pole, hgt);
    aimBone(upper, _b, _e);
    hand.getWorldPosition(_c);
    aimBone(fore, _c, _tgt);
  }

  /** Twist the hand about the forearm axis so the palm wraps the grip. */
  _rollHand(fore, hand, angle) {
    if (!angle) return;
    fore.getWorldPosition(_a);
    hand.getWorldPosition(_b);
    _v1.subVectors(_b, _a).normalize();
    rotateBoneWorld(hand, _v1, angle);
  }

  _startDeath() {
    this.dead = true;
    this.deathT = 0;
    this.speed = 0;
    this.moveYaw = 0;
    const d = this.actions.death;
    d.reset();
    d.setLoop(THREE.LoopOnce, 1);
    d.clampWhenFinished = true;
    d.play();
    if (this.hit) { this.hit.stop(); this.hit = null; }
    // Weapon follows the right hand to the ground (no longer gameplay-relevant).
    const gun = this.model.rifle;
    if (gun && gun.parent) this.bones.handR.attach(gun);
    this._fromW = {};
    for (const name of LOCO) {
      this._fromW[name] = this.actions[name].getEffectiveWeight();
      this.actions[name].setEffectiveWeight(0);
    }
  }

  _updateDeath(dt) {
    this.deathT += dt;
    this.actions.death.setEffectiveWeight(1);
    this.mixer.update(dt);
    if (this.deathT > state.clips.death.duration + 0.1) {
      // Pose held; the corpse no longer costs mixer or skinning-matrix work.
      for (const name of LOCO) this.actions[name].stop();
      this.frozen = true;
    }
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.inner);
    if (this.mesh && this.mesh.skeleton) this.mesh.skeleton.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
    // Geometry, materials and kit geometry are shared and cached: not disposed.
  }
}

function attachKit(root, kit, kitKey, colors, faceCover, list) {
  for (const m of list) { if (m.parent) m.parent.remove(m); }
  list.length = 0;
  for (const part of buildKit(kitKey, kit, colors, faceCover)) {
    const bone = root.getObjectByName(part.bone);
    if (!bone) continue;
    const mesh = new THREE.Mesh(part.geometry, kitMaterial());
    mesh.name = `kit-${kit}-${part.bone}`;
    mesh.castShadow = true;
    mesh.frustumCulled = true;
    bone.add(mesh);
    list.push(mesh);
  }
}

/** Operator uniform colour -> gentle multiply tint over the camo texture. */
export function operatorTint(hex) {
  if (typeof hex !== 'number') return 0xffffff;
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const mx = Math.max(r, g, b, 1);
  const ch = (c) => Math.round(255 * (0.55 + 0.45 * (c / mx)) * 0.97);
  return (ch(r) << 16) | (ch(g) << 8) | ch(b);
}

export const OPERATOR_KITS = Object.freeze({
  vanguard: 'rifleman', scout: 'recon', bulwark: 'heavy', marksman: 'marksman', medic: 'medic',
  engineer: 'breacher', ghost: 'ghost', tracker: 'tracker', disruptor: 'leader', specialist: 'assault',
});

/**
 * Player operator skin: same asset/clips, driven by PlayerBody state.
 * First person collapses the head bone (camera lives there) and sets the
 * body slightly back so the camera never clips the plate carrier.
 */
class PlayerSkin {
  constructor(body, opts) {
    this.body = body;
    this.root = cloneSkinned(state.template);
    this.root.name = 'vs-player-skin';
    this.inner = this.root.children[0];
    this.root.traverse((o) => { if (o.isSkinnedMesh) this.mesh = o; });
    const B = (n) => this.root.getObjectByName(n);
    this.bones = { hips: B('Hips'), spine02: B('Spine02'), spine01: B('Spine01'), spine: B('Spine'), head: B('Head') };
    body.root.add(this.root);
    this.hidden = [];
    const keep = new Set();
    if (body.weaponRoot) body.weaponRoot.traverse((o) => keep.add(o));
    body.root.traverse((o) => {
      if (!o.isMesh || keep.has(o)) return;
      let p = o; while (p && p !== this.root) p = p.parent;
      if (p === this.root) return;
      o.visible = false; this.hidden.push(o);
    });
    this.kitMeshes = [];
    this.setOperator(opts);
    this.mixer = new THREE.AnimationMixer(this.inner);
    this.actions = {};
    for (const name of LOCO.concat(['jump_loop', 'drive'])) {
      const a = this.mixer.clipAction(state.clips[name]);
      a.setEffectiveWeight(0); a.play();
      this.actions[name] = a;
      if (GAITS.includes(name)) a.timeScale = 0;
    }
    this.W = { idle: 1, walk: 0, jog: 0, sprint: 0, crouch_idle: 0, crouch_walk: 0, jump_loop: 0, drive: 0 };
    this.phase = 0; this.moveYaw = 0; this.backward = 0; this.speed = 0;
    this.fp = null;
  }

  setOperator(opts) {
    this.mesh.material = tintedMaterial(opts.tint || 0xffffff);
    const kit = opts.kit || 'rifleman';
    const colors = Object.assign({ armor: 0x30352d, webbing: 0x22261f, cloth: 0x454b3d, dark: 0x1c1f1e, pack: 0x323829, visor: 0x14191b }, opts.colors || {});
    attachKit(this.root, kit, `op|${kit}|${opts.tint || 0}`, colors, !!opts.faceCover, this.kitMeshes);
    this.kit = kit;
  }

  /** s: { dt, vx, vz, yaw, crouch, air, sprint, firstPerson, vehicle, pitch } */
  update(dt, s) {
    if (dt <= 0) return;
    const fp = !!s.firstPerson && !s.vehicle;
    if (fp !== this.fp) {
      this.fp = fp;
      this.bones.head.scale.setScalar(fp ? 0.001 : 1);
      this.root.position.set(0, 0, fp ? 0.13 : 0);
    }
    const W = this.W;
    if (s.vehicle) {
      for (const k in W) W[k] = 0;
      W.drive = 1;
      this.root.position.y = VEHICLE_SEAT_DROP;
    } else {
      this.root.position.y = 0;
      const raw = Math.min(10, Math.hypot(s.vx, s.vz));
      this.speed += (raw - this.speed) * (1 - Math.exp(-12 * dt));
      const v = this.speed;
      if (raw > 0.2) {
        let rel = Math.atan2(-s.vx, -s.vz) - s.yaw;
        while (rel > Math.PI) rel -= Math.PI * 2;
        while (rel < -Math.PI) rel += Math.PI * 2;
        const back = Math.abs(rel) > 1.95 ? 1 : 0;
        this.backward += (back - this.backward) * (1 - Math.exp(-8 * dt));
        let hip = back ? rel - Math.sign(rel) * Math.PI : rel;
        hip = Math.max(-1.2, Math.min(1.2, hip));
        this.moveYaw += (hip - this.moveYaw) * (1 - Math.exp(-8 * dt));
      } else this.moveYaw *= Math.exp(-6 * dt);
      const c = Math.min(1, Math.max(0, s.crouch));
      const air = Math.min(1, Math.max(0, s.air));
      const moving = smooth01(0.1, 0.5, v);
      const jogT = Math.max(smooth01(3.2, 4.4, v), s.sprint > 0.5 ? 1 : 0);
      const sprintT = s.sprint;
      const g = (1 - air);
      W.idle = (1 - moving) * (1 - c) * g;
      W.walk = moving * (1 - jogT) * (1 - c) * g;
      W.jog = moving * jogT * (1 - sprintT) * (1 - c) * g;
      W.sprint = moving * jogT * sprintT * (1 - c) * g;
      W.crouch_idle = (1 - moving) * c * g;
      W.crouch_walk = moving * c * g;
      W.jump_loop = air;
      W.drive = 0;
      const wsum = W.walk + W.jog + W.sprint + W.crouch_walk;
      if (wsum > 1e-3) {
        const vv = Math.max(v, 0.35);
        let cps = 0;
        for (let i = 0; i < GAITS.length; i++) {
          const k = GAITS[i], w = W[k];
          if (w <= 0) continue;
          const r = TS_RANGE[k];
          cps += w * Math.min(r[1], Math.max(r[0], vv / STRIDE_SPEED[k])) / state.clips[k].duration;
        }
        cps /= wsum;
        this.phase = (this.phase + (this.backward > 0.5 ? -1 : 1) * cps * dt) % 1;
        if (this.phase < 0) this.phase += 1;
      }
    }
    for (const name in this.actions) {
      const a = this.actions[name];
      a.setEffectiveWeight(W[name]);
      if (a.timeScale === 0) a.time = this.phase * a.getClip().duration;
    }
    this.mixer.update(dt);
    if (!s.vehicle && Math.abs(this.moveYaw) > 0.01) {
      rotateBoneWorld(this.bones.hips, _up, this.moveYaw);
      rotateBoneWorld(this.bones.spine02, _up, -this.moveYaw);
    }
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.inner);
    if (this.mesh && this.mesh.skeleton) this.mesh.skeleton.dispose();
    for (const m of this.kitMeshes) if (m.parent) m.parent.remove(m);
    if (this.root.parent) this.root.parent.remove(this.root);
    for (const o of this.hidden) o.visible = true;
  }
}

/** Attach the operator skin to a PlayerBody; null => procedural body stays. */
export function attachPlayerSkin(body, opts = {}) {
  if (state.status !== 'ready' || !body || !body.root) return null;
  try { return new PlayerSkin(body, opts); }
  catch (err) { console.warn('[soldier-rig] player skin failed, procedural body kept:', err); return null; }
}

/**
 * Attach a skinned soldier to a procedural logic-rig model.
 * Returns null (procedural fallback) if the asset is not ready.
 */
export function attachSoldierRig(model, opts = {}) {
  if (state.status !== 'ready' || !model || !model.root) return null;
  try {
    return new SoldierRig(model, {
      tint: opts.tint || 0xffffff,
      kit: opts.kit || 'rifleman',
      faceCover: !!opts.faceCover,
      kitKey: `${opts.kit || 'rifleman'}|${opts.paletteKey || 0}|${opts.faceCover ? 1 : 0}`,
      colors: Object.assign({
        armor: 0x3a3d33, webbing: 0x25281f, cloth: 0x4b5040, dark: 0x1c1e1f, pack: 0x353a2e, visor: 0x14181a,
      }, opts.colors || {}),
    });
  } catch (err) {
    console.warn('[soldier-rig] attach failed, procedural fallback:', err);
    return null;
  }
}

export const SOLDIER_RIG_INFO = Object.freeze({ url: ASSET_URL, loco: LOCO, oneShot: ONESHOT, strideSpeed: STRIDE_SPEED, cadenceRange: TS_RANGE });
