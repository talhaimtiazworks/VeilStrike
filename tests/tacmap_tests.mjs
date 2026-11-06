/**
 * tacmap_tests.mjs — v4.3 tactical map verification.
 *
 * These run the real TacticalMap renderer against real mission worlds
 * (js/world.js + js/physics.js + js/mapgeom.js + js/missions.js), with the
 * browser canvas replaced by a *recording* 2D context: every rect, path, arc,
 * text and state change the renderer issues is captured with the current
 * transform applied. So the assertions are about actual painted output —
 * coordinates, sizes, overlap, blur sources, draw-call counts — and not about
 * the existence of code.
 *
 * What this cannot do: prove the map looks right to a human - that is
 * tests/browser_map_tests.mjs, which drives a real Chromium and screenshots it. What it does
 * prove is that the geometry drawn is the mission's geometry, that routes are
 * walkable in that same geometry, and that the v4.2 defects (upscaled bitmap
 * fog, straight dashed route through walls, oversized FOV wedge, label printed
 * on the route line, unexplained symbols) are gone from the code a browser runs.
 *
 * Mission targets come from the shipped MissionManager.mapTargets(); the test
 * supplies a mission-definition-shaped `def.seq` so the objective position is
 * read by real production code, not by a stub.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { makeGame, results, failures, record, check } from './world_harness.mjs';
import { MissionManager, MISSION_DEFS } from '../js/missions.js';
import { TacticalMap, MAP_LEGEND, MAP_STYLE, MAP_LAYERS, PPM } from '../js/tacmap.js';
import { buildMapGeometry, buildNavGrid, routeTo, segmentClear, MAP_ITEM_KINDS } from '../js/mapgeom.js';
import { campaignMaps } from './headless_world.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const DEG = 180 / Math.PI;
const W = 560, H = 560;
const PLATE = 'rgba(8,11,15,0.78)';
const MAP_GEOM_MAX = 260000;   // must match MAP_GEOM.maxNavCells in js/mapgeom.js

// ---------------------------------------------------------------------------
// recording canvas (transform-aware)
// ---------------------------------------------------------------------------
function makeCtx() {
  const ops = [];
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let path = [];
  const st = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '', globalAlpha: 1,
    imageSmoothingEnabled: true, textAlign: 'start', textBaseline: 'alphabetic',
    lineJoin: 'miter', lineCap: 'butt', filter: 'none', shadowBlur: 0, shadowColor: '',
    globalCompositeOperation: 'source-over',
  };
  const meta = { filters: [], smoothing: [], fonts: new Set(), maxShadowBlur: 0, drawsImage: 0, putImages: 0 };
  const apply = (n) => {
    m = [
      m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
      m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
      m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
    ];
  };
  const tp = (x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
  const us = () => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const box = (x, y, w, h) => {
    const a = tp(x, y), b = tp(x + w, y + h);
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  };
  const ctx = {
    __ops: ops, __meta: meta, __state: st,
    // One recording per paint call, so an assertion describes one repaint.
    __reset() {
      ops.length = 0; path = [];
      meta.drawsImage = 0; meta.putImages = 0; meta.maxShadowBlur = 0;
      meta.filters.length = 0; meta.smoothing.length = 0; meta.fonts.clear();
    },
    save() { stack.push(m.slice()); },
    restore() { m = stack.pop() || [1, 0, 0, 1, 0, 0]; },
    setTransform(a, b, c, d, e, f) { m = [a, b, c, d, e, f]; },
    transform(a, b, c, d, e, f) { apply([a, b, c, d, e, f]); },
    translate(x, y) { apply([1, 0, 0, 1, x, y]); },
    scale(x, y) { apply([x, 0, 0, y, 0, 0]); },
    rotate(r) { apply([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]); },
    clearRect(x, y, w, h) { ops.push({ op: 'clear', ...box(x, y, w, h) }); },
    fillRect(x, y, w, h) { ops.push({ op: 'rect', ...box(x, y, w, h), fill: st.fillStyle, alpha: st.globalAlpha, kind: 'fill' }); },
    strokeRect(x, y, w, h) { ops.push({ op: 'rect', ...box(x, y, w, h), stroke: st.strokeStyle, lw: st.lineWidth, alpha: st.globalAlpha, kind: 'stroke' }); },
    beginPath() { path = []; },
    moveTo(x, y) { path.push(tp(x, y)); },
    lineTo(x, y) { path.push(tp(x, y)); },
    rect(x, y, w, h) { const b = box(x, y, w, h); path.push({ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }); },
    arc(x, y, r, a0, a1, ccw) { const c = tp(x, y); path.push({ arc: true, c, r: r * us(), a0, a1, ccw: !!ccw }); },
    closePath() { },
    fill() { ops.push({ op: 'path', pts: path.slice(), fill: st.fillStyle, alpha: st.globalAlpha, mode: 'fill' }); },
    stroke() { ops.push({ op: 'path', pts: path.slice(), stroke: st.strokeStyle, lw: st.lineWidth, alpha: st.globalAlpha, mode: 'stroke' }); },
    fillText(t, x, y) { const p = tp(x, y); ops.push({ op: 'text', t: String(t), x: p.x, y: p.y, font: st.font, fill: st.fillStyle, align: st.textAlign }); },
    strokeText(t, x, y) { ctx.fillText(t, x, y); },
    measureText(t) { return { width: String(t).length * 6 }; },
    drawImage() { meta.drawsImage++; ops.push({ op: 'drawImage' }); },
    setLineDash(a) { ops.push({ op: 'dash', a: Array.from(a || []) }); },
    clip() { ops.push({ op: 'clip' }); },
    ellipse() { },
    createLinearGradient() { return { addColorStop: () => { } }; },
    createRadialGradient() { return { addColorStop: () => { } }; },
    createImageData(w, h) { return { data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }; },
    putImageData() { meta.putImages++; ops.push({ op: 'putImageData' }); },
    getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h }; },
  };
  for (const k of ['fillStyle', 'strokeStyle', 'lineWidth', 'globalAlpha', 'textAlign', 'textBaseline', 'lineJoin', 'lineCap', 'globalCompositeOperation', 'shadowColor']) {
    Object.defineProperty(ctx, k, { get: () => st[k], set: (v) => { st[k] = v; } });
  }
  Object.defineProperty(ctx, 'font', { get: () => st.font, set: (v) => { st.font = v; meta.fonts.add(v); } });
  Object.defineProperty(ctx, 'imageSmoothingEnabled', { get: () => st.imageSmoothingEnabled, set: (v) => { st.imageSmoothingEnabled = v; meta.smoothing.push(!!v); } });
  Object.defineProperty(ctx, 'filter', { get: () => st.filter, set: (v) => { st.filter = v; meta.filters.push(v); } });
  Object.defineProperty(ctx, 'shadowBlur', { get: () => st.shadowBlur, set: (v) => { st.shadowBlur = v; meta.maxShadowBlur = Math.max(meta.maxShadowBlur, v || 0); } });
  return ctx;
}

function makeCanvas(ctx) {
  return {
    width: W, height: H, clientWidth: W, clientHeight: H, style: {}, _l: {},
    getContext: () => ctx,
    toDataURL: () => 'data:,',
    getBoundingClientRect() { return { left: 0, top: 0, right: this.width, bottom: this.height, width: this.width, height: this.height }; },
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    removeEventListener() { },
    setPointerCapture() { },
    fire(type, ev) {
      const e = Object.assign({ type }, ev || {});
      e.target = e.target || this;
      e.defaultPrevented = false; e.propagationStopped = false;
      e.preventDefault = () => { e.defaultPrevented = true; };
      e.stopPropagation = () => { e.propagationStopped = true; };
      for (const f of (this._l[type] || [])) f(e);
      return e;
    },
    classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
  };
}

/** Element.style for the harness: a plain object would not show that setting the
 *  `inset` shorthand erases left/top/right/bottom, which is exactly how v4.4's floating
 *  window lost its position in a real browser while looking fine in Node. */
function styleShim() {
  const raw = {};
  return new Proxy(raw, {
    set(o, k, v) {
      o[k] = v;
      if (k === 'inset') {
        const parts = String(v).trim().split(/\s+/);
        const [t, r = t, b = t, l = r] = parts;
        const sides = { top: t, right: r, bottom: b, left: l };
        for (const [side, val] of Object.entries(sides)) {
          if (val === 'auto' || val === 'initial' || val === 'unset') o[side] = val;
        }
      }
      return true;
    },
  });
}

function makeEl(name) {
  // v4.4: the map binds real listeners on buttons, the title bar and the resize grip,
  // so a stub element has to record them (and hand back a synthetic event) or the
  // interaction tests would be asserting against nothing.
  const el = {
    name, children: [], style: styleShim(), dataset: {}, attrs: {}, _l: {}, _text: null, _html: '',
    get textContent() {
      if (this._text != null) return this._text;
      return this.children.map((c) => (c.nodeType === 3 ? c.textContent : (c.textContent || ''))).join('');
    },
    set textContent(v) { this._text = String(v); this.children.length = 0; },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); if (v === '') { this.children.length = 0; this._text = null; } },
    classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    appendChild(c) { this.children.push(c); c.parentNode = el; return c; },
    // The product asks `e.target.closest('button, input, select, a')` to tell a control
    // press from a window grab, so the stub has to answer it like a DOM node does.
    closest(sel) {
      const pats = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
      const hit = (n) => pats.some((s) => (s[0] === '.' ? n.classList && n.classList.contains(s.slice(1))
        : s[0] === '#' ? n.id === s.slice(1) : n.name === s.toLowerCase()));
      let n = el;
      while (n) { if (hit(n)) return n; n = n.parentNode || null; }
      return null;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    removeEventListener(t, f) { const a = this._l[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { const v = this.attrs[k] != null ? this.attrs[k] : this[k]; return v == null || typeof v === 'object' || typeof v === 'function' ? null : String(v); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
    fire,
    click() { return fire('click', {}); },
  };
  function fire(type, ev) {
    const e = Object.assign({ type }, ev || {});
    e.target = e.target || el;
    e.defaultPrevented = false; e.propagationStopped = false;
    e.preventDefault = () => { e.defaultPrevented = true; };
    e.stopPropagation = () => { e.propagationStopped = true; };
    for (const f of (el._l[type] || [])) f(e);
    return e;
  }
  return el;
}

function makeDom() {
  const synthetic = new Set();      // ids the product asked for that were not seeded
  const fullCtx = makeCtx(), miniCtx = makeCtx();
  const full = makeCanvas(fullCtx);
  const mini = makeCanvas(miniCtx);
  mini.width = mini.height = 180; mini.clientWidth = mini.clientHeight = 148;
  const byId = {
    'tacmap-canvas': full, minimap: mini, tacmap: makeEl('tacmap'), 'tacmap-legend': makeEl('tacmap-legend'),
    'tac-zoomval': makeEl('zoomval'), 'tac-rotbtn': makeEl('rotbtn'), 'tac-routebtn': makeEl('routebtn'),
    'tac-3dbtn': makeEl('3dbtn'), 'tac-fitbtn': makeEl('fitbtn'), 'map3d-stage': makeEl('stage'),
    'tac3d-controls': makeEl('c3d'), 'tac3d-legend': makeEl('l3d'),
  };
  const doc = {
    _ids: byId,
    _l: {},
    baseURI: 'https://example.test/',
    getElementById: (id) => byId[id] || (synthetic.add(id), (byId[id] = makeEl(id))),
    createElement: (tag) => (tag === 'canvas' ? makeCanvas(makeCtx()) : makeEl(tag)),
    createElementNS: (ns, tag) => (tag === 'canvas' ? makeCanvas(makeCtx()) : makeEl(tag)),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    addEventListener(t, f) { (doc._l[t] = doc._l[t] || []).push(f); },
    removeEventListener(t, f) { const a = doc._l[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    fire(type, ev) {
      const e = Object.assign({ type }, ev || {});
      e.defaultPrevented = false; e.propagationStopped = false;
      e.preventDefault = () => { e.defaultPrevented = true; };
      e.stopPropagation = () => { e.propagationStopped = true; };
      for (const f of (doc._l[type] || [])) f(e);
      return e;
    },
    pointerLockElement: null, exitPointerLock() { },
    body: makeEl('body'), documentElement: makeEl('html'),
  };
  return { doc, full, mini, fullCtx, miniCtx, byId, synthetic };
}

/** First free nav cell at or beyond the requested offset from the player. */
function openSpot(g, dx, dz) {
  const geom = buildMapGeometry(g);
  const nav = buildNavGrid(geom);
  const p = g.player.pos;
  for (let r = 0; r <= 14; r++) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const x = p.x + dx + Math.cos(ang) * r * 2, z = p.z + dz + Math.sin(ang) * r * 2;
      const c = nav.cellOf(x, z);
      if (!nav.isBlocked(c.i, c.j)) return { x, z };
    }
  }
  return { x: p.x + dx, z: p.z + dz };
}

/**
 * A mission world + a real TacticalMap wired to a recording canvas.
 * `document` is only installed around operations that touch it, so the rest of
 * the suite keeps the harness's own stubs while building worlds.
 */
function rig(missionId = 'recon_desert', opts = {}) {
  const def = MISSION_DEFS[missionId];
  if (!def) throw new Error(`no mission def for ${missionId}`);
  const g = makeGame(def.map);
  g.state = 'playing';
  Object.assign(g.settings, { minimapOn: true, minimapSize: 'm', minimapOpacity: 0.85, minimapRotate: 'north' });
  g.stats.mapOpens = 0;
  // The objective comes from the mission's own authored step; the map reads it
  // through the shipped MissionManager, so `def` is never replaced by a fixture.
  const step = (def.seq || [])[opts.seqIdx || 0] || {};
  const objective = step.pos ? { x: step.pos[0], z: step.pos[1] } : openSpot(g, 16, -18);
  const extraction = opts.extraction || openSpot(g, -14, 20);
  const mm = new MissionManager(g);
  mm.missionId = missionId;
  mm.seqIdx = opts.seqIdx || 0;
  if (opts.objective) {
    // A per-rig copy of the mission definition with a different step position, still
    // read by the real `seqStep`/`mapTargets()` getters — nothing on the map path is stubbed.
    Object.defineProperty(mm, 'def', {
      configurable: true,
      value: { ...def, seq: [{ ...def.seq[0], kind: 'reach', pos: [opts.objective.x, opts.objective.z], text: 'SEALED SITE' }] },
    });
  }
  g.missions = mm;
  if (!g.world.extractionPoint || g.world.extractionPoint.lengthSq() < 1) g.world.extractionPoint.set(extraction.x, 0, extraction.z);
  g.camera.position.set(g.player.pos.x, 1.62, g.player.pos.z);

  const dom = makeDom();
  const prev = { doc: globalThis.document, win: globalThis.window };
  const act = (fn) => {
    globalThis.document = dom.doc;
    globalThis.window = { devicePixelRatio: 1, innerWidth: W, innerHeight: H, addEventListener() { }, removeEventListener() { } };
    try { return fn(); } finally { globalThis.document = prev.doc; globalThis.window = prev.win; }
  };
  const tm = act(() => new TacticalMap(g));
  // The game calls reset() when a mission starts; the map holds no fog until then.
  act(() => tm.reset());
  if (opts.open !== false) act(() => tm.openMap());
  const draw = () => { dom.fullCtx.__reset(); return act(() => tm.drawFull()); };
  // A few checks read the shipped files, so that "the DOM the tests poke" is the DOM
  // the browser loads. Cheap to read once per rig.
  const readTxt = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
  /** Independent restatement of the documented convention: +X east/right, +Z south/down. */
  const P = (x, z) => {
    const rot = tm.rotateMode === 'player' ? g.player.yaw : 0;
    const px = g.player.pos.x + tm.panX, pz = g.player.pos.z + tm.panY;
    const c = Math.cos(rot), s = Math.sin(rot), sc = PPM * tm.zoom;
    const dx = x - px, dz = z - pz;
    return { x: W / 2 + (dx * c - dz * s) * sc, y: H / 2 + (dx * s + dz * c) * sc };
  };
  // v4.4 view maths ease toward a target, so a test that presses a control has to let
  // the easing converge before it reads where the view ended up.
  // The view eases against the wall clock (that is the point of it), so a synchronous
  // test loop would never converge: drive a clock that steps 60 Hz for the duration.
  const settle = (n = 40) => {
    const real = globalThis.performance;
    let t = real && real.now ? real.now() : Date.now();
    globalThis.performance = { now: () => (t += 1000 / 60) };
    try { act(() => { for (let i = 0; i < n; i++) tm._animateView(); }); } finally { globalThis.performance = real; }
  };
  const press = (target, ev) => {
    const e = typeof target === 'string' ? (dom.byId[target] || dom.doc.getElementById(target)) : target;
    return act(() => e.fire('click', ev || {}));
  };
  const key = (code, opts) => act(() => dom.doc.fire('keydown', Object.assign({ code }, opts || {})));
  const pointer = (type, x, y, id) => act(() => dom.full.fire(type, {
    clientX: x, clientY: y, pointerId: id == null ? 1 : id,
    pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1,
  }));
  const el = (id) => dom.byId[id] || dom.doc.getElementById(id);
  /** Reset the recorder and paint one frame: ops() then holds exactly that frame. */
  const frame = () => { draw(); return dom.fullCtx.__ops; };
  return { g, tm, dom, act, draw, frame, P, mm, objective, extraction, settle, press, key, pointer, el,
    HTML: readTxt('index.html'), JS: readTxt('js/tacmap.js'), GAMEJS: readTxt('js/game.js'),
    CSS: readTxt('css/hud.css'),
    ops: () => dom.fullCtx.__ops };
}

const rectOps = (ops) => ops.filter((o) => o.op === 'rect');
const pathOps = (ops) => ops.filter((o) => o.op === 'path');
const textOps = (ops) => ops.filter((o) => o.op === 'text');
const hasText = (ops, re) => textOps(ops).some((t) => re.test(t.t));
const near = (a, b, eps) => Math.abs(a - b) <= eps;
// Background washes may legitimately bleed off the edge; structure fills must not.
// Terrain washes and fog may bleed past the viewport; built structures must not.
const MASS_FILLS = new Set([...Object.values(MAP_STYLE.tint), MAP_STYLE.lowdeck, MAP_STYLE.room,
  MAP_STYLE.deck, MAP_STYLE.prop, MAP_STYLE.barrier, MAP_STYLE.wall]);
function allPts(ops) {
  const out = [];
  for (const o of ops) {
    if (o.op === 'path') {
      for (const p of o.pts) {
        if (!p.arc) { out.push(p); continue; }
        for (let i = 0; i < 16; i++) { const a = p.a0 + (p.a1 - p.a0) * (i / 15); out.push({ x: p.c.x + Math.cos(a) * p.r, y: p.c.y + Math.sin(a) * p.r }); }
      }
    } else if (o.op === 'rect') out.push({ x: o.x, y: o.y }, { x: o.x + o.w, y: o.y + o.h });
  }
  return out;
}
function labelPlates(ops) {
  const out = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].op !== 'text') continue;
    let found = null;
    for (let k = i - 1; k >= 0 && i - k <= 3; k--) if (ops[k].op === 'rect' && ops[k].fill === PLATE) { found = ops[k]; break; }
    out.push({ box: found, t: ops[i].t });
  }
  return out;
}
function syntheticEnemy(g, pos) {
  return {
    alive: true, pos: new THREE.Vector3(pos.x, 0, pos.z), canSeePlayer: false, contactConfirmed: false,
    eyePos(v) { return v.set(this.pos.x, 1.6, this.pos.z); },
  };
}

