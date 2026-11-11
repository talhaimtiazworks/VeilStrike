/**
 * enemy-soldier.js
 * Original, procedural soldier visual system.  All geometry is generated from
 * local Three.js primitives or short tapered prism meshes; no downloaded
 * characters, textures, fonts, or runtime services are required.
 *
 * The rig uses a stable feet-at-origin hierarchy with separate pelvis, torso,
 * head, upper/lower arms, wrists/hands, thighs, knees, calves, ankles and boots.
 * Weapons are parented to the dominant wrist/grip and therefore share the
 * soldier's aim, recoil, locomotion, cover and reload transforms.
 */
import * as THREE from 'three';
import { roundedBoxGeometry } from './geometry.js';

const SHARED = {
  bevel: roundedBoxGeometry(3, 0.075),
  trim: roundedBoxGeometry(2, 0.018),
  head: new THREE.IcosahedronGeometry(1, 1),
  joint: new THREE.IcosahedronGeometry(1, 0),
  barrel: new THREE.CylinderGeometry(0.5, 0.54, 1, 8, 1, false),
  narrowBarrel: new THREE.CylinderGeometry(0.42, 0.5, 1, 7, 1, false),
  // Low-cost (24-vertex) plate used for armour panels, rails and straps.
  plate: roundedBoxGeometry(1, 0.05),
};

/** Collision-resolved procedural fallback gait. Stationary actors keep their
 * leg pose fixed; the prior unconditional phase update left a 0.10-rad idle
 * swing running forever and read as dancing. */
export function stepFallbackGait(phase, dt, groundSpeed) {
  const speed = Number.isFinite(groundSpeed) ? Math.max(0, groundSpeed) : 0;
  if (speed <= 0.12 || !Number.isFinite(dt) || dt <= 0) {
    return { phase, swing: 0, bob: 0 };
  }
  const nextPhase = phase + dt * (2.3 + speed * 2.2);
  const gait = Math.sin(nextPhase * 2);
  return {
    phase: nextPhase,
    swing: gait * Math.min(0.56, speed * 0.16),
    bob: Math.abs(Math.cos(nextPhase * 2)) * Math.min(0.038, speed * 0.008),
  };
}

/**
 * Visible armour tier follows the archetype's real armour stat (enemies.js
 * ARCHETYPES.armor), so heavier-looking soldiers really are tougher:
 * heavy 42 > armored/breacher 20 > standard 10-18 > light 2-8.
 */
function armourTier(visual) {
  if (visual.civilian || visual.gear === false) return 'none';
  const kit = visual.kit || '';
  const cls = visual.classId || '';
  if (kit === 'heavy' || cls === 'heavy') return 'heavy';
  if (kit === 'armored' || cls === 'breacher') return 'armored';
  if (kit === 'light' || kit === 'recon' || cls === 'recon' || cls === 'assault') return 'light';
  return 'standard';
}
const taperCache = new Map();
const JOINT_BATCH_MATERIALS = Object.freeze({
  matte: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, metalness: 0.08, vertexColors: true }),
  metal: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.48, metalness: 0.48, vertexColors: true }),
});

