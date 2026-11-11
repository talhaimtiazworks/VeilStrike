/**
 * map3d.js — Phase 14 · Interactive 3D world map view for VEILSTRIKE.
 *
 * A perspective/iso 3D representation of the LIVE mission world, opened as a
 * view mode inside the tactical-map screen (VIEW: 3D toggle). Built strictly
 * from real runtime data — nothing fabricated:
 *
 *   - terrain/structures: g.physics.colliders AABBs, instanced per material
 *   - bounds: g.world.bounds → ground plane footprint
 *   - markers: g.missions.mapTargets() (objective ◆ / extraction ring, live
 *     position refresh — escort and vehicle objectives move)
 *   - player: g.player.pos + g.player.yaw (live heading arrow)
 *   - hostiles: g.tacmap.known only — seen/intel-marked contacts, pruned by
 *     the same 26s knowledge contract as the 2D map (no cheater wallhack)
 *
 * Controls: drag = orbit · wheel/pinch = zoom · right-drag / shift-drag /
 * two-finger = pan · RECENTER follows the player · RESET restores defaults.
 * Input isolation is inherited: while the map screen is up tacmap.open stays
 * true, so the game loop keeps discarding gameplay edge inputs.
 *
 * Lifecycle: the scene is built on enter() and fully disposed on exit()
 * (mission change → next enter builds fresh). The WebGL renderer is created
 * once and reused, so WebGL context count is bounded at 1 across opens; the
 * rAF loop runs ONLY while the view is open.
 */

import * as THREE from 'three';

const MAT_COLOR3D = {
  concrete: 0x46525c, metal: 0x5a6a78, wood: 0x6a5638,
  glass: 0x7ac8e8, soil: 0x3b362c, gravel: 0x403c34, fabric: 0x463f4c,
};
const TAG_COLOR3D = { door: 0x35b6c9, glass: 0x7ac8e8, prop: 0x6b5a41, shield: 0xff9a3d };
const MAX_HOSTILES = 48;

export class Map3DView {
  constructor(game, tacmap) {
    this.game = game;
    this.tacmap = tacmap;
    this._open = false;
    this._raf = null;
    // renderer persists across opens (bounded WebGL context count = 1);
    // scene resources are disposed and rebuilt on every enter().
    this._renderer = null;
    this._scene = null;
    this._camera = null;
    this._disposables = [];
    // camera orbit state
    this._yaw = 0;
    this._pitch = 1.0;
    this._dist = 60;
    this._target = new THREE.Vector3();
    this._defaults = null;
    // live actors
    this._playerArrow = null;
    this._hostiles = null;
    this._markers = [];
    this._markerGroup = null;
    this._markerT = 0;
    this._colliderCount = 0;
    this._hostileCount = 0;
    this._t = 0;
    // scratch
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._up = new THREE.Vector3(0, 1, 0);

    this.canvas = document.getElementById('map3dcanvas');
    this.stage = document.getElementById('map3d-stage');
    this._bindDom();
    this._bindPointer();
  }

  // ------------------------------------------------------------------- dom
  _bindDom() {
    const on = (id, fn) => { const e = document.getElementById(id); if (e) e.addEventListener('click', (ev) => { ev.preventDefault(); fn(); }); };
    on('tac3d-zoomin', () => this.zoomBy(1));
    on('tac3d-zoomout', () => this.zoomBy(-1));
    on('tac3d-recenter', () => this.recenter());
    on('tac3d-reset', () => this.resetView());
  }

  _bindPointer() {
    if (!this.canvas) return;
    const cv = this.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    let drag = null; // {mode:'orbit'|'pan', x, y}
    cv.addEventListener('pointerdown', (e) => {
      if (!this._open) return;
      cv.setPointerCapture(e.pointerId);
      const pan = e.button === 2 || e.shiftKey;
      drag = { mode: pan ? 'pan' : 'orbit', x: e.clientX, y: e.clientY };
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this._open || !drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.mode === 'orbit') this.orbitBy(dx, dy); else this.panByPx(dx, dy);
    });
    const up = () => { drag = null; };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      if (!this._open) return;
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    // touch: 1-finger orbit, 2-finger pan + pinch zoom
    let pinch = 0;
    cv.addEventListener('touchstart', (e) => {
      if (!this._open) return;
      e.preventDefault();
      if (e.touches.length === 2) {
        pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        this._tmid = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
      } else if (e.touches.length === 1) {
        drag = { mode: 'orbit', x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
    }, { passive: false });
    cv.addEventListener('touchmove', (e) => {
      if (!this._open) return;
      e.preventDefault();
      if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (pinch > 0 && d > 0) this._zoomScale(d / pinch);
        pinch = d;
        const mid = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
        if (this._tmid) this.panByPx(mid.x - this._tmid.x, mid.y - this._tmid.y);
        this._tmid = mid;
      } else if (e.touches.length === 1 && drag) {
        const dx = e.touches[0].clientX - drag.x, dy = e.touches[0].clientY - drag.y;
        drag.x = e.touches[0].clientX; drag.y = e.touches[0].clientY;
        this.orbitBy(dx, dy);
      }
    }, { passive: false });
    const tend = () => { pinch = 0; this._tmid = null; drag = null; };
    cv.addEventListener('touchend', tend);
    cv.addEventListener('touchcancel', tend);
  }

