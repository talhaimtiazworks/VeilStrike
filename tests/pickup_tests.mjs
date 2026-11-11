/**
 * pickup_tests.mjs — behavioural verification of the Phase-4 campaign ammunition
 * supplies (typed packs + crates) and the Phase-3 accounting they rely on.
 *
 * Two halves:
 *   P — placement across all 100 campaign missions: every mission offers typed
 *       supplies, sizes come from the fixed pack table, nothing is buried,
 *       floating, unreachable or inside a vehicle, and the quantity scales with
 *       how big the mission is.
 *   B — behaviour on a real WeaponSystem: exact +N, magazine-first, family
 *       compatibility, caps, single award, prompt, notification and HUD.
 *
 * Headless note: no browser is available here, so "clear visual identification"
 * is verified structurally (distinct tint/label/mesh per family, prompt text) —
 * how it *looks* on screen is not something these tests can claim.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PhysicsWorld } from '../js/physics.js';
import { GameWorld } from '../js/world.js';
import { WeaponSystem, WEAPON_DEFS } from '../js/weapons.js';
import { ammoHudState } from '../js/ui.js';
import { AMMO_TYPES, AMMO_PACK_SIZES, WEAPON_AMMO, weaponsForType, grantPack } from '../js/ammo.js';
import { MISSION_ORDER, DIFFICULTIES } from '../js/progress.js';
import { MISSION_DEFS, syncCampaignMissionDefs } from '../js/missions.js';
import { results, check, makeGame, findOpenSpot } from './world_harness.mjs';

syncCampaignMissionDefs();

// ---------------------------------------------------------------------------
// P — placement across the whole campaign
// ---------------------------------------------------------------------------
/** Build one campaign mission's world with the same recipe the 100-mission audit
 *  uses (real GameWorld + real physics colliders), no game loop. */
function buildMissionWorld(mapId, opts = {}) {
  const scene = new THREE.Scene();
  const physics = new PhysicsWorld();
  const stub = {
    state: 'playing', time: 0, scene, physics, world: null,
    settings: { quality: 'medium', perfMode: false, dayMode: false },
    player: { pos: new THREE.Vector3(), crouchT: 0 },
    progress: { difficulty: DIFFICULTIES.standard, recordIntel() {} },
    ui: new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}) }),
    audio: new Proxy({ ready: false, alertLevel: 0 }, { get: (t, k) => (k in t ? t[k] : () => {}) }),
    particles: new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}) }),
    weapons: { state: {}, owned: new Set(), currentId: 'vx4', addRounds: () => ({ added: 0, toMag: 0, toReserve: 0 }), roundsNeeded: () => 0 },
    emitNoise() {},
  };
  const world = new GameWorld();
  stub.world = world;
  // Exactly what game.js does before building an operation: the mission hands the
  // world a supply plan, and buildByMap places the packs against the finished map.
  world._supplyPlan = {
    missionNumber: opts.missionNumber || 1,
    minEnemies: opts.minEnemies || 50,
    near: [0, 0],
  };
  world.buildByMap(mapId, scene, physics);
  return { world, physics, scene, stub };
}

const packOf = (it) => it.id.startsWith('ammo_pack_');
/** The pack's own volume, measured a hair larger than the placer demanded, so the
 *  check is a (slightly) stricter re-reading of the same guarantee. The floor slab
 *  of these maps has its top face at y=0, so the test volume starts just above it
 *  — including the floor would report every pack on the campaign as "buried". */
/** The tin's own mesh volume (0.34 × 0.18 × 0.22 resting on the ground plane; the
 *  interact point sits 0.34 above that). A low bench lip over a pack is not "inside
 *  a wall", so this measures the object rather than a metre of air around it — the
 *  accessibility half of the requirement is P6. The floor slab's top face is y=0 on
 *  these maps, so the volume starts 0.01 above it: including the floor would report
 *  every pack in the campaign as buried. */
function boxFor(it) {
  const base = it.pos.y - 0.34;
  return {
    min: new THREE.Vector3(it.pos.x - 0.18, base + 0.01, it.pos.z - 0.12),
    max: new THREE.Vector3(it.pos.x + 0.18, base + 0.2, it.pos.z + 0.12),
  };
}
/** A standing volume for a player next to `it`, or null if no side is walkable. */
function reachableFrom(world, physics, it) {
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const px = it.pos.x + Math.cos(a) * 1.25, pz = it.pos.z + Math.sin(a) * 1.25;
    const min = new THREE.Vector3(px - 0.34, Math.max(0.05, it.pos.y - 0.3), pz - 0.34);
    const max = new THREE.Vector3(px + 0.34, it.pos.y + 1.35, pz + 0.34);
    if (!physics.isBoxFree(min, max, { actors: false })) continue;
    const eye = new THREE.Vector3(px, it.pos.y + 0.75, pz);
    if (physics.hasLOS(eye, it.pos)) return { x: px, z: pz };
  }
  return null;
}

