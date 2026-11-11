/**
 * weapons.js
 * Original fictional weapons with independent handling characteristics and a
 * proper shot simulation pipeline:
 *
 *   input → weapon state → firing state → hitscan / projectile simulation
 *         → collision (world + entities) → material interaction → damage
 *
 *  VX-4  — 5.56-class assault rifle, full-auto, hitscan with tracer
 *  MR-7  — marksman rifle, semi-auto, simulated projectile travel + drop
 *  P9    — compact sidearm, semi-auto, hitscan
 *
 * View models are built from shared original primitives and depth-tested so
 * they remain correctly occluded; they animate procedurally (idle breathing,
 * sway, bob, recoil springs, reload keyframes, ADS transitions).
 * Weapon behaviour here is stylised game simulation, not a model of any
 * real-world firearm.
 */
import * as THREE from 'three';
import { rayAABBLocal } from './physics.js';
import { roundedBoxGeometry } from './geometry.js';

const DEG = Math.PI / 180;
const VM_HAND_MATS = {
  glove: new THREE.MeshStandardMaterial({ color: 0x222722, roughness: 0.94, metalness: 0.01, depthTest: true }),
  seam: new THREE.MeshStandardMaterial({ color: 0x394036, roughness: 0.96, metalness: 0.01, depthTest: true }),
  sleeve: new THREE.MeshStandardMaterial({ color: 0x394136, roughness: 0.96, metalness: 0.01, depthTest: true }),
  cuff: new THREE.MeshStandardMaterial({ color: 0x282e29, roughness: 0.92, metalness: 0.02, depthTest: true }),
};
const VM_CYLINDERS = new Map();
const VM_CAPSULES = new Map();
const VM_SPHERE = new THREE.SphereGeometry(1, 10, 8);
const VM_UP = new THREE.Vector3(0, 1, 0);
const VM_DIR = new THREE.Vector3();
const VM_MID = new THREE.Vector3();

export const WEAPON_DEFS = {
  vx4: {
    id: 'vx4', slot: 1, name: 'VX-4', klass: 'ASSAULT RIFLE',
    auto: true, rpm: 660,
    fireModes: ['semi', 'auto'], defaultFireMode: 'auto', burstCount: 3,
    penetration: 0.48, muzzleScale: 0.72,
    // VX-4 is supplied as one continuous 300-round mission load. There is no
    // 30-round reload gate; the visible receiver/magazine model is unchanged.
    magSize: 300, startReserve: 0, reserveMax: 0, noReload: true,
    damage: 34,
    zoneMult: { head: 3.2, torso: 1.0, arms: 0.72, legs: 0.62 },
    falloff: { near: 35, far: 110, min: 0.55 },
    projectile: false,
    spread: { hip: 1.15 * DEG, hipMove: 2.6 * DEG, ads: 0.09 * DEG, adsMove: 0.5 * DEG, bloomPerShot: 0.16 * DEG, bloomMax: 1.7 * DEG, bloomRecover: 2.6 * DEG },
    recoil: { pitch: 0.62 * DEG, yaw: 0.24 * DEG, kickZ: 0.055, kickPitch: 3.2 * DEG, recover: 9 },
    adsTime: 0.26, adsFov: 55, sightY: 0.055,
    reload: { tactical: 1.95, dry: 2.5 },
    noiseRadius: 55,
    sound: 'vx4',
    handling: 1.0, // how much movement slows while equipped
    weight: 5.0,
  },
  mr7: {
    id: 'mr7', slot: 2, name: 'MR-7', klass: 'MARKSMAN RIFLE',
    auto: false, rpm: 150, // mechanical cyclic limit; semi delay below
    fireModes: ['semi'], defaultFireMode: 'semi',
    semiDelay: 0.5, penetration: 0.64, muzzleScale: 0.9,
    magSize: 10, startReserve: 40, reserveMax: 60,
    damage: 78,
    zoneMult: { head: 2.6, torso: 1.0, arms: 0.8, legs: 0.7 },
    falloff: { near: 90, far: 300, min: 0.7 },
    projectile: true, projSpeed: 260, projGravity: 9.81, projLife: 2.2,
    spread: { hip: 2.2 * DEG, hipMove: 4.0 * DEG, ads: 0.015 * DEG, adsMove: 0.25 * DEG, bloomPerShot: 0.9 * DEG, bloomMax: 3 * DEG, bloomRecover: 1.6 * DEG },
    recoil: { pitch: 2.1 * DEG, yaw: 0.5 * DEG, kickZ: 0.13, kickPitch: 9 * DEG, recover: 4.5 },
    adsTime: 0.42, adsFov: 34, sightY: 0.075,
    reload: { tactical: 2.5, dry: 3.1 },
    noiseRadius: 85,
    sound: 'mr7',
    handling: 0.82,
    weight: 6.0,
    shake: 0.1,
  },
  p9: {
    id: 'p9', slot: 3, name: 'PX-9', klass: 'MACHINE PISTOL', sidearm: true,
    auto: true, rpm: 720, // Phase-14: full-auto available via fire-mode toggle (B); semi remains the default cadence
    fireModes: ['semi', 'auto'], defaultFireMode: 'semi',
    semiDelay: 0.13, penetration: 0.2, muzzleScale: 0.58,
    magSize: 15, startReserve: 60, reserveMax: 105,
    damage: 24,
    zoneMult: { head: 3.0, torso: 1.0, arms: 0.75, legs: 0.65 },
    falloff: { near: 18, far: 60, min: 0.5 },
    projectile: false,
    spread: { hip: 1.3 * DEG, hipMove: 2.8 * DEG, ads: 0.16 * DEG, adsMove: 0.7 * DEG, bloomPerShot: 0.3 * DEG, bloomMax: 2.2 * DEG, bloomRecover: 3.4 * DEG },
    recoil: { pitch: 0.95 * DEG, yaw: 0.4 * DEG, kickZ: 0.07, kickPitch: 5.5 * DEG, recover: 11 },
    adsTime: 0.17, adsFov: 62, sightY: 0.048,
    reload: { tactical: 1.45, dry: 1.85 },
    noiseRadius: 34,
    sound: 'p9',
    handling: 1.15,
    weight: 1.5,
  },

  // ---- C3 arsenal: fictional designs, gameplay-first identities ----
  st12: {
    id: 'st12', slot: 1, name: 'ST-12', klass: 'SHOTGUN',
    auto: false, rpm: 180, semiDelay: 0.36,
    fireModes: ['semi'], defaultFireMode: 'semi', reloadStyle: 'shell',
    magSize: 8, startReserve: 32, reserveMax: 56,
    damage: 10, pellets: 9, pelletRange: 48,
    zoneMult: { head: 1.65, torso: 1.0, arms: 0.8, legs: 0.7 },
    falloff: { near: 8, far: 34, min: 0.18 },
    projectile: false, penetration: 0.16, muzzleScale: 1.12, casingSize: 0.027,
    spread: { hip: 3.1 * DEG, hipMove: 4.2 * DEG, ads: 1.35 * DEG, adsMove: 2.2 * DEG, bloomPerShot: 0.72 * DEG, bloomMax: 4.2 * DEG, bloomRecover: 2.6 * DEG },
    recoil: { pitch: 2.2 * DEG, yaw: 0.55 * DEG, kickZ: 0.15, kickPitch: 10 * DEG, recover: 5.2 },
    adsTime: 0.31, adsFov: 56, sightY: 0.062,
    reload: { tactical: 0.42, dry: 0.55, shellStep: 0.42 },
    noiseRadius: 52,
    sound: 'st12',
    handling: 0.92,
    weight: 4.2,
    vmTint: 0x3a3f45,
  },
  vekp: {
    id: 'vekp', slot: 1, name: 'VEKTOR P', klass: 'SMG',
    auto: true, rpm: 920,
    fireModes: ['semi', 'burst', 'auto'], defaultFireMode: 'auto', burstCount: 3,
    magSize: 30, startReserve: 150, reserveMax: 210,
    damage: 17,
    zoneMult: { head: 2.8, torso: 1.0, arms: 0.72, legs: 0.6 },
    falloff: { near: 16, far: 52, min: 0.42 },
    projectile: false, penetration: 0.28, muzzleScale: 0.56,
    spread: { hip: 1.95 * DEG, hipMove: 3.4 * DEG, ads: 0.28 * DEG, adsMove: 0.95 * DEG, bloomPerShot: 0.3 * DEG, bloomMax: 3.1 * DEG, bloomRecover: 4.0 * DEG },
    recoil: { pitch: 0.58 * DEG, yaw: 0.34 * DEG, kickZ: 0.052, kickPitch: 3.8 * DEG, recover: 11 },
    adsTime: 0.18, adsFov: 61, sightY: 0.05,
    reload: { tactical: 1.6, dry: 2.0 },
    noiseRadius: 36,
    sound: 'vekp',
    handling: 1.22,
    weight: 3.1,
    vmTint: 0x2c2f34,
  },
  vx12: {
    id: 'vx12', slot: 1, name: 'VX-12 BREACHER', klass: 'SHOTGUN',
    auto: false, rpm: 70, semiDelay: 0.85,
    fireModes: ['semi'], defaultFireMode: 'semi', reloadStyle: 'shell',
    magSize: 6, startReserve: 24, reserveMax: 42,
    damage: 13, pellets: 8, pelletRange: 55,
    zoneMult: { head: 2.4, torso: 1.0, arms: 0.8, legs: 0.7 },
    falloff: { near: 9, far: 30, min: 0.12 },
    projectile: false, penetration: 0.2, muzzleScale: 1.25, casingSize: 0.029,
    spread: { hip: 3.4 * DEG, hipMove: 4.4 * DEG, ads: 1.7 * DEG, adsMove: 2.4 * DEG, bloomPerShot: 1.4 * DEG, bloomMax: 4 * DEG, bloomRecover: 2.2 * DEG },
    recoil: { pitch: 3.1 * DEG, yaw: 0.7 * DEG, kickZ: 0.19, kickPitch: 12 * DEG, recover: 4 },
    adsTime: 0.34, adsFov: 56, sightY: 0.062,
    reload: { tactical: 4.4, dry: 5.2, shellStep: 0.46 },
    noiseRadius: 62,
    sound: 'vx12',
    handling: 0.9,
    weight: 6.5,
    shake: 0.12,
    vmTint: 0x33302a,
  },
  mpx5: {
    id: 'mpx5', slot: 1, name: 'MPX-5', klass: 'SMG',
    auto: true, rpm: 850,
    fireModes: ['semi', 'auto'], defaultFireMode: 'auto', burstCount: 3,
    magSize: 30, startReserve: 150, reserveMax: 210,
    damage: 19,
    zoneMult: { head: 3.0, torso: 1.0, arms: 0.72, legs: 0.6 },
    falloff: { near: 22, far: 70, min: 0.45 },
    projectile: false, penetration: 0.25, muzzleScale: 0.58,
    spread: { hip: 1.5 * DEG, hipMove: 2.7 * DEG, ads: 0.22 * DEG, adsMove: 0.85 * DEG, bloomPerShot: 0.15 * DEG, bloomMax: 1.9 * DEG, bloomRecover: 3.0 * DEG },
    recoil: { pitch: 0.45 * DEG, yaw: 0.26 * DEG, kickZ: 0.042, kickPitch: 2.9 * DEG, recover: 12 },
    adsTime: 0.19, adsFov: 60, sightY: 0.052,
    reload: { tactical: 1.65, dry: 2.1 },
    noiseRadius: 42,
    sound: 'mpx5',
    handling: 1.25,
    weight: 3.5,
    vmTint: 0x26292e,
  },
  cr9: {
    id: 'cr9', slot: 1, name: 'CR-9', klass: 'ASSAULT RIFLE',
    auto: true, rpm: 700,
    fireModes: ['semi', 'burst', 'auto'], defaultFireMode: 'auto', burstCount: 3,
    magSize: 25, startReserve: 125, reserveMax: 175,
    damage: 23,
    zoneMult: { head: 3.0, torso: 1.0, arms: 0.72, legs: 0.62 },
    falloff: { near: 26, far: 80, min: 0.5 },
    projectile: false, penetration: 0.5, muzzleScale: 0.68,
    spread: { hip: 1.2 * DEG, hipMove: 2.3 * DEG, ads: 0.11 * DEG, adsMove: 0.6 * DEG, bloomPerShot: 0.11 * DEG, bloomMax: 1.4 * DEG, bloomRecover: 3.2 * DEG },
    recoil: { pitch: 0.38 * DEG, yaw: 0.16 * DEG, kickZ: 0.038, kickPitch: 2.4 * DEG, recover: 13 },
    adsTime: 0.23, adsFov: 58, sightY: 0.052,
    reload: { tactical: 1.8, dry: 2.3 },
    noiseRadius: 44,
    sound: 'cr9',
    handling: 1.1,
    weight: 4.0,
    vmTint: 0x2e3238,
  },
  rk4: {
    id: 'rk4', slot: 1, name: 'RK-4 LANCER', klass: 'ASSAULT RIFLE',
    auto: false, rpm: 600,
    fireModes: ['semi', 'burst'], defaultFireMode: 'burst', burstCount: 3,
    magSize: 25, startReserve: 125, reserveMax: 175,
    damage: 34,
    zoneMult: { head: 3.1, torso: 1.0, arms: 0.72, legs: 0.62 },
    falloff: { near: 40, far: 120, min: 0.6 },
    projectile: false,
    spread: { hip: 1.3 * DEG, hipMove: 2.8 * DEG, ads: 0.1 * DEG, adsMove: 0.55 * DEG, bloomPerShot: 0.2 * DEG, bloomMax: 2.1 * DEG, bloomRecover: 2.3 * DEG },
    recoil: { pitch: 0.85 * DEG, yaw: 0.34 * DEG, kickZ: 0.075, kickPitch: 4.4 * DEG, recover: 7.5 },
    adsTime: 0.3, adsFov: 52, sightY: 0.058,
    reload: { tactical: 2.2, dry: 2.8 },
    noiseRadius: 62, penetration: 0.58, muzzleScale: 0.82,
    sound: 'rk4',
    handling: 0.85,
    weight: 5.5,
    shake: 0.06,
    vmTint: 0x3c3a33,
  },
  sz8: {
    id: 'sz8', slot: 1, name: 'SZ-8 WASP', klass: 'MARKSMAN RIFLE',
    auto: false, rpm: 620,
    fireModes: ['semi', 'burst'], defaultFireMode: 'semi', burstCount: 3,
    magSize: 30, startReserve: 150, reserveMax: 210,
    damage: 25,
    zoneMult: { head: 2.7, torso: 1.0, arms: 0.78, legs: 0.7 },
    falloff: { near: 28, far: 90, min: 0.5 },
    projectile: false,
    spread: { hip: 1.35 * DEG, hipMove: 2.5 * DEG, ads: 0.13 * DEG, adsMove: 0.7 * DEG, bloomPerShot: 0.13 * DEG, bloomMax: 1.6 * DEG, bloomRecover: 2.8 * DEG },
    recoil: { pitch: 0.5 * DEG, yaw: 0.22 * DEG, kickZ: 0.048, kickPitch: 3 * DEG, recover: 11 },
    adsTime: 0.21, adsFov: 58, sightY: 0.054,
    reload: { tactical: 2.0, dry: 2.5 },
    noiseRadius: 58, penetration: 0.55, muzzleScale: 0.78,
    sound: 'sz8',
    handling: 1.2,
    weight: 4.0,
    vmTint: 0x28302c,
  },
  lb9: {
    id: 'lb9', slot: 1, name: 'LB-9 LONGBOW', klass: 'PRECISION RIFLE',
    auto: false, rpm: 52, semiDelay: 1.15,
    fireModes: ['semi'], defaultFireMode: 'semi',
    magSize: 5, startReserve: 20, reserveMax: 35,
    damage: 115,
    zoneMult: { head: 2.8, torso: 1.0, arms: 0.85, legs: 0.75 },
    falloff: { near: 120, far: 400, min: 0.75 },
    projectile: true, projSpeed: 420, projGravity: 9.81, projLife: 2.6,
    penetration: 0.86, muzzleScale: 1.0,
    spread: { hip: 3.2 * DEG, hipMove: 5.5 * DEG, ads: 0.008 * DEG, adsMove: 0.35 * DEG, bloomPerShot: 1.6 * DEG, bloomMax: 5 * DEG, bloomRecover: 1.1 * DEG },
    recoil: { pitch: 3.4 * DEG, yaw: 0.8 * DEG, kickZ: 0.22, kickPitch: 14 * DEG, recover: 3 },
    adsTime: 0.35, adsFov: 35, sightY: 0.096, adsScale: 1.0,
    reload: { tactical: 3.0, dry: 3.7 },
    noiseRadius: 110,
    sound: 'lb9',
    handling: 0.7,
    weight: 7.5,
    shake: 0.16,
    vmTint: 0x2e352b,
  },
  // ---- Phase-14 armory expansion ----
  hmg9: {
    id: 'hmg9', slot: 1, name: 'HMG-9 SENTINEL', klass: 'HMG SUPPORT',
    auto: true, rpm: 600,
    fireModes: ['semi', 'auto'], defaultFireMode: 'auto',
    penetration: 0.5, muzzleScale: 0.85,
    magSize: 60, startReserve: 120, reserveMax: 180,
    damage: 27,
    zoneMult: { head: 2.6, torso: 1.0, arms: 0.74, legs: 0.64 },
    falloff: { near: 30, far: 120, min: 0.5 },
    projectile: false,
    spread: { hip: 2.4 * DEG, hipMove: 4.2 * DEG, ads: 0.22 * DEG, adsMove: 0.9 * DEG, bloomPerShot: 0.24 * DEG, bloomMax: 2.6 * DEG, bloomRecover: 3.2 * DEG },
    recoil: { pitch: 0.72 * DEG, yaw: 0.4 * DEG, kickZ: 0.07, kickPitch: 4.5 * DEG, recover: 8 },
    adsTime: 0.34, adsFov: 58, sightY: 0.058,
    reload: { tactical: 3.6, dry: 4.3 },
    noiseRadius: 62,
    sound: 'rk4',
    handling: 0.78, // heaviest primary in the service — a real mobility trade
    weight: 9.8,
    vmTint: 0x2e3236,
  },
};
export const WEAPON_ORDER = ['vx4', 'mr7', 'p9', 'st12', 'vekp', 'vx12', 'mpx5', 'cr9', 'rk4', 'sz8', 'lb9', 'hmg9'];

