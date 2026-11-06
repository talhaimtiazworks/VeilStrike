// ============================================================================
// world-structures.js — Modular 3D Military & Tactical Infrastructure Kit
// ============================================================================
// Builds realistic, collidable, multi-entrance, multi-storey combat structures
// directly onto GameWorld so static batching (_prepareBatchBuckets), physics
// AABBs, breakable glass, interactive Doors, destructible targets, tactical AI
// cover points, and HRTF reverb zones all work seamlessly.
// ============================================================================

import * as THREE from 'three';
import { Material as Mat } from './physics.js';
import { Door } from './world.js';

export class StructureBuilder {
  constructor(world, opts = {}) {
    this.world = world;
    this.M = world.mat;
    this.lightCount = 0;
    this.maxPointLights = opts.maxPointLights == null ? 8 : opts.maxPointLights;
    this.keepouts = [];
    this.elevatedNodes = []; // [{ x, y, z, tag }] for rooftop/tower/gallery spawns & objectives
    this.interiorNodes = []; // [{ x, y, z, tag }] for indoor rooms/vaults/corridors
  }

  // --------------------------------------------------------------------------
  // Keepout & Material Helpers
  // --------------------------------------------------------------------------
  reserveArea(x, z, w, d, pad = 2.0) {
    this.keepouts.push({
      minX: x - w * 0.5 - pad,
      maxX: x + w * 0.5 + pad,
      minZ: z - d * 0.5 - pad,
      maxZ: z + d * 0.5 + pad,
    });
  }

  isAreaClear(x, z, w = 2.0, d = 2.0) {
    const x0 = x - w * 0.5;
    const x1 = x + w * 0.5;
    const z0 = z - d * 0.5;
    const z1 = z + d * 0.5;
    const b = this.world.bounds;
    if (b && (x0 < b.minX + 3 || x1 > b.maxX - 3 || z0 < b.minZ + 3 || z1 > b.maxZ - 3)) {
      return false;
    }
    for (const k of this.keepouts) {
      if (x1 > k.minX && x0 < k.maxX && z1 > k.minZ && z0 < k.maxZ) return false;
    }
    return true;
  }

  tintedConcrete(hex, rep = 4) {
    return this.world._cached(`s_conc_${hex}_${rep}`, () => {
      const m = this.M.concrete(rep).clone();
      m.color = new THREE.Color(hex);
      return m;
    });
  }

  waterMat(hex = 0x163244) {
    return this.world._cached(`s_water_${hex}`, () => new THREE.MeshStandardMaterial({
      color: hex,
      roughness: 0.16,
      metalness: 0.55,
    }));
  }

  grassMat(hex = 0x455338, rep = 24) {
    return this.world._cached(`s_grass_${hex}_${rep}`, () => {
      const m = this.M.gravel(rep).clone();
      m.color = new THREE.Color(hex);
      m.roughness = 0.96;
      return m;
    });
  }

  hazardMat() {
    return this.world._cached('s_hazard_yellow', () => new THREE.MeshStandardMaterial({
      color: 0xc59b27,
      roughness: 0.65,
      metalness: 0.25,
    }));
  }

  addFixtureLight(x, y, z, color = 0xffe2b0, intensity = 22, dist = 16, warmSodium = false) {
    const fixtureMat = warmSodium ? this.M.emissiveSodium : this.M.emissiveLamp;
    this.world.box(x, y, z, 0.48, 0.1, 0.22, fixtureMat, Mat.METAL, { noCollider: true, cast: false });
    if (this.lightCount < this.maxPointLights) {
      this.lightCount++;
      const l = new THREE.PointLight(color, intensity, dist, 1.9);
      l.position.set(x, y - 0.12, z);
      l.userData.base = l.intensity;
      this.world.group.add(l);
      this.world.allLights.push(l);
    }
  }

  addZone(x, y, z, w, h, d, type = 'room') {
    this.world.zones.push({
      min: new THREE.Vector3(x - w * 0.5, y, z - d * 0.5),
      max: new THREE.Vector3(x + w * 0.5, y + h, z + d * 0.5),
      type,
    });
  }

  addCoverRing(x, z, w, d, y = 0) {
    if (y > 0.6) return;
    this.world._cover(x, z + d * 0.5 + 0.85, 0, 1);
    this.world._cover(x, z - d * 0.5 - 0.85, 0, -1);
    this.world._cover(x + w * 0.5 + 0.85, z, 1, 0);
    this.world._cover(x - w * 0.5 - 0.85, z, -1, 0);
  }