const perMission = [];
check('P1. every one of the 100 campaign missions offers typed ammunition supplies', () => {
  const missing = [];
  for (let idx = 0; idx < MISSION_ORDER.length; idx++) {
    const id = MISSION_ORDER[idx];
    const def = MISSION_DEFS[id];
    const { world, physics } = buildMissionWorld(def.map, { missionNumber: idx + 1, minEnemies: 50 + idx * 2 });
    const packs = world.interactables.filter(packOf);
    const crates = world.interactables.filter((it) => it.id.startsWith('ammo_') && !packOf(it));
    if (!packs.length || !crates.length) missing.push(`${idx + 1}:${packs.length}p/${crates.length}c`);
    perMission.push({
      n: idx + 1, packs: packs.length, crates: crates.length,
      rounds: packs.reduce((a, b) => a + b.rounds, 0),
      types: packs.map((p) => p.ammoType),
      sizes: packs.map((p) => p.rounds),
      optional: packs.filter((p) => p.optional).length,
      world, physics, items: packs,
    });
  }
  assert.equal(missing.length, 0, `missions without supplies: ${missing.slice(0, 6).join(', ')}`);
});

check('P2. pack values come from the fixed table and families from the mapping', () => {
  const sizes = new Set(AMMO_PACK_SIZES);
  const bad = [];
  for (const m of perMission) {
    for (let i = 0; i < m.packs; i++) {
      if (!sizes.has(m.sizes[i])) bad.push(`op${m.n} size ${m.sizes[i]}`);
      if (!AMMO_TYPES[m.types[i]]) bad.push(`op${m.n} type ${m.types[i]}`);
    }
  }
  assert.equal(bad.length, 0, `off-table values: ${bad.slice(0, 5).join(', ') || 'none'}`);
  const total = perMission.reduce((a, m) => a + m.rounds, 0);
  assert.ok(total > 0, `${total} pack rounds distributed across the campaign`);
});

check('P3. longer / harder missions carry more and larger supplies', () => {
  const early = perMission.slice(0, 10);
  const late = perMission.slice(-10);
  const avg = (arr, k) => arr.reduce((a, m) => a + m[k], 0) / arr.length;
  assert.ok(avg(late, 'packs') > avg(early, 'packs'),
    `packs per mission: first 10 ${avg(early, 'packs').toFixed(1)} → last 10 ${avg(late, 'packs').toFixed(1)}`);
  assert.ok(avg(late, 'rounds') > avg(early, 'rounds') * 1.5,
    `pack rounds per mission: ${avg(early, 'rounds').toFixed(0)} → ${avg(late, 'rounds').toFixed(0)}`);
  assert.ok(avg(late, 'rounds') < 400,
    `and still finite: ${avg(late, 'rounds').toFixed(0)} rounds/mission in the finale (ammo is not unlimited)`);
});

check('P4. no pack is buried in, or clipping, solid geometry', () => {
  const bad = [];
  for (const m of perMission) {
    for (const it of m.items) {
      const b = boxFor(it);
      if (!m.physics.isBoxFree(b.min, b.max, { actors: false })) bad.push(`op${m.n} ${it.id}`);
    }
  }
  assert.equal(bad.length, 0, `packs overlapping static geometry: ${bad.slice(0, 6).join(', ') || 'none'} of ${perMission.reduce((a, m) => a + m.packs, 0)}`);
});

check('P5. no pack floats: solid ground is directly beneath it', () => {
  const bad = [];
  for (const m of perMission) {
    for (const it of m.items) {
      const from = new THREE.Vector3(it.pos.x, it.pos.y + 0.4, it.pos.z);
      const hit = m.physics.raycast(from, new THREE.Vector3(0, -1, 0), 1.6);
      if (!hit || hit.dist > 1.2) bad.push(`op${m.n} ${it.id} drop=${hit ? hit.dist.toFixed(2) : 'none'}`);
    }
  }
  assert.equal(bad.length, 0, `packs with no floor under them: ${bad.slice(0, 6).join(', ') || 'none'}`);
});

