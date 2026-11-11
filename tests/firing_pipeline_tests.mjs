/**
 * firing_pipeline_tests.mjs — the pre-fix mechanism, kept as a pin (v4.3).
 *
 * The reported defect was "one click, three bullets". The cause is the cadence
 * layer: `tryFire(now, triggerDown)` decides whether to shoot from the LEVEL of
 * the trigger for automatic fire, so feeding it a held boolean once per frame —
 * which is exactly what v4.2 and earlier did with `input.mouse0` — turns a
 * 250 ms click into floor(0.25 / (60/rpm)) + 1 shots.
 *
 * This file drives `tryFire` the OLD way (a raw held boolean, no FireTriggerInput
 * anywhere) so those numbers stay measured facts rather than folklore, and then
 * drives the SAME holds the shipped way (press/release through `FireTriggerInput`
 * and `Game.prototype._fireStep`) to pin the contrast: a click is one shot, a
 * hold is still automatic fire at the weapon's RPM.
 *
 * The full input-layer suite (real DOM listeners, every weapon and mode, the
 * 300-round ladder, listener duplication, touch/assist, map-open clicks) is
 * tests/firing_input_tests.mjs — 16 checks, F1..F16.
 *
 * Run: node --loader ./tests/progress_test_loader.mjs tests/firing_pipeline_tests.mjs
 */
import assert from 'node:assert/strict';
import { Game, GameState } from '../js/game.js';
import { WeaponSystem, WEAPON_DEFS } from '../js/weapons.js';
import { FireTriggerInput } from '../js/fireinput.js';
import { results, check, makeGame } from './world_harness.mjs';

const FPS = 60;
const DT = 1 / FPS;

/**
 * A world whose trigger is driven however the caller asks.
 * `hold(n)` is the pre-fix contract (level-driven, `tryFire(now, true)`);
 * `click()`/`holdShipped()` are the v4.3 contract (discrete event + held state
 * through the shipped per-frame fire step).
 */
function rig({ id = 'vx4', mode = 'auto' } = {}) {
  const g = makeGame('facility');
  const ws = new WeaponSystem(g);
  g.weapons = ws;
  g.stats.shots = 0;
  if (g.characters) {
    g.characters.liveReloadMult = () => 1;
    g.characters.abilityMult = () => 1;
    g.characters.liveSpeedMult = () => 1;
  }
  Object.assign(g, {
    state: GameState.PLAYING,
    tacmap: { open: false },
    input: Object.assign({}, g.input, { mouse0: false, mouse2: false }),
    _fireInput: new FireTriggerInput(),
  });
  g._fireStep = Game.prototype._fireStep.bind(g);

  const def = WEAPON_DEFS[id];
  ws.select(id);
  const st = ws.state[id];
  st.fireMode = mode;
  st.mag = 300;
  st.reserve = 0;

  const step = () => {
    g.time += DT;
    ws.update(DT, g.time, g.player);
    g.player.update(DT, g.input);
    st.malf = false;                 // the shot/click relation is what is measured here
  };
  // Warm off the draw animation: select() leaves state_ 'drawing' for a moment, and
  // a press inside it is swallowed rather than banked. Time-based, because the same
  // frame count is a different duration at 60 and 144 Hz (same rule as F-suite).
  for (let i = 0; i < Math.max(120, Math.round(2.5 * FPS)); i++) step();
  // ...and let the trigger go up once: `triggerBlockedUntilRelease` is only
  // cleared on a frame where the trigger is released, exactly as a real click does.
  for (let i = 0; i < 3; i++) { step(); ws.tryFire(g.time, false); g._fireStep(DT); }
  const base = { shots: g.stats.shots, rounds: 300 - (st.mag + st.reserve) };
  return {
    g, ws, st, def, dt: DT,
    shots: () => g.stats.shots - base.shots,
    rounds: () => (300 - (st.mag + st.reserve)) - base.rounds,
    /** pre-fix: the trigger is just a held boolean sampled every frame */
    hold(frames) {
      for (let i = 0; i < frames; i++) { step(); ws.tryFire(g.time, true); }
    },
    unhold(frames) { for (let i = 0; i < frames; i++) { step(); ws.tryFire(g.time, false); } },
    /** shipped: discrete press, then release, sampled by the real fire step */
    click(holdFrames = 15) {
      g._fireInput.press('mouse', g.time);
      for (let i = 0; i < holdFrames; i++) { step(); g._fireStep(DT); }
      g._fireInput.release('mouse');
      for (let i = 0; i < 6; i++) { step(); g._fireStep(DT); }
    },
    holdShipped(frames) { this.click(frames); },
  };
}

