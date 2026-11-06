/* ==========================================================================
 * VEILSTRIKE · js/layout.js — touch-control layout model (Phase 13)
 *
 * One authoritative model for every customizable on-screen control:
 *   id, label, action kind (game.input contract), geometry per profile.
 * Geometry is stored as VIEWPORT FRACTIONS with center anchoring, so the same
 * layout survives rotation: validation re-clamps against the ACTUAL viewport
 * plus safe areas instead of guessing pixels (brief §4: "reposition controls
 * safely without unnecessarily destroying the player's preferences").
 *
 * Persistence: localStorage 'obv_touch_layout_v1'. Corrupt/invalid payloads
 * fail closed to defaults (never bricks gameplay).
 * ========================================================================== */

export const LAYOUT_KEY = 'obv_touch_layout_v1';

/* Control registry — ONLY actions that exist in game.input (verified contract
 * game.js:162). kind maps to touch.js handler names. */
export const CONTROLS = [
  { id: 'stick-move',  label: 'MOVE STICK',   kind: 'stick',      base: 116 },
  { id: 'stick-look',  label: 'LOOK PAD',     kind: 'stick',      base: 116 },
  { id: 'tbtn-fire',   label: 'FIRE',         kind: 'btn',        base: 84,  accent: true },
  { id: 'tbtn-ads',    label: 'AIM',          kind: 'btn',        base: 68 },
  { id: 'tbtn-reload', label: 'RELOAD',       kind: 'btn',        base: 56 },
  { id: 'tbtn-jump',   label: 'JUMP',         kind: 'btn',        base: 56 },
  { id: 'tbtn-crouch', label: 'CROUCH',       kind: 'btn',        base: 56 },
  { id: 'tbtn-sprint', label: 'SPRINT',       kind: 'btn',        base: 56 },
  { id: 'tbtn-interact', label: 'INTERACT',   kind: 'btn',        base: 56  },
  { id: 'tbtn-switch', label: 'WEAPONS',      kind: 'btn',        base: 56 },
  { id: 'tbtn-throw',  label: 'THROW',        kind: 'btn',        base: 56 },
  { id: 'tbtn-throwbk', label: 'THROW · BACK', kind: 'btn',       base: 52 },
  { id: 'tbtn-shield', label: 'BARRIER',      kind: 'btn',        base: 56 },
  { id: 'tbtn-ability', label: 'ABILITY',     kind: 'btn',        base: 56 },
  { id: 'tbtn-mode',   label: 'FIRE MODE',    kind: 'btn',        base: 56 },
  { id: 'tbtn-band',   label: 'BANDAGE',      kind: 'btn',        base: 56 },
  { id: 'tbtn-map',    label: 'MAP',          kind: 'btn',        base: 52 },
  { id: 'tbtn-pause',  label: 'PAUSE',        kind: 'btn',        base: 52 },
  // Master upgrade (P3/P4/P8) — appended so saved layouts keep their order
  { id: 'tbtn-light',  label: 'FLASHLIGHT',   kind: 'btn',        base: 52 },
  { id: 'tbtn-zoom',   label: 'ZOOM',         kind: 'btn',        base: 52 },
  { id: 'tbtn-strike', label: 'BASE STRIKE',  kind: 'btn',        base: 52 },
];

/* Default layouts: x,y = CENTER as viewport fractions.
 * landscape: thumb-driven (move low-left, actions low-right rail).
 * portrait:  raised rails inside the narrower safe column.
 * Defaults intentionally leave the lower-center third clear for prompts. */