check('P6. every pack can actually be stood next to and faced', () => {
  const bad = [];
  for (const m of perMission) {
    for (const it of m.items) {
      if (!reachableFrom(m.world, m.physics, it)) bad.push(`op${m.n} ${it.id} @${it.pos.x.toFixed(0)},${it.pos.z.toFixed(0)}`);
    }
  }
  assert.equal(bad.length, 0, `unreachable packs: ${bad.slice(0, 6).join(', ') || 'none'}`);
});

check('P7. missions with room for it hide a share off the direct lines', () => {
  const needy = perMission.filter((m) => m.packs >= 2 && m.optional < 1);
  assert.equal(needy.length, 0, `missions with 2+ packs and nothing optional: ${needy.map((m) => 'op' + m.n).join(', ') || 'none'}`);
  const greedy = perMission.filter((m) => m.optional > m.packs / 2);
  assert.equal(greedy.length, 0, `more than half the supply hidden in: ${greedy.map((m) => 'op' + m.n).join(', ') || 'none'}`);
  const total = perMission.reduce((a, m) => a + m.optional, 0);
  assert.ok(total >= 100, `${total} optional packs across the campaign (≥ one per mission where the map allowed it)`);
});

check('P8. packs keep clear of the vehicle parking and of each other', () => {
  let minPair = 99, minVehicle = 99;
  for (const m of perMission) {
    const spots = (m.world.interactables || []).filter(packOf);
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        minPair = Math.min(minPair, Math.hypot(spots[i].pos.x - spots[j].pos.x, spots[i].pos.z - spots[j].pos.z));
      }
      for (const v of (m.world.vehicleSpawns || [])) {
        const p = v.pos || v;
        if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
        minVehicle = Math.min(minVehicle, Math.hypot(spots[i].pos.x - p.x, spots[i].pos.z - p.z));
      }
    }
  }
  assert.ok(minPair > 2.0, `closest two packs in a mission: ${minPair.toFixed(2)} m (no stacking one pickup on another)`);
  assert.ok(minVehicle > 1.2 || minVehicle === 99, `closest pack to a vehicle spawn: ${minVehicle === 99 ? 'n/a' : minVehicle.toFixed(2)} m`);
});

check('P9. legacy hand-built maps keep their crates and gain nothing broken', () => {
  const { world } = buildMissionWorld('facility', { missionNumber: 1, minEnemies: 50 });
  const crates = world.interactables.filter((it) => it.id.startsWith('ammo_') && !packOf(it));
  assert.ok(crates.length >= 1, `facility still places ${crates.length} resupply crate(s)`);
  for (const it of crates) assert.equal(typeof it.action, 'function', `${it.id} has an action`);
});

// ---------------------------------------------------------------------------
// B — collection behaviour against the real WeaponSystem
// ---------------------------------------------------------------------------
/** A game whose weapons state is the real system, with the loadout the test asks for. */
function range(loadout = ['vx4', 'p9']) {
  const g = makeGame('facility');
  g.weapons = new WeaponSystem(g);
  g.weapons.owned = new Set(loadout);
  for (const id of loadout) {
    const def = WEAPON_DEFS[id];
    const st = g.weapons.state[id];
    st.mag = Math.max(0, def.magSize - 5);
    st.reserve = Math.max(0, Math.floor(def.reserveMax * 0.25));
  }
  g.weapons.select(loadout[0]);
  g.toasts = [];
  g.ui.toastBrief = (t) => g.toasts.push(t);
  g.ui.toast = (a, b) => g.toasts.push(`${a} ${b}`);
  const spot = findOpenSpot(g, 8);
  g.player.reset(new THREE.Vector3(spot.x, spot.y, spot.z), 0);
  return { g, spot };
}

/** Drop a real pack (built by the real world code) next to the player. */
function dropPack(g, spot, type, rounds, opts = {}) {
  const it = g.world._ammoPack(900 + Math.floor(Math.random() * 99), spot.x + 0.9, spot.y, spot.z, type, rounds, opts);
  assert.ok(it, 'pack built');
  it.pos.set(spot.x + 0.9, spot.y + 0.34, spot.z);
  return it;
}

