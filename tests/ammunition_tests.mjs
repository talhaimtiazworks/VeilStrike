/**
 * ammunition_tests.mjs — Phase-3 verification: one successful firing event is
 * exactly one bullet, measured against an independent signal (the discharge the
 * firing path itself reports to audio), for every weapon, fire mode, frame rate
 * and trigger duration the game supports.
 *
 * Why an independent signal: comparing `mag` against a counter that the same code
 * writes proves nothing. `audio.gunshot` is emitted once per real discharge, so a
 * double-charge anywhere along the path (projectile, hitscan, the shotgun pellet
 * loop, muzzle flash, recoil, reload, HUD) shows up as rounds-spent ≠ discharges.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
import { WeaponSystem, WEAPON_DEFS, WEAPON_ORDER } from '../js/weapons.js';
import { ammoHudState } from '../js/ui.js';
import { check, results, makeGame } from './world_harness.mjs';

const src = (f) => readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
/** The same file as it stood in the accepted v4.1 build (git HEAD). */
function srcBaseline(f) {
  try {
    return execSync(`git show HEAD:js/${f}`, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
  } catch (e) {
    return null;
  }
}

/** Drive one weapon through the real loop and report what it did. */
function fire(id, mode, fps, clickFrames, totalFrames, opts = {}) {
  const def = WEAPON_DEFS[id];
  const g = makeGame('facility');
  const ws = new WeaponSystem(g);
  g.weapons = ws;
  ws.select(id);
  const st = ws.state[id];
  st.fireMode = mode;
  st.mag = opts.mag !== undefined ? opts.mag : def.magSize;
  st.reserve = opts.reserve !== undefined ? opts.reserve : (def.noReload ? 0 : def.startReserve);
  if (opts.freeAllowance !== undefined) st.freeAllowance = opts.freeAllowance;
  let shots = 0;
  const shotsAt = [];
  // the harness stubs some collaborators; these two are read by the real code,
  // so give them the shape the shipped Game provides (otherwise reload timing
  // multiplies by a Proxy and stats.shots++ starts from undefined).
  g.stats.shots = 0;
  if (g.characters) { g.characters.liveReloadMult = () => 1; g.characters.abilityMult = () => 1; }
  g.audio.gunshot = () => { shots++; shotsAt.push(g.time); };
  const dt = 1 / fps;
  const mag0 = st.mag, res0 = st.reserve;
  g.handsMode = 'gun';
  let charges = 0;
  const realSpend = ws.spendRound.bind(ws);
  ws.spendRound = (wid) => { const r = realSpend(wid); if (r) charges++; return r; };
  for (let i = 0; i < totalFrames; i++) {
    g.time += dt;
    const down = clickFrames === Infinity ? true : (i % Math.max(clickFrames * 3, 1)) < clickFrames;
    g.input.mouse0 = down;
    ws.tryFire(g.time, down);
    ws.update(dt, g.time, g.player);
    g.player.update(dt, g.input);
  }
  g.input.mouse0 = false;
  return {
    id, mode, fps, clickFrames, shots, charges,
    consumed: (mag0 - st.mag) + (res0 - st.reserve),
    mag: st.mag, reserve: st.reserve, st, g, ws, shotsAt, def,
  };
}

const modesOf = (def) => def.fireModes || [def.auto ? 'auto' : 'semi'];

// ---------------------------------------------------------------------------
check('M1. one discharge = one round, for every weapon × mode × 60/144 Hz × click length', () => {
  const rows = [];
  for (const id of WEAPON_ORDER) {
    const def = WEAPON_DEFS[id];
    for (const mode of modesOf(def)) {
      for (const fps of [60, 144]) {
        for (const click of [1, 2, 6]) rows.push(fire(id, mode, fps, click, 240));
        rows.push(fire(id, mode, fps, Infinity, 240));
      }
    }
  }
  const bad = rows.filter((r) => r.consumed !== r.shots);
  assert.equal(bad.length, 0, `mismatches in ${rows.length} cases: ${bad.slice(0, 6).map((r) => `${r.id}/${r.mode}@${r.fps} spent ${r.consumed} vs ${r.shots} shots`).join('; ')}`);
  const overcharged = rows.filter((r) => r.charges !== r.shots);
  assert.equal(overcharged.length, 0, `${overcharged.length} cases where the charge count differed from the discharge count`);
  const underfired = rows.filter((r) => r.consumed > r.mag + 0 && r.mag < 0);
  assert.equal(underfired.length, 0, 'no negative magazines');
  return `${rows.length} cases, 0 mismatches (single-charge point verified per case)`;
});

check('M2. the reported ladder: 300 → 299 → 298 → (10) 290 → (50) 250 → (100) 200', () => {
  const ladder = [[1, 299], [2, 298], [10, 290], [50, 250], [100, 200]];
  const seen = [];
  for (const mode of ['semi', 'auto']) {
    for (const [rounds, expect] of ladder) {
      const g = makeGame('facility');
      const ws = new WeaponSystem(g);
      g.weapons = ws; ws.select('vx4');
      const st = ws.state.vx4;
      st.fireMode = mode; st.mag = WEAPON_DEFS.vx4.magSize; st.reserve = 0;
      for (let i = 0; i < rounds; i++) assert.equal(ws.spendRound('vx4'), true, `${mode}: charge ${i + 1} refused`);
      assert.equal(st.mag + st.reserve, expect, `${mode}: after ${rounds} rounds expected ${expect}, got ${st.mag + st.reserve}`);
      seen.push(`${mode}:${rounds}→${st.mag + st.reserve}`);
    }
  }
  // and the same numbers through the real trigger path, at 60 Hz, held
  const held = fire('vx4', 'auto', 60, Infinity, 300 * 6, { mag: 300, reserve: 0 });
  assert.equal(held.consumed, held.shots, `${held.consumed} rounds for ${held.shots} discharges over 30 s`);
  assert.equal(held.mag, 300 - held.shots, `mag ${held.mag} after ${held.shots} shots`);
  assert.ok(held.mag >= 0, 'never negative');
  return seen.join(' ');
});

check('M3. a blocked, early or rejected shot consumes nothing', () => {
  const def = WEAPON_DEFS.p9;
  const g = makeGame('facility');
  g.stats.shots = 0;
  if (g.characters) { g.characters.liveReloadMult = () => 1; g.characters.abilityMult = () => 1; }
  const ws = new WeaponSystem(g);
  g.weapons = ws; ws.select('p9');
  const st = ws.state.p9;
  st.fireMode = 'semi'; st.mag = def.magSize; st.reserve = def.startReserve;
  g.handsMode = 'gun';
  let shots = 0;
  g.audio.gunshot = () => { shots++; };
  const DTt = 1 / 60;
  let t = 0;
  const step = (down) => { t += DTt; g.time = t; g.input.mouse0 = down; ws.tryFire(t, down); ws.update(DTt, t, g.player); };
  for (let i = 0; i < 90; i++) step(false);              // let the draw animation finish
  assert.equal(ws.state_, 'ready', `weapon settled into the ready state (${ws.state_})`);

  const interval = def.semiDelay || 60 / def.rpm;
  const framesIn = (secs) => Math.max(1, Math.round(secs * 60));
  const gate = Math.max(1, Math.floor(framesIn(interval) / 3));   // ~43 ms of a 130 ms gate

  const before = st.mag + st.reserve;
  step(true);
  assert.equal(before - (st.mag + st.reserve), 1, `one press spends exactly one round (mag ${st.mag}, reserve ${st.reserve})`);

  // still the same press, well inside the weapon's own interval
  for (let i = 0; i < gate; i++) step(true);
  assert.equal(st.mag + st.reserve, before - 1, 'holding a semi-automatic press fired nothing more');
  // a fresh press while the gate is still shut
  step(false); step(false);
  const t2 = st.mag + st.reserve;
  for (let i = 0; i < gate; i++) step(true);
  assert.equal(t2 - (st.mag + st.reserve), 0, `a re-press ${gate} frames after the shot (interval ${interval.toFixed(3)} s) costs nothing`);
  // once the interval has elapsed the same press does fire — one round
  for (let i = 0; i < framesIn(interval); i++) step(false);
  const t3 = st.mag + st.reserve;
  step(true);
  assert.equal(t3 - (st.mag + st.reserve), 1, 'after the gate expires the press costs exactly one round');
  for (let i = 0; i < 4; i++) step(true);
  assert.equal(st.mag + st.reserve, t3 - 1, 'and holding it does not add more');
  st.mag = 4;
  ws.startReload();
  assert.equal(ws.reloading, true, 'reload started');
  const during = st.mag + st.reserve;
  const shotsAtReload = shots;
  // press only inside the pre-commit part of the animation: the transfer itself
  // happens at stateDur·0.6, and M5 already covers what a completed reload does.
  const budget = Math.max(6, Math.floor(ws.stateDur * 60 * 0.4));
  for (let i = 0; i < budget; i++) step(true);        // one frame each: stays inside the pre-commit window
  assert.equal(ws.reloading, true, `still mid-reload after ${budget} press pairs (${ws.stateDur.toFixed(2)} s animation)`);
  assert.equal(st.mag + st.reserve, during, `no rounds charged while reloading (mag ${st.mag}/${st.reserve})`);
  assert.equal(shots, shotsAtReload, 'and no discharge was reported');
});

check('M4. an empty magazine prevents firing and cannot go negative', () => {
  for (const id of ['vx4', 'p9', 'st12', 'lb9']) {
    const def = WEAPON_DEFS[id];
    const r = fire(id, modesOf(def)[0], 60, 1, 400, { mag: 0, reserve: 0, freeAllowance: 100 });
    assert.equal(r.shots, 0, `${id}: fired ${r.shots} times with no ammunition`);
    assert.equal(r.mag, 0, `${id}: magazine stayed 0 (got ${r.mag})`);
    assert.ok(r.reserve >= 0, `${id}: reserve ${r.reserve} not negative`);
    assert.equal(r.consumed, 0, `${id}: nothing consumed`);
  }
});

check('M5. reload transfers exactly what both stores can hold, once', () => {
  for (const id of ['p9', 'st12', 'cr9', 'lb9']) {
    const def = WEAPON_DEFS[id];
    const g = makeGame('facility');
    g.stats.shots = 0;
    if (g.characters) { g.characters.liveReloadMult = () => 1; g.characters.abilityMult = () => 1; }
    const ws = new WeaponSystem(g);
    g.weapons = ws; ws.select(id);
    const st = ws.state[id];
    if (st.freeAllowance !== undefined) st.freeAllowance = 400;
    st.mag = Math.max(0, def.magSize - 6);
    st.reserve = Math.min(def.reserveMax, 40);
    const total = st.mag + st.reserve;
    for (let i = 0; i < 90; i++) { g.time += 1 / 60; ws.update(1 / 60, g.time, g.player); }
    ws.startReload();
    for (let i = 0; i < 900 && ws.reloading; i++) { g.time += 1 / 60; ws.update(1 / 60, g.time, g.player); }
    assert.equal(ws.reloading, false, `${id}: reload finished`);
    assert.equal(st.mag + st.reserve, total, `${id}: total conserved (${st.mag}/${st.reserve} of ${total})`);
    assert.equal(st.mag, Math.min(def.magSize, total), `${id}: magazine topped to the cap`);
    const after = st.mag + st.reserve;
    ws._commitReload();                                   // the late timer can also fire
    assert.equal(st.mag + st.reserve, after, `${id}: a second commit is a no-op`);
  }
});

check('M6. the HUD number is the same arithmetic the model holds', () => {
  for (const id of ['vx4', 'mr7', 'st12', 'hmg9']) {
    const def = WEAPON_DEFS[id];
    const g = makeGame('facility');
    const ws = new WeaponSystem(g);
    g.weapons = ws; ws.select(id);
    const st = ws.state[id];
    for (const [mag, reserve] of [[def.magSize, def.reserveMax], [7, 21], [0, def.noReload ? 0 : 12]]) {
      st.mag = mag; st.reserve = reserve;
      const hud = ammoHudState(def, st);
      assert.equal(hud.total, Math.max(0, mag + reserve), `${id} HUD total at ${mag}/${reserve}`);
      assert.equal(hud.suggestReload, !def.noReload && mag === 0 && reserve > 0, `${id} reload cue at ${mag}/${reserve}`);
      if (def.noReload) assert.match(hud.noReloadMessage || '', /CONTINUOUS SUPPLY|OUT OF AMMO/, `${id} continuous-feed message`);
    }
  }
});

check('M7. exactly one firing entry point and one charge point in the shipped code', () => {
  const callSites = ['game.js', 'player.js', 'ui.js', 'hud.js', 'input.js']
    .filter((f) => { try { readFileSync(new URL(`../js/${f}`, import.meta.url)); return true; } catch { return false; } })
    .reduce((n, f) => n + (src(f).match(/\.tryFire\(/g) || []).length, 0);
  assert.equal(callSites, 1, `${callSites} tryFire call sites in the game/player/UI layer (must be exactly 1)`);
  const weapons = src('weapons.js');
  const from = weapons.indexOf('  spendRound(');
  const to = weapons.indexOf('  addRounds(');
  assert.ok(from > 0 && to > from, 'spendRound/addRounds are still the named accounting owners');
  const spendBody = weapons.slice(from, to);
  assert.equal((spendBody.match(/st\.mag--/g) || []).length, 1, 'the single magazine decrement lives in spendRound');
  const rest = weapons.replace(spendBody, '');
  assert.equal((rest.match(/st\.mag--/g) || []).length, 0, 'no other code decrements the magazine');
  assert.equal((rest.match(/st\.mag\s*=\s*st\.mag\s*-/g) || []).length, 0, 'no "mag = mag - 1" style second decrement');
  const callers = (weapons.match(/this\.spendRound\(/g) || []).length;
  assert.ok(callers >= 1, `${callers} charge call site(s) inside the weapon system`);
});

check('M8. side effects (flash, sound, recoil, hitscan, projectiles) do not charge ammo', () => {
  const r = fire('vx4', 'auto', 60, Infinity, 300);
  assert.equal(r.charges, r.shots, `${r.charges} charges for ${r.shots} discharges`);
  assert.ok(r.shots > 20, `the sweep produced ${r.shots} shots, not a token sample`);
  assert.equal(r.st.roundsSpent | 0, r.shots, `the per-weapon audit counter agrees (${r.st.roundsSpent | 0})`);
  assert.equal(r.g.stats.shots, r.shots, 'and the stats counter agrees too — no parallel tally drifting');
  // recoil / flash / hitscan all ran in that window; a second charge would show as
  // consumed > shots, which M1 asserts across the whole roster.
  assert.equal(r.consumed, r.shots, `${r.consumed} rounds consumed for ${r.shots} shots`);
});

check('M9. a shotgun blast is one round, many pellets', () => {
  for (const id of ['st12', 'vx12']) {
    const def = WEAPON_DEFS[id];
    const pellets = def.pellets;
    const r = fire(id, 'semi', 60, 1, 400);
    assert.ok(r.shots >= 1, `${id}: ${r.shots} trigger events fired`);
    assert.equal(r.consumed, r.shots, `${id}: ${r.consumed} rounds for ${r.shots} discharges at ${pellets} pellets each`);
    assert.ok(pellets >= 2, `${id} still fires a multi-pellet pattern (${pellets})`);
  }
});

check('M10. no weapon setting was touched: table is byte-identical to the pre-fix baseline', () => {
  // Stronger than a hand-written snapshot: the shipped file at git HEAD (the
  // v4.1 build the user already accepted) is parsed the same way and compared
  // field by field. Magazine capacity, fire modes, rate, reserve cap and pellet
  // count must survive the ammunition rework untouched.
  const fields = ['magSize', 'reserveMax', 'startReserve', 'rpm', 'pellets', 'reloadTime'];
  const parse = (text) => {
    const out = {};
    for (const id of WEAPON_ORDER) {
      const m0 = text.match(new RegExp(`^\\s*${id}:\\s*\\{`, 'm'));
      if (!m0) continue;
      const at = m0.index;
      const depth1 = text.indexOf('{', at);
      let depth = 0, end = depth1;
      for (let i = depth1; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      const body = text.slice(depth1, end);
      const rec = {};
      for (const f of fields) {
        const m = body.match(new RegExp(`\\b${f}:\\s*(-?[\\d.]+)`));
        if (m) rec[f] = Number(m[1]);
      }
      const fm = body.match(/fireModes:\s*\[([^\]]*)\]/);
      if (fm) rec.fireModes = fm[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
      out[id] = rec;
    }
    return out;
  };
  // The primary guard is a recorded file, so it also works from an extracted
  // archive where no git checkout exists (this check used to depend on git and
  // silently fell back to a hand-typed table that was wrong about the MR-7 rpm).
  const recordedPath = new URL('./baselines/weapons_v4.1.json', import.meta.url);
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(recordedPath, 'utf8'));
  } catch (e) {
    assert.fail(`the recorded v4.1 weapon baseline is missing (${e.message}) — this check must not degrade to nothing`);
  }
  const now = parse(src('weapons.js'));
  const diffs = [];
  const compare = (label, table) => {
    for (const id of WEAPON_ORDER) {
      const a = table[id], b = now[id];
      assert.ok(a && b, `${id} present in both the ${label} and the current table`);
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const av = JSON.stringify(a[k]), bv = JSON.stringify(b[k]);
        if (av !== bv) diffs.push(`${label} ${id}.${k}: ${av} → ${bv}`);
      }
    }
  };
  compare('v4.1 baseline', recorded.weapons);
  const gitText = srcBaseline('weapons.js');
  if (gitText) compare('git HEAD', parse(gitText));
  assert.equal(diffs.length, 0, `weapon settings changed: ${diffs.slice(0, 8).join('; ')}`);
  // and the live defs agree with the current file text (no runtime rewriting)
  for (const id of WEAPON_ORDER) {
    assert.equal(WEAPON_DEFS[id].magSize, now[id].magSize, `${id} magSize matches the file`);
    assert.equal(WEAPON_DEFS[id].rpm, now[id].rpm, `${id} rpm matches the file`);
  }
  const changed = src('weapons.js') === gitText ? 'identical file' : 'file edited, settings identical';
  return `${WEAPON_ORDER.length} weapons, ${Object.keys(recorded.weapons.vx4).length} settings each — 0 changes vs the recorded v4.1 baseline${gitText ? ' and vs git HEAD' : ''} (${changed})`;

});

check('M11. the lb9 mission allowance decrements once per shot (secondary writer audit)', () => {
  const def = WEAPON_DEFS.lb9;
  const g = makeGame('facility');
  const ws = new WeaponSystem(g);
  g.weapons = ws; ws.select('lb9');
  const st = ws.state.lb9;
  st.fireMode = 'semi'; st.mag = def.magSize; st.reserve = 20; st.freeAllowance = 40;
  g.handsMode = 'gun';
  let shots = 0;
  g.audio.gunshot = () => { shots++; };
  for (let i = 0; i < 240; i++) {
    g.time += 0.05;
    const down = i % 4 === 0;
    g.input.mouse0 = down;
    ws.tryFire(g.time, down);
    ws.update(0.05, g.time, g.player);
  }
  assert.ok(shots >= 2, `${shots} shots fired`);
  assert.equal(40 - st.freeAllowance, shots, `allowance 40 → ${st.freeAllowance} after ${shots} shots (exactly one decrement per shot)`);
  // the lb9 keeps a mission-level round budget, and mag+reserve is a projection of
  // it. If the projection and the charge ever disagreed, this is where it shows.
  assert.equal(st.mag + st.reserve, st.freeAllowance, `on-hand ${st.mag}+${st.reserve} === allowance ${st.freeAllowance}`);
  assert.ok(st.mag >= 0 && st.reserve >= 0, `both stores non-negative (${st.mag}/${st.reserve})`);
  assert.equal(st.roundsSpent | 0, shots, `audit counter ${st.roundsSpent | 0} === ${shots}`);
  void def;
});

check('M12. resupply routes through the same owner and cannot zero a loadout', () => {
  const g = makeGame('facility');
  const ws = new WeaponSystem(g);
  g.weapons = ws;
  ws.select('vx4');
  const st = ws.state.vx4;
  st.mag = 120; st.reserve = 0;
  const granted = g.player.resupplyAll();
  assert.ok(granted > 0, `resupplyAll granted ${granted} rounds`);
  assert.ok(st.mag + st.reserve > 120, `VX-4 total went 120 → ${st.mag + st.reserve} (the old crate code zeroed it)`);
  assert.ok(st.mag <= WEAPON_DEFS.vx4.magSize, 'stayed inside the magazine cap');
  assert.ok(st.reserve <= WEAPON_DEFS.vx4.reserveMax, 'stayed inside the reserve cap');
});

// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.ok).length;
console.log('\n' + '='.repeat(66));
console.log(`${passed}/${results.length} ammunition accounting tests passed`);
console.log('='.repeat(66));
if (passed !== results.length) process.exitCode = 1;
