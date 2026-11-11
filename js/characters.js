/**
 * characters.js — Phase-14 operator roster: ten selectable characters with
 * measurable stat differences and one distinct ability each.
 *
 * Architecture:
 *  - CHARACTER_DEFS is the single source of truth (stats + ability config).
 *  - CharacterSystem applies the selected character to the live player:
 *    multipliers hook into player.speedMultiplier / handlingMultiplier /
 *    spreadMultiplier (existing aggregation points), maxHealth, and a
 *    detection multiplier consumed by enemies (player.visibilityMult).
 *  - Abilities share one interface: canActivate(now) / activate() / update(dt) /
 *    cancel(reason). Cooldowns, charges, expiry, death/pause/mission-end
 *    cancellation all run through the shared lifecycle below.
 *  No fake effects: every ability touches a real, inspectable system and is
 *  covered by the P14 batteries.
 */
export const CHARACTER_ORDER = ['vanguard', 'scout', 'bulwark', 'marksman', 'medic', 'engineer', 'ghost', 'tracker', 'disruptor', 'specialist'];

export const CHARACTER_DEFS = {
  vanguard: {
    id: 'vanguard', name: 'VANGUARD', role: 'BALANCED OPERATOR',
    desc: 'Baseline service operator. No modifiers, no ability — the control case every test compares against.',
    stats: { hp: 1.0, speed: 1.0, handling: 1.0, spread: 1.0, visibility: 1.0 },
    ability: null,
    tint: 0x394136,
  },
  scout: {
    id: 'scout', name: 'SCOUT', role: 'ADVANCE RECON',
    desc: '+12% movement speed, −15 hp. Reaches objectives first; pays for it under fire.',
    stats: { hp: 0.85, speed: 1.12, handling: 1.0, spread: 1.0, visibility: 1.0 },
    ability: { id: 'dash', name: 'FIELD DASH', kind: 'burst_speed', cd: 45, dur: 3.0, charges: 2, mult: 1.22, chargesRegen: 45 },
    tint: 0x46513f,
  },
  bulwark: {
    id: 'bulwark', name: 'BULWARK', role: 'HEAVY ASSAULT',
    desc: '+30 hp, −10% movement speed. Walks through fire that drops lighter operators.',
    stats: { hp: 1.3, speed: 0.90, handling: 0.95, spread: 1.05, visibility: 1.0 },
    ability: null,
    tint: 0x4d4a42,
  },
  marksman: {
    id: 'marksman', name: 'MARKSMAN', role: 'PRECISION SPECIALIST',
    desc: '15% tighter weapon spread and faster weapon handling, −8% movement speed.',
    stats: { hp: 1.0, speed: 0.92, handling: 1.15, spread: 0.85, visibility: 1.0 },
    ability: null,
    tint: 0x37424b,
  },
  medic: {
    id: 'medic', name: 'MEDIC', role: 'FIELD SURGEON',
    desc: 'Ability: FIELD SURGE — 6 s of 8 hp/s regeneration (up to 75 hp). 2 charges, 40 s cooldown.',
    stats: { hp: 1.0, speed: 1.0, handling: 1.0, spread: 1.0, visibility: 1.0 },
    ability: { id: 'surge', name: 'FIELD SURGE', kind: 'regen', cd: 40, dur: 6.0, charges: 2, rate: 8, cap: 75 },
    tint: 0x4f5548,
  },
  engineer: {
    id: 'engineer', name: 'ENGINEER', role: 'SYSTEMS TECHNICIAN',
    desc: 'Shield walls gain +40% health, shield cooldown −25%. Passive: 10% faster weapon handling.',
    stats: { hp: 1.0, speed: 1.0, handling: 1.1, spread: 1.0, visibility: 1.0 },
    ability: null,
    traits: { shieldHp: 1.4, shieldCd: 0.75 },
    tint: 0x54503f,
  },
  ghost: {
    id: 'ghost', name: 'GHOST', role: 'INFILTRATION SPECIALIST',
    desc: 'Ability: LOW SIGNATURE — 5 s at 15% detection rate. Not invisibility: close enemies still see you, and firing your weapon or taking a hit instantly breaks it. 60 s cooldown.',
    stats: { hp: 0.9, speed: 1.05, handling: 1.0, spread: 1.0, visibility: 1.0 },
    ability: { id: 'cloak', name: 'LOW SIGNATURE', kind: 'cloak', cd: 60, dur: 5.0, detectMult: 0.15 },
    tint: 0x2f3b37,
  },
  tracker: {
    id: 'tracker', name: 'TRACKER', role: 'TARGET ACQUISITION',
    desc: 'Ability: PULSE SWEEP — marks hostiles within 30 m on the tactical map for 12 s (through walls, like a TS-7 pulse). 45 s cooldown.',
    stats: { hp: 0.95, speed: 1.0, handling: 1.05, spread: 1.0, visibility: 1.0 },
    ability: { id: 'sweep', name: 'PULSE SWEEP', kind: 'reveal', cd: 45, dur: 12, radius: 30 },
    tint: 0x42463a,
  },
  disruptor: {
    id: 'disruptor', name: 'DISRUPTOR', role: 'DENIAL SPECIALIST',
    desc: 'EMP ordnance carries +1 charge and detonates with a 50% larger radius. Baseline stats.',
    stats: { hp: 1.0, speed: 1.0, handling: 1.0, spread: 1.0, visibility: 1.0 },
    ability: null,
    traits: { empBonusQty: 1, empRadius: 1.5 },
    tint: 0x3c4450,
  },
  specialist: {
    id: 'specialist', name: 'SPECIALIST', role: 'TASK-FORCE LEAD',
    desc: 'Ability: ADRENAL BURST — 4 s of +25% sprint speed and +30% reload speed. 60 s cooldown.',
    stats: { hp: 1.05, speed: 1.0, handling: 1.05, spread: 0.95, visibility: 1.0 },
    ability: { id: 'adrenal', name: 'ADRENAL BURST', kind: 'adrenal', cd: 60, dur: 4.0, speedMult: 1.25, reloadMult: 0.7 },
    tint: 0x4a3f46,
  },
};