check('B1. collecting adds exactly the pack value, magazine first', () => {
  for (const size of AMMO_PACK_SIZES) {
    // CR-9 (25 mag / 175 reserve) has headroom in both stores, so +N must move
    // exactly N. The VX-4's 300-round continuous feed is the *capped* case and is
    // covered by B4.
    const { g, spot } = range(['cr9', 'p9']);
    const st = g.weapons.state.cr9;
    const before = { mag: st.mag, reserve: st.reserve };
    const it = dropPack(g, spot, 'rifle', size);
    assert.equal(it.action(g), true, `+${size} collected`);
    assert.equal(st.mag + st.reserve, before.mag + before.reserve + size,
      `+${size}: ${before.mag}/${before.reserve} → ${st.mag}/${st.reserve} (delta ${st.mag + st.reserve - before.mag - before.reserve})`);
    assert.equal(st.mag, Math.min(WEAPON_DEFS.cr9.magSize, before.mag + size), `magazine filled first (mag ${st.mag}, reserve ${st.reserve})`);
    assert.equal(it.used, true, 'marked used');
    assert.equal(g.world.findInteractable(new THREE.Vector3(spot.x, spot.y + 1.6, spot.z), new THREE.Vector3(0, 0, 1), 2.6) === it, false,
      'collected pack stops offering itself');
  }
});

check('B2. notification reads "+N FAMILY AMMO" and the HUD total follows', () => {
  const { g, spot } = range(['cr9']);
  const st = g.weapons.state.cr9;
  st.mag = 10; st.reserve = 20;                       // headroom in both stores
  const def = WEAPON_DEFS.cr9;
  const before = ammoHudState(def, st);
  const it = dropPack(g, spot, 'rifle', 30);
  assert.equal(it.action(g), true, 'collected');
  const after = ammoHudState(def, st);
  assert.equal(after.total, before.total + 30, `HUD total ${before.total} → ${after.total} (the source the panel reads)`);
  assert.equal(after.total, st.mag + st.reserve, 'derived from the state the pickup wrote, not a parallel number');
  const toast = g.toasts.find((x) => /AMMO/.test(x));
  assert.ok(toast && /^\+\d+ RIFLE AMMO$/.test(toast), `notification text: "${toast}"`);
});

check('B3. families are isolated: shell packs never feed a rifle (and vice versa)', () => {
  const { g, spot } = range(['st12']);           // shotgun only
  const stShell = g.weapons.state.st12;
  const shellBefore = stShell.mag + stShell.reserve;
  let it = dropPack(g, spot, 'rifle', 40);
  assert.equal(it.action(g), false, 'rifle pack refused: no rifle carried');
  assert.equal(g.weapons.state.st12.mag + g.weapons.state.st12.reserve, shellBefore, 'shotgun untouched by a rifle pack');
  assert.ok(g.toasts.some((t) => /NO RIFLE WEAPON/.test(t)), `player told why: ${JSON.stringify(g.toasts.slice(-1))}`);
  assert.equal(it.used, false, 'refused pack stays in the world');
  it = dropPack(g, spot, 'shell', 20);
  assert.equal(it.action(g), true, 'shell pack accepted');
  assert.equal(stShell.mag + stShell.reserve, shellBefore + 20, 'shotgun got exactly +20');
});

check('B4. caps hold: never above magazine + reserve, never invented capacity', () => {
  const { g, spot } = range(['vx4', 'lb9']);
  const v = g.weapons.state.vx4, l = g.weapons.state.lb9;
  // VX-4 is the extreme case: 300-round magazine, reserveMax 0 (continuous feed).
  v.mag = WEAPON_DEFS.vx4.magSize - 7; v.reserve = 0;
  let it = dropPack(g, spot, 'rifle', 50);
  it.action(g);
  assert.equal(v.mag, WEAPON_DEFS.vx4.magSize, 'filled to the magazine cap and no further');
  assert.equal(v.reserve, 0, 'no reserve was invented for a reserveMax-0 weapon');
  // precision family (lb9) then gets the roll-over remainder
  l.mag = 0; l.reserve = 0;
  it = dropPack(g, spot, 'precision', 50);
  const cap = WEAPON_DEFS.lb9.magSize + WEAPON_DEFS.lb9.reserveMax;
  it.action(g);
  assert.equal(l.mag + l.reserve, Math.min(50, cap), `+50 capped at the family ceiling ${cap}: mag ${l.mag}/${WEAPON_DEFS.lb9.magSize}, reserve ${l.reserve}/${WEAPON_DEFS.lb9.reserveMax}`);
  assert.ok(l.mag <= WEAPON_DEFS.lb9.magSize && l.reserve <= WEAPON_DEFS.lb9.reserveMax, 'per-weapon caps respected');
  // and a full weapon family rejects the pack instead of overflowing
  it = dropPack(g, spot, 'precision', 50);
  assert.equal(it.action(g), false, 'full family ⇒ nothing granted');
  assert.equal(l.mag + l.reserve, Math.min(50, cap), 'totals unchanged by a rejected pack');
});