/** The documented cadence: a shot immediately, then one per interval that fits. */
const ladder = (frames, intervalS, dt = DT) => {
  let t = 0, next = 0, n = 0;
  for (let i = 0; i < frames; i++) {
    t += dt;
    if (t >= next - 1e-9) { n++; next = t + intervalS; }
  }
  return n;
};

check('P1. pre-fix contract, VX-4 auto: a held boolean per frame multi-fires one click — the reported ladder', () => {
  const interval = 60 / WEAPON_DEFS.vx4.rpm;                 // 90.9 ms at 660 RPM
  const got = [];
  for (const frames of [1, 9, 15, 30]) {
    const r = rig({ id: 'vx4', mode: 'auto' });
    r.hold(frames);
    const expected = ladder(frames, interval);
    assert.equal(r.shots(), expected, `${frames}-frame hold fired ${r.shots()}, cadence says ${expected}`);
    assert.equal(r.rounds(), r.shots(), `${frames}-frame hold charged ${r.rounds()} rounds for ${r.shots()} shots`);
    got.push(`${frames}f(${(frames * DT * 1000).toFixed(0)}ms)->${r.shots()}`);
  }
  return 'level-driven auto: ' + got.join(' ') + ' — a ~250 ms click is 3 shots';
});

check('P2. pre-fix contract, every auto weapon: shot count is hold length / (60/rpm) + 1, not clicks', () => {
  const notes = [];
  const autos = ['vx4', 'p9', 'mpx5', 'vekp', 'cr9', 'hmg9']
    .filter((id) => (WEAPON_DEFS[id].fireModes || []).includes('auto'));
  for (const id of autos) {
    const def = WEAPON_DEFS[id];
    const interval = 60 / def.rpm;
    const seen = [];
    for (const frames of [1, 9, 15, 30]) {
      const r = rig({ id, mode: 'auto' });     // fresh weapon per hold: the cadence timer carries over
      r.hold(frames);
      const expected = ladder(frames, interval);
      // Allow one shot of slack: a hold boundary can land within a microsecond of
      // the cadence edge (720 RPM at 60 Hz does), and which side of it the frame
      // falls on is float noise, not behaviour. The point is "many, not one".
      assert.ok(frames === 1 ? r.shots() === expected : Math.abs(r.shots() - expected) <= 1,
        `${def.name}: ${frames}-frame hold = ${r.shots()} shots, cadence = ${expected}`);
      assert.equal(r.rounds(), r.shots(), `${def.name}: ${frames}-frame hold charged ${r.rounds()} rounds for ${r.shots()} shots`);
      seen.push(`${frames}f->${r.shots()}`);
    }
    notes.push(`${id} ${seen.join(' ')} @${def.rpm}RPM`);
  }
  return 'old level-driven path, holds of 1/9/15/30 frames: ' + notes.join(' | ');
});

check('P3. semi was never affected: the old path was already edge-driven per press', () => {
  const r = rig({ id: 'vx4', mode: 'semi' });
  r.hold(1);
  assert.equal(r.shots(), 1, 'first frame of a semi hold must fire');
  r.hold(600);                                     // 10 s of "button down"
  assert.equal(r.shots(), 1, `semi repeated without a new press: ${r.shots()} shots`);
  assert.equal(r.rounds(), 1, `semi charged ${r.rounds()} rounds`);
  r.unhold(2);                                     // let the trigger up before re-pressing
  let presses = 0;
  // Space the presses by more than the weapon's own inter-shot cadence: presses
  // that land inside it are refused by design (F11), which is not what P3 measures.
  const gap = Math.ceil(((WEAPON_DEFS.vx4.semiDelay || 60 / WEAPON_DEFS.vx4.rpm)) / DT) + 2;
  for (let i = 0; i < 20; i++) { r.hold(1); r.unhold(gap); presses++; }
  assert.equal(r.shots(), presses + 1, `20 more presses gave ${r.shots() - 1} shots`);
  return '1 shot per press; a 10 s hold stayed at 1 shot; 20 presses -> 20 more shots';
});

