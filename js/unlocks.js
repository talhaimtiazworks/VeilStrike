/**
 * unlocks.js — Phase-14 centralized unlock registry + evaluation service.
 *
 * ONE service governs weapons, characters and challenge-track unlocks. Every
 * condition derives from REAL gameplay data already recorded by Progress
 * (mission completions, XP, medal stats) — no condition references a
 * nonexistent mission or impossible statistic.
 *
 * Storage: folded into Progress as data.unlocks (schema version 2).
 * Never clears Phase-13 control settings. Validates defensively on load.
 */
import { WEAPON_DEFS } from './weapons.js';
import { CHARACTER_DEFS } from './characters.js';

/** The ten-armory roster ordering used across UI and unlock evaluation. */
export const ARMORY_ORDER = ['vx4', 'vekp', 'cr9', 'rk4', 'st12', 'sz8', 'lb9', 'p9', 'hmg9', 'mr7'];
/** Roster items excluded from the armory grid (kept for campaign loadouts). */
export const CAMPAIGN_ONLY = ['vx12', 'mpx5'];

/**
 * Weapon unlock conditions. ctx = {
 *   completedCount, missions:{}, xp, accShots, accHits, medals:[], stats:{}
 * }
 * `label(d)` must describe the requirement exactly as evaluated.
 */
export const WEAPON_UNLOCKS = {
  vx4:  { label: 'STARTING SERVICE RIFLE', check: () => true },
  vekp: { label: 'COMPLETE 1 MISSION', check: c => c.completedCount >= 1 },
  cr9:  { label: 'COMPLETE 2 MISSIONS', check: c => c.completedCount >= 2 },
  rk4:  { label: 'REACH 600 XP (RANK: OPERATOR)', check: c => c.xp >= 600 },
  st12: { label: 'COMPLETE OPERATION: DUSTBOWL CACHE (desert)', check: c => !!(c.missions.desert && c.missions.desert.completed) },
  sz8:  { label: 'COMPLETE 3 MISSIONS', check: c => c.completedCount >= 3 },
  lb9:  { label: 'COMPLETE 4 MISSIONS (PRECISION OPERATOR)', check: c => c.completedCount >= 4 },
  p9:   { label: 'STARTING SIDEARM', check: () => true },
  hmg9: { label: 'COMPLETE 2 OPTIONAL OBJECTIVES ACROSS MISSIONS', check: c => (c.stats.optionalCompleted || 0) >= 2 },
  mr7:  { label: 'COMPLETE 8 MISSIONS (CAMPAIGN MIDPOINT)', check: c => c.completedCount >= 8 },
};

/** Character unlock condition order matches the roster narrative. */
export const CHARACTER_UNLOCKS = {
  vanguard:  { label: 'ALWAYS AVAILABLE', check: () => true },
  scout:     { label: 'COMPLETE 1 MISSION', check: c => c.completedCount >= 1 },
  bulwark:   { label: 'COMPLETE 2 MISSIONS', check: c => c.completedCount >= 2 },
  marksman:  { label: 'COMPLETE 3 MISSIONS', check: c => c.completedCount >= 3 },
  medic:     { label: 'REACH 1,600 XP (RANK: SPECIALIST)', check: c => c.xp >= 1600 },
  engineer:  { label: 'COMPLETE 4 MISSIONS', check: c => c.completedCount >= 4 },
  ghost:     { label: 'EARN THE GHOST MEDAL (NO MAJOR ALERT, ANY INFILTRATION)', check: c => c.medals.includes('ghost') },
  tracker:   { label: 'COMPLETE 5 MISSIONS', check: c => c.completedCount >= 5 },
  disruptor: { label: 'COMPLETE 4+ OPTIONAL OBJECTIVES ACROSS MISSIONS', check: c => (c.stats.optionalCompleted || 0) >= 4 },
  specialist:{ label: 'REACH 5,400 XP (RANK: FIELD EXPERT)', check: c => c.xp >= 5400 },
};