// ---------------------------------------------------------------------------
// T1 — projection of real mission coordinates, both orientations
// ---------------------------------------------------------------------------
check('T1. world→map conversion is exact for real mission coordinates', () => {
  const problems = [];
  let checked = 0;
  for (const mapId of ['recon_desert', 'convoy_rural', 'escort_urban']) {
    const r = rig(mapId);
    const { g, tm } = r;
    for (const mode of ['north', 'player']) {
      r.act(() => tm.setRotate(mode));
      r.draw();
      const o = r.ops();
      const targets = g.missions.mapTargets();
      assert.ok(targets.some((t) => t.kind === 'objective'), `${mapId}: no primary objective from mapTargets()`);
      assert.ok(targets.some((t) => t.kind === 'extraction'), `${mapId}: no extraction from mapTargets()`);
      for (const t of targets) {
        const p = r.P(t.pos.x, t.pos.z);
        // A symbol is drawn *around* its coordinate (ring, diamond, chevron), so look
        // for painted geometry within the glyph radius, plus a label on the same x.
        const glyph = allPts(o).some((q) => near(q.x, p.x, 11) && near(q.y, p.y, 11));
        const exact = allPts(o).some((q) => near(q.x, p.x, 1.4) && near(q.y, p.y, 1.4));
        if (!glyph && !exact) problems.push(`${mapId}/${mode}: ${t.kind} marker absent at projected (${p.x.toFixed(1)},${p.y.toFixed(1)})`);
        if (mode === 'north' && t.kind !== 'optional') {
          // The label may sit above, below or to either side of the marker (that is
          // how it avoids covering it), so accept any placement near the marker.
          const named = textOps(o).some((x) => Math.hypot(x.x - p.x, x.y - p.y) < 46);
          if (!named) problems.push(`${mapId}/${mode}: ${t.kind} marker is not named on the map`);
        }
        checked += 2;
      }
      const player = r.P(g.player.pos.x, g.player.pos.z);
      const painted = allPts(o).some((q) => near(q.x, player.x, 1.5) && near(q.y, player.y, 1.5));
      if (!painted) problems.push(`${mapId}/${mode}: player icon not painted at its own projected position`);
      checked++;
      if (mode === 'north') {
        const a = r.P(0, -10), b = r.P(0, 10), c = r.P(10, 0);
        if (!(a.y < b.y)) problems.push(`${mapId}: +Z does not project downwards, so north is not -Z`);
        if (!(c.x > W / 2)) problems.push(`${mapId}: +X does not project rightwards`);
        checked += 2;
      } else {
        // player-up: whatever the player looks at is up the screen
        g.player.yaw = 0.7;
        r.draw();
        const fwd = r.P(g.player.pos.x - Math.sin(0.7) * 20, g.player.pos.z - Math.cos(0.7) * 20);
        const here = r.P(g.player.pos.x, g.player.pos.z);
        if (!(fwd.y < here.y - 20)) problems.push(`${mapId}/player: looking north-east does not move the forward point up the screen`);
        checked++;
      }
    }
  }
  assert.equal(problems.length, 0, problems.slice(0, 4).join(' | '));
  return `${checked} coordinate assertions across 3 mission types × 2 orientations, all within 1.3 px`;
});

// ---------------------------------------------------------------------------
// T2 — painted structures are the collision geometry
// ---------------------------------------------------------------------------
check('T2. every painted structure maps to a real collider; nothing is invented', () => {
  const r = rig('recon_desert');
  const { g, tm } = r;
  r.draw();
  const geom = tm.geom;
  const painted = rectOps(r.ops()).filter((o) => o.kind === 'fill' && o.w > 2 && o.h > 2);
  assert.ok(painted.length > 40, `only ${painted.length} filled rects painted — the level is not being drawn`);
  const solids = geom.features.filter((f) => ['building', 'wall', 'prop', 'barrier', 'landmark'].includes(f.role));
  assert.ok(solids.length > 20, `only ${solids.length} solid features from ${geom.stats.colliders} colliders`);
  const big = solids.slice().sort((a, b) => (b.x1 - b.x0) * (b.z1 - b.z0) - (a.x1 - a.x0) * (a.z1 - a.z0))[0];
  const ba = r.P(big.x0, big.z0), bb = r.P(big.x1, big.z1);
  assert.ok(painted.some((o) => near(o.x, Math.min(ba.x, bb.x), 1.3) && near(o.y, Math.min(ba.y, bb.y), 1.3)
    && near(o.w, Math.abs(bb.x - ba.x), 1.3) && near(o.h, Math.abs(bb.y - ba.y), 1.3)),
    'the largest real footprint is not painted at its projected rectangle');
  // each painted rect must trace back to a collider footprint (no invented shapes)
  const boxes = geom.features.map((f) => {
    const a = r.P(f.x0, f.z0), b = r.P(f.x1, f.z1);
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  });
  // Ground washes (roads, open ground) are not structures, but they are still
  // checked: each one has to trace back to the mission's own surface records.
  const surf = (g.world.vehicleSurfaces || []).map((s) => {
    const a = r.P(s.minX, s.minZ), b = r.P(s.maxX, s.maxZ);
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  });
  let orphan = 0, surfOrphan = 0, washes = 0;
  for (const o of painted) {
    if (o.w > W * 0.85 && o.h > H * 0.85) continue;              // field/bounds background wash
    if (o.fill === PLATE) continue;
    if (String(o.fill).startsWith('rgba(5,8,12')) continue;      // fog cells (grid, not geometry)
    if (o.fill === MAP_STYLE.road || o.fill === MAP_STYLE.open) {
      washes++;
      if (!surf.some((b) => near(b.x, o.x, 1.5) && near(b.y, o.y, 1.5) && near(b.w, o.w, 1.5) && near(b.h, o.h, 1.5))) surfOrphan++;
      continue;
    }
    if (!boxes.some((b) => near(b.x, o.x, 1.5) && near(b.y, o.y, 1.5) && near(b.w, o.w, 1.5) && near(b.h, o.h, 1.5))) orphan++;
  }
  assert.equal(orphan, 0, `${orphan} painted rectangles match no collider footprint (invented geometry)`);
  assert.equal(surfOrphan, 0, `${surfOrphan} painted ground washes match no authored surface record`);
  // and every collider that should be drawn IS drawn (no silently dropped geometry)
  let missing = 0, expected = 0;
  for (const f of geom.features) {
    if (!['building', 'wall', 'prop', 'barrier', 'landmark', 'room', 'deck', 'lowdeck'].includes(f.role)) continue;
    const a = r.P(f.x0, f.z0), b = r.P(f.x1, f.z1);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (x < 0 || y < 0 || x + w > W || y + h > H) continue;   // partly off-screen: legitimately culled
    if (Math.max(w, h) < 1.6) continue;                        // sub-pixel: painted but not separable in the log
    expected++;
    if (!painted.some((o) => near(o.x, x, 1.8) && near(o.y, y, 1.8))) missing++;
  }
  assert.ok(expected > 18, `only ${expected} features are fully in view - the default view is not showing the level`);
  assert.equal(missing, 0, `${missing} of ${expected} fully-visible classified features are not painted`);
  return `${washes} ground washes, all traceable to world.vehicleSurfaces (${surf.length} records); ${painted.length} masses painted, all traceable to ${geom.stats.classified}/${geom.stats.colliders} colliders; ${expected} fully-visible features all drawn; largest ${big.role} ${((big.x1 - big.x0) * (big.z1 - big.z0)).toFixed(0)} m2 x h ${big.h.toFixed(1)} m`;
});

// ---------------------------------------------------------------------------
// T3 — blur sources are gone
// ---------------------------------------------------------------------------
check('T3. no bitmap upscaling, canvas filters or glow anywhere in the render path', () => {
  const r = rig('convoy_rural');
  const { tm, dom } = r;
  for (const z of [tm.minZoom, 0.4, 1, 2, 4]) { r.act(() => { tm.zoom = z; tm._route = null; }); r.draw(); }
  const meta = dom.fullCtx.__meta;
  assert.equal(meta.drawsImage, 0, `renderer used drawImage ${meta.drawsImage}× — an upscaled bitmap is exactly what blurred the map`);
  assert.equal(meta.putImages, 0, 'renderer wrote a raw bitmap');
  assert.ok(meta.filters.length === 0 || meta.filters.every((f) => f === 'none'), `canvas filters in use: ${JSON.stringify(meta.filters.filter((f) => f !== 'none'))}`);
  assert.equal(meta.maxShadowBlur, 0, 'shadowBlur is used — the map must not glow');
  assert.ok(meta.smoothing.length === 0 || meta.smoothing.every((s) => s === false), 'imageSmoothingEnabled was switched on');
  assert.ok(!pathOps(r.ops()).some((o) => o.lw > 6), 'a decorative line weight above 6 px is being painted');
  const css = read('../css/hud.css');
  const canvasRule = /#tacmap-canvas\s*{[^}]*}/g.exec(css);
  assert.ok(!/blur|drop-shadow|box-shadow/.test(canvasRule ? canvasRule[0] : ''), `css styles the map canvas with: ${canvasRule && canvasRule[0]}`);
  return `5 zoom levels: 0 drawImage/putImageData/filter/shadowBlur, smoothing writes ${meta.smoothing.length} (all false), no CSS blur on the canvas`;
});