/** Guard rails: every multiplier sits in a sane gameplay band. */
export function validateCharacterDefs(AUDIT = false) {
  const problems = [];
  for (const id of CHARACTER_ORDER) {
    const c = CHARACTER_DEFS[id];
    if (!c) { problems.push('missing def ' + id); continue; }
    const s = c.stats;
    for (const k of ['hp', 'speed', 'handling', 'spread', 'visibility']) {
      const v = s[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) problems.push(`${id}.${k} invalid: ${v}`);
    }
    if (s.hp < 0.5 || s.hp > 2) problems.push(`${id}.hp out of band`);
    if (s.speed < 0.6 || s.speed > 1.4) problems.push(`${id}.speed out of band`);
    if (s.visibility <= 0 || s.visibility > 2) problems.push(`${id}.visibility out of band`);
    if (c.ability) {
      const a = c.ability;
      if (!(a.cd > 0 && a.cd <= 300)) problems.push(`${id}.ability.bad-cd`);
      if (['burst_speed', 'regen', 'cloak', 'reveal', 'adrenal'].indexOf(a.kind) < 0) problems.push(`${id}.ability unknown kind ${a.kind}`);
      if (a.dur !== undefined && !(a.dur > 0 && a.dur <= 30)) problems.push(`${id}.ability.bad-dur`);
    }
  }
  if (AUDIT) for (const p of problems) console.warn('[characters]', p);
  return problems;
}

/**
 * Live application + ability runtime. One instance per Game; reset() is called
 * at every mission start; cancel() on death/pause/mission-end/menu.
 */
export class CharacterSystem {
  constructor(game) {
    this.game = game;
    this.id = 'vanguard';
    this.active = null;      // {def, t, dur} active ability instance
    this.cooldownLeft = 0;
    this.charges = 0;
    this._chargeRegenT = 0;
    this._applied = null;
  }

  get def() { return CHARACTER_DEFS[this.id] || CHARACTER_DEFS.vanguard; }
  get abilityDef() { return this.def.ability || null; }

  select(id) {
    if (!CHARACTER_DEFS[id]) return false;
    this.id = id;
    this.apply();
    return true;
  }

  /** Apply stat package to the live player constants. Idempotent. */
  apply() {
    const g = this.game, p = g.player;
    if (!p) return;
    const s = this.def.stats;
    // revert previous hp bonus BEFORE adding the new one so maxHealth never accrues
    if (this._applied && p.maxHealth && this._applied.hp !== 1) {
      const prevMax = 100 * this._applied.hp;
      p.maxHealth = 100;
      if (p.health > p.maxHealth) p.health = p.maxHealth;
    }
    p.maxHealth = Math.round(100 * s.hp);
    if (p.health > p.maxHealth) p.health = p.maxHealth;
    p.charSpeedMult = s.speed;
    p.charHandlingMult = s.handling;
    p.charSpreadMult = s.spread;
    p.visibilityMult = s.visibility;
    g.stats.playerCharacter = this.id;
    if (g.body && g.body.setOperatorKit) g.body.setOperatorKit(this.id);
    if (g.body && g.body.setSuitTint) g.body.setSuitTint(this.def.tint);
    this._applied = { hp: s.hp };
  }