check('B5. a pack can only be collected once, ever', () => {
  const { g, spot } = range(['cr9', 'p9']);
  const st = g.weapons.state.cr9;
  st.mag = 5; st.reserve = 10;
  const it = dropPack(g, spot, 'rifle', 40);
  assert.equal(it.action(g), true, 'first collect works');
  const total = st.mag + st.reserve;
  assert.equal(it.action(g), false, 'second collect refused by the used guard');
  assert.equal(st.mag + st.reserve, total, 'and it granted nothing the second time');
  const near = new THREE.Vector3(spot.x, spot.y + 1.6, spot.z);
  const picked = g.world.findInteractable(near, new THREE.Vector3(1, 0, 0), 3.0);
  assert.ok(!picked || picked.id !== it.id, 'a used pack no longer offers itself');
  assert.equal(it.reusable, false, 'not reusable, so the picker skip is permanent for this attempt');
});

check('B6. an unusable pack stays available instead of being silently eaten', () => {
  const { g, spot } = range(['vx4']);
  const v = g.weapons.state.vx4;
  v.mag = WEAPON_DEFS.vx4.magSize; v.reserve = 0;
  const it = dropPack(g, spot, 'rifle', 50);
  assert.equal(it.action(g), false, 'rejected while full');
  assert.equal(it.used, false, 'pack still in the world');
  assert.equal(it.prompt, 'RIFLE AMMO FULL', `prompt reports it: "${it.prompt}"`);
  // spend rounds, come back: the same pack is now collectable
  for (let i = 0; i < 60; i++) g.weapons.spendRound('vx4');
  assert.equal(v.mag, WEAPON_DEFS.vx4.magSize - 60, 'spent down to 240');
  assert.equal(it.action(g), true, 'collectable on return');
  assert.equal(v.mag, WEAPON_DEFS.vx4.magSize - 10, `+50 of the pack landed in the magazine (mag now ${v.mag})`);
});

check('B7. grantPack is the single owner: direct API agrees with the pickup', () => {
  const { g } = range(['cr9', 'rk4']);
  const before = ['cr9', 'rk4'].map((id) => {
    const s = g.weapons.state[id];
    return s.mag + s.reserve;
  });
  const res = grantPack(g, { type: 'rifle', rounds: 40 });
  const after = ['cr9', 'rk4'].map((id) => {
    const s = g.weapons.state[id];
    return s.mag + s.reserve;
  });
  assert.equal(res.granted, 40, `40 granted (${JSON.stringify(res.perWeapon)})`);
  assert.equal(after[0] + after[1], before[0] + before[1] + 40, 'total moved by exactly 40, once');
  assert.equal(res.wasted, 0, 'nothing lost');
});

check('B8. pickup reset contract: single-use per attempt, restored on retry', () => {
  const { g, spot } = range(['vx4']);
  const it = dropPack(g, spot, 'rifle', 20);
  assert.equal(it.reusable, false, 'not reusable');
  assert.equal(typeof it.reset, 'undefined', 'no custom reset hook ⇒ the mission-retry loop clears `used`');
  it.action(g);
  assert.equal(it.used, true, 'used after collection');
  // the exact loop js/game.js runs on a checkpoint retry
  for (const other of g.world.interactables) {
    if (other.reset) other.reset();
    else if (other.id !== 'terminal') other.used = false;
  }
  assert.equal(it.used, false, 'restored for the next attempt');
});

check('B9. weapon-case ammo path uses the same accounting (no reserve truncation)', () => {
  const { g, spot } = range(['vx4', 'st12']);
  const v = g.weapons.state.vx4;
  v.mag = 100; v.reserve = 0;
  const before = v.mag + v.reserve;
  const item = g.world._weaponPickup('vx4', spot.x + 0.8, spot.y, spot.z);
  const wpn = g.world.interactables[g.world.interactables.length - 1];
  wpn.pos.set(spot.x + 0.8, spot.y + 0.45, spot.z);
  const ok = wpn.action(g);
  assert.equal(ok, true, 'owned-weapon case grants ammo');
  const total = v.mag + v.reserve;
  assert.ok(total > before, `VX-4 total went ${before} → ${total} (was truncated to 0 by the old min(reserveMax,…) line)`);
  assert.ok(total <= WEAPON_DEFS.vx4.magSize + WEAPON_DEFS.vx4.reserveMax, 'still inside the caps');
  void item; void g; void v;
});

