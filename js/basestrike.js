/**
 * basestrike.js — Master upgrade Phase 8: one-action BASE STRIKE.
 *
 * Designated enemy base (per mission, deterministic):
 *  - The anchor is the densest authored hostile garrison cluster (count of
 *    other enemySpawns within 18 m) that is at least MIN_ANCHOR_DIST from the
 *    player insertion point. No anchor on the range/training map.
 *  - Three base structures (generator, ammunition cache, comms mast) are
 *    placed around the anchor with the world's existing stateful-destructible
 *    helper (world.addDestructibleBox → real colliders, finite HP, damaged/
 *    destroyed states, checkpoint reset support). Every candidate spot is
 *    validated: ground under it, no collider overlap, clear of authored
 *    hostile spawn points, never near the player insertion. If no valid spot
 *    exists the strike is reported UNAVAILABLE (no fake target).
 *
 * Activation (one key / one tap — [K] desktop, STK button mobile, pause menu):
 *  checks → charges > 0, not already in flight, base not already destroyed,
 *  player alive & in mission, player ≥ DANGER_CLOSE from the base. On success
 *  a charge is consumed immediately (re-presses during the countdown are
 *  rejected — no duplicate strikes), a beacon + radio countdown runs in GAME
 *  time (pausing pauses it), then IMPACTS staggered detonations go through
 *  the game's real explodeAt() pipeline (cover-checked damage to enemies,
 *  vehicles, props, glass; enemies killed there go through the authoritative
 *  EnemyManager.damage → kill counter/KILLED confirmation), and every base
 *  structure is destroyed through world.damageDestructible (colliders removed).
 *  Results are written to stats (baseDestroyed, baseStrikeKills) for the
 *  debrief; unrelated mission objectives are never touched.
 */
import * as THREE from 'three';

export const BASE_STRIKE_DEF = {
  charges: 1,
  countdown: 3.5,          // seconds from confirm to first impact
  impactGap: 0.42,         // seconds between detonations
  impactRadius: 9.0,
  power: 1.8,              // explodeAt power scale (frag = 1): lethal inner radius, cover still applies
  dangerClose: 30,         // player must be at least this far from the base
  minAnchorDist: 45,       // base anchor distance from insertion
};

const STRUCTURES = [
  { key: 'generator', label: 'ENEMY GENERATOR', w: 1.8, h: 1.3, d: 1.1, color: 0x3d4630, emissive: 0x1a0d04, hp: 220, mat: 'metal' },
  { key: 'ammo',      label: 'AMMUNITION CACHE', w: 1.4, h: 0.9, d: 1.0, color: 0x4a4228, emissive: 0x000000, hp: 160, mat: 'wood' },
  { key: 'mast',      label: 'COMMS MAST',       w: 0.4, h: 5.2, d: 0.4, color: 0x5c6066, emissive: 0x330000, hp: 180, mat: 'metal' },
];

const _v = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _bmin = new THREE.Vector3();
const _bmax = new THREE.Vector3();

export class BaseStrike {
  constructor(game) {
    this.game = game;
    this.structures = [];   // destructible items (world-owned)
    this.anchor = null;
    this.charges = 0;
    this.state = 'unavailable';   // unavailable | ready | inbound | striking | spent | complete
    this.reason = 'NO DESIGNATED BASE';
    this._t = 0;
    this._impacts = [];
    this._beacon = null;
    this.lastResult = null;
  }

  // ------------------------------------------------------------------ setup
  /** Called after world build + garrison spawn for a mission. */
  setupForMission(missionId) {
    this._clear();
    const g = this.game, w = g.world;
    if (!w || missionId === 'range' || !w.addDestructibleBox) { this.reason = 'NO DESIGNATED BASE ON THIS MAP'; return false; }
    const spawns = (w.enemySpawns || []).map(s => s.pos);
    const ins = w.spawnPoint || new THREE.Vector3();
    if (spawns.length < 3) { this.reason = 'NO DESIGNATED BASE ON THIS MAP'; return false; }
    // densest cluster far enough from insertion (deterministic ordering)
    let best = null, bestScore = -1;
    for (const p of spawns) {
      const dIns = Math.hypot(p.x - ins.x, p.z - ins.z);
      if (dIns < BASE_STRIKE_DEF.minAnchorDist) continue;
      let n = 0;
      for (const q of spawns) if (q !== p && Math.hypot(q.x - p.x, q.z - p.z) < 18) n++;
      const score = n * 1000 + dIns;          // density first, distance tiebreak
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) {   // small maps: farthest garrison instead
      for (const p of spawns) {
        const dIns = Math.hypot(p.x - ins.x, p.z - ins.z);
        if (dIns > bestScore) { bestScore = dIns; best = p; }
      }
      if (!best || bestScore < BASE_STRIKE_DEF.dangerClose + 5) { this.reason = 'NO SAFE BASE TARGET ON THIS MAP'; return false; }
    }
    this.anchor = best.clone();
    // place structures on rings around the anchor
    let placed = 0;
    for (let si = 0; si < STRUCTURES.length; si++) {
      const S = STRUCTURES[si];
      const spot = this._findSpot(S, si, spawns, ins);
      if (!spot) continue;
      const mat = new THREE.MeshStandardMaterial({ color: S.color, roughness: 0.78, metalness: S.mat === 'metal' ? 0.45 : 0.05, emissive: S.emissive, emissiveIntensity: 0.35 });
      const item = w.addDestructibleBox('enemy-base-' + S.key, spot.x, spot.y, spot.z, S.w, S.h, S.d, mat, S.mat, { label: S.label, health: S.hp });
      if (!item) continue;
      item.base = true;
      item.baseKey = S.key;
      if (item.collider) item.collider.tag = 'destructible';   // keep existing tag semantics
      this.structures.push(item);
      placed++;
    }
    if (placed === 0) { this.reason = 'BASE SITE BLOCKED — STRIKE UNAVAILABLE'; this.anchor = null; return false; }
    this.charges = BASE_STRIKE_DEF.charges;
    this.state = 'ready';
    this.reason = '';
    this._buildBeacon();
    return true;
  }

