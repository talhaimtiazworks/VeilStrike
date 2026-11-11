/* ==========================================================================
 * VEILSTRIKE · js/touch.js — mobile control layer (Phase 13 rewrite)
 *
 * Architecture rules (from the audit + Phase-13 brief):
 *  - ONE writer per input field: touch writes the SAME game.input object the
 *    keyboard/mouse layer writes; gameplay systems never read pointers.
 *  - Per-pointerId ownership: every control tracks exactly one active pointer;
 *    multi-touch (move + aim + fire) is structural, not negotiated.
 *  - Separate input modes: gameplay / editing. While the control editor is
 *    open (this.editing === true) every gameplay handler is a no-op.
 *  - Geometry comes exclusively from js/layout.js (ControlLayout); this file
 *    contains no layout constants. Rendering applies el.style.left/top +
 *    --ctl-size + opacity from the validated layout.
 * Public API consumed by game.js: constructor(game), applySettings(),
 * onResize(w,h), setEnabled(bool), beginCustomization(), update(dt),
 * resetForVehicleTransition(), setEditing(bool), saveLayout(), layout.
 * ========================================================================== */

import { CONTROLS, ControlLayout, safeInsets } from './layout.js';

const DEAD = 0.12;

export class TouchControls {
  constructor(game) {
    this.game = game;
    this.editing = false;
    this.enabled = false;
    this._pointers = new Map();      // pointerId -> control id
    this._stick = { m: null, l: null };  // pointerIds actually driving sticks
    this._autoSprint = false;
    this._autoFire = false;
    this._aimOn = false;             // aimMode:'toggle' state
    this._vwT = 0;

    this.layout = new ControlLayout();
    this._modeLandscape = window.innerWidth > window.innerHeight;
    if (!this.layout.loadFromStorage()) {
      this.layout.reset(this._modeLandscape, !!game.settings.leftHanded);
    } else {
      // Master upgrade: a saved layout from before new controls existed keeps
      // every saved position; only the NEW controls are seeded from defaults.
      this.layout.ensure(this._modeLandscape, !!game.settings.leftHanded);
      // FINAL MOBILE UX FIX: persist a v1→v2 layout migration exactly once
      // (customised positions are never touched — see ControlLayout._migrateV1)
      if (this.layout.migration) this.layout.save();
    }

    this.root = document.getElementById('touch-controls');
    this.root.classList.remove('hidden');        // visibility is driven solely by .enabled
    this.root.textContent = '';
    this.els = {};
    this._build();
    this.applyLayout();
  }

  /* ---------------------------------------------------------------- DOM -- */
  _build() {
    for (const c of CONTROLS) {
      let el, knob = null;
      if (c.kind === 'stick') {
        el = document.createElement('div');
        el.className = 'tstick';
        const base = document.createElement('div'); base.className = 'tstick-base';
        knob = document.createElement('div'); knob.className = 'tstick-knob show';
        el.appendChild(base); el.appendChild(knob);
      } else {
        el = document.createElement('button');
        el.type = 'button';
        el.className = 'tbtn' + (c.accent ? ' tbtn-accent' : '');
        el.textContent = this._abbr(c.id);
        el.setAttribute('aria-label', c.label);
      }
      el.dataset.ctl = c.id;
      el.id = c.id;
      this.root.appendChild(el);
      this.els[c.id] = { el, knob, def: c };
      this._bind(c.id);
    }
  }

  _abbr(id) {
    return ({
      'tbtn-fire': 'FIRE', 'tbtn-ads': 'ADS', 'tbtn-reload': 'RLD', 'tbtn-jump': 'JMP',
      'tbtn-crouch': 'CRC', 'tbtn-sprint': 'SPR', 'tbtn-interact': 'USE',
      'tbtn-switch': 'WPN', 'tbtn-throw': 'EQP', 'tbtn-throwbk': 'EQ◄', 'tbtn-mode': 'MODE',
      'tbtn-band': 'MED', 'tbtn-map': 'MAP', 'tbtn-pause': 'II',
      'tbtn-shield': 'BAR', 'tbtn-ability': 'ABL',
      'tbtn-light': 'LGT', 'tbtn-zoom': 'ZM', 'tbtn-strike': 'STK',
    })[id] || id;
  }

