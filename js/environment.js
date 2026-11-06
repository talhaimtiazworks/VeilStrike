/**
 * environment.js
 * Lightweight, reusable procedural dressing for the outdoor battlefields.
 * Natural props are collected at map-build time and emitted as a handful of
 * InstancedMesh batches; no per-frame work and no unique mesh per blade/tree.
 */
import * as THREE from 'three';

function makeCanopyGeometry() {
  // A tapered, irregular profile gives the conifer several soft branch tiers
  // without stacking identical toy-like cones.
  const radial = 10;
  const rings = [
    [0.00, 0.12], [0.10, 0.42], [0.24, 0.50], [0.38, 0.38],
    [0.54, 0.32], [0.68, 0.22], [0.84, 0.15], [0.98, 0.015],
  ];
  const positions = [], indices = [];
  for (let r = 0; r < rings.length; r++) {
    const [y, radius] = rings[r];
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const waviness = 1 + 0.075 * Math.sin(a * 3 + r * 0.8) + 0.035 * Math.cos(a * 5 - r);
      positions.push(Math.cos(a) * radius * waviness, y, Math.sin(a) * radius * waviness);
    }
  }
  const row = radial + 1;
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < radial; i++) {
      const a = r * row + i, b = a + row;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

function makeCurvedPalmTrunk() {
  const g = new THREE.CylinderGeometry(0.105, 0.17, 1, 8, 5, false);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) + 0.5;
    p.setX(i, p.getX(i) + (y * y - y) * 0.055);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

function makeFrondGeometry() {
  const segments = 7;
  const positions = [], indices = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const width = Math.sin(Math.PI * Math.max(0.02, t)) * 0.18 + 0.003;
    const z = t;
    const y = -0.12 * t * t;
    positions.push(-width, y, z, width, y, z);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

function makeGrassTuftGeometry() {
  const positions = [], indices = [];
  // Five crossed, tapered blades form a small clump; DoubleSide material keeps
  // the foliage visible from both sides without adding a second mesh.
  for (let blade = 0; blade < 5; blade++) {
    const a = blade * Math.PI * 0.4;
    const h = 0.62 + (blade % 3) * 0.11;
    const lean = (blade - 2) * 0.035;
    const baseX = Math.cos(a) * 0.055, baseZ = Math.sin(a) * 0.055;
    const sideX = -Math.sin(a) * 0.045, sideZ = Math.cos(a) * 0.045;
    const n = positions.length / 3;
    positions.push(
      baseX - sideX, 0, baseZ - sideZ,
      baseX + sideX, 0, baseZ + sideZ,
      lean - sideX * 0.48, h * 0.56, lean * 0.5 - sideZ * 0.48,
      lean + sideX * 0.48, h * 0.56, lean * 0.5 + sideZ * 0.48,
      lean * 1.7, h, lean,
    );
    indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2, n + 2, n + 3, n + 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

function makeRidgeGeometry(seed = 17) {
  const nx = 56, nz = 12;
  const positions = [], indices = [];
  const phase = (seed % 997) * 0.013;
  for (let z = 0; z <= nz; z++) {
    const v = z / nz;
    const envelope = Math.pow(Math.sin(Math.PI * v), 0.72);
    for (let x = 0; x <= nx; x++) {
      const u = x / nx;
      const xx = u * 2 - 1;
      const broad = 0.30 + 0.18 * Math.sin(xx * 5.4 + phase) + 0.13 * Math.sin(xx * 11.7 - phase * 0.6);
      const peaks = 0.34 * Math.exp(-Math.pow((xx + 0.58) / 0.19, 2))
        + 0.46 * Math.exp(-Math.pow((xx + 0.08) / 0.24, 2))
        + 0.30 * Math.exp(-Math.pow((xx - 0.52) / 0.17, 2));
      const y = Math.max(0.06, broad + peaks) * envelope;
      positions.push(xx, y, v);
    }
  }
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const a = z * (nx + 1) + x, b = a + nx + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

function seeded(seed) {
  let n = (seed >>> 0) || 1;
  return () => {
    n = (n + 0x6D2B79F5) | 0;
    let t = n;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class EnvironmentKit {
  constructor(group, materialLibrary) {
    this.group = group;
    this.library = materialLibrary;
    this.batches = new Map();
    this.geometries = {
      pineTrunk: new THREE.CylinderGeometry(0.105, 0.17, 1, 8, 2),
      pineCanopy: makeCanopyGeometry(),
      snowCap: new THREE.ConeGeometry(0.5, 1, 9, 2),
      palmTrunk: makeCurvedPalmTrunk(),
      palmFrond: makeFrondGeometry(),
      rock: new THREE.DodecahedronGeometry(1, 0),
      grass: makeGrassTuftGeometry(),
      ridge: makeRidgeGeometry(41),
    };
    this.materials = {
      pineTrunk: materialLibrary.wood(1, 0x514333),
      palmTrunk: materialLibrary.wood(1, 0x756044),
      foliage: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98, metalness: 0 }),
      snow: materialLibrary.snow(2),
      palmLeaf: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, side: THREE.DoubleSide }),
      rock: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98, metalness: 0.01 }),
      grass: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, side: THREE.DoubleSide }),
    };
    this._dummy = new THREE.Object3D();
    this._color = new THREE.Color();
    this._flushed = false;
  }

  _push(key, geometry, material, x, y, z, sx, sy, sz, rx, ry, rz, color, castShadow = false) {
    let batch = this.batches.get(key);
    if (!batch) {
      batch = { geometry, material, castShadow, entries: [] };
      this.batches.set(key, batch);
    }
    batch.entries.push({ x, y, z, sx, sy, sz, rx, ry, rz, color });
  }

  addConifer(x, z, height = 7, snow = false, seed = 1) {
    const rnd = seeded(seed);
    const h = Math.max(3.5, height);
    const yaw = rnd() * Math.PI * 2;
    const canopyTint = this._color.setHSL(0.285 + rnd() * 0.045, 0.23 + rnd() * 0.1, 0.18 + rnd() * 0.045).getHex();
    const trunkTint = this._color.setHSL(0.085 + rnd() * 0.025, 0.2, 0.24 + rnd() * 0.06).getHex();
    this._push('pine-trunks', this.geometries.pineTrunk, this.materials.pineTrunk,
      x, h * 0.255, z, 1, h * 0.51, 1, 0, yaw, 0, trunkTint, true);
    this._push('pine-canopies', this.geometries.pineCanopy, this.materials.foliage,
      x, h * 0.255, z, h * (0.78 + rnd() * 0.08), h * 0.75, h * (0.78 + rnd() * 0.08), 0, yaw, 0, canopyTint, true);
    if (snow) {
      const capTint = this._color.setHSL(0.57, 0.12, 0.82 + rnd() * 0.08).getHex();
      this._push('pine-snow', this.geometries.snowCap, this.materials.snow,
        x + (rnd() - 0.5) * 0.25, h * 0.79, z + (rnd() - 0.5) * 0.25,
        h * 0.48, h * 0.22, h * 0.48, 0, yaw, 0, capTint, false);
    }
  }

  addPalm(x, z, height = 6, seed = 1) {
    const rnd = seeded(seed);
    const h = Math.max(3.5, height);
    const bend = (rnd() - 0.5) * 0.11;
    const yaw = rnd() * Math.PI * 2;
    const trunkTint = this._color.setHSL(0.095, 0.24, 0.29 + rnd() * 0.05).getHex();
    this._push('palm-trunks', this.geometries.palmTrunk, this.materials.palmTrunk,
      x, h * 0.5, z, 1, h, 1, 0, yaw, bend, trunkTint, true);
    const leafTint = this._color.setHSL(0.25 + rnd() * 0.035, 0.34, 0.25 + rnd() * 0.05).getHex();
    const leaves = 7;
    for (let i = 0; i < leaves; i++) {
      const a = (i / leaves) * Math.PI * 2 + yaw;
      this._push('palm-fronds', this.geometries.palmFrond, this.materials.palmLeaf,
        x, h * 0.88, z, 2.6, 1, h * (0.42 + rnd() * 0.045), -0.04 - rnd() * 0.1, a, 0, leafTint, false);
    }
  }

  addRock(x, z, size = 1.5, tint = 0x67645d, seed = 1) {
    const rnd = seeded(seed);
    const sx = size * (0.72 + rnd() * 0.22);
    const sy = size * (0.44 + rnd() * 0.16);
    const sz = size * (0.62 + rnd() * 0.26);
    const c = this._color.setHex(tint);
    c.offsetHSL((rnd() - 0.5) * 0.025, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.12);
    this._push('field-rocks', this.geometries.rock, this.materials.rock,
      x, sy * 0.66, z, sx, sy, sz, (rnd() - 0.5) * 0.35, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.35, c.getHex(), true);
  }

  addGrassTuft(x, z, size = 1, seed = 1, palette = 'field') {
    const rnd = seeded(seed);
    if (palette === 'dry') this._color.setHSL(0.105 + rnd() * 0.03, 0.26, 0.32 + rnd() * 0.08);
    else this._color.setHSL(0.28 + rnd() * 0.045, 0.30 + rnd() * 0.08, 0.23 + rnd() * 0.08);
    this._push('ground-cover', this.geometries.grass, this.materials.grass,
      x, 0.015, z, size * (2.0 + rnd() * 0.7), size * (0.48 + rnd() * 0.36), size * (2.0 + rnd() * 0.7),
      0, rnd() * Math.PI * 2, 0, this._color.getHex(), false);
  }

  addDistantRidges(map = 'rural', bounds = null, baseMap = null, skyProfile = null) {
    if (skyProfile === 'underground') return;
    if (map === 'metro') { this._addMetroSkyline(); return; }
    const colors = {
      snow: 0x46535e, desert: 0x514a3f, rural: 0x28392e,
      urban: 0x30353a, industrial: 0x2a3034, facility: 0x252d32, range: 0x283139,
      recon_canyon: 0x514739, riverside_village: 0x263934,
      canal_market: 0x28353c, ridge_hold: 0x3a4856,
    };
    const hex = colors[map] || (baseMap && colors[baseMap]) || colors.rural;
    const mat = new THREE.MeshStandardMaterial({ color: hex, roughness: 1, metalness: 0 });
    const halfSpan = bounds ? Math.max(Math.abs(bounds.maxX || 90), Math.abs(bounds.maxZ || 90)) : 90;
    const dist = Math.max(112, halfSpan + 24);
    const dims = [Math.max(106, dist * 0.96), 23, 44];
    for (const [x, z, ry] of [
      [0, -dist, 0], [0, dist, Math.PI], [dist, 0, Math.PI / 2], [-dist, 0, -Math.PI / 2],
    ]) {
      const ridge = new THREE.Mesh(this.geometries.ridge, mat);
      ridge.position.set(x, -0.4, z);
      ridge.scale.set(...dims);
      ridge.rotation.y = ry;
      ridge.castShadow = false;
      ridge.receiveShadow = false;
      ridge.renderOrder = -2;
      this.group.add(ridge);
    }
  }

  _addMetroSkyline() {
    const count = 52;
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0.02 }),
      count
    );
    const rnd = seeded(0x4d455452);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (rnd() - 0.5) * 0.075;
      const radius = 204 + rnd() * 54;
      const h = 24 + rnd() * 56;
      const w = 8 + rnd() * 19;
      const d = 10 + rnd() * 18;
      this._dummy.position.set(Math.cos(a) * radius, h * 0.5 - 0.8, Math.sin(a) * radius);
      this._dummy.rotation.set(0, a * 0.32, 0);
      this._dummy.scale.set(w, h, d);
      this._dummy.updateMatrix();
      mesh.setMatrixAt(i, this._dummy.matrix);
      mesh.setColorAt(i, this._color.setHSL(0.56 + rnd() * 0.035, 0.08 + rnd() * 0.08, 0.105 + rnd() * 0.075));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = true;
    mesh.renderOrder = -1;
    this.group.add(mesh);
  }

  flush() {
    if (this._flushed) return;
    for (const batch of this.batches.values()) {
      const count = batch.entries.length;
      if (!count) continue;
      const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, count);
      mesh.name = `environment-${Array.from(this.batches.entries()).find(([, b]) => b === batch)?.[0] || 'batch'}`;
      mesh.castShadow = batch.castShadow;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      for (let i = 0; i < count; i++) {
        const e = batch.entries[i];
        this._dummy.position.set(e.x, e.y, e.z);
        this._dummy.rotation.set(e.rx, e.ry, e.rz);
        this._dummy.scale.set(e.sx, e.sy, e.sz);
        this._dummy.updateMatrix();
        mesh.setMatrixAt(i, this._dummy.matrix);
        if (e.color != null) mesh.setColorAt(i, this._color.setHex(e.color));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }
    this._flushed = true;
  }
}