// ---------------------------------------------------------------------------
// View model construction (all original shapes — no real weapon replicas)
// ---------------------------------------------------------------------------
function gunMetal(color = 0x23262a, rough = 0.42) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.72, depthTest: true });
  return m;
}
function polymer(color = 0x2c3129) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, depthTest: true });
}
const VM_PLANE = new THREE.PlaneGeometry(1, 1);
function sightGlass() {
  return new THREE.MeshBasicMaterial({ color: 0x9fd6ff, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide });
}
function accent(color = 0x4a4f42) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3, depthTest: true });
}

class ViewModelBuilder {
  /** Keep viewmodel parts depth-tested, while sharing a deterministic render order. */
  static finalize(group) {
    group.traverse(o => {
      if (o.isMesh) {
        o.renderOrder = 8;
        o.castShadow = false;
        o.receiveShadow = false;
        o.frustumCulled = false;
      }
    });
    return group;
  }

  static box(parent, w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
    const m = new THREE.Mesh(roundedBoxGeometry(), mat);
    m.position.set(x, y, z);
    m.scale.set(w, h, d);
    m.rotation.set(rx, ry, rz);
    parent.add(m);
    return m;
  }
  static cyl(parent, rt, rb, h, seg, mat, x, y, z, rx = 0, rz = 0) {
    const radius = Math.max(rt, rb, 0.0001);
    const top = +(rt / radius).toFixed(3), bottom = +(rb / radius).toFixed(3);
    const key = `${seg}:${top}:${bottom}`;
    let geo = VM_CYLINDERS.get(key);
    if (!geo) { geo = new THREE.CylinderGeometry(top, bottom, 1, seg); VM_CYLINDERS.set(key, geo); }
    const m = new THREE.Mesh(geo, mat);
    m.scale.set(radius, h, radius);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    parent.add(m);
    return m;
  }