function buildCtx(data) {
  const missions = data.missions || {};
  const completedCount = Object.keys(missions).filter(k => missions[k] && missions[k].completed).length;
  const ch = (data.unlocks && data.unlocks.challenge) || { accShots: 0, accHits: 0 };
  let accShots = ch.accShots || 0, accHits = ch.accHits || 0;
  // One-time adoption: saves predating Phase-14 hold lifetime accuracy in
  // stats but have empty challenge counters. A legacy operator is evaluated
  // against their real lifetime numbers instead of being re-tested from zero.
  if (accShots === 0 && data.stats && (data.stats.shots | 0) > 0) {
    accShots = data.stats.shots | 0;
    accHits = data.stats.hits | 0;
  }
  return {
    completedCount, missions, xp: data.xp || 0,
    accShots, accHits,
    medals: data.medals || [], stats: data.stats || {},
  };
}

export function defaultUnlocks() {
  return {
    weapons: { vx4: true, p9: true }, characters: { vanguard: true },
    equippedWeapon: 'vx4', selectedCharacter: 'vanguard',
    challenge: { accShots: 0, accHits: 0 },
    notified: [],
  };
}

/** Defensive load-merge: returns a valid unlock bag for any input. */
export function sanitizeUnlocks(raw) {
  const d = defaultUnlocks();
  if (!raw || typeof raw !== 'object') return d;
  for (const id of ARMORY_ORDER) if (raw.weapons && raw.weapons[id] === true) d.weapons[id] = true;
  for (const id in CHARACTER_DEFS) if (raw.characters && raw.characters[id] === true) d.characters[id] = true;
  if (raw.weapons && raw.weapons[raw.equippedWeapon] === true && WEAPON_DEFS[raw.equippedWeapon]) d.equippedWeapon = raw.equippedWeapon;
  if (raw.selectedCharacter && raw.characters && raw.characters[raw.selectedCharacter] === true && CHARACTER_DEFS[raw.selectedCharacter]) d.selectedCharacter = raw.selectedCharacter;
  if (raw.challenge && typeof raw.challenge === 'object') {
    d.challenge.accShots = Math.max(0, raw.challenge.accShots | 0);
    d.challenge.accHits = Math.min(d.challenge.accShots, Math.max(0, raw.challenge.accHits | 0));
  }
  if (Array.isArray(raw.notified)) d.notified = raw.notified.filter(x => typeof x === 'string');
  return d;
}

/**
 * Evaluate all unlock conditions against current progress data.
 * Returns { newlyUnlocked: [{kind, id, label}] } and mutates data.unlocks in
 * place (idempotent — an already-true flag is never re-granted, so rewards
 * can never double-fire).
 */
export function evaluateUnlocks(data) {
  if (!data.unlocks) data.unlocks = defaultUnlocks();
  const ctx = buildCtx(data);
  const out = [];
  for (const id of ARMORY_ORDER) {
    const u = WEAPON_UNLOCKS[id];
    if (!u || data.unlocks.weapons[id]) continue;
    let ok = false;
    try { ok = !!u.check(ctx); } catch (_) { ok = false; }
    if (ok) { data.unlocks.weapons[id] = true; out.push({ kind: 'weapon', id, label: (WEAPON_DEFS[id] && WEAPON_DEFS[id].name) || id, req: u.label }); }
  }
  for (const id in CHARACTER_DEFS) {
    const u = CHARACTER_UNLOCKS[id];
    if (!u || data.unlocks.characters[id]) continue;
    let ok = false;
    try { ok = !!u.check(ctx); } catch (_) { ok = false; }
    if (ok) { data.unlocks.characters[id] = true; out.push({ kind: 'character', id, label: CHARACTER_DEFS[id].name, req: u.label }); }
  }
  return out;
}

/** Static self-check used by tests + boot diagnostics. */
export function validateUnlockRegistry(AUDIT = false) {
  const problems = [];
  for (const id of ARMORY_ORDER) {
    if (!WEAPON_DEFS[id]) problems.push('armory id missing from WEAPON_DEFS: ' + id);
    if (!WEAPON_UNLOCKS[id]) problems.push('armory id missing unlock: ' + id);
  }
  for (const id in WEAPON_UNLOCKS) if (!ARMORY_ORDER.includes(id)) problems.push('unlock for non-roster id: ' + id);
  for (const id in CHARACTER_DEFS) if (!CHARACTER_UNLOCKS[id]) problems.push('character missing unlock: ' + id);
  for (const id in CHARACTER_UNLOCKS) if (!CHARACTER_DEFS[id]) problems.push('unlock for unknown character: ' + id);
  if (AUDIT) for (const p of problems) console.warn('[unlock-registry]', p);
  return problems;
}