function taperGeometry(length, topWidth, topDepth, bottomWidth, bottomDepth) {
  const key = [length, topWidth, topDepth, bottomWidth, bottomDepth].map(v => v.toFixed(3)).join(':');
  if (taperCache.has(key)) return taperCache.get(key);
  const p = [];
  const uv = [];
  const index = [];
  const rings = [
    [-length * 0.04, topWidth * 0.5, topDepth * 0.5],
    [-length, bottomWidth * 0.5, bottomDepth * 0.5],
  ];
  for (const [y, hx, hz] of rings) {
    p.push(-hx, y, -hz, hx, y, -hz, hx, y, hz, -hx, y, hz);
    uv.push(0, 1, 1, 1, 1, 0, 0, 0);
  }
  // Faces: top, bottom, then four tapered sides.
  index.push(0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7);
  for (let i = 0; i < 4; i++) {
    const a = i, b = (i + 1) % 4, c = b + 4, d = a + 4;
    index.push(a, b, d, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  taperCache.set(key, geo);
  return geo;
}

function piece(parent, geometry, material, position, scale, name) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  if (scale) mesh.scale.set(scale[0], scale[1], scale[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  if (name) mesh.name = name;
  parent.add(mesh);
  return mesh;
}

function box(parent, material, p, s, name, r = null) {
  const mesh = piece(parent, SHARED.bevel, material, p, s, name);
  if (r) mesh.rotation.set(r[0], r[1], r[2]);
  return mesh;
}

function plate(parent, material, p, s, name, r = null) {
  const mesh = piece(parent, SHARED.plate, material, p, s, name);
  if (r) mesh.rotation.set(r[0], r[1], r[2]);
  return mesh;
}

/** Merge static meshes attached to one articulated joint into material batches. */
function mergeJointMeshes(parent, preserve = () => false) {
  const batches = new Map();
  const mergedGeometries = [];
  const sourceMeshes = parent.children.filter(child => child.isMesh && !preserve(child));
  if (sourceMeshes.length < 2) return mergedGeometries;
  for (const mesh of sourceMeshes) {
    if (Array.isArray(mesh.material)) continue;
    mesh.updateMatrix();
    const source = mesh.geometry.clone();
    source.applyMatrix4(mesh.matrix);
    const originalMaterial = mesh.material;
    const batchMaterial = (originalMaterial.metalness || 0) >= 0.34
      ? JOINT_BATCH_MATERIALS.metal : JOINT_BATCH_MATERIALS.matte;
    let batch = batches.get(batchMaterial);
    if (!batch) {
      batch = { positions: [], normals: [], uvs: [], colors: [], indices: [], vertexCount: 0 };
      batches.set(batchMaterial, batch);
    }
    const position = source.getAttribute('position');
    const normal = source.getAttribute('normal');
    const uv = source.getAttribute('uv');
    const color = originalMaterial.color;
    for (let i = 0; i < position.count; i++) {
      batch.positions.push(position.getX(i), position.getY(i), position.getZ(i));
      batch.colors.push(color ? color.r : 1, color ? color.g : 1, color ? color.b : 1);
      if (normal) batch.normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
      if (uv) batch.uvs.push(uv.getX(i), uv.getY(i));
    }
    if (source.index) {
      for (let i = 0; i < source.index.count; i++) batch.indices.push(source.index.getX(i) + batch.vertexCount);
    } else {
      for (let i = 0; i < position.count; i++) batch.indices.push(i + batch.vertexCount);
    }
    batch.vertexCount += position.count;
    source.dispose();
  }
  for (const mesh of sourceMeshes) {
    if (!Array.isArray(mesh.material)) parent.remove(mesh);
  }
  let mergedIndex = 0;
  for (const [material, batch] of batches) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(batch.colors, 3));
    if (batch.normals.length) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(batch.normals, 3));
    if (batch.uvs.length) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uvs, 2));
    geometry.setIndex(batch.indices);
    if (!batch.normals.length) geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    mergedGeometries.push(geometry);
    const merged = new THREE.Mesh(geometry, material);
    merged.name = `${parent.name || 'joint'}-merged-${mergedIndex++}`;
    merged.castShadow = true;
    merged.receiveShadow = false;
    parent.add(merged);
  }
  return mergedGeometries;
}

const WEAPON_SHAPES = Object.freeze({
  rifle:     { receiver: 0.30, stock: 0.25, handguard: 0.25, barrel: 0.33, magazine: 0.18, muzzle: 0.79, optic: 'dot', magShape: 'curved' },
  smg:       { receiver: 0.24, stock: 0.17, handguard: 0.13, barrel: 0.20, magazine: 0.15, muzzle: 0.54, optic: 'rail', magShape: 'compact' },
  lmg:       { receiver: 0.38, stock: 0.27, handguard: 0.31, barrel: 0.43, magazine: 0.20, muzzle: 0.95, optic: 'rail', magShape: 'box' },
  marksman:  { receiver: 0.31, stock: 0.29, handguard: 0.38, barrel: 0.49, magazine: 0.16, muzzle: 1.08, optic: 'scope', magShape: 'straight' },
  shotgun:   { receiver: 0.26, stock: 0.23, handguard: 0.16, barrel: 0.38, magazine: 0.10, muzzle: 0.75, optic: 'bead', magShape: 'tube' },
});

function addBarrel(parent, material, centerZ, length, radius = 0.016, name = 'weapon-barrel') {
  const m = piece(parent, SHARED.barrel, material, [0, 0.045, centerZ], [radius * 2, length, radius * 2], name);
  m.rotation.x = Math.PI / 2;
  return m;
}

