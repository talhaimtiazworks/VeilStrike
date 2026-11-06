/**
 * vehicles.js
 * Original fictional road vehicles and the HX-7 VANGUARD utility helicopter.
 * Shared procedural geometry/materials, swept AABB collision, surface-aware
 * handling, staged entry/exit, smoothed cameras, damage and distance-throttled
 * authored-route AI. No remote or copied vehicle assets.
 */
import * as THREE from 'three';
import { roundedBoxGeometry } from './geometry.js';
import {
  applyImpact, syncActorBody, unregisterActorBody,
  IMPACT_TUNE as TUNE, BODY_STATE, ejectFromHull,
} from './impacts.js';

const DEG = Math.PI / 180;
const _UP = new THREE.Vector3(0, 1, 0);
const _WORLD_FWD = new THREE.Vector3();
const _WORLD_RIGHT = new THREE.Vector3();
const _AABB_MIN = new THREE.Vector3();
const _AABB_MAX = new THREE.Vector3();
const _RAY_DIR = new THREE.Vector3();
const _CAM_DIR = new THREE.Vector3();
const _GROUND_TEST = new THREE.Vector3();
const _BOARD_FROM = new THREE.Vector3();
const _BOARD_DIR = new THREE.Vector3();

const makeDef = (id, name, kind, spec) => ({
  id, name, kind,
  wd: 2.0, hl: 2.35, h: 1.85, seatH: 1.2, mass: 1600,
  accel: 5.0, reverseAccel: 2.6, brake: 10.5, top: 30,
  steer: 1.85, steerAngle: 0.52, wheelbase: 2.8, track: 1.55,
    wheelR: 0.42, wheelW: 0.27, axles: [[-1.45, 0.95], [1.45, 0.95]],
  hp: 240, offRoad: 0.85, passengers: 4, armored: false,
  cargo: false, enginePitch: 1,
  hoodLength: 1.05, trunkLength: 0.5, cabinHeight: 0.8,
  vision: 48, drivetrain: 'rwd',
  ...spec,
});

/** Existing fictional vehicles retain their original lookup keys and names. */
export const VEHICLE_DEFS = Object.freeze({
  sedan: makeDef('sedan', 'CS-4 MERIDIAN', 'sedan', {
    wd: 1.88, hl: 2.38, h: 1.56, seatH: 1.08, mass: 1380,
    accel: 6.0, reverseAccel: 2.8, brake: 11.5, top: 34, steer: 2.2,
    wheelbase: 2.72, track: 1.54, wheelR: 0.34, hp: 185,
    offRoad: 0.48, passengers: 4, hoodLength: 1.0, trunkLength: 0.62, cabinHeight: 0.72,
  }),
  hatchback: makeDef('hatchback', 'CV-8 RUNNER', 'hatchback', {
    wd: 1.82, hl: 2.12, h: 1.62, seatH: 1.08, mass: 1190,
    accel: 6.3, reverseAccel: 2.8, brake: 11.2, top: 32, steer: 2.35,
    wheelbase: 2.52, track: 1.5, wheelR: 0.34, hp: 165,
    offRoad: 0.52, passengers: 4, hoodLength: 0.78, trunkLength: 0.28, cabinHeight: 0.79,
  }),
  suv: makeDef('suv', 'SV-2 SCOUT', 'suv', {
    wd: 2.0, hl: 2.3, h: 1.95, seatH: 1.27, mass: 1880,
    accel: 5.0, reverseAccel: 2.8, brake: 11.8, top: 32, steer: 1.95,
    wheelbase: 2.78, track: 1.68, wheelR: 0.43, hp: 270,
    offRoad: 1.12, drivetrain: '4wd', passengers: 5, cargo: true, hoodLength: 1.0, trunkLength: 0.46, cabinHeight: 0.91,
    enginePitch: 0.92,
  }),
  pickup: makeDef('pickup', 'GR-4 HAULER', 'pickup', {
    wd: 2.08, hl: 2.62, h: 1.95, seatH: 1.3, mass: 2160,
    accel: 4.9, reverseAccel: 2.6, brake: 11.5, top: 31, steer: 1.82,
    wheelbase: 3.12, track: 1.7, wheelR: 0.45, hp: 295,
    offRoad: 1.2, drivetrain: '4wd', passengers: 5, cargo: true, hoodLength: 1.1, trunkLength: 0.24, cabinHeight: 0.9, cabinLength: 2.25,
    enginePitch: 0.9,
  }),
  van: makeDef('van', 'MV-6 WAYFARER', 'van', {
    wd: 2.0, hl: 2.8, h: 2.3, seatH: 1.42, mass: 2480,
    accel: 4.0, reverseAccel: 2.2, brake: 10.8, top: 28, steer: 1.55,
    wheelbase: 3.25, track: 1.66, wheelR: 0.41, hp: 275,
    offRoad: 0.72, passengers: 8, cargo: true, hoodLength: 0.76, trunkLength: 0.2, cabinHeight: 1.2,
    enginePitch: 0.85,
  }),
  utility: makeDef('utility', 'UT-4 TRAILKEEPER', 'utility', {
    wd: 1.95, hl: 2.35, h: 1.92, seatH: 1.22, mass: 1720,
    accel: 5.2, reverseAccel: 2.8, brake: 11.7, top: 30, steer: 2.0,
    wheelbase: 2.8, track: 1.62, wheelR: 0.43, hp: 255,
    offRoad: 1.32, drivetrain: '4wd', passengers: 4, cargo: true, hoodLength: 0.96, trunkLength: 0.34, cabinHeight: 0.87,
  }),
  truck: makeDef('truck', 'UT-6 UTILITY', 'truck', {
    wd: 2.35, hl: 3.3, h: 2.62, seatH: 1.74, mass: 3600,
    accel: 3.8, reverseAccel: 1.9, brake: 10.0, top: 27, steer: 1.35,
    wheelbase: 4.3, track: 1.9, wheelR: 0.53, wheelW: 0.34, hp: 390,
    axles: [[-2.35, 1.1], [0, 1.1], [2.35, 1.1]], offRoad: 0.98, drivetrain: '6x6',
    passengers: 3, cargo: true, hoodLength: 1.06, trunkLength: 0.08, cabinHeight: 0.94, cabinLength: 2.35,
    enginePitch: 0.78,
  }),
  apc: makeDef('apc', 'AV-3 BULWARK', 'apc', {
    wd: 2.65, hl: 3.7, h: 2.72, seatH: 1.78, mass: 6850,
    accel: 3.15, reverseAccel: 1.75, brake: 9.5, top: 25, steer: 1.1,
    wheelbase: 4.35, track: 2.02, wheelR: 0.59, wheelW: 0.4, hp: 820,
    axles: [[-2.35, 1.24], [0, 1.24], [2.35, 1.24]], offRoad: 1.3, drivetrain: 'tracked',
    passengers: 8, armored: true, cargo: true, hoodLength: 0.9, trunkLength: 0.5, cabinHeight: 1.15,
    enginePitch: 0.7,
  }),
  buggy: makeDef('buggy', 'TCV-9 JACKAL', 'buggy', {
    wd: 1.92, hl: 2.17, h: 1.72, seatH: 1.08, mass: 1060,
    accel: 7.0, reverseAccel: 3.2, brake: 11.6, top: 39, steer: 2.55,
    wheelbase: 2.55, track: 1.62, wheelR: 0.48, wheelW: 0.34, hp: 205,
    offRoad: 1.48, drivetrain: '4wd', passengers: 2, cargo: false, hoodLength: 0.55, trunkLength: 0.3, cabinHeight: 0.56,
    enginePitch: 1.18,
  }),
  armored_suv: makeDef('armored_suv', 'VX-11 WARDEN', 'armored', {
    wd: 2.2, hl: 2.62, h: 2.05, seatH: 1.33, mass: 3100,
    accel: 4.2, reverseAccel: 2.2, brake: 10.8, top: 29, steer: 1.6,
    wheelbase: 3.06, track: 1.86, wheelR: 0.48, hp: 535,
    offRoad: 1.12, drivetrain: '4wd', passengers: 5, armored: true, cargo: true,
    hoodLength: 1.12, trunkLength: 0.38, cabinHeight: 0.91, enginePitch: 0.8,
  }),
  carrier: makeDef('carrier', 'PC-12 WAYPOINT', 'carrier', {
    wd: 2.62, hl: 3.95, h: 2.72, seatH: 1.78, mass: 7600,
    accel: 2.9, reverseAccel: 1.6, brake: 9.4, top: 23, steer: 0.98,
    wheelbase: 4.9, track: 2.0, wheelR: 0.57, wheelW: 0.39, hp: 920,
    axles: [[-2.6, 1.21], [-0.92, 1.21], [0.92, 1.21], [2.6, 1.21]],
    offRoad: 1.18, drivetrain: 'tracked', passengers: 10, armored: true, cargo: true,
    hoodLength: 0.82, trunkLength: 0.24, cabinHeight: 1.14, cabinLength: 2.6, enginePitch: 0.68,
  }),
  cargo_truck: makeDef('cargo_truck', 'CT-8 LONGHAUL', 'cargo', {
    wd: 2.45, hl: 4.05, h: 3.0, seatH: 1.83, mass: 8200,
    accel: 2.65, reverseAccel: 1.35, brake: 9.2, top: 24, steer: 0.92,
    wheelbase: 5.3, track: 1.98, wheelR: 0.55, wheelW: 0.36, hp: 520,
    axles: [[-2.85, 1.14], [-1.05, 1.14], [1.55, 1.14], [3.0, 1.14]],
    offRoad: 0.58, passengers: 3, cargo: true, hoodLength: 1.05, trunkLength: 0.08, cabinHeight: 1.0, cabinLength: 2.55,
    enginePitch: 0.64,
  }),
  service: makeDef('service', 'FS-4 FIELD SERVICE', 'service', {
    wd: 2.25, hl: 3.05, h: 2.54, seatH: 1.68, mass: 3900,
    accel: 3.5, reverseAccel: 1.9, brake: 10.2, top: 27, steer: 1.42,
    wheelbase: 3.8, track: 1.86, wheelR: 0.49, hp: 365,
    axles: [[-2.0, 1.05], [1.75, 1.05]], offRoad: 0.93, drivetrain: '4wd', passengers: 3, cargo: true,
    hoodLength: 0.94, trunkLength: 0.12, cabinHeight: 0.94, cabinLength: 2.35, enginePitch: 0.75,
  }),
  rescue: makeDef('rescue', 'RV-6 RESCUE', 'rescue', {
    wd: 2.15, hl: 2.92, h: 2.45, seatH: 1.58, mass: 2860,
    accel: 4.65, reverseAccel: 2.5, brake: 12, top: 34, steer: 1.75,
    wheelbase: 3.55, track: 1.78, wheelR: 0.43, hp: 310,
    offRoad: 0.78, drivetrain: 'awd', passengers: 6, cargo: true, hoodLength: 0.78, trunkLength: 0.1,
    cabinHeight: 1.14, emergency: true, enginePitch: 0.88,
  }),
  tactical_pickup: makeDef('tactical_pickup', 'TP-5 RIDGEBACK', 'tactical-pickup', {
    wd: 2.12, hl: 2.72, h: 2.05, seatH: 1.34, mass: 2320,
    accel: 5.1, reverseAccel: 2.65, brake: 11.4, top: 33, steer: 1.78,
    wheelbase: 3.18, track: 1.74, wheelR: 0.46, hp: 360,
    offRoad: 1.42, drivetrain: '4wd', passengers: 5, cargo: true, hoodLength: 1.12, trunkLength: 0.23,
    cabinHeight: 0.94, cabinLength: 2.35, rack: true, enginePitch: 0.92,
  }),
});

export const HELI_DEF = Object.freeze({
  id: 'hx7', name: 'HX-7 VANGUARD', kind: 'helicopter', isHelicopter: true,
  wd: 3.8, hl: 4.45, h: 3.85, seatH: 1.92, mass: 3250,
  hp: 430, top: 43, maxSpeed: 43, camDist: 11.5, camH: 4.1,
  passengers: 6, armored: false, enginePitch: 1.25,
  accel: 6.2, yawRate: 1.12,
});

function makeMats(manager) {
  const material = (key, make) => manager.material(key, make);
  return {
    paint: (color) => material('paint_' + color, () => new THREE.MeshStandardMaterial({
      color, roughness: 0.6, metalness: 0.28,
    })),
    edge: material('vehicle_edge', () => new THREE.MeshStandardMaterial({ color: 0x202522, roughness: 0.76, metalness: 0.38 })),
    trim: material('vehicle_trim', () => new THREE.MeshStandardMaterial({ color: 0x171c1d, roughness: 0.84, metalness: 0.16 })),
    rubber: material('vehicle_rubber', () => new THREE.MeshStandardMaterial({ color: 0x111315, roughness: 0.98, metalness: 0.0 })),
    tread: material('vehicle_tread', () => new THREE.MeshStandardMaterial({ color: 0x1a1c1d, roughness: 0.99, metalness: 0.0 })),
    rim: material('vehicle_rim', () => new THREE.MeshStandardMaterial({ color: 0x68706c, roughness: 0.55, metalness: 0.74 })),
    glass: material('vehicle_glass', () => new THREE.MeshStandardMaterial({
      color: 0x648190, roughness: 0.2, metalness: 0.12, transparent: true, opacity: 0.42,
      side: THREE.DoubleSide, depthWrite: false,
    })),
    glassArmored: material('vehicle_glass_armored', () => new THREE.MeshStandardMaterial({
      color: 0x435964, roughness: 0.28, metalness: 0.2, transparent: true, opacity: 0.62,
      side: THREE.DoubleSide, depthWrite: false,
    })),
    headOff: material('vehicle_head_off', () => new THREE.MeshStandardMaterial({ color: 0x675f4a, emissive: 0x1a160e, emissiveIntensity: 0.16, roughness: 0.32, metalness: 0.12 })),
    headOn: material('vehicle_head_on', () => new THREE.MeshStandardMaterial({ color: 0xffeac4, emissive: 0xffdf9c, emissiveIntensity: 2.3, roughness: 0.25, metalness: 0.05 })),
    tailOff: material('vehicle_tail_off', () => new THREE.MeshStandardMaterial({ color: 0x451811, emissive: 0x270b06, emissiveIntensity: 0.3, roughness: 0.4 })),
    tailOn: material('vehicle_tail_on', () => new THREE.MeshStandardMaterial({ color: 0xff4b35, emissive: 0xe52212, emissiveIntensity: 1.75, roughness: 0.4 })),
    brakeOn: material('vehicle_brake_on', () => new THREE.MeshStandardMaterial({ color: 0xff4f3d, emissive: 0xff1f10, emissiveIntensity: 2.5, roughness: 0.38 })),
    indicatorOff: material('vehicle_indicator_off', () => new THREE.MeshStandardMaterial({ color: 0x805127, emissive: 0x221008, emissiveIntensity: 0.15, roughness: 0.55 })),
    indicatorOn: material('vehicle_indicator_on', () => new THREE.MeshStandardMaterial({ color: 0xffae48, emissive: 0xff8a24, emissiveIntensity: 1.9, roughness: 0.45 })),
    cabin: material('vehicle_cabin', () => new THREE.MeshStandardMaterial({ color: 0x252b29, roughness: 0.94, metalness: 0.02 })),
    seat: material('vehicle_seat', () => new THREE.MeshStandardMaterial({ color: 0x343936, roughness: 0.93, metalness: 0.03 })),
    instrument: material('vehicle_instruments', () => new THREE.MeshStandardMaterial({ color: 0x16241f, emissive: 0x2e956c, emissiveIntensity: 0.85, roughness: 0.5 })),
    scuff: material('vehicle_scuff', () => new THREE.MeshStandardMaterial({ color: 0x292b28, roughness: 0.95, metalness: 0.08, transparent: true, opacity: 0.7 })),
    rotorBlur: material('heli_rotor_blur', () => new THREE.MeshBasicMaterial({ color: 0x26302f, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })),
    rotor: material('heli_rotor', () => new THREE.MeshStandardMaterial({ color: 0x1f2524, roughness: 0.7, metalness: 0.24 })),
    helilight: material('heli_light', () => new THREE.MeshStandardMaterial({ color: 0xd8e5e4, emissive: 0x9fcac6, emissiveIntensity: 1.8, roughness: 0.34 })),
  };
}