  // ---- Critical ADS fix: see-through sights + an explicit sight line --------
  // Every viewmodel publishes userData.sightLine = { rear, front } (model-local
  // points the eye must line up). The ADS pose is SOLVED from these points each
  // frame (see WeaponSystem.update), instead of a hand-tuned sightY constant
  // that ignored the ADS scale and did not match the modelled sights.
  static setSightLine(g, rear, front) {
    g.userData.sightLine = { rear: new THREE.Vector3(...rear), front: new THREE.Vector3(...front) };
  }
  /** Hollow reflex/red-dot hood centred on the sight line (yc). Returns the line. */
  static reflex(g, yc, z, wIn, hIn, d, mat, t = 0.005, dot = 0xff2a1a) {
    this.box(g, t, hIn + 2 * t, d, mat, -(wIn / 2 + t / 2), yc, z);
    this.box(g, t, hIn + 2 * t, d, mat, (wIn / 2 + t / 2), yc, z);
    this.box(g, wIn + 2 * t, t, d, mat, 0, yc + hIn / 2 + t / 2, z);
    this.box(g, wIn + 2 * t, t * 2, d, mat, 0, yc - hIn / 2 - t, z);
    const glass = new THREE.Mesh(VM_PLANE, sightGlass());
    glass.scale.set(wIn, hIn, 1); glass.position.set(0, yc, z - d / 2 + 0.003);
    g.add(glass);
    const red = new THREE.Mesh(VM_PLANE, new THREE.MeshBasicMaterial({ color: dot, depthTest: true }));
    red.scale.set(0.0022, 0.0022, 1); red.position.set(0, yc, z - d / 2 + 0.0045);
    g.add(red);
    return [[0, yc, z + d / 2], [0, yc, z - d / 2]];
  }
  /** Open-ended (see-through) optic tube along -Z with a fine cross reticle. */
  static scopeTube(g, r, len, mat, y, z, reticleZ) {
    const tubeMat = mat.clone(); tubeMat.side = THREE.DoubleSide;
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 18, 1, true), tubeMat);
    tube.scale.set(r, len, r); tube.rotation.x = Math.PI / 2; tube.position.set(0, y, z);
    g.add(tube);
    const ret = new THREE.MeshBasicMaterial({ color: 0x060606, depthTest: true });
    const rz = reticleZ != null ? reticleZ : z - len / 2 + 0.004;
    const h = new THREE.Mesh(VM_PLANE, ret); h.scale.set(r * 2, 0.0007, 1); h.position.set(0, y, rz); g.add(h);
    const v = new THREE.Mesh(VM_PLANE, ret); v.scale.set(0.0007, r * 2, 1); v.position.set(0, y, rz); g.add(v);
    const glass = new THREE.Mesh(VM_PLANE, sightGlass()); glass.scale.set(r * 2, r * 2, 1); glass.position.set(0, y, rz - 0.002); g.add(glass);
    return tube;
  }
  /** Small self-luminous (tritium-style) dot so a dark post reads at night. */
  static nightDot(g, y, z, size = 0.0024) {
    const d = new THREE.Mesh(VM_PLANE, new THREE.MeshBasicMaterial({ color: 0x9dff8a, depthTest: true }));
    d.scale.set(size, size, 1); d.position.set(0, y, z);
    g.add(d);
    return d;
  }
  /** Two-ear rear notch (open U) whose top edge sits on the sight line. */
  static notch(g, top, z, gap, earW, earH, d, mat) {
    const x = gap / 2 + earW / 2;
    this.box(g, earW, earH, d, mat, -x, top - earH / 2, z);
    this.box(g, earW, earH, d, mat, x, top - earH / 2, z);
    this.box(g, gap + earW * 2, earH * 0.45, d, mat, 0, top - earH + earH * 0.225, z);
  }
  /** Rear peep (aperture ring) centred on the sight line. */
  static peep(g, yc, z, hole, ring, d, mat) {
    const w = hole + ring * 2;
    this.box(g, ring, w, d, mat, -(hole / 2 + ring / 2), yc, z);
    this.box(g, ring, w, d, mat, (hole / 2 + ring / 2), yc, z);
    this.box(g, w, ring, d, mat, 0, yc + hole / 2 + ring / 2, z);
    this.box(g, w, ring, d, mat, 0, yc - hole / 2 - ring / 2, z);
  }

  static capsuleBetween(parent, start, end, radius, mat, radial = 8) {
    VM_DIR.set(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
    const length = VM_DIR.length();
    const inner = Math.max(0.012, length - radius * 2);
    const key = `${radius.toFixed(3)}:${inner.toFixed(3)}:${radial}`;
    let geo = VM_CAPSULES.get(key);
    if (!geo) { geo = new THREE.CapsuleGeometry(radius, inner, 3, radial); VM_CAPSULES.set(key, geo); }
    const mesh = new THREE.Mesh(geo, mat);
    VM_MID.set((start[0] + end[0]) * 0.5, (start[1] + end[1]) * 0.5, (start[2] + end[2]) * 0.5);
    mesh.position.copy(VM_MID);
    mesh.quaternion.setFromUnitVectors(VM_UP, VM_DIR.normalize());
    parent.add(mesh);
    return mesh;
  }

  static ellipsoid(parent, mat, pos, scale) {
    const m = new THREE.Mesh(VM_SPHERE, mat);
    m.position.set(pos[0], pos[1], pos[2]);
    m.scale.set(scale[0], scale[1], scale[2]);
    parent.add(m);
    return m;
  }

  /** Detailed, original family silhouettes; pickups reuse the same compact geometry. */
  static generic(def) {
    const g = new THREE.Group();
    const steel = gunMetal(def.vmTint || 0x26292e, 0.38);
    const dark = gunMetal(0x17191c, 0.52);
    const poly = polymer(def.vmPoly || 0x31362c);
    const grip = polymer(0x222620);
    const accentMat = accent(def.vmAccent || 0x575748);
    const lensMat = new THREE.MeshStandardMaterial({ color: 0x101923, emissive: 0x172638, emissiveIntensity: 0.26, roughness: 0.2, metalness: 0.35, depthTest: true });
    const k = def.klass;
    const muzzle = new THREE.Object3D();
    const port = new THREE.Object3D();
    const sight = new THREE.Object3D();
    const ySight = def.sightY || 0.055;
    sight.position.set(0, ySight, 0);

    if (k === 'SIDEARM') {
      // Compact locked-slide pistol: slide, frame, ejection port and safe trigger opening.
      this.box(g, 0.047, 0.052, 0.228, steel, 0, 0.022, -0.085);
      this.box(g, 0.041, 0.031, 0.184, poly, 0, -0.012, -0.055);
      this.box(g, 0.039, 0.102, 0.056, grip, 0, -0.072, 0.022, 0.24);
      this.box(g, 0.048, 0.012, 0.055, dark, 0, 0.046, -0.10); // ejection port
      for (let i = 0; i < 5; i++) this.box(g, 0.05, 0.008, 0.009, dark, 0, 0.036, -0.01 + i * 0.014);
      this.box(g, 0.012, 0.009, 0.05, dark, 0, -0.035, -0.025); // trigger guard base
      this.box(g, 0.012, 0.037, 0.01, dark, 0, -0.018, -0.048);
      // Critical ADS fix: front blade top and rear-notch top share one line (y 0.060)
      this.box(g, 0.006, 0.012, 0.012, accentMat, 0, 0.054, -0.184); // front sight blade
      this.nightDot(g, 0.0565, -0.1905);
      this.notch(g, 0.060, 0.015, 0.0075, 0.011, 0.014, 0.013, dark); // rear notch
      this.setSightLine(g, [0, 0.060, 0.015], [0, 0.060, -0.184]);
      const mag = new THREE.Group();
      this.box(mag, 0.036, 0.075, 0.043, poly, 0, 0, 0.01);
      this.box(mag, 0.046, 0.016, 0.042, dark, 0, -0.043, 0.008);
      for (let i = 0; i < 3; i++) this.box(mag, 0.036, 0.006, 0.012, accentMat, 0, 0.022 - i * 0.019, 0.031);
      mag.position.set(0, -0.082, 0.02);
      g.add(mag);
      g.userData.mag = mag;
      this.cyl(g, 0.008, 0.008, 0.025, 10, dark, 0, 0.02, -0.205, Math.PI / 2);
      muzzle.position.set(0, 0.02, -0.222);
      port.position.set(0.033, 0.03, -0.075);
    } else if (k === 'SHOTGUN') {
      const long = def.id === 'vx12';
      const barrelZ = long ? -0.49 : -0.43;
      const barrelLen = long ? 0.62 : 0.53;
      this.box(g, 0.062, 0.075, 0.32, steel, 0, 0.004, -0.095); // receiver
      this.box(g, 0.052, 0.029, 0.17, dark, 0, -0.036, -0.11); // lower receiver
      this.cyl(g, 0.015, 0.017, barrelLen, 12, dark, 0, 0.018, barrelZ, Math.PI / 2);
      this.cyl(g, 0.013, 0.014, long ? 0.48 : 0.38, 12, steel, 0, -0.025, long ? -0.405 : -0.36, Math.PI / 2); // magazine tube
      this.cyl(g, 0.018, 0.018, 0.055, 12, dark, 0, 0.018, barrelZ - barrelLen * 0.49, Math.PI / 2); // muzzle ring
      const pump = this.box(g, 0.059, 0.062, long ? 0.17 : 0.15, poly, 0, -0.005, long ? -0.34 : -0.29); // pump/fore-end
      pump.userData.baseZ = pump.position.z;
      g.userData.pump = pump;
      for (let i = 0; i < 4; i++) this.box(g, 0.062, 0.008, 0.018, grip, 0, 0.018, (long ? -0.27 : -0.22) - i * 0.034);
      this.box(g, 0.051, 0.068, 0.23, poly, 0, -0.008, 0.155, -0.07); // shoulder stock
      this.box(g, 0.054, 0.086, 0.032, grip, 0, -0.012, 0.263); // butt pad
      this.box(g, 0.044, 0.092, 0.05, grip, 0, -0.069, 0.015, 0.28); // pistol grip
      this.box(g, 0.012, 0.01, 0.07, dark, 0, -0.037, -0.025); // trigger guard
      // Critical ADS fix: bead top level with the rear-notch top (y 0.060)
      this.box(g, 0.008, 0.032, 0.009, accentMat, 0, 0.044, -0.31); // front bead post
      this.notch(g, 0.060, 0.012, 0.008, 0.0095, 0.014, 0.018, dark); // rear notch
      this.setSightLine(g, [0, 0.060, 0.012], [0, 0.060, -0.31]);
      this.cyl(g, 0.006, 0.006, 0.045, 8, accentMat, 0.036, 0.008, -0.11, 0, Math.PI / 2); // safety/pin
      muzzle.position.set(0, 0.018, barrelZ - barrelLen * 0.5 - 0.014);
      port.position.set(0.038, 0.025, -0.105);
    } else if (k === 'SMG') {
      const pdw = def.id === 'vekp';
      this.box(g, 0.054, 0.067, 0.28, steel, 0, 0.004, -0.08);
      this.box(g, 0.049, 0.031, 0.205, poly, 0, -0.031, -0.055);
      this.box(g, 0.053, 0.055, pdw ? 0.15 : 0.18, poly, 0, 0.002, -0.285); // short ventilated handguard
      for (let i = 0; i < 4; i++) {
        const z = -0.235 - i * 0.036;
        this.box(g, 0.056, 0.009, 0.016, dark, 0, 0.029, z);
        this.box(g, 0.009, 0.016, 0.014, dark, 0.029, -0.008, z);
        this.box(g, 0.009, 0.016, 0.014, dark, -0.029, -0.008, z);
      }
      this.cyl(g, 0.011, 0.012, pdw ? 0.27 : 0.34, 10, dark, 0, 0.012, pdw ? -0.48 : -0.46, Math.PI / 2);
      this.cyl(g, 0.016, 0.016, 0.07, 10, steel, 0, 0.012, pdw ? -0.61 : -0.62, Math.PI / 2);
      const mag = new THREE.Group();
      this.box(mag, 0.038, 0.12, 0.058, poly, 0, 0, 0, 0.08);
      mag.position.set(0, -0.093, pdw ? 0.035 : -0.055);
      g.add(mag);
      g.userData.mag = mag;
      this.box(g, 0.044, 0.09, 0.052, grip, 0, -0.07, 0.038, 0.29); // pistol grip
      if (pdw) {
        this.box(g, 0.024, 0.04, 0.15, dark, 0, -0.008, 0.16); // side-folding brace
        this.box(g, 0.052, 0.03, 0.026, grip, 0, -0.012, 0.238);
      } else {
        this.cyl(g, 0.014, 0.014, 0.12, 10, dark, 0, 0, 0.13, Math.PI / 2);
        this.box(g, 0.047, 0.068, 0.18, poly, 0, -0.012, 0.19, -0.04);
        this.box(g, 0.051, 0.09, 0.032, grip, 0, -0.015, 0.28);
      }
      this.box(g, 0.018, 0.01, 0.32, dark, 0, 0.05, -0.15); // continuous top rail
      // Critical ADS fix: the old solid housing put its rear face over the screen
      // centre. Hollow hood + glass + red dot, front post folded below the line.
      const ln = this.reflex(g, ySight + 0.002, -0.10, 0.038, 0.016, 0.052, dark);
      this.box(g, 0.008, 0.016, 0.01, accentMat, 0, ySight - 0.012, -0.4); // folded front post
      this.setSightLine(g, ln[0], ln[1]);
      this.cyl(g, 0.006, 0.006, 0.055, 8, accentMat, 0.035, -0.008, -0.04, 0, Math.PI / 2); // selector
      muzzle.position.set(0, 0.012, pdw ? -0.624 : -0.64);
      port.position.set(0.035, 0.025, -0.10);
    } else if (k === 'HMG SUPPORT') {
      // Phase-14: HMG-9 SENTINEL — visibly the heaviest primary: box-mag fed,
      // thick quick-change barrel, bipod, no stock collapse.
      this.box(g, 0.062, 0.075, 0.36, steel, 0, 0.004, -0.10);      // deep receiver
      this.box(g, 0.056, 0.030, 0.24, poly, 0, -0.033, -0.085);     // feed tray / lower
      this.box(g, 0.058, 0.050, 0.24, poly, 0, -0.004, -0.335);     // full-length ventilated handguard
      for (let i = 0; i < 5; i++) {
        const z = -0.240 - i * 0.040;
        this.box(g, 0.060, 0.012, 0.018, dark, 0, 0.026, z);        // cooling slots
      }
      this.cyl(g, 0.017, 0.019, 0.40, 10, dark, 0, 0.012, -0.53, Math.PI / 2);  // heavy barrel
      this.cyl(g, 0.022, 0.022, 0.085, 10, steel, 0, 0.012, -0.72, Math.PI / 2); // heat-shrouded muzzle
      const drum = new THREE.Group();                                          // 60-rnd box drum
      this.box(drum, 0.05, 0.105, 0.075, dark, 0, 0, 0, 0.04);
      this.box(drum, 0.056, 0.02, 0.08, poly, 0, -0.055, 0.0);
      drum.position.set(0, -0.115, -0.085);
      g.add(drum);
      g.userData.mag = drum;
      this.box(g, 0.044, 0.088, 0.052, grip, 0, -0.072, 0.045, 0.28); // pistol grip
      this.box(g, 0.052, 0.075, 0.17, poly, 0, -0.014, 0.205, -0.05); // fixed shoulder stock
      this.box(g, 0.018, 0.012, 0.40, dark, 0, 0.052, -0.19);         // continuous top rail
      // Critical ADS fix: hollow battle optic (was a solid block on the sight line)
      const lnH = this.reflex(g, ySight + 0.002, -0.12, 0.036, 0.017, 0.056, dark, 0.006);
      this.setSightLine(g, lnH[0], lnH[1]);
      this.cyl(g, 0.008, 0.010, 0.09, 8, accentMat, 0.030, ySight, -0.135, Math.PI / 2);
      // bipod legs (folded pose, suggests the gun's planted-fire identity)
      this.cyl(g, 0.007, 0.005, 0.11, 6, dark, 0.040, -0.045, -0.40, 0, 0.5);
      this.cyl(g, 0.007, 0.005, 0.11, 6, dark, -0.040, -0.045, -0.40, 0, -0.5);
      muzzle.position.set(0, 0.012, -0.775);
      port.position.set(0.040, 0.028, -0.13);
    } else if (k === 'PRECISION RIFLE' || k === 'MARKSMAN RIFLE') {
      const long = k === 'PRECISION RIFLE';
      const barrelLen = long ? 0.74 : 0.58;
      const barrelZ = long ? -0.59 : -0.48;
      this.box(g, 0.064, 0.079, 0.39, steel, 0, 0.004, -0.11); // upper receiver
      this.box(g, 0.052, 0.034, 0.27, dark, 0, -0.037, -0.075); // lower receiver
      this.cyl(g, long ? 0.014 : 0.012, long ? 0.016 : 0.013, barrelLen, 12, dark, 0, 0.016, barrelZ, Math.PI / 2);
      this.cyl(g, long ? 0.022 : 0.016, long ? 0.022 : 0.016, long ? 0.16 : 0.055, 12, steel, 0, 0.016, barrelZ - barrelLen * 0.5, Math.PI / 2); // brake/suppressor
      // Critical ADS fix: open (see-through) tube, objective + ocular bells and a
      // cross reticle — the closed cylinder caps used to fill the sight picture.
      this.scopeTube(g, 0.021, long ? 0.28 : 0.22, dark, ySight, -0.18, -0.30);
      this.scopeTube(g, 0.027, 0.046, steel, ySight, -0.30, -0.30);
      this.scopeTube(g, 0.025, 0.04, steel, ySight, -0.055, -0.30);
      this.setSightLine(g, [0, ySight, -0.035], [0, ySight, -0.30]);
      this.box(g, 0.035, 0.038, 0.045, dark, 0, 0.045, -0.25); // scope saddle
      this.box(g, 0.035, 0.038, 0.045, dark, 0, 0.045, -0.105);
      this.box(g, 0.022, 0.025, 0.025, accentMat, 0.028, ySight, -0.18); // windage knob
      this.cyl(g, 0.013, 0.013, 0.034, 10, accentMat, 0, ySight + 0.032, -0.18); // elevation turret
      this.box(g, 0.04, 0.085, 0.13, poly, 0, -0.01, 0.15); // cheek-rest stock
      this.box(g, 0.05, 0.072, 0.17, poly, 0, -0.025, 0.24);
      this.box(g, 0.054, 0.11, 0.031, grip, 0, -0.015, 0.32);
      this.box(g, 0.043, 0.09, 0.052, grip, 0, -0.075, 0.035, 0.27);
      const mag = new THREE.Group();
      this.box(mag, 0.045, 0.12, 0.052, poly, 0, 0, 0, 0.2);
      mag.position.set(0, -0.086, -0.06);
      g.add(mag);
      g.userData.mag = mag; // detachable magazine
      this.box(g, 0.009, 0.05, 0.016, dark, -0.019, -0.073, -0.41, 0.35); // folded bipod leg
      this.box(g, 0.009, 0.05, 0.016, dark, 0.019, -0.073, -0.41, -0.35);
      this.box(g, 0.013, 0.01, 0.34, dark, 0, 0.048, -0.18); // optic rail
      muzzle.position.set(0, 0.016, barrelZ - barrelLen * 0.5 - (long ? 0.08 : 0.028));
      port.position.set(0.039, 0.02, -0.11);
    } else { // ASSAULT RIFLE — upper/lower receiver, gas system, rail and adjustable stock
      this.box(g, 0.062, 0.077, 0.35, steel, 0, 0.004, -0.10); // upper
      this.box(g, 0.052, 0.038, 0.245, dark, 0, -0.039, -0.07); // lower
      this.box(g, 0.054, 0.058, 0.25, poly, 0, 0.003, -0.335); // handguard
      this.cyl(g, 0.011, 0.013, 0.46, 12, dark, 0, 0.013, -0.455, Math.PI / 2);
      this.cyl(g, 0.017, 0.017, 0.07, 10, steel, 0, 0.027, -0.37, Math.PI / 2); // gas block
      this.cyl(g, 0.015, 0.015, 0.05, 10, dark, 0, 0.013, -0.70, Math.PI / 2); // compensator
      this.box(g, 0.018, 0.013, 0.39, dark, 0, 0.046, -0.19); // full top rail
      for (let i = 0; i < 5; i++) {
        const z = -0.245 - i * 0.044;
        this.box(g, 0.06, 0.008, 0.012, dark, 0, 0.018, z); // top vents
        this.box(g, 0.009, 0.018, 0.012, dark, 0.03, -0.001, z); // side slots
        this.box(g, 0.009, 0.018, 0.012, dark, -0.03, -0.001, z);
      }
      this.box(g, 0.045, 0.095, 0.055, grip, 0, -0.075, 0.04, 0.29);
      this.box(g, 0.012, 0.009, 0.062, dark, 0, -0.034, -0.025); // trigger guard
      this.box(g, 0.012, 0.035, 0.009, dark, 0, -0.02, -0.056);
      const mag = new THREE.Group();
      this.box(mag, 0.043, 0.125, 0.056, poly, 0, 0, 0, 0.12); // curved mag body
      this.box(mag, 0.043, 0.045, 0.058, dark, 0, -0.069, 0.014, 0.16); // mag floorplate
      mag.position.set(0, -0.086, -0.065);
      g.add(mag);
      g.userData.mag = mag;
      this.cyl(g, 0.014, 0.014, 0.12, 10, dark, 0, 0.002, 0.13, Math.PI / 2); // buffer tube
      this.box(g, 0.05, 0.068, 0.18, poly, 0, -0.012, 0.20, -0.04); // adjustable stock
      this.box(g, 0.052, 0.09, 0.028, grip, 0, -0.02, 0.285); // rubber buttpad
      // Critical ADS fix: hollow red-dot hood; folded BUIS stay below the line
      const lnR = this.reflex(g, ySight + 0.002, -0.11, 0.038, 0.016, 0.062, dark);
      this.box(g, 0.008, 0.016, 0.01, accentMat, 0, ySight - 0.012, -0.4); // folded front post
      this.box(g, 0.028, 0.012, 0.018, dark, 0, ySight - 0.016, 0.015); // folded rear aperture
      this.setSightLine(g, lnR[0], lnR[1]);
      this.cyl(g, 0.006, 0.006, 0.05, 8, accentMat, 0.036, -0.007, 0.03, 0, Math.PI / 2); // selector
      this.cyl(g, 0.006, 0.006, 0.05, 8, dark, 0, -0.005, -0.15, 0, Math.PI / 2); // receiver pin
      this.box(g, 0.046, 0.018, 0.07, dark, 0.037, 0.005, -0.105); // ejection cover
      muzzle.position.set(0, 0.013, -0.725);
      port.position.set(0.041, 0.018, -0.105);
    }
    g.userData.muzzle = muzzle;
    g.userData.port = port;
    g.userData.sight = sight;
    if (!g.userData.sightLine) this.setSightLine(g, [0, ySight, 0.0], [0, ySight, -0.4]);
    g.add(muzzle, port, sight);

    if (def.reloadStyle === 'shell') {
      const shellMat = accent(0x86623a);
      const shell = this.cyl(g, 0.009, 0.009, 0.064, 10, shellMat, 0, -0.09, 0.12, Math.PI / 2);
      shell.visible = false;
      shell.name = 'reload-shell';
      g.userData.reloadShell = shell;
    }
    return this.finalize(g);
  }

  /** Add a matched two-hand grip and clothed forearms to an in-view weapon. */
  static addHands(g, def) {
    const { glove, seam, sleeve, cuff } = VM_HAND_MATS;
    const sidearm = def.klass === 'SIDEARM';
    const supportAnchor = def.klass === 'SHOTGUN' ? [-0.025, -0.036, -0.30]
      : sidearm ? [-0.028, -0.058, 0.048] : [-0.018, -0.04, -0.28];
    const firingAnchor = sidearm ? [0.012, -0.065, 0.027] : [0.034, -0.065, 0.035];

    const makeHand = (anchor, end, side, name) => {
      const root = new THREE.Group();
      root.name = name;
      root.position.set(anchor[0], anchor[1], anchor[2]);
      const localEnd = [end[0] - anchor[0], end[1] - anchor[1], end[2] - anchor[2]];
      this.capsuleBetween(root, [0, 0, 0], localEnd, sidearm ? 0.046 : 0.054, sleeve, 8);
      const cuffCenter = [localEnd[0] * 0.15, localEnd[1] * 0.15, localEnd[2] * 0.15];
      this.ellipsoid(root, cuff, cuffCenter, [0.061, 0.052, 0.066]);
      this.ellipsoid(root, glove, [0, -0.006, 0.012], sidearm ? [0.045, 0.033, 0.058] : [0.051, 0.036, 0.063]);
      // Four articulated-looking fingers and a thumb; all glove parts are cached primitives.
      for (let i = 0; i < 4; i++) {
        const fx = (i - 1.5) * 0.019;
        this.ellipsoid(root, glove, [fx, -0.03, 0.046], [0.0115, 0.014, 0.04]);
        this.ellipsoid(root, seam, [fx, -0.018, 0.027], [0.007, 0.0055, 0.008]);
      }
      this.ellipsoid(root, glove, [side * 0.046, 0.001, 0.018], [0.015, 0.015, 0.041]);
      g.add(root);
      return root;
    };
    const firing = makeHand(firingAnchor, [firingAnchor[0] + 0.14, firingAnchor[1] - 0.29, firingAnchor[2] + 0.27], 1, 'viewmodel-firing-hand');
    const support = makeHand(supportAnchor, [supportAnchor[0] - 0.16, supportAnchor[1] - 0.27, supportAnchor[2] + 0.34], -1, 'viewmodel-support-hand');
    g.userData.firingHand = firing;
    g.userData.supportHand = support;
    g.userData.supportBase = { x: supportAnchor[0], y: supportAnchor[1], z: supportAnchor[2] };
    g.userData.supportOffsets = { x: -0.045, y: -0.105, z: 0.12 };
    return this.finalize(g);
  }

  static vx4() {
    const g = new THREE.Group();
    const steel = gunMetal(0x23262a);
    const dark = gunMetal(0x17191c, 0.5);
    const poly = polymer(0x31362c);
    const tan = accent(0x5c5a44);

    // receiver
    this.box(g, 0.062, 0.085, 0.34, steel, 0, 0, -0.10);
    // barrel + gas tube
    this.cyl(g, 0.011, 0.011, 0.34, 8, dark, 0, 0.012, -0.44, Math.PI / 2);
    this.cyl(g, 0.016, 0.016, 0.2, 8, steel, 0, 0.028, -0.36, Math.PI / 2);
    // handguard with slots
    this.box(g, 0.058, 0.062, 0.24, poly, 0, 0.002, -0.34);
    for (let i = 0; i < 4; i++) {
      this.box(g, 0.062, 0.01, 0.026, dark, 0, 0.02, -0.26 - i * 0.055);
    }
    // muzzle brake
    this.cyl(g, 0.015, 0.015, 0.05, 8, dark, 0, 0.012, -0.625, Math.PI / 2);
    // magazine (slight curve via two segments)
    const mag = new THREE.Group();
    this.box(mag, 0.04, 0.13, 0.075, poly, 0, -0.075, 0);
    this.box(mag, 0.04, 0.07, 0.075, poly, 0, -0.16, 0.022, 0.35);
    mag.position.set(0, -0.04, -0.12);
    g.add(mag);
    // pistol grip + trigger guard
    this.box(g, 0.04, 0.11, 0.055, poly, 0, -0.085, 0.02, 0.28);
    this.box(g, 0.02, 0.012, 0.07, dark, 0, -0.045, -0.02);
    // stock + buffer tube
    this.cyl(g, 0.016, 0.016, 0.12, 8, dark, 0, 0.005, 0.12, Math.PI / 2);
    this.box(g, 0.045, 0.09, 0.14, poly, 0, -0.005, 0.17);
    this.box(g, 0.05, 0.11, 0.03, tan, 0, -0.005, 0.245);
    // rail + iron sights (front post, rear aperture)
    this.box(g, 0.03, 0.012, 0.3, dark, 0, 0.048, -0.2);
    // Critical ADS fix: the old front-post top (0.077) and rear dot (0.068) were
    // not on one line and the rear "aperture" was a solid block. Now: a real
    // peep ring and a protected front post whose tip sits on the same line.
    const SL = 0.072;
    this.box(g, 0.005, 0.026, 0.008, dark, 0, SL - 0.013, -0.42);  // front post (tip on line)
    this.nightDot(g, SL - 0.0035, -0.4245);                          // tritium dot just under the tip
    this.box(g, 0.004, 0.03, 0.012, dark, -0.012, SL - 0.012, -0.42); // protective ears
    this.box(g, 0.004, 0.03, 0.012, dark, 0.012, SL - 0.012, -0.42);
    this.box(g, 0.03, 0.012, 0.016, dark, 0, SL - 0.026, -0.42);   // front sight base
    this.box(g, 0.03, 0.012, 0.02, dark, 0, SL - 0.018, 0.02);     // rear base
    this.peep(g, SL, 0.02, 0.009, 0.0045, 0.012, dark);            // rear aperture ring
    this.setSightLine(g, [0, SL, 0.02], [0, SL, -0.42]);
    // selector / pins
    this.cyl(g, 0.006, 0.006, 0.07, 6, tan, 0, -0.01, 0.05, 0, Math.PI / 2);
    const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.012, -0.66); g.add(muzzle);
    const port = new THREE.Object3D(); port.position.set(0.04, 0.02, -0.06); g.add(port);
    Object.assign(g.userData, { mag, muzzle, port });
    return this.finalize(g);
  }

  static mr7() {
    const g = new THREE.Group();
    const steel = gunMetal(0x1e2124, 0.36);
    const dark = gunMetal(0x14161a, 0.5);
    const wood = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.7, metalness: 0.05, depthTest: true });
    const tan = accent(0x6a6450);

    // long heavy barrel
    this.cyl(g, 0.013, 0.016, 0.62, 10, steel, 0, 0.01, -0.52, Math.PI / 2);
    this.cyl(g, 0.02, 0.02, 0.06, 10, dark, 0, 0.01, -0.85, Math.PI / 2); // brake
    // receiver
    this.box(g, 0.066, 0.08, 0.3, steel, 0, 0.005, -0.12);
    // scope: tube + objectives + turrets
    // Critical ADS fix: see-through scope (open tube + reticle + clear glass);
    // the closed caps and opaque objective disc used to block the sight picture.
    this.scopeTube(g, 0.021, 0.3, dark, 0.075, -0.16, -0.31);
    this.scopeTube(g, 0.027, 0.05, dark, 0.075, -0.32, -0.31);
    this.scopeTube(g, 0.026, 0.03, dark, 0.075, -0.015, -0.31);
    this.setSightLine(g, [0, 0.075, 0.0], [0, 0.075, -0.31]);
    this.cyl(g, 0.012, 0.012, 0.03, 8, tan, 0.03, 0.075, -0.16, 0, Math.PI / 2); // windage
    this.cyl(g, 0.012, 0.012, 0.03, 8, tan, 0, 0.105, -0.14);                    // elevation
    // scope mounts
    this.box(g, 0.03, 0.03, 0.04, dark, 0, 0.045, -0.24);
    this.box(g, 0.03, 0.03, 0.04, dark, 0, 0.045, -0.08);
    // iron sights (backup, low)
    this.box(g, 0.01, 0.018, 0.01, tan, 0, 0.05, -0.44);
    // stock (wooden, thumbhole vibe)
    this.box(g, 0.05, 0.085, 0.26, wood, 0, -0.01, 0.14);
    this.box(g, 0.05, 0.1, 0.05, wood, 0, -0.03, 0.03);
    this.box(g, 0.052, 0.12, 0.03, dark, 0, -0.01, 0.275); // buttpad
    // grip
    this.box(g, 0.04, 0.11, 0.05, wood, 0, -0.085, 0.02, 0.2);
    // magazine
    const mag = new THREE.Group();
    this.box(mag, 0.038, 0.1, 0.07, steel, 0, -0.06, 0);
    mag.position.set(0, -0.035, -0.14);
    g.add(mag);
    // bipod (folded)
    this.cyl(g, 0.007, 0.007, 0.09, 6, dark, -0.02, -0.035, -0.4, 0.5, 0.2);
    this.cyl(g, 0.007, 0.007, 0.09, 6, dark, 0.02, -0.035, -0.4, 0.5, -0.2);
    const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.01, -0.9); g.add(muzzle);
    const port = new THREE.Object3D(); port.position.set(0.04, 0.02, -0.08); g.add(port);
    Object.assign(g.userData, { mag, muzzle, port });
    return this.finalize(g);
  }

  static p9() {
    const g = new THREE.Group();
    const steel = gunMetal(0x202327, 0.38);
    const poly = polymer(0x2a2d28);
    const tan = accent(0x5c5a44);

    // slide
    this.box(g, 0.045, 0.05, 0.21, steel, 0, 0.028, -0.09);
    // serrations
    for (let i = 0; i < 4; i++) this.box(g, 0.047, 0.008, 0.008, poly, 0, 0.042, -0.02 - i * 0.014);
    // frame + grip
    this.box(g, 0.042, 0.035, 0.16, poly, 0, -0.005, -0.06);
    this.box(g, 0.042, 0.12, 0.055, poly, 0, -0.075, 0.015, 0.22);
    // trigger guard
    this.box(g, 0.012, 0.01, 0.05, poly, 0, -0.035, -0.035);
    this.box(g, 0.012, 0.035, 0.01, poly, 0, -0.02, -0.058);
    // barrel tip
    this.cyl(g, 0.009, 0.009, 0.02, 8, steel, 0, 0.015, -0.2, Math.PI / 2);
    // sights
    // Critical ADS fix: front blade inside a real rear notch, tops level (0.066)
    this.box(g, 0.005, 0.012, 0.008, tan, 0, 0.06, -0.185);
    this.nightDot(g, 0.0625, -0.1895);
    this.notch(g, 0.066, -0.005, 0.0075, 0.011, 0.012, 0.01, tan);
    this.setSightLine(g, [0, 0.066, -0.005], [0, 0.066, -0.185]);
    // magazine
    const mag = new THREE.Group();
    this.box(mag, 0.032, 0.1, 0.045, steel, 0, -0.06, 0);
    mag.position.set(0, -0.03, 0.01);
    mag.rotation.x = 0.22;
    g.add(mag);
    const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.015, -0.22); g.add(muzzle);
    const port = new THREE.Object3D(); port.position.set(0.035, 0.03, -0.05); g.add(port);
    Object.assign(g.userData, { mag, muzzle, port });
    return this.finalize(g);
  }

  static lb9() {
    const g = new THREE.Group();
    const steel = gunMetal(0x212529, 0.38);
    const dark = gunMetal(0x131518, 0.52);
    const chassis = gunMetal(0x2e352b, 0.45); // dark olive/gunmetal chassis matching image-1.png
    const grip = polymer(0x1a1c19);
    const accentMat = accent(0x565c4e);

    const yScope = 0.096;

    // Heavy fluted barrel & tactical muzzle brake
    this.cyl(g, 0.015, 0.018, 0.74, 12, dark, 0, 0.014, -0.56, Math.PI / 2);
    this.cyl(g, 0.024, 0.024, 0.09, 12, steel, 0, 0.014, -0.93, Math.PI / 2);

    // Receiver (olive green chassis)
    this.box(g, 0.072, 0.082, 0.42, chassis, 0, 0.006, -0.12);
    this.box(g, 0.058, 0.038, 0.28, dark, 0, -0.042, -0.08);

    // Stock & cheekrest (visible centered in lower foreground in image-1.png)
    this.box(g, 0.064, 0.088, 0.22, chassis, 0, -0.008, 0.16);
    this.box(g, 0.066, 0.115, 0.035, dark, 0, -0.01, 0.275);
    this.box(g, 0.044, 0.115, 0.055, grip, 0, -0.085, 0.03, 0.26);

    // Detachable magazine
    const mag = new THREE.Group();
    this.box(mag, 0.044, 0.12, 0.058, dark, 0, -0.08, 0, 0.18);
    mag.position.set(0, -0.03, -0.07);
    g.add(mag);

    // Continuous top rail & scope mount saddles
    this.box(g, 0.024, 0.014, 0.36, dark, 0, 0.052, -0.18);
    this.box(g, 0.038, 0.038, 0.042, dark, 0, yScope - 0.028, -0.26); // front ring mount
    this.box(g, 0.038, 0.038, 0.042, dark, 0, yScope - 0.028, -0.11); // rear ring mount

    // --- SCOPE TUBE (Picture-in-Sight 3D Optic directly matching image-1.png) ---
    // Outer tube housing (open-ended cylinders so light passes through unobstructed)
    const scopeMat = dark.clone(); scopeMat.side = THREE.DoubleSide;
    const steelMat = steel.clone(); steelMat.side = THREE.DoubleSide;

    const mainTube = new THREE.Mesh(new THREE.CylinderGeometry(0.037, 0.037, 0.28, 32, 1, true), scopeMat);
    mainTube.rotation.x = Math.PI / 2; mainTube.position.set(0, yScope, -0.19); g.add(mainTube);

    const objBell = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.037, 0.08, 32, 1, true), scopeMat);
    objBell.rotation.x = Math.PI / 2; objBell.position.set(0, yScope, -0.35); g.add(objBell);

    const ocuBell = new THREE.Mesh(new THREE.CylinderGeometry(0.039, 0.039, 0.06, 32, 1, true), steelMat);
    ocuBell.rotation.x = Math.PI / 2; ocuBell.position.set(0, yScope, -0.05); g.add(ocuBell);

    // Bezel rings (outer bevel & inner chamfer)
    const bezelMat = dark.clone(); bezelMat.side = THREE.DoubleSide;
    const bezelRing = new THREE.Mesh(new THREE.RingGeometry(0.034, 0.039, 32), bezelMat);
    bezelRing.position.set(0, yScope, -0.022);
    g.add(bezelRing);

    const innerBezel = new THREE.Mesh(new THREE.RingGeometry(0.031, 0.036, 32), bezelMat);
    innerBezel.position.set(0, yScope, -0.052);
    g.add(innerBezel);

    // Green optic reflex coating arcs (matching image-1.png top-left and top-right highlights)
    const reflexMat = new THREE.MeshBasicMaterial({ color: 0x1bf578, transparent: true, opacity: 0.92, depthTest: true, side: THREE.DoubleSide });
    const arcLeft = new THREE.Mesh(new THREE.RingGeometry(0.030, 0.0355, 24, 1, Math.PI * 0.52, Math.PI * 0.35), reflexMat);
    arcLeft.position.set(0, yScope, -0.065);
    g.add(arcLeft);

    const arcRight = new THREE.Mesh(new THREE.RingGeometry(0.030, 0.0355, 24, 1, Math.PI * 0.13, Math.PI * 0.35), reflexMat);
    arcRight.position.set(0, yScope, -0.065);
    g.add(arcRight);

    // Internal fine-line crosshair reticle (crossing at dead-center)
    const retMat = new THREE.MeshBasicMaterial({ color: 0x060606, depthTest: true });
    this.box(g, 0.072, 0.0007, 0.0005, retMat, 0, yScope, -0.22); // horizontal hair
    this.box(g, 0.0007, 0.072, 0.0005, retMat, 0, yScope, -0.22); // vertical hair

    // Clear optical lens
    const glass = new THREE.Mesh(VM_PLANE, sightGlass());
    glass.scale.set(0.072, 0.072, 1);
    glass.position.set(0, yScope, -0.222);
    g.add(glass);

    // Turrets (windage & elevation)
    this.cyl(g, 0.013, 0.013, 0.030, 10, accentMat, 0, yScope + 0.036, -0.19); // elevation
    this.cyl(g, 0.013, 0.013, 0.030, 10, accentMat, 0.036, yScope, -0.19, 0, 0, Math.PI / 2); // windage

    // Folded tactical bipod
    this.box(g, 0.009, 0.05, 0.016, dark, -0.019, -0.073, -0.41, 0.35);
    this.box(g, 0.009, 0.05, 0.016, dark, 0.019, -0.073, -0.41, -0.35);

    // Sight line aligns perfectly through scope axis
    this.setSightLine(g, [0, yScope, -0.04], [0, yScope, -0.32]);

    const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.014, -0.98); g.add(muzzle);
    const port = new THREE.Object3D(); port.position.set(0.042, 0.024, -0.10); g.add(port);
    Object.assign(g.userData, { mag, muzzle, port });
    return this.finalize(g);
  }
}