/** Detailed low-poly fictional weapon, origin at the dominant hand's trigger grip. */
function buildWeapon(hand, mats, type) {
  const profile = WEAPON_SHAPES[type] || WEAPON_SHAPES.rifle;
  const gun = new THREE.Group();
  gun.name = `${type}-held-weapon`;
  hand.add(gun);
  const metal = mats.gun || mats.dark;
  const dark = mats.dark || metal;
  const accent = mats.weaponAccent || mats.vest || metal;
  const compact = type === 'smg';
  const lmg = type === 'lmg';
  const marksman = type === 'marksman';
  const shotgun = type === 'shotgun';

  // Receiver / upper, separate dust cover and a beveled handguard.
  box(gun, metal, [0, 0.04, -0.055], [lmg ? 0.125 : 0.092, lmg ? 0.13 : 0.105, profile.receiver], 'weapon-receiver');
  box(gun, accent, [0, 0.099, -0.075], [0.076, 0.018, profile.receiver * 0.66], 'receiver-cover');
  box(gun, metal, [0, 0.038, -0.20 - profile.handguard * 0.5], [lmg ? 0.092 : 0.074, 0.084, profile.handguard], 'handguard');
  // Rear assembly and recoil pad.
  box(gun, metal, [0, 0.032, profile.stock * 0.34], [0.072, 0.078, profile.stock * 0.76], 'stock');
  box(gun, dark, [0, 0.032, profile.stock * 0.73], [0.081, 0.095, 0.035], 'buttpad');
  if (compact) {
    box(gun, metal, [0, 0.035, profile.stock * 0.08], [0.025, 0.022, profile.stock * 0.62], 'folding-stock-strut');
  }

  // Barrel, gas block, front sight and distinctive muzzle.
  const barrelStart = -0.21 - profile.handguard;
  addBarrel(gun, metal, barrelStart - profile.barrel * 0.5, profile.barrel, marksman ? 0.014 : shotgun ? 0.019 : 0.016);
  box(gun, dark, [0, 0.05, barrelStart - 0.015], [0.09, 0.11, 0.055], 'front-sight-block');
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle-origin';
  muzzle.position.set(0, 0.045, -profile.muzzle);
  muzzle.rotation.y = Math.PI; // Object3D's forward direction is local +Z; the fictional barrel points local -Z.
  gun.add(muzzle);
  const brake = piece(gun, SHARED.barrel, dark, [0, 0.045, -profile.muzzle + 0.018], [0.031, 0.065, 0.031], 'muzzle-brake');
  brake.rotation.x = Math.PI / 2;

  // Trigger housing, pistol grip, controls and a weapon-specific magazine.
  box(gun, dark, [0, -0.035, 0.045], [0.066, 0.058, 0.09], 'trigger-guard');
  box(gun, metal, [0, -0.098, 0.045], [0.052, 0.13, 0.068], 'pistol-grip', [0.18, 0, 0]);
  const magDepth = shotgun ? 0.058 : lmg ? 0.12 : 0.075;
  const magHeight = shotgun ? 0.13 : lmg ? 0.18 : profile.magazine;
  const mag = box(gun, dark, [0, -0.108, -0.07], [lmg ? 0.095 : 0.068, magHeight, magDepth], 'removable-magazine', [shotgun ? 0 : 0.11, 0, 0]);
  if (lmg) {
    box(gun, accent, [0, -0.15, -0.045], [0.105, 0.08, 0.12], 'ammunition-box');
    box(gun, dark, [0, -0.10, -0.05], [0.1, 0.018, 0.08], 'feed-cover');
  }
  if (shotgun) {
    // Under-barrel tube and pump action distinguish the close-range loadout.
    addBarrel(gun, dark, barrelStart - profile.barrel * 0.48, profile.barrel * 0.9, 0.012, 'shotgun-magazine-tube');
    box(gun, accent, [0, -0.035, -0.265], [0.078, 0.06, 0.12], 'pump-fore-end');
    box(gun, dark, [0, -0.14, -0.07], [0.045, 0.06, 0.055], 'shell-carrier');
  }

  // Sights / optics, top rail and a small rear charging handle.
  box(gun, dark, [0, 0.106, -0.035], [0.12, 0.018, profile.receiver + 0.06], 'top-rail');
  if (profile.optic === 'scope') {
    const scope = piece(gun, SHARED.narrowBarrel, dark, [0, 0.172, -0.075], [0.045, 0.27, 0.045], 'telescopic-optic');
    scope.rotation.x = Math.PI / 2;
    box(gun, accent, [0, 0.172, -0.075], [0.052, 0.05, 0.22], 'optic-mount');
    for (const z of [-0.20, 0.05]) {
      const lens = piece(gun, SHARED.barrel, mats.optic || dark, [0, 0.172, z], [0.052, 0.02, 0.052], 'scope-ring');
      lens.rotation.x = Math.PI / 2;
    }
  } else if (profile.optic === 'dot') {
    box(gun, dark, [0, 0.15, -0.055], [0.075, 0.085, 0.09], 'reflex-sight');
    box(gun, mats.optic || accent, [0, 0.155, -0.055], [0.052, 0.035, 0.018], 'sight-lens');
  } else if (profile.optic === 'rail') {
    box(gun, dark, [0, 0.145, -0.06], [0.04, 0.075, 0.045], 'rear-sight');
  } else if (profile.optic === 'bead') {
    piece(gun, SHARED.joint, mats.optic || metal, [0, 0.116, -0.48], [0.016, 0.016, 0.016], 'front-bead');
  }
  box(gun, dark, [0.066, 0.055, -0.02], [0.027, 0.042, 0.07], 'charging-handle');
  box(gun, accent, [0.063, 0.015, -0.02], [0.018, 0.02, 0.035], 'selector');

  // Role attachments: LMG bipod, marksman bipod, assault light/laser, sling.
  if (lmg || marksman) {
    const z = barrelStart - profile.handguard * 0.66;
    for (const side of [-1, 1]) {
      const leg = box(gun, dark, [side * 0.042, -0.10, z], [0.018, 0.20, 0.022], 'folding-bipod-leg', [side * 0.28, 0, 0]);
      leg.rotation.z = side * 0.24;
    }
  }
  if (compact) box(gun, dark, [0.055, 0.035, -0.26], [0.04, 0.045, 0.10], 'weapon-light');
  box(gun, mats.webbing || accent, [-0.085, -0.025, 0.13], [0.018, 0.018, profile.stock + profile.receiver], 'sling');
  gun.userData.weaponType = type;
  gun.userData.profile = profile;
  return { gun, muzzle, magazine: mag, type };
}