export const DEFAULTS = {
  landscape: {
    'stick-move':    { x: .16, y: .88, s: .62, o: .6 },
    // FINAL MOBILE UX FIX: the look pad was at (.46,.50) — dead centre, over
    // the ADS sight picture. It now rests under the right thumb, below ADS and
    // left of the weapon card, clear of the sight zone on every landscape size.
    'stick-look':    { x: .62, y: .85, s: .7, o: .5 },
    'tbtn-fire':     { x: .90, y: .61, s: 1.05, o: .92 },
    'tbtn-ads':      { x: .65, y: .60, s: 1.0, o: .85 },
    'tbtn-jump':     { x: .76, y: .63, s: 1.0, o: .85 },
    'tbtn-reload':   { x: .75, y: .45, s: 1.0, o: .85 },
    'tbtn-mode':     { x: .90, y: .41, s: .8, o: .8 },
    // action row sits one lane lower so the compact objective chip fits under the compass
    'tbtn-throw':    { x: .74, y: .27, s: 1.0, o: .85 },
    'tbtn-throwbk':  { x: .62, y: .27, s: 1.0, o: .85 },
    'tbtn-shield':   { x: .38, y: .27, s: 1.0, o: .85 },
    'tbtn-ability':  { x: .26, y: .27, s: 1.0, o: .85 },
    'tbtn-switch':   { x: .87, y: .265, s: 1.0, o: .85 },
    'tbtn-band':     { x: .87, y: .055, s: 1.0, o: .8 },
    'tbtn-crouch':   { x: .08, y: .48, s: 1.0, o: .85 },
    'tbtn-sprint':   { x: .08, y: .665, s: 1.0, o: .85 },
    'tbtn-interact': { x: .50, y: .76, s: 1.0, o: .9 },
    'tbtn-map':      { x: .07, y: .088, s: 1.0, o: .85 },
    'tbtn-pause':    { x: .18, y: .088, s: 1.0, o: .85 },
    'tbtn-light':    { x: .50, y: .27, s: 1.0, o: .85 },
    'tbtn-zoom':     { x: .65, y: .43, s: 1.0, o: .85 },
    'tbtn-strike':   { x: .17, y: .30, s: 1.0, o: .85 },
  },
};

/* Layout schema version. v1 = Phase-13…ADS/shield/music builds; v2 = final
 * mobile UX fix (look pad out of the sight zone + HUD lanes). */
export const LAYOUT_VERSION = 2;

/* The v1 landscape defaults, kept verbatim ONLY to recognise a saved layout
 * the player never customised (migration below). Not used for rendering. */
export const LEGACY_LANDSCAPE_V1 = {
  'stick-move':    { x: .16, y: .88, s: .62, o: .6 },
  'stick-look':    { x: .46, y: .50, s: .7, o: .5 },
  'tbtn-fire':     { x: .90, y: .61, s: 1.05, o: .92 },
  'tbtn-ads':      { x: .62, y: .60, s: 1.0, o: .85 },
  'tbtn-jump':     { x: .76, y: .63, s: 1.0, o: .85 },
  'tbtn-reload':   { x: .74, y: .40, s: 1.0, o: .85 },
  'tbtn-mode':     { x: .90, y: .44, s: .8, o: .8 },
  'tbtn-throw':    { x: .74, y: .20, s: 1.0, o: .85 },
  'tbtn-throwbk':  { x: .62, y: .20, s: 1.0, o: .85 },
  'tbtn-shield':   { x: .38, y: .20, s: 1.0, o: .85 },
  'tbtn-ability':  { x: .26, y: .20, s: 1.0, o: .85 },
  'tbtn-switch':   { x: .87, y: .265, s: 1.0, o: .85 },
  'tbtn-band':     { x: .87, y: .055, s: 1.0, o: .8 },
  'tbtn-crouch':   { x: .08, y: .48, s: 1.0, o: .85 },
  'tbtn-sprint':   { x: .08, y: .665, s: 1.0, o: .85 },
  'tbtn-interact': { x: .50, y: .80, s: 1.0, o: .9 },
  'tbtn-map':      { x: .07, y: .088, s: 1.0, o: .85 },
  'tbtn-pause':    { x: .18, y: .088, s: 1.0, o: .85 },
  'tbtn-light':    { x: .50, y: .20, s: 1.0, o: .85 },
  'tbtn-zoom':     { x: .62, y: .40, s: 1.0, o: .85 },
  'tbtn-strike':   { x: .19, y: .34, s: 1.0, o: .85 },
};

/* Portrait: taller ladder. Rails hug the two edges with HUD raised above them
   (see hud.css touch-portrait lift). Buttons sit clear of the weapon card
   (right-bottom) and vitals (left-bottom) at 320×568. */