function boxMesh(parent, manager, mat, size, pos, opts = {}) {
  const mesh = new THREE.Mesh(manager.geometry('rounded-box', () => roundedBoxGeometry(4, 0.1)), mat);
  mesh.scale.set(size[0], size[1], size[2]);
  mesh.position.set(pos[0], pos[1], pos[2]);
  if (opts.rotation) mesh.rotation.set(opts.rotation[0], opts.rotation[1], opts.rotation[2]);
  mesh.castShadow = opts.cast !== false;
  mesh.receiveShadow = opts.receive !== false;
  if (opts.name) mesh.name = opts.name;
  parent.add(mesh);
  return mesh;
}

function planeMesh(parent, manager, mat, width, height, pos, rotation = [0, 0, 0], name = '') {
  const geoKey = `plane_${width.toFixed(2)}_${height.toFixed(2)}`;
  const mesh = new THREE.Mesh(manager.geometry(geoKey, () => new THREE.PlaneGeometry(width, height)), mat);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  if (name) mesh.name = name;
  parent.add(mesh);
  return mesh;
}

function cylinderMesh(parent, manager, mat, radiusTop, radiusBottom, height, segments, pos, rotation = [0, 0, 0], name = '') {
  const key = `cyl_${radiusTop.toFixed(3)}_${radiusBottom.toFixed(3)}_${height.toFixed(3)}_${segments}`;
  const mesh = new THREE.Mesh(manager.geometry(key, () => new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments)), mat);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (name) mesh.name = name;
  parent.add(mesh);
  return mesh;
}

function sphereMesh(parent, manager, mat, scale, pos, name = '') {
  const mesh = new THREE.Mesh(manager.geometry('sphere16', () => new THREE.SphereGeometry(1, 16, 12)), mat);
  mesh.scale.set(scale[0], scale[1], scale[2]);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (name) mesh.name = name;
  parent.add(mesh);
  return mesh;
}

