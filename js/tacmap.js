/**
 * tacmap.js
 * Live tactical map + HUD mini-map for VEILSTRIKE (v4.3 rebuild).
 *
 * Design rules this file is built around:
 *  · Every drawn shape comes from mission data — the collider set, world.bounds,
 *    doors, authored patrol paths, cover points, interactables and
 *    missions.mapTargets() — classified by js/mapgeom.js. Nothing is invented.
 *  · Vector drawing in screen space only. No upscaled bitmaps, no blur, no glow,
 *    no filters: line widths and glyph sizes are constant on screen while the
 *    world scales, so the map stays readable at every zoom level.
 *  · The route is *found*, not assumed: it is A* over the same walkability grid
 *    the collision classification produces, so it never crosses a wall. When no
 *    path exists the map says so instead of drawing a straight wishful line.
 *  · Information discipline: hostiles and friendlies appear only through the
 *    detection knowledge in update() (line of sight, confirmed contact, flare or
 *    sensor reveal). The map never becomes a wallhack.
 *  · Labels are placed by reserving screen rectangles, so text cannot land on
 *    top of a feature, the player icon or another label.
 *
 * Controls: wheel / +- zoom (anchored on the cursor), drag or two-finger pan,
 * FIT to frame the whole mission area, ROT to switch north-up / player-up,
 * ROUTE to choose primary / optional / extraction / off, VIEW for the 3D world
 * view (map3d.js), tap or click a marker to select it, M or ESC to close.
 */
import * as THREE from 'three';
import { Map3DView } from './map3d.js';
import { ensureMapGeometry, buildNavGrid, routeTo, pathLength, MAP_ITEM_KINDS, MAP_GEOM } from './mapgeom.js';

const DEG = Math.PI / 180;
const PPM = 4.0;                       // px per metre at zoom 1
const ZOOM_STEP = 1.45;                // one press of + / -
const PAN_KEY_PX = 52;                 // one arrow tap, in screen pixels
const PAN_KEY_FAST_PX = 190;           // with Shift held
const HIT_PAD = 4;                     // px of slack around a symbol for tapping

/** Restrained field-manual palette: dark paper, muted masses, one accent per meaning. */
export const MAP_STYLE = {
  field: '#0d1218', outside: '#080b0f', bounds: '#3c4a55',
  tint: {
    structure: '#1f2830', metal: '#24313c', wood: '#2b2318', glass: '#1c2f39',
    ground: '#151d24', soft: '#1e1b24',
  },
  edge: '#48596a', edgeSoft: '#2c3845',
  ground: '#111820', lowdeck: '#18222b', deck: '#1d2a34', room: '#161f27',
  road: '#1b242d', roadEdge: '#324250', open: '#101922',
  path: '#2f3d47', cover: '#3a4a54',
  prop: '#202b33', propEdge: '#3b4a56',
  wall: '#54677a', barrier: '#3d4a55', glassEdge: '#5f8ea0',
  obj: '#3ddc84', objText: '#bdf0cf',
  opt: '#c9a24b', ext: '#37b8d9', route: '#e8b64a', routeCasing: '#0d1218',
  you: '#d6f2ff', youEdge: '#0d1218',
  foe: '#ff5c47', foeOld: '#a8544a', friend: '#6fa8ff', veh: '#9fb0bd',
  supply: '#e8d259', intel: '#ffe066', door: '#59d8e8',
  fog: 'rgba(5,8,12,0.82)', fogEdge: 'rgba(126,156,176,0.30)',
  fov: 'rgba(180,225,255,0.085)', fovEdge: 'rgba(180,225,255,0.20)',
  fovRadius: 11, fovHalfDeg: 33,
  text: '#cfe0e6', dim: '#8fa2ad', plate: 'rgba(8,11,15,0.78)',
  font: '10px "JetBrains Mono", ui-monospace, monospace',
  fontBold: 'bold 10px "JetBrains Mono", ui-monospace, monospace',
  fontTiny: '9px "JetBrains Mono", ui-monospace, monospace',
};

/**
 * The single source of truth for what a symbol means. The legend the player
 * reads is generated from this table, and the renderer paints the glyph for
 * each `kind` — so a symbol cannot exist on the map without an explanation
 * (tests/tacmap_tests.mjs asserts both directions).
 */
export const MAP_LEGEND = [
  { kind: 'you', label: 'YOU — arrow = facing, wedge = view' },
  { kind: 'objective', label: 'PRIMARY OBJECTIVE' },
  { kind: 'optional', label: 'OPTIONAL OBJECTIVE' },
  { kind: 'extraction', label: 'EXTRACTION LZ' },
  { kind: 'route', label: 'WALKABLE ROUTE (walked, not straight-line)' },
  { kind: 'noRoute', label: 'NO WALKABLE ROUTE TO SELECTION' },
  { kind: 'enemy', label: 'HOSTILE — SEEN NOW' },
  { kind: 'enemyOld', label: 'HOSTILE — LAST KNOWN (fades)' },
  { kind: 'friend', label: 'FRIENDLY / CONTACT' },
  { kind: 'vehicle', label: 'VEHICLE' },
  { kind: 'power', label: 'POWER / GENERATOR  [P]' },
  { kind: 'terminal', label: 'TERMINAL / HACK  [T]' },
  { kind: 'charge', label: 'CHARGE SITE  [X]' },
  { kind: 'intel', label: 'INTEL / EVIDENCE  [I]' },
  { kind: 'observe', label: 'OBSERVATION POST  [O]' },
  { kind: 'contact', label: 'NPC CONTACT  [C]' },
  { kind: 'supply', label: 'SUPPLY / EQUIPMENT  [S]' },
  { kind: 'ammo', label: 'AMMUNITION  [A]' },
  { kind: 'weapon', label: 'WEAPON CACHE  [W]' },
  { kind: 'cache', label: 'SEALED CACHE  [$]' },
  { kind: 'door', label: 'DOOR (hollow = open)' },
  { kind: 'building', label: 'BUILDING MASS' },
  { kind: 'wall', label: 'WALL / FENCE' },
  { kind: 'barrier', label: 'LOW BARRIER (vaultable)' },
  { kind: 'prop', label: 'CRATE / PROP' },
  { kind: 'deck', label: 'DECK / CATWALK / ROOF LEVEL' },
  { kind: 'room', label: 'INTERIOR SPACE' },
  { kind: 'road', label: 'ROAD / PAVED SURFACE' },
  { kind: 'openGround', label: 'OPEN / UNPAVED GROUND' },
  { kind: 'path', label: 'AUTHORED PATH / PATROL LINE' },
  { kind: 'cover', label: 'COVER POSITION' },
  { kind: 'unexplored', label: 'UNEXPLORED (fog)' },
  { kind: 'bounds', label: 'MISSION AREA BOUNDARY' },
];

const LEGEND_BY_KIND = new Map(MAP_LEGEND.map((l) => [l.kind, l]));

/** Roles drawn as filled masses, bottom of the stack first. */
const MASS_LAYERS = [
  ['ground', 'lowdeck', 'deck', 'room'],
  ['prop', 'barrier', 'wall', 'building', 'landmark', 'glass', 'vehicle'],
];

/** Masses the player may tap for a card. Ground washes and vehicle pads are skipped:
 *  a wash is context, not an object, and the pad glyph already carries its own. */
const SELECTABLE_ROLES = new Set(['building', 'landmark', 'room', 'deck', 'lowdeck', 'wall', 'barrier', 'prop', 'glass']);

/**
 * Layer switches (v4.4). A layer only gates *painting*: the geometry, the nav grid
 * and the route are computed from the mission data regardless, so hiding walls can
 * never hide an obstacle from the route planner or reset the view.
 */
export const MAP_LAYERS = [
  { key: 'buildings', label: 'BUILDINGS', hint: 'masses, interiors, landmarks' },
  { key: 'walls', label: 'WALLS & OBSTACLES', hint: 'walls, barriers, cover, doors' },
  { key: 'roads', label: 'ROADS & PATHS', hint: 'paved ground and authored lanes' },
  { key: 'terrain', label: 'TERRAIN', hint: 'open ground, decks, curbs' },
  { key: 'objectives', label: 'OBJECTIVES', hint: 'primary, optional, extraction' },
  { key: 'friendlies', label: 'FRIENDLY UNITS', hint: 'contacts the mission reports' },
  { key: 'enemies', label: 'KNOWN ENEMIES', hint: 'seen or remembered only' },
  { key: 'vehicles', label: 'VEHICLES', hint: 'spawn pads and live hulls' },
  { key: 'supplies', label: 'DISCOVERED SUPPLY', hint: 'revealed caches, ammo, gear' },
  { key: 'route', label: 'ROUTE', hint: 'walkable path to the selection' },
  { key: 'fog', label: 'FOG OF WAR', hint: 'dark cells are unexplored' },
];

/** Which switch owns which classified role. */
const ROLE_LAYER = {
  ground: 'terrain', lowdeck: 'terrain', deck: 'terrain', curb: 'terrain', flat: 'terrain',
  room: 'buildings', building: 'buildings', landmark: 'buildings', glass: 'buildings',
  path: 'roads',
  wall: 'walls', barrier: 'walls', prop: 'walls', cover: 'walls', door: 'walls',
  vehicle: 'vehicles',
};
const SURFACE_LAYER = { road: 'roads', open: 'terrain' };
const ITEM_LAYER = {
  supply: 'supplies', ammo: 'supplies', weapon: 'supplies', cache: 'supplies',
};

export class TacticalMap {
  constructor(game) {
    this.game = game;
    this.open = false;
    // ---- view (v4.4: an animated, pointer-driven camera) -------------------
    // The *rendered* values ease toward the *target* values. Zoom is interpolated
    // in log space so a wheel notch feels linear, and nothing is ever rasterised,
    // so "smooth" and "sharp" are not in conflict here.
    this.zoom = 1;
    this.panX = 0; this.panY = 0;      // world-metre view offset from the player
    this._zoomT = 1; this._panXT = 0; this._panYT = 0;
    this._animT = 0;                   // wall-clock of the last animated frame
    this._animating = false;
    this.minZoom = 0.06;
    this.maxZoom = 10.0;
    this.rotateMode = 'north';         // 'north' | 'player'
    this.follow = false;               // keep the player centred while the sim runs
    this.routeSel = 'primary';         // 'primary' | 'optional' | 'extraction' | 'custom' | null
    this.customTarget = null;          // {x, z, label} waypoint the player picked
    this.selected = null;              // inspected marker (see _markHit / select)
    this._hits = [];                   // rebuilt by every paint: screen boxes + payload
    this._drag = null;
    this._pointers = new Map();        // pointerId -> {x, y} for pinch
    this._mapBound = false;
    this._mapRebinds = 0;
    this._mapListenerCount = 0;
    this.layers = Object.create(null);
    for (const L of MAP_LAYERS) this.layers[L.key] = true;
    this.layersOpen = false;
    this._layerEls = [];
    this._insp = null;
    this.selectedRoute = null;
    this.float = { on: false, x: 0, y: 0, w: 0, h: 0, measured: false };
    this._bindings = [];
    this._paintingFull = false;
    this.showCover = true;
    this.fog = null;
    this.known = new Map();            // enemy → {x, z, t}
    this.knownNpc = new Map();         // npc → {x, z, t}
    this._detectT = 0;
    this.geom = null;
    this._fogCv = document.createElement('canvas');
    this._fogCtx = this._fogCv.getContext('2d');
    this._drawCalls = 0;               // instrumentation the tests read
    this._lastDrawMs = 0;
    this._route = null;                // {key, pts, meters, target}
    this._labels = [];
    this._labelBoxes = [];
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this.fullCv = document.getElementById('tacmap-canvas');
    this.fullCtx = this.fullCv ? this.fullCv.getContext('2d') : null;
    this.miniCv = document.getElementById('minimap');
    this.miniCtx = this.miniCv ? this.miniCv.getContext('2d') : null;
    this.el = document.getElementById('tacmap');
    this._buildLegendDom();

    // Phase 14: 3D world-map view mode (real runtime data only; see map3d.js).
    this.mode = '2d';                  // '2d' | '3d'
    this.map3d = null;
    try { this.map3d = new Map3DView(game, this); } catch (e) { this.map3d = null; }
    this._bindControls();
    if (this.fullCv) this._bindMapInput(this.fullCv);
    this._buildLayerDom();
    this._buildInspectorDom();
  }

  /**
   * Toolbar + window chrome. Every binding is recorded so a re-init cannot
   * accumulate listeners (the v4.3 firing tests proved that is a real risk).
   */
  _on(target, type, fn, opts) {
    if (!target || !target.addEventListener) return null;
    target.addEventListener(type, fn, opts);
    (this._bindings = this._bindings || []).push({ target, type, fn, opts });
    this._mapListenerCount++;
    return fn;
  }