/** Build a compact world-space pickup model from the same original weapon vocabulary. */
export function buildPickupWeapon(weaponId) {
  const def = WEAPON_DEFS[weaponId];
  if (!def) return null;
  const model = ViewModelBuilder.generic(def);
  model.name = `pickup-${weaponId}`;
  const materialCopies = new Map();
  model.traverse(o => {
    if (!o.isMesh) return;
    const convert = (material) => {
      if (!materialCopies.has(material.uuid)) {
        const copy = material.clone();
        copy.depthTest = true;
        copy.depthWrite = true;
        materialCopies.set(material.uuid, copy);
      }
      return materialCopies.get(material.uuid);
    };
    o.material = Array.isArray(o.material) ? o.material.map(convert) : convert(o.material);
    o.renderOrder = 0;
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = true;
  });
  return model;
}

// ---------------------------------------------------------------------------
// Projectile (marksman rifle)
// ---------------------------------------------------------------------------
class Projectile {
  constructor(def, origin, dir, game) {
    this.def = def;
    this.game = game;
    this.pos = origin.clone();
    this.vel = dir.clone().multiplyScalar(def.projSpeed);
    this.life = def.projLife;
    this.dead = false;
    this.damageMult = 1;
    this.woodPenetrated = false;
    this._last = new THREE.Vector3();
  }