/* Portrait (320-class): the HUD switches to compact mode under
   `@media (portrait,coarse,≤520px)` in hud.css (minimap hidden → tacmap MAP
   button remains the real map action; weapon card shrinks bottom-center).
   Rails: left = move-stick + crouch/sprint column; right edge = fire/ads;
   small actions form a grid upper-right; reload/jump/interact sit mid-band. */
// FINAL MOBILE UX FIX (v2): measured at 360×780…412×915 the v1 portrait table
// had the look pad in the sight column, MAP/II and the 5-button action row
// overlapping each other, and the weapon card/banner on top of buttons. v2:
// top row MAP·II | compass | LGT·MED; two button columns on each side of the
// narrow sight column (rows y .46/.55/.64); thumbs, FIRE, ADS and JMP at the
// bottom; the weapon card owns the bottom-left corner (hud.css portrait lanes).
DEFAULTS.portrait = {
  'stick-move':    { x: .20, y: .77, s: .92, o: .6 },
  'stick-look':    { x: .53, y: .77, s: .8, o: .5 },
  'tbtn-fire':     { x: .84, y: .76, s: 1.0, o: .92 },
  'tbtn-ads':      { x: .88, y: .925, s: 1.0, o: .85 },
  'tbtn-jump':     { x: .66, y: .925, s: 1.0, o: .85 },
  'tbtn-reload':   { x: .92, y: .64, s: 1.0, o: .85 },
  'tbtn-crouch':   { x: .08, y: .55, s: 1.0, o: .85 },
  'tbtn-sprint':   { x: .08, y: .64, s: 1.0, o: .85 },
  'tbtn-interact': { x: .25, y: .64, s: 1.0, o: .9 },
  'tbtn-band':     { x: .91, y: .055, s: .9, o: .8 },
  'tbtn-switch':   { x: .92, y: .55, s: 1.0, o: .85 },
  'tbtn-throw':    { x: .92, y: .46, s: 1.0, o: .85 },
  'tbtn-throwbk':  { x: .75, y: .46, s: 1.0, o: .85 },
  'tbtn-shield':   { x: .25, y: .55, s: 1.0, o: .85 },
  'tbtn-ability':  { x: .25, y: .46, s: 1.0, o: .85 },
  'tbtn-mode':     { x: .75, y: .64, s: .8, o: .8 },
  'tbtn-map':      { x: .075, y: .055, s: .9, o: .85 },
  'tbtn-pause':    { x: .215, y: .055, s: .9, o: .85 },
  'tbtn-light':    { x: .76, y: .055, s: .9, o: .85 },
  'tbtn-zoom':     { x: .75, y: .55, s: 1.0, o: .85 },
  'tbtn-strike':   { x: .08, y: .46, s: 1.0, o: .85 },
};

/* The v1 portrait defaults, kept verbatim ONLY to recognise an untouched save. */
export const LEGACY_PORTRAIT_V1 = {
  'stick-move':    { x: .17, y: .82, s: 1.0, o: .6 },
  'stick-look':    { x: .70, y: .53, s: .8, o: .5 },
  'tbtn-fire':     { x: .90, y: .79, s: 1.0, o: .92 },
  'tbtn-ads':      { x: .80, y: .93, s: 1.0, o: .85 },
  'tbtn-jump':     { x: .80, y: .66, s: 1.0, o: .85 },
  'tbtn-reload':   { x: .60, y: .72, s: 1.0, o: .85 },
  'tbtn-crouch':   { x: .06, y: .52, s: 1.0, o: .85 },
  'tbtn-sprint':   { x: .06, y: .66, s: 1.0, o: .85 },
  'tbtn-interact': { x: .46, y: .62, s: 1.0, o: .9 },
  'tbtn-band':     { x: .86, y: .13, s: 1.0, o: .8 },
  'tbtn-switch':   { x: .86, y: .26, s: 1.0, o: .85 },
  'tbtn-throw':    { x: .74, y: .26, s: 1.0, o: .85 },
  'tbtn-throwbk':  { x: .62, y: .26, s: 1.0, o: .85 },
  'tbtn-shield':   { x: .50, y: .26, s: 1.0, o: .85 },
  'tbtn-ability':  { x: .38, y: .26, s: 1.0, o: .85 },
  'tbtn-mode':     { x: .86, y: .39, s: .95, o: .8 },
  'tbtn-map':      { x: .07, y: .062, s: 1.0, o: .85 },
  'tbtn-pause':    { x: .18, y: .062, s: 1.0, o: .85 },
  'tbtn-light':    { x: .74, y: .13, s: .95, o: .85 },
  'tbtn-zoom':     { x: .62, y: .13, s: .95, o: .85 },
  'tbtn-strike':   { x: .06, y: .38, s: .95, o: .85 },
};