  _bindControls() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return;
    const click = (id, fn) => {
      const el = doc.getElementById ? doc.getElementById(id) : null;
      if (!el) return;
      this._on(el, 'click', (e) => { if (e && e.preventDefault) e.preventDefault(); if (e && e.stopPropagation) e.stopPropagation(); fn(e); });
    };
    click('tac-3dbtn', () => this.toggleMode());
    click('tac-fitbtn', () => this.recenter('fit'));
    click('tac-zoomin', () => { this.zoomBy(ZOOM_STEP, null); if (this.open) this.drawFull(); });
    click('tac-zoomout', () => { this.zoomBy(1 / ZOOM_STEP, null); if (this.open) this.drawFull(); });
    click('tac-rotbtn', () => this.setRotate(this.rotateMode === 'player' ? 'north' : 'player'));
    click('tac-followbtn', () => this.setFollow(!this.follow));
    click('tac-playerbtn', () => this.recenter('player'));
    click('tac-objbtn', () => this.recenter('objective'));
    click('tac-routebtn', () => this.cycleRoute());
    click('tac-layersbtn', () => this.toggleLayersPanel());
    click('tacmap-inspect-recenter', () => this.recenter('marker'));
    click('tacmap-inspect-nav', () => this.navigateToSelection());
    click('tacmap-inspect-active', () => this.focusActiveObjective());
    click('tacmap-inspect-clear', () => { this.clearSelection(); if (this.open) this.drawFull(); });
    click('tac-close', () => this.close());
    click('tac-floatbtn', () => this.toggleFloat());
    click('tac-compass', () => this.setRotate(this.rotateMode === 'player' ? 'north' : 'player'));
    this._bindWindowChrome();
  }

  /**
   * Optional window chrome: the top bar moves the panel, the grip resizes it, and
   * neither is allowed to touch the map canvas — so grabbing the frame never pans
   * the map and dragging the map never moves the window.
   */
  _bindWindowChrome() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !doc.getElementById) return;
    const el = doc.getElementById('tacmap');
    const bar = doc.getElementById('tacmap-topbar');
    const grip = doc.getElementById('tacmap-grip');
    if (!el) return;
    let chrome = null;
    const start = (which) => (e) => {
      if (!this.open || this.mode === '3d') return;
      // Pressing a button in the bar (zoom, CLOSE, FLOAT) must not also drag the window,
      // and grabbing the resize grip must not resize while the pointer is on a control.
      const tgt = e && e.target;
      if (tgt && tgt.closest && tgt.closest('button, input, select, a')) return;
      if (e && e.preventDefault) e.preventDefault();
      chrome = {
        which,
        x: e.clientX, y: e.clientY,
        left: this.float.x, top: this.float.y,
        w: this.float.w, h: this.float.h,
      };
      el.classList.add('chrome-active');
    };
    const move = (e) => {
      if (!chrome) return;
      const dx = e.clientX - chrome.x, dy = e.clientY - chrome.y;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      if (chrome.which === 'move') {
        // Keep a lip of the window on screen: a map dragged fully off the viewport is
        // unrecoverable by touch (there is nothing left to grab), so 48 px must stay.
        const grab = 48;
        this.float.x = THREE.MathUtils.clamp(chrome.left + dx, -(this.float.w - grab), vw - grab);
        this.float.y = THREE.MathUtils.clamp(chrome.top + dy, 0, Math.max(0, vh - grab));
      } else {
        this.float.w = THREE.MathUtils.clamp(chrome.w + dx, 360, vw * 1.2);
        this.float.h = THREE.MathUtils.clamp(chrome.h + dy, 280, vh * 1.2);
      }
      this._applyFloat();
      if (this.open && this.mode !== '3d') this.drawFull();
    };
    const end = () => { if (!chrome) return; chrome = null; el.classList.remove('chrome-active'); };
    if (bar) {
      this._on(bar, 'pointerdown', start('move'));
      this._on(bar, 'dblclick', () => this.toggleFloat());
    }
    if (grip) this._on(grip, 'pointerdown', start('resize'));
    this._on(doc, 'pointermove', move);
    this._on(doc, 'pointerup', end);
    this._on(doc, 'pointercancel', end);
  }

  toggleFloat() {
    this.float.on = !this.float.on;
    if (this.float.on && !this.float.measured) {
      // "Float" has to produce a *smaller, movable* window. Sizing it from the
      // maximised box (which is the viewport) used to hand back a window exactly the
      // size of the screen - floating in name only.
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      this.float.w = Math.round(Math.max(340, Math.min(vw - 24, vw * 0.68, 1180)));
      this.float.h = Math.round(Math.max(280, Math.min(vh - 24, vh * 0.74, 820)));
      this.float.x = Math.round(Math.max(8, (vw - this.float.w) / 2));
      this.float.y = Math.round(Math.max(8, (vh - this.float.h) / 2));
      this.float.measured = true;
    }
    this._applyFloat();
    this._syncControls();
    if (this.open) this.drawFull();
  }

  _applyFloat() {
    const el = this.el;
    if (!el || !el.classList) return;
    el.classList.toggle('floating', !!this.float.on);
    const s = el.style;
    if (!s) return;
    if (this.float.on) {
      // `inset` is the shorthand for top/right/bottom/left: it must be written FIRST,
      // or it erases the offsets set next to it (that put the floating window at 0,0
      // and made the title-bar drag look like it did nothing).
      s.inset = 'auto';
      s.left = this.float.x + 'px'; s.top = this.float.y + 'px';
      s.width = this.float.w + 'px'; s.height = this.float.h + 'px';
      s.right = ''; s.bottom = '';
    } else {
      s.inset = '';
      s.left = s.top = s.width = s.height = '';
    }
    if (typeof window !== 'undefined' && this.game && this.game.onResize) {
      // the frame is inside the page, so the renderer aspect is unaffected; only the
      // canvas box changes, which drawFull() picks up from getBoundingClientRect
    }
  }

  // ---------------------------------------------------------------------
  // legend (generated from MAP_LEGEND so map and legend cannot drift apart)
  // ---------------------------------------------------------------------
  _buildLegendDom() {
    const host = document.getElementById('tacmap-legend');
    if (!host) return;
    host.innerHTML = '';
    const keys = ['M / ESC — CLOSE', 'DRAG — PAN', 'WHEEL — ZOOM', 'FIT — WHOLE AREA'];
    const help = document.createElement('span');
    help.className = 'lg-keys';
    help.textContent = keys.join(' · ');
    host.appendChild(help);
    for (const row of MAP_LEGEND) {
      const item = document.createElement('span');
      item.className = 'lg-row';
      item.dataset.kind = row.kind;
      const sym = document.createElement('i');
      sym.className = 'lg-sym lg-' + row.kind;
      item.appendChild(sym);
      // The caption gets its own element so an over-long label is ellipsised inside its
      // grid cell instead of painting across the next column (what the 1080p legend did).
      const cap = document.createElement('b');
      cap.className = 'lg-txt';
      cap.textContent = row.label;
      item.appendChild(cap);
      host.appendChild(item);
    }
  }

  // ---------------------------------------------------------------------
  // mission lifecycle
  // ---------------------------------------------------------------------
  reset() {
    const g = this.game;
    const b = (g.world && g.world.bounds) || { minX: -70, maxX: 70, minZ: -70, maxZ: 70 };
    const cell = 3, m = 9;
    const gw = Math.max(8, Math.ceil((b.maxX - b.minX + 2 * m) / cell));
    const gh = Math.max(8, Math.ceil((b.maxZ - b.minZ + 2 * m) / cell));
    this.fog = { cell, x0: b.minX - m, z0: b.minZ - m, gw, gh, data: new Uint8Array(gw * gh) };
    this._fogCv.width = gw; this._fogCv.height = gh;
    this.known.clear();
    this.knownNpc.clear();
    this.geom = null;
    this._route = null;
    this.zoom = 1;
    this.panX = 0; this.panY = 0;
    this.routeSel = 'primary';
    this.close(true);
  }

  get fogPct() {
    if (!this.fog) return 0;
    let n = 0;
    for (let i = 0; i < this.fog.data.length; i++) if (this.fog.data[i]) n++;
    return n / this.fog.data.length;
  }

  // ---------------------------------------------------------------------
  // open / close (partial pause: the sim freezes while the map is up)
  // ---------------------------------------------------------------------
  toggle() { this.open ? this.close() : this.openMap(); }

  openMap() {
    const g = this.game;
    if (g.state !== 'playing' || this.open) return;
    this.open = true;
    this.geom = ensureMapGeometry(g, null);
    this.panX = 0; this.panY = 0;
    this._panXT = 0; this._panYT = 0;
    this._pointers.clear();
    this._drag = null;
    if (this.el) this.el.classList.remove('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
    g.stats.mapOpens = (g.stats.mapOpens || 0) + 1;
    this.mode = '2d';               // deterministic: opens in 2D; VIEW toggles to 3D
    this._applyMode();
    this._animating = false;
    const sv = this._savedView;
    if (sv && this.geom && sv.key === this.geom.key) {
      // Same mission, same geometry: the map reopens exactly where the player left it.
      this.follow = sv.follow;
      this._setView(sv.zoom, sv.panX, sv.panY, { instant: true });
    } else {
      this.follow = false;
      this.fit();
    }
    this._syncControls();
    this.drawFull();
  }

  close(silent = false) {
    const g = this.game;
    if (this.mode === '3d' && this.map3d) this.map3d.exit();
    // Drop any gesture in flight so a drag that was still down when the map closed
    // cannot leak into gameplay input (and no capture is left held on the canvas).
    this._drag = null;
    this._pointers.clear();
    this._pinch = null;
    if (this.fullCv && this.fullCv.classList) this.fullCv.classList.remove('dragging');
    if (this.el && this.el.classList) this.el.classList.remove('chrome-active');
    this.open = false;
    this._savedView = {
      key: this.geom ? this.geom.key : null,
      zoom: this._zoomT, panX: this._panXT, panY: this._panYT, follow: this.follow,
    };
    if (this.el) this.el.classList.add('hidden');
    if (!silent && g.state === 'playing' && g._requestLock) g._requestLock();
  }

  // ---------------------------------------------------------------------
  // view: fit / zoom / pan / rotate
  // ---------------------------------------------------------------------
  // --------------------------------------------------------------------
  // view: fit / zoom / pan / rotate / follow  (v4.4 — target + rendered pair)
  // --------------------------------------------------------------------
  _viewMetrics() {
    const cv = this.fullCv;
    if (!cv) return { w: 560, h: 560 };
    const rect = cv.getBoundingClientRect ? cv.getBoundingClientRect() : null;
    const w = Math.round((rect && rect.width) || cv.clientWidth || cv.width || 560);
    const h = Math.round((rect && rect.height) || cv.clientHeight || cv.height || 560);
    return { w: Math.max(120, w), h: Math.max(120, h) };
  }

  /** The projection the view is *heading* for; anchor maths uses it so a zoom
   *  lands with the pointer on the same world point it started on. */
  _targetView(forcedScale) {
    const g = this.game, m = this._viewMetrics();
    const v = { w: m.w, h: m.h, cx: m.w / 2, cy: m.h / 2 };
    v.scale = forcedScale || PPM * this._zoomT;
    v.rot = this.rotateMode === 'player' ? g.player.yaw : 0;
    v.px = g.player.pos.x + this._panXT;
    v.pz = g.player.pos.z + this._panYT;
    return v;
  }

  /** Zoom that fits the whole mission area, given the current box. */
  fitZoom() {
    if (!this.geom) return 1;
    const m = this._viewMetrics();
    const span = Math.max(this.geom.width, this.geom.depth, 8);
    return THREE.MathUtils.clamp(Math.min(m.w, m.h) / (span * PPM), this.minZoom, this.maxZoom);
  }

  /** Set the view. `instant` skips the easing (open/fit/reset should land now). */
  _setView(zoom, panX, panY, opts = {}) {
    this._zoomT = THREE.MathUtils.clamp(zoom, this.minZoom, this.maxZoom);
    this._panXT = panX; this._panYT = panY;
    this._centreFree = !!opts.centre || this.follow === true;
    this._clampTarget();
    if (opts.instant) {
      this.zoom = this._zoomT; this.panX = this._panXT; this.panY = this._panYT;
      this._animating = false;
    } else {
      this._animating = true;
      this._animT = nowMs();
    }
    this._syncControls();
  }

  /** Ease the rendered view toward the target. Returns true if anything moved. */
  _animateView() {
    if (this.follow) { this._panXT = 0; this._panYT = 0; this._centreFree = true; this._clampTarget(); }
    const t = nowMs();
    const dt = Math.min(0.05, Math.max(0, (t - (this._animT || t)) / 1000)) || 1 / 60;
    this._animT = t;
    const k = 1 - Math.exp(-dt / 0.055);
    let moved = false;
    const lz = Math.log(this.zoom), ltz = Math.log(this._zoomT);
    if (Math.abs(ltz - lz) > 1e-4) { this.zoom = Math.exp(lz + (ltz - lz) * k); moved = true; }
    else if (this.zoom !== this._zoomT) { this.zoom = this._zoomT; moved = true; }
    for (const [keyCur, keyT] of [['panX', '_panXT'], ['panY', '_panYT']]) {
      const cur = this[keyCur], tgt = this[keyT];
      if (Math.abs(tgt - cur) > 0.02) { this[keyCur] = cur + (tgt - cur) * k; moved = true; }
      else if (cur !== tgt) { this[keyCur] = tgt; moved = true; }
    }
    this._animating = moved;
    return moved;
  }

  /** Frame the whole mission area (the map's initial view, and the RESET control). */
  fit() {
    const g = this.game;
    if (!this.fullCv || !this.geom) return;
    this.follow = false;
    this._setView(this.fitZoom(), this.geom.cx - g.player.pos.x, this.geom.cz - g.player.pos.z, { instant: true });
    this._syncControls();
    if (this.open) this.drawFull();
  }

  /** RECENTER semantics: player, active objective, selection, or the whole area. */
  recenter(what = 'player') {
    const g = this.game;
    if (!this.geom) return;
    if (what === 'fit') { this.fit(); return; }
    let x = g.player.pos.x, z = g.player.pos.z;
    if (what === 'objective') {
      const t = this._currentTarget(this.geom, (g.missions && g.missions.mapTargets) ? g.missions.mapTargets() : []);
      if (!t) { if (g.ui && g.ui.toastBrief) g.ui.toastBrief('NO MISSION TARGET TO CENTRE ON'); return; }
      x = t.pos.x; z = t.pos.z;
    } else if (what === 'marker') {
      if (!this.selected) return;
      x = this.selected.x; z = this.selected.z;
    }
    this.follow = what === 'player' ? this.follow : false;
    this._setView(Math.max(this._zoomT, this.fitZoom()), x - g.player.pos.x, z - g.player.pos.z, { centre: true });
    if (this.open) this.drawFull();
  }

  setFollow(on) {
    this.follow = !!on;
    if (this.follow) { this._panXT = 0; this._panYT = 0; }
    this._syncControls();
    if (this.open) this.drawFull();
  }

  setZoom(step) { this.zoomBy(step > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, null); }

  /**
   * Zoom about a canvas-space anchor (the pointer, or the pinch midpoint). With no
   * anchor it zooms about the view centre. The anchor is solved against the TARGET
   * view, so the easing lands with the same world point under the cursor.
   */
  zoomBy(factor, anchorCss) {
    const z = THREE.MathUtils.clamp(this._zoomT * factor, this.minZoom, this.maxZoom);
    if (Math.abs(z - this._zoomT) < 1e-4) return false;
    if (anchorCss) {
      const before = this._targetView();
      const w0 = this._screenToWorld(anchorCss.x, anchorCss.y, before);
      const after = this._targetView(PPM * z);
      const w1 = this._screenToWorld(anchorCss.x, anchorCss.y, after);
      this._setView(z, this._panXT + (w0.x - w1.x), this._panYT + (w0.z - w1.z));
    } else {
      this._setView(z, this._panXT, this._panYT);
    }
    if (this.open) this.drawFull();
    return true;
  }

  /** Pan by a screen-space pixel delta (converts through rotation + scale). */
  _panByPx(dxPx, dyPx) {
    const g = this.game;
    const v = this._view();
    const dx = (-dxPx * Math.cos(v.rot) - dyPx * Math.sin(v.rot)) / v.scale;
    const dy = (dxPx * Math.sin(v.rot) - dyPx * Math.cos(v.rot)) / v.scale;
    this._panXT += dx; this._panYT += dy;
    this._centreFree = this.follow === true;
    this._clampTarget();
    // Dragging tracks the finger 1:1: the rendered view takes the same step now
    // instead of chasing it, so the map never feels like it is lagging behind.
    this.panX = this._panXT; this.panY = this._panYT;
    if (this.follow && (Math.abs(dxPx) > 1 || Math.abs(dyPx) > 1)) this.follow = false;
    void g;
    return true;
  }

  /** The view used for screen<->world maths during interaction (rendered values). */
  _view() {
    const g = this.game, m = this._viewMetrics();
    return {
      w: m.w, h: m.h, cx: m.w / 2, cy: m.h / 2,
      scale: PPM * this.zoom,
      rot: this.rotateMode === 'player' ? g.player.yaw : 0,
      px: g.player.pos.x + this.panX,
      pz: g.player.pos.z + this.panY,
    };
  }

  /**
   * Viewport-aware bounds: the visible rectangle must always overlap the mission
   * area, so the map can be panned right to its edges (plus a little air) but never
   * lost off-screen. When the whole mission fits, the centre is locked to it instead.
   */
  _clampTarget() {
    if (!this.geom) return;
    const g = this.game, p = g.player.pos, b = this.geom.bounds;
    const m = this._viewMetrics();
    const scale = Math.max(0.02, PPM * this._zoomT);
    const rot = this.rotateMode === 'player' ? g.player.yaw : 0;
    const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
    // A gesture (drag, wheel, pinch) is bounded by the viewport: the mission must stay
    // on the screen. An explicit "put THIS point in the middle" (ME, OBJECTIVE, follow)
    // is bounded by the world instead - the centre may go anywhere inside the mission
    // area plus a little air, because the player asked for that point, not for a frame.
    const free = this._centreFree === true;
    const ex = free ? 0 : (m.w / 2 * c + m.h / 2 * s) / scale;
    const ez = free ? 0 : (m.w / 2 * s + m.h / 2 * c) / scale;
    const air = 18;
    this._panXT = this._axisLimit(p.x, this._panXT, ex, b.minX - air, b.maxX + air) - p.x;
    this._panYT = this._axisLimit(p.z, this._panYT, ez, b.minZ - air, b.maxZ + air) - p.z;
  }

  _axisLimit(playerPos, pan, half, lo, hi) {
    const centre = playerPos + pan;
    const minC = lo + half, maxC = hi - half;
    const clamped = minC <= maxC
      ? THREE.MathUtils.clamp(centre, minC, maxC)
      : (lo + hi) / 2;                       // viewport wider than the mission: centre it
    return clamped;
  }

  setRotate(mode) {
    this.rotateMode = mode === 'player' ? 'player' : 'north';
    this._centreFree = this.follow === true;
    this._clampTarget();
    this.panX = this._panXT; this.panY = this._panYT;
    this._syncControls();
    if (this.open) this.drawFull();
  }

  setRoute(sel) {
    this.routeSel = this.routeSel === sel ? null : sel;
    if (this.routeSel !== 'custom') this.customTarget = null;
    this._syncControls();
    if (this.open) this.drawFull();
  }

  /** ROUTE control: cycle the planned destination, with a way back to the mission one. */
  cycleRoute() {
    const order = ['primary', 'optional', 'extraction'];
    if (this.customTarget && this.routeSel !== 'custom') { this.routeSel = 'custom'; }
    else {
      const i = order.indexOf(this.routeSel);
      this.routeSel = i < 0 ? order[0] : (i >= order.length - 1 ? (this.customTarget ? 'custom' : null) : order[i + 1]);
    }
    this._syncControls();
    if (this.open) this.drawFull();
  }

  focusActiveObjective() {
    this.customTarget = null;
    this.routeSel = 'primary';
    this.selected = null;
    this.recenter('objective');
    this._syncControls();
    if (this.open) this.drawFull();
  }

  setLayer(key, on) {
    if (!(key in this.layers)) return false;
    this.layers[key] = !!on;
    this._syncControls();
    if (this.open) this.drawFull();
    return true;
  }

  toggleLayer(key) { return this.setLayer(key, !this.layers[key]); }

  toggleLayersPanel() {
    const doc = typeof document !== 'undefined' ? document : null;
    const panel = doc && doc.getElementById ? doc.getElementById('tacmap-layers') : null;
    this.layersOpen = !this.layersOpen;
    if (panel && panel.classList) panel.classList.toggle('hidden', !this.layersOpen);
    this._syncControls();
  }

  _layerOn(layer) { return this.layers[layer] !== false; }

  /** Toolbar, compass, layer checkboxes and inspector, all derived from state. */
  _syncControls() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !doc.getElementById) return;
    const set = (id, txt) => { const e = doc.getElementById(id); if (e && txt != null) e.textContent = txt; };
    const attr = (id, name, val) => { const e = doc.getElementById(id); if (e && e.setAttribute) e.setAttribute(name, val); };
    const cls = (id, name, on) => { const e = doc.getElementById(id); if (e && e.classList) e.classList.toggle(name, !!on); };
    set('tac-zoomval', this.zoom.toFixed(this.zoom < 1 ? 2 : 1) + '\u00d7');
    set('tac-rotbtn', this.rotateMode === 'player' ? 'ROT: PLAYER-UP' : 'ROT: NORTH-UP');
    set('tac-routebtn', 'ROUTE: ' + (this.routeSel ? (this.routeSel === 'custom' ? 'WAYPOINT' : this.routeSel.toUpperCase()) : 'OFF'));
    set('tac-3dbtn', this.mode === '3d' ? 'VIEW: 3D' : 'VIEW: 2D');
    set('tac-followbtn', 'FOLLOW: ' + (this.follow ? 'ON' : 'OFF'));
    set('tac-floatbtn', this.float.on ? 'MAXIMIZE' : 'FLOAT');
    set('tac-layersbtn', 'LAYERS: ' + this._layersOnCount() + '/' + MAP_LAYERS.length);
    attr('tac-followbtn', 'aria-pressed', this.follow ? 'true' : 'false');
    attr('tac-layersbtn', 'aria-expanded', this.layersOpen ? 'true' : 'false');
    cls('tacmap-layers', 'hidden', !this.layersOpen);
    if (this._layerEls) {
      for (const { key, el } of this._layerEls) {
        if (el && el.classList) el.classList.toggle('on', !!this.layers[key]);
        if (el && el.setAttribute) el.setAttribute('aria-pressed', this.layers[key] ? 'true' : 'false');
      }
    }
    const g = this.game;
    const bearing = g && g.player ? ((-g.player.yaw * 180 / Math.PI) % 360 + 360) % 360 : 0;
    set('tac-compass-deg', this.rotateMode === 'player' ? 'UP ' + Math.round(bearing) + ' DEG' : 'NORTH-UP');
    const needle = doc.getElementById('tac-compass-needle');
    if (needle && needle.style) needle.style.transform = 'rotate(' + Math.round(this.rotateMode === 'player' ? bearing : 0) + 'deg)';
    this._renderInspector();
  }

  _layersOnCount() {
    let n = 0;
    for (const L of MAP_LAYERS) if (this.layers[L.key]) n++;
    return n;
  }

  _buildLayerDom() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !doc.getElementById) return;
    const host = doc.getElementById('tacmap-layerlist');
    if (!host) return;
    host.innerHTML = '';
    this._layerEls = [];
    for (const L of MAP_LAYERS) {
      const row = doc.createElement('button');
      row.className = 'tac-layer';
      row.dataset.layer = L.key;
      row.title = L.hint;
      const box = doc.createElement('i');
      box.className = 'tl-box';
      row.appendChild(box);
      row.appendChild(doc.createTextNode(L.label));
      this._on(row, 'click', (e) => {
        if (e && e.preventDefault) e.preventDefault();
        this.toggleLayer(L.key);
        const g = this.game;
        if (g && g.ui && g.ui.toastBrief) g.ui.toastBrief('LAYER ' + L.label + ': ' + (this.layers[L.key] ? 'ON' : 'OFF'));
      });
      host.appendChild(row);
      this._layerEls.push({ key: L.key, el: row });
    }
  }

  _buildInspectorDom() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !doc.getElementById) return;
    const host = doc.getElementById('tacmap-inspector');
    if (!host) return;
    if (!this._insp) {
      const mk = (cls, tag) => { const e = doc.createElement(tag || 'div'); e.className = cls; host.appendChild(e); return e; };
      this._insp = {
        root: host,
        title: mk('ti-title'),
        type: mk('ti-type'),
        info: mk('ti-info'),
        where: mk('ti-where'),
        actions: mk('ti-actions'),
      };
      const btn = (id, label, title) => {
        const b = doc.createElement('button');
        b.className = 'tac-btn wide ti-btn'; b.id = id; b.textContent = label;
        if (title) b.title = title;
        this._insp.actions.appendChild(b);
        return b;
      };
      btn('tacmap-inspect-nav', 'NAVIGATE', 'Plan the walkable route to this marker');
      btn('tacmap-inspect-recenter', 'CENTRE', 'Centre the map on this marker');
      btn('tacmap-inspect-active', 'ACTIVE OBJ', 'Back to the active mission objective');
      btn('tacmap-inspect-clear', 'CLEAR', 'Deselect');
    }
    this._renderInspector();
  }

  /** Inspector content: name, type, what the player may know, and navigation. */
  _renderInspector() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!this._insp) return;
    const set = (el, txt) => { if (el) el.textContent = txt; };
    const s = this.selected;
    if (this._insp.root && this._insp.root.classList) this._insp.root.classList.toggle('hidden', !s);
    if (!s) return;
    set(this._insp.title, s.label || 'MARKER');
    set(this._insp.type, (s.kind || 'MARKER').toUpperCase().replace(/_/g, ' ') + (s.subtype ? ' \u00b7 ' + s.subtype.toUpperCase() : ''));
    const g = this.game;
    const dx = s.x - g.player.pos.x, dz = s.z - g.player.pos.z;
    const dist = Math.hypot(dx, dz);
    set(this._insp.info, s.info || '');
    set(this._insp.where, Math.round(dist) + ' m ' + compassTo(dx, dz)
      + (s.walk != null ? '  \u00b7  ROUTE ' + Math.round(s.walk) + ' m' : '')
      + (this.routeSel && this.selectedRoute === s.key ? '  \u00b7  PLANNED' : ''));
  }


  // ---------------------------------------------------------------------
  // per-frame knowledge + fog updates (runs while the sim is live)
  // ---------------------------------------------------------------------
  update(dt) {
    const g = this.game;
    if (!this.fog || g.state !== 'playing') return;
    const p = g.player.pos;
    this._reveal(p.x, p.z, 15);
    // Follow mode keeps the view target welded to the player; with it off the map
    // stays exactly where the player left it, which is the whole point of panning.
    if (this.follow && this.open) { this._panXT = 0; this._panYT = 0; this._clampTarget(); }
    this._detectT -= dt;
    if (this._detectT <= 0) {
      this._detectT = 0.25;
      this._scanView();
    }
    // prune stale contacts
    for (const [e, k] of this.known) if (g.time - k.t > 26 || !e.alive) this.known.delete(e);
    for (const [n, k] of this.knownNpc) if (g.time - k.t > 26) this.knownNpc.delete(n);
  }

  _reveal(x, z, r) {
    const f = this.fog, cr = Math.ceil(r / f.cell);
    const ci = Math.floor((x - f.x0) / f.cell), cj = Math.floor((z - f.z0) / f.cell);
    const r2 = r * r;
    for (let j = Math.max(0, cj - cr); j <= Math.min(f.gh - 1, cj + cr); j++) {
      for (let i = Math.max(0, ci - cr); i <= Math.min(f.gw - 1, ci + cr); i++) {
        const wx = f.x0 + (i + 0.5) * f.cell, wz = f.z0 + (j + 0.5) * f.cell;
        const dx = wx - x, dz = wz - z;
        if (dx * dx + dz * dz <= r2) {
          const k = j * f.gw + i;
          if (!f.data[k]) { f.data[k] = 1; this._fogVer = (this._fogVer || 0) + 1; }
        }
      }
    }
  }

  _cellAt(x, z) {
    const f = this.fog;
    if (!f) return 1;
    const i = Math.floor((x - f.x0) / f.cell), j = Math.floor((z - f.z0) / f.cell);
    if (i < 0 || j < 0 || i >= f.gw || j >= f.gh) return 1; // outside bounds counts as open
    return f.data[j * f.gw + i];
  }

  _scanView() {
    const g = this.game, p = g.player;
    const eye = this._v1.copy(g.camera.position);
    const yaw = p.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    // view-cone fog reveal: 9 rays, stepped until blocked
    for (let r = -4; r <= 4; r++) {
      const a = r * 14 * DEG;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = fx * ca - fz * sa, dz = fx * sa + fz * ca;
      for (let d = 8; d <= 52; d += 8) {
        const tx = eye.x + dx * d, tz = eye.z + dz * d;
        this._v2.set(tx, 1.0, tz);
        if (!g.physics.hasLOS(eye, this._v2) || (g.throwables && g.throwables.smokeBlocksLOS(eye, this._v2))) break;
        this._reveal(tx, tz, 5);
      }
    }
    // hostile knowledge: player sees them, or they are actively engaging the player
    const px = p.pos.x, pz = p.pos.z;
    for (const e of g.enemies.list) {
      if (!e.alive) { this.known.delete(e); continue; }
      const dx = e.pos.x - px, dz = e.pos.z - pz;
      const d2 = dx * dx + dz * dz;
      let sees = false;
      if (d2 < 75 * 75) {
        const dot = (dx * fx + dz * fz) / Math.sqrt(Math.max(d2, 0.01));
        const enemyHasVisualContact = !!(e.canSeePlayer && e.contactConfirmed);
        if (dot > 0.34 || enemyHasVisualContact) {
          e.eyePos(this._v2); this._v2.y -= 0.15;
          sees = (g.physics.hasLOS(eye, this._v2) && !(g.throwables && g.throwables.smokeBlocksLOS(eye, this._v2))) || (enemyHasVisualContact && d2 < 90 * 90);
        }
      }
      if (!sees && g.throwables && g.throwables.revealCovers(e.pos)) sees = true;  // flare / sensor coverage
      if (sees) this.known.set(e, { x: e.pos.x, z: e.pos.z, t: g.time });
    }
    // friendly knowledge: escorted contact is always known; others when close & visible
    if (g.enemies.npcs) {
      for (const n of g.enemies.npcs) {
        const dx = n.pos.x - px, dz = n.pos.z - pz;
        const d2 = dx * dx + dz * dz;
        const auto = n === g.enemies.escortNpc && n.contacted;
        if (auto || (d2 < 45 * 45 && g.physics.hasLOS(eye, this._v2.set(n.pos.x, n.pos.y + 1.2, n.pos.z)))) {
          this.knownNpc.set(n, { x: n.pos.x, z: n.pos.z, t: g.time });
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // projection: world ⇄ screen, in CSS pixels
  // ---------------------------------------------------------------------
  _prepareView(cv, forcedScale) {
    const g = this.game;
    const canvas = cv || this.fullCv;
    // The full-map canvas projects through _viewMetrics() - the same rounded CSS box the
    // clamps, fitZoom and the anchor maths use. Reading clientWidth instead floored it, so
    // at a fractional devicePixelRatio (1.5 on a tablet) the last device row and column
    // of the map were never painted: a 1 px transparent seam around the whole canvas.
    const m = !cv || canvas === this.fullCv ? this._viewMetrics() : null;
    const w = (m ? m.w : (canvas ? (canvas.clientWidth || canvas.width || 560) : 560));
    const h = (m ? m.h : (canvas ? (canvas.clientHeight || canvas.height || 560) : 560));
    return {
      w, h, cx: w / 2, cy: h / 2,
      scale: forcedScale || PPM * this.zoom,
      rot: this.rotateMode === 'player' ? g.player.yaw : 0,
      px: g.player.pos.x + this.panX,
      pz: g.player.pos.z + this.panY,
    };
  }

  _worldToScreen(x, z, v) {
    const c = Math.cos(v.rot), s = Math.sin(v.rot);
    const dx = x - v.px, dz = z - v.pz;
    return { x: v.cx + (dx * c - dz * s) * v.scale, y: v.cy + (dx * s + dz * c) * v.scale };
  }

  _screenToWorld(sx, sy, v) {
    v = v || this._prepareView();
    const c = Math.cos(v.rot), s = Math.sin(v.rot);
    const dx = (sx - v.cx) / v.scale, dy = (sy - v.cy) / v.scale;
    return { x: v.px + dx * c + dy * s, z: v.pz - dx * s + dy * c };
  }

  _visibleRect(v) {
    const corners = [
      this._screenToWorld(0, 0, v), this._screenToWorld(v.w, 0, v),
      this._screenToWorld(0, v.h, v), this._screenToWorld(v.w, v.h, v),
    ];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of corners) {
      if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
      if (c.z < minZ) minZ = c.z; if (c.z > maxZ) maxZ = c.z;
    }
    const m = 6;
    return { minX: minX - m, maxX: maxX + m, minZ: minZ - m, maxZ: maxZ + m };
  }

  // ---------------------------------------------------------------------
  // feature painting
  // ---------------------------------------------------------------------
  _rect(ctx, f, v, fill, stroke, lw) {
    const a = this._worldToScreen(f.x0, f.z0, v);
    const b = this._worldToScreen(f.x1, f.z1, v);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), d = Math.abs(b.y - a.y);
    this._drawCalls += 2;
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, d); }
    if (stroke) {
      ctx.strokeStyle = stroke; ctx.lineWidth = lw || 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0.5, w - 1), Math.max(0.5, d - 1));
    }
    return { x, y, w, d };
  }

  _drawField(ctx, v, geom) {
    const S = { x: 0, y: 0, w: v.w, h: v.h };
    // The wash is painted in *device* space, over the whole backing store. The projection
    // box is the rounded CSS box, and rect.height x dpr can round the other way (1002 x
    // 389.25 CSS at dpr 2 = a 2004x779 bitmap): filling 0,0,1002,389 left the last device
    // row never painted, a 1 px transparent seam along the bottom of the map.
    const bcv = ctx === this.fullCtx ? this.fullCv : null;
    const whole = bcv && bcv.width > 0 ? () => {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillRect(0, 0, bcv.width, bcv.height); ctx.restore();
      this._drawCalls++;
    } : () => { ctx.fillRect(S.x, S.y, S.w, S.h); this._drawCalls++; };
    ctx.fillStyle = MAP_STYLE.field;
    whole();
    if (!geom) return;
    // The mission area is a real rectangle from world.bounds; outside it the map
    // is deliberately emptier so "beyond the playable terrain" reads at a glance.
    const a = this._worldToScreen(geom.bounds.minX, geom.bounds.minZ, v);
    const b = this._worldToScreen(geom.bounds.maxX, geom.bounds.maxZ, v);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), d = Math.abs(b.y - a.y);
    ctx.fillStyle = MAP_STYLE.outside;
    whole();                                 // beyond the mission, to every device pixel
    ctx.fillStyle = MAP_STYLE.field;
    ctx.fillRect(x, y, w, d);
    ctx.strokeStyle = MAP_STYLE.bounds;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, d - 1);
    this._drawCalls += 3;
    // Paved lanes and open ground, straight from the mission's own surface records.
    // They are washes under everything else: a road never hides a building and never
    // blocks a route (walkability comes from the collider grid, not from here).
    for (const s of (geom.surfaces || [])) {
      if (!this._layerOn(SURFACE_LAYER[s.role] || 'terrain')) continue;
      const a = this._worldToScreen(s.x0, s.z0, v);
      const b = this._worldToScreen(s.x1, s.z1, v);
      const rx = Math.min(a.x, b.x), ry = Math.min(a.y, b.y);
      const rw = Math.abs(b.x - a.x), rh = Math.abs(b.y - a.y);
      if (rx > v.w || ry > v.h || rx + rw < 0 || ry + rh < 0) continue;
      if (rw < 0.6 && rh < 0.6) continue;
      ctx.fillStyle = s.role === 'road' ? MAP_STYLE.road : MAP_STYLE.open;
      ctx.fillRect(rx, ry, rw, rh);
      if (s.role === 'road' && Math.min(rw, rh) >= 3) {
        ctx.strokeStyle = MAP_STYLE.roadEdge;
        ctx.lineWidth = 1;
        ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
        this._drawCalls++;
      }
      this._drawCalls++;
    }
    if (v.scale > PPM * 0.16) this._reserveLabel(x + w / 2, y - 4, 'MISSION AREA', MAP_STYLE.dim, 3, true);
  }

  _drawMasses(ctx, geom, v, vis, detail) {
    if (!geom) return;
    const byRole = geom.byRole;
    const on = (layer) => this._layerOn(layer);
    // ground/level layers first, then the solid masses
    const flat = on('terrain') ? (byRole.ground || []) : [];
    for (const f of flat) {
      if (!this._inView(f, vis)) continue;
      this._rect(ctx, f, v, MAP_STYLE.ground, null);
    }
    for (const role of ['lowdeck', 'room', 'deck']) {
      if (!on(ROLE_LAYER[role] || 'terrain')) continue;
      for (const f of (byRole[role] || [])) {
        if (!this._inView(f, vis)) continue;
        this._rect(ctx, f, v, MAP_STYLE[role], MAP_STYLE.edgeSoft, 1);
      }
    }
    // authored patrol paths / pathways
    ctx.lineWidth = detail ? 2.4 : 1.6;
    ctx.strokeStyle = MAP_STYLE.path;
    for (const pts of (on('roads') ? (geom.paths || []) : [])) {
      let started = false;
      ctx.beginPath();
      this._drawCalls++;
      for (const p of pts) {
        if (p.x < vis.minX - 40 || p.x > vis.maxX + 40 || p.z < vis.minZ - 40 || p.z > vis.maxZ + 40) { started = false; continue; }
        const s = this._worldToScreen(p.x, p.z, v);
        if (!started) { ctx.moveTo(s.x, s.y); started = true; } else ctx.lineTo(s.x, s.y);
      }
      ctx.stroke();
    }
    for (const role of MASS_LAYERS[1]) {
      const layer = ROLE_LAYER[role] || 'buildings';
      if (!on(layer)) continue;
      if (role === 'vehicle' && !on('vehicles')) continue;
      for (const f of (byRole[role] || [])) {
        if (!this._inView(f, vis)) continue;
        this._paintMass(ctx, f, role, v, detail);
        if (detail && SELECTABLE_ROLES.has(role)) this._markMassHit(f, role, v);
      }
    }
    if (detail && this.showCover && on('walls')) {
      ctx.strokeStyle = MAP_STYLE.cover;
      ctx.lineWidth = 1;
      ctx.beginPath();
      this._drawCalls++;
      for (const c of (geom.cover || [])) {
        if (c.x < vis.minX || c.x > vis.maxX || c.z < vis.minZ || c.z > vis.maxZ) continue;
        const s = this._worldToScreen(c.x, c.z, v);
        ctx.moveTo(s.x - 2, s.y + 2); ctx.lineTo(s.x + 2, s.y - 2);
      }
      ctx.stroke();
    }
  }

  /** Height reads as brightness within a role: massing without gradients or glow. */
  _paintMass(ctx, f, role, v, detail) {
    let fill = MAP_STYLE.tint[f.tint] || MAP_STYLE.prop;
    let edge = MAP_STYLE.edge;
    let lw = 1;
    if (role === 'wall') { fill = MAP_STYLE.wall; edge = MAP_STYLE.wall; lw = 1; }
    else if (role === 'barrier') { fill = MAP_STYLE.barrier; edge = MAP_STYLE.edgeSoft; }
    else if (role === 'prop') { fill = MAP_STYLE.prop; edge = MAP_STYLE.propEdge; }
    else if (role === 'building') { fill = MAP_STYLE.tint[f.tint] || MAP_STYLE.structure; edge = MAP_STYLE.edge; lw = 1.2; }
    else if (role === 'landmark') { fill = MAP_STYLE.tint[f.tint] || MAP_STYLE.structure; edge = MAP_STYLE.obj; lw = 1.2; }
    else if (role === 'glass') { fill = MAP_STYLE.tint.glass; edge = MAP_STYLE.glassEdge; }
    else if (role === 'vehicle') { fill = MAP_STYLE.tint.metal; edge = MAP_STYLE.veh; }
    const r = this._rect(ctx, f, v, fill, edge, lw);
    if (!detail || role === 'wall' || role === 'barrier') return r;
    if ((role === 'building' || role === 'landmark') && r.w > 26 && r.h > 20 && f.h > 2) {
      // One interior line per storey band, so a three-storey block does not read
      // as a flat rectangle — derived from the collider's own height, not invented.
      const bands = Math.min(3, Math.max(1, Math.round(f.h / 3.2)));
      ctx.strokeStyle = MAP_STYLE.edgeSoft;
      ctx.lineWidth = 1;
      ctx.beginPath();
      this._drawCalls++;
      for (let i = 1; i < bands; i++) {
        const yy = Math.round(r.y + (r.h * i) / bands) + 0.5;
        ctx.moveTo(r.x + 2, yy); ctx.lineTo(r.x + r.w - 2, yy);
      }
      ctx.stroke();
      if (f.name && r.w > 60) this._reserveLabel(r.x + r.w / 2, r.y + r.h / 2, f.name.toUpperCase(), MAP_STYLE.dim, 4, true);
    }
    return r;
  }

  _inView(f, vis) {
    return f.x1 >= vis.minX && f.x0 <= vis.maxX && f.z1 >= vis.minZ && f.z0 <= vis.maxZ;
  }

  /** Fog drawn as hard-edged cells: readable "unknown", and it cannot blur anything. */
  _drawFog(ctx, v, full) {
    const f = this.fog;
    if (!f) return;
    const cellPx = f.cell * v.scale;
    if (cellPx < 1.1 && !full) return;
    ctx.imageSmoothingEnabled = false;
    const { minI, maxI, minJ, maxJ } = vis0(this, v, f);
    ctx.fillStyle = MAP_STYLE.fog;
    for (let j = Math.max(0, minJ); j <= Math.min(f.gh - 1, maxJ); j++) {
      let run = -1;
      for (let i = Math.max(0, minI); i <= Math.min(f.gw, maxI + 1); i++) {
        const unknown = i < f.gw && !f.data[j * f.gw + i];
        if (unknown && run < 0) run = i;
        if ((!unknown || i === f.gw) && run >= 0) {
          const a = this._worldToScreen(f.x0 + run * f.cell, f.z0 + j * f.cell, v);
          const end = Math.min(i, maxI + 1);
          const b = this._worldToScreen(f.x0 + end * f.cell, f.z0 + (j + 1) * f.cell, v);
          ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
          this._drawCalls++;
          run = -1;
        }
      }
    }
    if (v.scale > PPM * 0.2) {
      ctx.strokeStyle = MAP_STYLE.fogEdge;
      ctx.lineWidth = 1;
      ctx.beginPath();
      this._drawCalls++;
      for (let j = Math.max(0, minJ); j <= Math.min(f.gh - 1, maxJ); j++) {
        for (let i = Math.max(0, minI); i <= Math.min(f.gw - 1, maxI); i++) {
          if (f.data[j * f.gw + i]) continue;
          if (i + 1 < f.gw && f.data[j * f.gw + i + 1]) {
            const a = this._worldToScreen(f.x0 + (i + 1) * f.cell, f.z0 + j * f.cell, v);
            const b = this._worldToScreen(f.x0 + (i + 1) * f.cell, f.z0 + (j + 1) * f.cell, v);
            ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          }
          if (j + 1 < f.gh && f.data[(j + 1) * f.gw + i]) {
            const a = this._worldToScreen(f.x0 + i * f.cell, f.z0 + (j + 1) * f.cell, v);
            const b = this._worldToScreen(f.x0 + (i + 1) * f.cell, f.z0 + (j + 1) * f.cell, v);
            ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          }
        }
      }
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------------
  // labels: reserve boxes first, paint last, so nothing overlaps
  // ---------------------------------------------------------------------
  _reserveLabel(x, y, text, color, priority, allowCentre) {
    if (!text) return null;
    this._labels.push({ x, y, text, color, priority: priority || 5, allowCentre: !!allowCentre });
    return this._labels[this._labels.length - 1];
  }

  _paintLabels(ctx, v) {
    const boxes = this._labelBoxes.slice();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = MAP_STYLE.fontBold;
    const pad = 2.5;
    const order = this._labels.slice().sort((a, b) => a.priority - b.priority);
    for (const L of order) {
      const w = Math.max(18, ctx.measureText(L.text).width + pad * 2);
      const h = 12;
      const cands = [
        [0, -h - 3], [0, h + 3], [w / 2 + 5, 0], [-w / 2 - 5, 0],
        [0, -2 * h - 6], [0, 2 * h + 6], [w / 2 + 5, -h - 3], [-w / 2 - 5, h + 3],
      ];
      let placed = null;
      for (const [ox, oy] of cands) {
        const box = { x: L.x + ox - w / 2, y: L.y + oy - h / 2, w, h };
        if (box.x < 1 || box.y < 1 || box.x + box.w > v.w - 1 || box.y + box.h > v.h - 1) continue;
        if (!boxes.some((b) => overlap(b, box))) { placed = box; break; }
      }
      if (!placed) {
        // Cosmetic names are dropped rather than allowed to sit on top of the map;
        // a critical one (player, primary objective, extraction, no-route) goes into
        // its least-crowded slot instead, so a name can never simply go missing.
        if (L.priority > 2) continue;
        let best = null, bestArea = Infinity;
        for (const [ox, oy] of cands.concat([[0, 0]])) {
          const box = { x: L.x + ox - w / 2, y: L.y + oy - h / 2, w, h };
          let area = 0;
          for (const other of boxes) {
            const ix = Math.max(0, Math.min(box.x + box.w, other.x + other.w) - Math.max(box.x, other.x));
            const iy = Math.max(0, Math.min(box.y + box.h, other.y + other.h) - Math.max(box.y, other.y));
            area += ix * iy;
          }
          if (area < bestArea) { bestArea = area; best = box; }
        }
        placed = best || { x: L.x - w / 2, y: L.y - h / 2, w, h };
      }
      boxes.push(placed);
      ctx.fillStyle = MAP_STYLE.plate;
      ctx.fillRect(placed.x, placed.y, placed.w, placed.h);
      ctx.fillStyle = L.color || MAP_STYLE.text;
      ctx.fillText(L.text, placed.x + placed.w / 2, placed.y + placed.h / 2 + 0.5);
      this._drawCalls += 2;
    }
    this._labelBoxes = boxes;
  }

  /** Screen box of a symbol, so labels are steered around the thing they name. */
  _reserveBox(x, y, r) { this._labelBoxes.push({ x: x - r, y: y - r, w: r * 2, h: r * 2 }); }

  // ---------------------------------------------------------------------
  // markers
  // ---------------------------------------------------------------------
  _drawMarkers(ctx, v, geom, detail) {
    const g = this.game, t = g.time;
    const targets = g.missions && g.missions.mapTargets ? g.missions.mapTargets() : [];
    ctx.lineWidth = 1;

    const on = (layer) => this._layerOn(layer);
    // interaction points the mission actually exposes, filtered by what the
    // player is allowed to know (revealed fog), never by a hidden-geometry peek
    if (geom) {
      for (const it of geom.interactables) {
        if (it.used || !MAP_ITEM_KINDS.has(it.kind)) continue;
        if (!on(ITEM_LAYER[it.kind] || 'objectives')) continue;
        if (!this._cellAt(it.x, it.z)) continue;
        const s = this._worldToScreen(it.x, it.z, v);
        if (s.x < -10 || s.y < -10 || s.x > v.w + 10 || s.y > v.h + 10) continue;
        this._itemGlyph(ctx, s.x, s.y, it.kind, detail ? 5.2 : 3.6);
        if (detail) {
          this._markHit(s.x, s.y, 6, {
            key: 'item:' + (it.id || it.kind), kind: it.kind, subtype: 'INTERACTION POINT',
            label: it.label || String(it.id || it.kind).toUpperCase(),
            x: it.x, z: it.z, routeSel: null,
            info: 'MISSION INTERACTION POINT - ' + (it.id ? '[' + String(it.id).toUpperCase() + '] ' : '') + (it.used ? 'USED' : 'NOT YET USED'),
          });
        }
        this._reserveBox(s.x, s.y, 8);
        if (detail && it.kind !== 'supply' && it.kind !== 'ammo') {
          this._reserveLabel(s.x, s.y - 9, shortLabel(it.label, it.kind), MAP_STYLE.supply, 6);
        }
      }
      for (const d of (on('walls') ? geom.doors : [])) {
        const s = this._worldToScreen(d.x, d.z, v);
        if (s.x < 0 || s.y < 0 || s.x > v.w || s.y > v.h) continue;
        ctx.strokeStyle = MAP_STYLE.door;
        ctx.lineWidth = d.open ? 1 : 1.6;
        ctx.beginPath();
        this._drawCalls++;
        ctx.rect(s.x - 2.6, s.y - 2.6, 5.2, 5.2);
        ctx.stroke();
        if (!d.open) { ctx.fillStyle = MAP_STYLE.door; ctx.fill(); this._drawCalls++; }
        if (detail) this._markHit(s.x, s.y, 6, {
          key: 'door:' + d.x.toFixed(1) + ',' + d.z.toFixed(1), kind: 'door',
          subtype: d.open ? 'OPEN' : 'CLOSED', label: (d.name || 'DOOR'),
          x: d.x, z: d.z, nav: true,
          info: (d.open ? 'OPEN - YOU CAN WALK THROUGH IT' : 'CLOSED - IT OPENS WHEN YOU TOUCH IT')
            + '  GRID ' + Math.round(d.x) + ', ' + Math.round(d.z),
        });
      }
      for (const veh of (on('vehicles') ? geom.vehicles : [])) {
        if (veh.taken) continue;
        if (!this._cellAt(veh.x, veh.z)) continue;
        const sv = this._worldToScreen(veh.x, veh.z, v);
        this._vehicleGlyph(ctx, sv, v, MAP_STYLE.veh, 5);
        if (detail) this._markHit(sv.x, sv.y, 7, {
          key: 'vehpad:' + Math.round(veh.x) + ',' + Math.round(veh.z), kind: 'vehicle',
          subtype: 'VEHICLE SPAWN', label: veh.name || 'VEHICLE', x: veh.x, z: veh.z,
          info: 'AUTHORED VEHICLE SPAWN - ' + (veh.taken ? 'ALREADY TAKEN' : 'STILL THERE'),
        });
      }
    }
    if (g.vehicles && g.vehicles.list && on('vehicles')) {
      for (const [i, veh] of g.vehicles.list.entries()) {
        const active = veh === g.vehicleMode;
        if (!active && !this._cellAt(veh.pos.x, veh.pos.z)) continue;
        const svp = this._worldToScreen(veh.pos.x, veh.pos.z, v);
        this._vehicleGlyph(ctx, svp, v,
          active ? MAP_STYLE.you : (veh.mission ? MAP_STYLE.opt : MAP_STYLE.veh), active ? 6 : 5);
        if (detail) this._markHit(svp.x, svp.y, 7, {
          key: 'veh:' + i, kind: 'vehicle', subtype: active ? 'YOU ARE DRIVING' : 'LIVE VEHICLE',
          label: (veh.def && veh.def.name) || 'VEHICLE', x: veh.pos.x, z: veh.pos.z,
          info: (veh.mission ? 'MISSION VEHICLE' : 'FIELD VEHICLE') + (active ? ' - BOARDING NOT REQUIRED' : ''),
        });
      }
    }

    // friendly knowledge
    for (const [n, k] of (on('friendlies') ? this.knownNpc : [])) {
      const live = t - k.t < 3;
      const x = live ? n.pos.x : k.x, z = live ? n.pos.z : k.z;
      const s = this._worldToScreen(x, z, v);
      ctx.globalAlpha = live ? 1 : 0.55;
      ctx.fillStyle = MAP_STYLE.friend;
      ctx.beginPath(); ctx.arc(s.x, s.y, live ? 3.4 : 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = MAP_STYLE.youEdge; ctx.lineWidth = 1; ctx.stroke();
      this._drawCalls += 2;
      ctx.globalAlpha = 1;
      if (detail) this._markHit(s.x, s.y, 6, {
        key: 'friend:' + ((n && n.id) || k.x.toFixed(1) + ',' + k.z.toFixed(1)), kind: 'friend',
        subtype: live ? 'IN CONTACT NOW' : 'LAST REPORT', label: (n && n.name) || 'FRIENDLY CONTACT',
        x, z, info: 'SQUAD MEMBER REPORTED BY THE MISSION - ' + Math.round(g.time - k.t) + 's OLD',
      });
    }
    // hostile knowledge: live while seen, last-known ring as it ages out
    for (const [e, k] of (on('enemies') ? this.known : [])) {
      const age = t - k.t;
      const live = age < 2.5;
      const x = live ? e.pos.x : k.x, z = live ? e.pos.z : k.z;
      const s = this._worldToScreen(x, z, v);
      const a = live ? 1 : Math.max(0.25, 1 - age / 26);
      ctx.globalAlpha = a;
      ctx.fillStyle = live ? MAP_STYLE.foe : MAP_STYLE.foeOld;
      const r = live ? 4 : 3;
      ctx.beginPath();                                     // triangle, not a fuzzy dot
      this._drawCalls++;
      ctx.moveTo(s.x, s.y - r); ctx.lineTo(s.x + r, s.y + r * 0.8); ctx.lineTo(s.x - r, s.y + r * 0.8);
      ctx.closePath(); ctx.fill();
      if (!live) {
        ctx.globalAlpha = a * 0.8;
        ctx.strokeStyle = MAP_STYLE.foeOld; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(s.x, s.y, r + 2.4, 0, Math.PI * 2); ctx.stroke();
        this._drawCalls++;
      }
      ctx.globalAlpha = 1;
      if (detail) this._markHit(s.x, s.y, 6, {
        key: 'foe:' + ((e && e.id != null) ? e.id : k.x.toFixed(1) + ',' + k.z.toFixed(1)), kind: 'enemy',
        subtype: live ? 'SEEN NOW' : 'LAST KNOWN', label: 'HOSTILE CONTACT', x, z,
        info: (live ? 'VISIBLE TO YOU NOW' : 'WHERE YOU LAST SAW THEM, ' + Math.round(age) + 's AGO')
          + ' - the map never shows what you have not spotted',
      });
    }

    // mission targets — briefing knowledge, always drawn
    // `i` keys the selection to one specific marker: a mission can carry two secondary
    // objectives, and both would otherwise open the same card.
    for (const [i, m] of (on('objectives') ? targets : []).entries()) {
      const s = this._worldToScreen(m.pos.x, m.pos.z, v);
      if (m.kind === 'extraction') {
        ctx.strokeStyle = MAP_STYLE.ext; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(s.x, s.y, 8, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(s.x, s.y, 4.2, 0, Math.PI * 2); ctx.stroke();
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(s.x - 3, s.y + 2); ctx.lineTo(s.x, s.y - 2.5); ctx.lineTo(s.x + 3, s.y + 2);
        ctx.stroke();
        this._drawCalls += 3;
        this._reserveBox(s.x, s.y, 10);
        if (detail) {
          this._markHit(s.x, s.y, 10, {
            key: 'extraction', kind: 'extraction', subtype: 'MISSION TARGET', label: m.label || 'EXTRACTION LZ',
            x: m.pos.x, z: m.pos.z, routeSel: 'extraction',
            info: 'EXFILTRATION POINT - reach it and hold to complete the operation',
          });
          this._reserveLabel(s.x, s.y - 11, 'EXTRACTION', MAP_STYLE.ext, 2);
        }
      } else if (m.kind === 'objective') {
        ctx.fillStyle = MAP_STYLE.obj;
        ctx.strokeStyle = MAP_STYLE.youEdge; ctx.lineWidth = 1.2;
        diamond(ctx, s.x, s.y, 6.4); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = MAP_STYLE.obj; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(s.x, s.y, 10, 0, Math.PI * 2); ctx.stroke();
        this._drawCalls += 3;
        this._reserveBox(s.x, s.y, 12);
        if (detail) {
          this._markHit(s.x, s.y, 11, {
            key: 'objective', kind: 'objective', subtype: 'ACTIVE OBJECTIVE', label: m.label || 'PRIMARY OBJECTIVE',
            x: m.pos.x, z: m.pos.z, routeSel: 'primary',
            info: 'CURRENT MISSION STEP - the route line follows this until you change it',
          });
          this._reserveLabel(s.x, s.y - 13, shortLabel(m.label, 'objective').toUpperCase(), MAP_STYLE.objText, 1);
        }
      } else {
        ctx.strokeStyle = MAP_STYLE.opt; ctx.lineWidth = 1.4;
        diamond(ctx, s.x, s.y, 5); ctx.stroke();
        this._drawCalls++;
        this._reserveBox(s.x, s.y, 7);
        if (detail) this._markHit(s.x, s.y, 8, {
          key: 'optional:' + i, kind: 'optional', subtype: 'SECONDARY TARGET', label: m.label || 'OPTIONAL OBJECTIVE',
          x: m.pos.x, z: m.pos.z, routeSel: 'optional',
          info: 'OPTIONAL - completing it changes the rating, not the objective chain',
        });
        if (detail) this._reserveLabel(s.x, s.y - 9, shortLabel(m.label, 'optional').toUpperCase(), MAP_STYLE.opt, 5);
      }
    }
    return targets;
  }

  _itemGlyph(ctx, x, y, kind, r) {
    const color = kind === 'intel' ? MAP_STYLE.intel
      : (kind === 'supply' || kind === 'ammo') ? MAP_STYLE.supply
        : kind === 'charge' ? MAP_STYLE.foe : MAP_STYLE.supply;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.4;
    ctx.beginPath();
    this._drawCalls++;
    if (kind === 'charge') {                                   // X
      ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
      ctx.stroke();
      return;
    }
    if (kind === 'power' || kind === 'terminal' || kind === 'contact' || kind === 'cache') {
      ctx.rect(x - r, y - r, r * 2, r * 2);
      if (kind === 'terminal') ctx.fill(); else ctx.stroke();
    } else if (kind === 'observe') {
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
      ctx.stroke();
    } else {
      ctx.arc(x, y, r * 0.85, 0, Math.PI * 2);
      if (kind === 'ammo' || kind === 'supply') ctx.fill(); else ctx.stroke();
    }
    ctx.font = MAP_STYLE.fontTiny;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = kind === 'terminal' ? MAP_STYLE.youEdge : color;
    const ch = { power: 'P', terminal: 'T', contact: 'C', cache: '$', intel: 'I', observe: 'O', charge: 'X', supply: 'S', ammo: 'A', weapon: 'W', objective: '◆' }[kind] || '?';
    if (kind !== 'supply' && kind !== 'ammo') { ctx.fillText(ch, x, y + 0.5); this._drawCalls++; }
  }

  _vehicleGlyph(ctx, s, v, color, r) {
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = color;
    ctx.strokeStyle = MAP_STYLE.youEdge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    this._drawCalls++;
    ctx.rect(-r, -r * 0.62, r * 2, r * 1.24);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  _drawPlayer(ctx, v, g) {
    this._playerScreen = null;
    // The player chevron is selectable too: the inspector's "YOU" card is what the
    // recenter and coordinate readouts hang off, and tapping yourself must not be a
    // way to accidentally re-frame the whole map.
    if (this._paintingFull) {
      const s0 = this._worldToScreen(g.player.pos.x, g.player.pos.z, v);
      this._markHit(s0.x, s0.y, 11, {
        key: 'you', kind: 'player', subtype: 'YOU', label: 'YOUR POSITION',
        x: g.player.pos.x, z: g.player.pos.z, nav: false,
        info: 'GRID ' + Math.round(g.player.pos.x) + ', ' + Math.round(g.player.pos.z)
          + '\nHEADING ' + Math.round(((-g.player.yaw * 180 / Math.PI) % 360 + 360) % 360) + '\u00b0'
          + (this.follow ? '\nFOLLOW MODE ON - the view tracks you' : '\nFOLLOW MODE OFF - the view stays put'),
      });
    }
    const p = g.player;
    const s = this._worldToScreen(p.pos.x, p.pos.z, v);
    const yaw = p.yaw;
    // View wedge first, so the icon always sits on top of it.
    const r = MAP_STYLE.fovRadius * v.scale;
    const half = MAP_STYLE.fovHalfDeg * DEG;
    // The game's forward vector is (-sin yaw, -cos yaw) in (x, z); in a north-up map
    // world +x is right and +z is down, so the wedge must open along atan2(-cos, -sin).
    const screenAng = Math.atan2(-Math.cos(yaw), -Math.sin(yaw));
    ctx.fillStyle = MAP_STYLE.fov;
    ctx.strokeStyle = MAP_STYLE.fovEdge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    this._drawCalls += 2;
    ctx.moveTo(s.x, s.y);
    ctx.arc(s.x, s.y, r, screenAng - half, screenAng + half);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // Chevron: constant screen size, points where the player points.
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(this.rotateMode === 'player' ? 0 : yaw);
    ctx.fillStyle = MAP_STYLE.you;
    ctx.strokeStyle = MAP_STYLE.youEdge;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    this._drawCalls += 2;
    ctx.moveTo(0, -8); ctx.lineTo(5.6, 6); ctx.lineTo(0, 3.2); ctx.lineTo(-5.6, 6);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    this._reserveBox(s.x, s.y, 11);
    this._reserveLabel(s.x, s.y + 12, 'YOU', MAP_STYLE.you, 0, true);
  }

  // ---------------------------------------------------------------------
  // route: found on the walkability grid, so it can't cross a wall
  // ---------------------------------------------------------------------
  _currentTarget(geom, targets) {
    if (!this.routeSel) return null;
    if (this.routeSel === 'custom') {
      return this.customTarget
        ? { kind: 'custom', pos: this.customTarget, label: this.customTarget.label || 'MARKED WAYPOINT' }
        : null;
    }
    if (this.routeSel === 'extraction') return targets.find((t) => t.kind === 'extraction') || null;
    if (this.routeSel === 'optional') return targets.find((t) => t.kind === 'optional') || null;
    return targets.find((t) => t.kind === 'objective') || null;
  }

  _ensureRoute(geom, target) {
    const g = this.game;
    if (!geom) return null;
    if (!target) { this._route = null; return null; }
    const from = g.player.pos;
    const key = geom.key + '|' + Math.round(from.x / 3) + ',' + Math.round(from.z / 3) + '|' +
      Math.round(target.pos.x) + ',' + Math.round(target.pos.z) + '|' + target.kind + '|' + (this.routeSel || '');
    if (this._route && this._route.key === key) return this._route;
    const nav = buildNavGrid(geom);
    let found = nav ? routeTo(geom, { x: from.x, z: from.z }, { x: target.pos.x, z: target.pos.z }) : null;
    let viaDoors = false;
    if (!found) {
      // Objectives often sit inside a building whose only opening is a door that is
      // still shut. Plan through closed doors rather than claiming there is no way
      // in — and label the route so it reads as a plan, not as an open gate.
      const alt = routeTo(geom, { x: from.x, z: from.z }, { x: target.pos.x, z: target.pos.z }, { throughDoors: true });
      if (alt) { found = alt; viaDoors = true; }
    }
    const direct = Math.hypot(target.pos.x - from.x, target.pos.z - from.z);
    this._route = {
      key, pts: found ? found.pts : null, target, found, viaDoors,
      meters: found ? found.meters : direct,
      endGap: found ? found.endGap : direct,
      endSnapped: found ? found.endSnapped : true,
      direct,
    };
    return this._route;
  }

  _drawRoute(ctx, v, route, detail) {
    this._noRoute = null;
    if (!route) return;
    // Hiding the ROUTE layer must not break the state readout, so the "no route"
    // verdict is still computed - only the line is suppressed.
    const paint = this._layerOn('route');
    // The walking distance belongs to the selection, not to the line: it is recorded
    // whether or not the ROUTE layer is currently painted.
    if (detail) this._selectedWalk(route.pts, route);
    if (!route.pts) {
      // Explicit "no route" state, drawn at the player and the target rather than
      // as a line that would imply a way through.
      const g = this.game;
      const s = this._worldToScreen(g.player.pos.x, g.player.pos.z, v);
      ctx.strokeStyle = MAP_STYLE.foe;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      this._drawCalls++;
      ctx.moveTo(s.x - 7, s.y - 7); ctx.lineTo(s.x + 7, s.y + 7);
      ctx.moveTo(s.x + 7, s.y - 7); ctx.lineTo(s.x - 7, s.y + 7);
      ctx.stroke();
      this._noRoute = 'NO WALKABLE ROUTE TO ' + String(route.target && route.target.label || 'SELECTION').toUpperCase();
      if (detail) this._reserveLabel(s.x, s.y + 24, this._noRoute, MAP_STYLE.foe, -1);
      return;
    }
    const pts = route.pts.map((p) => this._worldToScreen(p.x, p.z, v));
    if (!paint) return;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = MAP_STYLE.routeCasing;
    ctx.lineWidth = 4.2;
    tracePath(ctx, pts);
    ctx.strokeStyle = MAP_STYLE.route;
    ctx.lineWidth = 1.8;
    tracePath(ctx, pts);
    ctx.fillStyle = MAP_STYLE.route;
    ctx.beginPath();
    this._drawCalls += 3;
    for (let i = 1; i < pts.length - 1; i++) { ctx.moveTo(pts[i].x + 1.8, pts[i].y); ctx.arc(pts[i].x, pts[i].y, 1.8, 0, Math.PI * 2); }
    ctx.fill();
    if (route.endSnapped && route.endGap > 0.8) {
      // The route stops at the last walkable cell; the short hop to the marker is
      // drawn as a separate dotted spur so nobody reads it as a promised path.
      const g2 = this.game;
      const a2s = pts[pts.length - 1];
      const b2s = this._worldToScreen(route.found ? route.target.pos.x : 0, route.target.pos.z, v);
      ctx.save();
      ctx.strokeStyle = MAP_STYLE.route;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([2, 3]);
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      this._drawCalls++;
      ctx.moveTo(a2s.x, a2s.y); ctx.lineTo(b2s.x, b2s.y);
      ctx.stroke();
      ctx.restore();
      // priority 2: this is a caveat about the route, so crowding must not swallow it
      if (detail) this._reserveLabel((a2s.x + b2s.x) / 2, (a2s.y + b2s.y) / 2 - 12, 'LAST ' + Math.round(route.endGap) + ' m ON FOOT', MAP_STYLE.route, 2);
    }
    if (detail) {
      // Distance label at ~30 % of the way along the *route*, offset off the line.
      const idx = Math.max(1, Math.floor((pts.length - 1) * 0.3));
      const a = pts[idx - 1], b = pts[idx];
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const ox = -Math.sin(ang) * 13, oy = Math.cos(ang) * 13;
      this._reserveLabel((a.x + b.x) / 2 + ox, (a.y + b.y) / 2 + oy,
        'ROUTE ' + Math.round(route.meters) + ' m · ' + Math.max(0, pts.length - 2) + ' TURNS'
        + (route.viaDoors ? ' · THROUGH DOOR' : ''), MAP_STYLE.route, 3);
    }
  }

  /** Distance bookkeeping for the inspector, kept even when the line is hidden. */
  _selectedWalk(pts, route) {
    if (this.selected && this.selectedRoute === this.selected.key) this.selected.walk = route.meters;
    void pts;
  }

  // ---------------------------------------------------------------------
  // full map
  // ---------------------------------------------------------------------
  // touch gestures: 1 finger = tap marker (or drag-pan), 2 fingers = pan,
  // pinch = continuous zoom. Handlers live on the map canvas only, so they
  // never interfere with gameplay touch controls underneath.
  /**
   * Pointer input for the map viewport (v4.4). Everything is Pointer Events, so
   * mouse, pen and touch share one code path: single-pointer drag pans, two-pointer
   * drag pans and pinches with the pinch midpoint as the zoom anchor, and a tap that
   * never moved selects the marker under it. The whole gesture set is bound to the
   * canvas, never to the document, so it cannot reach gameplay input.
   */
  _bindMapInput(cv) {
    if (this._mapBound) { this._mapRebinds++; return; }      // idempotent by design
    this._mapBound = true;
    const cssPt = (e) => {
      const rect = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { left: 0, top: 0 };
      return { x: (e.clientX || 0) - rect.left, y: (e.clientY || 0) - rect.top };
    };
    const live = () => this.open && this.mode !== '3d';

    this._on(cv, 'pointerdown', (e) => {
      if (!live()) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;      // right/middle: the 3D view owns those
      if (e.preventDefault) e.preventDefault();                    // no text selection, no native drag
      const pt = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, id: e.pointerId, moved: false };
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!this._drag) this._drag = pt;
      this._pinch = this._pointers.size >= 2 ? this._pinchState() : null;
      if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (err) { /* capture is best-effort */ } }
      if (cv.classList) cv.classList.add('dragging');
      // A grab is an explicit takeover of the view: follow mode yields to it.
      if (this.follow) { this.follow = false; this._syncControls(); }
    });

    this._on(cv, 'pointermove', (e) => {
      if (!live()) return;
      if (!this._pointers.has(e.pointerId)) {
        if (this._hoverPan) this._hoverPan(e);                      // reserved for drag-while-held on touch pads
        return;
      }
      const prev = this._pointers.get(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const drag = this._drag;
      if (this._pointers.size >= 2) {
        const st = this._pinchState();
        if (this._pinch && st) {
          if (this._pinch.dist > 4 && st.dist > 4) this.zoomBy(st.dist / this._pinch.dist, cssPt({ clientX: st.mid.x - (cv.getBoundingClientRect().left || 0), clientY: st.mid.y - (cv.getBoundingClientRect().top || 0) }));
          this._panByPx(st.mid.x - this._pinch.mid.x, st.mid.y - this._pinch.mid.y);
        }
        this._pinch = st;
        if (drag) { drag.moved = true; drag.x = e.clientX; drag.y = e.clientY; }
        this.drawFull();
        return;
      }
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 5) drag.moved = true;
      if (drag.moved && (dx || dy)) { this._panByPx(dx, dy); this.drawFull(); }
      drag.x = e.clientX; drag.y = e.clientY;
    });

    const release = (e) => {
      if (!this._pointers.has(e.pointerId) && !this._drag) return;
      const drag = this._drag;
      const last = this._pointers.size <= 1;
      this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._pinch = null;
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved && last && live()) {
        const p = cssPt(e);
        this.selectAt(p.x, p.y);
      }
      this._drag = null;
      if (cv.releasePointerCapture) { try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      if (cv.classList) cv.classList.remove('dragging');
      if (this.open) this.drawFull();
    };
    this._on(cv, 'pointerup', release);
    this._on(cv, 'pointercancel', release);
    this._on(cv, 'lostpointercapture', (e) => { if (this._drag && e.pointerId === this._drag.id) { this._drag = null; if (cv.classList) cv.classList.remove('dragging'); } });

    // Wheel + trackpad pinch (browsers report a trackpad pinch as ctrl+wheel).
    this._on(cv, 'wheel', (e) => {
      if (!live()) return;
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      const dy = (e.deltaY || 0) * unit;
      if (!dy) return;
      const gain = e.ctrlKey ? 0.014 : 0.0026;
      const factor = THREE.MathUtils.clamp(Math.exp(-dy * gain), 0.5, 2.2);
      this.zoomBy(factor, cssPt(e));
    }, { passive: false });

    // Nothing in the browser's default drag machinery may run over the map.
    for (const t of ['dragstart', 'drag', 'selectstart', 'contextmenu']) {
      this._on(cv, t, (e) => { if (!live()) return; if (e.preventDefault) e.preventDefault(); });
    }
    this._bindMapKeys();
  }

  /** Two-pointer geometry: distance + midpoint, in viewport CSS pixels. */
  _pinchState() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) return null;
    const a = pts[0], b = pts[1];
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }

  /**
   * Keyboard, only while the map is up. Bound in the capture phase and stopped
   * there, so these keys never reach the gameplay bindings: no walk, no fire,
   * no reload, no weapon switch behind the map.
   */
  _bindMapKeys() {
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || !doc.addEventListener) return;
    const step = (e, mult) => {
      const k = (e.shiftKey ? PAN_KEY_FAST_PX : PAN_KEY_PX) * mult;
      return k;
    };
    this._on(doc, 'keydown', (e) => {
      if (!this.open || this.mode === '3d' || e.ctrlKey || e.metaKey || e.altKey) return;
      let handled = true;
      switch (e.code) {
        case 'Equal': case 'NumpadAdd': case 'PageUp': this.zoomBy(ZOOM_STEP, null); break;
        case 'Minus': case 'NumpadSubtract': case 'PageDown': this.zoomBy(1 / ZOOM_STEP, null); break;
        case 'Digit0': case 'Numpad0': this.fit(); break;
        case 'KeyC': this.recenter('player'); break;
        case 'KeyG': this.recenter('objective'); break;
        case 'KeyF': this.setFollow(!this.follow); break;
        case 'KeyN': this.setRotate('north'); break;
        case 'KeyU': this.setRotate('player'); break;
        case 'KeyL': this.toggleLayersPanel(); break;
        case 'ArrowLeft': this._panByPx(-step(e, 1), 0); break;
        case 'ArrowRight': this._panByPx(step(e, 1), 0); break;
        case 'ArrowUp': this._panByPx(0, -step(e, 1)); break;
        case 'ArrowDown': this._panByPx(0, step(e, 1)); break;
        case 'Enter': case 'Space': if (this.selected) this.navigateToSelection(); else this.focusActiveObjective(); break;
        default: handled = false;
      }
      if (!handled) return;
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      if (this.open) this.drawFull();
    }, true);
    this._on(doc, 'keyup', (e) => {
      if (!this.open || this.mode === '3d') return;
      if (/^(Arrow(Left|Right|Up|Down)|Equal|Minus|Digit0|Key[CFGNUL]|PageUp|PageDown|Enter|Space)$/.test(e.code)) {
        if (e.stopPropagation) e.stopPropagation();
      }
    }, true);
  }

  /**
   * Tap/click selection (v4.4). Hit-testing is done in *screen* space against the
   * boxes the paint pass registered, so a symbol is as easy to hit at 0.2x as at
   * 8x. A click on empty map now just clears the selection: it never re-frames the
   * view, because a map that snaps back under your hand is not an interactive map.
   */
  selectAt(sx, sy) {
    const hit = this._hitTest(sx, sy);
    if (!hit) {
      if (this.selected) { this.clearSelection(); if (this.open) this.drawFull(); }
      return null;
    }
    this.select(hit.payload);
    return hit.payload;
  }

  /** Legacy alias kept for the 3D view and any older caller. */
  _selectAt(sx, sy) { return this.selectAt(sx, sy); }

  _hitTest(sx, sy) {
    let best = null, score = Infinity;
    for (const h of this._hits) {
      const d = Math.hypot(h.x - sx, h.y - sy);
      if (d > h.r) continue;
      const s = d + h.r * 0.25;           // a small marker wins over the big footprint box it sits on
      if (s < score) { score = s; best = h; }
    }
    return best;
  }

  /**
   * Structures are tap targets too (v4.4): "what is that building, and can I get in?"
   * is answered from the collider that is drawn, never from invented metadata. A solid
   * mass says so on the card, and the route to it stops at its edge like the router
   * already does on the ground.
   */
  _markMassHit(f, role, v) {
    const cxw = (f.x0 + f.x1) / 2, czw = (f.z0 + f.z1) / 2;
    const s = this._worldToScreen(cxw, czw, v);
    if (s.x < -30 || s.y < -30 || s.x > v.w + 30 || s.y > v.h + 30) return null;
    const w = Math.abs(f.x1 - f.x0), d = Math.abs(f.z1 - f.z0);
    const rad = THREE.MathUtils.clamp(Math.min(w, d) * v.scale / 2, 9, 26);
    return this._markHit(s.x, s.y, rad, {
      key: 'mass:' + role + ':' + f.x0.toFixed(1) + ',' + f.z0.toFixed(1) + ',' + f.x1.toFixed(1) + ',' + f.z1.toFixed(1),
      kind: 'structure', subtype: role.toUpperCase(), label: f.name || role.toUpperCase(),
      x: cxw, z: czw, nav: f.nav !== false,
      info: Math.round(w) + ' x ' + Math.round(d) + ' m'
        + (f.h ? '  H ' + (Math.round(f.h * 10) / 10) + ' m' : '')
        + (f.tag ? '  ' + String(f.tag).toUpperCase() : '')
        + '  ' + (f.nav === false ? 'SOLID - THE ROUTE STOPS AT ITS EDGE' : 'PASSABLE'),
    });
  }

  /** Register a clickable symbol. Only the big map registers; the minimap must not. */
  _markHit(x, y, r, payload) {
    if (!this._paintingFull || !payload) return null;
    const hit = { x, y, r: Math.max(9, r + HIT_PAD), payload };
    this._hits.push(hit);
    return hit;
  }

  select(payload) {
    if (!payload) { this.clearSelection(); return; }
    this.selected = payload;
    // Mission markers own a routing identity, so tapping one retargets the planned
    // route (v4.3 behaviour). Plain features/items have none: they only open a card,
    // and the card's NAVIGATE button is what routes to them.
    if (payload.routeSel && this.routeSel !== payload.routeSel) {
      this.routeSel = payload.routeSel;
      this.customTarget = null;
    }
    this.selectedRoute = (this.routeSel && payload.routeSel === this.routeSel) ? payload.key : null;
    const g = this.game;
    if (g && g.ui && g.ui.toastBrief && payload.label) {
      const dx = payload.x - g.player.pos.x, dz = payload.z - g.player.pos.z;
      g.ui.toastBrief(payload.label + ' — ' + Math.round(Math.hypot(dx, dz)) + ' m ' + compassTo(dx, dz), 2.6);
    }
    this._syncControls();
  }

  clearSelection() {
    this.selected = null;
    this.selectedRoute = null;
    this._syncControls();
  }

  /** NAVIGATE: plan the walkable route to the selected marker. */
  navigateToSelection() {
    const s = this.selected;
    const g = this.game;
    if (!s) return false;
    if (s.kind === 'player') return false;
    if (s.routeSel) {
      this.customTarget = null;
      this.routeSel = s.routeSel;
    } else {
      this.customTarget = { x: s.x, z: s.z, label: s.label || 'WAYPOINT' };
      this.routeSel = 'custom';
    }
    this.selectedRoute = s.key;
    if (g && g.ui && g.ui.toastBrief) g.ui.toastBrief('ROUTE PLANNED TO ' + String(s.label || 'MARKER').toUpperCase());
    this._syncControls();
    if (this.open) this.drawFull();
    return true;
  }

  // ---------------------------------------------------------------------
  /** The status strip, built in one place so its footprint can be reserved before any map
   *  label is placed. The strip is painted unconditionally - it is where "NO WALKABLE
   *  ROUTE" and the zoom readout have to appear - so a feature label landing under it
   *  reads as overlapping text (on a 412 px phone the mission-area label did exactly that). */
  _statusBits(route) {
    const bits = [];
    if (this.follow) bits.push('FOLLOW');
    if (this.rotateMode === 'player') bits.push('PLAYER-UP');
    if (route) bits.push(route.pts ? `ROUTE ${Math.round(route.meters)} m${route.viaDoors ? ' VIA DOOR' : ''}` : 'NO WALKABLE ROUTE');
    else if (this.routeSel) bits.push('NO TARGET');
    bits.push('ZOOM ' + this.zoom.toFixed(this.zoom < 1 ? 2 : 1) + '\u00d7');
    if (this.selected) {
      const gp = this.game.player;
      const sdx = this.selected.x - gp.pos.x, sdz = this.selected.z - gp.pos.z;
      bits.push('SELECTED ' + String(this.selected.label || '').toUpperCase() + ' '
        + Math.round(Math.hypot(sdx, sdz)) + ' m ' + compassTo(sdx, sdz));
    }
    return bits;
  }

  drawFull() {
    const t0 = nowMs();
    const g = this.game, ctx = this.fullCtx;
    this._drawCalls = 0;
    if (!ctx || !this.open || !this.fog || this.mode === '3d') return;
    const moved = this._animateView();
    // While the view is easing, the toolbar readouts are part of the frame: a zoom
    // label that only updates on press shows a number the player is not looking at.
    if (moved || this._animating) this._syncControls();
    // The backing store must be exactly the CSS box x DPR. A cap here used to clamp
    // the bitmap to 1024 px, which clipped (and, once upscaled, blurred) the map on
    // any large display - the single reason a data-correct map still looked awful.
    this._sizeCanvas(this.fullCv, 4096);
    const dpr = this._dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geom = ensureMapGeometry(g, this.geom);
    const v = this._prepareView(this.fullCv);
    const vis = this._visibleRect(v);
    this._labels = [];
    this._labelBoxes = [];
    {
      // reserve the strip and the scale bar before anything asks for a label slot
      const worst = this._statusBits(null).join('  \u00b7  ') + '  \u00b7  ROUTE 000 m  \u00b7  SELECTED XXXXXXXX 000 m NE';
      const measured = ctx.measureText ? ctx.measureText(worst).width : 420;
      this._labelBoxes.push({ x: 8, y: 4, w: Math.min(v.w - 16, 14 + measured + 8), h: 22 });
      this._labelBoxes.push({ x: 8, y: 26, w: 124, h: 22 });
    }
    this._hits.length = 0;
    this._paintingFull = true;
    ctx.clearRect(0, 0, v.w, v.h);
    this._drawField(ctx, v, this.geom);
    this._drawMasses(ctx, this.geom, v, vis, true);
    if (this._layerOn('fog')) this._drawFog(ctx, v, false);
    const targets = (g.missions && g.missions.mapTargets) ? g.missions.mapTargets() : [];
    const route = this._ensureRoute(this.geom, this._currentTarget(this.geom, targets));
    this._drawRoute(ctx, v, route, true);
    this._drawMarkers(ctx, v, this.geom, true);
    this._drawPlayer(ctx, v, g);
    this._paintSelection(ctx, v);
    this._paintLabels(ctx, v);
    this._paintOverlays(ctx, v, route);
    this._paintingFull = false;
    this._lastDrawMs = nowMs() - t0;
  }

  /** The selection ring: 4 corner brackets, no glow, no animated pulsing. */
  _paintSelection(ctx, v) {
    const s = this.selected;
    if (!s) return;
    const p = this._worldToScreen(s.x, s.z, v);
    if (p.x < -40 || p.y < -40 || p.x > v.w + 40 || p.y > v.h + 40) return;
    const r = 13;
    ctx.strokeStyle = MAP_STYLE.you;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    this._drawCalls++;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.moveTo(p.x + sx * r, p.y + sy * r - sy * 5);
      ctx.lineTo(p.x + sx * r, p.y + sy * r);
      ctx.lineTo(p.x + sx * r - sx * 5, p.y + sy * r);
    }
    ctx.stroke();
    this._markHit(p.x, p.y, r + 2, s);
    this._reserveBox(p.x, p.y, r + 6);
  }

  /** North arrow, scale bar, route status line — screen furniture, drawn last. */
  _paintOverlays(ctx, v, route) {
    ctx.font = MAP_STYLE.fontTiny;
    ctx.textBaseline = 'alphabetic';
    // north
    ctx.save();
    ctx.translate(v.w - 20, v.h - 26);   // bottom-right: clear of the layer popover and the detail card
    if (this.rotateMode === 'player') ctx.rotate(-this.game.player.yaw);
    ctx.strokeStyle = MAP_STYLE.text; ctx.lineWidth = 1.4;
    ctx.fillStyle = MAP_STYLE.text;
    ctx.beginPath();
    this._drawCalls++;
    ctx.moveTo(0, 7); ctx.lineTo(0, -8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(-3.4, -2); ctx.moveTo(0, -8); ctx.lineTo(3.4, -2); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, -11);
    ctx.restore();
    // scale bar: pick a round metre length near 70 px
    const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
    let mPer = nice[nice.length - 1];
    for (const n of nice) { if (n * v.scale >= 55) { mPer = n; break; } }
    const px = mPer * v.scale;
    // The bar sits under the status line at the top-left: the bottom of the stage is
    // spoken for by the marker detail card, and a scale bar behind a card is useless.
    const barY = 38;
    ctx.strokeStyle = MAP_STYLE.dim; ctx.lineWidth = 1.4;
    ctx.beginPath();
    this._drawCalls++;
    ctx.moveTo(14, barY); ctx.lineTo(14 + px, barY);
    ctx.moveTo(14, barY - 3); ctx.lineTo(14, barY + 3);
    ctx.moveTo(14 + px, barY - 3); ctx.lineTo(14 + px, barY + 3);
    ctx.stroke();
    ctx.fillStyle = MAP_STYLE.dim;
    ctx.textAlign = 'left';
    ctx.fillText(mPer + ' m', 14, barY - 6);
    // status line
    const bits = this._statusBits(route);
    ctx.textAlign = 'left';
    ctx.fillStyle = route && !route.pts ? MAP_STYLE.foe : MAP_STYLE.dim;
    // The status line is always painted, so a critical state cannot be lost to
    // label crowding the way an anchored label can.
    ctx.fillText(bits.join('  ·  '), 14, 16);
    this._drawCalls++;
  }

  // ---------------------------------------------------------------------
  // mini-map (HUD) — same data, same projection, reduced furniture
  // ---------------------------------------------------------------------
  drawMini() {
    const g = this.game, ctx = this.miniCtx;
    if (!ctx || !this.miniCv || !this.fog) return;
    const s = g.settings;
    const show = s.minimapOn && g.state === 'playing' && !this.open;
    if (this._miniShown !== show) { this._miniShown = show; this.miniCv.classList.toggle('hidden', !show); }
    if (!show) { this._miniNext = 0; return; }
    // ~15 Hz redraw cadence (was every frame): minimap content moves at walking
    // pace and this keeps the HUD's raster cost down by ~4x on a 60 Hz display.
    const now = nowMs();
    if (this._miniNext && now < this._miniNext) return;
    this._miniNext = now + 66;
    this.miniDirty = false;
    const sizeKey = s.minimapSize || 'm';
    const px = sizeKey === 's' ? 110 : sizeKey === 'l' ? 190 : 148;
    const S = 180;
    if (this.miniCv.width !== S) { this.miniCv.width = S; this.miniCv.height = S; }
    const op = String(s.minimapOpacity != null ? s.minimapOpacity : 0.85);
    if (this._miniPx !== px) { this._miniPx = px; this.miniCv.style.width = px + 'px'; this.miniCv.style.height = px + 'px'; }
    if (this._miniOp !== op) { this._miniOp = op; this.miniCv.style.opacity = op; }
    this.geom = ensureMapGeometry(g, this.geom);
    const zoom = THREE.MathUtils.clamp((S / (70 * PPM)), this.minZoom, 1);
    const savedZoom = this.zoom, savedPanX = this.panX, savedPanY = this.panY, savedRot = this.rotateMode;
    this.zoom = zoom; this.panX = 0; this.panY = 0;
    this.rotateMode = (s.minimapRotate || 'north') === 'player' ? 'player' : 'north';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = MAP_STYLE.field;
    ctx.fillRect(0, 0, S, S);
    // The mini-map's backing store is a fixed 180 while its CSS box can be 110/148/190:
    // project in backing-store pixels, or the painting and the round frame disagree.
    const v = this._prepareView({ clientWidth: S, clientHeight: S, width: S, height: S });
    this._lastMiniView = v;            // instrumentation the tests read (the view is rebuilt per frame now)
    const vis = this._visibleRect(v);
    this._labels = []; this._labelBoxes = [];
    this._drawMasses(ctx, this.geom, v, vis, false);
    this._drawFog(ctx, v, true);
    const targets = (g.missions && g.missions.mapTargets) ? g.missions.mapTargets() : [];
    const route = this._ensureRoute(this.geom, this._currentTarget(this.geom, targets));
    this._drawRoute(ctx, v, route, false);
    this._drawMarkers(ctx, v, this.geom, false);
    this._drawPlayer(ctx, v, g);
    ctx.restore();
    ctx.strokeStyle = 'rgba(140,170,160,0.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2); ctx.stroke();
    this.zoom = savedZoom; this.panX = savedPanX; this.panY = savedPanY; this.rotateMode = savedRot;
  }

  /** Match the backing store to the CSS size (crisp on HiDPI, no resampled blur). */
  _sizeCanvas(cv, maxSide) {
    if (!cv) return;
    const rect = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { width: cv.width, height: cv.height };
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const w = Math.max(160, Math.round((rect.width || cv.width || 560) * dpr));
    const h = Math.max(160, Math.round((rect.height || cv.height || 560) * dpr));
    this._dpr = dpr;
    const bw = Math.min(w, maxSide), bh = Math.min(h, maxSide);
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    if (cv.clientWidth == null) { cv.clientWidth = cv.width / dpr; cv.clientHeight = cv.height / dpr; }
  }

  // ---------------------------------------------------------------------
  // 3D view mode (map3d.js) — 2D data layer above is shared with it
  // ---------------------------------------------------------------------
  toggleMode() { this.setMode(this.mode === '3d' ? '2d' : '3d'); }

  setMode(mode) {
    if (mode !== '2d' && mode !== '3d') return;
    if (mode === this.mode) return;
    if (mode === '3d' && !this.map3d) return;
    if (this.open && this.mode === '3d' && this.map3d) this.map3d.exit();
    this.mode = mode;
    this._applyMode();
    this._syncControls();
    if (this.open) {
      if (mode === '3d') this.map3d.enter();
      else this.drawFull();
    }
  }

  _applyMode() {
    const is3d = this.mode === '3d';
    if (this.fullCv) this.fullCv.classList.toggle('hidden', is3d);
    const show = (id, on) => { const e = document.getElementById(id); if (e) e.classList.toggle('hidden', !on); };
    show('map3d-stage', is3d);
    show('tac3d-controls', is3d);
    show('tac3d-legend', is3d);
    show('tacmap-legend', !is3d);
    for (const id of ['tac-zoomout', 'tac-zoomin', 'tac-zoomval', 'tac-rotbtn', 'tac-routebtn', 'tac-fitbtn']) show(id, !is3d);
  }

  /** Called by game._onResize — keep both views sized correctly. */
  render2D() {
    if (this.mode === '3d') { if (this.map3d) this.map3d.resize(); return; }
    this.drawFull();
  }
}