  update(dt) {
    const g = this.game;
    this.life -= dt;
    if (this.life <= 0) { this.dead = true; return; }

    this.vel.y -= this.def.projGravity * dt;
    this._last.copy(this.pos);
    this.pos.addScaledVector(this.vel, dt);

    const seg = _seg.copy(this.pos).sub(this._last);
    const segLen = seg.length();
    if (segLen < 0.0001) return;
    seg.divideScalar(segLen);

    // entities along the segment
    let bestT = segLen, bestHit = null, bestZone = null, bestEnemy = null, bestVehicle = null;

    for (const e of g.enemies.list) {
      if (!e.alive) continue;
      const d = rayAABBLocal(this._last, seg, e.box.min, e.box.max, bestT, _local);
      if (d !== null) {
        bestT = d; bestEnemy = e; bestHit = null;
        bestZone = zoneFromLocal(_local, e);
      }
    }
    if (g.vehicles && g.vehicles.list) {
      for (const vehicle of g.vehicles.list) {
        if (vehicle.hp <= 0) continue;
        const hit = vehicle.visibleHit(this._last, seg, bestT);
        if (hit && hit.dist < bestT) { bestT = hit.dist; bestVehicle = vehicle; bestHit = null; bestEnemy = null; }
      }
    }
    for (const t of g.world.rangeTargets) {
      const hit = t.rayTest(this._last, seg, bestT);
      if (hit) { bestT = hit.dist; bestHit = { target: t, zone: hit.zone }; bestEnemy = null; bestVehicle = null; }
    }

    const worldHit = g.physics.raycast(this._last, seg, bestT);
    if (worldHit) {
      bestT = worldHit.dist; bestEnemy = null; bestVehicle = null; bestHit = worldHit;
    }

    if (bestEnemy) {
      const point = _p1.copy(this._last).addScaledVector(seg, bestT);
      g.stats.hits++;
      if (bestZone === 'head') g.stats.headshots++;
      g.enemies.damage(bestEnemy, bestZone, this._damageAt(point.distanceTo(g.camera.position)) * this.damageMult, point, seg);
      this.dead = true;
    } else if (bestVehicle) {
      const point = _p1.copy(this._last).addScaledVector(seg, bestT);
      const damage = this._damageAt(point.distanceTo(g.camera.position)) * this.damageMult;
      g.stats.hits++;
      bestVehicle.damage(damage, g, point);
      if (g.ui && g.ui.hitMarker) g.ui.hitMarker(false);
      this.dead = true;
    } else if (bestHit && bestHit.target) {
      bestHit.target.hit();
      g.audio.wpnClick(1800, 0.4);
      g.particles.impact(_p1.copy(this._last).addScaledVector(seg, bestT), _n1.set(0, 0, 1), 'metal', 0.5);
      this.dead = true;
    } else if (bestHit && bestHit.collider) {
      const point = bestHit.point;
      const c = bestHit.collider;
      if (c.tag === 'shield' && g.shield) {
        const dmgS = this._damageAt(point.distanceTo(g.camera.position)) * this.damageMult * 0.6;
        g.shield.onHit(c, point, dmgS);
        g.onWorldImpact(point, bestHit.normal, 'metal', 1.0);
        this.dead = true;
        return;
      }
      if (c.breakable) {
        g.world.breakGlass(c);
        g.particles.glassBurst(point, bestHit.normal);
        g.audio.impact('glass', point);
        g.emitNoise(point, 30, 'glass');
        if ((this.def.penetration || 0) >= 0.18 && this.life > 0.05) {
          this.pos.copy(point).addScaledVector(seg, 0.05);
          this.vel.multiplyScalar(0.92);
          this.damageMult *= 0.85;
          return;
        }
      }
      if (c.material === 'wood' && !this.woodPenetrated && (this.def.penetration || 0) >= 0.72 && this.life > 0.05) {
        g.particles.impact(point, bestHit.normal, 'wood', 0.8);
        g.audio.impact('wood', point);
        this.pos.copy(point).addScaledVector(seg, 0.14);
        this.vel.multiplyScalar(0.78);
        this.damageMult *= 0.6;
        this.woodPenetrated = true;
        return;
      }
      g.onWorldImpact(point, bestHit.normal, c.material, 1.4);
      this.dead = true;
    }

    // tracer streak for the projectile itself
    g.particles.projectileTrail(this.pos, _n2.copy(this.vel).normalize());
  }

  _damageAt(dist) {
    const f = this.def.falloff;
    const k = dist <= f.near ? 1 : Math.max(f.min, 1 - (dist - f.near) / (f.far - f.near) * (1 - f.min));
    return this.def.damage * k;
  }
}

const _seg = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _n1 = new THREE.Vector3();
const _n2 = new THREE.Vector3();
const _oc = new THREE.Vector3();
const _local = { x: 0, y: 0, z: 0, dist: 0 };

/** Derive the hit zone from local hit coordinates relative to an enemy box. */
function zoneFromLocal(local, enemy) {
  const h = local.y; // height above feet
  const total = enemy.box.max.y - enemy.box.min.y;
  const rel = h / total;
  // lateral offset decides arms vs torso on the upper body
  const cx = (enemy.box.min.x + enemy.box.max.x) / 2;
  const cz = (enemy.box.min.z + enemy.box.max.z) / 2;
  const lateral = Math.max(Math.abs(local.x - cx), Math.abs(local.z - cz));
  if (rel > 0.84) return 'head';
  if (rel > 0.55) return lateral > 0.34 ? 'arms' : 'torso';
  if (rel > 0.42) return lateral > 0.3 ? 'arms' : 'torso';
  return 'legs';
}

// ---------------------------------------------------------------------------
// WeaponSystem
// ---------------------------------------------------------------------------
export class WeaponSystem {
  constructor(game) {
    this.game = game;
    this.defs = WEAPON_DEFS;

    // per-weapon runtime state
    this.state = {};
    for (const id of WEAPON_ORDER) {
      const def = WEAPON_DEFS[id];
      this.state[id] = {
        mag: def.magSize,
        reserve: def.startReserve,
        bloom: 0,
        heat: 0,
        malf: false,
        shotIdx: 0,
        fireMode: def.defaultFireMode || (def.auto ? 'auto' : 'semi'),
        burstRemaining: 0,
        // Ammunition audit: rounds charged by the accounting path. `shots` in
        // game.stats counts discharges; the two must stay equal, which is exactly
        // the one-shot-one-bullet rule the tests assert.
        roundsSpent: 0,
      };
    }

    // view model rig (attached to the camera)
    this.rig = new THREE.Group();
    this.models = {};
    const CUSTOM = {
      vx4: () => ViewModelBuilder.vx4(),
      mr7: () => ViewModelBuilder.mr7(),
      p9: () => ViewModelBuilder.p9(),
      lb9: () => ViewModelBuilder.lb9()
    };
    for (const id of WEAPON_ORDER) {
      const def = WEAPON_DEFS[id];
      this.models[id] = CUSTOM[id] ? CUSTOM[id]() : ViewModelBuilder.generic(def);
      ViewModelBuilder.addHands(this.models[id], def);
    }
    for (const m of Object.values(this.models)) {
      m.visible = false;
      this.rig.add(m);
    }
    this.owned = new Set(WEAPON_ORDER);   // narrowed by applyLoadout() per mission

    this.currentId = 'vx4';
    this.models[this.currentId].visible = true;

    // animation state
    this.adsT = 0;          // 0 hip → 1 sights
    this._adsToggled = false;   // Phase-14: settings.aimMode==='toggle' latch
    this._adsKeyLatch = false;  // Phase-15: dedicated keyboard toggle latch (default X)
    this._mouse2WasAds = false;
    this.sprintT = 0;
    this.state_ = 'ready';  // ready | reloading | stowing | drawing
    this.stateT = 0;
    this.stateDur = 0;
    this.pendingSelect = null;
    this.queuedSelect = null;
    this.nextShotAt = 0;
    this.triggerWasDown = false;
    this.triggerBlockedUntilRelease = false;
    this._shellReload = false; this._rackMalf = false;
    this.kickZ = 0; this.kickPitch = 0;
    this.pumpT = 0;
    this.swayX = 0; this.swayY = 0;
    this.swayVX = 0; this.swayVY = 0;
    this.bobT = 0;
    this.landDip = 0;
    this.projectiles = [];
    this.reloadEvents = [];   // {t, fired, fn}
    this.dryFireLatch = false;

    this.hipPos = new THREE.Vector3(0.13, -0.115, -0.28);
    this.hipRot = new THREE.Vector3(0, -0.05, 0);
    this._targetPos = new THREE.Vector3();
    this._targetRot = new THREE.Vector3();
    this._muzzleWorld = new THREE.Vector3();
    this._camDir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._shotDir = new THREE.Vector3();
    this._pelletDir = new THREE.Vector3();
  }

  get def() { return WEAPON_DEFS[this.currentId]; }
  get st() { return this.state[this.currentId]; }
  get model() { return this.models[this.currentId]; }
  get reloading() { return this.state_ === 'reloading'; }

  cycleFireMode() {
    const modes = this.def.fireModes || [this.def.auto ? 'auto' : 'semi'];
    if (modes.length < 2 || this.state_ !== 'ready') return false;
    const current = modes.indexOf(this.st.fireMode);
    this.st.fireMode = modes[(current + 1 + modes.length) % modes.length];
    this.st.burstRemaining = 0;
    this.game.ui.toastBrief('FIRE MODE: ' + this.st.fireMode.toUpperCase());
    return true;
  }

  /**
   * Whether a trigger event could be taken right now. Deliberately *not* an
   * ammunition check — the ammo gate lives in tryFire, which remains the only
   * place a round is charged. This exists so the input pipeline can queue a
   * click across a cadence window instead of silently discarding it.
   */
  canAcceptTriggerAt(now) {
    if (this.state_ !== 'ready') return false;
    if (this.triggerBlockedUntilRelease) return false;
    const player = this.game && this.game.player;
    if (player && typeof player.canFire === 'function' && !player.canFire()) return false;
    return now >= this.nextShotAt - 1e-6;
  }

  /**
   * A state that swallows a click outright rather than deferring it. The cadence
   * window defers (a real click, still owed a shot); a reload, a draw animation or
   * a blocked trigger discards it, so a click pressed while knocked down or while
   * the map is open cannot pay itself out afterwards.
   */
  triggerStateBusy() {
    if (this.state_ !== 'ready') return true;
    if (this.triggerBlockedUntilRelease) return true;
    const player = this.game && this.game.player;
    if (player && typeof player.canFire === 'function') return !player.canFire();
    return false;
  }

  blockTriggerUntilRelease() {
    this.triggerBlockedUntilRelease = true;
    this.triggerWasDown = !!(this.game.input && this.game.input.mouse0);
    if (this.st) this.st.burstRemaining = 0;
  }

  _restoreWeaponVisual(id) {
    const model = this.models[id];
    if (!model) return;
    const mag = model.userData.mag;
    if (mag) {
      mag.visible = true;
      if (mag.userData.baseY !== undefined) mag.position.y = mag.userData.baseY;
    }
    const shell = model.userData.reloadShell;
    if (shell) shell.visible = false;
    const pump = model.userData.pump;
    if (pump && pump.userData.baseZ !== undefined) pump.position.z = pump.userData.baseZ;
  }

  _queueShellReloadEvents() {
    this.reloadEvents.length = 0;
    const audio = this.game.audio;
    if (this._shellReloadStep === 0) this.reloadEvents.push({ t: 0.02, fired: false, fn: () => audio.wpnRaise(0) });
    this.reloadEvents.push({ t: this.stateDur * 0.52, fired: false, fn: () => audio.wpnMagIn(0) });
    this.reloadEvents.push({ t: this.stateDur * 0.82, fired: false, fn: () => audio.wpnClick(1250, 0.28) });
  }

  /** rank-earned cosmetic finish: tint the metalwork of every view model */
  applyFinish() {
    const f = this.game.progress.finish;
    for (const model of Object.values(this.models)) {
      model.traverse(o => {
        if (!o.isMesh || !o.material || o.material.metalness === undefined) return;
        if (o.userData._baseColor === undefined) o.userData._baseColor = o.material.color.getHex();
        if (o.material.metalness <= 0.5) return;
        if (f.color === null) o.material.color.setHex(o.userData._baseColor);
        else o.material.color.set(o.userData._baseColor).lerp(_finishColor.setHex(f.color), 0.55);
      });
    }
  }

  attachTo(camera) {
    camera.add(this.rig);
    // soft cool fill so the view model reads against dark interiors
    this.gunLight = new THREE.PointLight(0xcfe0f0, 1.15, 2.4, 2);
    this.gunLight.position.set(0.32, 0.24, -0.55);
    camera.add(this.gunLight);
  }

  reset(fullAmmo = false) {
    this.owned = new Set(WEAPON_ORDER);   // narrowed by applyLoadout() for missions
    for (const id of WEAPON_ORDER) {
      const def = WEAPON_DEFS[id];
      this.state[id].mag = def.magSize;
      this.state[id].reserve = fullAmmo ? def.reserveMax : def.startReserve;
      this.state[id].bloom = 0;
      this.state[id].heat = 0;
      this.state[id].malf = false;
      this.state[id].shotIdx = 0;
      this.state[id].fireMode = def.defaultFireMode || (def.auto ? 'auto' : 'semi');
      this.state[id].burstRemaining = 0;
      this._restoreWeaponVisual(id);
    }
    this.currentId = 'vx4';
    for (const m of Object.values(this.models)) m.visible = false;
    this.models.vx4.visible = true;
    this.adsT = 0; this._adsToggled = false; this._adsKeyLatch = false; this.sprintT = 0; this.pumpT = 0;
    this.state_ = 'ready';
    this.stateT = 0; this.stateDur = 0; this.pendingSelect = null; this.queuedSelect = null;
    this.nextShotAt = 0;
    this.reloadEvents.length = 0;
    this._shellReload = false; this._rackMalf = false;
    this.triggerWasDown = false; this.triggerBlockedUntilRelease = false;
    this.dryFireLatch = false;
    this.projectiles.length = 0;
    this.rig.position.copy(this.hipPos);
    this.rig.rotation.set(0, -0.05, 0);
  }

  /** Carry only the loadout weapons; everything else stays at zero until picked up. */
  applyLoadout(primaryId, secondaryId, fullAmmo = false) {
    const ids = [primaryId, secondaryId].filter(id => WEAPON_DEFS[id]);
    this.owned = new Set(ids);
    for (const id of WEAPON_ORDER) {
      const def = WEAPON_DEFS[id];
      const carry = ids.indexOf(id) >= 0;
      this.state[id].mag = carry ? def.magSize : 0;
      this.state[id].reserve = carry ? (fullAmmo ? def.reserveMax : def.startReserve) : 0;
      this.state[id].bloom = 0;
      this.state[id].heat = 0;
      this.state[id].malf = false;
      this.state[id].shotIdx = 0;
      this.state[id].fireMode = def.defaultFireMode || (def.auto ? 'auto' : 'semi');
      this.state[id].burstRemaining = 0;
      this._restoreWeaponVisual(id);
    }
    this.currentId = ids[0] || 'vx4';
    for (const m of Object.values(this.models)) m.visible = false;
    this.models[this.currentId].visible = true;
    this.adsT = 0;
    this._adsToggled = false;
    this._adsKeyLatch = false;
    this.state_ = 'ready';
    this.stateT = 0; this.stateDur = 0; this.pendingSelect = null; this.queuedSelect = null;
    this.nextShotAt = 0;
    this.reloadEvents.length = 0;
    this._shellReload = false; this._rackMalf = false;
    this.triggerWasDown = false; this.triggerBlockedUntilRelease = false;
    this.dryFireLatch = false;
  }

  /** After a checkpoint restore: re-derive carry from restored ammo state. */
  rebuildOwned() {
    this.owned = new Set();
    for (const id of WEAPON_ORDER) {
      const st = this.state[id];
      if (st && (st.mag > 0 || st.reserve > 0)) this.owned.add(id);
    }
    this.owned.add(this.currentId);
  }

  cancelForEquipment() {
    this.reloadEvents.length = 0;
    this._shellReload = false;
    this._rackMalf = false; // a malfunction remains on the weapon until rack-cleared
    this.pendingSelect = null;
    this.queuedSelect = null;
    // Phase-14 cancel matrix: switching to throwable/utility hands cancels ADS.
    // weapons.update() is not called while in hands mode, so without this the
    // ads pose + narrowed FOV would freeze, and an aimMode==='toggle' latch
    // would silently resume ADS on re-equip.
    this.adsT = 0;
    this._adsToggled = false;
    this._adsKeyLatch = false;
    if (this.game && this.game.setActiveFov) this.game.setActiveFov(this.game.settings.fov);
    this.state_ = 'ready';
    this.stateT = 0;
    this.stateDur = 0;
    this._restoreWeaponVisual(this.currentId);
    this.blockTriggerUntilRelease();
  }