  /* ------------------------------------------------------------ LAYOUT --- */
  _basePx(id) { return (CONTROLS.find(c => c.id === id) || { base: 56 }).base; }

  applyLayout() {
    // clamp-at-apply: even pristine defaults honor safe-area bounds on every viewport
    this.layout.validate(window.innerWidth, window.innerHeight, safeInsets(), (id) => this._basePx(id));
    for (const c of CONTROLS) {
      const e = this.layout.entries[c.id]; if (!e) continue;
      const rec = this.els[c.id];
      rec.el.style.left = (e.x * 100).toFixed(3) + '%';
      rec.el.style.top = (e.y * 100).toFixed(3) + '%';
      rec.el.style.width = rec.el.style.height = (Math.round(this._basePx(c.id) * e.s)) + 'px';
      rec.el.style.opacity = e.o.toFixed(2);
    }
  }

  onResize() {
    const ins = safeInsets();
    const landscape = window.innerWidth > window.innerHeight;
    if (landscape !== this._modeLandscape) {
      this._modeLandscape = landscape;
      // orientation flip: a never-customized layout follows the new mode's
      // default table; a saved/custom layout is instead clamped in place.
      const hasCustom = (() => { try { return !!localStorage.getItem('obv_touch_layout_v1'); } catch (_) { return false; } })();
      if (!hasCustom) this.layout.reset(landscape, !!this.game.settings.leftHanded);
    }
    const nudged = this.layout.validate(window.innerWidth, window.innerHeight, ins, (id) => this._basePx(id));
    this.applyLayout();
    if (this._editorHook) this._editorHook();
    return nudged;
  }

  saveLayout() { return this.layout.save(); }

  applySettings() {
    // Handed preset only reshapes a NON-customized layout; player drag
    // preferences are never destroyed by changing a different setting.
    const hasCustom = (() => { try { return !!localStorage.getItem('obv_touch_layout_v1'); } catch (_) { return false; } })();
    if (!hasCustom) {
      this.layout.reset(window.innerWidth > window.innerHeight, !!this.game.settings.leftHanded);
      this.applyLayout();
    }
  }