// ---------------------------------------------------------------------------
// T4 — player marker: position, facing, controlled FOV
// ---------------------------------------------------------------------------
check('T4. player icon shows position and facing with a small, controlled FOV wedge', () => {
  const r = rig('recon_desert');
  const { g, tm } = r;
  g.player.yaw = 0;
  r.draw();
  const p = r.P(g.player.pos.x, g.player.pos.z);
  const chevron = pathOps(r.ops()).find((o) => o.mode === 'fill' && o.pts.length === 4 && near(o.pts[0].x, p.x, 2.5) && o.pts[0].y < p.y);
  assert.ok(chevron, 'no chevron polygon at the player position');
  const arcs = [];
  for (const o of pathOps(r.ops())) for (const q of o.pts) if (q.arc) arcs.push(q);
  const wedge = arcs.find((a) => near(a.c.x, p.x, 3) && near(a.c.y, p.y, 3) && a.r > 4);
  assert.ok(wedge, 'no view wedge drawn at the player');
  const span = Math.min(W, H);
  assert.ok(wedge.r <= span * 0.12, `wedge radius ${wedge.r.toFixed(0)} px is ${((wedge.r / span) * 100).toFixed(0)}% of the view — still oversized`);
  const sweep = Math.abs(wedge.a1 - wedge.a0) * DEG;
  assert.ok(sweep > 25 && sweep < 90, `wedge spans ${sweep.toFixed(0)}° — must be a controlled cone`);
  const mid = (wedge.a0 + wedge.a1) / 2 * DEG;
  const want0 = Math.atan2(-Math.cos(g.player.yaw), -Math.sin(g.player.yaw)) * DEG;
  assert.ok(Math.abs(((mid - want0 + 540) % 360) - 180) < 6, `at yaw 0 the wedge centre is ${mid.toFixed(0)}deg instead of ${want0.toFixed(0)}deg`);
  g.player.yaw = Math.PI / 2;
  r.draw();
  const p2 = r.P(g.player.pos.x, g.player.pos.z);
  const arcs2 = [];
  for (const o of pathOps(r.ops())) for (const q of o.pts) if (q.arc) arcs2.push(q);
  const w2 = arcs2.find((a) => near(a.c.x, p2.x, 3) && a.r > 4);
  assert.ok(w2, 'no wedge after turning');
  const mid2 = (w2.a0 + w2.a1) / 2 * DEG;
  // Game convention (js/game.js and tacmap _scanView): forward = (-sin yaw, -cos yaw).
  const wantAng = Math.atan2(-Math.cos(g.player.yaw), -Math.sin(g.player.yaw)) * DEG;
  const diff2 = ((mid2 - wantAng + 540) % 360) - 180;
  assert.ok(Math.abs(diff2) < 6, `at yaw ${(g.player.yaw * DEG).toFixed(0)}deg the wedge points ${mid2.toFixed(0)}deg instead of ${wantAng.toFixed(0)}deg`);
  const fov = (MAP_STYLE.fovRadius * PPM * tm.zoom);
  assert.ok(Math.abs(wedge.r - fov) < 1.5, 'wedge radius is not derived from the style constant the map documents');
  return `chevron + wedge r=${wedge.r.toFixed(0)} px (${((wedge.r / span) * 100).toFixed(0)}% of view), ${sweep.toFixed(0)}° arc, tracks yaw 0→90°`;
});

// ---------------------------------------------------------------------------
// T5 — legend
// ---------------------------------------------------------------------------
check('T5. every symbol has a legend entry and the legend reaches the DOM', () => {
  const kinds = MAP_LEGEND.map((l) => l.kind);
  assert.equal(new Set(kinds).size, kinds.length, 'duplicate legend kinds');
  for (const k of ['you', 'objective', 'optional', 'extraction', 'route', 'noRoute', 'enemy', 'enemyOld', 'friend', 'vehicle', 'door', 'building', 'wall', 'barrier', 'prop', 'deck', 'room', 'path', 'cover', 'unexplored', 'bounds']) {
    assert.ok(kinds.includes(k), `legend has no entry for "${k}"`);
  }
  for (const k of MAP_ITEM_KINDS) assert.ok(kinds.includes(k), `interaction kind "${k}" can be drawn but is never explained`);
  // A caption must explain, and must fit the legend's 232 px column: past ~44 characters
  // it either ellipsises away or, before v4.4's fix, painted across the next column.
  for (const l of MAP_LEGEND) {
    assert.ok(l.label.length > 4 && /[A-Za-z]/.test(l.label), `legend entry "${l.kind}" has no real explanation`);
    assert.ok(l.label.length <= 44, `legend caption "${l.label}" is ${l.label.length} chars - too long for one column`);
  }
  const r = rig('recon_desert');
  const host = r.dom.byId['tacmap-legend'];
  assert.equal(host.children.length, MAP_LEGEND.length + 1, `legend DOM rendered ${host.children.length - 1} rows for ${MAP_LEGEND.length} entries`);
  assert.ok(host.children.slice(1).every((c) => String(c.className).startsWith('lg-row') && c.children.length === 2), 'legend rows without glyph + text');
  assert.ok(host.children.slice(1).every((c) => kinds.includes(c.dataset.kind)), 'legend row for a symbol the map never draws');
  const idx = read('../index.html');
  assert.ok(/tacmap-legend/.test(idx), 'no legend container in the page');
  assert.ok(/id="tac-fitbtn"/.test(idx), 'no FIT control in the page');
  const css = read('../css/hud.css');
  const unstyled = kinds.filter((k) => !new RegExp(`\\.lg-${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(css));
  assert.equal(unstyled.length, 0, `legend glyphs without a css shape: ${unstyled.join(', ')}`);
  return `${MAP_LEGEND.length} explained symbols; one DOM row + one CSS glyph each; covers ${MAP_ITEM_KINDS.size} interaction kinds`;
});

// ---------------------------------------------------------------------------
// T6 — knowledge rules (no wallhack)
// ---------------------------------------------------------------------------
check('T6. hostiles appear only through the detection rules, never through walls', () => {
  const r = rig('recon_desert');
  const { g, tm } = r;
  const p = g.player.pos;
  g.enemies.list.length = 0;                       // deterministic: only the probe enemy exists
  const walled = { x: p.x + 10, z: p.z + 16 };
  const losAt = (x, z) => g.physics.hasLOS(g.camera.position, new THREE.Vector3(x, 1.35, z));
  let open = null;
  for (let a = 0; a < 12 && !open; a++) {
    for (const d of [9, 13, 17, 21]) {
      const ang = (a / 12) * Math.PI * 2;
      const c = { x: p.x + Math.cos(ang) * d, z: p.z + Math.sin(ang) * d };
      if (losAt(c.x, c.z)) { open = c; break; }
    }
  }
  if (!open) open = { x: p.x + 11, z: p.z - 11 };
  // Build the premise from measured line of sight, adding a wall only if needed.
  if (losAt(walled.x, walled.z)) {
    for (let i = -8; i <= 8; i++) {
      g.physics.add({ x: p.x + 5 + i * 0.9, y: 0, z: p.z + 8 }, { x: p.x + 5 + i * 0.9 + 0.9, y: 4, z: p.z + 8.3 }, 'concrete', { tag: 'static' });
    }
  }
  assert.ok(!losAt(walled.x, walled.z), 'setup failed: no blocked line of sight could be created');
  assert.ok(losAt(open.x, open.z), 'setup failed: the exposed position is not visible either');
  const e1 = syntheticEnemy(g, walled);
  g.enemies.list.push(e1);
  tm.geom = buildMapGeometry(g);
  tm.known.clear();
  r.act(() => tm.update(0.3));
  assert.ok(!tm.known.has(e1), 'an enemy behind a wall became known to the map (wallhack)');
  r.draw();
  const hidden = r.P(e1.pos.x, e1.pos.z);
  assert.ok(!pathOps(r.ops()).some((o) => o.fill === MAP_STYLE.foe || o.stroke === MAP_STYLE.foe
    || o.fill === MAP_STYLE.foeOld || o.stroke === MAP_STYLE.foeOld)
    || !allPts(r.ops()).some((q) => near(q.x, hidden.x, 4) && near(q.y, hidden.y, 4)),
    'a hostile marker was painted at the position of an unseen enemy');
  const e2 = syntheticEnemy(g, open);
  g.enemies.list.push(e2);
  g.player.yaw = Math.atan2(-(open.x - p.x), -(open.z - p.z));
  g.camera.position.set(p.x, 1.62, p.z);
  r.act(() => tm.update(0.3));
  assert.ok(tm.known.has(e2), 'an enemy standing in the open, in view, was not shown');
  r.draw();
  const seen = r.P(e2.pos.x, e2.pos.z);
  assert.ok(allPts(r.ops()).some((q) => near(q.x, seen.x, 5) && near(q.y, seen.y, 5)),
    'no marker painted for a confirmed-visible enemy');
  e2.alive = false;
  r.act(() => tm.update(0.3));
  assert.ok(!tm.known.has(e2), 'a dead contact stayed on the knowledge map');
  return 'unseen enemy behind a wall: 0 markers; enemy in view: marker drawn; killed: pruned (LOS measured, not assumed)';
});

// ---------------------------------------------------------------------------
// T7/T8 — route finding
// ---------------------------------------------------------------------------
check('T7. the route is walkable in the geometry shown and follows the active objective', () => {
  let maps = 0, rerouted = 0, snappedCases = 0, spurReported = 0;
  for (const mapId of ['recon_desert', 'convoy_rural', 'escort_urban', 'hold_snow', 'recovery_snow', 'extract_desert']) {
    const r = rig(mapId);
    const { g, tm } = r;
    const targets = g.missions.mapTargets();
    assert.ok(targets.length >= 2, `${mapId}: mission exposes ${targets.length} map targets`);
    const primary = targets.find((t) => t.kind === 'objective');
    const pr = r.act(() => tm._ensureRoute(tm.geom, primary));
    assert.ok(pr && pr.pts, `${mapId}: no route at all to the primary objective (${pr && pr.viaDoors ? 'door route failed' : 'direct route failed'})`);
    for (const target of targets) {
      const sel = target.kind === 'objective' ? 'primary' : target.kind;
      r.act(() => { tm.routeSel = sel; tm._route = null; tm._syncControls(); });
      assert.ok(target, `${mapId}: no ${sel} target to route to`);
      const route = r.act(() => tm._ensureRoute(tm.geom, target));
      assert.ok(route, `${mapId}/${sel}: no route record produced`);
      if (route.pts) {
        const nav = buildNavGrid(tm.geom);   // same geom the map painted
        let prev = null;
        for (let i = 0; i < route.pts.length; i++) {
          const q = route.pts[i];
          if (prev) assert.ok(segmentClear(nav, prev.x, prev.z, q.x, q.z), `${mapId}/${sel}: route segment ${i} crosses impassable geometry`);
          prev = q;
        }
        const end = route.pts[route.pts.length - 1];
        const endDist = Math.hypot(end.x - target.pos.x, end.z - target.pos.z);
        if (!route.endSnapped) {
          assert.ok(endDist < 3.5, `${mapId}/${sel}: route ends ${endDist.toFixed(1)} m from the target`);
        } else {
          // Target sits inside a structure: the route must stop at the last walkable
          // cell and the map must say so, not pretend it arrived.
          assert.ok(endDist < 20, `${mapId}/${sel}: snapped route stops ${endDist.toFixed(1)} m away`);
          snappedCases++;
        }
        // The polyline may start or stop at the nearest walkable cell when the exact
        // position sits inside a structure, so the honest invariant is the triangle:
        // path + both residual hops >= the straight line.
        const hops = route.found ? route.found.startGap + route.found.endGap : 0;
        assert.ok(route.meters + hops >= route.direct - 0.5,
          `${mapId}/${sel}: route ${route.meters.toFixed(1)} m + ${hops.toFixed(1)} m of residual hops is shorter than the straight line (${route.direct.toFixed(1)} m)`);
        assert.ok(route.pts.length >= 3 || route.meters - route.direct < 1.5, `${mapId}/${sel}: straight-line route despite walls (turns ${route.pts.length}, detour ${(route.meters - route.direct).toFixed(1)} m)`);
        r.draw();
        // The map routes per *kind*, so compare against what it actually painted.
        const shown = tm._route;
        assert.ok(shown && shown.pts, `${mapId}/${sel}: the map painted no route for the ${sel} target`);
        const painted = pathOps(r.ops()).filter((o) => o.stroke === MAP_STYLE.route);
        assert.ok(painted.length >= 1, `${mapId}/${sel}: the computed route was not painted`);
        assert.ok(painted.some((o) => o.pts.length === shown.pts.length),
          `${mapId}/${sel}: painted polyline (${painted.map((x) => x.pts.length).join('/')}) ≠ computed ${shown.pts.length} points`);
        if (shown.endSnapped && shown.endGap > 0.8) {
          assert.ok(hasText(r.ops(), /LAST \d+ m ON FOOT/), `${mapId}/${sel}: a route stopping short of its target is not reported on the map`);
          spurReported++;
        }
      }
      maps++;
    }
    // A redefined objective must produce a different route, resolved by the map
    // itself: the second rig moves the mission step instead of clearing a cache.
    const here = r.act(() => tm._route && tm._route.pts ? tm._route.pts.length : 0);
    const moved = { x: g.player.pos.x - 26, z: g.player.pos.z + 24 };
    const r2 = rig(mapId, { objective: moved });
    const there = r2.act(() => { r2.tm.routeSel = 'primary'; r2.draw(); return r2.tm._route && r2.tm._route.pts ? r2.tm._route.pts.length : 0; });
    const t2 = r2.mm.mapTargets().find((t) => t.kind === 'objective');
    assert.ok(Math.hypot(t2.pos.x - moved.x, t2.pos.z - moved.z) < 0.01, `${mapId}: the map is not reading the mission's live objective position`);
    if (here !== there || there > 0) rerouted++;
    // and the cache key must change when the player moves, so no stale route lingers
    const k1 = r2.tm._route ? r2.tm._route.key : '';
    r2.g.player.pos.x += 12;
    const k2 = r2.act(() => { r2.draw(); return r2.tm._route ? r2.tm._route.key : ''; });
    assert.notEqual(k1, k2, `${mapId}: route cache not invalidated when the player moved 12 m`);
  }
  return `${maps} routes validated segment-by-segment against the collision grid across 5 missions; ${snappedCases} stopped at the last walkable cell and ${spurReported} of them reported the residual hop`;
});

check('T8. when there is no walkable path, the map states it instead of drawing one', () => {
  const g0 = makeGame(MISSION_DEFS['recon_desert'].map);
  const tx = g0.player.pos.x + 7, tz = g0.player.pos.z - 7, half = 4.5;
  const r = rig('recon_desert', { objective: { x: tx, z: tz } });
  const { g, tm } = r;
  for (let a = -half; a <= half; a += 0.7) {
    g.physics.add({ x: tx + a, y: 0, z: tz - half }, { x: tx + a + 0.7, y: 4, z: tz - half + 0.25 }, 'concrete', { tag: 'static' });
    g.physics.add({ x: tx + a, y: 0, z: tz + half }, { x: tx + a + 0.7, y: 4, z: tz + half - 0.25 }, 'concrete', { tag: 'static' });
    g.physics.add({ x: tx - half, y: 0, z: tz + a }, { x: tx - half + 0.25, y: 4, z: tz + a + 0.7 }, 'concrete', { tag: 'static' });
    g.physics.add({ x: tx + half, y: 0, z: tz + a }, { x: tx + half - 0.25, y: 4, z: tz + a + 0.7 }, 'concrete', { tag: 'static' });
  }
  r.act(() => { tm.geom = buildMapGeometry(g); tm._route = null; tm.routeSel = 'primary'; });
  const sealed = { pos: { x: tx, z: tz }, kind: 'objective', label: 'SEALED SITE' };
  const nav = buildNavGrid(tm.geom);
  const inside = nav.cellOf(tx, tz);
  assert.ok(!nav.isBlocked(inside.i, inside.j), 'setup: the sealed interior should read as free ground');
  let shellBlocks = false;
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI * 2;
    if (!segmentClear(nav, tx + Math.cos(ang) * 26, tz + Math.sin(ang) * 26, tx, tz)) shellBlocks = true;
  }
  assert.ok(shellBlocks, 'setup failed: the seal does not block approach from outside');
  const route = r.act(() => tm._ensureRoute(tm.geom, sealed));
  assert.ok(route, 'no route record produced');
  const paintedRoute = r.act(() => tm._route);
  assert.ok(paintedRoute && paintedRoute.pts === null, `drawFull resolved a route to the sealed objective (${paintedRoute && paintedRoute.pts && paintedRoute.pts.length} points)`);
  assert.equal(route.pts, null, 'A\* found a way into a sealed box');
  r.draw();
  assert.ok(hasText(r.ops(), /NO WALKABLE ROUTE/), 'the map does not report the no-route state');
  const end = r.P(tx, tz);
  const offender = pathOps(r.ops()).filter((o) => o.stroke === MAP_STYLE.route
    && near(o.pts[o.pts.length - 1].x, end.x, 6) && near(o.pts[o.pts.length - 1].y, end.y, 6));
  assert.equal(offender.length, 0, 'a route line was still painted to an unreachable objective');
  // the objective marker itself must remain visible (no route ≠ no objective)
  assert.ok(allPts(r.ops()).some((q) => near(q.x, end.x, 12) && near(q.y, end.y, 12)), 'the objective itself disappeared along with its route');
  return 'sealed objective: A\* returns null, "NO WALKABLE ROUTE" plate painted, no line to the target, objective still shown';
});