  /** §21 slot limits: picking up `id` would displace the occupant of its slot. */
  isSlotFull(id) {
    const def = WEAPON_DEFS[id];
    if (!def) return false;
    return def.klass === 'SIDEARM' ? !!this.game.loadout.secondary : !!this.game.loadout.primary;
  }
  select(id) {
    if (!WEAPON_DEFS[id]) return;
    if (this.owned && !this.owned.has(id)) return;   // not carried — no ghost slots
    if (this.state_ === 'stowing') {
      this.blockTriggerUntilRelease();
      if (id === this.currentId) {
        this.pendingSelect = null;
        this.state_ = 'ready'; this.stateT = 0; this.stateDur = 0;
        this._restoreWeaponVisual(this.currentId);
      } else this.pendingSelect = id;
      return;
    }
    if (this.state_ === 'drawing') {
      this.blockTriggerUntilRelease();
      this.queuedSelect = id === this.currentId ? null : id;
      return;
    }
    if (id === this.currentId) return;
    this._restoreWeaponVisual(this.currentId);
    this.blockTriggerUntilRelease();
    this._shellReload = false;
    this.reloadEvents.length = 0;
    this.state_ = 'stowing';
    this.stateT = 0;
    this.stateDur = 0.22;
    this.pendingSelect = id;
    this.queuedSelect = null;
  }

  startReload(force = false) {
    const def = this.def;
    if (def.noReload) {
      // The VX-4 carries a single continuous 300-round supply. Never enter a
      // reload state (including from a queued R press or an old checkpoint).
      this._reloadQueuedUntil = 0;
      this.reloadEvents.length = 0;
      this._shellReload = false;
      this._rackMalf = false;
      if (this.state_ === 'reloading') {
        this.state_ = 'ready'; this.stateT = 0; this.stateDur = 0;
        this._restoreWeaponVisual(this.currentId);
      }
      if (this.game.ui && this.game.ui.toastBrief) {
        this.game.ui.toastBrief(this.st.mag + this.st.reserve > 0 ? 'VX-4: NO RELOAD REQUIRED' : 'AMMO DEPLETED — RESUPPLY UNAVAILABLE');
      }
      return false;
    }
    // Master upgrade P2: a reload pressed while the weapon is still being
    // drawn/stowed used to be silently dropped (felt like an unresponsive R).
    // It is now buffered and starts the moment the weapon is ready.
    if (this.state_ === 'drawing' || this.state_ === 'stowing') { this._reloadQueuedUntil = (this.game.time || 0) + 1.2; return; }
    if (this.state_ !== 'ready') return;
    this._reloadQueuedUntil = 0;
    const st = this.st;
    if (st.malf) {
      // Tap-rack clears the stoppage without changing ammunition.
      this.game.emitNoise(this.game.player.headPos || this.game.player.pos, 7, 'reload');
      const handling = this.game.player.handlingMultiplier();
      this.blockTriggerUntilRelease();
      this.reloadEvents.length = 0;
      this._shellReload = false;
      this.state_ = 'reloading';
      this.stateT = 0;
      this.stateDur = 1.15 * handling;
      this._rackMalf = true;
      this.malfLatch = false;
      const audio = this.game.audio;
      this.reloadEvents.push({ t: 0.05, fired: false, fn: () => audio.wpnClick(500, 0.5) });
      this.reloadEvents.push({ t: this.stateDur * 0.5, fired: false, fn: () => audio.wpnBolt(0) });
      this.reloadEvents.push({ t: this.stateDur * 0.85, fired: false, fn: () => audio.wpnClick(1900, 0.35) });
      return;
    }
    if (st.mag >= def.magSize) return;
    if (def.id === 'lb9' && st.freeAllowance != null && st.freeAllowance <= st.mag) {
      this.game.ui.toastBrief('SNIPER ALLOWANCE DEPLETED (NO EXTRA ROUNDS)');
      return;
    }
    if (st.reserve <= 0 && !force) {
      this.game.ui.toastBrief('NO RESERVE AMMO');
      return;
    }
    this.game.emitNoise(this.game.player.headPos || this.game.player.pos, 7, 'reload');
    const dry = st.mag === 0;
    const base = dry ? def.reload.dry : def.reload.tactical;
    // arm injuries slow reloads; Phase-14 specialist ADRENAL BURST speeds them up
    const handling = this.game.player.handlingMultiplier() * (this.game.characters ? this.game.characters.liveReloadMult() : 1);
    this.blockTriggerUntilRelease();
    this.reloadEvents.length = 0;
    this.state_ = 'reloading';
    this.stateT = 0;
    this.stateDur = base * handling;
    this.dryFireLatch = false;
    this._rackMalf = false;
    this._shellReload = def.reloadStyle === 'shell';

    if (this._shellReload) {
      this._shellReloadStep = 0;
      this._shellStepDuration = Math.max(0.2, def.reload.shellStep || 0.5) * handling;
      this.stateDur = this._shellStepDuration;
      this._queueShellReloadEvents();
      return;
    }

    // Detachable-magazine swap. Master upgrade P2: ammunition transfers exactly
    // once, at the event where the weapon is actually loaded — mag seated
    // (tactical, round already chambered) or bolt released (dry). The rest of
    // the timeline is recovery that a fresh trigger press may cut short.
    // Interrupting BEFORE the commit (switch/stow/death) changes no ammo.
    const audio = this.game.audio;
    this._reloadCommitted = false;
    this._reloadCommitAt = this.stateDur * (dry ? 0.8 : 0.6);
    const ev = [];
    ev.push({ t: 0.02, fn: () => audio.wpnRaise(0) });
    ev.push({ t: this.stateDur * 0.18, fn: () => audio.wpnMagOut(0) });
    ev.push({ t: this.stateDur * 0.55, fn: () => audio.wpnMagIn(0) });
    if (dry) ev.push({ t: this.stateDur * 0.78, fn: () => audio.wpnBolt(0) });
    ev.push({ t: this._reloadCommitAt, fn: () => this._commitReload() });
    ev.push({ t: this.stateDur * 0.92, fn: () => audio.wpnClick(1900, 0.35) });
    ev.forEach(e => this.reloadEvents.push({ t: e.t, fired: false, fn: e.fn }));
  }

  _finishReload() {
    const st = this.st, def = this.def;
    if (this._rackMalf) {
      this._rackMalf = false;
      st.malf = false;
      this.state_ = 'ready';
      this._shellReload = false;
      return;
    }
    this._commitReload();          // no-op if the mag-in event already committed
    this.state_ = 'ready';
    this._shellReload = false;
    this._reloadCommitted = false;
    const shell = this.model.userData.reloadShell;
    if (shell) shell.visible = false;
  }

  // ---------------------------------------------------------------------
  // Ammunition accounting. These two methods are the ONLY code allowed to
  // charge or credit a weapon, so a fired shot, a reload transfer, an armoury
  // pad and an ammunition pickup can never double-count or silently destroy
  // rounds. `tryFire` charges through spendRound(); nothing else does.
  // ---------------------------------------------------------------------

  /** Rounds this weapon could still accept, magazine first, then reserve. */
  roundsNeeded(id = this.currentId) {
    const def = (this.defs && this.defs[id]) || WEAPON_DEFS[id];
    const st = this.state[id];
    if (!def || !st) return 0;
    const magRoom = Math.max(0, def.magSize - st.mag);
    if (id === 'lb9' && st.freeAllowance != null) {
      return magRoom + Math.max(0, def.magSize + def.reserveMax - st.freeAllowance);
    }
    return magRoom + (def.noReload ? 0 : Math.max(0, def.reserveMax - st.reserve));
  }

  /** Charge exactly one round for one discharge. Returns false when there is
   * nothing to charge, so a failed shot can never consume ammunition. */
  spendRound(id = this.currentId) {
    const def = (this.defs && this.defs[id]) || WEAPON_DEFS[id];
    const st = this.state[id];
    if (!def || !st) return false;
    if (st.mag > 0) {
      st.mag--;
      st.roundsSpent = (st.roundsSpent | 0) + 1;
      return true;
    }
    // A saved/legacy continuous-feed load keeps rounds in `reserve`; drain it in
    // the same single-charge manner so the accounting stays 1:1 there too.
    if (def.noReload && st.reserve > 0) {
      st.reserve--;
      st.roundsSpent = (st.roundsSpent | 0) + 1;
      return true;
    }
    return false;
  }

  /** Credit rounds: magazine first, remainder into reserve, capped by the
   * weapon's own limits. `wasted` is what would not fit, so a caller can refuse
   * the pickup instead of destroying ammunition. */
  addRounds(id, n) {
    const def = (this.defs && this.defs[id]) || WEAPON_DEFS[id];
    const st = this.state[id];
    let left = Math.max(0, Math.floor(Number(n) || 0));
    if (!def || !st || left === 0) return { added: 0, toMag: 0, toReserve: 0, wasted: left };
    const toMag = Math.min(left, Math.max(0, def.magSize - st.mag));
    st.mag += toMag; left -= toMag;
    let toReserve = 0;
    if (left > 0) {
      if (id === 'lb9' && st.freeAllowance != null) {
        // the marksman allowance derives its reserve, so grow the pool and
        // re-derive it rather than breaking that invariant
        const room = Math.max(0, def.magSize + def.reserveMax - st.freeAllowance);
        toReserve = Math.min(left, room);
        st.freeAllowance += toReserve;
        st.reserve = Math.max(0, st.freeAllowance - st.mag);
        left -= toReserve;
      } else if (!def.noReload) {
        toReserve = Math.min(left, Math.max(0, def.reserveMax - st.reserve));
        st.reserve += toReserve; left -= toReserve;
      }
    }
    return { added: toMag + toReserve, toMag, toReserve, wasted: left };
  }

  /** Single ammunition transfer for a magazine reload (idempotent per reload). */
  _commitReload() {
    if (this._reloadCommitted) return;
    this._reloadCommitted = true;
    const st = this.st, def = this.def;
    if (def.id === 'lb9' && st.freeAllowance != null) {
      st.reserve = Math.max(0, st.freeAllowance - st.mag);
    }
    const need = Math.max(0, def.magSize - st.mag);
    const take = Math.min(need, Math.max(0, st.reserve));
    st.mag += take;
    st.reserve -= take;
  }

  _finishShellStep(overshoot = 0) {
    const st = this.st, def = this.def;
    if (st.mag < def.magSize && st.reserve > 0) {
      st.mag++;
      st.reserve--;
      this._shellReloadStep++;
    }
    if (st.mag >= def.magSize || st.reserve <= 0) {
      this.state_ = 'ready';
      this.stateT = 0;
      this._shellReload = false;
      this.reloadEvents.length = 0;
      const shell = this.model.userData.reloadShell;
      if (shell) shell.visible = false;
      return;
    }
    this.stateT = Math.max(0, overshoot);
    this.stateDur = this._shellStepDuration;
    this._queueShellReloadEvents();
  }