check('B10. every family in the mapping has a visual identity and a crate name', () => {
  for (const [type, fam] of Object.entries(AMMO_TYPES)) {
    assert.ok(Number.isFinite(fam.tint), `${type} has a tint`);
    assert.ok(fam.label && fam.label === fam.label.toUpperCase(), `${type} has an uppercase label`);
    assert.ok(Array.isArray(fam.crates) && fam.crates.length >= 1, `${type} has crate naming`);
    assert.ok(weaponsForType(type).length >= 1, `${type} maps to at least one weapon`);
    const tints = Object.values(AMMO_TYPES).map((f) => f.tint);
    assert.equal(new Set(tints).size, tints.length, 'family tints are all distinct');
  }
  for (const id of Object.keys(WEAPON_DEFS)) {
    assert.ok(AMMO_TYPES[WEAPON_AMMO[id]], `${id} maps to a known ammunition family`);
  }
});

check('B11. field crates are a bounded allocation, not an unlimited top-up', () => {
  // Repairing resupplyAll made the old "refill everything" crate *work* — which,
  // left alone, turned five crates per mission into unlimited ammunition. A crate
  // now issues one bounded family allocation and can only be opened once.
  const { g, spot } = range(['vx4', 'p9', 'st12']);
  const v = g.weapons.state.vx4, smg = g.weapons.state.p9, sh = g.weapons.state.st12;
  for (const st of [v, smg, sh]) { st.mag = 0; st.reserve = 0; }
  const crates = g.world.interactables.filter((it) => it.id.startsWith('ammo_') && !packOf(it));
  assert.ok(crates.length >= 1, `the map places ${crates.length} crate(s)`);
  const onHand = () => v.mag + v.reserve + smg.mag + smg.reserve + sh.mag + sh.reserve;
  let opened = 0;
  for (const c of crates) { if (c.action(g)) opened++; }
  const total = onHand();
  assert.ok(total > 0, `crates granted ${total} rounds across ${opened} openings`);
  const caps = WEAPON_DEFS.vx4.magSize + WEAPON_DEFS.vx4.reserveMax
    + WEAPON_DEFS.p9.magSize + WEAPON_DEFS.p9.reserveMax
    + WEAPON_DEFS.st12.magSize + WEAPON_DEFS.st12.reserveMax;
  assert.ok(total < caps, `${total} rounds from ${opened} crates is below the ${caps}-round full-loadout cap (not a top-up of everything)`);
  const before = total;
  crates[0].action(g);
  assert.equal(onHand(), before, 'a spent crate grants nothing further');
  assert.equal(crates[0].used, true, 'and stays used');
  void spot;
});

// ---------------------------------------------------------------------------
// Economy summary (printed, not asserted): the numbers quoted in the fix report
// come from this run so a reader can reproduce them with the same command.
if (perMission.length) {
  const packs = perMission.reduce((a, m) => a + m.packs, 0);
  const rounds = perMission.reduce((a, m) => a + m.rounds, 0);
  const byType = {}, bySize = {};
  for (const m of perMission) {
    for (const t of m.types) byType[t] = (byType[t] || 0) + 1;
    for (const r of m.sizes) bySize[r] = (bySize[r] || 0) + 1;
  }
  const opt = perMission.reduce((a, m) => a + m.optional, 0);
  const first = perMission.slice(0, 10).reduce((a, m) => a + m.packs, 0);
  const last = perMission.slice(-10).reduce((a, m) => a + m.packs, 0);
  const fmt = (o) => Object.keys(o).sort().map((k) => `${k} ${o[k]}`).join(', ');
  console.log(`\nECONOMY  ${packs} packs over ${perMission.length} missions (${(packs / perMission.length).toFixed(1)}/mission), ${rounds} rounds of ammunition total`);
  console.log(`         by family: ${fmt(byType)}`);
  console.log(`         by size:   ${fmt(bySize)}`);
  console.log(`         off-the-route: ${opt} · packs in ops 1-10: ${first} · ops 91-100: ${last}`);
  console.log(`         crates: ${perMission.reduce((a, m) => a + m.crates, 0)} field crates across the campaign (bounded allocation each)\n`);
}

// ---------------------------------------------------------------------------
const passed = results.filter((r) => r.ok).length;
console.log('\n' + '='.repeat(66));
console.log(`${passed}/${results.length} ammunition pickup tests passed`);
console.log('='.repeat(66));
if (passed !== results.length) process.exitCode = 1;