function makeArm(torso, side, mats, tier = 'none') {
  const sign = side === 'R' ? 1 : -1;
  const shoulder = new THREE.Group();
  shoulder.name = `shoulder-${side}`;
  shoulder.position.set(sign * 0.235, 0.43, -0.005);
  torso.add(shoulder);
  const upperRig = new THREE.Group(); upperRig.name = `upper-arm-rig-${side}`; shoulder.add(upperRig);
  const upperGeo = taperGeometry(0.30, 0.145, 0.155, 0.115, 0.12);
  piece(upperRig, upperGeo, mats.cloth, [0, 0, 0], [1, 1, 1], `upper-arm-${side}`);
  piece(upperRig, SHARED.joint, mats.cloth, [0, -0.015, 0], [0.075, 0.074, 0.074], `shoulder-joint-${side}`);
  box(upperRig, mats.armor || mats.vest, [0, -0.055, -0.005], [0.17, 0.12, 0.18], `shoulder-guard-${side}`);
  if (tier === 'standard' || tier === 'armored' || tier === 'heavy') {
    // Soft deltoid / upper-arm ballistic protector with retention strap.
    plate(upperRig, mats.armor || mats.vest, [sign * 0.074, -0.10, 0], [0.024, 0.15, 0.15], `deltoid-armour-${side}`, [0, 0, sign * 0.1]);
    plate(upperRig, mats.webbing || mats.dark, [0, -0.17, 0], [0.152, 0.02, 0.162], `deltoid-strap-${side}`);
  }
  if (tier === 'heavy') {
    // Layered pauldron over the shoulder joint.
    box(upperRig, mats.armor || mats.vest, [sign * 0.02, 0.01, -0.005], [0.2, 0.075, 0.215], `pauldron-${side}`, [0, 0, sign * 0.22]);
  }
  const elbow = new THREE.Group(); elbow.name = `elbow-${side}`; elbow.position.set(0, -0.30, 0); upperRig.add(elbow);
  const lowerRig = new THREE.Group(); lowerRig.name = `forearm-rig-${side}`; elbow.add(lowerRig);
  const lowerGeo = taperGeometry(0.265, 0.115, 0.12, 0.09, 0.095);
  piece(lowerRig, lowerGeo, mats.cloth, [0, 0, 0], [1, 1, 1], `forearm-${side}`);
  box(lowerRig, mats.armor || mats.vest, [0, -0.12, -0.006], [0.12, 0.10, 0.14], `forearm-guard-${side}`);
  if (tier !== 'none') {
    // Wrap-around hard-shell elbow pad reads correctly at any elbow angle.
    plate(lowerRig, mats.armor || mats.vest, [0, -0.02, 0], [0.135, 0.075, 0.14], `elbow-pad-${side}`);
  }
  const wrist = new THREE.Group(); wrist.name = `wrist-${side}`; wrist.position.set(0, -0.265, 0); lowerRig.add(wrist);
  box(wrist, mats.glove || mats.dark, [0, -0.024, 0], [0.094, 0.07, 0.11], `gloved-hand-${side}`, [0.08, 0, 0]);
  box(wrist, mats.glove || mats.dark, [sign * 0.037, -0.03, -0.023], [0.035, 0.045, 0.09], `thumb-${side}`, [0, 0, sign * 0.28]);
  return { side, sign, shoulder, upperRig, elbow, lowerRig, wrist, upperLength: 0.30, lowerLength: 0.265 };
}

// Scratch objects are module-local and reused by the sequential pose calls.
const _down = new THREE.Vector3(0, -1, 0);
const _forward = new THREE.Vector3(0, 0, -1);
const _s1 = new THREE.Vector3();
const _s2 = new THREE.Vector3();
const _s3 = new THREE.Vector3();
const _s4 = new THREE.Vector3();
const _s5 = new THREE.Vector3();
const _s6 = new THREE.Vector3();
const _sQ = new THREE.Quaternion();
const _sQ2 = new THREE.Quaternion();
const _sE = new THREE.Euler();