  _findSpot(S, index, spawns, ins) {
    const g = this.game, phys = g.physics;
    const a = this.anchor;
    for (let ring = 0; ring < 6; ring++) {
      const r = 4 + ring * 2.2;
      for (let k = 0; k < 12; k++) {
        const ang = (index * 2.1) + k * (Math.PI / 6);
        const x = a.x + Math.cos(ang) * r, z = a.z + Math.sin(ang) * r;
        const top = _v.set(x, (a.y || 0) + 4, z);
        const hit = phys.raycast(top, _down, 9);
        if (!hit || hit.normal.y < 0.85) continue;
        const gy = hit.point.y;
        if (Math.hypot(x - ins.x, z - ins.z) < BASE_STRIKE_DEF.minAnchorDist * 0.6) continue;
        let nearSpawn = false;
        for (const p of spawns) if (Math.hypot(p.x - x, p.z - z) < 2.2) { nearSpawn = true; break; }
        if (nearSpawn) continue;
        const m = 0.45;
        _bmin.set(x - S.w / 2 - m, gy + 0.05, z - S.d / 2 - m);
        _bmax.set(x + S.w / 2 + m, gy + S.h, z + S.d / 2 + m);
        let blocked = false;
        for (const c of phys.colliders) {
          if (!c.enabled || c.sensor) continue;
          if (_bmin.x < c.max.x && _bmax.x > c.min.x && _bmin.z < c.max.z && _bmax.z > c.min.z && _bmax.y > c.min.y && _bmin.y < c.max.y) {
            if (c.max.y <= gy + 0.12) continue;
            blocked = true; break;
          }
        }
        if (blocked) continue;
        return { x, y: gy, z };
      }
    }
    return null;
  }