check('P4. shipped contract: the same 250 ms click is exactly one shot and one round', () => {
  const notes = [];
  const pairs = [['vx4', 'auto'], ['p9', 'auto'], ['mpx5', 'auto'], ['vekp', 'auto'], ['cr9', 'auto'], ['hmg9', 'auto'], ['vx4', 'semi'], ['mr7', 'semi'], ['st12', 'semi']]
    .filter(([id, m]) => (WEAPON_DEFS[id].fireModes || [WEAPON_DEFS[id].auto ? 'auto' : 'semi']).includes(m));
  for (const [id, mode] of pairs) {
    const def = WEAPON_DEFS[id];
    const r = rig({ id, mode });
    r.click(15);                                   // 250 ms down, then up
    assert.equal(r.shots(), 1, `${def.name} ${mode}: a 15-frame click fired ${r.shots()} shots`);
    assert.equal(r.rounds(), 1, `${def.name} ${mode}: a click charged ${r.rounds()} rounds`);
    notes.push(`${id}/${mode}`);
  }
  return `15-frame click through FireTriggerInput + _fireStep -> 1 shot, 1 round, for ${notes.length} weapon/mode pairs (${notes.join(', ')})`;
});

check('P5. shipped contract: a real hold still auto-fires at RPM and stops on release', () => {
  const def = WEAPON_DEFS.vx4;
  const interval = 60 / def.rpm;
  const r = rig({ id: 'vx4', mode: 'auto' });
  const times = [];
  const realSpend = r.ws.spendRound.bind(r.ws);
  r.ws.spendRound = (wid) => { const ok = realSpend(wid); if (ok) times.push(r.g.time); return ok; };
  r.click(30);                                     // 500 ms down > AUTO_ENGAGE_S
  const held = r.shots();
  assert.ok(held >= 3, `a 500 ms auto hold engaged only ${held} shots — sustained fire must continue`);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] - times[i - 1] >= interval - 1e-6, `shots ${i} and ${i + 1} were ${((times[i] - times[i - 1]) * 1000).toFixed(1)} ms apart, faster than the ${def.rpm} RPM cadence`);
  }
  const engageFrames = Math.ceil(0.25 * FPS);
  const ceiling = 1 + ladder(30 - engageFrames, interval);
  assert.ok(held <= ceiling + 1, `a 500 ms hold gave ${held} shots; the cadence allows at most ${ceiling}`);
  const after = (() => { for (let i = 0; i < 120; i++) { r.g.time += DT; r.ws.update(DT, r.g.time, r.g.player); } return r.shots(); })();
  assert.equal(after, held, `fire continued ${after - held} shots after release`);
  const r2 = rig({ id: 'vx4', mode: 'auto' });
  r2.click(9);
  assert.equal(r2.shots(), 1, `a 9-frame (150 ms) click fired ${r2.shots()} shots — short presses must not engage auto`);
  return `30-frame hold -> ${held} shots at ${def.rpm} RPM, frozen on release; 150 ms click -> 1 shot`;
});

check('P6. burst keeps its configured length: one press = one burst, never a burst per frame', () => {
  const notes = [];
  for (const id of Object.keys(WEAPON_DEFS)) {
    const def = WEAPON_DEFS[id];
    if (!(def.fireModes || []).includes('burst')) continue;
    const burst = def.burstCount || 3;
    const r = rig({ id, mode: 'burst' });
    r.click(15);
    assert.equal(r.shots(), burst, `${def.name}: one press fired ${r.shots()} rounds, burstCount is ${burst}`);
    assert.equal(r.rounds(), burst, `${def.name}: one press charged ${r.rounds()} rounds, burstCount is ${burst}`);
    const r2 = rig({ id, mode: 'burst' });
    r2.hold(15); r2.hold(15); r2.hold(15);          // the old level-driven path, held
    assert.equal(r2.shots(), burst, `${def.name}: the old path armed ${r2.shots() / burst} bursts from one press`);
    notes.push(`${id}:${burst}`);
  }
  return `one press = exactly one burst for every burst weapon (${notes.join(', ')})`;
});

const passed = results.filter((x) => x.ok).length;
console.log(`\n${'='.repeat(66)}\n${passed}/${results.length} firing-pipeline tests passed\n${'='.repeat(66)}`);
process.exit(passed === results.length ? 0 : 1);