  // ------------------------------------------------------------------ views
  orbitBy(dx, dy) {
    this._yaw -= dx * 0.0052;
    this._pitch = THREE.MathUtils.clamp(this._pitch + dy * 0.0045, 0.28, 1.45);
  }
  _zoomScale(f) {
    this._dist = THREE.MathUtils.clamp(this._dist / f, this._minDist(), this._maxDist());
  }
  zoomBy(step) { this._zoomScale(step > 0 ? 1.18 : 1 / 1.18); }
  panByPx(dx, dy) {
    // move the orbit target across the ground plane, camera-relative
    const k = this._dist * 0.0016;
    const fx = Math.sin(this._yaw), fz = Math.cos(this._yaw);       // camera forward (XZ)
    const rx = Math.sin(this._yaw + Math.PI / 2), rz = Math.cos(this._yaw + Math.PI / 2);
    this._target.x -= (rx * dx - fx * dy) * k;
    this._target.z -= (rz * dx - fz * dy) * k;
    this._clampTarget();
  }
  recenter() {
    const g = this.game;
    if (g.player) { this._target.copy(g.player.pos); this._target.y = 0; }
    this._clampTarget();
  }
  resetView() {
    if (!this._defaults) return;
    this._yaw = this._defaults.yaw;
    this._pitch = this._defaults.pitch;
    this._dist = this._defaults.dist;
    this.recenter();
  }
  _minDist() { return 12; }
  _maxDist() { const g = this.game; const b = g.world && g.world.bounds; return b ? Math.max(220, (b.maxX - b.minX) * 2.2) : 420; }
  _clampTarget() {
    const b = this.game.world && this.game.world.bounds;
    if (!b) return;
    this._target.x = THREE.MathUtils.clamp(this._target.x, b.minX, b.maxX);
    this._target.z = THREE.MathUtils.clamp(this._target.z, b.minZ, b.maxZ);
  }