  _buildBeacon() {
    const g = this.game;
    if (!this.anchor || !g.scene) return;
    const mast = this.structures.find(s => s.baseKey === 'mast') || this.structures[0];
    const geo = new THREE.SphereGeometry(0.16, 10, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff3326 });
    const m = new THREE.Mesh(geo, mat);
    const top = mast.pos.clone();
    top.y += (mast.baseKey === 'mast' ? 2.7 : 1.0);
    m.position.copy(top);
    g.scene.add(m);
    this._beacon = m;
  }

  get alive() { return this.structures.filter(s => !s.destroyed).length; }
  get basePos() { return this.anchor; }

  // ------------------------------------------------------------- activation
  /** Pure check: { ok, reason }. */
  canActivate() {
    const g = this.game, p = g.player;
    if (g.state !== 'playing') return { ok: false, reason: 'NOT IN MISSION' };
    if (!p || !p.alive) return { ok: false, reason: 'OPERATOR DOWN' };
    if (this.state === 'unavailable') return { ok: false, reason: this.reason || 'NO DESIGNATED BASE' };
    if (this.state === 'inbound' || this.state === 'striking') return { ok: false, reason: 'STRIKE ALREADY INBOUND' };
    if (this.state === 'complete' || this.alive === 0) return { ok: false, reason: 'ENEMY BASE ALREADY DESTROYED' };
    if (this.charges <= 0) return { ok: false, reason: 'NO STRIKE CHARGES LEFT' };
    const d = Math.hypot(p.pos.x - this.anchor.x, p.pos.z - this.anchor.z);
    if (d < BASE_STRIKE_DEF.dangerClose) return { ok: false, reason: `DANGER CLOSE — MOVE ${Math.ceil(BASE_STRIKE_DEF.dangerClose - d)} M FURTHER FROM THE BASE` };
    return { ok: true, dist: d };
  }

  activate() {
    const g = this.game;
    const chk = this.canActivate();
    if (!chk.ok) {
      g.ui && g.ui.toastBrief('BASE STRIKE DENIED — ' + chk.reason, 2.2);
      g.audio && g.audio.dryFire && g.audio.dryFire();
      return chk;
    }
    this.charges--;                          // consumed at confirm: no double triggers
    this.state = 'inbound';
    this._t = 0;
    this._killsAtStart = g.stats ? g.stats.kills : 0;
    this._impacts.length = 0;
    // impact plan: each living structure + the anchor, staggered
    // each structure gets its own impact (destroyed as that round lands), then the anchor
    const targets = this.structures.filter(s => !s.destroyed).map(s => ({ pos: s.pos.clone(), item: s }));
    targets.push({ pos: this.anchor.clone().setY((this.anchor.y || 0) + 0.4), item: null });
    targets.forEach((tg, i) => this._impacts.push({ t: BASE_STRIKE_DEF.countdown + i * BASE_STRIKE_DEF.impactGap, pos: tg.pos, item: tg.item, done: false }));
    g.ui && g.ui.radio('BASE STRIKE CONFIRMED — IMPACT IN ' + Math.ceil(BASE_STRIKE_DEF.countdown) + ' SECONDS');
    g.ui && g.ui.toast && g.ui.toast('BASE STRIKE', 'INBOUND — STAY CLEAR OF THE TARGET');
    g.audio && g.audio.alarm && this.anchor && g.audio.alarm(this.anchor);
    g.stats.baseStrikeUsed = true;
    return { ok: true };
  }

  // ----------------------------------------------------------------- update
  update(dt) {
    const g = this.game;
    if (this._beacon) {
      const blink = this.state === 'inbound' ? (Math.sin(this._t * 18) > 0) : (Math.sin(g.time * 3) > 0.2);
      this._beacon.visible = blink && this.state !== 'complete';
    }
    if (this.state !== 'inbound' && this.state !== 'striking') return;
    this._t += dt;
    for (const imp of this._impacts) {
      if (imp.done || this._t < imp.t) continue;
      imp.done = true;
      this.state = 'striking';
      // A direct hit destroys the designated structure first through the world's
      // real destructible path (collider removed → navigation/LOS update); the
      // detonation then happens at that spot, so the blast is not smothered by
      // the structure's own collider (measured defect: centre-of-box origins
      // were fully occluded by the cover check).
      if (imp.item && !imp.item.destroyed && g.world && g.world.damageDestructible) g.world.damageDestructible(imp.item, imp.item.health + 1, g, imp.item.pos, null);
      const at = imp.item ? imp.pos.clone().setY(imp.item.pos.y - imp.item.mesh.geometry.parameters.height / 2 + 0.5) : imp.pos;
      g.explodeAt(at, { radius: BASE_STRIKE_DEF.impactRadius, power: BASE_STRIKE_DEF.power, owner: 'player', source: 'player' });
      g.addShake && g.addShake(0.35);
    }
    if (this._impacts.length && this._impacts.every(i => i.done)) this._finish();
  }

  _finish() {
    const g = this.game, w = g.world;
    // guarantee the designated structures are destroyed through the real
    // destructible path (removes colliders; explosion damage may already have)
    for (const s of this.structures) {
      if (!s.destroyed && w && w.damageDestructible) w.damageDestructible(s, s.health + 1, g, s.pos, null);
    }
    this.state = 'complete';
    if (this._beacon) this._beacon.visible = false;
    const kills = g.stats ? g.stats.kills - (this._killsAtStart || 0) : 0;
    g.stats.baseDestroyed = true;
    g.stats.baseStrikeKills = kills;
    this.lastResult = { destroyed: this.structures.filter(s => s.destroyed).length, total: this.structures.length, kills };
    g.ui && g.ui.toast && g.ui.toast('ENEMY BASE DESTROYED', `${this.lastResult.destroyed}/${this.lastResult.total} STRUCTURES · ${kills} HOSTILES ELIMINATED`);
    g.ui && g.ui.radio('GOOD EFFECT ON TARGET — ENEMY BASE DESTROYED');
    g.audio && g.audio.objectiveComplete && g.audio.objectiveComplete();
  }

  /** Checkpoint restart: world.resetDestructibles() restored the structures. */
  resetForCheckpoint() {
    this._impacts.length = 0;
    if (!this.structures.length) return;
    this.charges = BASE_STRIKE_DEF.charges;
    this.state = 'ready';
    if (this.game.stats) { this.game.stats.baseDestroyed = false; }
  }

  _clear() {
    const g = this.game;
    if (this._beacon) {
      try { g.scene.remove(this._beacon); this._beacon.geometry.dispose(); this._beacon.material.dispose(); } catch (_) { /* torn down */ }
      this._beacon = null;
    }
    this.structures = [];    // world owns + disposes the destructible meshes/colliders
    this.anchor = null;
    this.charges = 0;
    this.state = 'unavailable';
    this.reason = 'NO DESIGNATED BASE';
    this._impacts.length = 0;
    this._t = 0;
    this.lastResult = null;
  }

  /** Teardown/abort: cancel anything in flight. */
  reset() { this._clear(); }

  hudText() {
    switch (this.state) {
      case 'ready': return `STRIKE ×${this.charges} [K]`;
      case 'inbound': return `STRIKE ${Math.max(0, Math.ceil(BASE_STRIKE_DEF.countdown - this._t))}S`;
      case 'striking': return 'STRIKE IMPACT';
      case 'complete': return 'BASE DOWN';
      default: return 'BASE STRIKE —';
    }
  }
}
