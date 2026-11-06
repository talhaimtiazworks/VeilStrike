/* ==========================================================================
 * VEILSTRIKE · js/editor.js — CUSTOMIZE CONTROLS screen (Phase 13)
 *
 * Dedicated editor opened from Settings (and from the legacy customize path).
 * Contract:
 *  - previews the REAL #touch-controls markup (the live node is re-parented
 *    into the editor stage for exact WYSIWYG, then moved back);
 *  - gameplay handlers are dead while editing (touch.editing === true);
 *  - drag = position · sliders = size & opacity · SAVE persists via
 *    ControlLayout · RESET restores defaults · CANCEL reverts to the snapshot
 *    taken at open;
 *  - works with touch alone (drag via pointer events) and with mouse.
 * ========================================================================== */

import { CONTROLS, ControlLayout, safeInsets } from './layout.js';

let active = null; // session {game, touch, snapshot, selected, cleanup}

export function openControlEditor(game) {
  const touch = game.touch;
  if (!touch || active) return;
  const screen = document.getElementById('screen-controls');
  if (!screen) return;

  const session = {
    game, touch,
    snapshot: JSON.parse(JSON.stringify(touch.layout.entries)),
    selected: null,
  };
  active = session;

  // enter editing mode: HUD hidden, controls moved into the editor stage
  game.ui.showScreen('controls');
  document.body.classList.add('controls-editing');
  const stage = document.getElementById('ces-stage');
  stage.appendChild(touch.root);
  touch.root.classList.add('enabled', 'editing');
  touch.setEditing(true);

  const sizeR = document.getElementById('ces-size');
  const opR = document.getElementById('ces-opacity');
  const onSize = () => { if (!session.selected) return; const e = touch.layout.entries[session.selected]; e.s = +sizeR.value / 100; touch.applyLayout(); };
  const onOp = () => { if (!session.selected) return; const e = touch.layout.entries[session.selected]; e.o = +opR.value / 100; touch.applyLayout(); };
  sizeR.addEventListener('input', onSize);
  opR.addEventListener('input', onOp);

  // populate
  document.getElementById('ces-name').textContent = 'SELECT A CONTROL';
  _syncSliders(null);
  screen.classList.remove('hidden');

  // interactions ------------------------------------------------------------
  const onDown = (ev) => {
    const t = ev.target.closest('[data-ctl]');
    if (!t) return;
    ev.preventDefault(); ev.stopPropagation();
    select(t.dataset.ctl);
    const id = session.selected;
    const rec = touch.els[id];
    try { t.setPointerCapture(ev.pointerId); } catch (_) { /* ok */ }
    session.drag = { id, pid: ev.pointerId };
  };
  const onMove = (ev) => {
    const d = session.drag;
    if (!d || ev.pointerId !== d.pid) return;
    ev.preventDefault();
    const e = touch.layout.entries[d.id];
    const vw = window.innerWidth, vh = window.innerHeight;
    e.x = Math.min(1, Math.max(0, ev.clientX / vw));
    e.y = Math.min(1, Math.max(0, ev.clientY / vh));
    const nudged = touch.onResize() > 0 || true;   // clamp live
    touch.layout.entries[d.id].x = e.x = clampHalf(d.id, e.x, vw, 'x', touch);
    touch.layout.entries[d.id].y = e.y = clampHalf(d.id, e.y, vh, 'y', touch);
    touch.applyLayout();
  };
  const onUp = (ev) => { if (session.drag && ev.pointerId === session.drag.pid) session.drag = null; };

  stage.addEventListener('pointerdown', onDown, { passive: false });
  stage.addEventListener('pointermove', onMove, { passive: false });
  stage.addEventListener('pointerup', onUp);
  stage.addEventListener('pointercancel', onUp);

  const bindClick = (id, fn) => { const b = document.getElementById(id); const h = () => { fn(); }; b.addEventListener('click', h); return [b, h]; };
  const binds = [];
  binds.push(bindClick('ces-save', () => {
    const ok = touch.saveLayout();
    close(true, ok ? 'LAYOUT SAVED' : 'SAVE UNAVAILABLE');
  }));
  binds.push(bindClick('ces-cancel', () => { touch.layout.entries = session.snapshot; touch.applyLayout(); close(false, 'CHANGES DISCARDED'); }));
  binds.push(bindClick('ces-reset', () => {
    touch.layout.reset(window.innerWidth > window.innerHeight, !!game.settings.leftHanded);
    touch.applyLayout();
    select(session.selected, true);
    flash('DEFAULT LAYOUT RESTORED — SAVE TO KEEP');
  }));
  binds.push(bindClick('ces-done', () => close(false, null)));

  const onHook = () => { /* resize during edit → re-clamp + rerender */ touch.applyLayout(); };
  touch._editorHook = onHook;

  function select(id, silent) {
    session.selected = id || null;
    for (const c of CONTROLS) touch.els[c.id].el.classList.toggle('selected', c.id === id);
    const def = CONTROLS.find(c => c.id === id);
    document.getElementById('ces-name').textContent = def ? def.label : 'SELECT A CONTROL';
    _syncSliders(id ? touch.layout.entries[id] : null);
  }
  function _syncSliders(e) {
    sizeR.value = e ? Math.round(e.s * 100) : 100;
    opR.value = e ? Math.round(e.o * 100) : 80;
    document.getElementById('ces-size-val').textContent = e ? Math.round(e.s * 100) + '%' : '—';
    document.getElementById('ces-op-val').textContent = e ? Math.round(e.o * 100) + '%' : '—';
  }
  const onSizeLabel = () => document.getElementById('ces-size-val').textContent = sizeR.value + '%';
  const onOpLabel = () => document.getElementById('ces-op-val').textContent = opR.value + '%';
  sizeR.addEventListener('input', onSizeLabel);
  opR.addEventListener('input', onOpLabel);
  function flash(msg) {
    const el = document.getElementById('ces-flash');
    el.textContent = msg || '';
    el.classList.toggle('show', !!msg);
    clearTimeout(flash._t); flash._t = setTimeout(() => el.classList.remove('show'), 2400);
  }
  function close(saved, toast) {
    // leave editing mode, restore node, persist state choice
    touch.setEditing(false);
    touch.root.classList.remove('editing');
    touch.root.classList.toggle('enabled', !!touch.enabled);
    document.getElementById('game-container').appendChild(touch.root); // back to play layer
    document.body.classList.remove('controls-editing');
    screen.classList.add('hidden');
    stage.removeEventListener('pointerdown', onDown);
    stage.removeEventListener('pointermove', onMove);
    stage.removeEventListener('pointerup', onUp);
    stage.removeEventListener('pointercancel', onUp);
    sizeR.removeEventListener('input', onSize);
    opR.removeEventListener('input', onOp);
    sizeR.removeEventListener('input', onSizeLabel);
    opR.removeEventListener('input', onOpLabel);
    for (const [b, h] of binds) b.removeEventListener('click', h);
    touch._editorHook = null;
    active = null;
    if (saved && !touch.saveLayout()) { /* save attempted twice is harmless */ }
    game.ui.showScreen('settings');
    if (toast && game.ui.toastBrief) game.ui.toastBrief(toast);
  }

  session.select = select;
  session._clamp = (touch) => { /* noop kept for future hooks */ };
}

/* clamp: keep at least half the control onscreen against safe insets */
function clampHalf(id, v, span, axis, touch) {
  const ins = safeInsets();
  const base = (CONTROLS.find(c => c.id === id) || { base: 56 }).base;
  const e = touch.layout.entries[id];
  const half = (base * e.s) / 2;
  const lo = ((axis === 'x' ? ins.l : ins.t) + half) / span;
  const hi = (span - (axis === 'x' ? ins.r : ins.b) - half) / span;
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}