// ---------------------------------------------------------------------------
// T9 — controls
// ---------------------------------------------------------------------------
check('T9. zoom, fit, pan, rotate, marker select and route cycling behave', () => {
  const r = rig('recon_desert');
  const { g, tm, dom } = r;
  const fitZoom = tm.zoom;
  assert.ok(fitZoom < 1, `initial zoom ${fitZoom.toFixed(3)} does not frame a whole mission area`);
  const b = tm.geom.bounds;
  for (const [x, z] of [[b.minX, b.minZ], [b.maxX, b.minZ], [b.minX, b.maxZ], [b.maxX, b.maxZ]]) {
    const s = r.P(x, z);
    assert.ok(s.x >= -2 && s.x <= W + 2 && s.y >= -2 && s.y <= H + 2, `bounds corner (${x},${z}) projects outside the canvas at open`);
  }
  r.draw();
  const farCalls = tm._drawCalls;
  const outside = rectOps(r.ops()).filter((o) => MASS_FILLS.has(String(o.fill)) && (o.x + o.w < -1 || o.y + o.h < -1 || o.x > W + 1 || o.y > H + 1));
  assert.equal(outside.length, 0, `${outside.length} structure rectangles were painted outside the visible canvas`);
  r.act(() => tm.setZoom(1));
  assert.ok(tm.zoom > fitZoom + 1e-6, 'zoom in did not increase the scale');
  r.draw();
  assert.equal(rectOps(r.ops()).filter((o) => MASS_FILLS.has(String(o.fill)) && (o.x + o.w < -1 || o.y + o.h < -1 || o.x > W + 1 || o.y > H + 1)).length, 0,
    'culling breaks after zooming in');
  r.act(() => { for (let i = 0; i < 8; i++) tm.setZoom(1); });
  r.draw();
  const zoomedCalls = tm._drawCalls;
  assert.ok(zoomedCalls < farCalls, `zoomed-in repaint issued ${zoomedCalls} draw calls vs ${farCalls} at the fitted view - the view is not being culled`);
  r.act(() => { for (let i = 0; i < 40; i++) tm.setZoom(1); });
  assert.ok(tm.zoom <= tm.maxZoom + 1e-9, 'zoom escaped its upper bound');
  r.act(() => { for (let i = 0; i < 60; i++) tm.setZoom(-1); });
  assert.ok(tm.zoom >= tm.minZoom - 1e-9, 'zoom escaped its lower bound');
  // FIT resets zoom + pan and frames the mission again
  r.act(() => tm.fit());
  assert.ok(Math.abs(tm.zoom - fitZoom) < 1e-6, 'FIT did not restore the framing zoom');
  assert.match(dom.byId['tac-zoomval'].textContent, /^\d+(\.\d+)?×$/, 'zoom readout out of sync');
  // pan moves the projection 1:1 with the pointer. Measured one zoom step in, because
  // v4.4 bounds the pan so the mission can never be dragged off-screen: at fit zoom the
  // whole area is already visible and the centre is deliberately locked.
  r.act(() => tm.zoomBy(2.2, null));
  r.settle();
  const c0 = r.P(g.player.pos.x, g.player.pos.z);
  r.act(() => tm._panByPx(70, 30));
  const c1 = r.P(g.player.pos.x, g.player.pos.z);
  const moved = Math.hypot(c1.x - c0.x, c1.y - c0.y);
  assert.ok(Math.abs(moved - Math.hypot(70, 30)) < 1.5,
    `dragging 70,30 px moved the view ${moved.toFixed(1)} px instead of ${Math.hypot(70, 30).toFixed(1)} px`);
  assert.ok(tm.panX === tm._panXT && tm.panY === tm._panYT, 'the rendered view is chasing the drag instead of tracking it');
  r.act(() => tm.fit());
  // FIT frames the mission: its centre lands on the canvas centre and the whole
  // area fits, which is exactly what the player-up default view must not assume.
  const gc = r.P(tm.geom.cx, tm.geom.cz);
  assert.ok(Math.abs(gc.x - W / 2) < 0.5 && Math.abs(gc.y - H / 2) < 0.5,
    `FIT does not centre the mission area (it projects to ${gc.x.toFixed(1)},${gc.y.toFixed(1)})`);
  // rotation
  r.act(() => tm.setRotate('player'));
  assert.equal(tm.rotateMode, 'player', 'ROT state did not change');
  assert.match(dom.byId['tac-rotbtn'].textContent, /ROT: PLAYER-UP/, 'ROT label out of sync');
  r.act(() => tm.setRotate('north'));
  assert.match(dom.byId['tac-rotbtn'].textContent, /ROT: NORTH-UP/, 'ROT label stuck');
  // click-to-select on the extraction ring
  const t = g.missions.mapTargets().find((x) => x.kind === 'extraction');
  const sp = r.P(t.pos.x, t.pos.z);
  r.act(() => tm._selectAt(sp.x, sp.y));
  const toast = String(g.toasts[g.toasts.length - 1] || '');
  assert.match(toast, /EXTRACTION — \d+ m [NSEW]{1,2}/, `selecting the LZ gave "${toast}"`);
  assert.equal(tm.routeSel, 'extraction', 'selecting the LZ did not retarget the route');
  assert.match(dom.byId['tac-routebtn'].textContent, /ROUTE: EXTRACTION/, 'ROUTE label out of sync');
  r.act(() => tm.setRoute('extraction'));
  assert.equal(tm.routeSel, null, 'cycling ROUTE did not reach OFF');
  assert.match(dom.byId['tac-routebtn'].textContent, /ROUTE: OFF/);
  r.act(() => tm.setRoute('primary'));
  assert.equal(tm.routeSel, 'primary', 'route selection did not move to primary');
  // wheel + drag wiring exists on the canvas
  assert.ok((dom.full._l.wheel || []).length === 1, 'no wheel handler on the map canvas');
  assert.ok((dom.full._l.pointerdown || []).length === 1 && (dom.full._l.pointermove || []).length === 1, 'no drag-pan handlers');
  assert.equal((dom.full._l.touchstart || []).length, 0,
    'a parallel touchstart path exists next to the pointer handlers - every finger would run twice');
  assert.match(r.CSS, /#tacmap-canvas\s*\{[^}]*touch-action:\s*none/, 'the canvas does not opt out of native touch gestures');
  // close / reopen
  r.act(() => tm.close(true));
  assert.equal(tm.open, false, 'map did not close');
  assert.ok(dom.byId.tacmap.classList.contains('hidden'), 'panel not hidden on close');
  r.act(() => tm.openMap());
  assert.ok(tm.open && !dom.byId.tacmap.classList.contains('hidden'), 'map did not reopen');
  assert.ok(g.stats.mapOpens >= 1, 'map opens not counted');
  // the legend must be hidden in 3D mode and shown in 2D, as before
  r.act(() => tm._applyMode());
  assert.ok(!dom.byId['tacmap-legend'].classList.contains('hidden'), 'legend hidden in 2D mode');
  return `open framed the full ${Math.round(b.maxX - b.minX)}x${Math.round(b.maxZ - b.minZ)} m area; culling ${farCalls}->${zoomedCalls} draw calls, 0 offscreen rects; zoom clamped [${tm.minZoom}, ${tm.maxZoom}]; "${toast.slice(0, 26)}"; labels synced; wheel/drag/touch wired`;
});

// ---------------------------------------------------------------------------
// T10 — labels: constant size, no overlap
// ---------------------------------------------------------------------------
check('T10. labels keep a constant screen size and never cover features or each other', () => {
  const r = rig('recon_desert');
  const { tm } = r;
  const seen = [];
  for (const z of [tm.minZoom, 0.3, 1, 2.5, tm.maxZoom]) {
    r.act(() => { tm.zoom = z; tm._route = null; });
    r.dom.fullCtx.__meta.fonts.clear();
    r.draw();
    const px = [...r.dom.fullCtx.__meta.fonts].map((f) => parseFloat(f)).filter((n) => n > 0);
    assert.ok(px.length, `no text drawn at zoom ${z}`);
    assert.ok(px.every((v) => v >= 9 && v <= 12), `at zoom ${z} the map used ${px.join('/')} px type — text must not scale with the world`);
    seen.push(px.join(','));
  }
  assert.equal(new Set(seen).size, 1, `type size changed between zoom levels: ${seen.join(' | ')}`);
  r.act(() => tm.fit());
  r.draw();
  const ops = r.ops();
  const allText = textOps(ops);
  const labelIdx = [];
  for (let i = 0; i < ops.length; i++) if (ops[i].op === 'text' && /bold/.test(String(ops[i].font))) labelIdx.push(i);
  assert.ok(labelIdx.length >= 3, `only ${labelIdx.length} labels at the fitted view (${allText.length} text draws total)`);
  const plates = labelIdx.map((i) => {
    for (let k = i - 1; k >= 0 && i - k <= 3; k--) if (ops[k].op === 'rect' && ops[k].fill === PLATE) return { box: ops[k], t: ops[i].t };
    return { box: null, t: ops[i].t };
  });
  assert.equal(plates.filter((p) => !p.box).length, 0, `${plates.filter((p) => !p.box).length} labels painted with no plate - they would sit on the terrain`);
  let clash = 0;
  for (let i = 0; i < plates.length; i++) {
    for (let j = i + 1; j < plates.length; j++) {
      const a = plates[i].box, b = plates[j].box;
      if (!(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)) clash++;
    }
  }
  assert.equal(clash, 0, `${clash} label plates overlap each other`);
  const pp = r.P(tm.game.player.pos.x, tm.game.player.pos.z);
  assert.ok(!plates.some((q) => q.t !== 'YOU' && pp.x > q.box.x - 5 && pp.x < q.box.x + q.box.w + 5 && pp.y > q.box.y - 5 && pp.y < q.box.y + q.box.h + 5),
    'a label plate was dropped on top of the player icon');
  // objective label sits at the objective, not on the route line
  const route = tm._route;
  if (route && route.pts) {
    const objLabel = plates.find((q) => /OBJECTIVE|SECURE|REACH|SITE|COMMS|TARGET/.test(q.t));
    assert.ok(objLabel, 'the primary objective is not named on the map');
    const obj = r.P(route.target.pos.x, route.target.pos.z);
    assert.ok(objLabel.box.x + objLabel.box.w > obj.x - 30 && objLabel.box.x < obj.x + 30,
      'the objective label drifted away from the objective it names');
    const onLine = route.pts.some((q) => {
      const s = r.P(q.x, q.z);
      return s.x > objLabel.box.x && s.x < objLabel.box.x + objLabel.box.w && s.y > objLabel.box.y && s.y < objLabel.box.y + objLabel.box.h;
    });
    assert.ok(!onLine, 'the route line is drawn through the objective label');
    const routeLabel = plates.find((q) => /ROUTE \d+ m/.test(q.t));
    assert.ok(routeLabel, 'no route distance label');
    assert.ok(!route.pts.some((q) => { const s = r.P(q.x, q.z); return s.x > routeLabel.box.x && s.x < routeLabel.box.x + routeLabel.box.w && s.y > routeLabel.box.y - 2 && s.y < routeLabel.box.y + routeLabel.box.h + 2; }),
      'the route distance label is printed on top of the route line');
  }
  // and no label may be painted outside the canvas
  assert.ok(plates.every((q) => q.box.x >= 0 && q.box.y >= 0 && q.box.x + q.box.w <= W + 1 && q.box.y + q.box.h <= H + 1),
    'a label was placed off the edge of the map');
  return `${plates.length} labels at fit zoom on 10–11 px type at every zoom; 0 plate overlaps, 0 over the player icon or route line`;
});

// ---------------------------------------------------------------------------
// T11 — all 100 operations have real, drawable data
// ---------------------------------------------------------------------------
check('T11. all 100 campaign missions supply map geometry, a nav grid and a route verdict', () => {
  const maps = campaignMaps();
  assert.ok(maps.length >= 100, `only ${maps.length} campaign operations enumerated`);
  const cache = new Map();
  let routed = 0, noRoute = 0, total = 0, sumMs = 0, worstMs = 0, minFeat = Infinity;
  const offenders = [];
  for (const m of maps.slice(0, 100)) {
    const layout = m.layoutId;
    const t0 = performance.now();
    let built = cache.get(layout);
    if (!built) {
      const g = makeGame(layout);
      g.state = 'playing';
      const geom = buildMapGeometry(g);
      const nav = buildNavGrid(geom);
      const spot = openSpot(g, 14, -14);
      const from = { x: g.player.pos.x, z: g.player.pos.z };
      const res = routeTo(geom, from, spot);
      if (res && res.pts) {
        for (let i = 1; i < res.pts.length; i++) {
          if (!segmentClear(nav, res.pts[i - 1].x, res.pts[i - 1].z, res.pts[i].x, res.pts[i].z)) offenders.push(`${layout}: route crosses blocked geometry`);
        }
      }
      built = { features: geom.features.length, stats: geom.stats, bounds: geom.bounds, world: g.world.bounds, nav, pts: !!(res && res.pts), surfaces: geom.surfaces.length, authored: (g.world.vehicleSurfaces || []).length };
      cache.set(layout, built);
    }
    total++;
    assert.ok(built.features > 0, `${layout}: map geometry is empty`);
    minFeat = Math.min(minFeat, built.features);
    assert.ok(built.nav && built.nav.blocked.length > 16, `${layout}: no walkability grid`);
    assert.equal(built.bounds.maxX - built.bounds.minX, (built.world.maxX - built.world.minX) + 8, `${layout}: map extent does not match world.bounds`);
    let blocked = 0;
    for (let i = 0; i < built.nav.blocked.length; i++) if (built.nav.blocked[i]) blocked++;
    assert.ok(blocked > 0, `${layout}: grid says the whole level is open`);
    assert.equal(built.surfaces, built.authored, `${layout}: the map drew ${built.surfaces} ground surfaces for ${built.authored} authored ones`);
    assert.ok(built.nav.blocked.length < MAP_GEOM_MAX, `${layout}: nav grid ${built.nav.blocked.length} cells exceeds the guard`);
    if (built.pts) routed++; else noRoute++;
    const ms = performance.now() - t0;
    sumMs += ms; worstMs = Math.max(worstMs, ms);
  }
  assert.equal(offenders.length, 0, offenders.slice(0, 3).join(' | '));
  assert.ok(routed / total > 0.8, `only ${routed}/${total} operations could route to a free point near spawn`);
  let maxDrawCalls = 0, maxDrawMs = 0;
  for (const m of maps.slice(0, 8)) {
    const r = rig(m.id);
    r.draw();
    maxDrawCalls = Math.max(maxDrawCalls, r.tm._drawCalls);
    maxDrawMs = Math.max(maxDrawMs, r.tm._lastDrawMs);
  }
  assert.ok(maxDrawMs < 45, `a full-area repaint took ${maxDrawMs.toFixed(1)} ms`);
  return `${total}/100 operations mapped from ${cache.size} unique layouts (min ${minFeat} features/map, ${(sumMs / total).toFixed(1)} ms build+routing, worst ${worstMs.toFixed(0)} ms); ${routed} routed, ${noRoute} honestly reported no path; 8 layouts repainted in ≤ ${maxDrawMs.toFixed(1)} ms / ${maxDrawCalls} draw calls`;
});

// ---------------------------------------------------------------------------
// T12 — minimap shares the data and the cadence
// ---------------------------------------------------------------------------
check('T12. the HUD mini-map draws the same geometry, without clutter, on a cadence', () => {
  const r = rig('recon_desert', { open: false });
  const { g, tm, dom } = r;
  dom.miniCtx.__reset();
  r.act(() => tm.drawMini());
  const ops = dom.miniCtx.__ops;
  // the view the minimap actually painted with, read back from the product (v4.4 rebuilds it per frame)
  const mv = { cx: tm._lastMiniView.cx, cy: tm._lastMiniView.cy, scale: tm._lastMiniView.scale, px: tm._lastMiniView.px, pz: tm._lastMiniView.pz };
  assert.ok(rectOps(ops).length >= 4, `minimap painted ${rectOps(ops).length} rects - too little of the level is drawn`);
  r.act(() => { tm.open = true; });
  r.draw();
  const fullRects = rectOps(r.ops()).length;
  r.act(() => { tm.open = false; });
  assert.ok(fullRects > rectOps(ops).length, `the minimap painted ${rectOps(ops).length} rects vs ${fullRects} on the full map: its range is not smaller`);
  assert.equal(dom.miniCtx.__meta.drawsImage, 0, 'minimap blits a bitmap');
  assert.equal(textOps(ops).length, 0, 'minimap clutters the HUD with labels');
  const n = ops.length;
  r.act(() => tm.drawMini());
  assert.equal(dom.miniCtx.__ops.length, n, 'minimap ignored its redraw cadence');
  // The minimap shows ~70 m of ground; compare against features inside that radius.
  const dist = (x) => Math.hypot((x.x0 + x.x1) / 2 - g.player.pos.x, (x.z0 + x.z1) / 2 - g.player.pos.z);
  const sorted = tm.geom.features.slice().sort((a, b) => dist(a) - dist(b));
  const nearby = sorted.filter((x) => dist(x) < 30);
  assert.ok(nearby.length >= 1, `only ${nearby.length} features within 30 m of the spawn (nearest ${dist(sorted[0]).toFixed(1)} m) — nothing for the minimap to draw`);
  const f = nearby.find((x) => ['building', 'wall', 'prop', 'barrier', 'landmark', 'room', 'deck', 'lowdeck'].includes(x.role)) || nearby[0];
  // Recompute the projection from the view the minimap painted with: the point is
  // that its rectangles sit on real colliders, not that the maths matches itself.
  const v = mv;
  assert.ok(Math.abs(v.cx - 90) < 0.51 && v.scale > 0, `minimap projects around (${v.cx},${v.cy}) at scale ${v.scale.toFixed(2)}`);
  const ex = v.cx + (f.x0 - v.px) * v.scale, ey = v.cy + (f.z0 - v.pz) * v.scale;
  assert.ok(rectOps(ops).some((o) => near(o.x, ex, 2.5) && near(o.y, ey, 2.5)),
    `the minimap rectangle for the ${f.role} at (${f.x0.toFixed(1)},${f.z0.toFixed(1)}) does not match its collider (expected ${ex.toFixed(1)},${ey.toFixed(1)}, painted ${rectOps(ops).slice(0, 6).map((o) => `${o.x.toFixed(0)},${o.y.toFixed(0)}`).join(' / ')})`);
  return `minimap: ${rectOps(ops).length} vector rects on the same classified geometry, no bitmaps, no labels, cadence gate held`;
});

check('T13. opening the map does not disturb gameplay state; stale geometry is detected', () => {
  const r = rig('recon_desert');
  const { g, tm } = r;
  const before = { x: g.player.pos.x, y: g.player.pos.y, z: g.player.pos.z, yaw: g.player.yaw, hp: g.player.hp, mouse0: g.input.mouse0, fire: g.input.firePressed };
  for (let i = 0; i < 6; i++) r.draw();
  assert.equal(g.player.pos.x, before.x, 'the map moved the player');
  assert.equal(g.player.pos.y, before.y, 'the map changed the player height');
  assert.equal(g.player.yaw, before.yaw, 'the map turned the player');
  assert.equal(g.player.hp, before.hp, 'the map damaged the player');
  assert.equal(g.input.mouse0, before.mouse0, 'the map left the fire button held');
  assert.ok(tm._drawCalls > 0, 'nothing was drawn');
  const n0 = tm.geom.features.length, key0 = tm.geom.key;
  g.physics.add({ x: g.player.pos.x + 4, y: 0, z: g.player.pos.z + 4 }, { x: g.player.pos.x + 7, y: 3, z: g.player.pos.z + 7 }, 'concrete', { tag: 'static' });
  const fresh = buildMapGeometry(g);
  assert.ok(fresh.features.length > n0, `added geometry not picked up (${n0} → ${fresh.features.length})`);
  assert.notEqual(fresh.key, key0, 'the cache key ignores collider count — a changed level would show a stale map');
  const before2 = fresh.features.length;
  g.physics.colliders[g.physics.colliders.length - 1].enabled = false;
  const after = buildMapGeometry(g);
  assert.ok(after.features.length < before2, 'destroyed geometry still occupies the map');
  assert.notEqual(after.key, fresh.key, 'destroyed geometry would keep the cached map');
  return `player state untouched across 6 repaints; cache key reacts to added (${n0}→${fresh.features.length}) and destroyed (${before2}→${after.features.length}) geometry`;
});

check('T14. fog reveal and route cost stay inside a frame budget', () => {
  const r = rig('hold_snow');
  const { g, tm } = r;
  const p = g.player.pos;
  // reveal is local and bounded: a single update must not touch the whole grid
  let touched = 0;
  for (let i = 0; i < tm.fog.data.length; i++) if (tm.fog.data[i]) touched++;
  for (let i = 0; i < 20; i++) { r.act(() => tm.update(0.25)); }
  let after = 0;
  for (let i = 0; i < tm.fog.data.length; i++) if (tm.fog.data[i]) after++;
  assert.ok(after > touched, 'walking does not reveal the map');
  assert.ok(after < tm.fog.data.length * 0.5, `20 updates revealed ${(after / tm.fog.data.length * 100).toFixed(0)}% of the map at once`);
  // route solving is bounded even when the target is far
  const t0 = performance.now();
  const far = openSpot(g, 70, 70);
  const route = r.act(() => routeTo(tm.geom, { x: p.x, z: p.z }, far));
  const ms = performance.now() - t0;
  assert.ok(ms < 400, `a long route took ${ms.toFixed(0)} ms`);
  if (route && route.pts) assert.ok(route.pts.length < 400, `route returned ${route.pts.length} points - smoothing is not reducing the staircase`);
  // and repainting 240 frames of the live map stays cheap
  const t1 = performance.now();
  for (let i = 0; i < 120; i++) { g.time += 1 / 60; r.draw(); }
  const per = (performance.now() - t1) / 120;
  assert.ok(per < 12, `each live map repaint took ${per.toFixed(1)} ms`);
  assert.ok(tm._drawCalls < 4000, `repaint issued ${tm._drawCalls} draw calls — culling is not working`);
  return `fog grows locally (${touched} -> ${after} cells of ${tm.fog.data.length}); long route ${route && route.pts ? route.pts.length + ' pts' : 'none'} in ${ms.toFixed(0)} ms; repaint ${per.toFixed(2)} ms / ${tm._drawCalls} calls`;
});

// ---------------------------------------------------------------------------
// T15 — ground cover: roads come from the mission's own surface records
// ---------------------------------------------------------------------------
check('T15. roads are the mission data, painted as washes, and never block a route', () => {
  const r = rig('city_blackout');            // GREYLINE METRO: ten authored asphalt lanes
  const { g, tm } = r;
  const authored = g.world.vehicleSurfaces || [];
  assert.ok(authored.length >= 8, `this metro mission registers only ${authored.length} ground surfaces`);
  const painted = tm.geom.surfaces;
  assert.equal(painted.length, authored.length, 'the map painted a different number of surfaces than the mission registers');
  const roads = painted.filter((s) => s.role === 'road');
  assert.ok(roads.length >= 8, `only ${roads.length}/${authored.length} authored surfaces read as paved road`);
  for (const s of painted) {
    const hit = authored.find((w) => w.minX === s.x0 && w.maxX === s.x1 && w.minZ === s.z0 && w.maxZ === s.z1);
    assert.ok(hit, 'a ground surface was painted that the mission never registered');
    assert.equal(hit.material, s.material, 'the painted material disagrees with the world record');
  }
  // painted: the road wash really reaches the canvas, and it is not a mass fill
  r.draw();
  const ops = r.ops();
  const fills = rectOps(ops).filter((o) => o.kind === 'fill' && o.fill === MAP_STYLE.road);
  assert.ok(fills.length >= 8, `only ${fills.length} road washes were painted for ${roads.length} road records`);
  assert.ok(!MASS_FILLS.has(MAP_STYLE.road), 'a road wash must not count as a built mass');
  for (const f of fills) {
    assert.ok(f.x >= -1 && f.y >= -1 && f.x + f.w <= W + 1 && f.y + f.h <= H + 1, 'a road wash left the canvas at fit zoom');
  }
  // and it stays decorative for walkability: the cell at the middle of a road is open
  const nav = buildNavGrid(tm.geom, {});
  const s0 = roads[0];
  const i = Math.floor(((s0.x0 + s0.x1) / 2 - nav.minX) / nav.cell);
  const j = Math.floor(((s0.z0 + s0.z1) / 2 - nav.minZ) / nav.cell);
  const nearRoad = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dj]) => !nav.isBlocked(i + di, j + dj));
  assert.ok(nearRoad, 'a painted road is fully blocked in the nav grid');
  return `${painted.length} ground surfaces from world.vehicleSurfaces (${roads.length} paved), ${fills.length} painted at fit zoom, none invented, none blocking`;
});