  tryFire(now, triggerDown) {
    const down = !!triggerDown;
    if (this.game.state !== 'playing') {
      this.triggerWasDown = false;
      this.triggerBlockedUntilRelease = true;
      for (const st of Object.values(this.state)) st.burstRemaining = 0;
      return;
    }

    const wasDown = this.triggerWasDown;
    const freshPress = down && !wasDown;
    this.triggerWasDown = down;
    if (!down) {
      this.triggerBlockedUntilRelease = false;
      this.dryFireLatch = false;
    } else if (this.triggerBlockedUntilRelease) {
      return;
    }

    const def = this.def, st = this.st;
    const player = this.game.player;
    // A knocked-down operator cannot shoot. The trigger is blocked until it is
    // released, so getting up with the button still held never turns into a
    // free burst, and a downed body never trades fire while on the floor.
    if (player && typeof player.canFire === 'function' && !player.canFire()) {
      st.burstRemaining = 0;
      this.triggerBlockedUntilRelease = true;
      return;
    }
    const validModes = def.fireModes || [def.auto ? 'auto' : 'semi'];
    const mode = validModes.includes(st.fireMode) ? st.fireMode : (def.defaultFireMode || 'semi');
    st.fireMode = mode;
    if (def.noReload && this.state_ === 'reloading') {
      // Defensive recovery for a stale/transient legacy state: continuous-feed
      // weapons are never held behind a reload animation.
      this.state_ = 'ready'; this.stateT = 0; this.stateDur = 0;
      this.reloadEvents.length = 0; this._shellReload = false; this._rackMalf = false;
      this._restoreWeaponVisual(this.currentId);
    }

    // Tube-fed weapons can be topped up shell-by-shell and interrupted as soon
    // as a round is available. Detachable-magazine reloads remain locked.
    if (this.state_ === 'reloading') {
      if (!this._shellReload && !this._rackMalf && this._reloadCommitted && freshPress && !player.sprinting) {
        // magazine seated + chambered: a fresh press skips the recovery tail
        this._finishReload();
        this.reloadEvents.length = 0;
        this.stateT = 0;
      } else if (this._shellReload && freshPress && st.mag > 0 && !player.sprinting) {
        this._shellReload = false;
        this.state_ = 'ready';
        this.stateT = 0;
        this.reloadEvents.length = 0;
        const shell = this.model.userData.reloadShell;
        if (shell) shell.visible = false;
      } else {
        return;
      }
    }
    if (this.state_ !== 'ready') {
      st.burstRemaining = 0;
      return;
    }

    // Semi requires a new press; burst arms a finite queue; auto repeats only
    // while held. A burst is deliberately allowed to finish after release.
    if (mode === 'burst' && freshPress && st.burstRemaining === 0) {
      st.burstRemaining = Math.max(1, def.burstCount || 3);
    }
    const burstActive = mode === 'burst' && st.burstRemaining > 0;
    const canFire = mode === 'auto' ? down : (mode === 'burst' ? burstActive : freshPress);
    if (!canFire) return;
    if (now < this.nextShotAt) return;

    if (def.noReload) st.malf = false; // the continuous VX-4 supply cannot jam into a dead state
    if (st.malf) {
      st.burstRemaining = 0;
      if (!this.malfLatch) {
        this.game.audio.wpnClick(320, 0.5); // dead click
        this.malfLatch = true;
        this.nextShotAt = now + 0.25;
      }
      return;
    }
    const ammoAvailable = Math.max(0, st.mag) + (def.noReload ? Math.max(0, st.reserve) : 0);
    if (ammoAvailable <= 0) {
      st.burstRemaining = 0;
      // Ordinary weapons may reload on a fresh press; the VX-4 has no reload
      // transition and remains ready, reporting an empty supply cleanly.
      if (!def.noReload && freshPress && st.reserve > 0) { this.startReload(); return; }
      if (!this.dryFireLatch) {
        this.game.audio.dryFire();
        this.dryFireLatch = true;
        this.nextShotAt = now + 0.3;
      }
      return;
    }

    if (def.id === 'lb9' && st.freeAllowance != null) {
      if (st.freeAllowance <= 0) {
        st.mag = 0;
        st.reserve = 0;
        if (!this.dryFireLatch) {
          this.game.audio.dryFire();
          this.dryFireLatch = true;
          this.nextShotAt = now + 0.3;
          this.game.ui.toastBrief('SNIPER ALLOWANCE EXHAUSTED (0/100 ROUNDS)');
        }
        return;
      }
      st.freeAllowance--;
      st.reserve = Math.max(0, st.freeAllowance - (st.mag - 1));
    }

    const shotInterval = mode === 'semi' ? (def.semiDelay || 60 / def.rpm) : 60 / def.rpm;
    // One discharge, one round, charged here and nowhere else. Nothing below
    // this line (projectile, hitscan, muzzle flash, sound, recoil, HUD) touches
    // ammunition, and if the charge fails the shot does not happen.
    if (!this.spendRound(def.id)) { st.burstRemaining = 0; return; }
    this.nextShotAt = now + shotInterval;
    if (mode === 'burst') st.burstRemaining = Math.max(0, st.burstRemaining - 1);
    if (this.model.userData.pump) this.pumpT = 0.18;
    this.dryFireLatch = false;
    this.game.stats.shots++;

    // --- shot direction: camera forward + dispersion cone ---
    const cam = this.game.camera;
    cam.getWorldDirection(this._camDir);
    const speed = player.speed;
    const moving = speed > 0.6;
    const s = def.spread;
    let spread = (this.adsT > 0.6 ? THREE.MathUtils.lerp(s.ads, s.adsMove, Math.min(1, speed / 2)) : THREE.MathUtils.lerp(s.hip, s.hipMove, Math.min(1, speed / 3.2)));
    spread += st.bloom;
    spread *= player.spreadMultiplier();
    if (!player.onGround) spread *= 2.4;

    this._right.set(1, 0, 0).applyQuaternion(cam.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spread;
    this._shotDir.copy(this._camDir)
      .addScaledVector(this._right, Math.cos(a) * r)
      .addScaledVector(this._up, Math.sin(a) * r)
      .normalize();

    // muzzle world position
    const muzzleObj = this.model.userData.muzzle;
    muzzleObj.getWorldPosition(this._muzzleWorld);

    // bloom + heat
    st.bloom = Math.min(s.bloomMax, st.bloom + s.bloomPerShot);
    st.heat = Math.min(20, st.heat + 1);
    // hot guns jam: rare when clean, more likely soaked in heat
    const jamChance = st.heat > 14 ? 0.02 : st.heat > 9 ? 0.006 : 0.002;
    if (!def.noReload && Math.random() < jamChance) st.malf = true;

    // recoil into the camera (player applies + recovers)
    const rec = def.recoil;
    st.shotIdx = (st.shotIdx || 0) + 1;
    const si = st.shotIdx;
    // signature curve: mild first round, strong early climb, settled group after
    const ramp = si <= 1 ? 0.72 : si <= 6 ? 0.95 + si * 0.05 : 0.9;
    const yawSig = Math.sin(si * (def.id === 'vx4' ? 1.9 : def.id === 'p9' ? 2.3 : 3.1))
      * (def.id === 'mr7' ? 0.25 : 0.8);
    player.addRecoil(
      rec.pitch * ramp * (0.92 + Math.random() * 0.16),
      rec.yaw * yawSig + (Math.random() - 0.5) * rec.yaw * 0.5
    );
    this.kickZ += rec.kickZ;
    this.kickPitch += rec.kickPitch;

    // the operator's body absorbs the shot too, not just the view model
    if (this.game.body && this.game.body.built) {
      this.game.body.addRecoil(THREE.MathUtils.clamp(rec.kickPitch / 0.22, 0.15, 1));
    }

    // audio + visuals
    this.game.addShake(def.shake != null ? def.shake : 0.045);
    this.game.audio.gunshot(def.sound, null);
    this.game.emitNoise(player.headPos, def.noiseRadius, 'gunshot');
    // Phase-14 ghost discipline: a live shot instantly breaks LOW SIGNATURE.
    if (this.game.characters) this.game.characters.onShoot();
    this.game.particles.muzzleFlash(this._muzzleWorld, this._shotDir, true, def.muzzleScale || 1);
    if (st.heat > 6) this.game.particles.gunSmoke(this._muzzleWorld, this._shotDir);
    this.game.audio.casingDrop(null, 0.28);
    this._ejectCasing();

    // simulation
    const isSniper = def.klass === 'PRECISION RIFLE' || def.id === 'lb9';
    // Observation zoom is optical only, but its shots must originate at the
    // camera/crosshair as ADS shots do; muzzle-origin rays caused close-range
    // parallax to miss the point the player was aiming at.
    const useAimRay = this.adsT > 0.5 || this.zoomT > 0.05 || isSniper;
    const shotOrigin = useAimRay ? cam.position.clone() : this._muzzleWorld.clone();

    if (def.pellets) {
      // shotgun: independent cone roll per pellet, hard range cap
      for (let i = 0; i < def.pellets; i++) {
        const ap = Math.random() * Math.PI * 2;
        const rp = Math.sqrt(Math.random()) * spread;
        this._pelletDir.copy(this._camDir)
          .addScaledVector(this._right, Math.cos(ap) * rp)
          .addScaledVector(this._up, Math.sin(ap) * rp)
          .normalize();
        this._hitscan(shotOrigin, this._pelletDir, def.pelletRange || 60);
      }
    } else if (def.projectile) {
      const p = new Projectile(def, shotOrigin, this._shotDir.clone(), this.game);
      this.projectiles.push(p);
    } else {
      this._hitscan(shotOrigin, this._shotDir, 300);
    }
  }

  _ejectCasing() {
    const cam = this.game.camera;
    const port = this.model.userData.port;
    port.getWorldPosition(_p1);
    _n1.set(1, 0.6, 0.2).applyQuaternion(cam.quaternion).multiplyScalar(1.6 + Math.random());
    this.game.particles.debris.spawn(_p1, _n1, this.def.casingSize || 0.018, _casingColor, 1.4, 16);
  }

  /**
   * Hitscan with glass penetration: rays pass through breakable panes
   * (shattering them) and keep going.
   */
  _hitscan(origin, dir, maxRange) {
    const g = this.game;
    this._penMult = 1;
    let from = origin;
    let remaining = maxRange;
    const finalPoint = _p1.copy(origin).addScaledVector(dir, maxRange);
    let woodPenetrated = false;

    // Each pass resolves the nearest candidate across entities, lamps, range
    // targets and world geometry. A wall always wins when it is nearer.
    for (let pass = 0; pass < 4 && remaining > 0.1; pass++) {
      let nearest = remaining;
      let hitKind = null;
      let bestEnemy = null, bestZone = null, bestTarget = null, bestShoot = null, bestVehicle = null;

      for (const e of g.enemies.list) {
        if (!e.alive) continue;
        const d = rayAABBLocal(from, dir, e.box.min, e.box.max, nearest, _local);
        if (d !== null && d < nearest) {
          nearest = d; hitKind = 'enemy'; bestEnemy = e; bestZone = zoneFromLocal(_local, e);
          bestTarget = null; bestShoot = null;
        }
      }
      if (g.vehicles && g.vehicles.list) {
        for (const vehicle of g.vehicles.list) {
          if (vehicle.hp <= 0) continue;
          const hit = vehicle.visibleHit(from, dir, nearest);
          if (hit && hit.dist < nearest) {
            nearest = hit.dist; hitKind = 'vehicle'; bestVehicle = vehicle;
            bestEnemy = null; bestTarget = null; bestShoot = null;
          }
        }
      }
      for (const target of g.world.rangeTargets) {
        const hit = target.rayTest(from, dir, nearest);
        if (hit && hit.dist < nearest) {
          nearest = hit.dist; hitKind = 'target'; bestTarget = target;
          bestEnemy = null; bestShoot = null; bestVehicle = null;
        }
      }
      for (const sh of g.world.shootables) {
        if (sh.dead) continue;
        _oc.copy(sh.pos).sub(from);
        const tca = _oc.dot(dir);
        if (tca < 0 || tca >= nearest) continue;
        const d2 = _oc.lengthSq() - tca * tca;
        if (d2 > sh.r * sh.r) continue;
        const d0 = tca - Math.sqrt(sh.r * sh.r - d2);
        if (d0 >= 0 && d0 < nearest) {
          nearest = d0; hitKind = 'shootable'; bestShoot = sh;
          bestEnemy = null; bestTarget = null; bestVehicle = null;
        }
      }

      const worldLimit = Math.min(remaining, nearest + 0.001);
      const worldHit = g.physics.raycast(from, dir, worldLimit);
      if (worldHit && worldHit.dist <= nearest) {
        const c = worldHit.collider;
        // Phase-14: barrier walls stop rounds and take the damage themselves
        if (c.tag === 'shield' && g.shield) {
          finalPoint.copy(worldHit.point);
          const dmgS = this._damageAt(this.def, worldHit.point.distanceTo(g.camera.position)) * this._penMult * 0.6;
          g.shield.onHit(c, worldHit.point, dmgS);
          g.onWorldImpact(worldHit.point, worldHit.normal, 'metal', 1.0);
          break;
        }
        if (c.breakable) {
          g.world.breakGlass(c);
          g.particles.glassBurst(worldHit.point, worldHit.normal);
          g.audio.impact('glass', worldHit.point);
          g.emitNoise(worldHit.point, 30, 'glass');
          if ((this.def.penetration || 0) >= 0.18 && pass < 3) {
            this._penMult *= 0.85;
            from = _p3.copy(worldHit.point).addScaledVector(dir, 0.06);
            remaining -= worldHit.dist + 0.06;
            continue;
          }
          finalPoint.copy(worldHit.point);
          break;
        }
        if (c.material === 'wood' && !woodPenetrated && (this.def.penetration || 0) >= 0.42 && pass < 3) {
          g.particles.impact(worldHit.point, worldHit.normal, 'wood', 0.8);
          g.audio.impact('wood', worldHit.point);
          this._penMult *= 0.6;
          woodPenetrated = true;
          from = _p3.copy(worldHit.point).addScaledVector(dir, 0.14);
          remaining -= worldHit.dist + 0.14;
          continue;
        }
        finalPoint.copy(worldHit.point);
        g.onWorldImpact(worldHit.point, worldHit.normal, c.material, 1.2);
        break;
      }

      if (hitKind === 'enemy' && bestEnemy) {
        const point = _p2.copy(from).addScaledVector(dir, nearest);
        const dmg = this._damageAt(this.def, point.distanceTo(g.camera.position)) * this._penMult;
        g.stats.hits++;
        if (bestZone === 'head') g.stats.headshots++;
        g.enemies.damage(bestEnemy, bestZone, dmg, point, dir);
        finalPoint.copy(point);
        break;
      }
      if (hitKind === 'vehicle' && bestVehicle) {
        const point = _p2.copy(from).addScaledVector(dir, nearest);
        const damage = this._damageAt(this.def, point.distanceTo(g.camera.position)) * this._penMult;
        g.stats.hits++;
        bestVehicle.damage(damage, g, point);
        if (g.ui && g.ui.hitMarker) g.ui.hitMarker(false);
        finalPoint.copy(point);
        break;
      }
      if (hitKind === 'target' && bestTarget) {
        const point = _p2.copy(from).addScaledVector(dir, nearest);
        bestTarget.hit();
        g.audio.wpnClick(1800, 0.4);
        g.particles.impact(point, _n1.copy(dir).negate(), 'metal', 0.6);
        finalPoint.copy(point);
        break;
      }
      if (hitKind === 'shootable' && bestShoot) {
        const point = _p2.copy(from).addScaledVector(dir, nearest);
        bestShoot.dead = true;
        bestShoot.light.userData.dead = true;
        bestShoot.light.intensity = 0;
        if (bestShoot.bulb) bestShoot.bulb.material = g.world.mat.burntBulb;
        g.particles.impact(point, _n1.copy(dir).negate(), 'metal', 1.4);
        g.audio.impact('metal', point, 1.4);
        g.audio.wpnClick(140, 0.6);
        g.emitNoise(point, 10, 'impact');
        from = _p3.copy(point).addScaledVector(dir, 0.06);
        remaining -= nearest + 0.06;
        continue;
      }
      break; // unobstructed to the range limit
    }

    g.particles.tracer(this._muzzleWorld, finalPoint);
  }

  _damageAt(def, dist) {
    const f = def.falloff;
    const k = dist <= f.near ? 1 : Math.max(f.min, 1 - (dist - f.near) / (f.far - f.near) * (1 - f.min));
    return def.damage * k;
  }

  // -------------------------------------------------------------------------
  update(dt, now, player) {
    const g = this.game;
    const def = this.def, st = this.st;

    // ---- breathing sway on the aimed camera ----
    // Phase 17: amplitude is now HARD-BOUNDED — fatigue / injury / suppression
    // stack grew unbounded before (≈0.85° under fire = a visibly wandering
    // sight picture). Resting breath stays subtle; stress raises it, but the
    // total multiplier is capped and suppression adds a SHORT pulse instead of
    // a sustained 4.5×.
    if (this.isAds() && g.state === 'playing') {
      const t = g.time;
      const fatigue = 1 + Math.min(1.6, (1 - player.stamina / 100) * 2.2) + (player.health < 40 ? 0.8 : 0);
      const stress = Math.min(2.6, fatigue * (player.armInjury > 0 ? 1.6 : 1) * (1 + Math.min(0.75, g.suppress || 0)));
      const amp = 0.00042 * stress;
      g.camera.rotation.x += Math.sin(t * 1.7) * amp + Math.sin(t * 3.9 + 1.7) * amp * 0.45;
      g.camera.rotation.y += Math.cos(t * 1.3 + 0.6) * amp * 0.6;
    }

    // ---- projectiles ----
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.update(dt);
      if (p.dead) this.projectiles.splice(i, 1);
    }

    // ---- bloom / heat recovery ----
    st.bloom = Math.max(0, st.bloom - def.spread.bloomRecover * dt);
    if (st.bloom <= 0.0001 && this.state_ === 'ready') st.shotIdx = 0;
    st.heat = Math.max(0, st.heat - dt * 1.4);

    // ---- state machine (reload / swap timelines) ----
    this.stateT += dt;
    if (this.state_ === 'reloading') {
      for (const ev of this.reloadEvents) {
        if (!ev.fired && this.stateT >= ev.t) { ev.fired = true; ev.fn(); }
      }
      if (this.stateT >= this.stateDur) {
        if (this._shellReload) {
          const overshoot = this.stateT - this.stateDur;
          this._finishShellStep(overshoot);
        } else {
          this._finishReload();
          this.reloadEvents.length = 0;
          this.stateT = 0;
        }
      }
    } else if (this.state_ === 'stowing') {
      if (this.stateT >= this.stateDur) {
        this.models[this.currentId].visible = false;
        this.currentId = this.pendingSelect || 'vx4';
        this.pendingSelect = null;
        this.state[this.currentId].burstRemaining = 0;
        this.models[this.currentId].visible = true;
        this.state_ = 'drawing';
        this.stateT = 0;
        const newDef = WEAPON_DEFS[this.currentId];
        this.stateDur = (0.42 / (newDef.handling || 1)) * player.handlingMultiplier();
        g.audio.wpnRaise();
      }
    } else if (this.state_ === 'drawing') {
      if (this.stateT >= this.stateDur) {
        this.state_ = 'ready'; this.stateT = 0; this.nextShotAt = now;
        const queued = this.queuedSelect;
        this.queuedSelect = null;
        if (queued && queued !== this.currentId) this.select(queued);
        else if (this._reloadQueuedUntil && (g.time || 0) <= this._reloadQueuedUntil) { this._reloadQueuedUntil = 0; this.startReload(); }
        else this._reloadQueuedUntil = 0;
      }
    }

    // ---- ADS ----
    // Hold is the default; Settings → AIM BUTTON MODE latches a tap so aim
    // holds without the button. Mobile (tbtn-ads) already honors the same
    // setting in touch.js — this block brings desktop mouse parity.
    const aimToggle = g.settings && g.settings.aimMode === 'toggle';
    // Phase 15: dedicated keyboard toggle (default X, remappable). The latch
    // is INDEPENDENT of the mouse: releasing right-mouse never clears it, and
    // it works identically alongside both AIM BUTTON MODE settings.
    if (g.input.adsToggleRequested) {
      g.input.adsToggleRequested = false;
      if (g.handsMode === 'gun' && g.state === 'playing') this._adsKeyLatch = !this._adsKeyLatch;
    }
    if (aimToggle && g.handsMode === 'gun') {
      if (g.input.mouse2 && !this._mouse2WasAds) this._adsToggled = !this._adsToggled;
    } else {
      this._adsToggled = false;
    }
    this._mouse2WasAds = g.input.mouse2;
    // A sprint REQUEST breaks every latched aim. Without this the hold-key is
    // never released in toggle mode, wantSprint would stay blocked by the ADS
    // gate in player.js, and the operator would be permanently aim-locked.
    if ((aimToggle && this._adsToggled || this._adsKeyLatch) && g.input.sprint && g.input.moveF > 0.2 && !player.crouching) {
      this._adsToggled = false; this._adsKeyLatch = false;
    }
    // going down takes the sights off: aim is re-acquired after the stand-up
    const upright = typeof player.canAct === 'function' ? player.canAct() : true;
    const wantsAds = ((aimToggle ? this._adsToggled : g.input.mouse2) || this._adsKeyLatch)
      && this.state_ === 'ready' && !player.sprinting && player.speed < 4.2 && g.handsMode === 'gun' && upright;
    // sprinting / leaving the gun / drawing always clears latched aim
    if (!wantsAds) { this._adsToggled = false; this._adsKeyLatch = false; }
    const adsSpeed = 1 / (def.adsTime * player.handlingMultiplier());
    this.adsT = THREE.MathUtils.clamp(this.adsT + (wantsAds ? adsSpeed : -adsSpeed * 1.3) * dt, 0, 1);
    // camera FOV — Master upgrade P3.
    // Optical magnification is applied with the true projection relation
    //   fov' = 2·atan(tan(fov/2) / m)
    // (not by dividing degrees), so ×2 really halves on-screen angular size.
    //  - ADS: each weapon's authored adsFov, scaled by the user's ADS
    //    MAGNIFICATION setting (0.8–1.3×) relative to the base FOV.
    //  - Observation zoom: a SEPARATE hold control (Y / middle mouse / touch
    //    ZM toggle), 1.5–4× (setting), eased in/out, cancelled by sprint,
    //    vehicles, death, pause and the map. It never alters weapon state, so
    //    firing/reloading/switching keep working while observing.
    // The FIELD OF VIEW setting stays the un-magnified base FOV.
    const baseFov = g.settings.fov;
    const D2R = Math.PI / 180;
    const magFov = (fov, m) => 2 * Math.atan(Math.tan(fov * D2R / 2) / m) / D2R;
    const adsMag = THREE.MathUtils.clamp(g.settings.adsMag != null ? g.settings.adsMag : 1, 0.8, 1.3);
    const weaponMag = Math.tan(baseFov * D2R / 2) / Math.tan(Math.min(def.adsFov, baseFov) * D2R / 2);
    const adsFovEff = THREE.MathUtils.clamp(magFov(baseFov, Math.max(1, weaponMag * adsMag)), 12, baseFov);
    let fov = THREE.MathUtils.lerp(baseFov, adsFovEff, this.easeInOut(this.adsT));
    const inp = g.input;
    // Sprint cancels observation zoom (including the Y toggle latch), so it
    // cannot silently spring back on when sprinting ends.
    if (player.sprinting || g.vehicleMode || !player.alive) {
      inp._zoomKey = false; inp._zoomMouse = false; inp._touchZoom = false;
    }
    const wantsZoom = !!(inp._zoomKey || inp._zoomMouse || inp._touchZoom) && !player.sprinting && !g.vehicleMode && player.alive;
    this.zoomT = THREE.MathUtils.clamp((this.zoomT || 0) + (wantsZoom ? dt / 0.2 : -dt / 0.16), 0, 1);
    const zoomMag = THREE.MathUtils.clamp(g.settings.zoomMag != null ? g.settings.zoomMag : 2, 1.25, 4);
    this.zoomFactor = 1 + (zoomMag - 1) * this.easeInOut(this.zoomT);
    if (this.zoomFactor > 1.0005) fov = Math.max(15, magFov(fov, this.zoomFactor));
    this.lookScale = Math.tan(fov * D2R / 2) / Math.tan(baseFov * D2R / 2);   // keeps aim speed proportional to view
    g.setActiveFov(fov);

    // ---- sprint pose ----
    const wantsSprint = player.sprinting && player.speed > 1.2;
    this.sprintT = THREE.MathUtils.clamp(this.sprintT + (wantsSprint ? 5 : -6) * dt, 0, 1);

    // ---- procedural pose target ----
    const model = this.model;
    // Critical ADS fix: SOLVE the sighted pose from the model's sight line.
    // Root cause of the misaligned sight picture: the old pose used a per-weapon
    // sightY constant (+0.008 fudge) that (a) did not match the modelled sights
    // (VX-4 rear dot 0.068 / front tip 0.077 vs sightY 0.055) and (b) ignored the
    // ADS presentation scale (~0.86), so the sights sat 2–3° off the screen
    // centre and the rear/front were not on one line. Here the rear sight point,
    // after the ADS scale and the levelling pitch, is placed exactly on the
    // camera axis, so camera centre = sight line = hitscan ray.
    const sl = model.userData.sightLine;
    const adsScaleT = def.adsScale != null ? def.adsScale : (def.klass === 'BATTLE RIFLE' || def.klass === 'SNIPER' ? 0.80 : 0.86);
    let adsPitch = 0;
    const adsPos = _adsPos.set(0, -def.sightY - 0.008, -0.335);
    if (sl) {
      // level the line (front vs rear height) so both sights coincide on-axis
      adsPitch = -Math.atan2(sl.front.y - sl.rear.y, sl.rear.z - sl.front.z);
      _slTmp.copy(sl.rear).applyAxisAngle(_slAxisX, adsPitch).multiplyScalar(adsScaleT);
      adsPos.set(-_slTmp.x, -_slTmp.y, -0.335);
    }
    this.adsPitch = adsPitch;
    const sprintPos = _sprintPos.set(0.02, -0.16, -0.24);
    const sprintRot = _sprintRot.set(0.28, -0.5, -0.42);

    const adsE = this.easeInOut(this.adsT);   // one curve for position AND rotation (no mid-transition kink)
    this._targetPos.copy(this.hipPos).lerp(adsPos, adsE);
    this._targetRot.set(
      THREE.MathUtils.lerp(this.hipRot.x, adsPitch, adsE),
      THREE.MathUtils.lerp(this.hipRot.y, 0, adsE),
      0
    );
    // sprint blend
    this._targetPos.lerp(sprintPos, this.sprintT);
    this._targetRot.lerp(sprintRot, this.sprintT);

    // reload pose: dip the weapon down-left and tilt; mag hand-off motion
    if (this.state_ === 'reloading') {
      const t = this.stateT / this.stateDur;
      const dip = Math.sin(Math.min(1, t) * Math.PI);        // down and back up
      const tilt = Math.sin(Math.min(1, t * 1.1) * Math.PI); // roll
      this._targetPos.x += -0.045 * dip * (1 - this.adsT * 0.5);
      this._targetPos.y += -0.075 * dip;
      this._targetPos.z += 0.05 * dip;
      this._targetRot.x += 0.42 * dip;
      this._targetRot.z += 0.4 * tilt;
      this._targetRot.y += -0.18 * dip;
      // magazine visual: drops out and comes back (models without a tagged
      // magazine — pistols, shotgun shells — simply skip this detail)
      const mag = model.userData.mag;
      if (mag) {
        const magDrop = t < 0.18 ? 0 : t < 0.32 ? (t - 0.18) / 0.14 : t < 0.5 ? 1 : t < 0.62 ? 1 - (t - 0.5) / 0.12 : 0;
        mag.position.y = mag.userData.baseY === undefined ? (mag.userData.baseY = mag.position.y) : mag.userData.baseY;
        mag.position.y = mag.userData.baseY - magDrop * 0.35;
        mag.visible = !(t > 0.2 && t < 0.5);
      }
    } else if (model.userData.mag) {
      model.userData.mag.visible = true;
      if (model.userData.mag.userData.baseY !== undefined) model.userData.mag.position.y = model.userData.mag.userData.baseY;
    }

    // The support hand leaves the fore-end for a short, controlled reload
    // reach; tube-fed weapons bring the visible shell to the loading port.
    const support = model.userData.supportHand;
    const supportBase = model.userData.supportBase;
    const reloadPhase = this.state_ === 'reloading'
      ? THREE.MathUtils.clamp(this.stateT / Math.max(0.001, this.stateDur), 0, 1) : 0;
    const reach = this.state_ === 'reloading' ? Math.sin(reloadPhase * Math.PI) : 0;
    if (support && supportBase) {
      support.position.set(
        supportBase.x - 0.04 * reach,
        supportBase.y - 0.065 * reach,
        supportBase.z + (def.klass === 'SIDEARM' ? 0.1 : def.reloadStyle === 'shell' ? 0.09 : 0.19) * reach
      );
    }
    const reloadShell = model.userData.reloadShell;
    if (reloadShell) {
      const shellT = this._shellReload && this.state_ === 'reloading' ? reloadPhase : 0;
      reloadShell.visible = shellT > 0.28 && shellT < 0.88;
      reloadShell.position.set(0.068 * (1 - shellT), -0.058 + 0.016 * shellT, -0.19);
    }
    this.pumpT = Math.max(0, this.pumpT - dt);
    const pump = model.userData.pump;
    if (pump && pump.userData.baseZ !== undefined) {
      const p = this.pumpT > 0 ? Math.sin((1 - this.pumpT / 0.18) * Math.PI) * 0.035 : 0;
      pump.position.z = pump.userData.baseZ + p;
    }
    // stow / draw dip
    if (this.state_ === 'stowing') {
      const t = Math.min(1, this.stateT / this.stateDur);
      this._targetPos.y -= 0.35 * t;
      this._targetRot.x += 0.5 * t;
    } else if (this.state_ === 'drawing') {
      const t = Math.min(1, this.stateT / this.stateDur);
      this._targetPos.y -= 0.35 * (1 - t);
      this._targetRot.x += 0.5 * (1 - t);
    }

    // ---- head bob + landing dip + sway spring ----
    const bob = player.weaponBob(); // {x,y} small offsets
    this._targetPos.x += bob.x * (1 - this.adsT * 0.85);
    this._targetPos.y += bob.y * (1 - this.adsT * 0.85);

    this.landDip = THREE.MathUtils.lerp(this.landDip, player.landImpulse, 1 - Math.exp(-14 * dt));
    this._targetPos.y -= this.landDip * 0.045;
    this._targetRot.x += this.landDip * 0.16;

    // look sway (weapon trails camera rotation)
    // A braced stance visibly settles the weapon, not just the crosshair.
    const stab = player.stabilityMultiplier ? player.stabilityMultiplier() : 1;
    const swayK = 26, swayD = 9;
    this.swayVX += (-player.lookDeltaX * 0.02 * swayK * stab - this.swayX * swayK - this.swayVX * swayD) * dt;
    this.swayVY += (-player.lookDeltaY * 0.02 * swayK * stab - this.swayY * swayK - this.swayVY * swayD) * dt;
    const swayCap = 0.06 * Math.max(0.35, stab);
    this.swayX = THREE.MathUtils.clamp(this.swayX + this.swayVX * dt, -swayCap, swayCap);
    this.swayY = THREE.MathUtils.clamp(this.swayY + this.swayVY * dt, -swayCap, swayCap);
    // Phase 17: the rotation terms had NOT been ADS-gated while the position
    // terms were (×(1−adsT·0.9)) — the weapon stayed pinned to the sight node
    // but kept swinging orientation through the sway spring at full aim, which
    // is the "gun keeps moving while aiming" bug. Gate both consistently.
    const swayGate = 1 - this.adsT * 0.9;
    this._targetPos.x += this.swayX * swayGate;
    this._targetPos.y += this.swayY * swayGate;
    this._targetRot.y += -this.swayX * 2.2 * swayGate;
    this._targetRot.z += this.swayX * 1.4 * swayGate;
    this._targetRot.x += this.swayY * 1.6 * swayGate;

    // ---- recoil kick spring on the view model ----
    const rec = def.recoil.recover;
    this.kickZ = THREE.MathUtils.lerp(this.kickZ, 0, 1 - Math.exp(-rec * dt));
    this.kickPitch = THREE.MathUtils.lerp(this.kickPitch, 0, 1 - Math.exp(-rec * dt));
    this._targetPos.z += this.kickZ;
    this._targetRot.x += this.kickPitch;

    // ---- smooth toward target (faster when ads for responsiveness) ----
    const k = this.adsT > 0.5 ? 16 : 11;
    const f = 1 - Math.exp(-k * dt);
    // Phase 15: subtle presentation shrink while aiming (~8–12% by class).
    // Phase 15 (pass 2): first visual pass (0.88/0.92) still left the receiver
    // dominating the frame — comparison shots are the authority. ~14% shrink
    // puts the sight picture center-frame without cartoon proportions.
    const adsScale = adsScaleT;
    const targetScale = 1 + (adsScale - 1) * this.easeInOut(this.adsT);
    this.rig.scale.x = THREE.MathUtils.lerp(this.rig.scale.x, targetScale, 1 - Math.exp(-16 * dt));
    this.rig.scale.y = this.rig.scale.z = this.rig.scale.x;
    this.rig.position.lerp(this._targetPos, f);
    this.rig.rotation.x = THREE.MathUtils.lerp(this.rig.rotation.x, this._targetRot.x, f);
    this.rig.rotation.y = THREE.MathUtils.lerp(this.rig.rotation.y, this._targetRot.y, f);
    this.rig.rotation.z = THREE.MathUtils.lerp(this.rig.rotation.z, this._targetRot.z, f);

    // idle breathing when nearly still — Phase 17: fades fully out while
    // sighted (the aimed camera already carries the subtle breath cue; a
    // second, rig-local oscillator fought the sight picture).
    const still = player.speed < 0.4 && this.state_ === 'ready' ? 1 : 0;
    this.bobT += dt;
    if (still > 0) {
      const brGate = 1 - Math.min(1, this.adsT * 1.3);
      const br = Math.sin(this.bobT * 1.4) * 0.0022 + Math.sin(this.bobT * 0.9) * 0.0015;
      this.rig.position.y += br * brGate;
      this.rig.rotation.z += Math.sin(this.bobT * 0.7) * 0.0016 * brGate;
    }

    // hide the whole rig while dead / menus
    this.rig.visible = g.state === 'playing';
  }

