/**
 * firing_input_tests.mjs — Part A of the "one click = one shot" fix.
 *
 * These are *input-layer* tests. The v4.2 ammunition suite drove
 * `WeaponSystem.tryFire()` directly, which is why it stayed green while a real
 * mouse click produced three shots: the defect lived between the DOM listener and
 * tryFire, in a layer no test touched. Everything here goes through the SHIPPED
 * pipeline — the real `Game.prototype._bindInput` listeners and the real
 * `Game.prototype._fireStep`, plus the real `WeaponSystem` — by dispatching actual
 * mousedown/mouseup events at them and reading back `stats.shots` and the real
 * magazine/reserve state. Nothing is asserted from a display value.
 *
 * Run: node --loader ./tests/progress_test_loader.mjs tests/firing_input_tests.mjs
 */
import assert from 'node:assert/strict';
import { Game, GameState } from '../js/game.js';
import { WeaponSystem, WEAPON_DEFS, WEAPON_ORDER } from '../js/weapons.js';
import { FIRE_INPUT } from '../js/fireinput.js';
import { results, check, makeGame } from './world_harness.mjs';

/** A document that really records listeners, so the real binding code can be driven. */
function makeDoc(domEl) {
  const reg = new Map();
  return {
    pointerLockElement: domEl,
    addEventListener(type, fn) { if (!reg.has(type)) reg.set(type, []); reg.get(type).push(fn); },
    removeEventListener(type, fn) { const a = reg.get(type) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    body: { classList: { add() {}, remove() {}, toggle() {} } },
    documentElement: { style: {}, requestFullscreen: null },
    __fire(type, ev) { for (const fn of (reg.get(type) || []).slice()) fn(ev); },
    __count(type) { return (reg.get(type) || []).length; },
  };
}
const mouseEv = (button) => ({ type: '', button, target: { closest: () => null }, preventDefault() {} });

/**
 * A world in which one `click()` is a real browser event sequence:
 * mousedown → N simulated frames → mouseup, then the shipped per-frame fire step.
 */
function rig({ id = 'vx4', mode = 'semi', fps = 60, mag, reserve, autoHoldMs, jamFree = false } = {}) {
  const g = makeGame('facility');
  const ws = new WeaponSystem(g);
  g.weapons = ws;
  g.stats.shots = 0;
  if (g.characters) {
    g.characters.liveReloadMult = () => 1;
    g.characters.abilityMult = () => 1;
    g.characters.liveSpeedMult = () => 1;
  }
  const domEl = { id: 'gl', closest: () => null, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, style: {} };
  Object.assign(g, {
    renderer: { domElement: domEl },
    state: GameState.PLAYING,
    _touchPrimary: false,
    device: { isDesktop: true },
    vehicleMode: null, interactTarget: null,
    tacmap: { open: false },
    _requestLock() {}, _unlockAudioOnce() {}, pause() {}, resume() {},
    shieldPressStart() {}, shieldPressEnd() {}, onResize() {},
    settings: Object.assign({ adsKey: 'KeyX', sensitivity: 1, aimSens: 0.8 },
      autoHoldMs === undefined ? {} : { autoHoldMs }),
  });
  const doc = makeDoc(domEl);
  const prevDoc = globalThis.document;
  globalThis.document = doc;
  try {
    Game.prototype._bindInput.call(g);                 // the real listeners
    g._fireStep = Game.prototype._fireStep.bind(g);  // the real per-frame fire step
  } finally { globalThis.document = prevDoc; }

  const def = WEAPON_DEFS[id];
  ws.select(id);
  const st = ws.state[id];
  st.fireMode = mode;
  st.mag = mag === undefined ? def.magSize : mag;
  st.reserve = reserve === undefined ? (def.noReload ? 0 : def.startReserve) : reserve;

  const dt = 1 / fps;
  const shotsBefore = g.stats.shots;
  const ammoBefore = st.mag + st.reserve;
  let dryFires = 0;
  g.audio.dryFire = () => { dryFires++; };
  const chargeLog = [];
  const realSpend = ws.spendRound.bind(ws);
  ws.spendRound = (wid) => { const ok = realSpend(wid); if (ok) chargeLog.push(g.time); return ok; };

  // Warm off the draw animation: select() legitimately leaves state_ 'drawing',
  // during which a click is swallowed rather than banked. Time-based, because the
  // same frame count is a different duration at 60 and 144 Hz.
  const step = () => {
    g.time += dt;
    g._fireStep(dt);
    ws.update(dt, g.time, g.player);
    g.player.update(dt, g.input);
    // Weapons roll for a stoppage after every shot (js/weapons.js:1734). The
    // counting checks measure the click → shot relation, so they opt out of that
    // random truncation; a blocked shot costing nothing is F15's job.
    if (jamFree) st.malf = false;
  };
  for (let i = 0; i < Math.max(90, Math.round(2.0 * fps)); i++) step();

  const frames = (n) => { for (let i = 0; i < n; i++) step(); };
  // The shipped handlers read the *global* document (pointer-lock check included),
  // so a dispatch has to run with this rig's document installed. That is the point:
  // the real guard code decides whether the press reaches the trigger.
  const withDoc = (fn) => { const prev = globalThis.document; globalThis.document = doc; try { fn(); } finally { globalThis.document = prev; } };
  const press = () => withDoc(() => doc.__fire('mousedown', mouseEv(0)));
  const release = () => withDoc(() => doc.__fire('mouseup', mouseEv(0)));
  /** One physical click: held for `holdFrames`, then `gapFrames` of nothing. */
  const click = (holdFrames = 2, gapFrames = 8) => {
    press();
    frames(holdFrames);
    release();
    frames(gapFrames);
  };
  return {
    g, ws, st, def, doc, dt, fps, press, release, frames, click, chargeLog, withDoc,
    dryFires: () => dryFires,
    shots: () => g.stats.shots - shotsBefore,
    rounds: () => ammoBefore - (st.mag + st.reserve),
  };
}

const modesOf = (def) => def.fireModes || [def.auto ? 'auto' : 'semi'];
const burstLen = (def) => Math.max(1, def.burstCount || 3);

// ---------------------------------------------------------------------------
// 1. One click = one shot, one round — across the whole weapon table.
// ---------------------------------------------------------------------------
check('F1. one mouse click produces exactly one shot, every weapon × mode × click length', () => {
  const bad = [];
  let cases = 0;
  for (const id of WEAPON_ORDER) {
    const def = WEAPON_DEFS[id];
    for (const mode of modesOf(def)) {
      for (const fps of [60, 144]) {
        // Click lengths only — a press at or under the auto-engage window. Past it the
        // player is holding, and F9/F14 measure that against the weapon's RPM.
        for (const hold of fps === 60 ? [1, 2, 4, 9, 14] : [2, 6, 12, 20, 30]) {
          const r = rig({ id, mode, fps, jamFree: true });
          r.click(hold, 8);
          r.frames(90);                        // let an armed burst finish
          cases++;
          // A burst is one *firing event* that spends the weapon's configured
          // number of rounds; semi and auto fire a single round per click.
          const want = mode === 'burst' ? burstLen(def) : 1;
          if (r.shots() !== want || r.rounds() !== want) {
            bad.push(`${id}/${mode}@${fps}:${hold}f→${r.shots()} shots, ${r.rounds()} rounds (want ${want})`);
          }
        }
      }
    }
  }
  assert.equal(bad.length, 0, `${bad.length}/${cases} cases wrong: ${bad.slice(0, 6).join('; ')}`);
  return `${cases} click cases — one firing event per click (one shot, or exactly one configured burst), never more`;
});

check('F2. one click charges ammunition exactly once — one charge point, no per-pellet or per-effect debit', () => {
  const bad = [];
  for (const id of WEAPON_ORDER) {
    const def = WEAPON_DEFS[id];
    for (const mode of modesOf(def)) {
      const r = rig({ id, mode, jamFree: true });
      r.click(3, 6);
      r.frames(60);
      const want = mode === 'burst' ? burstLen(def) : 1;
      if (r.chargeLog.length !== want || r.rounds() !== want || r.shots() !== want) {
        bad.push(`${id}/${mode}: charges ${r.chargeLog.length}, rounds ${r.rounds()}, shots ${r.shots()} (want ${want})`);
      }
    }
  }
  assert.equal(bad.length, 0, bad.slice(0, 6).join('; '));
  const sg = rig({ id: 'st12', mode: 'semi', jamFree: true });
  sg.click(2, 6);
  assert.equal(sg.shots(), 1, `a shotgun click is one discharge (got ${sg.shots()})`);
  assert.equal(sg.rounds(), 1, `and one shell, not one per pellet (got ${sg.rounds()})`);
  return `12 weapons: charges === shots === rounds; ST-12 1 discharge, 1 shell, ${WEAPON_DEFS.st12.pellets || 9} pellets`;
});

// ---------------------------------------------------------------------------
// 2. The reported ladder and the twenty-click requirement, counted in clicks.
// ---------------------------------------------------------------------------
check('F3. the reported ladder, counted in clicks: 300 → 299 → 298 → 290 → 280 → 200', () => {
  const seen = [];
  for (const mode of ['semi', 'auto']) {
    const r = rig({ id: 'vx4', mode, jamFree: true });
    const marks = [[1, 299], [2, 298], [10, 290], [20, 280], [100, 200]];
    let done = 0;
    for (const [clicks, expect] of marks) {
      for (let i = done; i < clicks; i++) r.click(2, 8);
      done = clicks;
      const left = r.st.mag + r.st.reserve;
      assert.equal(left, expect, `${mode}: after ${clicks} clicks expected ${expect} rounds, got ${left}`);
      assert.equal(r.shots(), clicks, `${mode}: ${clicks} clicks produced ${r.shots()} shots`);
      assert.equal(r.rounds(), clicks, `${mode}: ${clicks} clicks consumed ${r.rounds()} rounds`);
      seen.push(`${mode}:${clicks}→${left}`);
    }
  }
  // The same ladder for one weapon of EVERY category, in each of its
  // non-burst fire modes: the 1:1 rule has to hold for pistols, SMGs,
  // shotguns (many pellets, one shell) and the belt-fed LMG alike.
  const byClass = new Map();
  for (const id of WEAPON_ORDER) {
    const key = WEAPON_DEFS[id].klass || id;
    if (!byClass.has(key)) byClass.set(key, id);
  }
  // One click, measured fairly: wait until the weapon itself says it can accept a
  // trigger press, press, release, and wait for the discharge to land. Spacing
  // clicks by a fixed frame count instead would land presses inside e.g. the
  // MR-7's 0.5 s semi delay, where a click is *correctly* dropped and not banked
  // (F11) — that would measure the cycle time, not the click→shot relation.
  const oneClick = (r) => {
    const want = r.shots() + 1;
    let guard = 0;
    while (!r.ws.canAcceptTriggerAt(r.g.time) && guard++ < 600) r.frames(1);
    r.press();
    r.frames(2);
    r.release();
    guard = 0;
    while (r.shots() < want && guard++ < 180) r.frames(1);
    r.frames(2);
  };
  for (const [klass, id] of byClass) {
    const def = WEAPON_DEFS[id];
    // 300 rounds carried in the magazine itself: an empty mag mid-ladder would
    // start an auto-reload, and a press during a reload is swallowed on purpose
    // (that is F11/F12's rule, measured there). Here the question is only
    // whether N clicks pay for N rounds.
    const mag = 300;
    for (const mode of modesOf(def).filter((m) => m !== 'burst')) {
      const r = rig({ id, mode, mag, reserve: 0, fps: 60, jamFree: true });
      assert.equal(r.st.mag + r.st.reserve, 300, `${klass}/${mode}: loadout is not 300 rounds`);
      let done = 0;
      for (const [clicks, expect] of [[1, 299], [2, 298], [10, 290], [20, 280], [100, 200]]) {
        for (let i = done; i < clicks; i++) oneClick(r);
        done = clicks;
        const left = r.st.mag + r.st.reserve;
        assert.equal(left, expect, `${def.name} ${klass} ${mode}: ${clicks} clicks left ${left} rounds`);
        assert.equal(r.shots(), clicks, `${def.name} ${mode}: ${clicks} clicks fired ${r.shots()} shots`);
        assert.equal(r.rounds(), clicks, `${def.name} ${mode}: ${clicks} clicks charged ${r.rounds()} rounds`);
      }
      seen.push(`${def.name}/${mode}:300→200 in 100`);
    }
  }
  return seen.join(' ');
});

check('F4. twenty separate clicks = twenty shots and twenty rounds', () => {
  const notes = [];
  // Burst is excluded deliberately: one press arms a fixed 3-round burst that is
  // allowed to finish after release. That is the weapon's fire mode (counted
  // exactly in F1/F2/F14), not a click firing more than once.
  for (const id of ['vx4', 'p9', 'cr9', 'st12', 'mpx5']) {
    for (const mode of modesOf(WEAPON_DEFS[id]).filter((m) => m !== 'burst')) {
      const r = rig({ id, mode, mag: 999, reserve: 0, jamFree: true });
      // Clicks spaced at the weapon's own cadence (ST-12 fires one shot per 0.36 s,
      // so a fixed 9-frame gap would be measuring the cadence, not the input path).
      const interval = mode === 'semi' && WEAPON_DEFS[id].semiDelay ? WEAPON_DEFS[id].semiDelay : 60 / WEAPON_DEFS[id].rpm;
      const gap = Math.ceil(interval * 60) + 4;
      for (let i = 0; i < 20; i++) r.click(2, gap);
      assert.equal(r.shots(), 20, `${id}/${mode}: 20 clicks → ${r.shots()} shots`);
      assert.equal(r.rounds(), 20, `${id}/${mode}: 20 clicks → ${r.rounds()} rounds consumed`);
      assert.equal(r.chargeLog.length, 20, `${id}/${mode}: ${r.chargeLog.length} charges for 20 shots`);
      notes.push(`${id}/${mode}`);
    }
  }
  return `verified for ${notes.length} weapon/mode pairs (${notes.join(', ')})`;
});

// ---------------------------------------------------------------------------
// 3. The listener layer: no duplication, and re-initialisation is harmless.
// ---------------------------------------------------------------------------
check('F5. repeated initialization cannot multiply listeners or fire events', () => {
  const r = rig({ id: 'vx4', mode: 'semi' });
  const before = {
    down: r.doc.__count('mousedown'), up: r.doc.__count('mouseup'),
    move: r.doc.__count('mousemove'), key: r.doc.__count('keydown'),
  };
  const prevDoc = globalThis.document;
  globalThis.document = r.doc;
  try { Game.prototype._bindInput.call(r.g); Game.prototype._bindInput.call(r.g); }
  finally { globalThis.document = prevDoc; }
  const after = {
    down: r.doc.__count('mousedown'), up: r.doc.__count('mouseup'),
    move: r.doc.__count('mousemove'), key: r.doc.__count('keydown'),
  };
  assert.deepEqual(after, before, `listener counts changed on re-init: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  assert.equal(r.g._rebindCount, 2, 'the guard should record that rebinding was attempted twice');
  r.press();
  assert.equal(r.g._fireInput.presses, 1, `one dispatch must count exactly one press (got ${r.g._fireInput.presses})`);
  r.frames(2);
  r.release();
  r.frames(8);
  assert.equal(r.shots(), 1, `one dispatch after three bind attempts produced ${r.shots()} shots`);
  return `mousedown/mouseup/mousemove/keydown stayed at ${after.down}/${after.up}/${after.move}/${after.key} across 3 bind calls, 1 shot`;
});

check('F6. a duplicate or stuck mousedown for a held button adds no second event', () => {
  const r = rig({ id: 'vx4', mode: 'auto' });
  r.press();
  r.press();                       // resend / synthetic re-entry, no mouseup between
  r.press();
  r.frames(4);
  r.release();
  r.frames(12);
  assert.equal(r.shots(), 1, `three mousedowns for one press produced ${r.shots()} shots`);
  assert.equal(r.rounds(), 1, `and ${r.rounds()} rounds consumed`);
  return 'press() is idempotent per physical press (deduped by source)';
});

check('F7. mouse, touch and aim-assist inputs cannot double-fire the same action', () => {
  const r = rig({ id: 'vx4', mode: 'semi' });
  r.press();                                       // mouse
  r.g._fireInput.press('touch', r.g.time);         // touch fire button, same instant
  r.frames(3);
  r.release();
  r.g._fireInput.release('touch');
  r.frames(10);
  assert.equal(r.shots(), 1, `two sources pressed together produced ${r.shots()} shots`);
  // A second source arriving while one is already held must not bank a shot either.
  const r2 = rig({ id: 'vx4', mode: 'auto' });
  r2.press();
  r2.frames(2);
  r2.g._fireInput.press('touch', r2.g.time);
  r2.frames(2);
  r2.release();
  r2.g._fireInput.release('touch');
  r2.frames(60);
  assert.equal(r2.shots(), 1, `a coincidental second source banked extra shots (${r2.shots()})`);
  return 'one firing event per physical press, whatever the number of input sources';
});

// ---------------------------------------------------------------------------
// 4. Semi vs automatic semantics.
// ---------------------------------------------------------------------------
check('F8. a semi-automatic click cannot repeat, however long the button is held', () => {
  const r = rig({ id: 'p9', mode: 'semi', mag: 999, reserve: 0, jamFree: true });
  r.press();
  r.frames(60 * 10);              // ten seconds, never released
  assert.equal(r.shots(), 1, `a 10 s semi press fired ${r.shots()} times`);
  r.release();
  r.frames(6);
  assert.equal(r.shots(), 1, 'release must not add one either');
  for (let i = 0; i < 9; i++) r.click(3, 9);
  assert.equal(r.shots(), 10, `10 presses total → ${r.shots()} shots`);
  return 'P9 semi: 1 shot per press; a 10 s hold is still 1 shot; 10 presses → 10 shots';
});

check('F9. holding automatic fire keeps firing at the weapon RPM; releasing stops it', () => {
  const def = WEAPON_DEFS.vx4;
  const eff = Math.max(60 / def.rpm, 1 / 60);      // a frame boundary cannot be finer than dt
  const engage = FIRE_INPUT.AUTO_ENGAGE_S;
  const measure = (holdSec) => {
    const r = rig({ id: 'vx4', mode: 'auto', mag: 9999, reserve: 0, jamFree: true });
    r.press();
    r.frames(Math.round(holdSec * 60));
    r.release();
    r.frames(30);
    return { shots: r.shots(), rounds: r.rounds() };
  };
  const click = measure(0.20);                       // a click, under the engage window
  const slowClick = measure(0.24);
  const hold = measure(1.0);
  assert.equal(click.shots, 1, `a 200 ms press fired ${click.shots} times — a click must not read as a hold`);
  assert.equal(slowClick.shots, 1, `a 240 ms press fired ${slowClick.shots} times`);
  const expectHold = 1 + Math.floor((1.0 - engage) / eff);
  // Realised cadence is frame-quantised (nextShotAt is crossed on a frame edge), so
  // the honest claim is "consistent with the RPM", not an exact shot count.
  const ideal = def.rpm / 60;
  assert.ok(hold.shots >= Math.floor(ideal * 0.6) && hold.shots <= Math.ceil(ideal * 1.15),
    `1 s auto hold fired ${hold.shots} shots at ${def.rpm} RPM (ideal ~${ideal.toFixed(1)}/s, frame-quantised expect ~${expectHold})`);
  assert.equal(hold.rounds, hold.shots, 'the auto hold consumed exactly one round per shot');
  const r = rig({ id: 'vx4', mode: 'auto', mag: 9999, reserve: 0, jamFree: true });
  r.press(); r.frames(48);
  const atRelease = r.shots();
  r.release(); r.frames(90);
  assert.equal(r.shots(), atRelease, `firing continued after release (${atRelease} → ${r.shots()})`);
  assert.equal(r.g.input.mouse0, false, 'the held flag is cleared by mouseup');
  return `200 ms click → 1 shot · 1 s hold → ${hold.shots} shots (expect ~${expectHold}) · release stops at ${atRelease}`;
});

// ---------------------------------------------------------------------------
// 5. Blocked shots, empty magazine, reloads, stoppages.
// ---------------------------------------------------------------------------
check('F10. an empty magazine cannot fire, and a click on empty is free', () => {
  const r = rig({ id: 'p9', mode: 'semi', mag: 0, reserve: 0 });
  const dry0 = r.dryFires();
  for (let i = 0; i < 5; i++) r.click(2, 8);
  assert.equal(r.shots(), 0, `fired ${r.shots()} times with an empty weapon`);
  assert.equal(r.rounds(), 0, 'and consumed nothing');
  assert.ok(r.st.mag >= 0 && r.st.reserve >= 0, 'no negative stores');
  assert.ok(r.dryFires() > dry0, 'the player still hears the dry click');
  return `5 clicks on empty: 0 shots, 0 rounds, ${r.dryFires() - dry0} dry-click sounds`;
});

check('F11. a shot that cannot happen consumes nothing and is not banked for later', () => {
  // (a) pressed during a reload: swallowed, not queued behind the animation
  const r = rig({ id: 'p9', mode: 'semi', mag: 0, reserve: 60 });
  r.click(2, 2);                       // empty → the dry press starts the reload
  assert.equal(r.ws.state_, 'reloading', `a dry press should have begun a reload (state ${r.ws.state_})`);
  const roundsAtClick = r.rounds();
  r.press(); r.release();              // a click pressed mid-reload
  r.frames(4 * 60);                    // ride the reload out (dry reloads are slowest)
  assert.equal(r.shots(), 0, `a click during reload fired ${r.shots()} times`);
  assert.equal(r.rounds(), roundsAtClick, 'and it must not have charged anything');
  assert.equal(r.ws.state_, 'ready', 'the reload still completed');
  // (b) while the trigger is blocked (knockdown / map open / not playing)
  const r2 = rig({ id: 'vx4', mode: 'semi' });
  r2.g.player.canFire = () => false;
  for (let i = 0; i < 4; i++) r2.click(2, 6);
  assert.equal(r2.shots(), 0, `${r2.shots()} shots while the player cannot fire`);
  assert.equal(r2.rounds(), 0, 'no ammunition charged while blocked');
  r2.g.player.canFire = () => true;
  r2.frames(8);
  assert.equal(r2.shots(), 0, 'a blocked click must not pay itself out when the block lifts');
  const r3 = rig({ id: 'vx4', mode: 'auto' });
  r3.g.state = GameState.PAUSED;
  for (let i = 0; i < 3; i++) r3.click(2, 6);
  assert.equal(r3.shots(), 0, 'no shots while not playing');
  assert.equal(r3.rounds(), 0, 'no rounds consumed while not playing');
  return 'reload, knockdown and pause each swallow the click outright — 0 rounds, nothing banked';
});

check('F12. reload accounting survives the new pipeline: dry press → reload → exact transfer', () => {
  const def = WEAPON_DEFS.p9;
  const r = rig({ id: 'p9', mode: 'semi', mag: def.magSize, reserve: def.startReserve, jamFree: true });
  const start = def.magSize + def.startReserve;
  for (let i = 0; i < def.magSize; i++) r.click(2, 10);      // empty it, click by click
  assert.equal(r.shots(), def.magSize, `${r.shots()} shots for ${def.magSize} clicks`);
  assert.equal(r.st.mag, 0, 'the magazine is empty');
  r.click(2, 4);                                              // the dry press reloads
  assert.equal(r.ws.state_, 'reloading', 'reload engaged from a click on an empty weapon');
  r.frames(240);
  assert.equal(r.ws.state_, 'ready', 'reload completed');
  assert.equal(r.st.mag, def.magSize, `magazine refilled to ${r.st.mag}/${def.magSize}`);
  assert.equal(start - (r.st.mag + r.st.reserve), def.magSize, `${def.magSize} rounds spent in total, no leak`);
  return `P9: ${def.magSize} clicks → ${def.magSize} rounds, reload moved ${r.st.mag}/${def.magSize} with ${r.st.reserve} in hand`;
});

check('F13. rapid clicking: never more shots than clicks, and no click lost when spaced at the cadence', () => {
  const def = WEAPON_DEFS.vx4;
  const intervalFrames = Math.ceil((60 / def.rpm) * 60) + 1;   // frames per shot at 60 Hz
  const r = rig({ id: 'vx4', mode: 'semi', mag: 999, reserve: 0, jamFree: true });
  for (let i = 0; i < 24; i++) r.click(2, intervalFrames + 2);
  assert.equal(r.shots(), 24, `${r.shots()} shots for 24 clicks spaced ${intervalFrames + 2}f`);
  assert.equal(r.rounds(), 24, `${r.rounds()} rounds for 24 shots`);
  // Far below the cadence the queue drains at the weapon's rate: shots may be
  // fewer than clicks, never more, and the bank is bounded (no burst later).
  const fast = rig({ id: 'vx4', mode: 'semi', mag: 999, reserve: 0, jamFree: true });
  for (let i = 0; i < 40; i++) fast.click(1, 1);
  assert.ok(fast.shots() <= 40, `${fast.shots()} shots from 40 clicks — more shots than clicks`);
  assert.ok(fast.shots() >= Math.floor(80 / intervalFrames) - 1,
    `only ${fast.shots()} of 40 fast clicks registered in 80 frames (cadence 1 per ${intervalFrames}f)`);
  assert.equal(fast.rounds(), fast.shots(), 'every registered shot charged exactly one round');
  assert.ok(fast.g._fireInput.pending <= 2, 'overflow is dropped, never banked into a future burst');
  return `spaced: 24/24 · 40 clicks at 33 ms → ${fast.shots()} shots, ${fast.rounds()} rounds, never more shots than clicks`;
});

check('F14. fire modes and RPM are unchanged by the input fix', () => {
  const notes = [];
  const perWeaponRate = {};
  for (const id of WEAPON_ORDER) {
    const def = WEAPON_DEFS[id];
    const modes = modesOf(def);
    for (const mode of modes) {
      const r = rig({ id, mode, mag: 9999, reserve: 9999, jamFree: true });
      r.click(2, 8);
      r.frames(60);
      const want = mode === 'burst' ? burstLen(def) : 1;
      assert.equal(r.shots(), want, `${id} in ${mode}: one click gave ${r.shots()} shots (want ${want})`);
    }
    notes.push(`${id}:${modes.join('/')}`);
    if (modes.includes('semi')) {
      const s = rig({ id, mode: 'semi', mag: 9999, reserve: 0, jamFree: true });
      s.press(); s.frames(120);
      assert.equal(s.shots(), 1, `${id} semi repeated within one press (${s.shots()} shots)`);
      s.release();
    }
    if (modes.includes('auto')) {
      const a = rig({ id, mode: 'auto', mag: 9999, reserve: 9999, jamFree: true });
      a.press();
      a.frames(180);
      a.release();
      const ideal = def.rpm / 60 * 3.0;            // what RPM implies across a 3 s hold
      assert.ok(a.shots() >= Math.floor(ideal * 0.55) && a.shots() <= Math.ceil(ideal * 1.1),
        `${id} auto held 3 s → ${a.shots()} shots; RPM ${def.rpm} implies ~${ideal.toFixed(0)} before the hold engages and frame quantisation`);
      perWeaponRate[id] = a.shots() / 3;
      notes.push(`${id}auto ${a.shots()}/3s`);
    }
  }
  // A faster weapon must not end up slower than a slower one: that would mean the
  // pipeline was flattening the table it is supposed to preserve.
  const byRpm = WEAPON_ORDER.filter((id) => perWeaponRate[id]).sort((x, y) => WEAPON_DEFS[y].rpm - WEAPON_DEFS[x].rpm);
  for (let i = 1; i < byRpm.length; i++) {
    const a = byRpm[i - 1], b = byRpm[i];
    assert.ok(perWeaponRate[a] >= perWeaponRate[b] - 0.5,
      `${a} (${WEAPON_DEFS[a].rpm} RPM) managed ${perWeaponRate[a].toFixed(1)}/s but the slower ${b} (${WEAPON_DEFS[b].rpm} RPM) managed ${perWeaponRate[b].toFixed(1)}/s`);
  }
  return `12 weapons keep their modes; auto rates still track RPM (${byRpm.slice(0, 3).map((id) => `${id} ${perWeaponRate[id].toFixed(1)}/s @ ${WEAPON_DEFS[id].rpm} RPM`).join(', ')})`;
});

check('F15. a stoppage (jam) blocks the shot and costs no round; racking clears it', () => {
  const r = rig({ id: 'p9', mode: 'semi' });
  r.click(2, 6);
  const afterShot = r.st.mag + r.st.reserve;
  assert.equal(r.shots(), 1, 'the first click fired');
  r.st.malf = true;                       // force the state the per-shot roll can produce
  const before = r.shots();
  for (let i = 0; i < 5; i++) r.click(2, 6);
  assert.equal(r.shots(), before, `a jammed weapon fired ${r.shots() - before} extra times`);
  assert.equal(r.st.mag + r.st.reserve, afterShot, 'and charged nothing while jammed');
  // R: the frame loop turns `input.reloadPressed` into `weapons.startReload()`
  // (js/game.js:2468-2472), and that is the action which racks a stoppage clear
  // (js/weapons.js:1464). Called directly here because this rig drives the weapon
  // step, not the whole game frame.
  r.ws.startReload();
  r.frames(240);
  assert.equal(r.ws.state_, 'ready', 'the action completed');
  assert.equal(r.st.malf, false, 'and it cleared the stoppage');
  r.click(2, 8);
  assert.equal(r.shots(), before + 1, 'and the next click fires normally again');
  return '5 clicks while jammed: 0 shots, 0 rounds; R clears it; the next click fires';
});

check('F16. a click on an open tactical map cannot fire the weapon or steal the cursor', () => {
  const r = rig({ id: 'vx4', mode: 'auto', mag: 999, reserve: 0, jamFree: true });
  // The map panel is open: pointer lock is released and the cursor belongs to it.
  r.g.tacmap = { open: true, mode: '2d' };
  let lockCalls = 0;
  r.g._requestLock = () => { lockCalls++; };
  const before = r.shots();
  r.press();                       // real mousedown through the real handler
  r.frames(20);                    // held long enough to engage auto fire if it could
  assert.equal(r.g.input.mouse0, false, 'mousedown while the map was open latched the trigger');
  assert.equal(lockCalls, 0, 'a map click re-grabbed pointer lock, hiding the cursor from the map');
  r.release();
  r.g.tacmap.open = false;
  r.frames(20);
  assert.equal(r.shots(), before, 'a click on the open map fired the weapon');
  // and the very next real click fires exactly once
  r.click(2, 8);
  assert.equal(r.shots(), before + 1, `after closing the map a click fired ${r.shots() - before} times (want 1)`);
  return 'mousedown while the map was open: no trigger press, no pointer-lock grab; first click after closing fires once';
});

// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.ok).length;
console.log('\n' + '='.repeat(66));
console.log(`${passed}/${results.length} firing-input tests passed`);
console.log('='.repeat(66));
if (passed !== results.length) process.exitCode = 1;