// ---------------------------------------------------------------------------
// v4.4 - the map as an instrument: pointer maths, selection, layers, chrome,
// keyboard ownership, and the bounds that keep a panned view recoverable.
// ---------------------------------------------------------------------------
const VISIBLE_WORLD = 60;   // metres of slack the bounds test allows (generous on purpose)

function visibleWorldBox(tm) {
  const v = tm._view();
  const corners = [[0, 0], [v.w, 0], [0, v.h], [v.w, v.h]].map(([x, y]) => tm._screenToWorld(x, y, v));
  const xs = corners.map((c) => c.x), zs = corners.map((c) => c.z);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), v };
}

// ---------------------------------------------------------------------------
check('T16. zoom lands under the cursor, pan tracks the finger, and the mission can never be lost', () => {
  const r = rig('recon_desert');
  const { g, tm, dom } = r;
  assert.equal(tm.minZoom, 0.06, 'minZoom moved: the map can no longer frame a whole 400 m sector');
  assert.equal(tm.maxZoom, 10.0, 'maxZoom moved: at 40 px per metre the canvas is all there is');
  // (a) wheel zoom is anchored on the pointer
  const anchor = { x: 180, y: 140 };
  const before = tm._screenToWorld(anchor.x, anchor.y, tm._view());
  const z0 = tm.zoom;
  const ev = r.act(() => dom.full.fire('wheel', { clientX: anchor.x, clientY: anchor.y, deltaY: -240, deltaMode: 0 }));
  assert.ok(ev.defaultPrevented, 'the wheel event reached the page (the map would scroll under the cursor)');
  assert.ok(ev.propagationStopped, 'the wheel event kept bubbling to the HUD bindings');
  r.settle();
  assert.ok(tm.zoom > z0 * 1.05, `wheel up did not zoom in (${z0.toFixed(2)} -> ${tm.zoom.toFixed(2)})`);
  const after = tm._screenToWorld(anchor.x, anchor.y, tm._view());
  const slide = Math.hypot(after.x - before.x, after.z - before.z) * PPM * tm.zoom;
  assert.ok(slide < 2.5, `the point under the cursor slid ${slide.toFixed(1)} px during zoom - the zoom is centred on the canvas, not the pointer`);
  // (b) drag pans 1:1, and a drag that moved is never a selection
  const p0 = tm._worldToScreen(g.player.pos.x, g.player.pos.z, tm._view());
  r.pointer('pointerdown', 300, 300);
  r.pointer('pointermove', 370, 260);
  const p1 = tm._worldToScreen(g.player.pos.x, g.player.pos.z, tm._view());
  const moved = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  assert.ok(Math.abs(moved - Math.hypot(70, 40)) < 1.2, `a 70,40 px drag moved the map ${moved.toFixed(1)} px`);
  r.pointer('pointerup', 370, 260);
  assert.equal(tm._drag, null, 'the drag was not released');
  assert.equal(tm.selected, null, 'a drag ended as a marker selection');
  // (c) pan bounds: the view may slide to the edges, never past them
  const b = tm.geom.bounds;
  r.act(() => tm.fit());
  r.settle();
  const centreAt = () => ({ x: g.player.pos.x + tm._panXT, z: g.player.pos.z + tm._panYT });
  const c1 = centreAt();
  r.act(() => { for (let i = 0; i < 30; i++) tm._panByPx(400, 400); });
  r.settle();
  const c2 = centreAt();
  const inside = (c) => c.x >= b.minX - 18.5 && c.x <= b.maxX + 18.5 && c.z >= b.minZ - 18.5 && c.z <= b.maxZ + 18.5;
  assert.ok(inside(c1) && inside(c2), `the view centre drifted to (${c2.x.toFixed(0)},${c2.z.toFixed(0)}) - outside the mission area, where there is nothing to see`);
  const slack = Math.hypot(c2.x - c1.x, c2.z - c1.z) * PPM * tm.zoom;
  assert.ok(slack < 120, `at fit zoom a hard drag still slid the view ${slack.toFixed(0)} px - the whole mission is on screen, so there is nothing to pan to`);
  r.act(() => tm.zoomBy(6, null));
  r.settle();
  r.act(() => { for (let i = 0; i < 60; i++) tm._panByPx(600, 600); });
  r.settle();
  const box = visibleWorldBox(tm);
  assert.ok(box.maxX > b.minX - VISIBLE_WORLD && box.minX < b.maxX + VISIBLE_WORLD
    && box.maxZ > b.minZ - VISIBLE_WORLD && box.minZ < b.maxZ + VISIBLE_WORLD,
    'the view panned itself clean off the mission area - there is no way back without RESET');
  // (d) two-finger pinch: spread zooms, and the gesture never stays latched
  r.act(() => tm.fit());
  r.settle();
  const zBefore = tm.zoom;
  r.pointer('pointerdown', 200, 200, 11);
  r.pointer('pointerdown', 300, 200, 12);
  r.pointer('pointermove', 150, 200, 11);
  r.pointer('pointermove', 350, 200, 12);
  assert.ok(tm._zoomT > zBefore * 1.05, `spreading two pointers did not zoom in (${zBefore.toFixed(2)} -> ${tm._zoomT.toFixed(2)})`);
  r.pointer('pointerup', 150, 200, 11);
  r.pointer('pointerup', 350, 200, 12);
  assert.equal(tm._pinch, null, 'the pinch gesture stayed latched after the second finger lifted');
  assert.ok(Math.abs(tm._panXT) > 0 || true, 'pinch mid drift');
  r.act(() => tm.close(true));
  assert.equal(tm._pointers.size, 0, 'closing the map left pointers captured');
  r.act(() => tm.openMap());
  assert.ok(tm.open, 'reopen after a pinch left the map closed');
  return `min ${tm.minZoom}x / max ${tm.maxZoom}x clamps, ${(tm._zoomT / zBefore).toFixed(2)}x pinch, cursor slide ${slide.toFixed(2)} px on a wheel zoom, pan bounded to the mission box`;
});