  /** Phase 15: one authoritative ADS cancel — clears every latched state. */
  /** Master upgrade P3: drop any observation zoom (map/menu/death/vehicle). */
  cancelZoom() {
    const inp = this.game.input;
    if (inp) { inp._touchZoom = false; inp._zoomMouse = false; inp._zoomKey = false; }
    this.zoomT = 0; this.zoomFactor = 1; this.lookScale = 1;
  }

  cancelAds() {
    this.adsT = 0;
    this._adsToggled = false;
    this._adsKeyLatch = false;
    if (this.game && this.game.input) this.game.input.adsToggleRequested = false;
  }

  easeInOut(t) { return t * t * (3 - 2 * t); }

  /** Crosshair spread in pixels-ish units for the HUD. */
  currentSpreadDegrees() {
    const def = this.def, st = this.st;
    const player = this.game.player;
    const s = def.spread;
    const speed = player.speed;
    let spread = (this.adsT > 0.6 ? THREE.MathUtils.lerp(s.ads, s.adsMove, Math.min(1, speed / 2)) : THREE.MathUtils.lerp(s.hip, s.hipMove, Math.min(1, speed / 3.2)));
    spread += st.bloom;
    spread *= player.spreadMultiplier();
    if (!player.onGround) spread *= 2.4;
    return spread / DEG;
  }

  isAds() { return this.adsT > 0.6; }
}

const _casingColor = new THREE.Color(0.72, 0.55, 0.3);
const _adsPos = new THREE.Vector3();
const _slTmp = new THREE.Vector3();
const _slAxisX = new THREE.Vector3(1, 0, 0);
const _sprintPos = new THREE.Vector3();
const _sprintRot = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();

const _finishColor = new THREE.Color();