  reset() {
    this.cancel('mission-reset');
    this.cooldownLeft = 0;
    this._chargeRegenT = 0;
    const a = this.abilityDef;
    this.charges = a ? (a.charges || 1) : 0;
    this.apply();
  }

  canActivate() {
    const a = this.abilityDef;
    if (!a) return { ok: false, reason: 'NO ABILITY' };
    if (this.game.state !== 'playing') return { ok: false, reason: 'NOT IN MISSION' };
    if (this.game.vehicleMode) return { ok: false, reason: 'IN VEHICLE' };
    if (this.active) return { ok: false, reason: 'ALREADY ACTIVE' };
    if (this.cooldownLeft > 0) return { ok: false, reason: 'COOLDOWN ' + Math.ceil(this.cooldownLeft) + 'S' };
    if (this.charges <= 0) return { ok: false, reason: 'NO CHARGES' };
    return { ok: true };
  }

  activate() {
    const gate = this.canActivate();
    if (!gate.ok) { this.game.ui.radio(gate.reason); return false; }
    const a = this.abilityDef;
    this.active = { def: a, t: 0, dur: a.dur || 0 };
    this.charges--;
    this.cooldownLeft = a.cd;
    const g = this.game;
    switch (a.kind) {
      case 'cloak':
        g.player.visibilityMult = this.def.stats.visibility * a.detectMult;
        g.ui.toastBrief('LOW SIGNATURE ENGAGED — STAY OUT OF CLOSE RANGE');
        break;
      case 'reveal':
        if (g.throwables) g.throwables.spawnRevealPulse(g.player.pos, a.radius, a.dur, true);
        g.ui.toastBrief('PULSE SWEEP OUT — CONTACTS ON TACMAP');
        break;
      case 'regen':
        g.ui.toastBrief('FIELD SURGE RUNNING');
        break;
      case 'burst_speed':
      case 'adrenal':
        g.ui.toastBrief(a.name + ' — GO');
        break;
    }
    g.audio.uiConfirm && g.audio.uiConfirm();
    return true;
  }

  /** Effective live speed multiplier incl. active ability. Consumed by player. */
  liveSpeedMult() {
    let m = this.def.stats.speed;
    if (this.active) {
      const a = this.active.def;
      if (a.kind === 'burst_speed') m *= a.mult;
      else if (a.kind === 'adrenal') m = this.def.stats.speed * a.speedMult;
    }
    return m;
  }
  liveReloadMult() {
    if (this.active && this.active.def.kind === 'adrenal') return this.active.def.reloadMult;
    return 1;
  }

  // ---------- tactical signal hooks (Phase-14 functional depth) ----------

  /**
   * Ghost LOW SIGNATURE contract: the cloak is a firing-discipline state.
   * Discharging a weapon breaks the signature discipline and drops the cloak
   * (audio cue + HUD refresh flow through cancel()).
   */
  onShoot() {
    if (this.active && this.active.def.kind === 'cloak') this.cancel('shot');
  }
  /** Taking fire blows the cloak too — you're lit once hit. */
  onDamaged() {
    if (this.active && this.active.def.kind === 'cloak') this.cancel('hit');
  }

  update(dt) {
    if (this.cooldownLeft > 0) this.cooldownLeft = Math.max(0, this.cooldownLeft - dt);
    // passive charge regen for multi-charge kits
    const a = this.abilityDef;
    if (a && a.chargesRegen && this.charges < (a.charges || 1) && !this.active) {
      this._chargeRegenT += dt;
      if (this._chargeRegenT >= a.chargesRegen) { this._chargeRegenT = 0; this.charges++; }
    }
    if (!this.active) return;
    const act = this.active;
    act.t += dt;
    const abd = act.def;
    if (abd.kind === 'regen') {
      const p = this.game.player;
      if (p.alive) p.health = Math.min(abd.cap, Math.min(p.maxHealth, p.health + abd.rate * dt));
    }
    if (act.t >= act.dur) this.cancel('expired');
  }

  cancel() {
    if (!this.active) return;
    const a = this.active.def;
    if (a.kind === 'cloak') {
      this.game.player.visibilityMult = this.def.stats.visibility;
    }
    this.active = null;
    if (this.game.ui) this.game.ui.refreshAbilityHud?.();
  }

}