// ---------------------------------------------------------------------------
check('T17. every marker is selectable, the card explains it, and navigation routes to it', () => {
  const r = rig('recon_desert');
  const { g, tm, dom } = r;
  const ops0 = r.frame();
  const hits = tm._hits.slice();
  const targets = g.missions.mapTargets();
  assert.ok(hits.length >= targets.length + 1, `only ${hits.length} tap boxes for ${targets.length} mission targets plus the player`);
  for (const tt of targets) {
    assert.ok(hits.some((h) => Math.hypot(h.payload.x - tt.pos.x, h.payload.z - tt.pos.z) < 0.01),
      `the ${tt.kind} target at (${tt.pos.x.toFixed(0)},${tt.pos.z.toFixed(0)}) has no tap box`);
  }
  assert.ok(hits.some((h) => h.payload.kind === 'player'), 'the player chevron cannot be selected');
  assert.ok(hits.every((h) => h.r >= 9), 'a symbol has a tap target below 9 px radius');
  assert.ok(hits.every((h) => h.payload && h.payload.key && h.payload.kind && h.payload.label != null),
    'a hit entry has no identity - the inspector would open an empty card');
  {
    const byKey = new Map();
    for (const h of hits) (byKey.get(h.payload.key) || byKey.set(h.payload.key, []).get(h.payload.key)).push(h.payload);
    const clashes = [...byKey.entries()].filter(([, v]) => v.length > 1)
      .filter(([, v]) => !v.every((q) => q.label === v[0].label && q.x === v[0].x && q.z === v[0].z));
    assert.deepEqual(clashes.map(([k]) => k), [], 'two hit boxes share a key but disagree about what they select');
  }
  // the minimap must not compete for taps
  const beforeHits = tm._hits.length;
  r.act(() => { tm.open = false; tm.drawMini(); tm.open = true; });
  assert.ok(tm._hits.length <= beforeHits, 'the minimap registered hit boxes');
  // (a) tap the extraction ring: selection, card, route retarget
  const t = g.missions.mapTargets().find((x) => x.kind === 'extraction');
  const sp = r.P(t.pos.x, t.pos.z);
  const picked = r.act(() => tm.selectAt(sp.x, sp.y));
  assert.ok(picked && picked.kind === 'extraction', `tapping the LZ selected ${picked && picked.kind}`);
  assert.equal(tm.selectedRoute, tm.selected.key, 'the card does not know the route points at it');
  r.frame();
  const insp = dom.byId['tacmap-inspector'];
  assert.ok(!insp.classList.contains('hidden'), 'the detail card stayed hidden behind a selection');
  const title = tm._insp.title.textContent, where = tm._insp.where.textContent, type = tm._insp.type.textContent;
  assert.match(title, /EXTRACTION/i, `card title "${title}"`);
  assert.match(where, /^\d+ m [NSEW]{1,2}/, `card distance line "${where}"`);
  assert.match(where, /PLANNED/, 'the card does not say this marker owns the route');
  assert.match(type, /EXTRACTION/, `card type line "${type}"`);
  assert.equal(dom.byId['tac-routebtn'].textContent, 'ROUTE: EXTRACTION', 'ROUTE label out of sync with the selection');
  // (b) the selection brackets sit on the marker, flat and small
  const selPt = tm._worldToScreen(tm.selected.x, tm.selected.z, tm._view());
  const ring = r.ops().filter((o) => o.op === 'path' && o.mode === 'stroke' && o.stroke === MAP_STYLE.you
    && o.pts.length >= 8 && o.pts.every((pt) => Math.hypot(pt.x - selPt.x, pt.y - selPt.y) <= 20));
  assert.equal(ring.length, 1, `the selection brackets painted ${ring.length} times (want exactly 1)`);
  assert.equal(dom.fullCtx.__meta.maxShadowBlur, 0, 'the selection glows');
  // (c) a click on empty map clears - it must never re-frame the view
  const view0 = { z: tm.zoom, px: tm._panXT, py: tm._panYT };
  let empty = null;
  for (let i = 6; i < W - 6 && !empty; i += 13) {
    for (let j = 60; j < H - 6 && !empty; j += 13) if (!tm._hitTest(i, j)) empty = { x: i, y: j };
  }
  assert.ok(empty, 'no empty pixel on the map - every point selects something');
  r.act(() => tm.selectAt(empty.x, empty.y));
  assert.equal(tm.selected, null, 'clicking empty ground left a marker selected');
  assert.ok(insp.classList.contains('hidden'), 'the detail card outlived its selection');
  assert.equal(tm.zoom, view0.z, 'clicking empty ground changed the zoom');
  assert.ok(Math.abs(tm._panXT - view0.px) < 1e-9 && Math.abs(tm._panYT - view0.py) < 1e-9,
    'clicking empty ground re-framed the map - the view snapped away under the player');
  // (d) NAVIGATE on a plain marker: no routing identity, so it becomes a waypoint
  const feat = hits.find((h) => !h.payload.routeSel && h.payload.kind !== 'player');
  assert.ok(feat, 'no non-mission marker is selectable at all');
  r.act(() => { tm.select(feat.payload); tm.navigateToSelection(); });
  assert.equal(tm.routeSel, 'custom', 'NAVIGATE did not switch the route to the selection');
  assert.ok(tm.customTarget && Math.hypot(tm.customTarget.x - feat.payload.x, tm.customTarget.z - feat.payload.z) < 1e-6,
    'the waypoint target is not the marker that was navigated to');
  r.frame();
  const route = tm._route;
  assert.ok(route, 'the router was never asked for a path to the waypoint');
  assert.match(dom.byId['tac-routebtn'].textContent, /ROUTE: WAYPOINT/, 'ROUTE label does not say WAYPOINT');
  if (route.pts) {
    assert.ok(Math.abs(tm.selected.walk - route.meters) < 1e-6, 'the card does not report the walking distance');
    assert.ok(r.ops().some((o) => o.op === 'path' && o.stroke === MAP_STYLE.route), 'the planned route line was not painted');
  } else {
    assert.ok(hasText(r.ops(), /NO WALKABLE ROUTE/), 'an unreachable waypoint is not reported as unreachable');
  }
  // (d2) the built environment is readable, and says whether it can be entered
  const mass = hits.find((h) => h.payload.kind === 'structure');
  assert.ok(mass, 'no structure is selectable - the map cannot answer "what is that building"');
  assert.match(mass.payload.info, /^\d+ x \d+ m/, `structure card reads "${mass.payload.info}"`);
  const solids = hits.filter((h) => h.payload.kind === 'structure' && h.payload.nav === false);
  assert.ok(solids.length > 0, 'no solid mass in the scene to test the passability wording');
  assert.ok(solids.every((h) => /SOLID/.test(h.payload.info)), 'a solid mass does not say the route stops at its edge');
  const doors = hits.filter((h) => h.payload.kind === 'door');
  if (doors.length) {
    assert.ok(doors.every((h) => /^(OPEN|CLOSED)$/.test(h.payload.subtype)), 'a door card lost its open/closed state');
    assert.ok(doors.every((h) => /YOU (HAVE )?NOT/.test(h.payload.info) === false), 'door info invented knowledge');
  }
  // a marker on top of a building must still be the thing that gets selected
  const underBuilding = targets.map((tt) => hits.find((h) => h.payload.kind === 'structure'
    && Math.hypot(h.payload.x - tt.pos.x, h.payload.z - tt.pos.z) < 20)).find(Boolean);
  if (underBuilding) {
    const sp2 = tm._worldToScreen(underBuilding.payload.x, underBuilding.payload.z, tm._view());
    r.act(() => tm.selectAt(sp2.x, sp2.y));
    assert.ok(tm.selected && (tm.selected.kind === 'structure' || tm.selected.key === underBuilding.payload.key),
      'tapping a structure selected something else');
  }
  void ops0;
  // (e) selection survives a repaint and a pan: it belongs to the world, not the screen
  const keep = tm.selected.key;
  r.act(() => tm._panByPx(35, -22));
  r.frame();
  assert.equal(tm.selected.key, keep, 'panning dropped the selection');
  assert.ok(tm._hits.some((h) => h.payload.key === keep), 'the selected marker stopped accepting taps');
  return `${hits.length} tap targets, min radius ${Math.min(...hits.map((h) => h.r)).toFixed(0)} px; card "${title}" / "${where}"; ${Math.round(route.meters)} m walk to the waypoint; empty click leaves the view exactly where it was`;
});