function buildBody(def, mats, color, manager) {
  const root = new THREE.Group();
  root.name = 'vehicle-' + def.id;
  const paint = mats.paint(color);
  const windowMat = def.armored ? mats.glassArmored : mats.glass;
  const doors = [];
  const wheels = [];
  const windows = [];
  const headlights = [];
  const tailLights = [];
  const brakeLights = [];
  const indicators = [];
  const beams = [];
  const details = new THREE.Group();
  details.name = 'vehicle-lod-details';
  root.add(details);
  const B = (mat, size, pos, opts) => boxMesh(root, manager, mat, size, pos, opts);
  const D = (mat, size, pos, opts) => boxMesh(details, manager, mat, size, pos, opts);
  const wd = def.wd, hl = def.hl, front = -hl, rear = hl;
  const bodyLow = def.kind === 'buggy' ? 0.53 : 0.62;
  const cabW = wd * (def.armored ? 0.79 : 0.84);
  const cabFront = front + def.hoodLength;
  const defaultCabLength = rear - def.trunkLength - cabFront;
  const cabLength = Math.max(0.85, Math.min(def.cabinLength || defaultCabLength, rear - cabFront - 0.08));
  const cabRear = cabFront + cabLength;
  const cabZ = (cabFront + cabRear) * 0.5;
  const cabHeight = def.cabinHeight;

  // Low, continuous chassis and multi-piece shoulder line keep the silhouette
  // recognisably automotive instead of reading as a single rectangular block.
  B(mats.trim, [wd * 0.88, 0.22, hl * 2 - 0.08], [0, 0.42, 0]);
  B(paint, [wd, 0.43, hl * 2 - 0.16], [0, bodyLow, 0]);
  B(paint, [wd * 0.96, 0.2, Math.max(0.48, def.hoodLength * 1.85)], [0, 0.88, front + def.hoodLength * 0.87]);
  B(paint, [wd * 0.94, 0.2, Math.max(0.36, def.trunkLength * 1.7)], [0, 0.86, rear - def.trunkLength * 0.83]);

  if (def.kind === 'pickup' || def.kind === 'tactical-pickup') {
    const bedLen = Math.max(0.75, rear - cabRear - 0.1);
    B(mats.edge, [wd * 0.8, 0.08, bedLen], [0, 0.74, (cabRear + rear) * 0.5]);
    for (const side of [-1, 1]) {
      B(paint, [0.12, 0.42, bedLen], [side * (wd * 0.44), 0.91, (cabRear + rear) * 0.5]);
      B(mats.edge, [0.14, 0.06, bedLen], [side * (wd * 0.44), 1.14, (cabRear + rear) * 0.5]);
    }
    B(paint, [wd * 0.88, 0.38, 0.12], [0, 0.91, rear - 0.05]);
    if (def.kind === 'tactical-pickup') {
      B(mats.edge, [wd * 0.65, 0.22, bedLen * 0.72], [0, 1.02, (cabRear + rear) * 0.5]);
      for (const x of [-wd * 0.31, wd * 0.31]) cylinderMesh(root, manager, mats.edge, 0.034, 0.034, 0.74, 7, [x, 1.14, rear - 0.58], [Math.PI / 2, 0, 0]);
    }
  } else if (def.kind === 'truck' || def.kind === 'cargo' || def.kind === 'service' || def.kind === 'carrier') {
    const boxStart = cabRear - 0.08;
    const boxLen = Math.max(1.2, rear - boxStart - 0.08);
    const boxH = def.kind === 'cargo' ? 1.75 : def.kind === 'carrier' ? 1.12 : def.kind === 'service' ? 1.28 : 1.16;
    const boxColor = def.kind === 'cargo' ? mats.paint(0x74766f) : paint;
    B(boxColor, [wd * 0.91, boxH, boxLen], [0, 0.78 + boxH * 0.5, (boxStart + rear) * 0.5]);
    B(mats.edge, [wd * 0.88, 0.08, boxLen * 0.92], [0, 0.84, (boxStart + rear) * 0.5]);
    if (def.kind === 'truck' || def.kind === 'service') {
      for (let i = 0; i < 4; i++) {
        const z = boxStart + 0.2 + i * Math.max(0.22, (boxLen - 0.4) / 4);
        B(mats.edge, [wd * 0.94, 0.055, 0.045], [0, 0.84, z]);
      }
    }
    // Distinct cab ahead of the cargo body with real window openings.
    B(paint, [cabW, 0.34, cabLength], [0, 1.42, cabZ]);
    B(paint, [cabW * 0.94, 0.12, cabLength * 0.82], [0, 1.3 + cabHeight, cabZ]);
    const cabGlassY = 1.3 + cabHeight * 0.52;
    windows.push(planeMesh(root, manager, windowMat, cabW * 0.84, cabHeight * 0.7,
      [0, cabGlassY, cabFront + 0.035], [-0.42, 0, 0], 'truck-windshield'));
    windows.push(planeMesh(root, manager, windowMat, cabW * 0.72, cabHeight * 0.62,
      [0, cabGlassY - 0.015, cabRear - 0.025], [0.36, 0, Math.PI], 'truck-rear-window'));
    if (def.kind === 'service') {
      B(mats.rim, [0.09, 0.56, 0.56], [-wd * 0.36, 1.72, boxStart + 0.45], { rotation: [0, 0, Math.PI / 2] });
      for (let i = 0; i < 3; i++) B(mats.edge, [0.08, 0.13, 0.13], [wd * 0.32, 1.25 + i * 0.25, boxStart + 0.35]);
    }
    if (def.kind === 'carrier' || def.kind === 'apc') {
      // Sloped armour cheeks, raised roof band and protected rear hatch.
      B(paint, [wd * 0.95, 0.36, 1.1], [0, 1.62, boxStart + 0.48], { rotation: [-0.16, 0, 0] });
      B(mats.edge, [wd * 0.7, 0.06, 0.52], [0, 2.15, boxStart + 0.3]);
      for (const side of [-1, 1]) {
        B(mats.trim, [0.1, 0.16, 0.8], [side * wd * 0.475, 1.56, cabZ]);
        for (let i = 0; i < 3; i++) {
          const pane = B(windowMat, [0.018, 0.12, 0.21], [side * wd * 0.48, 1.66, cabZ - 0.48 + i * 0.4]);
          windows.push(pane);
        }
      }
    }
  } else if (def.kind === 'apc' || def.kind === 'armored') {
    B(paint, [wd * 0.92, 0.72, hl * 1.72], [0, 1.0, 0.03]);
    B(paint, [wd * 0.84, 0.36, cabLength * 0.88], [0, 1.46, cabZ + 0.08], { rotation: [0.035, 0, 0] });
    B(mats.edge, [wd * 0.46, 0.17, 0.6], [0, 2.0, cabZ + 0.2]); // hatch, not a weapon station
    for (const side of [-1, 1]) {
      B(mats.trim, [0.085, 0.18, 1.0], [side * wd * 0.49, 1.55, cabZ - 0.1]);
      for (let i = 0; i < 3; i++) {
        const pane = B(windowMat, [0.025, 0.11, 0.2], [side * wd * 0.5, 1.65, cabZ - 0.52 + i * 0.4]);
        windows.push(pane);
      }
    }
    B(mats.edge, [wd * 0.82, 0.08, 0.1], [0, 1.3, rear - 0.13]);
  } else if (def.kind === 'buggy') {
    // Open cage and exposed bucket seats replace a conventional cabin.
    B(mats.trim, [wd * 0.76, 0.12, hl * 1.55], [0, 0.73, 0.08]);
    for (const side of [-1, 1]) {
      D(mats.rim, [0.075, 1.0, 0.075], [side * wd * 0.43, 1.13, cabFront + 0.08]);
      D(mats.rim, [0.075, 1.0, 0.075], [side * wd * 0.43, 1.13, cabRear - 0.08]);
      D(mats.rim, [0.08, 0.08, cabLength], [side * wd * 0.43, 1.62, cabZ]);
    }
    D(mats.rim, [wd * 0.84, 0.08, 0.075], [0, 1.62, cabFront + 0.08]);
    D(mats.rim, [wd * 0.84, 0.08, 0.075], [0, 1.62, cabRear - 0.08]);
    for (const x of [-0.38, 0.38]) {
      B(mats.seat, [0.44, 0.42, 0.42], [x, 0.92, -0.05]);
      B(mats.seat, [0.42, 0.55, 0.12], [x, 1.16, 0.22], { rotation: [-0.12, 0, 0] });
    }
  } else {
    // Beltline shell leaves the greenhouse open for actual transparent glazing.
    B(paint, [cabW, 0.34, cabLength], [0, 1.42, cabZ]);
    const roofZ = cabZ + (def.kind === 'hatchback' || def.kind === 'van' ? 0.05 : 0.0);
    B(paint, [cabW * 0.94, 0.12, cabLength * 0.82], [0, 1.3 + cabHeight, roofZ]);
    const frontY = 1.30 + cabHeight * 0.53;
    planeMesh(root, manager, windowMat, cabW * 0.86, cabHeight * 0.73,
      [0, frontY, cabFront + 0.035], [-0.42, 0, 0], 'windshield');
    planeMesh(root, manager, windowMat, cabW * 0.74, cabHeight * 0.66,
      [0, frontY - 0.02, cabRear - 0.025], [0.38, 0, Math.PI], 'rear-window');
    windows.push(root.getObjectByName('windshield'), root.getObjectByName('rear-window'));
    if (def.kind === 'van' || def.kind === 'rescue') {
      for (const side of [-1, 1]) {
        const win = planeMesh(root, manager, windowMat, cabLength * 0.68, cabHeight * 0.58,
          [side * (cabW * 0.505), frontY, cabZ + 0.08], [0, side * Math.PI / 2, 0], `side-glass-${side}`);
        windows.push(win);
      }
    }
  }

  // Greenhouse glazing and pillars for ordinary vehicles; armored types use
  // narrow protected panes and buggy models intentionally stay open-sided.
  if (!['buggy', 'apc', 'armored', 'carrier'].includes(def.kind) && !['truck', 'cargo', 'service'].includes(def.kind)) {
    if (def.kind !== 'van' && def.kind !== 'rescue') {
      const sideWinW = cabLength * 0.72;
      for (const side of [-1, 1]) {
        const win = planeMesh(root, manager, windowMat, sideWinW, cabHeight * 0.61,
          [side * (cabW * 0.505), 1.32 + cabHeight * 0.48, cabZ], [0, side * Math.PI / 2, 0], `side-glass-${side}`);
        windows.push(win);
      }
    }
    // Pillars, roof rails and a separate, hinged lower door skin.
    for (const side of [-1, 1]) {
      B(paint, [0.075, cabHeight * 0.82, 0.09], [side * cabW * 0.48, 1.27 + cabHeight * 0.48, cabFront + 0.08], { rotation: [-0.35, 0, 0] });
      B(paint, [0.075, cabHeight * 0.84, 0.09], [side * cabW * 0.48, 1.27 + cabHeight * 0.48, cabRear - 0.08], { rotation: [0.32, 0, 0] });
      B(paint, [0.065, cabHeight * 0.74, 0.075], [side * cabW * 0.49, 1.32 + cabHeight * 0.47, cabZ]);
      if (def.kind === 'suv' || def.kind === 'utility' || def.kind === 'armored') {
        D(mats.edge, [0.06, 0.055, cabLength * 0.74], [side * cabW * 0.53, 1.3 + cabHeight, cabZ]);
      }
      const doorZs = def.passengers > 4 ? [cabFront + cabLength * 0.27, cabFront + cabLength * 0.72] : [cabZ];
      for (let di = 0; di < doorZs.length; di++) {
        const doorLength = Math.min(0.92, cabLength / (doorZs.length + 0.15));
        const hinge = new THREE.Group();
        hinge.position.set(side * (wd * 0.47), 1.04, doorZs[di] - doorLength * 0.38);
        hinge.name = `door-${side}-${di}`;
        root.add(hinge);
        boxMesh(hinge, manager, paint, [0.065, 0.48, doorLength * 0.76], [side * 0.025, 0.03, doorLength * 0.5]);
        boxMesh(hinge, manager, mats.edge, [0.024, 0.04, 0.13], [side * 0.067, 0.05, doorLength * 0.65]);
        doors.push({ hinge, side, front: di === 0, target: 0, z: doorZs[di] });
      }
      // mirrors, side steps and door sill
      D(mats.edge, [0.16, 0.12, 0.18], [side * (wd * 0.56), 1.22, cabFront + 0.08]);
      D(paint, [0.055, 0.16, 0.34], [side * (wd * 0.53), 1.14, cabFront + 0.08]);
      B(mats.edge, [0.08, 0.07, cabLength * 0.55], [side * (wd * 0.51), 0.62, cabZ]);
    }
  }

  // Hood shoulders, wheel arches, bumpers, grille and shallow panel breaks.
  B(paint, [wd * 0.9, 0.1, Math.max(0.34, def.hoodLength * 0.78)], [0, 1.02, front + def.hoodLength * 0.66]);
  B(mats.edge, [wd * 1.04, 0.16, 0.22], [0, 0.5, front + 0.07]);
  B(mats.edge, [wd * 1.03, 0.14, 0.22], [0, 0.49, rear - 0.06]);
  B(mats.trim, [wd * 0.42, 0.32, 0.08], [0, 0.78, front + 0.12]);
  for (let i = 0; i < 5; i++) B(mats.rim, [0.035, 0.24, 0.04], [-wd * 0.17 + i * wd * 0.085, 0.78, front + 0.07]);
  const frontZ = front + 0.18, rearZ = rear - 0.12;
  for (const side of [-1, 1]) {
    const head = sphereMesh(root, manager, mats.headOff, [0.21, 0.105, 0.07], [side * wd * 0.34, 0.92, frontZ], `headlight-${side}`);
    headlights.push(head);
    const tail = sphereMesh(root, manager, mats.tailOff, [0.15, 0.16, 0.06], [side * wd * 0.36, 0.9, rearZ], `taillight-${side}`);
    tailLights.push(tail);
    const brake = sphereMesh(root, manager, mats.tailOff, [0.12, 0.10, 0.035], [side * wd * 0.3, 0.72, rearZ - 0.025], `brake-${side}`);
    brakeLights.push(brake);
    const ind = sphereMesh(root, manager, mats.indicatorOff, [0.075, 0.055, 0.04], [side * wd * 0.45, 0.9, frontZ + 0.012], `indicator-${side}`);
    indicators.push({ mesh: ind, side });
    const beam = new THREE.Mesh(manager.geometry('headlight-beam', () => new THREE.ConeGeometry(0.78, 7.2, 12, 1, true)),
      new THREE.MeshBasicMaterial({ color: 0xffe8b0, transparent: true, opacity: 0.075, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.set(side * wd * 0.34, 0.88, frontZ - 3.6);
    beam.rotation.x = -Math.PI / 2;
    beam.castShadow = false; beam.receiveShadow = false; beam.visible = false;
    root.add(beam); beams.push(beam);
  }
  for (const [z, axleX] of def.axles) {
    const r = def.wheelR;
    const archGeo = manager.geometry(`wheel-arch-${r.toFixed(2)}`, () => new THREE.TorusGeometry(r * 1.09, 0.055, 5, 16, Math.PI));
    for (const side of [-1, 1]) {
      const arch = new THREE.Mesh(archGeo, paint);
      arch.position.set(side * wd * 0.49, r * 0.88 + 0.1, z);
      arch.rotation.y = Math.PI / 2;
      arch.castShadow = true;
      root.add(arch);
    }
  }

  for (let axle = 0; axle < def.axles.length; axle++) {
    const [z, axleX] = def.axles[axle];
    for (const side of [-1, 1]) {
      const index = wheels.length;
      const pivot = new THREE.Group();
      pivot.position.set(side * axleX, def.wheelR, z);
      root.add(pivot);
      const suspension = new THREE.Group();
      suspension.rotation.z = Math.PI / 2;
      pivot.add(suspension);
      const tire = new THREE.Mesh(manager.geometry(`tire-${def.wheelR}-${def.wheelW}`, () =>
        new THREE.CylinderGeometry(def.wheelR, def.wheelR, def.wheelW, 18, 1)), mats.rubber);
      tire.castShadow = true; tire.receiveShadow = true;
      suspension.add(tire);
      const rim = new THREE.Mesh(manager.geometry(`rim-${def.wheelR}-${def.wheelW}`, () =>
        new THREE.CylinderGeometry(def.wheelR * 0.58, def.wheelR * 0.58, def.wheelW * 0.9, 12, 1)), mats.rim);
      rim.castShadow = true; rim.receiveShadow = true; suspension.add(rim);
      const hub = new THREE.Mesh(manager.geometry(`hub-${def.wheelR}`, () =>
        new THREE.CylinderGeometry(def.wheelR * 0.19, def.wheelR * 0.19, def.wheelW, 10, 1)), mats.edge);
      hub.castShadow = true; suspension.add(hub);
      const treadGeo = manager.geometry(`tread-block-${def.wheelR}`, () => roundedBoxGeometry(2, 0.035));
      const treads = new THREE.Group();
      for (let t = 0; t < 10; t++) {
        const angle = t * Math.PI / 5;
        const block = new THREE.Mesh(treadGeo, mats.tread);
        block.scale.set(def.wheelW * 0.82, 0.04, 0.09);
        block.position.set(Math.sin(angle) * def.wheelR, 0, Math.cos(angle) * def.wheelR);
        block.rotation.y = angle;
        block.castShadow = true;
        treads.add(block);
      }
      suspension.add(treads);
      wheels.push({ pivot, spin: suspension, tire, rim, front: axle === 0, baseY: def.wheelR, side, axle, index, z });
    }
  }

  // Subtle interior: front seats, rear bench, steering wheel and dash. The
  // geometry is shared and only visible close to the camera through glazing.
  if (!['buggy', 'apc', 'carrier'].includes(def.kind)) {
    const interior = new THREE.Group();
    interior.name = 'vehicle-interior';
    root.add(interior);
    for (const x of [-0.39, 0.39]) {
      boxMesh(interior, manager, mats.seat, [0.40, 0.13, 0.42], [x, 0.93, cabFront + 0.36]);
      boxMesh(interior, manager, mats.seat, [0.38, 0.45, 0.12], [x, 1.18, cabFront + 0.56], { rotation: [-0.12, 0, 0] });
      cylinderMesh(interior, manager, mats.trim, 0.025, 0.025, 0.4, 6, [x - 0.14, 0.76, cabFront + 0.35], [0, 0, Math.PI / 2]);
    }
    if (def.passengers > 4) {
      boxMesh(interior, manager, mats.seat, [cabW * 0.62, 0.13, 0.34], [0, 0.94, cabRear - 0.34]);
      boxMesh(interior, manager, mats.seat, [cabW * 0.62, 0.35, 0.12], [0, 1.16, cabRear - 0.17]);
    }
    boxMesh(interior, manager, mats.edge, [cabW * 0.84, 0.2, 0.14], [0, 1.16, cabFront + 0.02]);
    boxMesh(interior, manager, mats.instrument, [0.38, 0.09, 0.03], [-0.28, 1.28, cabFront - 0.005]);
    const wheel = new THREE.Mesh(manager.geometry('steering-wheel', () => new THREE.TorusGeometry(0.19, 0.025, 7, 16)), mats.rim);
    wheel.position.set(-0.37, 1.23, cabFront + 0.24);
    wheel.rotation.x = 0.38;
    interior.add(wheel);
    root.userData.steeringWheel = wheel;
  }

  // Basic body scuffs are low-contrast and remain hidden until the health state
  // changes; they avoid the clean toy-plastic look without texture downloads.
  const dents = new THREE.Group();
  dents.name = 'vehicle-damage-scuffs';
  for (let i = 0; i < 5; i++) {
    const side = i % 2 ? -1 : 1;
    const z = front * 0.6 + i * (hl * 0.28);
    boxMesh(dents, manager, mats.scuff, [0.018, 0.09 + (i % 2) * 0.04, 0.22], [side * wd * 0.502, 0.68 + (i % 2) * 0.15, z]);
  }
  dents.visible = false;
  root.add(dents);

  // Cargo/rack silhouettes vary by class but remain sparse.
  if (def.rack || def.kind === 'suv' || def.kind === 'utility' || def.kind === 'apc') {
    for (const side of [-1, 1]) {
      D(mats.edge, [0.055, 0.06, cabLength * 0.72], [side * cabW * 0.42, 1.3 + cabHeight + 0.06, cabZ]);
      D(mats.edge, [0.055, 0.06, 0.13], [side * cabW * 0.42, 1.3 + cabHeight + 0.06, cabFront + cabLength * 0.15]);
    }
  }
  if (def.kind === 'apc' || def.kind === 'carrier') {
    D(mats.edge, [0.075, 0.7, 0.075], [wd * 0.38, 1.65, rear - 0.35]);
    D(mats.edge, [0.075, 0.7, 0.075], [wd * 0.38, 1.65, rear - 1.0]);
    D(mats.rim, [0.08, 0.44, 0.44], [wd * 0.4, 1.15, rear - 0.35], { rotation: [0, 0, Math.PI / 2] });
  }
  if (def.emergency) {
    for (const side of [-1, 1]) {
      const light = sphereMesh(details, manager, mats.indicatorOn, [0.14, 0.07, 0.14], [side * 0.42, 1.3 + cabHeight, cabZ]);
      light.material = mats.indicatorOff;
      indicators.push({ mesh: light, side, emergency: true });
    }
  }

  root.userData.wheels = wheels;
  root.userData.doors = doors;
  root.userData.windows = windows.filter(Boolean);
  root.userData.headlights = headlights;
  root.userData.taillights = tailLights;
  root.userData.brakelights = brakeLights;
  root.userData.indicators = indicators;
  root.userData.lightBeams = beams;
  root.userData.details = details;
  root.userData.dents = dents;
  root.userData.vehicleKind = def.kind;
  root.userData.driverSide = -1;
  return root;
}

function buildHelicopter(manager, mats, color) {
  const root = new THREE.Group();
  root.name = 'hx7-vanguard';
  const paint = mats.paint(color);
  const windowMat = mats.glassArmored;
  const doors = [];
  const windows = [];
  const headlights = [];
  const tailLights = [];
  const indicators = [];
  const beams = [];
  const details = new THREE.Group();
  details.name = 'heli-lod-details';
  root.add(details);
  const sph = (mat, s, p, name) => sphereMesh(root, manager, mat, s, p, name);
  const B = (mat, s, p, opts) => boxMesh(root, manager, mat, s, p, opts);

  // Original twin-cabin utility aircraft silhouette, with distinct nose,
  // crew cabin, tail boom and tailplane instead of a single primitive fuselage.
  sph(paint, [0.82, 0.66, 1.63], [0, 1.53, 0.32], 'fuselage');
  sph(paint, [0.68, 0.47, 0.86], [0, 1.62, -1.16], 'nose');
  B(mats.edge, [0.18, 0.15, 1.95], [0, 1.58, 2.25], { rotation: [0.015, 0, 0] }); // tapered tail boom
  B(paint, [0.11, 0.94, 0.56], [0, 1.98, 3.92], { rotation: [0.18, 0, 0] }); // tail fin
  B(paint, [1.25, 0.12, 0.45], [0, 1.68, 3.38]); // tailplane
  B(mats.edge, [1.05, 0.08, 0.2], [0, 1.46, 1.45]);

  const wind = planeMesh(root, manager, windowMat, 1.12, 0.62, [0, 1.91, -1.72], [-0.42, 0, 0], 'cockpit-windscreen');
  windows.push(wind);
  for (const side of [-1, 1]) {
    windows.push(planeMesh(root, manager, windowMat, 0.9, 0.55, [side * 0.69, 1.83, -1.05], [0, side * Math.PI / 2, 0], `pilot-side-window-${side}`));
    windows.push(planeMesh(root, manager, windowMat, 1.3, 0.48, [side * 0.77, 1.78, 0.25], [0, side * Math.PI / 2, 0], `cabin-window-${side}`));
    B(paint, [0.08, 0.09, 1.48], [side * 0.77, 1.47, 0.15]);
    B(mats.edge, [0.05, 0.09, 1.2], [side * 0.79, 2.14, 0.25]);
    const hinge = new THREE.Group();
    hinge.position.set(side * 0.78, 1.44, 0.95);
    root.add(hinge);
    boxMesh(hinge, manager, paint, [0.07, 0.74, 1.12], [side * 0.04, 0.16, -0.55]);
    planeMesh(hinge, manager, windowMat, 0.98, 0.43, [side * 0.08, 0.4, -0.56], [0, side * Math.PI / 2, 0], `sliding-door-window-${side}`);
    doors.push({ hinge, side, front: false, target: 0, sliding: true });
  }
  B(mats.edge, [1.06, 0.15, 1.28], [0, 0.97, 0.16]); // cabin floor
  for (const x of [-0.37, 0.37]) {
    B(mats.seat, [0.38, 0.14, 0.42], [x, 1.06, -0.54]);
    B(mats.seat, [0.35, 0.45, 0.14], [x, 1.3, -0.35], { rotation: [-0.12, 0, 0] });
    B(mats.seat, [0.39, 0.14, 0.4], [x, 1.04, 0.55]);
    B(mats.seat, [0.36, 0.41, 0.14], [x, 1.26, 0.73]);
  }
  B(mats.edge, [1.0, 0.28, 0.18], [0, 1.37, -1.18]);
  B(mats.instrument, [0.74, 0.18, 0.035], [0, 1.48, -1.12]);
  cylinderMesh(details, manager, mats.rim, 0.026, 0.026, 0.42, 7, [-0.31, 1.48, -0.63], [Math.PI / 2, 0, 0]); // cyclic
  cylinderMesh(details, manager, mats.edge, 0.055, 0.075, 0.15, 8, [0, 2.46, 0.25]); // mast
  sph(mats.rim, [0.22, 0.12, 0.22], [0, 2.54, 0.25], 'rotor-hub');

  const rotor = new THREE.Group();
  rotor.position.set(0, 2.58, 0.25);
  root.add(rotor);
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2;
    const blade = boxMesh(rotor, manager, mats.rotor, [3.65, 0.036, 0.15], [Math.cos(angle) * 1.93, 0, Math.sin(angle) * 1.93]);
    blade.rotation.y = angle;
    blade.castShadow = false;
  }
  const blur = new THREE.Mesh(manager.geometry('heli-blur-disc', () => new THREE.CircleGeometry(3.9, 24)), mats.rotorBlur);
  blur.rotation.x = -Math.PI / 2;
  blur.position.y = 0.012;
  blur.visible = false;
  rotor.add(blur);

  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.15, 2.0, 4.02);
  tailRotor.rotation.y = Math.PI / 2;
  root.add(tailRotor);
  for (let i = 0; i < 4; i++) {
    const blade = boxMesh(tailRotor, manager, mats.rotor, [0.06, 0.72, 0.09], [0, Math.cos(i * Math.PI / 2) * 0.38, Math.sin(i * Math.PI / 2) * 0.38]);
    blade.rotation.x = i * Math.PI / 2;
    blade.castShadow = false;
  }
  const tailBlur = new THREE.Mesh(manager.geometry('heli-tail-blur', () => new THREE.CircleGeometry(0.5, 16)), mats.rotorBlur);
  tailBlur.rotation.y = Math.PI / 2;
  tailBlur.visible = false;
  tailRotor.add(tailBlur);

  // Twin, long skids with spreader struts. Skid tubes are shared cylinders.
  for (const side of [-1, 1]) {
    cylinderMesh(root, manager, mats.edge, 0.055, 0.055, 4.05, 8, [side * 0.76, 0.16, 0.2], [Math.PI / 2, 0, 0]);
    for (const z of [-0.95, 1.48]) cylinderMesh(root, manager, mats.rim, 0.055, 0.075, 1.02, 7, [side * 0.61, 0.62, z], [0, 0, side * -0.25]);
  }
  cylinderMesh(root, manager, mats.edge, 0.06, 0.06, 1.48, 8, [0, 0.24, 0.25], [0, 0, Math.PI / 2]);
  cylinderMesh(root, manager, mats.edge, 0.05, 0.05, 1.25, 8, [0, 0.24, 0.25], [0, 0, -Math.PI / 2]);

  for (const side of [-1, 1]) {
    const head = sph(mats.headOff, [0.14, 0.09, 0.09], [side * 0.43, 1.48, -1.82], `hx7-nav-light-${side}`);
    headlights.push(head);
    const beam = new THREE.Mesh(manager.geometry('heli-headlight-beam', () => new THREE.ConeGeometry(0.72, 8, 12, 1, true)),
      new THREE.MeshBasicMaterial({ color: 0xd8edee, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }));
    beam.position.set(side * 0.43, 1.43, -5.82); beam.rotation.x = -Math.PI / 2; beam.visible = false; root.add(beam); beams.push(beam);
    const tail = sph(mats.tailOff, [0.09, 0.11, 0.06], [side * 0.18, 1.65, 4.02], `hx7-tail-light-${side}`);
    tailLights.push(tail);
    const ind = sph(mats.indicatorOff, [0.08, 0.06, 0.05], [side * 0.82, 1.48, -1.24], `hx7-indicator-${side}`);
    indicators.push({ mesh: ind, side });
  }
  const beacon = sph(mats.helilight, [0.08, 0.08, 0.08], [0, 2.17, 0.2], 'hx7-beacon');
  const details2 = new THREE.Group();
  details2.add(beacon);
  root.add(details2);

  root.userData.rotor = rotor;
  root.userData.rotorBlur = blur;
  root.userData.tailRotor = tailRotor;
  root.userData.tailBlur = tailBlur;
  root.userData.doors = doors;
  root.userData.windows = windows;
  root.userData.headlights = headlights;
  root.userData.taillights = tailLights;
  root.userData.indicators = indicators;
  root.userData.lightBeams = beams;
  root.userData.details = details;
  root.userData.vehicleKind = 'helicopter';
  root.userData.steeringWheel = null;
  return root;
}

const _vehicleBatchPos = new THREE.Vector3();
const _vehicleBatchNormal = new THREE.Vector3();
const _vehicleBatchNormalMatrix = new THREE.Matrix3();

/**
 * Merge opaque, immutable sub-meshes inside a vehicle's existing transform
 * groups. Moving hinges, wheel pivots, rotors, LOD groups, and all meshes whose
 * materials/visibility change at runtime remain in their original hierarchy.
 * The generated geometries are owned by the vehicle instance and disposed by
 * VehicleManager.reset(); cached source geometry/materials are never disposed.
 */
function mergeVehicleStaticMeshes(root) {
  const data = root && root.userData;
  if (!data) return 0;
  const dynamic = new Set();
  const protect = (item) => {
    if (!item) return;
    if (item.isMesh) dynamic.add(item);
    else if (item.mesh && item.mesh.isMesh) dynamic.add(item.mesh);
  };
  for (const key of ['wheels', 'windows', 'headlights', 'taillights', 'brakelights', 'indicators', 'lightBeams']) {
    for (const item of (Array.isArray(data[key]) ? data[key] : [])) {
      if (key === 'wheels') { protect(item.tire); protect(item.rim); }
      else protect(item);
    }
  }
  for (const key of ['steeringWheel', 'rotorBlur', 'tailBlur']) protect(data[key]);

  const generated = [];
  let mergedParts = 0;
  const visit = (parent) => {
    // Keep the authored hierarchy intact. Batching within a group means its
    // door/wheel/rotor animation and the near/far detail visibility still work.
    for (const child of parent.children.slice()) {
      if (child.isGroup && !child.isBone) visit(child);
    }

    const buckets = new Map();
    for (const mesh of parent.children) {
      if (!mesh.isMesh || dynamic.has(mesh) || !mesh.visible || mesh.isSkinnedMesh || mesh.isInstancedMesh) continue;
      if (mesh.children.length || Array.isArray(mesh.material)) continue;
      const mat = mesh.material, geo = mesh.geometry, attrs = geo && geo.attributes;
      if (!mat || mat.transparent || mat.vertexColors || !attrs || !attrs.position || !attrs.normal || !attrs.uv) continue;
      // Single-material meshes ignore BufferGeometry groups; the material-array
      // case was excluded above. Preserve any extra attributes we do not bake.
      if (Object.keys(attrs).some(k => k !== 'position' && k !== 'normal' && k !== 'uv')) continue;
      const key = mat.uuid + '|' + (mesh.castShadow ? 1 : 0) + '|' + (mesh.receiveShadow ? 1 : 0) + '|' + mesh.renderOrder + '|' + (mesh.frustumCulled ? 1 : 0);
      let b = buckets.get(key);
      if (!b) {
        b = { material: mat, cast: mesh.castShadow, receive: mesh.receiveShadow, renderOrder: mesh.renderOrder, frustumCulled: mesh.frustumCulled, parts: [], vertices: 0, indices: 0 };
        buckets.set(key, b);
      }
      const indexCount = geo.index ? geo.index.count : attrs.position.count;
      b.parts.push(mesh);
      b.vertices += attrs.position.count;
      b.indices += indexCount;
    }

    for (const b of buckets.values()) {
      if (b.parts.length < 2) continue;
      const pos = new Float32Array(b.vertices * 3);
      const nor = new Float32Array(b.vertices * 3);
      const uv = new Float32Array(b.vertices * 2);
      const Index = b.vertices > 65535 ? Uint32Array : Uint16Array;
      const ix = new Index(b.indices);
      let vertexBase = 0, indexBase = 0;
      for (const mesh of b.parts) {
        mesh.updateMatrix();
        _vehicleBatchNormalMatrix.getNormalMatrix(mesh.matrix);
        const geo = mesh.geometry, pa = geo.attributes.position, na = geo.attributes.normal, ua = geo.attributes.uv;
        for (let i = 0; i < pa.count; i++) {
          _vehicleBatchPos.fromBufferAttribute(pa, i).applyMatrix4(mesh.matrix);
          const p = i * 3 + vertexBase * 3;
          pos[p] = _vehicleBatchPos.x; pos[p + 1] = _vehicleBatchPos.y; pos[p + 2] = _vehicleBatchPos.z;
          _vehicleBatchNormal.fromBufferAttribute(na, i).applyNormalMatrix(_vehicleBatchNormalMatrix);
          nor[p] = _vehicleBatchNormal.x; nor[p + 1] = _vehicleBatchNormal.y; nor[p + 2] = _vehicleBatchNormal.z;
          const t = i * 2 + vertexBase * 2;
          uv[t] = ua.getX(i); uv[t + 1] = ua.getY(i);
        }
        if (geo.index) {
          for (let i = 0; i < geo.index.count; i++) ix[indexBase++] = geo.index.getX(i) + vertexBase;
        } else {
          for (let i = 0; i < pa.count; i++) ix[indexBase++] = i + vertexBase;
        }
        vertexBase += pa.count;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geometry.setIndex(new THREE.BufferAttribute(ix, 1));
      geometry.computeBoundingSphere();
      const merged = new THREE.Mesh(geometry, b.material);
      merged.name = 'vehicle-static-batch-' + b.parts.length;
      merged.castShadow = b.cast;
      merged.receiveShadow = b.receive;
      merged.renderOrder = b.renderOrder;
      merged.frustumCulled = b.frustumCulled;
      merged.matrixAutoUpdate = false;
      parent.add(merged);
      for (const mesh of b.parts) parent.remove(mesh);
      generated.push(geometry);
      mergedParts += b.parts.length;
    }
  };
  visit(root);
  data._staticBatchGeometries = generated;
  data._staticBatchParts = mergedParts;
  return mergedParts;
}

function approach(value, target, amount) {
  if (value < target) return Math.min(target, value + amount);
  return Math.max(target, value - amount);
}

// ---------------------------------------------------------------------------
export class Vehicle {
  constructor(manager, spawn) {
    this.manager = manager;
    this.game = manager.game;
    this.isHelicopter = spawn.type === 'hx7' || spawn.type === 'helicopter';
    this.def = this.isHelicopter ? HELI_DEF : (VEHICLE_DEFS[spawn.type] || VEHICLE_DEFS.suv);
    this.lowRangeCapable = ['4wd', 'awd', '6x6', 'tracked'].includes(this.def.drivetrain);
    this.type = this.isHelicopter ? 'hx7' : this.def.id;
    this.tag = spawn.tag || null;
    this.mission = !!spawn.mission;
    this.extractionLocked = this.isHelicopter && this.mission;
    this.route = spawn.route && spawn.route.length ? spawn.route : null;
    this.routeIdx = 0;
    this.aiMode = spawn.ai ? 'patrol' : 'parked';
    this.hostileCrew = spawn.hostileCrew || false;
    this.crewKinds = spawn.crewKinds || ['rifleman', 'assault'];
    this.crewDismounted = false;
    this.pursue = !!spawn.pursue;
    this.pos = spawn.pos.clone();
    this.heading = spawn.yaw || 0;
    this.speed = 0;
    this.vy = 0;
    this.collective = 0.5;
    this.rotorPower = 0;
    this.hoverAltitude = null;
    this.landed = this.isHelicopter;
    this.hp = this.def.hp * (spawn.hpFrac != null ? spawn.hpFrac : 1);
    this.driver = spawn.ai ? 'ai' : null;
    this.firstPerson = false;
    this.steerVis = 0;
    this.pitchT = 0;
    this.rollT = 0;
    this.bobT = 0;
    this.smokeT = 0;
    this.damageT = 0;
    this.lightsBroken = false;
    this.engineStarted = !!spawn.ai;
    this.headlightsOn = false;
    this.lowRange = false;
    this.entryT = 0;
    this.entryDuration = 0.62;
    // A hull out-masses every person in the mission: it is a solid body that
    // shoves rather than being shoved, but its impulses stay bounded so nobody
    // is flicked across the map.
    this.collisionMass = Math.max(420, (this.def.mass || 1600) * 0.55);
    this._body = null;
    this._hullContacts = [];
    this.entryStart = new THREE.Vector3();
    this.entryDoorSide = -1;
    this.doorT = 0;
    this.doorTarget = 0;
    this.turnSignalT = 0;
    this.indicatorT = 0;
    this.skidT = 0;
    this._noiseT = 0;
    this._engineActive = false;
    this._engineId = 'vehicle-' + manager._idSeq;
    this._aiAccumulator = 0;
    this._aiPauseT = 0;
    this._aiContactT = 0;
    this._aiLastSeen = new THREE.Vector3();
    this._aiLastSeenAt = -99;
    this._aiOut = { t: 0, s: 0, brake: false };
    this._lastUpdatePos = new THREE.Vector3();
    this._lastSafeExit = spawn.pos.clone();
    this._exitProbeT = 0;
    this._doorSoundT = 0;
    this._exitDoorTimer = 0;
    this._arrivedRouteIdx = -1;
    this._controls = { throttle: 0, steer: 0, brake: false, lowRange: false, hover: false, collective: 0 };
    this._lastCollided = false;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._tmp3 = new THREE.Vector3();
    this._tmp4 = new THREE.Vector3();
    this._exitTmp = new THREE.Vector3();
    this._surface = { grip: 1, drag: 0.1, dust: 0 };
    this._moveOut = { onGround: false, hitX: false, hitZ: false, hitCeil: false, steppedUp: false, groundCollider: null };
    this.box = { min: new THREE.Vector3(), max: new THREE.Vector3() };
    this.crashCd = 0;
    this.doorGroups = [];
    this.wheels = [];
    this.burstTire = [];
    this.windowHealth = [];
    this.brokenWindows = [];
    this.capacity = this.def.passengers || 1;
    this.passengers = [];
    this.occupants = this.driver === 'ai' ? Math.min(this.capacity, spawn.crewCount || (this.hostileCrew ? this.crewKinds.length + 1 : 1)) : 0;

    const color = spawn.color != null ? spawn.color : [0x536253, 0x6b6352, 0x4a5962, 0x675847, 0x5b625d][Math.floor(Math.random() * 5)];
    this.model = this.isHelicopter
      ? buildHelicopter(manager, manager.mats, color)
      : buildBody(this.def, manager.mats, color, manager);
    mergeVehicleStaticMeshes(this.model);
    this.model.position.copy(this.pos);
    this.model.rotation.y = this.heading;
    manager.group.add(this.model);
    if (this.extractionLocked) this.model.visible = false;
    const data = this.model.userData;
    this.wheels = data.wheels || [];
    this.doorGroups = data.doors || [];
    this.headLights = data.headlights || [];
    this.tailLights = data.taillights || [];
    this.brakeLights = data.brakelights || [];
    this.indicators = data.indicators || [];
    this.lightBeams = data.lightBeams || [];
    this.windowMeshes = data.windows || [];
    this.dents = data.dents || null;
    this._steeringWheel = data.steeringWheel || null;
    this._details = data.details || null;
    this._rotor = data.rotor || null;
    this._rotorBlur = data.rotorBlur || null;
    this._tailRotor = data.tailRotor || null;
    this._tailBlur = data.tailBlur || null;
    this._doorMaterials = this.doorGroups.map(d => ({ group: d.hinge, side: d.side }));
    this.burstTire = new Array(this.wheels.length).fill(false);
    this.windowHealth = new Array(this.windowMeshes.length).fill(this.def.armored ? 115 : 68);
    this.brokenWindows = new Array(this.windowMeshes.length).fill(false);
    this._syncBox();
  }

  get state() {
    const f = this.hp / this.def.hp;
    if (f <= 0) return 'disabled';
    if (f < 0.25) return 'severe';
    if (f < 0.6) return 'damaged';
    return 'normal';
  }
  get drivable() { return this.hp > 0; }
  get condition() { return this.state; }
  get isMoving() { return Math.abs(this.speed) > 0.35 || Math.abs(this.vy) > 0.45; }

  _syncBox() {
    if (this.isHelicopter) {
      const c = Math.abs(Math.cos(this.heading)), s = Math.abs(Math.sin(this.heading));
      const ex = (c * this.def.wd + s * this.def.hl * 2) / 2;
      const ez = (s * this.def.wd + c * this.def.hl * 2) / 2;
      this.box.min.set(this.pos.x - ex, this.pos.y, this.pos.z - ez);
      this.box.max.set(this.pos.x + ex, this.pos.y + this.def.h, this.pos.z + ez);
    } else {
      const c = Math.abs(Math.cos(this.heading)), s = Math.abs(Math.sin(this.heading));
      const hl = this.def.hl, wd = this.def.wd;
      const ex = (c * wd + s * hl * 2) / 2, ez = (s * wd + c * hl * 2) / 2;
      this.box.min.set(this.pos.x - ex, this.pos.y, this.pos.z - ez);
      this.box.max.set(this.pos.x + ex, this.pos.y + this.def.h, this.pos.z + ez);
    }
    // The hull is a physical body: every actor (and every other vehicle) is
    // resolved against it, and it follows the model every frame, so a moving
    // truck never leaves its collision behind.
    const g = this.game;
    if (g && g.physics && g.physics.actors) {
      syncActorBody(g.physics, this, this.box, { tag: 'vehicle', material: 'metal', mass: this.collisionMass });
    }
  }

  /**
   * Driver's door: the one and only place boarding is allowed (helicopters use
   * their designated cabin threshold, which is the same point). Returns the
   * world position plus the outward normal the operator has to approach from.
   */
  doorInfo(out) {
    const info = out || { pos: new THREE.Vector3(), normal: new THREE.Vector3(), height: 0.86 };
    const hx = this.isHelicopter ? -1.08 : -(this.def.wd * 0.5 + 0.22);
    this.driverDoorWorld(info.pos);
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    // local -X (driver side) rotated into world space = outward door normal
    info.normal.set(-c, 0, s);
    info.localX = hx;
    info.reach = this.isHelicopter ? 1.85 : 1.5;
    return info;
  }

  /** Designated entry point for vehicles with no doors (buggy, bike, APC roof
   * hatch, open-bed truck): a marked spot on the driver's side, same rules. */
  entryPointInfo(out) {
    const info = this.doorInfo(out);
    info.hasDoor = !(this.isHelicopter || this.def.kind === 'buggy' || this.def.openCrew === true);
    info.label = info.hasDoor ? 'DRIVER DOOR' : 'ENTRY POINT';
    return info;
  }

  /**
   * Door-specific boarding test. Boarding is allowed only from the driver's
   * side: the operator has to be within arm's reach of the door point AND on
   * the outward side of the door plane, with nothing solid between him and the
   * aperture. Approaching the far side of the hull never boards.
   */
  canBoardFrom(playerPos, game, out) {
    const info = this.entryPointInfo(this._boardInfo || (this._boardInfo = { pos: new THREE.Vector3(), normal: new THREE.Vector3(), localX: 0, reach: 1.5, hasDoor: true, label: '' }));
    const res = out || { ok: false, reason: '' };
    res.point = info.pos;
    if (!this.drivable) { res.ok = false; res.reason = 'WRECKED'; return res; }
    if (this.driver === 'player') { res.ok = false; res.reason = 'OCCUPIED'; return res; }
    if (this.isHelicopter && this.extractionLocked) { res.ok = false; res.reason = 'LOCKED'; return res; }
    if (this.isHelicopter && (this.pos.y > 1.25 || (!this.landed && this.pos.y > 0.5))) { res.ok = false; res.reason = 'AIRBORNE'; return res; }
    if (Math.abs(this.speed || 0) > (this.driver === 'ai' ? 2.5 : 1.35)) { res.ok = false; res.reason = 'MOVING'; return res; }
    const dx = playerPos.x - info.pos.x, dz = playerPos.z - info.pos.z;
    const dist = Math.hypot(dx, dz);
    res.distance = dist;
    // 1) reach: an outstretched hand at the aperture, not a map-wide trigger
    if (dist > info.reach) { res.ok = false; res.reason = dist > info.reach + 3 ? 'TOO_FAR' : 'NEAR_DOOR'; return res; }
    // 2) side: the player must be outside the door plane, not inside the hull
    const sideDot = dx * info.normal.x + dz * info.normal.z;
    if (sideDot < -0.30) { res.ok = false; res.reason = 'WRONG_SIDE'; return res; }
    // 3) nothing solid wedged between the operator and the door
    if (game && game.physics) {
      const from = _BOARD_FROM.set(playerPos.x, playerPos.y + 1.0, playerPos.z);
      const delta = _BOARD_DIR.copy(info.pos).setY(info.pos.y + 0.1).sub(from);
      const len = delta.length();
      if (len > 0.08) {
        const hit = game.physics.raycast(from, delta.multiplyScalar(1 / len), len - 0.06);
        if (hit) { res.ok = false; res.reason = 'BLOCKED'; return res; }
      }
    }
    res.ok = true; res.reason = 'READY';
    return res;
  }

  localToWorld(x, y, z, out = this._tmp) {
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    return out.set(this.pos.x + x * c + z * s, this.pos.y + y, this.pos.z - x * s + z * c);
  }

  driverDoorWorld(out = this._tmp) {
    const x = this.isHelicopter ? -1.08 : -(this.def.wd * 0.5 + 0.22);
    const z = this.isHelicopter ? 0.15 : -Math.min(0.38, this.def.hl * 0.18);
    return this.localToWorld(x, 0.86, z, out);
  }

  setDoor(open, side = this.entryDoorSide) {
    this.doorTarget = open ? 1 : 0;
    for (const d of this.doorGroups) {
      if (d.side === side || d.sliding) d.target = this.doorTarget;
    }
    if (open) this.doorT = Math.max(this.doorT, 0.01);
  }

  _updateDoorAnimation(dt) {
    const target = this.doorTarget;
    this.doorT += (target - this.doorT) * Math.min(1, dt * 9);
    if (Math.abs(this.doorT - target) < 0.006) this.doorT = target;
    for (const d of this.doorGroups) {
      const amount = d.target || 0;
      if (d.sliding) d.hinge.position.x = d.side * (0.78 + amount * 0.64);
      else d.hinge.rotation.y = d.side * amount * 0.82;
    }
    if (this._doorSoundT > 0) this._doorSoundT = Math.max(0, this._doorSoundT - dt);
  }

  openForEntry(playerPos) {
    const localX = this._tmp.copy(playerPos).sub(this.pos).applyAxisAngle(_UP, -this.heading).x;
    this.entryDoorSide = localX < 0 ? -1 : 1;
    this.setDoor(true, this.entryDoorSide);
    this._doorSoundT = 0.35;
    if (this.game.audio && this.game.audio.doorSound) this.game.audio.doorSound(this.pos, 'open');
  }

  closeAfterEntry() {
    this.setDoor(false, this.entryDoorSide);
    if (this.game.audio && this.game.audio.doorSound) this.game.audio.doorSound(this.pos, 'close');
  }

  /**
   * A moving hull is a physical event, not a pass-through: anyone it closes on
   * is knocked down (mass-weighted) and, above plow speed, takes damage. The
   * victim's own collision resolution runs against this hull every frame, so a
   * body pinned against a wall is never shoved further into it.
   */
  _processHullContacts(game, dt) {
    if (!game.physics || !game.physics.actors || !game.physics.actors.count) return;
    if (this.hp <= 0) return;
    const speedAbs = Math.abs(this.speed || 0);
    const sink = Math.abs(this.vy || 0);
    if (speedAbs < 1.1 && sink < 1.0) return;
    const list = this._hullContacts;
    const min = this._tmp.set(this.box.min.x, this.box.min.y, this.box.min.z);
    const max = this._tmp2.set(this.box.max.x, this.box.max.y, this.box.max.z);
    list.length = 0;
    game.physics.actors.query(min, max, list, this._body);
    for (let i = 0; i < list.length; i++) {
      const body = list[i];
      if (body.tag !== 'actor') continue;            // only characters, not other hulls
      const victim = body.entity;
      if (!victim || victim === this || victim.alive === false) continue;
      // The driver rides inside the hull and is not a run-over victim; everyone
      // else in the path of a moving hull is. (This used to skip the whole loop
      // whenever the player was driving, so player-driven vehicles could not
      // knock anybody down at all.)
      if (game.vehicleMode === this && victim === game.player) continue;
      if (victim === game.player && this.driver === 'player') continue;
      const nx = victim.pos.x - this.pos.x;
      const nz = victim.pos.z - this.pos.z;
      const len = Math.hypot(nx, nz) || 1;
      const closing = speedAbs * Math.max(0.35, Math.abs((nx / len) * Math.sin(this.heading) + (nz / len) * Math.cos(this.heading)) * 0.6 + 0.55);
      // Two tonnes of hull outranks any balance check: a body in the path of a
      // moving vehicle goes down, and only a crawl gets away with a stagger.
      const vehSpeed = Math.max(closing, speedAbs, sink);
      applyImpact(victim, {
        physics: game.physics,
        closingSpeed: vehSpeed,
        nx: nx / len, nz: nz / len,
        source: this,
        subjectMassScale: 1,
        attackerMass: this.collisionMass,
        forceState: vehSpeed >= TUNE.VEHICLE_KNOCK_SPEED ? BODY_STATE.KNOCKED_DOWN : BODY_STATE.STAGGERED,
      });
      // and clear the body out of the swept hull (knockback alone cannot beat
      // a six-metre box in the frames it takes to drive over it)
      if (victim.impactFsm) ejectFromHull(victim, this.box, game.physics, this._body);
      if (closing > TUNE.VEHICLE_DAMAGE_SPEED) {
        const dmg = Math.min(58, (closing - TUNE.VEHICLE_DAMAGE_SPEED) * 9);
        if (victim === game.player) {
          if (game.applyDamageToPlayer) game.applyDamageToPlayer('torso', dmg, this.pos);
          else game.player.damage('torso', dmg, this.pos);
        } else if (game.enemies && game.enemies.damage) {
          game.enemies.damage(victim, 'torso', dmg, victim.pos, null);
        }
        if (game.emitNoise) game.emitNoise(this.pos, 12, 'impact');
        if (game.audio && game.audio.impact) game.audio.impact('metal', this.pos, 0.9);
      }
    }
  }

  _surfaceAt(game) {
    const s = game.world && game.world.getVehicleSurface ? game.world.getVehicleSurface(this.pos.x, this.pos.z) : null;
    if (!s) {
      this._surface.grip = 0.92; this._surface.drag = 0.12; this._surface.dust = 0.12;
      return this._surface;
    }
    this._surface.grip = s.grip;
    this._surface.drag = s.drag;
    this._surface.dust = s.dust;
    return this._surface;
  }

  _traction(surface, lowRange = this.lowRange) {
    const offRoadBias = THREE.MathUtils.clamp((this.def.offRoad || 0.8) - 0.7, -0.4, 0.8);
    let grip = surface.grip + offRoadBias * (surface.grip < 0.9 ? 0.34 : 0.12);
    // Engaged low-range 4WD/6x6/tracked drivetrains gain usable grip on loose
    // ground at the cost of the lower gearing and top-speed limit below.
    if (lowRange && this.lowRangeCapable) grip *= surface.grip < 0.9 ? 1.17 : 1.07;
    let tires = 0;
    for (let i = 0; i < this.burstTire.length; i++) if (this.burstTire[i]) tires++;
    grip *= 1 - tires * 0.105;
    return THREE.MathUtils.clamp(grip, 0.28, 1.2);
  }

  _hitLocation(point) {
    const local = this._tmp.copy(point).sub(this.pos).applyAxisAngle(_UP, -this.heading);
    if (this.isHelicopter) {
      if (local.y > 1.55 && local.y < 2.35 && Math.abs(local.z) < 1.9 && Math.abs(local.x) < 1.25) {
        let best = -1, bestD = Infinity;
        for (let i = 0; i < this.windowMeshes.length; i++) {
          if (this.brokenWindows[i]) continue;
          const d = Math.abs(local.z + 1.2) + Math.abs(local.y - 1.8) + Math.abs(local.x) * 0.4;
          if (d < bestD) { bestD = d; best = i; }
        }
        if (best >= 0) return { zone: 'glass', index: best };
      }
      return { zone: 'body', index: -1 };
    }
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      if (Math.abs(local.x) >= this.def.wd * 0.36 && Math.abs(local.z - w.z) <= this.def.wheelR * 1.12 && local.y < this.def.wheelR * 2.25) {
        return { zone: 'tire', index: i };
      }
    }
    const y = local.y;
    const sideWindow = Math.abs(local.x) >= this.def.wd * 0.36 && y > 0.95 && y < this.def.h - 0.12;
    const windscreen = local.z < -this.def.hl * 0.55 && y > 0.96 && y < this.def.h;
    const rearWindow = local.z > this.def.hl * 0.72 && y > 0.95 && y < this.def.h;
    if (sideWindow || windscreen || rearWindow) {
      let idx = -1, bestD = Infinity;
      for (let i = 0; i < this.windowMeshes.length; i++) {
        if (this.brokenWindows[i]) continue;
        const p = this.windowMeshes[i].position;
        const dx = local.x - p.x, dy = local.y - p.y, dz = local.z - p.z;
        const d = dx * dx + dy * dy * 1.12 + dz * dz;
        if (d < bestD) { bestD = d; idx = i; }
      }
      if (idx >= 0) return { zone: 'glass', index: idx };
    }
    if (local.z < -this.def.hl * 0.43 && y < 1.15 && !this.def.armored) return { zone: 'engine', index: -1 };
    return { zone: 'body', index: -1 };
  }

  damage(amount, game, point, zone = null) {
    if (this.hp <= 0 || amount <= 0) return;
    const hit = point ? this._hitLocation(point) : { zone: zone || 'body', index: -1 };
    const kind = zone || hit.zone;
    if (kind === 'glass' && hit.index >= 0) {
      const idx = hit.index;
      this.windowHealth[idx] -= amount * (this.def.armored ? 0.5 : 1);
      if (this.windowHealth[idx] <= 0 && !this.brokenWindows[idx]) {
        this.brokenWindows[idx] = true;
        if (this.windowMeshes[idx]) this.windowMeshes[idx].visible = false;
        if (point && game.particles && game.particles.glassBurst) game.particles.glassBurst(point, _UP);
        if (game.audio && game.audio.impact) game.audio.impact('glass', point, 0.75);
      }
      // A windscreen is a vulnerable component but still contributes to hull wear.
      this.hp -= amount * (this.def.armored ? 0.06 : 0.13);
    } else if (kind === 'tire' && hit.index >= 0 && !this.isHelicopter) {
      this.tireHealth = this.tireHealth || new Array(this.wheels.length).fill(100);
      this.tireHealth[hit.index] = Math.max(0, this.tireHealth[hit.index] - amount * 1.7);
      if (this.tireHealth[hit.index] <= 0) this.burstTire[hit.index] = true;
      this.hp -= amount * 0.12;
    } else {
      const multiplier = kind === 'engine' ? 1.25 : this.def.armored ? 0.48 : 1;
      this.hp -= amount * multiplier;
      if (kind === 'engine') this.engineDamage = Math.min(1, (this.engineDamage || 0) + amount / 180);
    }
    if (point && amount > 4 && game.particles && game.particles.impact) {
      game.particles.impact(point, this._tmp2.copy(point).sub(this.pos).normalize(), kind === 'glass' ? 'glass' : 'metal', Math.min(2.3, 0.55 + amount / 34));
      if (game.audio && game.audio.impact && kind !== 'glass') game.audio.impact('metal', point, Math.min(2, 0.5 + amount / 45));
    }
    if (this.hp < this.def.hp * 0.62 && this.dents) this.dents.visible = true;
    if (this.hp < this.def.hp * 0.4 && !this.lightsBroken) this.lightsBroken = true;
    if (this.hp <= 0) {
      this.hp = 0;
      this.speed = 0;
      this.engineStarted = false;
      if (game.audio && game.audio.engineStop) game.audio.engineStop(this._engineId);
      if (game.ui && game.ui.radio) game.ui.radio('VEHICLE DISABLED — CREW EXPOSED');
      if (this.driver === 'player' && game.exitVehicle) game.exitVehicle(true);
    } else if (this.hostileCrew && !this.crewDismounted && this.driver === 'ai' && amount > 22) {
      this.aiMode = 'retreat';
      this.routeIdx = this.route ? (this.routeIdx + 1) % this.route.length : 0;
    }
  }

  visibleHit(origin, dir, maxDist) {
    if (this.hp <= 0) return null;
    const d = this._hitLocalAABB(origin, dir, maxDist);
    if (d === null) return null;
    const point = this._tmp.copy(origin).addScaledVector(dir, d);
    return { dist: d, point, hit: this._hitLocation(point) };
  }

  _hitLocalAABB(origin, dir, maxDist) {
    const d = this._tmp2.copy(origin).sub(this.pos).applyAxisAngle(_UP, -this.heading);
    const rd = this._tmp3.copy(dir).applyAxisAngle(_UP, -this.heading);
    const y0 = this.isHelicopter ? 0 : 0;
    const y1 = this.def.h;
    const dx = this.isHelicopter ? this.def.wd * 0.45 : this.def.wd * 0.5;
    const dz = this.isHelicopter ? this.def.hl * 0.38 : this.def.hl;
    let t0 = 0, t1 = maxDist;
    for (const axis of ['x', 'y', 'z']) {
      let mn = axis === 'x' ? -dx : axis === 'y' ? y0 : -dz;
      let mx = axis === 'x' ? dx : axis === 'y' ? y1 : dz;
      if (axis === 'y') { mn += this.pos.y; mx += this.pos.y; }
      const o = axis === 'y' ? d.y + this.pos.y : d[axis];
      const v = rd[axis];
      if (Math.abs(v) < 1e-8) { if (o < mn || o > mx) return null; continue; }
      let a = (mn - o) / v, b = (mx - o) / v;
      if (a > b) { const tmp = a; a = b; b = tmp; }
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) return null;
    }
    return t0 >= 0 && t0 <= maxDist ? t0 : t1 >= 0 && t1 <= maxDist ? t1 : null;
  }

  _getControls(dt, game) {
    let throttle = 0, steer = 0, brake = false, lowRange = false, hover = false, collective = 0;
    if (this.driver === 'player' && this.drivable && this.entryT <= 0) {
      const inp = game.input || {};
      throttle = inp.moveF || 0;
      steer = -(inp.moveR || 0) * ((game.settings && game.settings.vehSteerInvert) ? -1 : 1)
        * ((game.settings && game.settings.vehSteerSens != null) ? game.settings.vehSteerSens : 1);
      brake = !!inp.spaceHeld;
      lowRange = !!inp.sprint && this.lowRangeCapable;
      hover = !!inp.vehicleHover && this.isHelicopter;
      collective = inp.vehicleCollective || 0;
    } else if (this.driver === 'ai' && this.drivable) {
      if (this.isHelicopter) {
        const c = this._heliAIControl(dt);
        throttle = c.t; steer = c.s; collective = c.collective;
      } else {
        const c = this._aiControl(dt, game);
        throttle = c.t; steer = c.s; brake = c.brake;
      }
    }
    const out = this._controls;
    out.throttle = throttle; out.steer = steer; out.brake = brake;
    out.lowRange = lowRange; out.hover = hover; out.collective = collective;
    return out;
  }

  update(dt, game) {
    if (this.driver === 'ai' && this.hostileCrew && !this.crewDismounted) {
      const contact = this._detectAIContact(dt, game);
      if (contact && this.aiMode !== 'retreat') {
        const dx = game.player.pos.x - this.pos.x, dz = game.player.pos.z - this.pos.z;
        this.aiMode = this.pursue && Math.hypot(dx, dz) > 17 ? 'pursue' : 'contact';
      }
      if (this.aiMode === 'contact' && Math.abs(this.speed) < 1.35) this._dismountCrew(game);
    }
    if (this.entryT > 0) {
      this.entryT = Math.max(0, this.entryT - dt);
      if (this.entryT === 0) this.closeAfterEntry();
    }
    if (this._exitDoorTimer > 0) {
      this._exitDoorTimer = Math.max(0, this._exitDoorTimer - dt);
      if (this._exitDoorTimer === 0) this.setDoor(false, this.entryDoorSide);
    }
    if (!this.drivable && this.driver !== 'player') {
      this._updatePresentation(dt, game, 0, false);
      return;
    }
    const c = this._getControls(dt, game);
    if (this.isHelicopter) this._updateHelicopter(dt, game, c);
    else this._updateGround(dt, game, c);
    this._updatePresentation(dt, game, c.steer, c.brake);
  }

  _updateGround(dt, game, control) {
    const def = this.def;
    this.lowRange = !!control.lowRange && this.lowRangeCapable;
    const surface = this._surfaceAt(game);
    const traction = this._traction(surface, this.lowRange);
    const previousSpeed = this.speed;
    const moving = this.driver === 'player' || this.driver === 'ai';
    const throttle = moving ? THREE.MathUtils.clamp(control.throttle, -1, 1) : 0;
    const brake = control.brake || !moving || !this.drivable;
    const engineDamage = 1 - Math.min(0.55, (this.engineDamage || 0) * 0.42);
    const tirePenalty = this.burstTire.reduce((n, b) => n + (b ? 1 : 0), 0);
    const accelScale = engineDamage * (this.lowRange ? 1.12 : 1) * Math.max(0.52, traction);

    // Progressive throttle/braking with rolling and aerodynamic drag.
    if (throttle > 0.035) {
      if (this.speed < -0.45) this.speed = approach(this.speed, 0, def.brake * 0.55 * dt);
      else this.speed += def.accel * accelScale * throttle * dt;
    } else if (throttle < -0.035) {
      if (this.speed > 0.7) this.speed = approach(this.speed, 0, def.brake * Math.abs(throttle) * dt);
      else this.speed -= def.reverseAccel * accelScale * Math.abs(throttle) * dt;
    }
    if (brake) this.speed = approach(this.speed, 0, def.brake * (control.brake ? 1.0 : 0.8) * dt);
    const rolling = (surface.drag + (this.lowRange ? 0.04 : 0)) * Math.max(0.25, 1.15 - (def.offRoad - 1) * 0.15);
    const aero = 0.0015 + Math.abs(this.speed) * 0.00042;
    if (Math.abs(throttle) < 0.035 || brake) {
      this.speed *= Math.max(0, 1 - (rolling + aero) * dt * (brake ? 4 : 1));
      if (Math.abs(this.speed) < 0.035) this.speed = 0;
    } else {
      this.speed *= Math.max(0, 1 - aero * dt);
    }
    const baseTop = def.top * (this.lowRange ? 0.58 : 1) * engineDamage;
    const flatTireLimit = Math.max(0.56, 1 - tirePenalty * 0.095);
    this.speed = THREE.MathUtils.clamp(this.speed, -baseTop * 0.34, baseTop * flatTireLimit);

    const speedAbs = Math.abs(this.speed);
    const speedFactor = THREE.MathUtils.clamp(speedAbs / 4.5, 0, 1);
    const highSpeedReduction = 1 - 0.42 * THREE.MathUtils.clamp(speedAbs / def.top, 0, 1);
    const massScale = THREE.MathUtils.clamp(1850 / def.mass, 0.48, 1.3);
    const damagedSteer = Math.max(0.42, 1 - (this.engineDamage || 0) * 0.3 - tirePenalty * 0.12);
    const steerRate = def.steer * speedFactor * highSpeedReduction * massScale * traction * damagedSteer;
    if (speedAbs > 0.1) this.heading += control.steer * steerRate * Math.sign(this.speed) * dt;
    this.heading = THREE.MathUtils.euclideanModulo(this.heading + Math.PI, Math.PI * 2) - Math.PI;
    this.steerVis += (THREE.MathUtils.clamp(control.steer, -1, 1) * 0.47 - this.steerVis) * Math.min(1, dt * 7.5);

    _WORLD_FWD.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
    this._lastUpdatePos.copy(this.pos);
    this._syncBox();
    const dx = _WORLD_FWD.x * this.speed * dt;
    const dz = _WORLD_FWD.z * this.speed * dt;
    game.physics.moveBox(this.box, dx, -3.6 * dt, dz, this._moveOut, 0.34, this._moveOpts || (this._moveOpts = { actors: false, ignoreBody: null, maxDepenetrate: 0.5 }));
    this.pos.set((this.box.min.x + this.box.max.x) * 0.5, this.box.min.y, (this.box.min.z + this.box.max.z) * 0.5);
    // republish the collision body from the resolved hull, not the pre-move one:
    // a body left a frame behind is a gap a fast mover can step through.
    this._syncBox();

    const hit = this._moveOut.hitX || this._moveOut.hitZ;
    if (hit) {
      const impactSpeed = Math.abs(previousSpeed);
      if (impactSpeed > 7 && this.crashCd <= 0) {
        const damage = Math.min(def.hp * 0.28, (impactSpeed - 6.5) * def.mass / 1000 * 0.62);
        this.damage(damage, game, this._tmp.copy(this.pos).addScaledVector(_WORLD_FWD, -def.hl * 0.82).setY(this.pos.y + 0.62), 'body');
        this.crashCd = 0.65;
        if (this.driver === 'player' && game.addShake) game.addShake(Math.min(0.6, impactSpeed / 30));
        if (game.audio && game.audio.impact) game.audio.impact('metal', this.pos, Math.min(1.8, impactSpeed / 16));
      }
      this.speed *= impactSpeed > 7 ? -0.11 : 0.28;
      if (control.steer) this.heading += control.steer * 0.025;
    }
    this.crashCd = Math.max(0, this.crashCd - dt);

    const bounds = game.world && game.world.bounds;
    if (bounds) {
      const margin = Math.max(def.wd, def.hl) * 0.5;
      if (this.pos.x < bounds.minX + margin || this.pos.x > bounds.maxX - margin || this.pos.z < bounds.minZ + margin || this.pos.z > bounds.maxZ - margin) {
        this.speed *= 0.5;
        this.pos.x = THREE.MathUtils.clamp(this.pos.x, bounds.minX + margin, bounds.maxX - margin);
        this.pos.z = THREE.MathUtils.clamp(this.pos.z, bounds.minZ + margin, bounds.maxZ - margin);
        this._syncBox();
      }
    }

    // Ground and surface feedback are throttled; there is no per-frame audio
    // node creation and dirt/snow puffs reuse the existing particle pool.
    this.skidT = Math.max(0, this.skidT - dt);
    const slip = Math.abs(control.steer) * speedAbs / Math.max(traction, 0.28);
    if (slip > 8.5 && this.skidT <= 0) {
      this.skidT = 1.15;
      if (game.audio && game.audio.tireSqueal) game.audio.tireSqueal(this.pos, THREE.MathUtils.clamp(slip / 18, 0.15, 0.7));
      if (surface.dust > 0.18) this._spawnDust(game, surface.dust * 0.75);
    } else if (speedAbs > 4 && surface.dust > 0.1 && this.skidT <= 0) {
      this.skidT = 0.48;
      this._spawnDust(game, surface.dust * Math.min(1, speedAbs / 16));
    }

    // Occupants are protected by the shell, but severe impacts still transmit
    // a small impulse. Run-over checks remain on the existing player damage path.
    if (this.driver === 'player' && speedAbs > 14 && hit && game.applyDamageToPlayer) {
      game.applyDamageToPlayer('torso', Math.min(24, (speedAbs - 12) * 0.65), this.pos);
    }
    if (this._steeringWheel) this._steeringWheel.rotation.z = this.steerVis * 0.75;
  }

  _spawnDust(game, intensity) {
    if (!game.particles || !game.particles.smoke || intensity < 0.08) return;
    const p = this._tmp.copy(this.pos).addScaledVector(_WORLD_FWD, this.def.hl * 0.48).setY(this.pos.y + 0.12);
    const velocity = game._tmpV2 || this._tmp2;
    velocity.set((Math.random() - 0.5) * 0.55, 0.18 + intensity * 0.4, (Math.random() - 0.5) * 0.55);
    game.particles.smoke.spawn(p, velocity, {
      r: 0.42, g: 0.39, b: 0.3, size: 0.17 + intensity * 0.12,
      sizeGrow: 0.55, life: 0.42 + intensity * 0.24, gravity: -0.12, drag: 2.2,
    });
  }

  _aiControl(dt, game) {
    const out = this._aiOut;
    out.t = 0; out.s = 0; out.brake = false;
    if (this.aiMode === 'contact' || this.aiMode === 'stopped') { out.brake = true; return out; }
    const route = this.route;
    if (this.aiMode === 'pursue' && game.time - this._aiLastSeenAt < 5.5) {
      const dx = this._aiLastSeen.x - this.pos.x, dz = this._aiLastSeen.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 14) { this.aiMode = 'contact'; out.brake = true; return out; }
      const desired = Math.atan2(-dx, -dz);
      let diff = desired - this.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      out.s = THREE.MathUtils.clamp(-diff * 1.25, -1, 1);
      out.t = Math.abs(diff) < 1.1 ? 0.74 : 0.26;
      return out;
    }
    if (this.aiMode === 'pursue') this.aiMode = 'patrol';
    if (!route || !route.length) return out;
    const wp = route[this.routeIdx % route.length];
    if (!wp) return out;
    const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 3.5) {
      if (this._arrivedRouteIdx !== this.routeIdx) {
        this._arrivedRouteIdx = this.routeIdx;
        this._aiPauseT = 0.42;
      }
      if (this._aiPauseT > 0) {
        this._aiPauseT = Math.max(0, this._aiPauseT - dt);
        out.brake = true;
        return out;
      }
      this.routeIdx = (this.routeIdx + 1) % route.length;
      this._arrivedRouteIdx = -1;
    }
    const targetWp = route[this.routeIdx % route.length] || wp;
    const target = this._tmp.set(targetWp.x - this.pos.x, 0, targetWp.z - this.pos.z);
    const desired = Math.atan2(-target.x, -target.z);
    let diff = desired - this.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const dir = _WORLD_FWD.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
    const obstacle = game.physics.raycast(this._tmp2.set(this.pos.x, this.pos.y + 0.82, this.pos.z), dir, Math.min(7, dist));
    if (obstacle && obstacle.dist < Math.min(4.1, dist)) {
      out.brake = true;
      out.t = obstacle.dist < 1.8 ? -0.3 : 0.08;
      const side = Math.sign(Math.sin(diff) || (this.idTag && this.idTag.length % 2 ? 1 : -1));
      out.s = -side * 0.56;
      this._aiPauseT = Math.max(this._aiPauseT, 0.45);
      return out;
    }
    out.s = THREE.MathUtils.clamp(-diff * 1.6, -1, 1);
    const retreating = this.aiMode === 'retreat';
    const desiredSpeed = Math.min(this.def.top * (retreating ? 0.78 : Math.abs(diff) > 0.72 ? 0.3 : 0.7), Math.max(3, dist * 0.52));
    out.t = this.speed > desiredSpeed ? 0 : (retreating ? 0.9 : 0.72);
    if (dist < 5) out.brake = true;
    return out;
  }

  _detectAIContact(dt, game) {
    if (!this.hostileCrew || this.crewDismounted || !game.player || !game.player.alive) return false;
    const eye = this._tmp.set(this.pos.x, this.pos.y + (this.isHelicopter ? 2.1 : this.def.seatH), this.pos.z);
    const playerEye = this._tmp2.set(game.player.pos.x, game.player.pos.y + 1.0, game.player.pos.z);
    const toP = this._tmp3.copy(playerEye).sub(eye);
    const distance = toP.length();
    if (distance > (this.isHelicopter ? 70 : 56) || distance < 2) { this._aiContactT = Math.max(0, this._aiContactT - dt * 0.5); return false; }
    toP.multiplyScalar(1 / distance);
    _WORLD_FWD.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
    if (_WORLD_FWD.dot(_RAY_DIR.set(toP.x, 0, toP.z).normalize()) < Math.cos(62 * DEG)) return false;
    if (!game.physics.hasLOS(eye, playerEye)) return false;
    if (game.throwables && game.throwables.smokeBlocksLOS(eye, playerEye)) return false;
    this._aiContactT += dt;
    this._aiLastSeen.copy(game.player.pos);
    this._aiLastSeenAt = game.time;
    return this._aiContactT > 0.9;
  }

  _dismountCrew(game) {
    if (this.crewDismounted || !this.hostileCrew || !game.enemies || !game.enemies.spawnVehicleCrew) return;
    this.crewDismounted = true;
    this.aiMode = 'contact';
    this.route = null;
    this.speed = 0;
    this.setDoor(true, -1);
    if (game.audio && game.audio.doorSound) game.audio.doorSound(this.pos, 'open');
    game.enemies.spawnVehicleCrew(this, this.crewKinds);
    if (game.ui && game.ui.radio) game.ui.radio('HOSTILE VEHICLE CREW DISMOUNTING');
  }

  _updateHelicopter(dt, game, control) {
    const def = this.def;
    const engineWant = this.driver === 'player' || this.driver === 'ai';
    const rotorTarget = engineWant && this.drivable ? 1 : 0;
    this.rotorPower += (rotorTarget - this.rotorPower) * Math.min(1, dt * (rotorTarget ? 0.52 : 0.32));
    const ai = this.driver === 'ai';
    let forwardControl = control.throttle;
    let yawControl = control.steer;
    let climbControl = control.collective;
    let hover = control.hover;
    if (ai && this.route && this.route.length) {
      const pilot = this._heliAIControl(dt);
      forwardControl = pilot.t; yawControl = pilot.s; climbControl = pilot.collective; hover = false;
    }

    if (hover) {
      if (this.hoverAltitude == null) this.hoverAltitude = this.pos.y;
      const error = this.hoverAltitude - this.pos.y;
      const hold = THREE.MathUtils.clamp(0.5 + error * 0.16 - this.vy * 0.105, 0.18, 0.86);
      this.collective += (hold - this.collective) * Math.min(1, dt * 2.2);
    } else {
      this.hoverAltitude = null;
      const collectiveTarget = THREE.MathUtils.clamp(0.5 + THREE.MathUtils.clamp(climbControl, -1, 1) * 0.43, 0.04, 0.96);
      this.collective += (collectiveTarget - this.collective) * Math.min(1, dt * 1.35);
    }

    const damaged = this.hp < def.hp * 0.3 ? 0.62 : this.hp < def.hp * 0.58 ? 0.82 : 1;
    const verticalAcceleration = (this.collective * 19.62 * this.rotorPower - 9.81) * damaged - this.vy * 1.42;
    this.vy = THREE.MathUtils.clamp(this.vy + verticalAcceleration * dt, -11, 8.5);
    this.speed += forwardControl * def.accel * damaged * dt;
    this.speed *= Math.max(0, 1 - (0.22 + Math.abs(this.speed) * 0.009) * dt);
    this.speed = THREE.MathUtils.clamp(this.speed, -def.top * 0.42, def.top * damaged);
    const yawRate = def.yawRate * (0.35 + Math.min(1, Math.abs(this.speed) / 18));
    if (Math.abs(yawControl) > 0.02) this.heading += yawControl * yawRate * dt;
    this.heading = THREE.MathUtils.euclideanModulo(this.heading + Math.PI, Math.PI * 2) - Math.PI;
    _WORLD_FWD.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
    this.velocityXZ = this.velocityXZ || new THREE.Vector3();
    this.velocityXZ.addScaledVector(_WORLD_FWD, this.speed * dt * 1.6);
    this.velocityXZ.multiplyScalar(Math.exp(-0.18 * dt));
    const horizontalMax = def.top * 0.88;
    const hSpeed = this.velocityXZ.length();
    if (hSpeed > horizontalMax) this.velocityXZ.multiplyScalar(horizontalMax / hSpeed);

    this._syncBox();
    game.physics.moveBox(this.box, this.velocityXZ.x * dt, this.vy * dt, this.velocityXZ.z * dt, this._moveOut, 0, this._moveOpts || (this._moveOpts = { actors: false, ignoreBody: null, maxDepenetrate: 0.5 }));
    this.pos.set((this.box.min.x + this.box.max.x) * 0.5, this.box.min.y, (this.box.min.z + this.box.max.z) * 0.5);
    if (this._moveOut.onGround || this.pos.y < 0.012) {
      this.pos.y = Math.max(0.001, this.pos.y);
      if (this.vy < 0) this.vy = 0;
      this.landed = Math.abs(this.vy) < 0.65 && this.velocityXZ.length() < 3;
      if (this.landed) this.velocityXZ.multiplyScalar(Math.exp(-2.4 * dt));
    } else this.landed = false;
    if (this._moveOut.hitCeil) this.vy = Math.min(0, this.vy);
    if (this._moveOut.hitX || this._moveOut.hitZ) {
      const impact = this.velocityXZ.length();
      this.velocityXZ.multiplyScalar(0.18);
      if (impact > 6 && this.crashCd <= 0) {
        this.damage(Math.min(def.hp * 0.3, (impact - 5) * 1.9), game, this.pos, 'body');
        this.crashCd = 0.8;
      }
    }
    this.crashCd = Math.max(0, this.crashCd - dt);
    const bounds = game.world && game.world.bounds;
    if (bounds) {
      const margin = this.def.wd * 0.65;
      this.pos.x = THREE.MathUtils.clamp(this.pos.x, bounds.minX + margin, bounds.maxX - margin);
      this.pos.z = THREE.MathUtils.clamp(this.pos.z, bounds.minZ + margin, bounds.maxZ - margin);
      this._syncBox();
    }
    this.pitchT += (THREE.MathUtils.clamp(-forwardControl * 0.24 - this.speed * 0.006, -0.32, 0.32) - this.pitchT) * Math.min(1, dt * 2.6);
    this.rollT += (THREE.MathUtils.clamp(-yawControl * 0.27 - this.velocityXZ.x * 0.004, -0.34, 0.34) - this.rollT) * Math.min(1, dt * 2.2);
    this.steerVis += (yawControl - this.steerVis) * Math.min(1, dt * 4.2);
  }

  _heliAIControl(dt) {
    const out = this._aiOut;
    out.t = 0; out.s = 0; out.brake = false; out.collective = 0;
    if (!this.route || !this.route.length) return out;
    const wp = this.route[this.routeIdx % this.route.length];
    const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
    const dy = (wp.y || 0) - this.pos.y;
    const dist = Math.hypot(dx, dz);
    if (dist < 5 && Math.abs(dy) < 2.8) this.routeIdx = (this.routeIdx + 1) % this.route.length;
    const desired = Math.atan2(-dx, -dz);
    let diff = desired - this.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    out.s = THREE.MathUtils.clamp(-diff * 0.65, -0.8, 0.8);
    out.t = dist > 8 && Math.abs(diff) < 1.25 ? THREE.MathUtils.clamp(dist / 20, 0.18, 0.7) : 0;
    out.collective = THREE.MathUtils.clamp(dy * 0.25, -0.55, 0.55);
    void dt;
    return out;
  }

  _updatePresentation(dt, game, steer, brake) {
    this.bobT += dt * (1 + Math.abs(this.speed) * 0.24);
    if (this.isHelicopter) {
      if (this._rotor) this._rotor.rotation.y += dt * (this.rotorPower * 46 + (this.engineStarted ? 5 : 0));
      if (this._tailRotor) this._tailRotor.rotation.x += dt * (this.rotorPower * 58 + (this.engineStarted ? 6 : 0));
      if (this._rotorBlur) this._rotorBlur.visible = this.rotorPower > 0.56;
      if (this._tailBlur) this._tailBlur.visible = this.rotorPower > 0.56;
      const bob = this.landed ? Math.sin(this.bobT * 3.1) * 0.015 : Math.sin(this.bobT * 2.8) * 0.026;
      this.model.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
      this.model.rotation.set(this.pitchT, this.heading, this.rollT);
    } else {
      const terrain = this._surfaceAt(game);
      const bump = terrain.grip < 0.75 ? Math.sin(this.bobT * 6) * Math.min(0.04, Math.abs(this.speed) * 0.0014) : Math.sin(this.bobT * 4.2) * Math.min(0.014, Math.abs(this.speed) * 0.0005);
      const accel = (this.speed - (this._previousPresentationSpeed || 0)) / Math.max(dt, 0.001);
      this._previousPresentationSpeed = this.speed;
      this.pitchT += (THREE.MathUtils.clamp(-accel * 0.0068, -0.07, 0.07) - this.pitchT) * Math.min(1, dt * 7.5);
      this.rollT += (THREE.MathUtils.clamp(-steer * this.speed * 0.0025, -0.08, 0.08) - this.rollT) * Math.min(1, dt * 6.5);
      this.model.position.set(this.pos.x, this.pos.y + bump, this.pos.z);
      this.model.rotation.set(this.pitchT, this.heading, this.rollT);
      const spin = (this.speed / Math.max(0.2, this.def.wheelR)) * dt;
      for (const w of this.wheels) {
        w.spin.rotation.y += spin;
        w.pivot.position.y = w.baseY + Math.sin(this.bobT * 8 + w.index) * Math.min(0.014, Math.abs(this.speed) * 0.0004);
        if (w.front) w.pivot.rotation.y = this.steerVis * 0.45;
        if (this.burstTire[w.index]) {
          w.pivot.position.y = w.baseY * 0.79;
          w.tire.material = game.vehicles.mats.rubber;
          w.rim.material = game.vehicles.mats.edge;
        }
      }
      if (this._steeringWheel) this._steeringWheel.rotation.z = this.steerVis * 0.75;
    }
    this._updateDoorAnimation(dt);
    this._updateLighting(game, dt, brake, steer);
    this._updateDamageFx(game, dt);
    this._updateMotorAudio(game, dt);
  }

  _updateLighting(game, dt, brake, steer) {
    const night = game.world && game.world.lightMode === 'night';
    const active = (this.driver === 'player' || this.driver === 'ai') && this.hp > 0;
    this.headlightsOn = !!(night && active && !this.lightsBroken);
    for (let i = 0; i < this.headLights.length; i++) {
      const light = this.headLights[i];
      light.material = this.headlightsOn ? game.vehicles.mats.headOn : game.vehicles.mats.headOff;
    }
    for (const beam of this.lightBeams) beam.visible = this.headlightsOn;
    const tailMat = active ? game.vehicles.mats.tailOn : game.vehicles.mats.tailOff;
    for (const l of this.tailLights) l.material = tailMat;
    const brakeMat = brake || (this.driver === 'player' && this.speed < -0.4) ? game.vehicles.mats.brakeOn : game.vehicles.mats.tailOff;
    for (const l of this.brakeLights) l.material = brakeMat;
    this.indicatorT += dt;
    const blink = Math.floor(this.indicatorT * 2.4) % 2 === 0;
    const turnSide = steer > 0.24 ? -1 : steer < -0.24 ? 1 : 0;
    for (const item of this.indicators) {
      const on = item.emergency ? active && blink : turnSide === item.side && blink;
      item.mesh.material = on ? game.vehicles.mats.indicatorOn : game.vehicles.mats.indicatorOff;
    }
  }

  _updateDamageFx(game, dt) {
    const st = this.state;
    if (st !== 'damaged' && st !== 'severe' && st !== 'disabled') return;
    this.smokeT -= dt;
    if (this.smokeT > 0 || !game.particles || !game.particles.smoke) return;
    this.smokeT = st === 'disabled' ? 0.2 : st === 'severe' ? 0.34 : 0.65;
    const fwd = _WORLD_FWD.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
    const p = this._tmp.copy(this.pos).addScaledVector(fwd, this.isHelicopter ? -0.4 : -this.def.hl * 0.46).setY(this.pos.y + (this.isHelicopter ? 1.75 : this.def.h * 0.68));
    const velocity = game._tmpV2 || this._tmp2;
    velocity.set((Math.random() - 0.5) * 0.26, 0.85 + Math.random() * 0.55, (Math.random() - 0.5) * 0.26);
    game.particles.smoke.spawn(p, velocity, {
      r: st === 'damaged' ? 0.42 : 0.12, g: st === 'damaged' ? 0.42 : 0.12, b: st === 'damaged' ? 0.39 : 0.13,
      size: st === 'damaged' ? 0.24 : 0.42, sizeGrow: 1.1, life: 1.2, gravity: -0.25, drag: 1.3,
    });
  }

  _updateMotorAudio(game, dt) {
    // AudioSystem exposes a shared low-cost engine/rotor loop. The manager
    // selects one active/nearest vehicle once per frame; individual cars only
    // schedule gameplay noise on a throttled timer here.
    this._noiseT -= dt;
    if ((this.driver === 'player' || this.driver === 'ai') && Math.abs(this.speed) > (this.isHelicopter ? 2 : 1.5) && this._noiseT <= 0) {
      this._noiseT = this.isHelicopter ? 1.0 : 0.65;
      if (game.emitNoise) game.emitNoise(this.pos, this.isHelicopter ? 38 + Math.abs(this.speed) : 12 + Math.abs(this.speed) * 0.85, this.isHelicopter ? 'rotor' : 'machine', this);
    }
  }

  updateCamera(dt, game) {
    const input = game.input || {};
    const sens = (game.settings && game.settings.sensitivity || 1) * 0.0022;
    this.cameraYaw = (this.cameraYaw || 0) + (input.lookX || 0) * sens;
    this.cameraPitch = THREE.MathUtils.clamp((this.cameraPitch == null ? 0.22 : this.cameraPitch) - (input.lookY || 0) * sens, this.isHelicopter ? -0.16 : -0.22, 0.82);
    const cam = game.camera;
    if (!cam) return;
    const fwd = _WORLD_FWD.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
    if (this.firstPerson) {
      if (this.isHelicopter) {
        this._tmp.copy(this.localToWorld(-0.33, this.def.seatH, -0.42, this._tmp));
      } else {
        this._tmp.copy(this.localToWorld(-this.def.wd * 0.17, this.def.seatH, -this.def.hl * 0.25, this._tmp));
      }
      cam.position.lerp(this._tmp, 1 - Math.exp(-18 * dt));
      const angle = this.heading + (this.cameraYaw || 0);
      _CAM_DIR.set(-Math.sin(angle) * Math.cos(this.cameraPitch), Math.sin(this.cameraPitch), -Math.cos(angle) * Math.cos(this.cameraPitch));
      this._tmp2.copy(cam.position).addScaledVector(_CAM_DIR, 18);
      cam.up.set(0, 1, 0);
      cam.lookAt(this._tmp2);
    } else {
      const distance = this.isHelicopter ? this.def.camDist : (this.def.camDist || 7.4) + Math.min(2.8, Math.abs(this.speed) * 0.065);
      const orbit = this.heading + (this.cameraYaw || 0);
      const horiz = Math.cos(this.cameraPitch);
      const anchorY = this.pos.y + (this.isHelicopter ? 2.0 : Math.min(1.5, this.def.h * 0.62));
      this._tmp.set(this.pos.x + Math.sin(orbit) * distance * horiz,
        anchorY + Math.sin(this.cameraPitch) * distance,
        this.pos.z + Math.cos(orbit) * distance * horiz);
      this._tmp2.set(this.pos.x, anchorY, this.pos.z);
      const delta = _CAM_DIR.copy(this._tmp).sub(this._tmp2);
      const len = delta.length();
      if (len > 0.1) {
        delta.divideScalar(len);
        const hit = game.physics.raycast(this._tmp2, delta, len);
        if (hit && hit.dist < len) this._tmp.copy(this._tmp2).addScaledVector(delta, Math.max(1.8, hit.dist - 0.48));
      }
      const k = 1 - Math.exp(-7.2 * dt);
      cam.position.lerp(this._tmp, k);
      const lead = THREE.MathUtils.clamp(Math.abs(this.speed) * 0.18, 0, 5);
      const aimX = this.pos.x - fwd.x * lead;
      const aimZ = this.pos.z - fwd.z * lead;
      cam.up.set(0, 1, 0);
      cam.lookAt(aimX, anchorY + (this.isHelicopter ? 0.15 : 0.1), aimZ);
    }
    if (this.isHelicopter && !this.firstPerson) {
      cam.rotation.z = this.rollT * 0.18;
    }
  }

  toggleHorn() {
    if (this.game.audio && this.game.audio.vehicleHorn) this.game.audio.vehicleHorn(this.pos);
    if (this.game.emitNoise) this.game.emitNoise(this.pos, 32, 'horn', this, 0.75);
  }
}

