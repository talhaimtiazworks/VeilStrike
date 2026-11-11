/**
 * js/ammo.js — the ammunition-type layer.
 *
 * Why this exists: every pickup used to call `Player.resupplyAll()`, which did
 * `reserve = min(reserveMax, reserve + …)`. For the VX-4 (`reserveMax: 0`, the
 * whole 300-round mission load lives in `mag`) that meant a resupply crate both
 * **did nothing** for the primary rifle and **silently zeroed** any legacy
 * reserve the save carried. Ammunition accounting needs one owner.
 *
 * This module owns only the *policy* (which weapons share which ammunition,
 * and how much a pack holds). The *mutation* stays in `WeaponSystem`, which is
 * the single place that touches `mag`/`reserve`, so a pickup, an armoury pad and
 * a reload can never disagree or double-count.
 */
import { WEAPON_DEFS, WEAPON_ORDER } from './weapons.js';

/** Ammunition families. Derived from the existing weapon classes — a new weapon
 * only needs an entry in WEAPON_AMMO below, never a new pickup code path. */
export const AMMO_TYPES = {
  rifle:    { label: 'RIFLE',    crates: ['AMMUNITION CRATE', 'RIFLE AMMO BOX'],        tint: 0x8a7a3a, max: 200, crate: 80 },
  marksman: { label: 'MARKSMAN', crates: ['PRECISION AMMO CASE', 'MARKSMAN AMMO PACK'], tint: 0x4d7a86, max: 160, crate: 40 },
  precision:{ label: 'PRECISION',crates: ['SNIPER AMMO CASE'],                          tint: 0x5d6f9c, max: 40, crate: 25 },
  smg:      { label: 'SMG',      crates: ['SUBMACHINE-GUN AMMO BOX', 'SMG AMMO PACK'],  tint: 0x7c6a4f, max: 240, crate: 90 },
  shell:    { label: 'SHOTGUN',  crates: ['SHOTGUN SHELL CRATE', '12-GAUGE BOX'],      tint: 0x93502f, max: 96, crate: 32 },
  support:  { label: 'SUPPORT',  crates: ['BELT AMMO CONTAINER', 'HMG AMMO CRATE'],    tint: 0x55604a, max: 240, crate: 90 },
};

/** Weapon → family. Weapons in the same family share pickups, as the real
 * things they are modelled on do. */
export const WEAPON_AMMO = {
  vx4: 'rifle', cr9: 'rifle', rk4: 'rifle',
  mr7: 'marksman', sz8: 'marksman',
  lb9: 'precision',
  vekp: 'smg', mpx5: 'smg', p9: 'smg',
  st12: 'shell', vx12: 'shell',
  hmg9: 'support',
};

const _byType = new Map();
for (const id of WEAPON_ORDER) {
  const type = WEAPON_AMMO[id] || 'rifle';
  if (!_byType.has(type)) _byType.set(type, []);
  _byType.get(type).push(id);
}

export function ammoTypeOf(weaponId) {
  return WEAPON_AMMO[weaponId] || null;
}

/** Weapons a pack of this family can replenish. */
export function weaponsForType(type) {
  return _byType.get(type) || [];
}

export function isCompatible(type, weaponId) {
  return ammoTypeOf(weaponId) === type;
}

/** The quantity ladder the design asks for; anything else is clamped to it. */
export const AMMO_PACK_SIZES = [10, 20, 30, 40, 50];

export function normalisePackRounds(n) {
  const v = Math.round(Number(n) || 0);
  if (v <= 0) return 0;
  let best = AMMO_PACK_SIZES[0];
  for (const s of AMMO_PACK_SIZES) if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  return best;
}

/**
 * Grant one pack to the player.
 *
 * Rules, all of them asserted in tests/ammunition_tests.mjs:
 *  · only weapons of the pack's family are touched (or exactly one weapon when
 *    the pack is weapon-specific);
 *  · a weapon's magazine is topped up first, the remainder goes to reserve,
 *    and nothing is ever added past `magSize`/`reserveMax` — the unspent
 *    remainder is reported back rather than destroyed;
 *  · `WeaponSystem.addRounds` is the only mutator, so this can neither
 *    duplicate a grant nor race with reload accounting.
 *
 * @returns {{granted:number, wasted:number, perWeapon:Array, label:string}}
 */
