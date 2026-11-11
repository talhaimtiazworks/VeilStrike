/**
 * geometry.js
 * Small shared low-poly shape library for original procedural character,
 * weapon and vehicle presentation. Geometries are immutable and cached.
 */
import * as THREE from 'three';

const roundedBoxes = new Map();

/** Unit cube with softened bevels. Scale the returned shared geometry per mesh. */
export function roundedBoxGeometry(segments = 4, radius = 0.105) {
  const key = `${segments}:${radius}`;
  if (roundedBoxes.has(key)) return roundedBoxes.get(key);
  const faces = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  const positions = [], normals = [], uvs = [], indices = [];
  const side = segments + 1;
  for (const face of faces) {
    const offset = positions.length / 3;
    for (let a = 0; a <= segments; a++) for (let b = 0; b <= segments; b++) {
      const au = a / segments - 0.5, bv = b / segments - 0.5;
      const p = [
        face.n[0] * 0.5 + face.u[0] * au + face.v[0] * bv,
        face.n[1] * 0.5 + face.u[1] * au + face.v[1] * bv,
        face.n[2] * 0.5 + face.u[2] * au + face.v[2] * bv,
      ];
      const core = p.map(v => THREE.MathUtils.clamp(v, -0.5 + radius, 0.5 - radius));
      let nx = p[0] - core[0], ny = p[1] - core[1], nz = p[2] - core[2];
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      positions.push(core[0] + nx * radius, core[1] + ny * radius, core[2] + nz * radius);
      normals.push(nx, ny, nz);
      uvs.push(a / segments, b / segments);
    }
    for (let a = 0; a < segments; a++) for (let b = 0; b < segments; b++) {
      const i = offset + a * side + b;
      indices.push(i, i + side, i + 1, i + side, i + side + 1, i + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  roundedBoxes.set(key, geometry);
  return geometry;
}