  /* ----------------------------------------------------------- POINTERS -- */
  _bind(id) {
    const rec = this.els[id];
    const el = rec.el;

    el.addEventListener('pointerdown', (ev) => {
      if (!this.enabled || this.editing) return;
      ev.preventDefault(); ev.stopPropagation();
      try { el.setPointerCapture(ev.pointerId); } catch (_) { /* older engines */ }
      this._pointers.set(ev.pointerId, id);
      el.classList.add('active');
      this._press(id, ev);
    }, { passive: false });

    el.addEventListener('pointermove', (ev) => {
      if (this._pointers.get(ev.pointerId) !== id || this.editing) return;
      ev.preventDefault();
      if (id === 'stick-move' || id === 'stick-look') this._stickMove(id, ev);
    }, { passive: false });

    const up = (ev) => {
      if (this._pointers.get(ev.pointerId) !== id) return;
      this._pointers.delete(ev.pointerId);
      el.classList.remove('active');
      if (!this.editing) this._release(id);
      if (id === 'stick-move') this._stick.m = null;
      if (id === 'stick-look') this._stick.l = null;
      if (rec.knob) rec.knob.style.transform = '';
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }

  _stickMove(id, ev) {
    const rec = this.els[id];
    const g = this.game;
    const r = rec.el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const radius = r.width / 2;
    let dx = (ev.clientX - cx) / radius, dy = (ev.clientY - cy) / radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    const mag = Math.hypot(dx, dy);
    if (mag < DEAD) { dx = 0; dy = 0; }
    if (rec.knob) rec.knob.style.transform = `translate(${dx * radius * 0.42}px, ${dy * radius * 0.42}px)`;
    if (id === 'stick-move') {
      // Phase-17 responsiveness audit: the game's _pollInput() aggregates axes
      // from _touchF/_touchR every frame — writing input.moveF/moveR directly
      // is overwritten on the very next tick, which left touch movement
      // permanently dead. Feed the aggregated lanes instead.
      g.input._touchR = dx;
      g.input._touchF = -dy;
      const wantSprint = this.game.settings.autoSprint && mag > 0.985;
      if (wantSprint !== this._autoSprint) { this._autoSprint = wantSprint; }
      g.input.sprint = this._autoSprint || g.input._shiftKeyHeld || this._sprintWrote || false;
    } else {
      const sens = (g.input.mouse2 ? this.game.settings.aimSens : this.game.settings.lookSens) || 1;
      const gain = 0.14 * radius * sens;                       // px-of-travel → look units
      if (Number.isFinite(gain) && gain > 0) {
        g.input.lookX += dx * gain;
        g.input.lookY += dy * gain * (this.game.settings.invertY ? -1 : 1);
      }
    }
  }

  /* ------------------------------------------------------- ACTION WIRING --
   * Names map 1:1 to game.input fields (contract game.js:162 — verified). */
  _press(id) {
    const g = this.game;
    const i = g.input;
    if (g.state !== 'playing' && id !== 'tbtn-pause' && id !== 'tbtn-map') return;
    switch (id) {
      case 'stick-move': this._stick.m = true; break;
      case 'stick-look': this._stick.l = true; break;
      case 'tbtn-fire': i.mouse0 = true; this._fireTouch = true; this._buzz(12);
        if (this.game._fireInput) this.game._fireInput.press('touch', this.game.time); break;
      case 'tbtn-ads':
        // Phase 15: the ADS button now routes through the shared keyboard-toggle
        // edge (same latch as the X key) — one tap aims, next tap lowers the
        // sights. No hold-hunting on touch, and releasing the button can never
        // override a latched aim.
        i.adsToggleRequested = true;
        this._buzz(6); break;
      case 'tbtn-reload': i.reloadPressed = true; this._buzz(6); break;
      case 'tbtn-jump':
        if (g.vehicleMode) i.spaceHeld = true;            // vehicle: handbrake
        else { i.jumpPressed = true; i.spaceHeld = true; }
        this._buzz(6); break;
      case 'tbtn-crouch':
        if (g.vehicleMode) { i.camPressed = true; this._buzz(6); } // vehicle: camera
        else { i.crouch = !i.crouch; this._buzz(6); }
        break;
      case 'tbtn-sprint': i.sprint = true; this._sprintWrote = true; this._buzz(6); break;
      case 'tbtn-interact': i.interactPressed = true; i.interactHeld = true; this._buzz(6); break;
      // Phase-17 responsiveness audit: game._selectSlot() consumes slot NAMES
      // ('primary'|'secondary'); numeric slot ids were silently resolved to the
      // primary, leaving the touch weapon-switch button dead.
      case 'tbtn-switch': i.selectWeapon = (g.handsMode === 'gun' && g.weapons && g.weapons.current && g.weapons.current.slot === 2) ? 'primary' : 'secondary'; this._buzz(6); break;
      case 'tbtn-throw':
        if (g.vehicleMode) { i.vehicleHorn = true; this._buzz(6); } // vehicle: horn
        else { i.grenadePressed = true; this._buzz(6); }
        break;
      case 'tbtn-throwbk':
        if (!g.vehicleMode) { i.grenadeBackPressed = true; this._buzz(6); }
        break;
      case 'tbtn-shield':
        // CRITICAL FIX: same contract as [V] — tap acts on release, long-press stows
        if (!g.vehicleMode) { g.shieldPressStart(); this._buzz(6); }
        break;
      case 'tbtn-ability':
        if (!g.vehicleMode) { i.abilityPressed = true; this._buzz(6); }
        break;
      // Master upgrade: flashlight (tap), observation zoom (tap toggles), base strike (tap)
      case 'tbtn-light': if (!g.vehicleMode) { i.flashlightPressed = true; this._buzz(6); } break;
      case 'tbtn-zoom': if (!g.vehicleMode) { i._touchZoom = !i._touchZoom; this._buzz(6); } break;
      case 'tbtn-strike': i.baseStrikePressed = true; this._buzz(14); break;
      case 'tbtn-mode': i.fireModePressed = true; this._buzz(6); break;
      case 'tbtn-band': i.bandageHeld = true; this._buzz(6); break;
      case 'tbtn-map': i.mapPressed = true; this._buzz(6); break;
      case 'tbtn-pause':
        if (g.state === 'playing') g.pause();
        else if (g.state === 'paused') g.resume();
        this._buzz(6); break;
    }
  }

  _release(id) {
    const g = this.game;
    const i = g.input;
    switch (id) {
      case 'stick-move':
        i._touchF = 0; i._touchR = 0;
        this._autoSprint = false;
        if (!g.input._shiftKeyHeld && !this._sprintWrote) i.sprint = false;
        break;
      case 'stick-look': break;
      case 'tbtn-fire': i.mouse0 = false; this._fireTouch = false;
        if (this.game._fireInput) this.game._fireInput.release('touch'); break;
      case 'tbtn-ads': break;   // toggle-edge: release carries no state
      case 'tbtn-jump': i.spaceHeld = false; break;
      case 'tbtn-sprint':
        this._sprintWrote = false;
        if (!g.input._shiftKeyHeld && !this._autoSprint) i.sprint = false;
        break;
      case 'tbtn-interact': i.interactHeld = false; break;
      case 'tbtn-throw': if (g.vehicleMode) i.vehicleHorn = false; break;
      case 'tbtn-band': i.bandageHeld = false; break;
      case 'tbtn-shield': g.shieldPressEnd(); break;   // CRITICAL FIX: tap fires on release
    }
  }

  _buzz(ms) {
    if (!this.game.settings.vibration) return;
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) { /* iOS */ }
  }