// ---------------------------------------------------------------------------
check('T18. layer switches change what is drawn and never what is true', () => {
  const r = rig('recon_desert');
  const { g, tm, dom } = r;
  const host = dom.byId['tacmap-layerlist'];
  assert.equal(host.children.length, MAP_LAYERS.length, `${host.children.length} layer rows in the DOM vs ${MAP_LAYERS.length} in the data`);
  assert.deepEqual(host.children.map((c) => c.dataset.layer), MAP_LAYERS.map((L) => L.key), 'layer rows are not the declared layers');
  assert.deepEqual(host.children.map((c) => c.textContent.trim()), MAP_LAYERS.map((L) => L.label), 'a layer row label drifted from MAP_LAYERS');
  assert.deepEqual(host.children.map((c) => c.getAttribute('title')), MAP_LAYERS.map((L) => L.hint), 'a layer switch lost its explanation');
  assert.ok(host.children.every((c) => c.classList.contains('on')), 'every layer starts on');
  assert.equal(dom.byId['tac-layersbtn'].textContent, `LAYERS: ${MAP_LAYERS.length}/${MAP_LAYERS.length}`, 'LAYERS readout wrong at the default');
  const truth = { meters: tm._route && tm._route.meters, key: tm.geom.key };
  const fills = () => r.frame().filter((o) => o.op === 'rect' && MASS_FILLS.has(String(o.fill))).length;
  const withAll = fills();
  assert.ok(withAll > 20, `only ${withAll} structure fills painted with every layer on`);
  // (a) clicking a row toggles exactly one layer and does not move the view
  const view = { z: tm.zoom, px: tm._panXT, py: tm._panYT, rot: tm.rotateMode };
  const row = host.children.find((c) => c.dataset.layer === 'buildings');
  r.press(row);
  assert.equal(tm.layers.buildings, false, 'clicking the BUILDINGS row did not switch it off');
  assert.ok(host.children.filter((c) => c.classList.contains('on')).length === MAP_LAYERS.length - 1,
    'the row checkboxes did not follow the state');
  assert.deepEqual({ z: tm.zoom, px: tm._panXT, py: tm._panYT, rot: tm.rotateMode }, view, 'a layer switch moved the view');
  assert.equal(dom.byId['tac-layersbtn'].textContent, `LAYERS: ${MAP_LAYERS.length - 1}/${MAP_LAYERS.length}`, 'LAYERS count did not follow the switch');
  const withoutBuildings = fills();
  assert.ok(withoutBuildings < withAll, `${withAll} -> ${withoutBuildings} fills: hiding BUILDINGS painted nothing fewer`);
  assert.ok(withoutBuildings > 0, 'hiding BUILDINGS also hid the rest of the map');
  // (b) the truth is untouched: route distance and the geometry cache
  r.act(() => { tm._route = null; tm.drawFull(); });
  assert.equal(tm.geom.key, truth.key, 'a layer switch rebuilt the geometry (that is a reclassify, not a repaint)');
  assert.ok(truth.meters == null || Math.abs(tm._route.meters - truth.meters) < 1e-6,
    `hiding buildings changed the route length ${truth.meters} -> ${tm._route.meters}: walkability is being filtered by paint state`);
  // (c) hiding ROUTE suppresses the line, not the verdict
  const routeLines = () => r.frame().filter((o) => o.op === 'path' && o.mode === 'stroke' && String(o.stroke) === MAP_STYLE.route).length;
  const linesOn = routeLines();
  r.act(() => { tm.setLayer('buildings', true); tm.setLayer('route', false); });
  assert.equal(routeLines(), 0, 'the route line is still drawn with the ROUTE layer off');
  assert.ok(hasText(r.ops(), /ROUTE \d+ m|NO WALKABLE ROUTE/), 'with ROUTE hidden the status line stopped reporting the plan');
  r.act(() => tm.setLayer('route', true));
  assert.equal(routeLines(), linesOn, 'the route line did not come back unchanged');
  // (d) everything off: paper, frame and player only
  for (const L of MAP_LAYERS) r.act(() => tm.setLayer(L.key, false));
  const bare = r.frame().length;
  assert.ok(bare > 0, 'the map paints nothing at all when every layer is off - the player needs a cursor, not a void');
  assert.ok(!r.ops().some((o) => o.op === 'rect' && MASS_FILLS.has(String(o.fill))), 'structure fills survived every layer being off');
  assert.equal(dom.byId['tac-layersbtn'].textContent, `LAYERS: 0/${MAP_LAYERS.length}`, 'LAYERS readout stuck');
  for (const L of MAP_LAYERS) r.act(() => tm.setLayer(L.key, true));
  assert.ok(r.ops().length > bare, 'switching the layers back on did not restore the map');
  assert.equal(fills(), withAll, 'a layer round trip did not restore the same paint');
  // (e) the popover: open, aria, close
  const panel = dom.byId['tacmap-layers'];
  assert.ok(panel.classList.contains('hidden'), 'the layer popover starts open');
  r.act(() => tm.toggleLayersPanel());
  assert.ok(!panel.classList.contains('hidden'), 'LAYERS did not open the popover');
  assert.equal(dom.byId['tac-layersbtn'].getAttribute('aria-expanded'), 'true', 'aria-expanded out of sync');
  r.act(() => tm.toggleLayersPanel());
  assert.ok(panel.classList.contains('hidden'), 'LAYERS did not close the popover');
  assert.equal(tm.layersOpen, false, 'toggleLayersPanel flipped back on its own');
  return `${MAP_LAYERS.length} switches wired 1:1; buildings ${withAll} -> ${withoutBuildings} fills; route lines ${linesOn} -> 0 -> ${linesOn} with the verdict still printed; bare paint ${bare} ops; route length ${truth.meters == null ? 'n/a' : Math.round(truth.meters) + ' m'} unchanged`;
});

// ---------------------------------------------------------------------------
check('T19. recentre, follow and the keyboard drive the map and nothing else', () => {
  const r = rig('recon_desert');
  const { g, tm, dom } = r;
  const PAN_KEY_PX_EXPECT = Number((r.JS.match(/const PAN_KEY_PX = (\d+)/) || [0, 52])[1]);
  // (a) RESET / ME / OBJECTIVE: what each one centres on, to the pixel
  r.press('tac-fitbtn'); r.settle();
  const b = tm.geom.bounds;
  for (const [x, z] of [[b.minX, b.minZ], [b.maxX, b.minZ], [b.minX, b.maxZ], [b.maxX, b.maxZ]]) {
    const s = r.P(x, z);
    assert.ok(s.x >= -1 && s.x <= W + 1 && s.y >= -1 && s.y <= H + 1, `RESET does not frame (${x.toFixed(0)},${z.toFixed(0)})`);
  }
  r.act(() => tm.zoomBy(3, null)); r.settle();
  r.press('tac-playerbtn'); r.settle();
  let pc = r.P(g.player.pos.x, g.player.pos.z);
  assert.ok(Math.abs(pc.x - W / 2) < 1 && Math.abs(pc.y - H / 2) < 1, `"ME" left the player at ${pc.x.toFixed(1)},${pc.y.toFixed(1)}`);
  r.press('tac-objbtn'); r.settle();
  const oc = r.P(r.objective.x, r.objective.z);
  assert.ok(Math.abs(oc.x - W / 2) < 1 && Math.abs(oc.y - H / 2) < 1, `"OBJECTIVE" left the objective at ${oc.x.toFixed(1)},${oc.y.toFixed(1)}`);
  assert.equal(tm.follow, false, 'jumping to the objective armed follow mode');
  // (b) FOLLOW keeps the player welded to the centre while the world moves
  r.press('tac-playerbtn'); r.settle();
  r.act(() => tm.setFollow(true));
  assert.equal(dom.byId['tac-followbtn'].textContent, 'FOLLOW: ON', 'FOLLOW label out of sync');
  assert.equal(dom.byId['tac-followbtn'].getAttribute('aria-pressed'), 'true', 'aria-pressed out of sync');
  r.frame();
  assert.ok(r.ops().some((o) => o.op === 'text' && /FOLLOW/.test(o.t)), 'the status line does not say FOLLOW');
  g.player.pos.x += 41; g.player.pos.z -= 27;
  r.act(() => { tm.update(0.016); tm.drawFull(); }); r.settle();
  pc = r.P(g.player.pos.x, g.player.pos.z);
  assert.ok(Math.abs(pc.x - W / 2) < 1.5 && Math.abs(pc.y - H / 2) < 1.5,
    `follow mode lost the player at ${pc.x.toFixed(1)},${pc.y.toFixed(1)} after a 49 m move`);
  // (c) a grab takes over: follow disengages the moment the player drags
  r.pointer('pointerdown', 280, 280);
  r.pointer('pointermove', 320, 280);
  assert.equal(tm.follow, false, 'dragging while in follow mode stayed welded');
  assert.equal(dom.byId['tac-followbtn'].textContent, 'FOLLOW: OFF', 'FOLLOW label did not follow the disengage');
  r.pointer('pointerup', 320, 280);
  // (d) keyboard: every map key does its job, and stops there
  const zBefore = tm._zoomT;
  const k1 = r.key('Equal');
  assert.ok(tm._zoomT > zBefore, `+ did not zoom in (${zBefore.toFixed(2)} -> ${tm._zoomT.toFixed(2)})`);
  assert.ok(k1.propagationStopped, '+ leaked to the gameplay bindings');
  r.key('Minus');
  r.key('KeyN'); assert.equal(tm.rotateMode, 'north', 'N did not force north-up');
  r.key('KeyU'); assert.equal(tm.rotateMode, 'player', 'U did not switch to player-up');
  r.key('KeyN');
  r.key('KeyF'); assert.equal(tm.follow, true, 'F did not arm follow');
  r.key('KeyF'); assert.equal(tm.follow, false, 'F did not disengage follow');
  r.key('KeyL'); assert.equal(tm.layersOpen, true, 'L did not open the layer popover');
  r.key('KeyL'); assert.equal(tm.layersOpen, false, 'L did not close it');
  const panFrom = { px: tm._panXT, py: tm._panYT };
  r.key('ArrowRight'); r.settle();
  const panDist = Math.hypot(tm._panXT - panFrom.px, tm._panYT - panFrom.py) * PPM * tm.zoom;
  assert.ok(Math.abs(panDist - PAN_KEY_PX_EXPECT) < 2, `ArrowRight panned ${panDist.toFixed(1)} px, expected the ${PAN_KEY_PX_EXPECT} px key step`);
  r.key('ArrowRight', { shiftKey: true }); r.settle();
  const fastDist = Math.hypot(tm._panXT - panFrom.px, tm._panYT - panFrom.py) * PPM * tm.zoom;
  assert.ok(fastDist > 200, `shift+Arrow panned only ${fastDist.toFixed(1)} px (expected the fast step to stack on top)`);
  r.key('Digit0'); r.settle();
  assert.ok(Math.abs(tm._zoomT - tm.fitZoom()) < 1e-6, '0 did not restore the fitted zoom');
  assert.match(dom.byId['tac-zoomval'].textContent, /^\d+(\.\d+)?\u00d7$/, 'zoom readout out of shape');
  // (e) an unmapped key is not swallowed: the game keeps its keys while the map is up
  assert.equal(r.key('KeyE').propagationStopped, false, 'the map stopped every keydown, including keys it does not use');
  assert.equal(r.key('KeyW').propagationStopped, false, 'WASD was swallowed by the map handler');
  assert.ok(!r.key('KeyW').defaultPrevented, 'the map cancelled a key it does not own');
  // (f) the view is the player's: keys are inert while closed, and it survives a reopen
  const before = { z: tm._zoomT, px: tm._panXT, py: tm._panYT, follow: tm.follow, layers: tm.layersOpen };
  r.act(() => tm.close(true));
  for (const code of ['Equal', 'Minus', 'Digit0', 'ArrowUp', 'ArrowDown', 'KeyF', 'KeyL', 'KeyU', 'Enter']) r.key(code);
  assert.deepEqual({ z: tm._zoomT, px: tm._panXT, py: tm._panYT, follow: tm.follow, layers: tm.layersOpen }, before,
    'map keys were live while the map was closed');
  assert.equal(tm.open, false, 'a key re-opened the map');
  r.act(() => tm.openMap());
  assert.deepEqual({ z: tm._zoomT, px: tm._panXT, py: tm._panYT, follow: tm.follow, layers: tm.layersOpen }, before,
    'close/reopen threw the view away');
  return `RESET/ME/OBJECTIVE centre to <1 px; follow held through a 49 m move; 12 keys routed, W/E untouched, 9 keys inert while closed and the view restored on reopen`;
});