const MIN_S = 0.6, MAX_S = 2.0, MIN_O = 0.25, MAX_O = 1;

export class ControlLayout {
  constructor() { this.entries = {}; }

  /* default profile for a physical viewport; handed mirrors X */
  static defaults(landscape, leftHanded = false) {
    const table = landscape ? DEFAULTS.landscape : DEFAULTS.portrait;
    const out = {};
    for (const [id, e] of Object.entries(table)) {
      out[id] = { ...e };
      if (leftHanded) out[id].x = 1 - out[id].x;
    }
    return out;
  }

  /** current table is per-viewport-mode: portrait/landscape must re-seed on flip. */
  retable(landscape, leftHanded = false) {
    this.entries = ControlLayout.defaults(landscape, leftHanded);
    return this;
  }

  loadFromStorage() {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || typeof data.entries !== 'object') return false;
      const e = data.entries;
      // Master upgrade: controls added after a layout was saved are simply
      // missing from it — that is NOT corruption. Present entries must be
      // valid; missing ones are seeded later by ensure(). At least one known
      // control must exist or the payload is treated as invalid.
      let known = 0;
      for (const c of CONTROLS) {
        const v = e[c.id];
        if (!v) continue;
        if (![v.x, v.y, v.s, v.o].every(Number.isFinite)) return false;
        known++;
      }
      if (!known) return false;
      this.entries = e;
      this.savedVersion = Number.isFinite(data.v) ? data.v : 1;
      this.migration = null;
      if (this.savedVersion < LAYOUT_VERSION) this.migration = this._migrateV1();
      return true;
    } catch (_) { return false; }
  }

  ensure(landscape, leftHanded) {
    const d = ControlLayout.defaults(landscape, leftHanded);
    for (const c of CONTROLS) if (!this.entries[c.id]) this.entries[c.id] = { ...d[c.id] };
    return this;
  }

  reset(landscape, leftHanded) { this.entries = ControlLayout.defaults(landscape, leftHanded); return this; }

  /* ---------------------------------------------------- v1 → v2 migration --
   * A saved layout stores EVERY control, so "has a saved layout" does not mean
   * "customised". Rules (player customisation always wins):
   *   1. every saved control still equals its v1 landscape OR v1 portrait
   *      default (either hand; values pulled inward by validate()'s safe-area clamp count as
   *      unchanged) → the player never customised → adopt the v2 defaults.
   *   2. otherwise the layout IS customised → nothing moves, EXCEPT an
   *      untouched look pad (exact v1 default position, size and opacity),
   *      which moves to its v2 spot only if that spot is not occupied by one
   *      of the player's own controls.
   * Unknown/extra keys are left exactly as stored. Returns a summary. */
  _migrateV1() {
    const e = this.entries;
    const hands = [false, true];
    // a save is taken in whichever orientation the editor was open in, so an
    // untouched save can match either v1 table
    for (const [legacy, landscape] of [[LEGACY_LANDSCAPE_V1, true], [LEGACY_PORTRAIT_V1, false]]) {
      for (const left of hands) {
        let all = true, seen = 0;
        for (const c of CONTROLS) {
          const v = e[c.id], d = legacy[c.id];
          if (!v || !d) continue;
          seen++;
          if (!ControlLayout._sameAsDefault(v, d, left, c.base, false, landscape)) { all = false; break; }
        }
        if (all && seen) {
          const next = ControlLayout.defaults(landscape, left);
          for (const c of CONTROLS) if (e[c.id]) e[c.id] = { ...next[c.id] };
          return { from: 1, mode: 'defaults', table: landscape ? 'landscape' : 'portrait', leftHanded: left };
        }
      }
    }
    // customised layout: only an untouched look pad may move
    const look = e['stick-look'];
    for (const left of hands) {
      const d = LEGACY_LANDSCAPE_V1['stick-look'];
      if (!look || !ControlLayout._sameAsDefault(look, d, left, 116, true)) continue;
      const target = { ...DEFAULTS.landscape['stick-look'] };
      if (left) target.x = 1 - target.x;
      const blocker = ControlLayout._occupant(e, 'stick-look', target);
      if (blocker) return { from: 1, mode: 'look-kept', blockedBy: blocker };
      e['stick-look'] = target;
      return { from: 1, mode: 'look-moved', leftHanded: left };
    }
    return { from: 1, mode: 'customised-unchanged' };
  }

  /** v === default d (mirrored for left hand). strict: exact only (no clamp slack). */
  static _sameAsDefault(v, d, left, basePx, strict = false, landscape = true) {
    const EPS = 1e-4;
    if (Math.abs(v.s - d.s) > EPS || Math.abs(v.o - d.o) > EPS) return false;
    const dx = left ? 1 - d.x : d.x;
    const axis = (val, def, longAxis) => {
      if (Math.abs(val - def) <= EPS) return true;
      if (strict) return false;
      // validate() can only pull a control INWARD from an edge it overhangs,
      // by at most half its size + the safe-area inset on that axis. Bound the
      // slack by real phone geometry: long axis ≥ 568 px with ≤ 60 px inset
      // (notch side), short axis ≥ 320 px with ≤ 34 px inset (home bar).
      // Anything moved further than that is a player customisation.
      const margin = ((basePx * d.s) / 2 + (longAxis ? 60 : 34)) / (longAxis ? 568 : 320);
      if (def < margin && val > def && val <= margin) return true;
      if (def > 1 - margin && val < def && val >= 1 - margin) return true;
      return false;
    };
    return axis(v.x, dx, landscape) && axis(v.y, d.y, !landscape);
  }

  /** id of a saved control whose footprint overlaps `pos` (reference 844×390 phone). */
  static _occupant(entries, selfId, pos) {
    const W = 844, H = 390;
    const self = CONTROLS.find(c => c.id === selfId);
    const r0 = (self.base * pos.s) / 2;
    for (const c of CONTROLS) {
      if (c.id === selfId) continue;
      const v = entries[c.id]; if (!v) continue;
      const r = (c.base * v.s) / 2;
      if (Math.abs(v.x * W - pos.x * W) < r + r0 && Math.abs(v.y * H - pos.y * H) < r + r0) return c.id;
    }
    return null;
  }

  save() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ v: LAYOUT_VERSION, entries: this.entries })); return true; }
    catch (_) { return false; }
  }

  /* clamp everything into the current viewport rect (CSS px), safe-area aware.
   * Returns the number of controls whose position had to be nudged. */
  validate(vw, vh, inset = { t: 0, r: 0, b: 0, l: 0 }, basePxFor = () => 56) {
    let nudged = 0;
    for (const c of CONTROLS) {
      const e = this.entries[c.id]; if (!e) continue;
      e.s = Math.min(MAX_S, Math.max(MIN_S, e.s));
      e.o = Math.min(MAX_O, Math.max(MIN_O, e.o));
      const half = (basePxFor(c.id) * e.s) / 2;
      const minX = (inset.l + half) / vw, maxX = (vw - inset.r - half) / vw;
      const minY = (inset.t + half) / vh, maxY = (vh - inset.b - half) / vh;
      const nx = Math.min(Math.max(e.x, minX), Math.max(minX, maxX));
      const ny = Math.min(Math.max(e.y, minY), Math.max(minY, maxY));
      if (nx !== e.x || ny !== e.y) { e.x = nx; e.y = ny; nudged++; }
    }
    return nudged;
  }
}

/* Pixel-safe-area snapshot for validation */
export function safeInsets() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);' +
    'padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const v = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
  probe.remove();
  return v;
}