/** Progress-percentage toward a requirement, for UI displays (0..1). */
export function unlockProgress(kind, id, data) {
  const reg = kind === 'weapon' ? WEAPON_UNLOCKS : CHARACTER_UNLOCKS;
  const u = reg[id];
  if (!u) return 0;
  if ((kind === 'weapon' ? data.unlocks.weapons[id] : data.unlocks.characters[id])) return 1;
  const ctx = buildCtx(data);
  try { if (u.check(ctx)) return 1; } catch (_) { return 0; }
  switch (id) {
    case 'vekp': case 'scout': return Math.min(1, ctx.completedCount / 1);
    case 'cr9': case 'bulwark': return Math.min(1, ctx.completedCount / 2);
    case 'sz8': case 'marksman': return Math.min(1, ctx.completedCount / 3);
    case 'engineer': return Math.min(1, ctx.completedCount / 4);
    case 'tracker': return Math.min(1, ctx.completedCount / 5);
    case 'mr7': return Math.min(1, ctx.completedCount / 8);
    case 'rk4': return Math.min(1, ctx.xp / 600);
    case 'medic': return Math.min(1, ctx.xp / 1600);
    case 'specialist': return Math.min(1, ctx.xp / 5400);
    case 'lb9': return Math.min(1, ctx.completedCount / 4);
    case 'hmg9': return Math.min(1, (ctx.stats.optionalCompleted || 0) / 2);
    case 'disruptor': return Math.min(1, (ctx.stats.optionalCompleted || 0) / 4);
    case 'st12': return (ctx.missions.desert && ctx.missions.desert.completed) ? 1 : 0;
    case 'ghost': return ctx.medals.includes('ghost') ? 1 : 0;
    default: return 0;
  }
}

/**
 * Phase 15: raw current/needed figures for locked-tile display, derived from
 * the SAME evaluation context as the unlock checks (never decorative).
 * Returns '' where a single number pair would be meaningless.
 */
export function unlockProgressText(kind, id, data) {
  if (!data || !data.unlocks) return '';
  if (kind === 'weapon' ? data.unlocks.weapons[id] : data.unlocks.characters[id]) return '';
  const ctx = buildCtx(data);
  const m = Math.min;
  switch (id) {
    case 'vekp': case 'scout': return `${m(1, ctx.completedCount)}/1 MISSIONS`;
    case 'cr9': case 'bulwark': return `${m(2, ctx.completedCount)}/2 MISSIONS`;
    case 'sz8': case 'marksman': return `${m(3, ctx.completedCount)}/3 MISSIONS`;
    case 'engineer': return `${m(4, ctx.completedCount)}/4 MISSIONS`;
    case 'tracker': return `${m(5, ctx.completedCount)}/5 MISSIONS`;
    case 'mr7': return `${m(8, ctx.completedCount)}/8 MISSIONS`;
    case 'rk4': return `${Math.floor(m(600, ctx.xp))}/600 XP`;
    case 'medic': return `${Math.floor(m(1600, ctx.xp))}/1,600 XP`;
    case 'specialist': return `${Math.floor(m(5400, ctx.xp))}/5,400 XP`;
    case 'lb9': return `${m(4, ctx.completedCount)}/4 MISSIONS`;
    case 'hmg9': return `${m(2, ctx.stats.optionalCompleted || 0)}/2 OPTIONALS`;
    case 'disruptor': return `${m(4, ctx.stats.optionalCompleted || 0)}/4 OPTIONALS`;
    case 'st12': return ctx.missions.desert && ctx.missions.desert.completed ? 'DONE' : 'RUN: DUSTBOWL CACHE';
    case 'ghost': return ctx.medals.includes('ghost') ? 'DONE' : 'MEDAL: GHOST';
    default: return '';
  }
}