export function grantPack(game, { type = null, weapon = null, rounds = 30 } = {}) {
  const ws = game && game.weapons;
  if (!ws || !ws.addRounds) return { granted: 0, wasted: 0, perWeapon: [], label: '' };
  const amount = normalisePackRounds(rounds);
  if (amount <= 0) return { granted: 0, wasted: 0, perWeapon: [], label: '' };

  // Only weapons actually in the player's hands may receive rounds. Without this
  // filter a full rifle still "consumed" a pack by parking the spare rounds in an
  // unowned sister weapon's reserve — the pickup reported success, the gun the
  // player carries stayed empty, and the ammo surfaced later as a free bonus.
  const owns = (id) => (!ws.owned || typeof ws.owned.has !== 'function' || ws.owned.has(id));
  const targets = (weapon ? [weapon] : weaponsForType(type)).filter(owns);
  if (!targets.length) return { granted: 0, wasted: 0, perWeapon: [], label: '' };

  let granted = 0, wasted = 0;
  const perWeapon = [];
  // Share the pack out: an owned weapon that needs rounds takes its fill; the
  // leftover rolls on to the next compatible weapon so nothing is wasted while
  // a squadmate still has room.
  let pool = amount;
  for (const id of targets) {
    const def = WEAPON_DEFS[id];
    if (!def) continue;
    const want = ws.roundsNeeded ? ws.roundsNeeded(id) : def.magSize + def.reserveMax;
    if (pool <= 0 || want <= 0) continue;
    const take = Math.min(pool, want);
    const res = ws.addRounds(id, take);
    granted += res.added;
    pool -= res.added;
    perWeapon.push({ id, added: res.added, toMag: res.toMag, toReserve: res.toReserve });
  }
  wasted = Math.max(0, pool);

  const label = weapon
    ? `${WEAPON_DEFS[weapon] ? WEAPON_DEFS[weapon].name : weapon.toUpperCase()} AMMO +${granted}`
    : `+${granted} ${(AMMO_TYPES[type] ? AMMO_TYPES[type].label : 'AMMO')} AMMO`;
  return { granted, wasted, perWeapon, label };
}

/**
 * What one field resupply crate is worth. The crate used to call
 * `Player.resupplyAll()`, which tops *every* weapon up to its cap — once the
 * accounting was repaired (Phase 3) that turned five crates per mission into
 * unlimited ammunition, which the brief explicitly rules out. A crate therefore
 * issues a bounded allocation to one family (the weapon you are carrying), and
 * the typed packs on the map are what make up the difference.
 */
/** Rounds a single field crate is worth for one family. The amount lives on the
 * family entry above so there is exactly one table to reason about. */
export function crateAmountFor(type) {
  const fam = AMMO_TYPES[type];
  return fam && fam.crate ? fam.crate : 40;
}

/**
 * Open a field resupply crate. The crate is not calibre-specific the way a pack
 * is, so it feeds the family you are holding and, if that is already full, the
 * next owned family with room — a crate that grants nothing would otherwise be a
 * dead prop you have to walk past twice. The amount is bounded per family
 * (AMMO_TYPES[].crate) so five crates per mission cannot become unlimited ammo.
 */
export function grantCrate(game) {
  const ws = game && game.weapons;
  if (!ws) return { granted: 0, label: '', type: null };
  const equipped = ws.currentId && WEAPON_AMMO[ws.currentId];
  const owned = [...(ws.owned || [])].map((id) => WEAPON_AMMO[id]).filter(Boolean);
  const order = [];
  for (const t of [equipped, ...owned]) if (t && !order.includes(t)) order.push(t);
  if (!order.length) order.push('rifle');
  for (const type of order) {
    const res = grantPack(game, { type, rounds: crateAmountFor(type) });
    if (res.granted > 0) {
      return {
        ...res, type,
        label: `RESUPPLY +${res.granted} ${(AMMO_TYPES[type] || {}).label || 'AMMO'} AMMO`,
      };
    }
  }
  return { granted: 0, wasted: 0, perWeapon: [], label: '', type: order[0] };
}