/** Two-bone elbow solve in torso-local space; weapon wrist remains aligned with the spine. */
function poseArm(arm, target, bendSign, wristPitch = 0) {
  const shoulder = arm.shoulder.position;
  _s1.set(target[0] - shoulder.x, target[1] - shoulder.y, target[2] - shoulder.z);
  let distance = _s1.length();
  const a = arm.upperLength, b = arm.lowerLength;
  distance = THREE.MathUtils.clamp(distance, Math.abs(a - b) + 0.02, a + b - 0.018);
  _s1.normalize();
  const axial = (a * a - b * b + distance * distance) / (2 * distance);
  const height = Math.sqrt(Math.max(0.002, a * a - axial * axial));
  _s2.crossVectors(_s1, _forward);
  if (_s2.lengthSq() < 1e-4) _s2.set(1, 0, 0);
  _s2.normalize().multiplyScalar(bendSign);
  _s3.copy(shoulder).addScaledVector(_s1, axial).addScaledVector(_s2, height);
  _s4.copy(_s3).sub(shoulder).normalize();
  _s5.set(target[0] - _s3.x, target[1] - _s3.y, target[2] - _s3.z).normalize();
  arm.upperRig.quaternion.setFromUnitVectors(_down, _s4);
  arm.lowerRig.quaternion.setFromUnitVectors(_down, _s5);
  // Cancel the limb's compound twist at the wrist, then apply a small pose
  // pitch.  The held weapon inherits the torso's aim without wrist drift.
  _sQ.copy(arm.upperRig.quaternion).multiply(arm.lowerRig.quaternion).invert();
  if (wristPitch) {
    _sE.set(wristPitch, 0, 0);
    _sQ2.setFromEuler(_sE);
    _sQ.multiply(_sQ2);
  }
  arm.wrist.quaternion.copy(_sQ);
}

export function poseSoldierArms(model, aiming, moving, reloading, crouchT, fireKickT = 0, surrendered = false) {
  if (!model || !model.armL || !model.armR) return;
  // Carry muzzle forward in combat; lower it slightly while moving and keep
  // the left support hand on the fore-end. During reload the left hand reaches
  // the magazine, while the right hand retains the trigger grip.
  const lower = moving && !aiming ? -0.22 : 0;
  const crouch = crouchT * -0.018;
  const recoil = Math.min(0.08, fireKickT * 0.035);
  const rightHand = surrendered ? [0.26, 0.58, 0.04] : [0.075, 0.235 + crouch, -0.115 + recoil];
  const leftHand = surrendered ? [-0.26, 0.58, 0.04] : reloading
    ? [0.02, 0.085 + crouch, -0.18]
    : [0.055, 0.235 + crouch, -0.405 + recoil];
  const wristPitch = aiming ? 0 : lower;
  poseArm(model.armR, rightHand, 1, surrendered ? 0.18 : wristPitch);
  poseArm(model.armL, leftHand, -1, surrendered ? -0.18 : reloading ? -0.18 : wristPitch);
  model.gripPoints.right.set(rightHand[0], rightHand[1], rightHand[2]);
  model.gripPoints.left.set(leftHand[0], leftHand[1], leftHand[2]);
}