  // ------------------------------------------------------------- lifecycle
  enter() {
    const g = this.game;
    if (this._open || !this.canvas || !this.stage) return;
    this._open = true;
    if (!this._renderer) {
      this._renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: false });
      this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    }
    this.stage.classList.remove('hidden');
    this._build();
    this.resize();
    const fps = 30, frameMs = 1000 / fps;
    let last = 0;
    const loop = (t) => {
      if (!this._open) { this._raf = null; return; }
      this._raf = requestAnimationFrame(loop);
      if (t - last < frameMs) return;        // 30fps budget, like the 2D map cadence
      last = t;
      this._tick(Math.min(0.1, frameMs / 1000));
    };
    this._raf = requestAnimationFrame(loop);
  }

  exit() {
    if (!this._open) return;
    this._open = false;
    if (this._raf != null) { cancelAnimationFrame(this._raf); this._raf = null; }
    this._disposeScene();
    if (this.stage) this.stage.classList.add('hidden');
  }

  disposeAll() { this.exit(); if (this._renderer) { this._renderer.dispose(); this._renderer = null; } }

  resize() {
    if (!this._renderer || !this._camera || !this.stage) return;
    const w = Math.max(280, this.stage.clientWidth || 560);
    const h = Math.max(240, this.stage.clientHeight || 480);
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  _build() {
    const g = this.game;
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0x0a0e12);
    this._disposables = [];
    this._markers = [];
    this._camera = new THREE.PerspectiveCamera(50, 1, 0.5, 2000);
    const b = (g.world && g.world.bounds) || { minX: -70, maxX: 70, minZ: -70, maxZ: 70 };
    const ext = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);

    this._scene.add(new THREE.HemisphereLight(0x9db4c8, 0x1c222a, 1.1));
    const dir = new THREE.DirectionalLight(0xdfe9f2, 0.9);
    dir.position.set(0.45, 1, 0.3);
    this._scene.add(dir);
    this._scene.fog = new THREE.Fog(0x0a0e12, ext * 0.9, ext * 2.6);

    // ground footprint = real world bounds
    const gGeo = new THREE.PlaneGeometry(b.maxX - b.minX, b.maxZ - b.minZ);
    const gMat = new THREE.MeshLambertMaterial({ color: 0x141a20 });
    const ground = new THREE.Mesh(gGeo, gMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((b.minX + b.maxX) / 2, -0.05, (b.minZ + b.maxZ) / 2);
    this._scene.add(ground);
    this._disposables.push(gGeo, gMat);
    // 20 m grid for scale
    const grid = new THREE.GridHelper(ext, Math.max(2, Math.round(ext / 20)), 0x243040, 0x1a2330);
    grid.position.y = 0.02;
    this._scene.add(grid);
    this._disposables.push(grid.geometry, grid.material);

    // ---------------------------------------------------------------- world
    const groups = new Map(); // key 'mat:<name>' | 'tag:<name>' -> matrices
    const cols = (g.physics && g.physics.colliders) || [];
    this._colliderCount = cols.length;
    for (const c of cols) {
      if (!c || !c.min || !c.max || c.enabled === false) continue;
      const sx = Math.max(0.12, c.max.x - c.min.x);
      const sy = Math.max(0.12, c.max.y - c.min.y);
      const sz = Math.max(0.12, c.max.z - c.min.z);
      if (sx > 500 || sz > 500) continue; // safety: no absurd slabs
      this._v.set((c.min.x + c.max.x) / 2, (c.min.y + c.max.y) / 2, (c.min.z + c.max.z) / 2);
      this._s.set(sx, sy, sz);
      this._q.identity();
      const m = new THREE.Matrix4().compose(this._v, this._q, this._s);
      const key = (c.tag && c.tag !== 'static') ? 'tag:' + c.tag : 'mat:' + (c.material || 'concrete');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this._disposables.push(boxGeo);
    for (const [key, mats] of groups) {
      const [kind, name] = key.split(':');
      const color = kind === 'tag' ? (TAG_COLOR3D[name] ?? 0x46525c) : (MAT_COLOR3D[name] ?? 0x46525c);
      const mat = new THREE.MeshLambertMaterial({
        color,
        transparent: name === 'glass',
        opacity: name === 'glass' ? 0.42 : 1,
      });
      const inst = new THREE.InstancedMesh(boxGeo, mat, mats.length);
      for (let i = 0; i < mats.length; i++) inst.setMatrixAt(i, mats[i]);
      inst.instanceMatrix.needsUpdate = true;
      this._scene.add(inst);
      this._disposables.push(mat);
    }

    // ------------------------------------------------------------- player
    const pGeo = new THREE.ConeGeometry(1.4, 4.2, 5);
    const pMat = new THREE.MeshBasicMaterial({ color: 0x62d4ff });
    this._playerArrow = new THREE.Mesh(pGeo, pMat);
    this._playerArrow.rotation.order = 'YXZ';
    this._scene.add(this._playerArrow);
    this._disposables.push(pGeo, pMat);

    // ------------------------------------------------------------ hostiles
    const hGeo = new THREE.SphereGeometry(1.1, 8, 6);
    const hMat = new THREE.MeshBasicMaterial({ color: 0xe23c3c });
    this._hostiles = new THREE.InstancedMesh(hGeo, hMat, MAX_HOSTILES);
    this._hostiles.count = 0;
    this._scene.add(this._hostiles);
    this._disposables.push(hGeo, hMat);

    // ------------------------------------------------------------- markers
    this._markerGroup = new THREE.Group();
    this._scene.add(this._markerGroup);
    this._rebuildMarkers();

    // camera defaults: behind/above the player, dist scaled to the world
    this._defaults = { yaw: (g.player ? g.player.yaw : 0), pitch: 1.0, dist: THREE.MathUtils.clamp(ext * 0.42, 40, 260) };
    this.resetView();
    this._tick(0);
  }

  _rebuildMarkers() {
    const g = this.game;
    // dispose previous
    for (const mk of this._markers) { this._markerGroup.remove(mk.mesh); if (mk.label) this._markerGroup.remove(mk.label); }
    this._markers = [];
    const targets = (g.missions && g.missions.mapTargets) ? g.missions.mapTargets() : [];
    for (const t of targets) {
      let mesh;
      if (t.kind === 'extraction') {
        const geo = new THREE.TorusGeometry(3.2, 0.5, 6, 22);
        const mat = new THREE.MeshBasicMaterial({ color: 0x71e08a });
        mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        this._disposables.push(geo, mat);
      } else {
        const geo = new THREE.OctahedronGeometry(2.2);
        const mat = new THREE.MeshBasicMaterial({ color: t.kind === 'objective' ? 0x62d46a : 0xe0b34d });
        mesh = new THREE.Mesh(geo, mat);
        this._disposables.push(geo, mat);
      }
      const label = this._makeLabel(t.kind === 'extraction' ? 'EXTRACTION' : (t.label || 'OBJECTIVE').slice(0, 26));
      this._markerGroup.add(mesh);
      if (label) this._markerGroup.add(label);
      this._markers.push({ mesh, label, kind: t.kind, text: t.label || t.kind });
    }
  }

  _makeLabel(text) {
    if (!text) return null;
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 48;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(8,12,16,0.72)';
    ctx.fillRect(0, 0, 256, 48);
    ctx.font = '600 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#bfe3c9';
    ctx.fillText(text.toUpperCase(), 128, 25);
    const tex = new THREE.CanvasTexture(cv);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(18, 3.4, 1);
    this._disposables.push(tex, mat);
    return sp;
  }

  _tick(dt) {
    if (!this._scene) return;
    const g = this.game;
    this._t += dt;
    // live player arrow
    if (g.player && this._playerArrow) {
      this._playerArrow.position.set(g.player.pos.x, 4.2, g.player.pos.z);
      this._playerArrow.rotation.set(Math.PI / 2, -g.player.yaw, 0);
    }
    // live hostiles from the shared knowledge contract (2D + 3D consistent)
    let n = 0;
    if (this._hostiles && this.tacmap) {
      this._q.identity(); this._s.set(1, 1, 1);
      for (const [e, k] of this.tacmap.known) {
        if (n >= MAX_HOSTILES) break;
        if (!e.alive) continue;
        this._v.set(k.x, 2.4, k.z);
        this._m.compose(this._v, this._q, this._s);
        this._hostiles.setMatrixAt(n++, this._m);
      }
      this._hostiles.count = n;
      if (n) this._hostiles.instanceMatrix.needsUpdate = true;
    }
    this._hostileCount = n;
    // markers: refresh from mapTargets (handles moving objectives/count change)
    this._markerT -= dt;
    if (this._markerT <= 0) {
      this._markerT = 0.5;
      const targets = (g.missions && g.missions.mapTargets) ? g.missions.mapTargets() : [];
      if (targets.length !== this._markers.length) this._rebuildMarkers();
      for (let i = 0; i < this._markers.length && i < targets.length; i++) {
        const mk = this._markers[i], t = targets[i];
        const pulse = 1 + 0.15 * Math.sin(this._t * 4);
        mk.mesh.position.set(t.pos.x, t.kind === 'extraction' ? 1.2 : 5.2 + 0.8 * Math.sin(this._t * 3), t.pos.z);
        mk.mesh.scale.setScalar(pulse);
        if (mk.label) mk.label.position.set(t.pos.x, 9.2, t.pos.z);
      }
    }
    // camera
    if (this._camera) {
      const cp = this._camera.position;
      cp.set(
        this._target.x + this._dist * Math.sin(this._yaw) * Math.cos(this._pitch),
        this._target.y + this._dist * Math.sin(this._pitch),
        this._target.z + this._dist * Math.cos(this._yaw) * Math.cos(this._pitch),
      );
      this._camera.lookAt(this._target);
      this._renderer.render(this._scene, this._camera);
    }
  }

  _disposeScene() {
    if (!this._scene) return;
    for (const mk of this._markers) { if (mk.mesh.geometry && mk.mesh.geometry !== undefined) { /* geos tracked below */ } }
    for (const d of this._disposables) { try { d.dispose && d.dispose(); } catch (e) { /* already disposed */ } }
    this._disposables = [];
    this._markers = [];
    this._markerGroup = null;
    this._playerArrow = null;
    this._hostiles = null;
    this._scene = null;
    this._camera = null;
  }

  // ------------------------------------------------------------------ probe
  /** Structured state for automated verification + debugging. */
  state() {
    return {
      open: this._open,
      built: !!this._scene,
      colliders: this._colliderCount,
      physicsColliders: (this.game.physics && this.game.physics.colliders.length) || 0,
      markers: this._markers.map(m => ({ kind: m.kind, text: m.text })),
      hostiles: this._hostileCount,
      cam: {
        yaw: +this._yaw.toFixed(3),
        pitch: +this._pitch.toFixed(3),
        dist: +this._dist.toFixed(1),
        target: [+this._target.x.toFixed(1), +this._target.y.toFixed(1), +this._target.z.toFixed(1)],
      },
      rafActive: this._raf != null,
      rendererLive: !!this._renderer,
    };
  }
}