// ---------------------------------------------------------------------------
// module-local helpers
// ---------------------------------------------------------------------------
function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

function diamond(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
  ctx.closePath();
}

function tracePath(ctx, pts) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) ctx.moveTo(pts[i].x, pts[i].y); else ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.stroke();
  return pts.length;
}

function overlap(a, b) {
  return !(a.x + a.w + 1 < b.x || b.x + b.w + 1 < a.x || a.y + a.h + 1 < b.y || b.y + b.h + 1 < a.y);
}

/** Keep label text short: the map must stay readable, and long prompts overlap. */
function shortLabel(text, kind) {
  const t = String(text || kind || '').replace(/\s+/g, ' ').trim();
  if (t.length <= 22) return t.toUpperCase();
  return t.slice(0, 21).trim() + '…';
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function compassTo(dx, dz) {
  let ang = Math.atan2(dx, -dz) * 180 / Math.PI;
  if (ang < 0) ang += 360;
  return COMPASS[Math.round(ang / 45) % 8];
}

/** Visible fog-cell index range for the current view. */
function vis0(map, v, f) {
  const r = map._visibleRect(v);
  return {
    minI: Math.floor((r.minX - f.x0) / f.cell),
    maxI: Math.ceil((r.maxX - f.x0) / f.cell),
    minJ: Math.floor((r.minZ - f.z0) / f.cell),
    maxJ: Math.ceil((r.maxZ - f.z0) / f.cell),
  };
}

export { LEGEND_BY_KIND, PPM, MAP_GEOM };