/** Build a rigged soldier or unarmed civilian using the same proportional skeleton. */
export function buildSoldierModel(mats, visual = {}) {
  const classId = visual.classId || 'rifleman';
  const weaponType = visual.weaponStyle || 'rifle';
  const isCivilian = visual.civilian || visual.gear === false;
  const tier = armourTier(visual);
  const armourMat = mats.armor || mats.vest;
  const strapMat = mats.webbing || mats.dark;
  const root = new THREE.Group(); root.name = 'soldier-root';
  const body = new THREE.Group(); body.name = 'body-pose'; root.add(body);
  const legs = new THREE.Group(); legs.name = 'leg-rig'; body.add(legs);

  // Belt and pelvis anchor the leg/torso articulation.
  const pelvis = new THREE.Group(); pelvis.name = 'pelvis'; pelvis.position.y = 0.91; body.add(pelvis);
  box(pelvis, mats.cloth, [0, 0, 0], [0.37, 0.22, 0.235], 'uniform-pelvis');
  box(pelvis, mats.webbing || mats.pouch || mats.dark, [0, -0.045, -0.126], [0.39, 0.055, 0.028], 'battle-belt');
  box(pelvis, mats.metal || mats.dark, [0, -0.04, -0.148], [0.07, 0.06, 0.025], 'belt-buckle');

  const legL = new THREE.Group(); legL.name = 'left-thigh'; legL.position.set(-0.115, 0.90, 0); legs.add(legL);
  const legR = new THREE.Group(); legR.name = 'right-thigh'; legR.position.set(0.115, 0.90, 0); legs.add(legR);
  const knees = [];
  const shins = [];
  const ankles = [];
  for (const [leg, side] of [[legL, 'L'], [legR, 'R']]) {
    piece(leg, taperGeometry(0.39, 0.18, 0.22, 0.14, 0.16), mats.cloth, [0, 0, 0], [1, 1, 1], `combat-trousers-${side}`);
    const knee = new THREE.Group(); knee.name = `knee-${side}`; knee.position.set(0, -0.38, -0.004); leg.add(knee); knees.push(knee);
    box(knee, mats.armor || mats.vest, [0, -0.005, -0.04], [0.15, 0.11, 0.07], `knee-pad-${side}`);
    const shin = new THREE.Group(); shin.name = `lower-leg-${side}`; knee.add(shin); shins.push(shin);
    piece(shin, taperGeometry(0.37, 0.14, 0.16, 0.12, 0.13), mats.cloth, [0, 0, 0], [1, 1, 1], `combat-trouser-calf-${side}`);
    box(shin, mats.webbing || mats.dark, [0, -0.18, -0.012], [0.145, 0.055, 0.17], `ankle-gaiter-${side}`);
    const ankle = new THREE.Group(); ankle.name = `ankle-${side}`; ankle.position.set(0, -0.415, -0.01); shin.add(ankle); ankles.push(ankle);
    box(ankle, mats.boots || mats.dark, [0, -0.028, -0.055], [0.16, 0.13, 0.29], `combat-boot-${side}`);
    box(ankle, mats.dark, [0, -0.092, -0.05], [0.164, 0.026, 0.285], `boot-sole-${side}`);
    box(ankle, mats.webbing || mats.dark, [0, 0.03, 0.005], [0.16, 0.06, 0.14], `boot-cuff-${side}`);
    if (tier === 'heavy' || tier === 'armored') {
      // Hard thigh plate on a leg strap.
      plate(leg, armourMat, [0, -0.17, -0.104], [0.15, 0.2, 0.026], `thigh-plate-${side}`, [-0.08, 0, 0]);
      plate(leg, strapMat, [0, -0.25, 0], [0.165, 0.022, 0.2], `thigh-strap-${side}`);
    }
    if (tier === 'heavy') {
      plate(shin, armourMat, [0, -0.16, -0.078], [0.13, 0.24, 0.028], `shin-guard-${side}`, [-0.05, 0, 0]);
    }
    if (tier !== 'none' && side === 'R') {
      // Drop-leg sidearm holster on the dominant side.
      plate(leg, mats.pouch || mats.dark, [0.103, -0.15, -0.005], [0.045, 0.15, 0.1], 'drop-leg-holster');
      plate(leg, strapMat, [0.006, -0.11, 0], [0.205, 0.02, 0.21], 'holster-leg-strap');
    }
  }
  if (tier === 'heavy' || tier === 'armored') {
    // Groin protector hanging from the battle belt.
    plate(pelvis, armourMat, [0, -0.105, -0.138], [0.15, 0.13, 0.022], 'groin-protector', [0.06, 0, 0]);
  }
  if (tier !== 'none') {
    plate(pelvis, mats.pouch || mats.dark, [0.13, -0.035, 0.125], [0.1, 0.11, 0.06], 'dump-pouch');
  }

  const torso = new THREE.Group(); torso.name = 'torso'; torso.position.y = 0.91; body.add(torso);
  box(torso, mats.cloth, [0, 0.20, 0], [0.40, 0.39, 0.245], 'field-uniform-shirt');
  box(torso, mats.cloth, [0, -0.07, 0], [0.33, 0.22, 0.21], 'uniform-abdomen');

  const heavy = classId === 'heavy';
  const recon = classId === 'recon';
  const marksman = classId === 'marksman';
  const leader = classId === 'leader';
  const scaleX = heavy ? 1.22 : recon ? 0.92 : 1;
  const gearAllowed = visual.gear !== false;
  if (gearAllowed) {
    box(torso, mats.vest, [0, 0.22, -0.037], [0.405 * scaleX, 0.355, 0.26], 'modular-plate-carrier');
    box(torso, mats.armor || mats.vest, [0, 0.245, -0.174], [0.29 * scaleX, 0.245, 0.035], 'hard-armor-plate');
    box(torso, mats.webbing || mats.pouch || mats.dark, [0, 0.40, -0.17], [0.31 * scaleX, 0.025, 0.025], 'upper-chest-webbing');
    box(torso, mats.webbing || mats.pouch || mats.dark, [0, 0.075, -0.17], [0.33 * scaleX, 0.028, 0.025], 'lower-chest-webbing');
    for (let i = 0; i < (heavy ? 4 : 3); i++) {
      const n = heavy ? 4 : 3;
      const x = (i - (n - 1) * 0.5) * 0.095;
      box(torso, i % 2 ? mats.pouch || mats.dark : mats.vest, [x, 0.12, -0.205], [0.074, 0.12, 0.065], `mag-pouch-${i + 1}`);
      box(torso, mats.webbing || mats.dark, [x, 0.125, -0.239], [0.05, 0.016, 0.009], `pouch-flap-${i + 1}`);
    }
    box(torso, mats.pouch || mats.dark, [-0.18, 0.24, -0.145], [0.08, 0.12, 0.065], 'medical-pouch');
    box(torso, mats.pouch || mats.dark, [0.18, 0.22, -0.13], [0.075, 0.17, 0.07], 'utility-pouch');
    box(torso, mats.webbing || mats.dark, [-0.17, 0.35, -0.16], [0.025, 0.24, 0.024], 'left-vest-strap');
    box(torso, mats.webbing || mats.dark, [0.17, 0.35, -0.16], [0.025, 0.24, 0.024], 'right-vest-strap');
    // Realistic plate-carrier wrap: side plates in the cummerbund, padded
    // shoulder straps and a rear plate (hidden under a pack when worn).
    const sideX = 0.2025 * scaleX + 0.012;
    for (const sx of [-1, 1]) {
      plate(torso, armourMat, [sx * sideX, 0.165, -0.03], [0.03, 0.2, 0.17], `side-plate-${sx < 0 ? 'L' : 'R'}`);
      plate(torso, mats.vest, [sx * 0.145, 0.41, -0.035], [0.09, 0.032, 0.27], `shoulder-strap-pad-${sx < 0 ? 'L' : 'R'}`);
    }
    plate(torso, mats.vest, [0, 0.10, -0.035], [0.43 * scaleX, 0.07, 0.27], 'cummerbund');
    if (!(heavy || visual.pack || leader || marksman)) {
      plate(torso, armourMat, [0, 0.245, 0.106], [0.29 * scaleX, 0.25, 0.03], 'rear-armour-plate');
      plate(torso, mats.pouch || mats.dark, [0, 0.21, 0.13], [0.15, 0.17, 0.035], 'hydration-carrier');
    }
    if (tier === 'heavy' || tier === 'armored') {
      // Throat protector and ballistic collar.
      plate(torso, armourMat, [0, 0.415, -0.142], [0.17, 0.075, 0.028], 'throat-protector', [-0.25, 0, 0]);
      plate(torso, armourMat, [0, 0.42, 0.085], [0.3, 0.07, 0.045], 'ballistic-collar-rear');
      for (const sx of [-1, 1]) plate(torso, armourMat, [sx * 0.135, 0.42, -0.02], [0.045, 0.07, 0.19], `ballistic-collar-${sx < 0 ? 'L' : 'R'}`);
    }
    if (heavy) {
      // Oversized front plate overlay for the heavy gunner.
      plate(torso, armourMat, [0, 0.215, -0.196], [0.34 * scaleX, 0.3, 0.03], 'heavy-front-plate');
    }
    if (heavy || visual.pack || leader || marksman) {
      box(torso, mats.pack || mats.vest, [0, 0.22, 0.17], [heavy ? 0.37 : 0.29, heavy ? 0.45 : 0.38, 0.20], leader ? 'radio-backpack' : 'field-pack');
      box(torso, mats.webbing || mats.dark, [0, 0.43, 0.175], [0.23, 0.025, 0.02], 'pack-retention-strap');
    }
    if (leader) {
      box(torso, mats.armor || mats.vest, [0.205, 0.31, -0.065], [0.055, 0.105, 0.035], 'leader-arm-patch');
      const antenna = piece(torso, SHARED.narrowBarrel, mats.metal || mats.dark, [0.17, 0.49, 0.18], [0.012, 0.28, 0.012], 'radio-antenna');
      antenna.rotation.x = 0.12;
    }
    if (marksman) {
      box(torso, mats.webbing || mats.dark, [-0.18, 0.44, 0.03], [0.18, 0.065, 0.18], 'spotter-binocular-pouch');
    }
  }

  // Shoulder pivots and articulated arm bones.  The weapon's trigger grip is
  // attached to the right wrist after the two-bone pose solve.
  const armL = makeArm(torso, 'L', mats, tier);
  const armR = makeArm(torso, 'R', mats, tier);

  const neck = new THREE.Group(); neck.name = 'neck'; neck.position.set(0, 0.455, 0); torso.add(neck);
  box(neck, mats.skin, [0, 0.035, 0], [0.125, 0.13, 0.12], 'neck');
  const headGrp = new THREE.Group(); headGrp.name = 'head-pivot'; headGrp.position.set(0, 0.535, 0); torso.add(headGrp);
  headGrp.scale.setScalar(visual.headScale || 1);
  const faceMat = mats.skin;
  piece(headGrp, SHARED.head, faceMat, [0, 0.055, 0], [0.105, 0.128, 0.096], 'faceted-human-head');
  box(headGrp, faceMat, [0, -0.045, -0.032], [0.11, 0.07, 0.095], 'jawline');
  // Brow, visible eye-line, eye lenses and nose define a readable face at play distance.
  box(headGrp, mats.dark, [0, 0.080, -0.084], [0.125, 0.035, 0.027], 'goggle-frame');
  for (const x of [-0.033, 0.033]) {
    box(headGrp, mats.optic || mats.dark, [x, 0.079, -0.101], [0.040, 0.023, 0.008], `eye-lens-${x < 0 ? 'L' : 'R'}`);
  }
  piece(headGrp, SHARED.joint, faceMat, [0, 0.035, -0.092], [0.018, 0.025, 0.025], 'nose-bridge');
  if (visual.faceCover) {
    box(headGrp, mats.dark, [0, -0.005, -0.087], [0.118, 0.075, 0.029], 'lower-face-cover');
    box(headGrp, mats.webbing || mats.dark, [0, -0.075, -0.013], [0.15, 0.02, 0.024], 'mask-strap');
  }
  if (visual.headwear !== 'none') {
    const cap = visual.headwear === 'cap';
    const shellMat = cap ? mats.cloth : visual.helmetCover ? mats.cloth : mats.helmet;
    piece(headGrp, SHARED.head, shellMat,
      [0, 0.154, 0], [0.13, cap ? 0.065 : 0.086, 0.12],
      cap ? 'soft-cap' : 'combat-helmet');
    box(headGrp, cap ? mats.cloth : shellMat, [0, 0.126, -0.076], [0.145, 0.026, 0.074], 'helmet-brim');
    box(headGrp, mats.webbing || mats.dark, [0, 0.05, -0.087], [0.17, 0.018, 0.022], 'helmet-chinstrap');
    if (!cap) {
      // High-cut ballistic helmet: accessory rails, NVG shroud, rear
      // counterweight pouch.
      for (const sx of [-1, 1]) plate(headGrp, mats.dark, [sx * 0.127, 0.14, -0.004], [0.014, 0.026, 0.14], `helmet-rail-${sx < 0 ? 'L' : 'R'}`);
      plate(headGrp, mats.dark, [0, 0.188, -0.116], [0.052, 0.036, 0.022], 'nvg-shroud');
      plate(headGrp, mats.pouch || mats.dark, [0, 0.135, 0.116], [0.085, 0.05, 0.03], 'helmet-counterweight');
      if (tier === 'heavy') {
        // Tinted ballistic visor and mandible guard.
        plate(headGrp, mats.optic || mats.dark, [0, 0.058, -0.113], [0.17, 0.115, 0.014], 'ballistic-visor', [-0.06, 0, 0]);
        plate(headGrp, armourMat, [0, -0.03, -0.106], [0.15, 0.05, 0.04], 'mandible-guard');
      } else if (tier === 'armored') {
        plate(headGrp, armourMat, [0, -0.03, -0.106], [0.15, 0.05, 0.04], 'mandible-guard');
      }
    }
  }
  for (const side of [-1, 1]) {
    box(headGrp, mats.dark, [side * 0.112, 0.04, 0], [0.035, 0.075, 0.11], `ear-defender-${side}`);
  }

  const backpack = torso.children.find(o => o.name === 'field-pack' || o.name === 'radio-backpack') || null;
  const weapon = gearAllowed && visual.weaponStyle !== 'none'
    ? buildWeapon(armR.wrist, mats, weaponType)
    : { gun: new THREE.Group(), muzzle: new THREE.Object3D(), magazine: null, type: 'none' };
  if (!gearAllowed) {
    // NPCs remain unarmed, but share the same facial/head/limb construction.
    weapon.gun.visible = false;
    weapon.muzzle.visible = false;
  }

  const strobe = box(torso, mats.strobe || mats.dark, [-0.20, 0.40, -0.12], [0.07, 0.07, 0.035], 'faction-identification-tab');
  strobe.visible = visual.strobe !== false && gearAllowed;

  // The skeleton remains fully articulated, while fixed armor/cloth/weapon
  // pieces on each joint collapse into a few material batches for mobile GPUs.
  const mergedGeometries = [];
  for (const joint of [
    pelvis, legL, legR, knees[0], knees[1], shins[0], shins[1], ankles[0], ankles[1],
    torso, armL.upperRig, armL.lowerRig, armL.wrist, armR.upperRig, armR.lowerRig, armR.wrist,
    neck, headGrp, weapon.gun,
  ]) {
    mergedGeometries.push(...mergeJointMeshes(joint, mesh => mesh === strobe || mesh === weapon.magazine));
  }

  const rootScale = visual.height || 1;
  body.scale.set(visual.width || (heavy ? 1.08 : recon ? 0.95 : 1), 1, visual.depth || 1);
  root.scale.y = rootScale;
  root.userData.enemyClass = classId;
  root.userData.weaponType = weapon.type;

  return {
    root, body, legs, pelvis, torso, headGrp,
    legL, legR, kneeL: knees[0], kneeR: knees[1], shins, ankles,
    armL, armR, rifle: weapon.gun, muzzle: weapon.muzzle, mag: weapon.magazine,
    strobe, backpack, upperArms: [armL.upperRig, armR.upperRig],
    lowerArms: [armL.lowerRig, armR.lowerRig], gripPoints: { left: new THREE.Vector3(), right: new THREE.Vector3() },
    weaponType: weapon.type, classId, mergedGeometries,
  };
}

/** Release only per-actor merged geometries; shared primitives and materials stay cached. */
export function disposeSoldierModel(model) {
  if (!model || !model.mergedGeometries) return;
  for (const geometry of model.mergedGeometries) geometry.dispose();
  model.mergedGeometries.length = 0;
}

/** Count scene meshes/vertices for profiling and headless tests. */
export function soldierGeometryStats(root) {
  let meshes = 0, vertices = 0, weapons = 0;
  root.traverse(node => {
    if (!node.isMesh) return;
    meshes++;
    vertices += node.geometry?.attributes?.position?.count || 0;
    if (node.name.includes('weapon-') || node.name.includes('magazine') || node.name.includes('optic')) weapons++;
  });
  return { meshes, vertices, weaponParts: weapons };
}

export const SOLDIER_WEAPON_TYPES = Object.freeze(Object.keys(WEAPON_SHAPES));