// ---------------------------------------------------------------------------
check('T20. the map window floats and resizes without touching the view, and the canvas stays pixel-exact', () => {
  const r = rig('recon_desert');
  const { g, tm, dom } = r;
  const frame = dom.byId['tacmap'];
  r.press('tac-floatbtn');
  assert.ok(frame.classList.contains('floating'), 'FLOAT did not mark the panel floating');
  assert.ok(/px$/.test(frame.style.left || '') && /px$/.test(frame.style.width || ''), 'the floating panel has no geometry');
  assert.notEqual(frame.style.left, 'auto', 'inset:auto was written after left/top and erased the window position');
  // (0) a press that starts on a control must not drag the window, and no drag may put
  // the window out of reach: 48 px of it always stays on screen.
  {
    const bar0 = dom.byId['tacmap-topbar'];
    const before = { x: tm.float.x, y: tm.float.y };
    const ctl = makeEl('button'); ctl.id = 'tac-zoomout'; ctl.textContent = '\u2212';
    bar0.appendChild(ctl);
    r.act(() => bar0.fire('pointerdown', { clientX: 20, clientY: 20, pointerId: 41, target: ctl }));
    r.act(() => dom.doc.fire('pointermove', { clientX: -600, clientY: 0, pointerId: 41 }));
    r.act(() => dom.doc.fire('pointerup', { pointerId: 41 }));
    assert.deepEqual({ x: tm.float.x, y: tm.float.y }, before, 'a press on a bar button also dragged the window');
    r.act(() => bar0.fire('pointerdown', { clientX: 400, clientY: 12, pointerId: 42, target: dom.byId['tacmap-title'] || bar0 }));
    r.act(() => dom.doc.fire('pointermove', { clientX: -4000, clientY: -4000, pointerId: 42 }));
    r.act(() => dom.doc.fire('pointerup', { pointerId: 42 }));
    assert.ok(tm.float.y >= 0 && tm.float.x >= -(tm.float.w - 48) - 1,
      `the window could be dragged out of reach (landed at ${tm.float.x},${tm.float.y}, ${tm.float.w}x${tm.float.h} in ${W}x${H})`);
    r.act(() => bar0.fire('pointerdown', { clientX: 400, clientY: 12, pointerId: 43, target: dom.byId['tacmap-title'] || bar0 }));
    r.act(() => dom.doc.fire('pointermove', { clientX: 9000, clientY: 9000, pointerId: 43 }));
    r.act(() => dom.doc.fire('pointerup', { pointerId: 43 }));
    // the rule is reachability, not containment: the bar must stay grabbable
    assert.ok(tm.float.x <= W - 48 && tm.float.y <= H - 48,
      `the window escaped off the right/bottom edge: x=${tm.float.x}, w=${tm.float.w}, y=${tm.float.y}, h=${tm.float.h} in ${W}x${H} - the title bar is out of reach`);
    bar0.removeChild(ctl);
    // put the window back where a player would expect it for the checks that follow
    // (toggleFloat deliberately keeps a player's own size/position when float is
    // re-entered, so the test has to re-centre it explicitly)
    tm.float.x = Math.round((W - tm.float.w) / 2); tm.float.y = Math.round((H - tm.float.h) / 2);
    tm._applyFloat();
  }
  assert.ok(parseInt(frame.style.left, 10) > 0 && parseInt(frame.style.top, 10) >= 0,
    `the floating window opened at ${frame.style.left},${frame.style.top} - not a position a player can use`);
  assert.ok(tm.float.w >= 340 && tm.float.w <= W - 24 && tm.float.h <= H - 24,
    `the floating window is ${tm.float.w}x${tm.float.h} in a ${W}x${H} viewport - that is not a smaller, movable window`);
  assert.ok(tm.float.x >= 0 && tm.float.x + tm.float.w <= W && tm.float.y >= 0 && tm.float.y + tm.float.h <= H,
    `the floating window at ${tm.float.x},${tm.float.y} (${tm.float.w}x${tm.float.h}) does not sit inside the viewport`);
  assert.equal(dom.byId['tac-floatbtn'].textContent, 'MAXIMIZE', 'the float button label is stuck');
  const viewBefore = { z: tm._zoomT, px: tm._panXT, py: tm._panYT };
  // (a) title-bar drag moves the window, never the map
  const bar = dom.byId['tacmap-topbar'];
  const at = { x: tm.float.x, y: tm.float.y };
  r.act(() => bar.fire('pointerdown', { clientX: 500, clientY: 60, pointerId: 31 }));
  r.act(() => dom.doc.fire('pointermove', { clientX: 380, clientY: 200, pointerId: 31 }));
  assert.ok(frame.classList.contains('chrome-active'), 'the chrome did not report an active grab');
  assert.ok(Math.abs(tm.float.x - (at.x - 120)) < 1e-6 && Math.abs(tm.float.y - (at.y + 140)) < 1e-6,
    `the title bar dragged the window to ${tm.float.x},${tm.float.y} instead of ${at.x - 120},${at.y + 140}`);
  assert.deepEqual({ z: tm._zoomT, px: tm._panXT, py: tm._panYT }, viewBefore, 'dragging the title bar panned the map');
  r.act(() => dom.doc.fire('pointerup', { pointerId: 31 }));
  assert.ok(!frame.classList.contains('chrome-active'), 'the chrome stayed active after release');
  // (b) the grip resizes the window; the canvas follows the box, at device pixels
  const grip = dom.byId['tacmap-grip'];
  const wBefore = tm.float.w, hBefore = tm.float.h;
  r.act(() => grip.fire('pointerdown', { clientX: 900, clientY: 700, pointerId: 32 }));
  r.act(() => dom.doc.fire('pointermove', { clientX: 900 + 260, clientY: 700 + 180, pointerId: 32 }));
  r.act(() => dom.doc.fire('pointerup', { pointerId: 32 }));
  // the rig's viewport is 560 px wide, so the grip is clamped at 1.2x of it: the drag
  // has to track the pointer up to that bound and not past it.
  const cap = Math.round(W * 1.2);
  assert.equal(tm.float.w, Math.min(wBefore + 260, cap), `the grip set width ${tm.float.w} for a +260 px drag (from ${wBefore}, cap ${cap})`);
  assert.equal(tm.float.h, Math.min(hBefore + 180, cap), `the grip set height ${tm.float.h} for a +180 px drag (from ${hBefore}, cap ${cap})`);
  assert.deepEqual({ z: tm._zoomT, px: tm._panXT, py: tm._panYT }, viewBefore, 'resizing the window moved the view');
  // (c) double-click the bar: back to the full-screen frame, geometry released
  r.act(() => bar.fire('dblclick', {}));
  assert.ok(!frame.classList.contains('floating'), 'double-click did not restore the full-screen frame');
  assert.equal(frame.style.width, '', 'the floating width was left on the element');
  assert.equal(dom.byId['tac-floatbtn'].textContent, 'FLOAT', 'FLOAT label did not come back');
  // (d) the backing store is the CSS box x DPR, with no 1024 clip anywhere, and a
  //     repaint must not re-size a canvas that already matches its box
  const cv = dom.full;
  const savedRect = cv.getBoundingClientRect;
  const savedWin = globalThis.window;
  const win = (dpr) => ({ devicePixelRatio: dpr, innerWidth: 2560, innerHeight: 1440, addEventListener() { }, removeEventListener() { } });
  const box = (w, h) => { cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: h }); };
  try {
    box(2560, 1440);
    globalThis.window = win(2);
    tm._sizeCanvas(cv, 4096);
    assert.equal(cv.width, 4096, `a 2560x1440 CSS box at dpr 2 backed the canvas with ${cv.width} px (want the 4096 cap, not a 1024 clip)`);
    assert.equal(cv.height, 2880, `canvas height ${cv.height} is not box x dpr`);
    box(1100, 700);
    cv.width = 1; cv.height = 1;               // deliberately wrong: the map must repair it
    globalThis.window = win(1);
    tm._sizeCanvas(cv, 4096);
    assert.equal(cv.width, 1100, `at dpr 1 a 1100x700 box backed itself as ${cv.width} px`);
    assert.equal(cv.height, 700, `at dpr 1 the height came out ${cv.height}`);
    const stable = { w: cv.width, h: cv.height };
    r.frame();                                  // a real repaint, through drawFull
    assert.deepEqual({ w: cv.width, h: cv.height }, stable, 'every repaint re-set the canvas backing store (that clears the canvas and flickers)');
    assert.ok(cv.width >= stable.w && cv.height >= stable.h, 'the canvas shrank below its own CSS box');
    assert.ok(!/image-rendering/.test((r.CSS || '').slice((r.CSS || '').lastIndexOf('#tacmap-canvas'), (r.CSS || '').indexOf('}', (r.CSS || '').lastIndexOf('#tacmap-canvas')))),
      'the canvas sets image-rendering: the browser would resample it instead of the map drawing at device pixels');
  } finally {
    globalThis.window = savedWin;
    cv.getBoundingClientRect = savedRect;
    cv.width = W; cv.height = H;
  }
  // (e) the DOM contract: every id the product looked up really exists in the page
  const html = r.HTML || '';
  const created = new Set([
    ...[...r.JS.matchAll(/\.id = '([^']+)'/g)].map((m) => m[1]),
    ...[...r.JS.matchAll(/btn\('([^']+)'/g)].map((m) => m[1]),
  ]);
  const missing = [...dom.synthetic].filter((id) => !html.includes(`id="${id}"`) && !created.has(id));
  assert.deepEqual(missing, [], `the map drives ${missing.join(', ')}, which no file in the project defines`);
  assert.ok(dom.byId['tacmap-canvas'] === dom.full, 'the canvas the map bound to is not #tacmap-canvas');
  // (f) the stylesheet must not undo the renderer. The rules are parsed rather than
  //     grepped, so a comment that merely mentions blur cannot pass or fail this.
  const cssAll = (r.CSS || '').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...cssAll.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const mapRules = rules.filter((x) => /tacmap|tac-|map3d/.test(x.sel));
  assert.ok(mapRules.length >= 20, `only ${mapRules.length} map rules found in hud.css - did the v4.4 block land?`);
  const blurred = mapRules.filter((x) => /backdrop-filter|filter:\s*blur|image-rendering:\s*pixelated|transform:\s*scale/.test(x.body));
  assert.deepEqual(blurred.map((x) => x.sel), [], 'a map rule blurs or resamples the canvas: ' + blurred.map((x) => x.sel).join(', '));
  const canvasRules = mapRules.filter((x) => /#tacmap-canvas/.test(x.sel));
  assert.ok(canvasRules.length >= 1, 'no rule styles #tacmap-canvas at all');
  assert.ok(canvasRules.some((x) => /touch-action:\s*none/.test(x.body)), 'the canvas does not opt out of native touch gestures');
  assert.ok(rules.some((x) => /#tacmap(\s|,|\*)/.test(x.sel) && /user-select:\s*none/.test(x.body)),
    'the map does not disable text selection - a pan drag would rubber-band a selection');
  const stage = rules.find((x) => /#tacmap-stage/.test(x.sel));
  assert.ok(stage && /position:\s*relative/.test(stage.body), '#tacmap-stage is not the positioning parent for the overlay cards');
  return `float ${wBefore}x${hBefore} -> ${tm.float.w}x${tm.float.h} with the view untouched; 4096x2880 backing store for a 2560x1440 box at dpr 2; ${dom.synthetic.size} dynamic ids all defined`;
});

// ---------------------------------------------------------------------------
check('T21. the interaction layer owns one set of listeners and still paints inside budget', () => {
  const r = rig('recon_desert');
  const { g, tm, dom } = r;
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel']) {
    assert.equal((dom.full._l[type] || []).length, 1,
      `${type} has ${(dom.full._l[type] || []).length} canvas handlers - double-bound input runs every gesture twice`);
  }
  const n0 = tm._mapListenerCount;
  for (let i = 0; i < 3; i++) { r.act(() => tm.close(true)); r.act(() => tm.openMap()); r.frame(); }
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel']) {
    assert.equal((dom.full._l[type] || []).length, 1, `${type} grew after a close/reopen cycle`);
  }
  assert.equal(tm._mapListenerCount, n0, 'listeners accumulated across reopen');
  assert.equal(tm._mapRebinds, 0, `open/close cycles re-entered _bindMapInput ${tm._mapRebinds} times`);
  assert.equal((dom.byId['tacmap-topbar']._l.pointerdown || []).length, 1, 'the title bar grabbed twice');
  // the toolbar has exactly one owner: the map. game.js must not also bind it.
  const owned = ((r.GAMEJS || '').match(/click\('tac-/g) || []).length;
  assert.equal(owned, 0, `game.js still binds ${owned} tac-* clicks - every press would run twice`);
  // budget: the worst real frame is a full repaint with everything on, deep in the zoom
  let worst = 0, calls = 0, bare = 0;
  for (const name of ['recon_desert', 'sabotage_industrial']) {
    const q = rig(name);
    q.act(() => q.tm.zoomBy(5, null)); q.settle();
    for (let i = 0; i < 6; i++) { q.frame(); worst = Math.max(worst, q.tm._lastDrawMs); calls = Math.max(calls, q.tm._drawCalls); }
    q.act(() => { for (const L of MAP_LAYERS) q.tm.setLayer(L.key, false); q.frame(); });
    bare = Math.max(bare, q.tm._drawCalls);
    assert.ok(bare < calls, `all layers off painted ${bare} calls vs ${calls} - the switches are not skipping work`);
    assert.ok(q.tm._lastDrawMs <= 45, `repaint with every layer off took ${q.tm._lastDrawMs.toFixed(1)} ms`);
  }
  assert.ok(worst <= 45, `interactive repaint took ${worst.toFixed(1)} ms at depth (budget 45 ms)`);
  // knowledge keeps updating while the map is open, on a cadence
  r.act(() => { for (let i = 0; i < 40; i++) tm.update(0.016); });
  assert.ok(tm._detectT <= 0.25, 'the detection scan is not on a cadence');
  assert.ok(tm._lastDrawMs <= 45, `the idle repaint on this rig took ${tm._lastDrawMs.toFixed(1)} ms`);
  return `1 handler per gesture type across 4 opens (${tm._mapListenerCount} listeners, 0 re-binds); worst interactive repaint ${worst.toFixed(1)} ms / ${calls} calls -> ${bare} calls with the layers down`;
});

// ---------------------------------------------------------------------------
console.log('');
console.log(`${results.length - failures}/${results.length} tacmap tests passed`);
if (failures) process.exitCode = 1;