  /* ------------------------------------------------------------- MODES --- */
  setEnabled(on) {
    this.enabled = !!on;
    this.root.classList.toggle('enabled', this.enabled);
    if (!this.enabled) this._releaseAll();
  }

  setEditing(on) {
    this.editing = !!on;
    document.body.classList.toggle('controls-editing', this.editing);
    if (this.editing) this._releaseAll();
  }

  _releaseAll() {
    for (const [, id] of [...this._pointers]) { this.els[id].el.classList.remove('active'); this._release(id); }
    this._pointers.clear();
    this._stick.m = this._stick.l = null;
    for (const id of Object.keys(this.els)) if (this.els[id].knob) this.els[id].knob.style.transform = '';
  }

  beginCustomization() {
    // Legacy entry preserved for game.js; the Phase-13 editor owns the flow.
    import('./editor.js').then(m => m.openControlEditor(this.game));
  }

  resetForVehicleTransition() { this._releaseAll(); }

  /* ------------------------------------------------------------- FRAME --- */
  update(dt) {
    const g = this.game;
    if (!this.enabled || this.editing) return;
    // contextual labels in vehicle mode
    if (this._veh !== !!g.vehicleMode) {
      this._veh = !!g.vehicleMode;
      this.els['tbtn-jump'].el.textContent = this._veh ? 'BRK' : 'JMP';
      this.els['tbtn-crouch'].el.textContent = this._veh ? 'CAM' : 'CRC';
      this.els['tbtn-throw'].el.textContent = this._veh ? 'HRN' : 'EQP';
    }
    // crouch indicator
    const crouched = !g.vehicleMode && !!g.input.crouch;
    this.els['tbtn-crouch'].el.classList.toggle('on', crouched);
    // auto-fire (only with an aim-assist target while ADS)
    if (g.settings.autoFire && g.input.mouse2 && g._aimAssistTarget && !this._fireTouch) {
      g.input.mouse0 = true; this._autoFire = true;
      if (g._fireInput) g._fireInput.setAssistHeld(true);       // a hold, not a click
    } else if (this._autoFire && !this._fireTouch) {
      g.input.mouse0 = false; this._autoFire = false;
      if (g._fireInput) g._fireInput.setAssistHeld(false);
    }
    // interact contextual availability (prompt lives in the HUD DOM)
    const prompt = document.getElementById('interact-prompt');
    const show = !!prompt && !prompt.classList.contains('hidden');
    this.els['tbtn-interact'].el.classList.toggle('ctx-hidden', !show);
    // haptic pulse while firing held
    if (g.input.mouse0) { this._vwT -= dt; if (this._vwT <= 0) { this._buzz(6); this._vwT = 0.15; } }
  }
}