  // --------------------------------------------------------------------------
  // Walkable Stair Flight (<= 0.24m risers so Player & AI step-up smoothly)
  // dir: '+z' | '-z' | '+x' | '-x'
  // --------------------------------------------------------------------------
  addStairFlight(x0, y0, z0, length, rise, width, dir = '+z', mat = null) {
    const M = mat || this.M.concrete(2);
    const steps = Math.max(3, Math.ceil(Math.abs(rise) / 0.23));
    const stepRise = rise / steps;
    const stepRun = length / steps;
    for (let i = 0; i < steps; i++) {
      const h = Math.max(0.18, Math.abs(stepRise) + 0.06);
      const sy = y0 + (i + 1) * stepRise - h;
      if (dir === '+z' || dir === '-z') {
        const sgn = dir === '+z' ? 1 : -1;
        const sz = z0 + sgn * (i + 0.5) * stepRun;
        this.world.box(x0, Math.max(0, sy), sz, width, h, stepRun + 0.04, M, Mat.CONCRETE);
      } else {
        const sgn = dir === '+x' ? 1 : -1;
        const sx = x0 + sgn * (i + 0.5) * stepRun;
        this.world.box(sx, Math.max(0, sy), z0, stepRun + 0.04, h, width, M, Mat.CONCRETE);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Wall Run with Optional Doorway & Window Openings
  // axis: 'x' (wall runs along X at fixed Z) | 'z' (wall runs along Z at fixed X)
  // --------------------------------------------------------------------------
  addWallWithOpening(cx, y, cz, length, height, thick, axis, mat, opts = {}) {
    const w = this.world;
    const doorW = opts.doorWidth || 0;
    const doorOff = opts.doorOffset || 0;
    const doorH = opts.doorHeight || 2.3;
    const winCount = opts.windows || 0;

    if (doorW <= 0 && winCount <= 0) {
      if (axis === 'x') w.box(cx, y, cz, length, height, thick, mat, Mat.CONCRETE);
      else w.box(cx, y, cz, thick, height, length, mat, Mat.CONCRETE);
      return;
    }

    if (doorW > 0) {
      const half = length * 0.5;
      const dLeft = doorOff - doorW * 0.5;
      const dRight = doorOff + doorW * 0.5;
      const seg1Len = Math.max(0, dLeft - (-half));
      const seg2Len = Math.max(0, half - dRight);
      const lintelH = Math.max(0.2, height - doorH);

      if (axis === 'x') {
        if (seg1Len > 0.15) w.box(cx - half + seg1Len * 0.5, y, cz, seg1Len, height, thick, mat, Mat.CONCRETE);
        if (seg2Len > 0.15) w.box(cx + half - seg2Len * 0.5, y, cz, seg2Len, height, thick, mat, Mat.CONCRETE);
        if (lintelH > 0.05) w.box(cx + doorOff, y + doorH, cz, doorW, lintelH, thick, mat, Mat.CONCRETE);
        if (opts.withDoor) {
          new Door(w, {
            position: new THREE.Vector3(cx + dLeft + 0.04, y, cz),
            rotY: 0,
            width: Math.min(1.35, doorW - 0.08),
            height: doorH - 0.04,
            slideUp: !!opts.slideUp,
            locked: !!opts.locked,
          });
        }
      } else {
        if (seg1Len > 0.15) w.box(cx, y, cz - half + seg1Len * 0.5, thick, height, seg1Len, mat, Mat.CONCRETE);
        if (seg2Len > 0.15) w.box(cx, y, cz + half - seg2Len * 0.5, thick, height, seg2Len, mat, Mat.CONCRETE);
        if (lintelH > 0.05) w.box(cx, y + doorH, cz + doorOff, thick, lintelH, doorW, mat, Mat.CONCRETE);
        if (opts.withDoor) {
          new Door(w, {
            position: new THREE.Vector3(cx, y, cz + dRight - 0.04),
            rotY: Math.PI * 0.5,
            width: Math.min(1.35, doorW - 0.08),
            height: doorH - 0.04,
            slideUp: !!opts.slideUp,
            locked: !!opts.locked,
          });
        }
      }
      return;
    }

    // Windowed wall: sill + header + piers + breakable glass panes
    const sillH = 1.05;
    const winH = Math.min(1.35, Math.max(0.8, height - 1.75));
    const headY = sillH + winH;
    const headH = Math.max(0.25, height - headY);
    if (axis === 'x') {
      w.box(cx, y, cz, length, sillH, thick, mat, Mat.CONCRETE);
      w.box(cx, y + headY, cz, length, headH, thick, mat, Mat.CONCRETE);
      const bay = length / winCount;
      const winW = Math.min(2.1, bay * 0.56);
      const pierW = (bay - winW) * 0.5;
      for (let i = 0; i < winCount; i++) {
        const bx = cx - length * 0.5 + (i + 0.5) * bay;
        w.box(bx - winW * 0.5 - pierW * 0.5, y + sillH, cz, pierW, winH, thick, mat, Mat.CONCRETE);
        w.box(bx + winW * 0.5 + pierW * 0.5, y + sillH, cz, pierW, winH, thick, mat, Mat.CONCRETE);
        w._window(bx, y + sillH, cz, winW, winH, 'z');
      }
    } else {
      w.box(cx, y, cz, thick, sillH, length, mat, Mat.CONCRETE);
      w.box(cx, y + headY, cz, thick, headH, length, mat, Mat.CONCRETE);
      const bay = length / winCount;
      const winW = Math.min(2.1, bay * 0.56);
      const pierW = (bay - winW) * 0.5;
      for (let i = 0; i < winCount; i++) {
        const bz = cz - length * 0.5 + (i + 0.5) * bay;
        w.box(cx, y + sillH, bz - winW * 0.5 - pierW * 0.5, thick, winH, pierW, mat, Mat.CONCRETE);
        w.box(cx, y + sillH, bz + winW * 0.5 + pierW * 0.5, thick, winH, pierW, mat, Mat.CONCRETE);
        w._window(cx, y + sillH, bz - winW * 0.5, winW, winH, 'x');
      }
    }
  }

  // --------------------------------------------------------------------------
  // 1. Paved Roadways & Intersections
  // --------------------------------------------------------------------------
  addRoadSegment(x, z, w, d, axis = 'z', opts = {}) {
    const asp = this.M.asphalt(Math.max(4, Math.round(Math.max(w, d) / 4)));
    const curb = this.M.concrete(3);
    const stripeMat = this.world._cached('road_stripe_mat', () => new THREE.MeshStandardMaterial({
      color: 0xd8c98e, roughness: 0.85, metalness: 0,
    }));
    this.world.box(x, 0.01, z, w, 0.03, d, asp, Mat.CONCRETE, { noCollider: true, cast: false });
    this.world._addVehicleSurface(x, z, w, d, { grip: 1.0, drag: 0.045, dust: 0.02, material: 'asphalt' });

    if (axis === 'z') {
      if (opts.curbs !== false) {
        this.world.box(x - w * 0.5 - 0.2, 0, z, 0.35, 0.14, d, curb, Mat.CONCRETE, { noCollider: true });
        this.world.box(x + w * 0.5 + 0.2, 0, z, 0.35, 0.14, d, curb, Mat.CONCRETE, { noCollider: true });
      }
      const dashes = Math.floor(d / 6);
      for (let i = 0; i < dashes; i++) {
        const dz = z - d * 0.5 + 3 + i * 6;
        this.world.box(x, 0.042, dz, 0.18, 0.01, 2.4, stripeMat, Mat.CONCRETE, { noCollider: true, cast: false });
      }
    } else {
      if (opts.curbs !== false) {
        this.world.box(x, 0, z - d * 0.5 - 0.2, w, 0.14, 0.35, curb, Mat.CONCRETE, { noCollider: true });
        this.world.box(x, 0, z + d * 0.5 + 0.2, w, 0.14, 0.35, curb, Mat.CONCRETE, { noCollider: true });
      }
      const dashes = Math.floor(w / 6);
      for (let i = 0; i < dashes; i++) {
        const dx = x - w * 0.5 + 3 + i * 6;
        this.world.box(dx, 0.042, z, 2.4, 0.01, 0.18, stripeMat, Mat.CONCRETE, { noCollider: true, cast: false });
      }
    }
    this.reserveArea(x, z, w, d, 0.8);
  }

  addIntersection(x, z, size = 11) {
    const asp = this.M.asphalt(3);
    this.world.box(x, 0.014, z, size, 0.03, size, asp, Mat.CONCRETE, { noCollider: true, cast: false });
    this.reserveArea(x, z, size, size, 1.0);
  }

  // --------------------------------------------------------------------------
  // 2. Multi-Storey Building (2 or 3 floors + interior stairs + roof access)
  // --------------------------------------------------------------------------
  addMultiStoreyBuilding(x, z, w = 14, d = 12, floors = 2, opts = {}) {
    const world = this.world;
    const wallMat = opts.wallMat || (opts.brick ? this.M.brick(5) : this.tintedConcrete(opts.tint || 0x8d8b84, 4));
    const floorMat = this.M.floorConc(6);
    const trimMat = this.M.metalDark;
    const floorH = 3.6;
    const totalH = floors * floorH;
    const t = 0.36;

    this.reserveArea(x, z, w, d, 2.6);
    this.addCoverRing(x, z, w, d, 0);

    // Ground floor slab
    world.box(x, 0, z, w, 0.12, d, floorMat, Mat.CONCRETE);

    // Stairwell shaft on the -X side (width 2.4m, runs along Z)
    const stairW = 2.3;
    const stairX = x - w * 0.5 + t + stairW * 0.5 + 0.15;
    const stairRun = Math.min(6.4, d - 3.6);

    for (let f = 0; f < floors; f++) {
      const fy = f * floorH;
      const isGround = f === 0;
      const frontDoor = isGround ? { doorWidth: 2.2, doorOffset: 1.6, doorHeight: 2.45, withDoor: opts.doors !== false } : { windows: 3 };
      const backDoor = isGround ? { doorWidth: 2.0, doorOffset: -1.4, doorHeight: 2.4, withDoor: false } : { windows: 2 };
      const rightSide = isGround && opts.sideEntry ? { doorWidth: 1.9, doorOffset: 0, doorHeight: 2.35 } : { windows: 2 };

      // South (+Z), North (-Z), East (+X), West (-X) outer walls
      this.addWallWithOpening(x, fy, z + d * 0.5 - t * 0.5, w, floorH, t, 'x', wallMat, frontDoor);
      this.addWallWithOpening(x, fy, z - d * 0.5 + t * 0.5, w, floorH, t, 'x', wallMat, backDoor);
      this.addWallWithOpening(x + w * 0.5 - t * 0.5, fy, z, d - t * 2, floorH, t, 'z', wallMat, rightSide);
      this.addWallWithOpening(x - w * 0.5 + t * 0.5, fy, z, d - t * 2, floorH, t, 'z', wallMat, isGround ? {} : { windows: 2 });

      // Interior partition creating 2 tactical rooms + hallway per floor
      const partX = x + 1.4;
      world.box(partX, fy, z - d * 0.26, 0.24, floorH - 0.2, d * 0.36, this.M.concrete(2), Mat.CONCRETE);
      world._cover(partX - 0.8, z - 0.4, -1, 0);
      world._cover(partX + 0.8, z - 0.4, 1, 0);

      // Tactical interior cover (desks / server consoles / crates)
      world.box(x + w * 0.25, fy + 0.12, z + d * 0.18, 1.8, 0.9, 0.8, trimMat, Mat.METAL);
      this.interiorNodes.push({ x: x + w * 0.22, y: fy + 0.14, z: z - d * 0.18, tag: f === 0 ? 'ground_room' : `floor_${f + 1}` });

      // Upper floor / roof slab with stairwell cutout on -X
      const slabY = (f + 1) * floorH - 0.22;
      const mainSlabW = w - stairW - t * 2 - 0.4;
      world.box(x + (stairW + 0.4) * 0.5, slabY, z, mainSlabW, 0.24, d - t * 2, floorMat, Mat.CONCRETE);
      // North & South landing strips around the stair opening
      const landD = (d - t * 2 - stairRun) * 0.5;
      if (landD > 0.5) {
        world.box(stairX, slabY, z - d * 0.5 + t + landD * 0.5, stairW + 0.4, 0.24, landD, floorMat, Mat.CONCRETE);
        world.box(stairX, slabY, z + d * 0.5 - t - landD * 0.5, stairW + 0.4, 0.24, landD, floorMat, Mat.CONCRETE);
      }

      // Walkable stairs from this floor to the slab above (alternating direction so multi-floor climbs flow!)
      const dir = f % 2 === 0 ? '-z' : '+z';
      const zStart = dir === '-z' ? (z + stairRun * 0.5) : (z - stairRun * 0.5);
      this.addStairFlight(stairX, fy + 0.1, zStart, stairRun, floorH - 0.1, stairW - 0.2, dir);

      if (f === 0) {
        this.addFixtureLight(x + 1.2, fy + floorH - 0.35, z, 0xffe2b0, 20, 14);
      }
    }

    // Rooftop ballistic parapet with firing embrasures + AC/antenna cover
    const roofY = totalH;
    const pH = 1.05;
    world.box(x, roofY, z + d * 0.5 - 0.18, w, pH, 0.34, wallMat, Mat.CONCRETE);
    world.box(x, roofY, z - d * 0.5 + 0.18, w, pH, 0.34, wallMat, Mat.CONCRETE);
    world.box(x + w * 0.5 - 0.18, roofY, z, 0.34, pH, d, wallMat, Mat.CONCRETE);
    world.box(x - w * 0.5 + 0.18, roofY, z, 0.34, pH, d, wallMat, Mat.CONCRETE);
    // HVAC unit on roof for rooftop cover
    world.box(x + w * 0.22, roofY, z - d * 0.2, 2.2, 1.25, 1.6, this.M.metal(2, 0x5c646c), Mat.METAL);
    this.elevatedNodes.push({ x: x + w * 0.16, y: roofY + 0.04, z: z + d * 0.16, tag: 'rooftop' });

    this.addZone(x, 0, z, w - 0.6, totalH, d - 0.6, 'room');
    return {
      groundPos: new THREE.Vector3(x + 2.0, 0.14, z - 1.5),
      upperPos: new THREE.Vector3(x + 2.0, floorH + 0.04, z),
      roofPos: new THREE.Vector3(x + 2.0, roofY + 0.04, z + 1.5),
    };
  }

  // --------------------------------------------------------------------------
  // 3. Industrial Warehouse Hall (roll-up bay, racks, mezzanine catwalk + stairs)
  // --------------------------------------------------------------------------
  addWarehouseHall(x, z, w = 20, d = 16, opts = {}) {
    const world = this.world;
    const skin = this.M.corrugated(opts.color || 0x55626a, 5);
    const conc = this.M.concrete(4);
    const steel = this.M.metalDark;
    const h = opts.height || 7.2;
    const t = 0.34;

    this.reserveArea(x, z, w, d, 2.8);
    this.addCoverRing(x, z, w, d, 0);

    world.box(x, 0, z, w, 0.12, d, this.M.floorConc(8), Mat.CONCRETE);
    // Front & rear walls with wide roll-up bay openings (4.2m wide)
    this.addWallWithOpening(x, 0, z + d * 0.5 - t * 0.5, w, h, t, 'x', skin, {
      doorWidth: 4.2, doorOffset: 0, doorHeight: 3.6, withDoor: !!opts.closedBay, slideUp: true,
    });
    this.addWallWithOpening(x, 0, z - d * 0.5 + t * 0.5, w, h, t, 'x', skin, {
      doorWidth: 3.6, doorOffset: 0, doorHeight: 3.2, withDoor: false,
    });
    this.addWallWithOpening(x - w * 0.5 + t * 0.5, 0, z, d - t * 2, h, t, 'z', skin, {
      doorWidth: 2.0, doorOffset: 0, doorHeight: 2.4,
    });
    this.addWallWithOpening(x + w * 0.5 - t * 0.5, 0, z, d - t * 2, h, t, 'z', skin, { windows: 3 });

    // Roof + structural portal trusses
    world.box(x, h, z, w + 0.5, 0.32, d + 0.5, steel, Mat.METAL);
    for (const tz of [-d * 0.3, 0, d * 0.3]) {
      world.box(x, h - 0.45, z + tz, w - 0.8, 0.35, 0.28, steel, Mat.METAL, { noCollider: true });
    }

    // Mezzanine catwalk along +X wall at y = 3.4m + walkable stair flight
    const mezY = 3.4;
    const mezW = 3.2;
    const mezX = x + w * 0.5 - t - mezW * 0.5;
    world.box(mezX, mezY - 0.18, z, mezW, 0.2, d - 2.4, steel, Mat.METAL);
    world.box(mezX - mezW * 0.5 + 0.08, mezY, z, 0.12, 1.0, d - 2.4, steel, Mat.METAL);
    this.addStairFlight(mezX - mezW * 0.5 - 1.1, 0.12, z + d * 0.34, 5.8, mezY - 0.12, 1.8, '-z', steel);
    this.elevatedNodes.push({ x: mezX, y: mezY + 0.04, z: z - 1.5, tag: 'catwalk' });

    // Interior shelving / crate aisles leaving wide 4.5m central lane clear
    for (const side of [-1]) {
      for (const rz of [-d * 0.24, d * 0.22]) {
        const rx = x + side * (w * 0.27);
        world.box(rx, 0.12, z + rz, 2.8, 2.2, 1.5, this.M.wood(2, 0x8f7352), Mat.WOOD);
        this.addCoverRing(rx, z + rz, 2.8, 1.5, 0);
      }
    }
    this.interiorNodes.push({ x, y: 0.14, z, tag: 'warehouse_floor' });
    this.addFixtureLight(x, h - 0.55, z, 0xffdfb0, 26, 20, true);
    this.addZone(x, 0, z, w - 0.8, h, d - 0.8, 'warehouse');
    return {
      floorPos: new THREE.Vector3(x, 0.14, z),
      catwalkPos: new THREE.Vector3(mezX, mezY + 0.04, z),
    };
  }

  // --------------------------------------------------------------------------
  // 4. Guard Tower (4 steel legs, walkable stairs to y=3.6m cab, firing parapet)
  // --------------------------------------------------------------------------
  addGuardTower(x, z, opts = {}) {
    const world = this.world;
    const steel = this.M.metalDark;
    const cabMat = this.M.metal(2, opts.color || 0x4c5550);
    const deckY = 3.6;
    const size = 4.2;

    this.reserveArea(x, z, size + 3.6, size + 4.4, 1.6);

    // 4 heavy corner legs + cross-braces
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        world.box(x + sx * 1.75, 0, z + sz * 1.75, 0.32, deckY + 2.5, 0.32, steel, Mat.METAL);
      }
    }
    // Elevated cab floor
    world.box(x, deckY - 0.22, z, size, 0.24, size, steel, Mat.METAL);
    // Waist-high armored parapet on 3.5 sides (opening on +Z stair landing)
    const pH = 1.12;
    world.box(x, deckY, z - size * 0.5 + 0.15, size, pH, 0.26, cabMat, Mat.METAL);
    world.box(x - size * 0.5 + 0.15, deckY, z, 0.26, pH, size, cabMat, Mat.METAL);
    world.box(x + size * 0.5 - 0.15, deckY, z, 0.26, pH, size, cabMat, Mat.METAL);
    world.box(x - 1.1, deckY, z + size * 0.5 - 0.15, size * 0.45, pH, 0.26, cabMat, Mat.METAL);
    // Canopy roof + searchlight housing
    world.box(x, deckY + 2.45, z, size + 0.6, 0.22, size + 0.6, steel, Mat.METAL);
    world.box(x, deckY + 2.25, z - size * 0.45, 0.55, 0.22, 0.3, this.M.emissiveLamp, Mat.METAL, { noCollider: true });

    // Walkable exterior stair flight climbing from (z + 6.4) up to (z + size*0.5)
    const stairStartZ = z + size * 0.5 + 5.6;
    this.addStairFlight(x + 0.9, 0, stairStartZ, 5.6, deckY, 1.55, '-z', steel);
    this.elevatedNodes.push({ x: x - 0.4, y: deckY + 0.04, z: z - 0.3, tag: 'tower_deck' });
    this.addCoverRing(x, z, size, size, 0);
    return new THREE.Vector3(x - 0.3, deckY + 0.04, z - 0.3);
  }

  // --------------------------------------------------------------------------
  // 5. Military Barracks Block (twin doorways, corridor, bunk bays, porch)
  // --------------------------------------------------------------------------
  addBarracksBlock(x, z, w = 16, d = 8.5, opts = {}) {
    const world = this.world;
    const wall = this.tintedConcrete(opts.tint || 0x7d8278, 3);
    const roofMat = this.M.corrugated(0x465248, 4);
    const h = 3.5;
    const t = 0.3;

    this.reserveArea(x, z, w, d + 2.4, 2.0);
    this.addCoverRing(x, z, w, d, 0);

    world.box(x, 0, z, w, 0.12, d, this.M.floorConc(5), Mat.CONCRETE);
    this.addWallWithOpening(x, 0, z + d * 0.5 - t * 0.5, w, h, t, 'x', wall, {
      doorWidth: 1.8, doorOffset: -w * 0.24, doorHeight: 2.35, withDoor: true,
    });
    this.addWallWithOpening(x, 0, z - d * 0.5 + t * 0.5, w, h, t, 'x', wall, {
      doorWidth: 1.8, doorOffset: w * 0.24, doorHeight: 2.35, withDoor: false,
    });
    this.addWallWithOpening(x - w * 0.5 + t * 0.5, 0, z, d - t * 2, h, t, 'z', wall, { windows: 2 });
    this.addWallWithOpening(x + w * 0.5 - t * 0.5, 0, z, d - t * 2, h, t, 'z', wall, { windows: 2 });
    world.box(x, h, z, w + 0.6, 0.3, d + 0.8, roofMat, Mat.METAL);

    // Interior bunk partitions & footlockers
    for (const bx of [-w * 0.18, w * 0.18]) {
      world.box(x + bx, 0.12, z - d * 0.22, 0.2, 2.2, d * 0.34, wall, Mat.CONCRETE);
      world.box(x + bx - 1.2, 0.12, z - d * 0.26, 1.9, 0.65, 0.9, this.M.fabric, Mat.WOOD);
    }
    // Front sandbag parapet
    world.box(x + w * 0.22, 0, z + d * 0.5 + 1.3, 3.4, 1.0, 0.65, this.M.wood(1, 0x8e7f62), Mat.WOOD);
    world._cover(x + w * 0.22, z + d * 0.5 + 2.1, 0, 1);

    this.interiorNodes.push({ x, y: 0.14, z, tag: 'barracks_room' });
    this.addZone(x, 0, z, w - 0.6, h, d - 0.6, 'room');
    return new THREE.Vector3(x, 0.14, z);
  }

  // --------------------------------------------------------------------------
  // 6. Fortified Border / Base Checkpoint Gate
  // --------------------------------------------------------------------------
  addCheckpointGate(x, z, spanW = 18, opts = {}) {
    const world = this.world;
    const conc = this.M.concrete(3);
    const steel = this.M.metalDark;
    const haz = this.hazardMat();

    this.reserveArea(x, z, spanW + 4, 12, 2.0);

    // Overhead inspection canopy (4.6m clearance for trucks/APCs)
    world.box(x, 4.6, z, spanW, 0.45, 5.4, conc, Mat.CONCRETE);
    // Left & right guard booths (outside central 7.5m road lane)
    for (const side of [-1, 1]) {
      const bx = x + side * (spanW * 0.34);
      world.box(bx, 0, z, 3.2, 3.1, 3.8, conc, Mat.CONCRETE);
      world.box(bx, 3.1, z, 3.4, 1.5, 1.2, steel, Mat.METAL);
      world._cover(bx, z + 2.7, 0, 1);
      world._cover(bx, z - 2.7, 0, -1);
    }
    // Raised boom-arm islands + striped boom bars (high enough or offset for passage)
    world.box(x - 3.6, 0, z + 2.8, 0.6, 1.1, 0.6, haz, Mat.METAL);
    world.box(x - 1.9, 1.05, z + 2.8, 3.1, 0.12, 0.12, haz, Mat.METAL, { noCollider: true });
    // Chicane concrete Jersey barriers leaving navigable S-lane
    this.addJerseyBarrierLine(x - 3.2, z + 5.2, 2, 'x');
    this.addJerseyBarrierLine(x + 3.2, z - 5.2, 2, 'x');
    this.addFixtureLight(x, 4.5, z, 0xffdca8, 24, 18, true);
  }

  // --------------------------------------------------------------------------
  // 7. Concrete Jersey Barriers, HESCO Walls & Watch Posts
  // --------------------------------------------------------------------------
  addJerseyBarrierLine(x, z, count = 3, axis = 'x') {
    const conc = this.M.concrete(2);
    const segLen = 2.6;
    for (let i = 0; i < count; i++) {
      const off = (i - (count - 1) * 0.5) * (segLen + 0.18);
      const bx = axis === 'x' ? x + off : x;
      const bz = axis === 'z' ? z + off : z;
      const w = axis === 'x' ? segLen : 0.68;
      const d = axis === 'z' ? segLen : 0.68;
      this.world.box(bx, 0, bz, w, 1.02, d, conc, Mat.CONCRETE);
      this.addCoverRing(bx, bz, w, d, 0);
    }
  }

  addHescoWall(x, z, length = 8, axis = 'x', height = 1.85) {
    const hesco = this.M.wood(2, 0x9b8b6c);
    const frame = this.M.metalDark;
    const w = axis === 'x' ? length : 1.15;
    const d = axis === 'z' ? length : 1.15;
    this.world.box(x, 0, z, w, height, d, hesco, Mat.CONCRETE);
    this.world.box(x, height, z, w + 0.08, 0.08, d + 0.08, frame, Mat.METAL, { noCollider: true });
    this.addCoverRing(x, z, w, d, 0);
    this.reserveArea(x, z, w, d, 0.6);
  }

  addWatchPost(x, z, rotFaceZ = 1) {
    const conc = this.M.concrete(2);
    const bag = this.M.wood(1, 0x8f8062);
    const w = 4.2, d = 3.6;
    this.reserveArea(x, z, w, d, 1.5);
    // Front firing wall (chest height 1.15m + overhead lintel at 2.15m = firing slit!)
    const fz = z + rotFaceZ * (d * 0.5 - 0.22);
    this.world.box(x, 0, fz, w, 1.12, 0.44, conc, Mat.CONCRETE);
    this.world.box(x, 1.95, fz, w, 0.55, 0.44, conc, Mat.CONCRETE);
    // Side walls
    this.world.box(x - w * 0.5 + 0.22, 0, z, 0.44, 2.5, d, conc, Mat.CONCRETE);
    this.world.box(x + w * 0.5 - 0.22, 0, z, 0.44, 2.5, d, conc, Mat.CONCRETE);
    // Overhead blast slab
    this.world.box(x, 2.5, z, w + 0.4, 0.32, d + 0.4, conc, Mat.CONCRETE);
    // Flanking sandbags
    this.world.box(x - w * 0.5 - 1.2, 0, fz, 2.0, 0.95, 0.65, bag, Mat.WOOD);
    this.addCoverRing(x, z, w, d, 0);
    this.interiorNodes.push({ x, y: 0.05, z, tag: 'pillbox' });
    return new THREE.Vector3(x, 0.05, z);
  }

  // --------------------------------------------------------------------------
  // 8. Elevated Overpass Bridge (with walkable/driveable approach ramps)
  // --------------------------------------------------------------------------
  addOverpassBridge(x, z, spanLen = 28, width = 7.5, axis = 'x', deckY = 3.8) {
    const conc = this.M.concrete(4);
    const asp = this.M.asphalt(5);
    const rail = this.M.metal(2, 0x565e66);
    const rampLen = 11.5;

    if (axis === 'x') {
      this.reserveArea(x, z, spanLen + rampLen * 2, width + 1.6, 1.4);
      // Main elevated span (clear 3.4m underpass beneath for vehicles & infantry!)
      this.world.box(x, deckY - 0.38, z, spanLen, 0.38, width, conc, Mat.CONCRETE);
      this.world.box(x, deckY, z, spanLen, 0.05, width - 0.6, asp, Mat.CONCRETE, { noCollider: true });
      this.world.box(x, deckY, z - width * 0.5 + 0.16, spanLen, 0.95, 0.28, rail, Mat.METAL);
      this.world.box(x, deckY, z + width * 0.5 - 0.16, spanLen, 0.95, 0.28, rail, Mat.METAL);
      // Support piers leaving central underpass road clear
      for (const px of [-spanLen * 0.36, spanLen * 0.36]) {
        for (const pz of [-width * 0.34, width * 0.34]) {
          this.world.box(x + px, 0, z + pz, 0.9, deckY - 0.38, 0.9, conc, Mat.CONCRETE);
          this.addCoverRing(x + px, z + pz, 0.9, 0.9, 0);
        }
      }
      // West & East walkable/stepped ramps
      this.addStairFlight(x - spanLen * 0.5 - rampLen, 0, z, rampLen, deckY, width - 0.6, '+x', conc);
      this.addStairFlight(x + spanLen * 0.5 + rampLen, 0, z, rampLen, deckY, width - 0.6, '-x', conc);
    } else {
      this.reserveArea(x, z, width + 1.6, spanLen + rampLen * 2, 1.4);
      this.world.box(x, deckY - 0.38, z, width, 0.38, spanLen, conc, Mat.CONCRETE);
      this.world.box(x, deckY, z, width - 0.6, 0.05, spanLen, asp, Mat.CONCRETE, { noCollider: true });
      this.world.box(x - width * 0.5 + 0.16, deckY, z, 0.28, 0.95, spanLen, rail, Mat.METAL);
      this.world.box(x + width * 0.5 - 0.16, deckY, z, 0.28, 0.95, spanLen, rail, Mat.METAL);
      for (const pz of [-spanLen * 0.36, spanLen * 0.36]) {
        for (const px of [-width * 0.34, width * 0.34]) {
          this.world.box(x + px, 0, z + pz, 0.9, deckY - 0.38, 0.9, conc, Mat.CONCRETE);
          this.addCoverRing(x + px, z + pz, 0.9, 0.9, 0);
        }
      }
      this.addStairFlight(x, 0, z - spanLen * 0.5 - rampLen, rampLen, deckY, width - 0.6, '+z', conc);
      this.addStairFlight(x, 0, z + spanLen * 0.5 + rampLen, rampLen, deckY, width - 0.6, '-z', conc);
    }
    this.elevatedNodes.push({ x, y: deckY + 0.06, z, tag: 'overpass_deck' });
    return new THREE.Vector3(x, deckY + 0.06, z);
  }

  // --------------------------------------------------------------------------
  // 9. Enclosed Tunnel Passage & Subterranean Command Hall
  // --------------------------------------------------------------------------
  addTunnelPassage(x, z, length = 24, width = 6.2, axis = 'z', opts = {}) {
    const conc = this.tintedConcrete(0x66686c, 4);
    const dark = this.M.metalDark;
    const h = opts.height || 3.8;
    const t = 0.45;

    if (axis === 'z') {
      this.reserveArea(x, z, width + 1.4, length, 1.2);
      this.world.box(x, 0, z, width, 0.1, length, this.M.floorConc(6), Mat.CONCRETE);
      this.world.box(x - width * 0.5 - t * 0.5, 0, z, t, h, length, conc, Mat.CONCRETE);
      this.world.box(x + width * 0.5 + t * 0.5, 0, z, t, h, length, conc, Mat.CONCRETE);
      this.world.box(x, h, z, width + t * 2, 0.55, length, conc, Mat.CONCRETE);
      const ribs = Math.max(2, Math.floor(length / 6));
      for (let i = 0; i < ribs; i++) {
        const rz = z - length * 0.5 + (i + 0.5) * (length / ribs);
        this.world.box(x - width * 0.5 + 0.28, 0, rz, 0.55, h, 0.55, dark, Mat.METAL);
        this.world.box(x + width * 0.5 - 0.28, 0, rz, 0.55, h, 0.55, dark, Mat.METAL);
        this.world._cover(x - width * 0.5 + 0.9, rz + 0.9, 0, 1);
        this.world._cover(x + width * 0.5 - 0.9, rz - 0.9, 0, -1);
      }
      this.addZone(x, 0, z, width, h, length, 'corridor');
    } else {
      this.reserveArea(x, z, length, width + 1.4, 1.2);
      this.world.box(x, 0, z, length, 0.1, width, this.M.floorConc(6), Mat.CONCRETE);
      this.world.box(x, 0, z - width * 0.5 - t * 0.5, length, h, t, conc, Mat.CONCRETE);
      this.world.box(x, 0, z + width * 0.5 + t * 0.5, length, h, t, conc, Mat.CONCRETE);
      this.world.box(x, h, z, length, 0.55, width + t * 2, conc, Mat.CONCRETE);
      const ribs = Math.max(2, Math.floor(length / 6));
      for (let i = 0; i < ribs; i++) {
        const rx = x - length * 0.5 + (i + 0.5) * (length / ribs);
        this.world.box(rx, 0, z - width * 0.5 + 0.28, 0.55, h, 0.55, dark, Mat.METAL);
        this.world.box(rx, 0, z + width * 0.5 - 0.28, 0.55, h, 0.55, dark, Mat.METAL);
        this.world._cover(rx + 0.9, z - width * 0.5 + 0.9, 1, 0);
        this.world._cover(rx - 0.9, z + width * 0.5 - 0.9, -1, 0);
      }
      this.addZone(x, 0, z, length, h, width, 'corridor');
    }
    this.addFixtureLight(x, h - 0.18, z, 0xffb380, 18, 16, true);
    this.interiorNodes.push({ x, y: 0.12, z, tag: 'tunnel' });
  }

  addUndergroundHall(x, z, w = 22, d = 18, opts = {}) {
    const conc = this.tintedConcrete(0x5e6268, 5);
    const steel = this.M.metalDark;
    const h = 6.2;
    const t = 0.5;

    this.reserveArea(x, z, w, d, 2.4);
    this.world.box(x, 0, z, w, 0.14, d, this.M.floorConc(8), Mat.CONCRETE);
    // 4 walls with 4 blast-portal openings so N/S/E/W tunnels connect cleanly!
    this.addWallWithOpening(x, 0, z + d * 0.5 - t * 0.5, w, h, t, 'x', conc, { doorWidth: 4.4, doorOffset: 0, doorHeight: 3.6 });
    this.addWallWithOpening(x, 0, z - d * 0.5 + t * 0.5, w, h, t, 'x', conc, { doorWidth: 4.4, doorOffset: 0, doorHeight: 3.6 });
    this.addWallWithOpening(x - w * 0.5 + t * 0.5, 0, z, d - t * 2, h, t, 'z', conc, { doorWidth: 3.8, doorOffset: 0, doorHeight: 3.4 });
    this.addWallWithOpening(x + w * 0.5 - t * 0.5, 0, z, d - t * 2, h, t, 'z', conc, { doorWidth: 3.8, doorOffset: 0, doorHeight: 3.4 });
    // Heavy bunker roof slab
    this.world.box(x, h, z, w + 0.4, 0.8, d + 0.4, conc, Mat.CONCRETE);

    // 4 heavy blast columns + server/console banks
    for (const px of [-w * 0.25, w * 0.25]) {
      for (const pz of [-d * 0.24, d * 0.24]) {
        this.world.box(x + px, 0.14, z + pz, 1.2, h - 0.14, 1.2, conc, Mat.CONCRETE);
        this.addCoverRing(x + px, z + pz, 1.2, 1.2, 0);
      }
    }
    // Raised observation gallery along -Z quadrant + stairs
    const galY = 2.8;
    this.world.box(x + w * 0.26, galY - 0.2, z - d * 0.3, 6.2, 0.22, 3.6, steel, Mat.METAL);
    this.addStairFlight(x + w * 0.26 - 3.1, 0.14, z - d * 0.3, 4.8, galY - 0.14, 1.6, '+x', steel);
    this.elevatedNodes.push({ x: x + w * 0.28, y: galY + 0.04, z: z - d * 0.3, tag: 'bunker_gallery' });
    this.interiorNodes.push({ x, y: 0.16, z, tag: 'bunker_hall' });
    this.addFixtureLight(x, h - 0.3, z, 0xd8ecff, 26, 20);
    this.addZone(x, 0, z, w - 1, h, d - 1, 'warehouse');
    return new THREE.Vector3(x, 0.16, z);
  }

  // --------------------------------------------------------------------------
  // 10. Parking Lot / Motor Pool
  // --------------------------------------------------------------------------
  addParkingLot(x, z, w = 18, d = 14) {
    const asp = this.M.asphalt(5);
    const lineMat = this.world._cached('park_line', () => new THREE.MeshStandardMaterial({ color: 0xd0d4d8, roughness: 0.9 }));
    const conc = this.M.concrete(2);

    this.reserveArea(x, z, w, d, 1.5);
    this.world.box(x, 0.01, z, w, 0.03, d, asp, Mat.CONCRETE, { noCollider: true, cast: false });
    this.world._addVehicleSurface(x, z, w, d, { grip: 0.98, drag: 0.05, dust: 0.03, material: 'asphalt' });

    const bays = Math.max(3, Math.floor((w - 2) / 3.4));
    for (let i = 0; i <= bays; i++) {
      const bx = x - (bays * 3.2) * 0.5 + i * 3.2;
      this.world.box(bx, 0.042, z - d * 0.26, 0.12, 0.01, 4.6, lineMat, Mat.CONCRETE, { noCollider: true, cast: false });
      if (i < bays) {
        this.world.box(bx + 1.6, 0.04, z - d * 0.44, 2.2, 0.18, 0.28, conc, Mat.CONCRETE);
      }
    }
    // Concrete median cover island
    this.world.box(x, 0, z + d * 0.44, w * 0.55, 0.95, 0.7, conc, Mat.CONCRETE);
    this.addCoverRing(x, z + d * 0.44, w * 0.55, 0.7, 0);
  }

  // --------------------------------------------------------------------------
  // 11. Aircraft Hangar / Hardened Aircraft Shelter & Runway Strip
  // --------------------------------------------------------------------------
  addAircraftHangar(x, z, w = 22, d = 20, opts = {}) {
    const steel = this.M.metal(3, opts.color || 0x5c656d);
    const dark = this.M.metalDark;
    const conc = this.M.concrete(4);
    const h = 8.2;
    const t = 0.48;

    this.reserveArea(x, z, w, d, 3.0);
    this.addCoverRing(x, z, w, d, 0);

    this.world.box(x, 0, z, w, 0.14, d, this.M.floorConc(9), Mat.CONCRETE);
    // Wide open front apron bay (14m wide!) + rear personnel blast door
    this.addWallWithOpening(x, 0, z + d * 0.5 - t * 0.5, w, h, t, 'x', conc, {
      doorWidth: w - 5.2, doorOffset: 0, doorHeight: 6.2,
    });
    this.addWallWithOpening(x, 0, z - d * 0.5 + t * 0.5, w, h, t, 'x', conc, {
      doorWidth: 3.2, doorOffset: 0, doorHeight: 3.0,
    });
    this.world.box(x - w * 0.5 + t * 0.5, 0, z, t, h, d - t * 2, conc, Mat.CONCRETE);
    this.world.box(x + w * 0.5 - t * 0.5, 0, z, t, h, d - t * 2, conc, Mat.CONCRETE);
    // Stepped arched blast roof
    this.world.box(x, h, z, w + 0.6, 0.5, d + 0.6, steel, Mat.METAL);
    this.world.box(x, h + 0.5, z, w * 0.68, 0.55, d, steel, Mat.METAL);

    // Maintenance gantry catwalk along -X wall + stairs
    const catY = 3.8;
    const catX = x - w * 0.5 + t + 1.4;
    this.world.box(catX, catY - 0.18, z, 2.6, 0.2, d - 3.0, dark, Mat.METAL);
    this.world.box(catX + 1.22, catY, z, 0.12, 1.0, d - 3.0, dark, Mat.METAL);
    this.addStairFlight(catX + 1.8, 0.14, z - d * 0.32, 6.2, catY - 0.14, 1.5, '+z', dark);
    this.elevatedNodes.push({ x: catX, y: catY + 0.04, z, tag: 'hangar_catwalk' });

    // Parked tactical drone / jet airframe silhouette on central maintenance jacks (great CQB cover!)
    this.world.box(x + 1.2, 0.9, z - 0.5, 2.1, 1.3, 9.6, this.M.metal(2, 0x454f58), Mat.METAL);
    this.world.box(x + 1.2, 1.35, z - 0.2, 9.4, 0.22, 2.6, this.M.metal(2, 0x4c5660), Mat.METAL);
    this.world.box(x + 1.2, 1.8, z - 4.4, 0.22, 1.6, 1.8, dark, Mat.METAL);
    this.addCoverRing(x + 1.2, z - 0.5, 3.2, 9.6, 0);

    this.interiorNodes.push({ x: x - 3.2, y: 0.16, z: z + 2.5, tag: 'hangar_bay' });
    this.addFixtureLight(x, h - 0.35, z, 0xe8f2ff, 28, 22);
    this.addZone(x, 0, z, w - 1, h, d - 1, 'warehouse');
    return new THREE.Vector3(x - 3.2, 0.16, z + 2.5);
  }

  addRunwayStrip(x, z, width = 18, length = 110, axis = 'z') {
    const asp = this.M.asphalt(14);
    const white = this.world._cached('rwy_white', () => new THREE.MeshStandardMaterial({ color: 0xe6e9ec, roughness: 0.85 }));
    const w = axis === 'z' ? width : length;
    const d = axis === 'z' ? length : width;

    this.world.box(x, 0.012, z, w, 0.03, d, asp, Mat.CONCRETE, { noCollider: true, cast: false });
    this.world._addVehicleSurface(x, z, w, d, { grip: 1.02, drag: 0.04, dust: 0.015, material: 'runway-asphalt' });
    this.reserveArea(x, z, w, d, 1.0);

    if (axis === 'z') {
      // Threshold piano keys + centerline + edge runway beacons
      for (const end of [-1, 1]) {
        for (let k = -3; k <= 3; k++) {
          if (k === 0) continue;
          this.world.box(x + k * 1.9, 0.045, z + end * (length * 0.5 - 5.5), 0.9, 0.01, 5.5, white, Mat.CONCRETE, { noCollider: true, cast: false });
        }
      }
      const dashes = Math.floor((length - 26) / 9);
      for (let i = 0; i < dashes; i++) {
        this.world.box(x, 0.045, z - length * 0.5 + 15 + i * 9, 0.42, 0.01, 4.8, white, Mat.CONCRETE, { noCollider: true, cast: false });
      }
    } else {
      for (const end of [-1, 1]) {
        for (let k = -3; k <= 3; k++) {
          if (k === 0) continue;
          this.world.box(x + end * (length * 0.5 - 5.5), 0.045, z + k * 1.9, 5.5, 0.01, 0.9, white, Mat.CONCRETE, { noCollider: true, cast: false });
        }
      }
      const dashes = Math.floor((length - 26) / 9);
      for (let i = 0; i < dashes; i++) {
        this.world.box(x - length * 0.5 + 15 + i * 9, 0.045, z, 4.8, 0.01, 0.42, white, Mat.CONCRETE, { noCollider: true, cast: false });
      }
    }
  }

  // --------------------------------------------------------------------------
  // 12. Fuel Depot (bunded basin, cylindrical tanks, pipes, optional destructible)
  // --------------------------------------------------------------------------
  addFuelDepot(x, z, opts = {}) {
    const conc = this.M.concrete(3);
    const tankMat = this.M.metal(2, opts.color || 0x8c9296);
    const pipeMat = this.hazardMat();
    const w = 15, d = 12;

    this.reserveArea(x, z, w, d, 2.2);
    this.addCoverRing(x, z, w, d, 0);

    // Concrete bund containment walls (1.05m waist cover with entry gap on +Z)
    this.world.box(x, 0, z, w, 0.1, d, conc, Mat.CONCRETE);
    this.world.box(x, 0, z - d * 0.5 + 0.2, w, 1.05, 0.4, conc, Mat.CONCRETE);
    this.world.box(x - w * 0.5 + 0.2, 0, z, 0.4, 1.05, d, conc, Mat.CONCRETE);
    this.world.box(x + w * 0.5 - 0.2, 0, z, 0.4, 1.05, d, conc, Mat.CONCRETE);
    this.world.box(x - 4.4, 0, z + d * 0.5 - 0.2, 5.2, 1.05, 0.4, conc, Mat.CONCRETE);
    this.world.box(x + 4.4, 0, z + d * 0.5 - 0.2, 5.2, 1.05, 0.4, conc, Mat.CONCRETE);

    // Twin vertical cylindrical storage tanks + overhead pipe bridge
    this.world.cyl(x - 3.6, 0.1, z - 1.2, 2.2, 2.2, 5.2, 14, tankMat, Mat.METAL);
    this.world.cyl(x + 3.6, 0.1, z - 1.2, 2.2, 2.2, 5.2, 14, tankMat, Mat.METAL);
    this.world.box(x, 4.4, z - 1.2, 7.6, 0.28, 0.55, pipeMat, Mat.METAL);

    let destructible = null;
    if (opts.destructibleId) {
      destructible = this.world.addDestructibleBox(
        opts.destructibleId,
        x, 0.12, z + 2.4, 1.6, 1.5, 1.1,
        this.M.metal(1, 0xb8422c), Mat.METAL,
        { health: 95, label: opts.destructibleLabel || 'FUEL MANIFOLD VALVE' }
      );
    } else {
      this.world.box(x, 0.12, z + 2.4, 1.5, 1.35, 1.0, pipeMat, Mat.METAL);
    }
    return { pos: new THREE.Vector3(x, 0.12, z + 2.4), destructible };
  }

  // --------------------------------------------------------------------------
  // 13. Comms Tower, Power Substation & Radar Installation
  // --------------------------------------------------------------------------
  addCommsTower(x, z, opts = {}) {
    const steel = this.M.metalDark;
    const redMat = this.M.emissiveRed;
    const conc = this.M.concrete(2);
    const h = opts.height || 18;

    this.reserveArea(x, z, 9, 9, 1.8);
    this.world.box(x, 0, z, 4.4, 0.65, 4.4, conc, Mat.CONCRETE);
    // Tapered steel lattice mast segments
    this.world.box(x, 0.65, z, 1.8, h * 0.45, 1.8, steel, Mat.METAL);
    this.world.box(x, 0.65 + h * 0.45, z, 1.05, h * 0.4, 1.05, steel, Mat.METAL);
    this.world.cyl(x, 0.65 + h * 0.85, z, 0.08, 0.16, h * 0.25, 6, steel, Mat.METAL);
    // Microwave dish drums + red aviation warning beacon
    this.world.cyl(x + 0.9, h * 0.62, z, 0.65, 0.65, 0.35, 10, this.M.metal(1, 0xd8dce0), Mat.METAL, { rotZ: Math.PI * 0.5, noCollider: true });
    this.world.box(x, h * 1.1 + 0.65, z, 0.28, 0.28, 0.28, redMat, Mat.METAL, { noCollider: true, cast: false });

    // Attached transmitter shelter
    this.world.box(x + 3.4, 0, z, 3.2, 2.8, 3.6, this.M.metal(2, 0x525d58), Mat.METAL);
    this.addCoverRing(x + 3.4, z, 3.2, 3.6, 0);

    let destructible = null;
    if (opts.destructibleId) {
      destructible = this.world.addDestructibleBox(
        opts.destructibleId,
        x - 2.6, 0.1, z + 1.8, 1.4, 1.65, 1.0,
        this.M.metal(1, 0x3b6c88), Mat.METAL,
        { health: 90, label: opts.destructibleLabel || 'COMMS RELAY RACK' }
      );
    }
    return { pos: new THREE.Vector3(x - 2.6, 0.1, z + 1.8), destructible };
  }

  addPowerSubstation(x, z, opts = {}) {
    const conc = this.M.concrete(3);
    const steel = this.M.metalDark;
    const xfmMat = this.M.metal(2, 0x4c5860);
    const w = 15, d = 13;

    this.reserveArea(x, z, w, d, 2.0);
    this.world.box(x, 0, z, w, 0.12, d, this.M.gravel(8), Mat.CONCRETE);
    this.addPerimeterFence(x, z, w, d, { gapSouth: 4.0, gapNorth: 3.4, height: 2.3 });

    // Twin HV step-down transformers + ceramic bushings + overhead gantry busbar
    for (const sx of [-3.4, 3.4]) {
      this.world.box(x + sx, 0.12, z - 1.6, 2.6, 2.5, 2.2, xfmMat, Mat.METAL);
      for (const bx of [-0.7, 0, 0.7]) {
        this.world.cyl(x + sx + bx, 2.62, z - 1.6, 0.12, 0.16, 1.1, 6, conc, Mat.METAL, { noCollider: true });
      }
      this.addCoverRing(x + sx, z - 1.6, 2.6, 2.2, 0);
    }
    this.world.box(x - 5.2, 0.12, z - 1.6, 0.35, 5.4, 0.35, steel, Mat.METAL);
    this.world.box(x + 5.2, 0.12, z - 1.6, 0.35, 5.4, 0.35, steel, Mat.METAL);
    this.world.box(x, 5.2, z - 1.6, 11.0, 0.28, 0.45, steel, Mat.METAL, { noCollider: true });

    if (opts.withGenerator) {
      this.world._generator(x, 0.12, z + 3.2);
    }
    let destructible = null;
    if (opts.destructibleId) {
      destructible = this.world.addDestructibleBox(
        opts.destructibleId,
        x, 0.12, z + 2.8, 1.6, 1.7, 1.1,
        this.hazardMat(), Mat.METAL,
        { health: 100, label: opts.destructibleLabel || 'TRANSFORMER BREAKER BANK' }
      );
    }
    return { pos: new THREE.Vector3(x, 0.12, z + 2.8), destructible };
  }

  addRadarInstallation(x, z, opts = {}) {
    const conc = this.M.concrete(3);
    const dishMat = this.M.metal(2, 0xc8cfd6);
    const dark = this.M.metalDark;

    this.reserveArea(x, z, 13, 13, 2.2);
    // Elevated concrete radar plinth (y = 2.6m) + walkable stairs
    this.world.box(x, 0, z, 7.6, 2.6, 7.6, conc, Mat.CONCRETE);
    this.addStairFlight(x, 0, z + 3.8 + 4.8, 4.8, 2.6, 2.2, '-z', conc);
    // Pedestal + angled radar reflector array
    this.world.cyl(x, 2.6, z - 0.8, 0.9, 1.2, 2.2, 10, dark, Mat.METAL);
    this.world.box(x, 4.7, z - 0.8, 5.4, 2.1, 0.45, dishMat, Mat.METAL, { rotY: 0.35 });
    this.addCoverRing(x, z, 7.6, 7.6, 0);
    this.elevatedNodes.push({ x: x + 1.8, y: 2.64, z: z + 1.8, tag: 'radar_plinth' });

    let destructible = null;
    if (opts.destructibleId) {
      destructible = this.world.addDestructibleBox(
        opts.destructibleId,
        x + 1.8, 2.62, z + 1.4, 1.3, 1.5, 1.0,
        this.M.metal(1, 0x3b7a5c), Mat.METAL,
        { health: 95, label: opts.destructibleLabel || 'RADAR TELEMETRY CORE' }
      );
    }
    return { pos: new THREE.Vector3(x + 1.8, 2.64, z + 1.8), destructible };
  }

  // --------------------------------------------------------------------------
  // 14. Perimeter Fence / Fortified Compound Wall with Multiple Gates & Breaches
  // --------------------------------------------------------------------------
  addPerimeterFence(x, z, w, d, opts = {}) {
    const mat = opts.concrete ? this.M.concrete(4) : this.M.metalDark;
    const h = opts.height || 2.5;
    const t = opts.concrete ? 0.42 : 0.16;
    const gapS = opts.gapSouth == null ? 5.2 : opts.gapSouth;
    const gapN = opts.gapNorth == null ? 4.4 : opts.gapNorth;
    const gapE = opts.gapEast == null ? 3.4 : opts.gapEast;
    const gapW = opts.gapWest == null ? 3.4 : opts.gapWest;

    const seg = (cx, cz, len, axis, gap) => {
      if (gap <= 0) {
        if (axis === 'x') this.world.box(cx, 0, cz, len, h, t, mat, Mat.CONCRETE);
        else this.world.box(cx, 0, cz, t, h, len, mat, Mat.CONCRETE);
        return;
      }
      const part = Math.max(0, (len - gap) * 0.5);
      if (part < 0.4) return;
      if (axis === 'x') {
        this.world.box(cx - gap * 0.5 - part * 0.5, 0, cz, part, h, t, mat, Mat.CONCRETE);
        this.world.box(cx + gap * 0.5 + part * 0.5, 0, cz, part, h, t, mat, Mat.CONCRETE);
        // Gate pillars
        this.world.box(cx - gap * 0.5, 0, cz, 0.55, h + 0.45, 0.55, this.M.concrete(2), Mat.CONCRETE);
        this.world.box(cx + gap * 0.5, 0, cz, 0.55, h + 0.45, 0.55, this.M.concrete(2), Mat.CONCRETE);
      } else {
        this.world.box(cx, 0, cz - gap * 0.5 - part * 0.5, t, h, part, mat, Mat.CONCRETE);
        this.world.box(cx, 0, cz + gap * 0.5 + part * 0.5, t, h, part, mat, Mat.CONCRETE);
        this.world.box(cx, 0, cz - gap * 0.5, 0.55, h + 0.45, 0.55, this.M.concrete(2), Mat.CONCRETE);
        this.world.box(cx, 0, cz + gap * 0.5, 0.55, h + 0.45, 0.55, this.M.concrete(2), Mat.CONCRETE);
      }
    };

    seg(x, z + d * 0.5, w, 'x', gapS);
    seg(x, z - d * 0.5, w, 'x', gapN);
    seg(x + w * 0.5, z, d, 'z', gapE);
    seg(x - w * 0.5, z, d, 'z', gapW);
  }

  // --------------------------------------------------------------------------
  // 15. Shipping Container Yard Cluster (walk-through container + 2-tier stack)
  // --------------------------------------------------------------------------
  addContainerStack(x, z, opts = {}) {
    const colors = [0x3d5a6c, 0x7a4236, 0x48624c, 0x8a6d38, 0x4c525a];
    const c1 = this.M.corrugated(colors[Math.abs(Math.round(x + z)) % colors.length], 4);
    const c2 = this.M.corrugated(colors[Math.abs(Math.round(x * 2 - z)) % colors.length], 4);
    const c3 = this.M.corrugated(colors[Math.abs(Math.round(z * 2 + x)) % colors.length], 4);

    this.reserveArea(x, z, 11.5, 9.5, 1.6);

    // Container A (solid 6.2m × 2.6m × 2.5m) + Container B stacked on top + walkable stair/ramp!
    this.world.box(x - 2.4, 0, z - 1.8, 2.5, 2.6, 6.2, c1, Mat.METAL);
    if (opts.stacked !== false) {
      this.world.box(x - 2.4, 2.6, z - 1.4, 2.5, 2.6, 6.2, c2, Mat.METAL);
      this.addStairFlight(x - 2.4, 0, z + 1.3 + 4.4, 4.4, 2.6, 1.5, '-z', this.M.metalDark);
      this.elevatedNodes.push({ x: x - 2.4, y: 5.24, z: z - 1.4, tag: 'container_top' });
    }
    // Container C: Open-ended walk-through container on +X side!
    const ox = x + 2.5;
    this.world.box(ox, 0, z, 2.5, 0.12, 6.2, this.M.wood(2, 0x6c563c), Mat.WOOD);
    this.world.box(ox - 1.18, 0.12, z, 0.14, 2.45, 6.2, c3, Mat.METAL);
    this.world.box(ox + 1.18, 0.12, z, 0.14, 2.45, 6.2, c3, Mat.METAL);
    this.world.box(ox, 2.57, z, 2.5, 0.14, 6.2, c3, Mat.METAL);

    this.addCoverRing(x - 2.4, z - 1.8, 2.5, 6.2, 0);
    this.addCoverRing(ox, z, 2.5, 6.2, 0);
  }

  // --------------------------------------------------------------------------
  // 16. Industrial / Refinery Machinery Unit
  // --------------------------------------------------------------------------
  addIndustrialMachinery(x, z, opts = {}) {
    const conc = this.M.concrete(3);
    const steel = this.M.metal(2, opts.color || 0x5c6670);
    const rust = this.M.rust;

    this.reserveArea(x, z, 11, 9, 1.8);
    this.world.box(x, 0, z, 9.6, 0.45, 7.4, conc, Mat.CONCRETE);
    // Fractionating column + horizontal pressure vessel + gantry pipework
    this.world.cyl(x - 2.4, 0.45, z - 1.2, 1.15, 1.25, 8.8, 12, steel, Mat.METAL);
    this.world.box(x + 2.0, 0.45, z - 1.0, 3.6, 2.3, 2.4, rust, Mat.METAL);
    this.world.box(x, 3.4, z - 1.1, 6.8, 0.3, 0.9, this.M.metalDark, Mat.METAL);
    this.addCoverRing(x, z, 9.6, 7.4, 0);

    let destructible = null;
    if (opts.destructibleId) {
      destructible = this.world.addDestructibleBox(
        opts.destructibleId,
        x + 2.2, 0.45, z + 2.1, 1.5, 1.55, 1.0,
        this.hazardMat(), Mat.METAL,
        { health: 95, label: opts.destructibleLabel || 'PROCESS CONTROL UNIT' }
      );
    }
    return { pos: new THREE.Vector3(x + 2.2, 0.48, z + 2.1), destructible };
  }

  // --------------------------------------------------------------------------
  // 17. Harbor Quay, Gantry Crane & Docked Cargo Barge (with walkable gangway!)
  // --------------------------------------------------------------------------
  addHarborQuay(x, z, length = 64, waterSide = '+x') {
    const conc = this.M.concrete(8);
    const steel = this.M.metal(2, 0x3b4d5e);
    const craneMat = this.hazardMat();
    const sgn = waterSide === '+x' ? 1 : -1;

    // Sea wall apron + recessed deep water basin (fenced with safety bollards + gangway)
    this.world.box(x, 0, z, 12, 0.22, length, conc, Mat.CONCRETE);
    const waterW = 26;
    const waterX = x + sgn * (6 + waterW * 0.5);
    this.world.box(waterX, -1.2, z, waterW, 0.6, length, this.waterMat(0x132c3d), Mat.CONCRETE);
    // Low seawall curb blocking accidental walk-off except at the ship gangway!
    const halfSeg = (length - 5.0) * 0.5;
    this.world.box(x + sgn * 5.75, 0.22, z - 2.5 - halfSeg * 0.5, 0.45, 1.15, halfSeg, conc, Mat.CONCRETE);
    this.world.box(x + sgn * 5.75, 0.22, z + 2.5 + halfSeg * 0.5, 0.45, 1.15, halfSeg, conc, Mat.CONCRETE);

    // Docked patrol/cargo vessel hull + walkable gangway onto ship deck!
    const shipX = x + sgn * 11.4;
    this.world.box(shipX, -0.6, z, 7.6, 1.4, 28, steel, Mat.METAL);
    // Ship bulwark rails
    this.world.box(shipX + sgn * 3.55, 0.8, z, 0.35, 1.1, 28, steel, Mat.METAL);
    this.world.box(shipX, 0.8, z - 13.8, 7.6, 1.1, 0.4, steel, Mat.METAL);
    this.world.box(shipX, 0.8, z + 13.8, 7.6, 1.1, 0.4, steel, Mat.METAL);
    // Ship bridge superstructure at stern
    this.world.box(shipX, 0.8, z - 8.5, 5.2, 3.4, 5.6, this.M.metal(2, 0xb8c0c8), Mat.METAL);
    // Walkable steel gangway bridging quay (x + sgn*5.5) to ship deck (shipX - sgn*3.6)
    this.world.box(x + sgn * 7.2, 0.55, z, 4.2, 0.25, 3.2, this.M.metalDark, Mat.METAL);
    this.elevatedNodes.push({ x: shipX, y: 0.85, z: z + 3.0, tag: 'ship_deck' });

    // Port Gantry Crane straddling the quay
    const cz = z + 10;
    for (const lx of [-4.2, 4.2]) {
      for (const lz of [-3.6, 3.6]) {
        this.world.box(x + lx, 0.22, cz + lz, 0.65, 10.5, 0.65, craneMat, Mat.METAL);
      }
    }
    this.world.box(x + sgn * 3.5, 10.7, cz, 18.0, 0.85, 7.6, craneMat, Mat.METAL);
    this.reserveArea(x, z, 14, length, 1.5);
    return new THREE.Vector3(shipX, 0.85, z + 3.0);
  }

  // --------------------------------------------------------------------------
  // 18. Rail Yard Track & Coupled Freight Rolling Stock
  // --------------------------------------------------------------------------
  addRailYardTrack(x, z, length = 84, axis = 'z', opts = {}) {
    const gravel = this.M.gravel(14);
    const wood = this.M.wood(2, 0x56422e);
    const steel = this.M.metalDark;
    const carMat = this.M.corrugated(opts.carColor || 0x6b3f36, 4);

    if (axis === 'z') {
      this.world.box(x, 0.01, z, 3.8, 0.06, length, gravel, Mat.CONCRETE, { noCollider: true, cast: false });
      this.world.box(x - 0.78, 0.07, z, 0.12, 0.1, length, steel, Mat.METAL, { noCollider: true });
      this.world.box(x + 0.78, 0.07, z, 0.12, 0.1, length, steel, Mat.METAL, { noCollider: true });
      const sleepers = Math.floor(length / 2.2);
      for (let i = 0; i < sleepers; i++) {
        this.world.box(x, 0.04, z - length * 0.5 + 1.1 + i * 2.2, 2.6, 0.05, 0.24, wood, Mat.WOOD, { noCollider: true, cast: false });
      }
      if (opts.withCars !== false) {
        // Two freight cars separated by an 8m tactical crossing gap!
        for (const cz of [z - 18, z + 18]) {
          this.world.box(x, 0.55, cz, 2.9, 0.35, 12.4, steel, Mat.METAL);
          this.world.box(x, 0.9, cz, 2.85, 2.7, 12.2, carMat, Mat.METAL);
          this.addCoverRing(x, cz, 2.9, 12.4, 0);
          this.reserveArea(x, cz, 3.6, 13.2, 1.0);
        }
      }
    } else {
      this.world.box(x, 0.01, z, length, 0.06, 3.8, gravel, Mat.CONCRETE, { noCollider: true, cast: false });
      this.world.box(x, 0.07, z - 0.78, length, 0.1, 0.12, steel, Mat.METAL, { noCollider: true });
      this.world.box(x, 0.07, z + 0.78, length, 0.1, 0.12, steel, Mat.METAL, { noCollider: true });
      if (opts.withCars !== false) {
        for (const cx of [x - 18, x + 18]) {
          this.world.box(cx, 0.55, z, 12.4, 0.35, 2.9, steel, Mat.METAL);
          this.world.box(cx, 0.9, z, 12.2, 2.7, 2.85, carMat, Mat.METAL);
          this.addCoverRing(cx, z, 12.4, 2.9, 0);
          this.reserveArea(cx, z, 13.2, 3.6, 1.0);
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // 19. Research / Clean-Room Laboratory Module
  // --------------------------------------------------------------------------
  addLabModule(x, z, w = 15, d = 12, opts = {}) {
    const cleanWall = this.M.metal(2, 0xc9d2da);
    const tile = this.M.tile(8);
    const dark = this.M.metalDark;
    const h = 3.8;
    const t = 0.32;

    this.reserveArea(x, z, w, d, 2.4);
    this.addCoverRing(x, z, w, d, 0);

    this.world.box(x, 0, z, w, 0.14, d, tile, Mat.CONCRETE);
    this.addWallWithOpening(x, 0, z + d * 0.5 - t * 0.5, w, h, t, 'x', cleanWall, {
      doorWidth: 2.0, doorOffset: 0, doorHeight: 2.4, withDoor: true,
    });
    this.addWallWithOpening(x, 0, z - d * 0.5 + t * 0.5, w, h, t, 'x', cleanWall, {
      doorWidth: 2.0, doorOffset: 0, doorHeight: 2.4, withDoor: false,
    });
    this.addWallWithOpening(x - w * 0.5 + t * 0.5, 0, z, d - t * 2, h, t, 'z', cleanWall, { windows: 2 });
    this.addWallWithOpening(x + w * 0.5 - t * 0.5, 0, z, d - t * 2, h, t, 'z', cleanWall, { windows: 2 });
    this.world.box(x, h, z, w + 0.4, 0.35, d + 0.4, dark, Mat.METAL);

    // Interior glass containment partition + cryo cylinders
    this.world._window(x - 2.2, 0.9, z, 3.4, 1.8, 'z');
    this.world.box(x - 2.2, 0.14, z, 3.6, 0.76, 0.24, cleanWall, Mat.CONCRETE);
    this.world.cyl(x - 3.6, 0.14, z - 2.4, 0.55, 0.55, 2.4, 10, this.M.emissiveScreen, Mat.METAL);
    this.world.box(x + 3.0, 0.14, z - 1.8, 2.2, 0.95, 0.9, dark, Mat.METAL);

    this.interiorNodes.push({ x: x + 2.4, y: 0.16, z: z + 1.2, tag: 'lab_room' });
    this.addFixtureLight(x, h - 0.25, z, 0xe2f4ff, 22, 16);
    this.addZone(x, 0, z, w - 0.6, h, d - 0.6, 'room');
    return new THREE.Vector3(x + 2.4, 0.16, z + 1.2);
  }

  // --------------------------------------------------------------------------
  // 20. Hydroelectric Dam Wall & Crest Roadway (with walkable stair towers!)
  // --------------------------------------------------------------------------
  addDamSpillway(x, z, spanW = 68, crestY = 4.4) {
    const conc = this.M.concrete(8);
    const asp = this.M.asphalt(8);
    const steel = this.M.metalDark;

    this.reserveArea(x, z, spanW, 18, 2.0);
    // Massive concrete dam crest deck + sloped buttresses
    this.world.box(x, 0, z, spanW, crestY, 8.6, conc, Mat.CONCRETE);
    this.world.box(x, crestY, z, spanW, 0.06, 7.4, asp, Mat.CONCRETE, { noCollider: true });
    // Crest guardrails (with openings at the twin access stair flights!)
    this.world.box(x, crestY, z - 4.05, spanW, 1.05, 0.35, conc, Mat.CONCRETE);
    this.world.box(x, crestY, z + 4.05, spanW * 0.46, 1.05, 0.35, conc, Mat.CONCRETE);

    // Upstream reservoir water (-Z) & tailrace spillway pool (+Z)
    this.world.box(x, crestY - 1.2, z - 14, spanW - 4, 0.8, 18, this.waterMat(0x16384c), Mat.CONCRETE);
    // Sluice gate piers along crest
    for (const sx of [-18, -6, 6, 18]) {
      this.world.box(x + sx, crestY, z - 3.6, 1.4, 2.8, 1.6, steel, Mat.METAL);
    }

    // Twin walkable switchback/ramp stair flights from lower apron (+Z) to dam crest!
    this.addStairFlight(x - spanW * 0.32, 0, z + 4.3 + 9.6, 9.6, crestY, 2.8, '-z', conc);
    this.addStairFlight(x + spanW * 0.32, 0, z + 4.3 + 9.6, 9.6, crestY, 2.8, '-z', conc);
    this.elevatedNodes.push({ x, y: crestY + 0.08, z, tag: 'dam_crest' });
    return new THREE.Vector3(x, crestY + 0.08, z);
  }

  // --------------------------------------------------------------------------
  // 21. Hardened Bunker Casemate & Rural Homestead
  // --------------------------------------------------------------------------
  addBunkerCasemate(x, z, w = 13, d = 11, opts = {}) {
    const conc = this.tintedConcrete(0x6e706c, 4);
    const h = 3.4;
    const t = 0.55;

    this.reserveArea(x, z, w, d + 4.5, 2.0);
    this.addCoverRing(x, z, w, d, 0);

    this.world.box(x, 0, z, w, 0.14, d, this.M.floorConc(5), Mat.CONCRETE);
    // Rear armored entry + front firing embrasures
    this.addWallWithOpening(x, 0, z + d * 0.5 - t * 0.5, w, h, t, 'x', conc, {
      doorWidth: 2.1, doorOffset: 0, doorHeight: 2.35,
    });
    // Front wall with horizontal firing slit
    this.world.box(x, 0, z - d * 0.5 + t * 0.5, w, 1.18, t, conc, Mat.CONCRETE);
    this.world.box(x, 1.85, z - d * 0.5 + t * 0.5, w, h - 1.85, t, conc, Mat.CONCRETE);
    this.world.box(x - w * 0.5 + t * 0.5, 0, z, t, h, d - t * 2, conc, Mat.CONCRETE);
    this.world.box(x + w * 0.5 - t * 0.5, 0, z, t, h, d - t * 2, conc, Mat.CONCRETE);
    // Heavy blast roof + rooftop sandbagged AA/observation deck via exterior stairs
    this.world.box(x, h, z, w + 0.8, 0.55, d + 0.8, conc, Mat.CONCRETE);
    const roofY = h + 0.55;
    this.world.box(x, roofY, z - d * 0.5 + 0.3, w, 0.95, 0.45, conc, Mat.CONCRETE);
    this.addStairFlight(x + w * 0.32, 0, z + d * 0.5 + 6.4, 6.0, roofY, 1.8, '-z', conc);

    this.interiorNodes.push({ x, y: 0.16, z, tag: 'bunker_room' });
    this.elevatedNodes.push({ x: x - 1.5, y: roofY + 0.04, z, tag: 'bunker_roof' });
    this.addZone(x, 0, z, w - 1, h, d - 1, 'room');
    return new THREE.Vector3(x, 0.16, z);
  }

  addRuralHomestead(x, z, w = 11, d = 9, opts = {}) {
    const wall = opts.stone ? this.tintedConcrete(0x9a9182, 4) : this.M.brick(4);
    const wood = this.M.wood(2, 0x6f5338);
    const h = 3.3;
    const t = 0.32;

    this.reserveArea(x, z, w, d + 2.2, 2.0);
    this.addCoverRing(x, z, w, d, 0);

    this.world.box(x, 0, z, w, 0.12, d, wood, Mat.WOOD);
    this.addWallWithOpening(x, 0, z + d * 0.5 - t * 0.5, w, h, t, 'x', wall, {
      doorWidth: 1.7, doorOffset: -1.5, doorHeight: 2.3, withDoor: true,
    });
    this.addWallWithOpening(x, 0, z - d * 0.5 + t * 0.5, w, h, t, 'x', wall, {
      doorWidth: 1.6, doorOffset: 1.5, doorHeight: 2.25,
    });
    this.addWallWithOpening(x - w * 0.5 + t * 0.5, 0, z, d - t * 2, h, t, 'z', wall, { windows: 2 });
    this.addWallWithOpening(x + w * 0.5 - t * 0.5, 0, z, d - t * 2, h, t, 'z', wall, { windows: 2 });
    // Stepped gable timber roof
    this.world.box(x, h, z, w + 0.7, 0.35, d + 0.7, wood, Mat.WOOD);
    this.world.box(x, h + 0.35, z, w * 0.68, 0.45, d + 0.5, wood, Mat.WOOD);
    this.world.box(x, h + 0.8, z, w * 0.34, 0.4, d + 0.3, wood, Mat.WOOD);

    // Low stone courtyard wall out front
    this.world.box(x + 2.6, 0, z + d * 0.5 + 1.6, 4.4, 0.95, 0.45, this.M.concrete(2), Mat.CONCRETE);
    this.world._cover(x + 2.6, z + d * 0.5 + 2.3, 0, 1);

    this.interiorNodes.push({ x, y: 0.14, z, tag: 'homestead_room' });
    this.addZone(x, 0, z, w - 0.6, h, d - 0.6, 'room');
    return new THREE.Vector3(x, 0.14, z);
  }

  // --------------------------------------------------------------------------
  // 22. Fortified Command Citadel (3-tier HQ keep + corner bastions + roof deck)
  // --------------------------------------------------------------------------
  addCommandCitadel(x, z, w = 22, d = 18, opts = {}) {
    const res = this.addMultiStoreyBuilding(x, z, w, d, 3, {
      tint: opts.tint || 0x707478,
      doors: true,
      sideEntry: true,
    });
    const conc = this.tintedConcrete(0x5c6066, 4);
    // 4 heavy octagonal/square corner bastions
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const bx = x + sx * (w * 0.5 + 1.1);
        const bz = z + sz * (d * 0.5 + 1.1);
        this.world.box(bx, 0, bz, 2.8, 11.4, 2.8, conc, Mat.CONCRETE);
        this.addCoverRing(bx, bz, 2.8, 2.8, 0);
      }
    }
    // Rooftop comms mast
    this.world.cyl(x - w * 0.25, 10.8, z - d * 0.22, 0.12, 0.24, 6.5, 8, this.M.metalDark, Mat.METAL);
    return res;
  }
}