// ---------------------------------------------------------------------------
export class VehicleManager {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.group = new THREE.Group();
    this.group.name = 'vehicles';
    game.scene.add(this.group);
    this._geometries = new Map();
    this._materials = new Map();
    this.mats = makeMats(this);
    this._idSeq = 0;
    this._query = [];
    this._collisionMin = new THREE.Vector3();
    this._collisionMax = new THREE.Vector3();
    this._candidateBox = { min: new THREE.Vector3(), max: new THREE.Vector3() };
    this._surfaceScratch = { grip: 1, drag: 0.1, dust: 0 };
  }

  geometry(key, factory) {
    let g = this._geometries.get(key);
    if (!g) { g = factory(); this._geometries.set(key, g); }
    return g;
  }
  material(key, factory) {
    let m = this._materials.get(key);
    if (!m) { m = factory(); this._materials.set(key, m); }
    return m;
  }

  reset() {
    for (const v of this.list) {
      if (v._engineActive && this.game.audio && this.game.audio.engineStop) this.game.audio.engineStop(v._engineId);
      unregisterActorBody(this.game.physics, v);
      this.group.remove(v.model);
      // The model's authored primitive geometry/materials are shared caches;
      // only dispose the per-instance merged buffers created for this model.
      for (const geometry of (v.model.userData._staticBatchGeometries || [])) geometry.dispose();
      v.model.userData._staticBatchGeometries = [];
    }
    this.list.length = 0;
    this._idSeq = 0;
    const interactables = this.game.world ? this.game.world.interactables : null;
    if (interactables) {
      for (let i = interactables.length - 1; i >= 0; i--) {
        const id = interactables[i].id || '';
        if (id.startsWith('veh_') || id.startsWith('trunk_')) interactables.splice(i, 1);
      }
    }
  }

  setMissionHelicopterAvailable(available) {
    const ready = !!available;
    for (const v of this.list) {
      if (!v.isHelicopter || !v.mission) continue;
      v.extractionLocked = !ready;
      if (v.model) v.model.visible = ready;
      if (v._details) v._details.visible = ready;
    }
  }

  spawnFromWorld() {
    const spawns = (this.game.world && this.game.world.vehicleSpawns) || [];
    for (const spawn of spawns) {
      const v = new Vehicle(this, spawn);
      v.idTag = 'v' + (this._idSeq++);
      v._engineId = 'vehicle-' + v.idTag;
      this.list.push(v);
      this.game.world.interactables.push({
        id: 'veh_' + v.idTag,
        pos: v.driverDoorWorld(new THREE.Vector3()),
        // Boarding is door-gated: the generic camera-ray picker must never hand
        // out a vehicle, otherwise the operator could enter from the far side of
        // the hull or from across a courtyard. `hidden` opts this entry out; the
        // strict driver-door query in VehicleManager.boardingCandidate() owns it.
        radius: 0,
        reach: v.isHelicopter ? 1.85 : 1.5,
        hidden: true,
        vehicleEntry: true,
        prompt: 'PRESS [F] — ENTER VEHICLE',
        getPrompt: () => {
          if (!v.drivable) return 'WRECKED — UNDRIVABLE';
          if (v.isHelicopter && v.extractionLocked) return 'EXTRACTION NOT READY';
          if (v.isHelicopter && (v.pos.y > 1.25 || !v.landed && v.pos.y > 0.5)) return 'AIRBORNE — WAIT TO BOARD';
          if (v.driver === 'ai' && Math.abs(v.speed) > 2.5) return 'MOVING — CANNOT BOARD';
          return 'PRESS [F] — ENTER VEHICLE';
        },
        doorTest: (playerPos, game, out) => v.canBoardFrom(playerPos, game, out),
        hold: 0.42,
        used: false,
        reusable: true,
        vehicle: v,
        isVehicleInteraction: true,
        action: (game) => {
          if (!v.drivable) { game.ui.toastBrief('THE VEHICLE IS WRECKED'); return false; }
          if (v.isHelicopter && v.extractionLocked) { game.ui.toastBrief('EXTRACTION NOT READY'); return false; }
          if (v.isHelicopter && (v.pos.y > 1.25 || !v.landed && v.pos.y > 0.5)) { game.ui.toastBrief('LAND BEFORE BOARDING'); return false; }
          if (v.driver === 'ai' && Math.abs(v.speed) > 2.5) return false;
          game.enterVehicle(v);
          return false;
        },
        reset: function () { this.used = false; },
      });
      if (!v.isHelicopter && v.def.cargo) {
        this.game.world.interactables.push({
          id: 'trunk_' + v.idTag,
          pos: v.localToWorld(0, 0.9, v.def.hl + 0.55, new THREE.Vector3()),
          radius: 2.0,
          prompt: 'SEARCH VEHICLE STORAGE',
          hold: 0.7,
          used: false,
          reusable: false,
          vehicle: v,
          trunk: true,
          reset() { this.used = false; },
          action: (game) => {
            const roll = Math.random();
            const w = game.weapons.def, st = game.weapons.state[w.id];
            const addAmmo = () => { const add = w.magSize * 2; st.reserve = Math.min(w.reserveMax, st.reserve + add); return 'SPARE ' + w.name + ' AMMO +' + add; };
            let msg;
            if (roll < 0.28) msg = 'STORAGE IS EMPTY';
            else if (roll < 0.6) msg = addAmmo();
            else if (roll < 0.8) msg = game.throwables.addOne('vxfrag') ? 'VX-FRAG ×1' : addAmmo();
            else msg = game.throwables.addOne('medkit') ? 'FIELD MEDKIT ×1' : addAmmo();
            game.audio.pickup(v.pos);
            game.ui.toastBrief(msg);
            return true;
          },
        });
      }
    }
  }

  /**
   * The vehicle, if any, that the operator may currently board: he has to be at
   * the driver's door (or the designated entry point of a doorless vehicle),
   * within reach, on the correct side of the hull, with a clear line to the
   * aperture. Nearest valid candidate wins.
   */
  boardingCandidate(player, out) {
    const res = out || { vehicle: null, interactable: null, distance: Infinity, reason: '' };
    res.vehicle = null; res.interactable = null; res.distance = Infinity; res.reason = '';
    if (!player) return res;
    const interactables = this.game.world && this.game.world.interactables;
    let best = null, bestD = Infinity, bestReason = '';
    for (const v of this.list) {
      if (v.driver === 'player') continue;
      const d = Math.hypot(v.pos.x - player.pos.x, v.pos.z - player.pos.z);
      const reach = (v.isHelicopter ? 1.85 : 1.5) + Math.max(v.def.wd, v.def.hl) * 0.35;
      if (d > reach + 2.5) continue;                 // cheap reject before the strict test
      const test = v.canBoardFrom(player.pos, this.game, v._boardRes || (v._boardRes = { ok: false, reason: '' }));
      if (test.ok) {
        if (test.distance < bestD) { bestD = test.distance; best = v; bestReason = ''; }
      } else if (!best && !bestReason && d < reach && test.reason) {
        bestReason = test.reason;                     // near but not boardable: feedback only
      }
    }
    res.reason = best ? 'READY' : bestReason;
    if (!best) return res;
    res.vehicle = best;
    res.distance = bestD;
    if (interactables) res.interactable = interactables.find(it => it.vehicle === best && it.vehicleEntry) || null;
    return res;
  }

  byTag(tag) { return this.list.find(v => v.tag === tag) || null; }
  byId(interactId) {
    const it = this.game.world.interactables.find(i => i.id === interactId);
    return it && it.vehicle ? it.vehicle : null;
  }

  /**
   * Collision-aware egress. Each candidate standing spot beside a door is
   * tested against the *same* unified world query the mover uses: static
   * geometry (walls, barriers, other hulls) plus every dynamic body, with the
   * host vehicle's own hull excluded. The first spot that is genuinely free —
   * with floor under it and a head-height clearance — wins, so the operator is
   * never dropped inside a wall, another vehicle, or a soldier standing at the
   * door. Outward variants per door mean a wall hugging one side simply moves
   * the egress to the next legal spot instead of refusing the exit.
   */
  _safeExit(v, out) {
    const g = this.game;
    if (v.isHelicopter && (!v.landed || v.pos.y > 1.05 || Math.abs(v.vy) > 0.9)) return false;
    const side = v.entryDoorSide || -1;
    const halfW = v.isHelicopter ? 2.2 : v.def.wd * 0.5 + 0.95;
    const variants = [0.0, 0.45, 0.95];
    const offsets = [];
    for (const extra of variants) {
      offsets.push([side * (halfW + extra), 0, -0.2]);                 // driver's door
      offsets.push([side * (halfW + extra), 0, v.def.hl * 0.55]);      // rear door / cabin side
      offsets.push([-side * (halfW + extra), 0, -0.2]);                // far side, last resort
    }
    offsets.push([0, 0, -v.def.hl - 0.95], [0, 0, v.def.hl + 0.95]);   // bow / stern
    const bounds = g.world && g.world.bounds;
    let fallback = null;
    for (const offset of offsets) {
      v.localToWorld(offset[0], 0, offset[2], out);
      out.y = Math.max(0, v.pos.y);
      if (bounds && (out.x < bounds.minX + 0.65 || out.x > bounds.maxX - 0.65 || out.z < bounds.minZ + 0.65 || out.z > bounds.maxZ - 0.65)) continue;
      _AABB_MIN.set(out.x - 0.34, out.y + 0.03, out.z - 0.34);
      _AABB_MAX.set(out.x + 0.34, out.y + 1.82, out.z + 0.34);
      g.physics.queryAABB(_AABB_MIN, _AABB_MAX, this._query, { actors: true, self: v._body || null });
      const seated = g.player && g.player._body;
      let blocked = false;
      for (const c of this._query) {
        // the host hull (already accounted for) and the seated operator himself
        // are not obstructions to his own egress
        if ((seated && c === seated) || c.entity === v) continue;
        if (c.max.y > _AABB_MIN.y + 0.08 && c.min.y < _AABB_MAX.y - 0.08) { blocked = true; break; }
      }
      if (blocked) {
        // remember the least-bad spot only when nothing else works at all
        if (!fallback && g.physics.isBoxFree(_AABB_MIN, _AABB_MAX, { actors: true })) fallback = out.clone();
        continue;
      }
      if (!fallback) fallback = out.clone();
      _GROUND_TEST.set(out.x, out.y + 1.15, out.z);
      _RAY_DIR.set(0, -1, 0);
      const ground = g.physics.raycast(_GROUND_TEST, _RAY_DIR, 2.5);
      if (!ground || ground.normal.y < 0.55) continue;
      out.y = ground.point.y;
      if (Math.abs(out.y - v.pos.y) > 1.25) continue;
      // and the spot must be free of bodies too (the query above covered it)
      return true;
    }
    if (fallback) {
      // Nothing perfectly clear exists: stand up beside the vehicle at the least
      // obstructed spot and let the solver push the operator out, rather than
      // locking him inside the hull forever.
      out.copy(fallback);
      g.physics.repairSpawnPoint(out, 0.34, 1.8);
      return true;
    }
    return false;
  }

  update(dt) {
    const g = this.game;
    const p = g.player && g.player.pos;
    for (const v of this.list) {
      const d2 = p ? v.pos.distanceToSquared(p) : 0;
      const close = v.driver === 'player' || d2 < 75 * 75;
      if (v.driver === 'ai' && !close) {
        v._aiAccumulator += dt;
        const interval = d2 > 170 * 170 ? 0.34 : d2 > 95 * 95 ? 0.2 : 0.1;
        if (v._aiAccumulator >= interval) {
          const step = Math.min(0.12, v._aiAccumulator);
          v._aiAccumulator -= step;
          v.update(step, g);
        } else {
          v._updateDoorAnimation(dt);
          v._updateDamageFx(g, dt);
        }
      } else if (v.driver || Math.abs(v.speed) > 0.04 || v.isHelicopter && v.rotorPower > 0.02) {
        v._aiAccumulator = 0;
        v.update(dt, g);
      } else {
        v._updateDoorAnimation(dt);
        v._updateDamageFx(g, dt);
      }
      const missionAircraftHidden = v.isHelicopter && v.mission && v.extractionLocked;
      v.model.visible = !missionAircraftHidden && (v === g.vehicleMode || d2 < 250 * 250);
      if (v._details) v._details.visible = !missionAircraftHidden && d2 < (v.isHelicopter ? 135 * 135 : 85 * 85);
      if (v._exitProbeT <= 0 && v.driver === 'player') {
        v._exitProbeT = 0.8;
        if (this._safeExit(v, v._exitTmp)) v._lastSafeExit.copy(v._exitTmp);
      } else v._exitProbeT = Math.max(0, v._exitProbeT - dt);
      const entry = g.world && g.world.interactables.find(it => it.vehicle === v && it.isVehicleInteraction);
      if (entry) v.driverDoorWorld(entry.pos);
      const trunk = g.world && g.world.interactables.find(it => it.vehicle === v && it.trunk);
      if (trunk) v.localToWorld(0, 0.9, v.def.hl + 0.55, trunk.pos);
    }
    this._resolveVehiclePairs();
    // Hulls are moving solid bodies: anyone standing in the road of a rolling
    // vehicle is bowled over (and hurt above plow speed). Runs for vehicles
    // near the operator only, so the 100-mission roster stays cheap.
    if (p) {
      for (const v of this.list) {
        if (v.hp <= 0 || v.pos.distanceToSquared(p) > 60 * 60) continue;
        v._processHullContacts(g, dt);
      }
    }
    this._updateAudio();
  }

  _updateAudio() {
    const g = this.game, audio = g.audio;
    if (!audio || !audio.ready) return;
    let chosen = g.vehicleMode || null;
    let volume = chosen ? 0.78 : 0;
    if (!chosen && g.player) {
      let bestD2 = 62 * 62;
      for (const v of this.list) {
        if (v.driver !== 'ai' || v.hp <= 0 || Math.abs(v.speed) < (v.isHelicopter ? 0.25 : 0.6)) continue;
        const d2 = v.pos.distanceToSquared(g.player.pos);
        if (d2 < bestD2) { bestD2 = d2; chosen = v; volume = 0.36 * (1 - Math.sqrt(d2) / 62); }
      }
    }
    if (!chosen || chosen.hp <= 0) {
      if (audio.engineStop) audio.engineStop();
      if (audio.rotorStop) audio.rotorStop();
      return;
    }
    if (chosen.isHelicopter) {
      if (audio.engineStop) audio.engineStop();
      if (audio.rotorUpdate) audio.rotorUpdate(chosen.rotorPower, volume, chosen.pos, chosen.def.enginePitch);
    } else {
      if (audio.rotorStop) audio.rotorStop();
      if (audio.engineUpdate) {
        const rpm = THREE.MathUtils.clamp(0.12 + Math.abs(chosen.speed) / chosen.def.top * 0.72, 0, 1);
        const load = Math.abs(chosen.speed) < chosen.def.top * 0.58;
        audio.engineUpdate(rpm, load, volume, chosen.pos);
      }
    }
  }

  _resolveVehiclePairs() {
    // Sparse broad-phase: levels have only a few vehicles, so pair tests are
    // inexpensive and are skipped for distant, parked scenery.
    for (let i = 0; i < this.list.length; i++) {
      const a = this.list[i];
      if (a.isHelicopter || a.hp <= 0) continue;
      for (let j = i + 1; j < this.list.length; j++) {
        const b = this.list[j];
        if (b.isHelicopter || b.hp <= 0) continue;
        const ox = Math.min(a.box.max.x, b.box.max.x) - Math.max(a.box.min.x, b.box.min.x);
        const oz = Math.min(a.box.max.z, b.box.max.z) - Math.max(a.box.min.z, b.box.min.z);
        if (ox <= 0 || oz <= 0 || Math.min(a.box.max.y, b.box.max.y) <= Math.max(a.box.min.y, b.box.min.y)) continue;
        const pushB = a.driver === 'player' || b.driver !== 'player';
        const moving = pushB ? b : a;
        const signX = moving.pos.x >= (pushB ? a.pos.x : b.pos.x) ? 1 : -1;
        const signZ = moving.pos.z >= (pushB ? a.pos.z : b.pos.z) ? 1 : -1;
        const useX = ox < oz;
        const amount = (useX ? ox : oz) + 0.035;
        moving.pos[useX ? 'x' : 'z'] += (useX ? signX : signZ) * amount;
        moving.speed *= 0.38;
        moving._syncBox();
        moving.model.position.copy(moving.pos);
      }
    }
  }

  spawnVehicleCrew(vehicle, kinds = ['rifleman', 'assault']) {
    const enemies = this.game.enemies;
    if (!enemies || !enemies.spawnVehicleCrew) return 0;
    return enemies.spawnVehicleCrew(vehicle, kinds);
  }
}
