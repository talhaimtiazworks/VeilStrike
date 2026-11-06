/**
 * throwables.js
 * Universal throwable / utility framework for VEILSTRIKE (C3).
 * All items are fictional devices; effects are pure gameplay — arcs, fuses,
 * radii and falloff only, no real-world construction detail.
 *
 * Categories:
 *  - THROWABLES (G to equip, LMB throw, RMB soft/alt toss):
 *      VX-FRAG   — timed fragmentation effect (arc, fuse 2.6s, radius, falloff)
 *      MS-2 SMOKE— deploys a vision-blocking smoke volume (~15s)
 *      FL-8 FLASH— bangs after landing: stuns enemies in radius + LOS, whites out the player if facing it
 *      DC-3 DECOY— emits gunshot reports + noise events for 10s (AI investigates)
 *      SG-1 FLARE— burning marker light: reveals enemies in radius (via LOS) on the tac map, lights night scenes
 *  - UTILITIES (wheel or Digit4; LMB primary use, RMB secondary):
 *      TS-7 SENSOR — tossed deployable: marks enemies within radius on the tac map THROUGH walls (~22s)
 *      BR-X BREACH — PLACE on a surface (LMB), ACTIVATE all placed charges (RMB): blast effect,
 *                    forces doors (even locked), shatters nearby glass, mission state updates flow naturally
 *      FIELD MEDKIT— instant heal + partial armor restore
 *
 * VX-FRAG count remains on player.frags so old saves/checkpoints stay compatible.
 */
import * as THREE from 'three';

export const VXFRAG_STOCK_MAX = 20;
export const VXFRAG_MISSION_START = 20;

export const THROWABLE_DEFS = {
  vxfrag: { id: 'vxfrag', name: 'VX-FRAG', cat: 'throwable', kind: 'frag', max: VXFRAG_STOCK_MAX, weight: 0.5, fuse: 2.6, color: 0x3d4a3a },
  smoke: { id: 'smoke', name: 'MS-2 SMOKE', cat: 'throwable', kind: 'smoke', max: 3, weight: 0.5, fuse: 1.1, color: 0x61695e },
  flash: { id: 'flash', name: 'FL-8 FLASH', cat: 'throwable', kind: 'flash', max: 3, weight: 0.4, fuse: 1.5, color: 0x8a8f94 },
  decoy: { id: 'decoy', name: 'DC-3 DECOY', cat: 'throwable', kind: 'decoy', max: 3, weight: 0.4, fuse: 0.5, color: 0x4a4f42 },
  flare: { id: 'flare', name: 'SG-1 FLARE', cat: 'throwable', kind: 'flare', max: 3, weight: 0.4, fuse: 0.9, color: 0xa8452e },
  // ---- Phase-14 throwable expansion (effect handlers land in detonate()) --
  pyro:   { id: 'pyro',   name: 'IG-5 PYRO',        cat: 'throwable', kind: 'incendiary', max: 2, weight: 0.6, fuse: 0.8, color: 0xb44a1e,
            desc: 'Incendiary charge: 8 s burn zone (damage over time + area denial).' },
  empz:   { id: 'empz',   name: 'EMP-4 ARC',        cat: 'throwable', kind: 'emp', max: 2, weight: 0.5, fuse: 0.7, color: 0x2e6f8a,
            desc: 'Electromagnetic pulse: kills enemy flashlights, wipes active enemy sensor/reveal fields, blocks terminal interaction briefly, damages barrier walls.' },
  glue:   { id: 'glue',   name: 'AD-9 STICC',       cat: 'throwable', kind: 'glue', max: 3, weight: 0.4, fuse: 0.5, color: 0xa8a25a,
            desc: 'Adhesive splash: 4 m zone slows hostiles to 45% for 10 s.' },
  siren:  { id: 'siren',  name: 'NE-2 SIREN',       cat: 'throwable', kind: 'siren', max: 2, weight: 0.4, fuse: 0.9, color: 0x8a4a62,
            desc: 'Noise emitter: 14 s of repeating wide pings — draws patrols (louder than a decoy, obviously a device).' },
  ashock: { id: 'ashock', name: 'BX-1 SHOCKBOR',    cat: 'throwable', kind: 'barrier_disruptor', max: 1, weight: 0.6, fuse: 0.6, color: 0xbfa94a,
            desc: 'Barrier disruptor: shredding pulse vs shield walls (260 dmg — one-shots a standard barrier) + brief 6 m EMP-lite.' },
  sensor: { id: 'sensor', name: 'TS-7 SENSOR', cat: 'utility', kind: 'deploy', max: 2, weight: 0.8, fuse: 0.7, color: 0x33454f },
  breach: { id: 'breach', name: 'BR-X BREACH', cat: 'utility', kind: 'place', max: 2, weight: 0.9, fuse: 0, color: 0x6a5030 },
  medkit: { id: 'medkit', name: 'FIELD MEDKIT', cat: 'utility', kind: 'instant', max: 2, weight: 0.6, fuse: 0, color: 0xaab2aa },
};

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/** Local trait lookup (avoids import cycle with characters.js; mirrors shield.js). */
function CHARACTER_TRAITS(game) {
  const sys = game.characters;
  if (!sys || !sys.def) return {};
  return sys.def.traits || {};
}

export class ThrowableSystem {
  constructor(game) {
    this.game = game;
    this.inv = {};
    for (const id in THROWABLE_DEFS) this.inv[id] = 0;
    this.equipped = null;        // throwable id currently in hand ('throwable' mode)
    this.utility = null;         // utility id currently in hand ('utility' mode)
    this.smokeVolumes = [];      // {pos, r, t}
    this.revealVolumes = [];     // {pos, r, t, los:boolean}
    this.decoys = [];            // {pos, t, next, mesh}
    this.charges = [];           // {pos, mesh, blink}
    this.fireZones = [];         // Phase-14 {pos, r, t, tickT, light}
    this.glueZones = [];         // Phase-14 {pos, r, t, tickT, mesh}
    this.sirens = [];            // Phase-14 {pos, t, next, mesh}
    this._mats = {};
    for (const id in THROWABLE_DEFS) {
      this._mats[id] = new THREE.MeshStandardMaterial({ color: THROWABLE_DEFS[id].color, roughness: 0.7, metalness: 0.2 });
    }
    this._chargeMat = new THREE.MeshStandardMaterial({ color: 0x6a5030, roughness: 0.6, metalness: 0.3, emissive: 0xff9a2e, emissiveIntensity: 0 });
    this._fieldMats = {
      flare: new THREE.MeshStandardMaterial({ color: 0xff5a30, emissive: 0xff5a30, emissiveIntensity: 2.4 }),
      sensor: new THREE.MeshStandardMaterial({ color: 0x33454f, roughness: 0.5, metalness: 0.4, emissive: 0x39c6d8, emissiveIntensity: 0.5 }),
    };
    this._geo = null; // lazy shared projectile geo
    this._smokeT = 0;
  }

  // ---------------------------------------------------------------- inventory
  reset(loadout) {
    for (const id in this.inv) this.inv[id] = 0;
    this.clearField();
    if (loadout) {
      if (loadout.throwable && THROWABLE_DEFS[loadout.throwable] && loadout.throwable !== 'vxfrag') {
        // Phase-14 DISRUPTOR trait: EMP ordnance carries +1 charge (raised cap).
        const bonus = loadout.throwable === 'empz' ? (CHARACTER_TRAITS(this.game).empBonusQty || 0) : 0;
        this.inv[loadout.throwable] = Math.min(THROWABLE_DEFS[loadout.throwable].max + bonus, (loadout.throwableCount || 0) + bonus);
      }
      if (loadout.utility && THROWABLE_DEFS[loadout.utility]) {
        this.inv[loadout.utility] = Math.min(THROWABLE_DEFS[loadout.utility].max, loadout.utilityCount || 0);
      }
    }
    const configuredFrags = loadout && loadout.throwable === 'vxfrag' ? (loadout.throwableCount || 0) : 0;
    this.game.player.frags = Math.min(VXFRAG_STOCK_MAX, Math.max(VXFRAG_MISSION_START, configuredFrags));
    this.equipped = null;
    this.utility = null;
  }

  snapshotInv() { return Object.assign({ frags: this.game.player.frags }, this.inv); }
  restoreInv(snap) {
    if (!snap) return;
    for (const id in this.inv) if (snap[id] != null) this.inv[id] = snap[id];
    if (snap.frags != null) this.game.player.frags = Math.max(0, Math.min(VXFRAG_STOCK_MAX, Math.floor(Number(snap.frags) || 0)));
  }

  count(id) {
    if (id === 'vxfrag') return Math.max(0, Math.min(VXFRAG_STOCK_MAX, Math.floor(Number(this.game.player.frags) || 0)));
    return this.inv[id] || 0;
  }

  addOne(id) {
    if (!THROWABLE_DEFS[id]) return false;
    if (id === 'vxfrag') {
      const current = Math.max(0, Math.min(VXFRAG_STOCK_MAX, Math.floor(Number(this.game.player.frags) || 0)));
      if (current >= VXFRAG_STOCK_MAX) return false;
      this.game.player.frags = current + 1;
      return true;
    }
    if (this.inv[id] >= THROWABLE_DEFS[id].max) return false;
    this.inv[id]++;
    return true;
  }

  consume(id) {
    if (id === 'vxfrag') { this.game.player.frags = Math.max(0, this.count('vxfrag') - 1); return; }
    this.inv[id] = Math.max(0, (this.inv[id] || 0) - 1);
  }

  listWithStock(cat) {
    const out = [];
    for (const id in THROWABLE_DEFS) {
      const d = THROWABLE_DEFS[id];
      if (d.cat === cat && this.count(id) > 0) out.push(id);
    }
    return out;
  }

  // ---------------------------------------------------------------- equipping
  /**
   * Cycle fwd/back through stock. dir -1 walks the stock backwards (wraps),
   * which Keyboard N and the mobile cycle-back control use (Phase-14).
   * Default +1 preserves every existing caller exactly.
   */
  cycle(cat, dir = 1) {
    const stock = this.listWithStock(cat);
    if (!stock.length) return null;
    const cur = cat === 'throwable' ? this.equipped : this.utility;
    let idx = cur ? stock.indexOf(cur) : -1;
    if (dir < 0) {
      idx = cur ? (idx - 1 + stock.length) % stock.length : stock.length - 1;
    } else {
      idx = (idx + 1) % stock.length;
    }
    const id = stock[idx];
    if (cat === 'throwable') this.equipped = id; else this.utility = id;
    return id;
  }

  select(id) {
    const d = THROWABLE_DEFS[id];
    if (!d || this.count(id) <= 0) return false;
    if (d.cat === 'throwable') this.equipped = id; else this.utility = id;
    return true;
  }

  // ---------------------------------------------------------------- throwing
  throwCurrent(soft = false) {
    const g = this.game;
    const id = g.handsMode === 'utility' ? this.utility : this.equipped;
    if (!id) return false;
    const def = THROWABLE_DEFS[id];
    if (this.count(id) <= 0) {
      g.ui.radio(def.cat === 'utility' ? 'NO UTILITY ITEMS LEFT' : 'NO THROWABLES LEFT');
      g.equipGun();
      return false;
    }
    if (def.kind === 'instant') { this.useMedkit(); return true; }
    if (def.kind === 'place') { this.placeCharge(); return true; }
    this.consume(id);
    g.stats.throwablesUsed = (g.stats.throwablesUsed || 0) + 1;
    const dir = g.camera.getWorldDirection(_v1);
    const pos = _v2.copy(g.camera.position).addScaledVector(dir, 0.45);
    pos.y -= 0.08;
    const vel = dir.clone().multiplyScalar(soft ? 7 : def.kind === 'deploy' ? 9 : 13.5);
    vel.y += soft ? 1.2 : 2.4;
    g.spawnThrowable(pos.clone(), vel, id, g.player);
    g.player.frags = g.player.frags; // keep field live for HUD
    return true;
  }

  altUse() {
    const g = this.game;
    if (g.handsMode === 'utility') {
      const id = this.utility;
      if (id === 'breach') { this.detonateCharges(); return; }
      if (id === 'medkit') { this.useMedkit(); return; }
      this.throwCurrent(false); // sensor: deploy toss
      return;
    }
    this.throwCurrent(true);    // soft toss
  }

  useMedkit() {
    const g = this.game;
    if (this.count('medkit') <= 0) { g.ui.radio('NO MEDKITS LEFT'); return; }
    const p = g.player;
    if (p.health >= 100 && p.armor >= 50) { g.ui.radio('ALREADY AT FULL STRENGTH'); return; }
    this.consume('medkit');
    p.health = Math.min(100, p.health + 55);
    p.armor = Math.min(50, p.armor + 25);
    g.audio.deviceChirp(null);
    g.ui.toastBrief('MEDKIT USED');
    if (this.count('medkit') <= 0) g.equipGun();
  }

  // ---------------------------------------------------------------- breach
  placeCharge() {
    const g = this.game;
    if (this.count('breach') <= 0) { g.ui.radio('NO BREACH CHARGES LEFT'); return; }
    if (this.charges.length >= 2) { g.ui.radio('CHARGES SET — DETONATE FIRST'); return; }
    const dir = g.camera.getWorldDirection(_v1);
    const hit = g.physics.raycast(g.camera.position, dir, 3.2);
    if (!hit) { g.ui.radio('AIM AT A SURFACE — CHARGE NEEDS SOMETHING TO STICK TO'); return; }
    this.consume('breach');
    const pos = hit.point.clone().addScaledVector(hit.normal || _v2.set(0, 1, 0), 0.04);
    const mesh = new THREE.Mesh(this._geoBox(), this._chargeMat.clone());
    mesh.position.copy(pos);
    if (hit.normal) mesh.lookAt(pos.clone().add(hit.normal));
    g.scene.add(mesh);
    this.charges.push({
      pos, mesh, blink: 0,
      surfacePoint: hit.point.clone(),
      surfaceNormal: hit.normal ? hit.normal.clone() : new THREE.Vector3(0, 1, 0),
      surfaceMaterial: hit.collider ? hit.collider.material : 'metal',
    });
    g.stats.throwablesUsed = (g.stats.throwablesUsed || 0) + 1;
    g.audio.deviceChirp(pos);
    g.ui.toastBrief('BREACH CHARGE SET — RMB TO DETONATE');
    if (this.count('breach') <= 0) { /* stay in utility mode so RMB can detonate */ }
  }

  detonateCharges() {
    const g = this.game;
    if (!this.charges.length) { g.ui.radio('NO CHARGES SET'); return; }
    for (const c of this.charges) {
      g.explodeAt(c.pos, {
        type: 'breach', owner: g.player, forceDoors: true,
        surfacePoint: c.surfacePoint, surfaceNormal: c.surfaceNormal, surfaceMaterial: c.surfaceMaterial,
      });
      this._removeCharge(c);
    }
    this.charges.length = 0;
    if (g.handsMode === 'utility' && this.count('breach') <= 0) g.equipGun();
  }

  _removeCharge(charge) {
    if (!charge || !charge.mesh) return;
    this.game.scene.remove(charge.mesh);
    if (charge.mesh.material && charge.mesh.material !== this._chargeMat) charge.mesh.material.dispose();
  }

  _geoBox() {
    if (!this._boxGeo) this._boxGeo = new THREE.BoxGeometry(0.24, 0.16, 0.07);
    return this._boxGeo;
  }

  // ---------------------------------------------------------------- detonation effects
  detonate(type, pos, projectile = null) {
    const g = this.game;
    const def = THROWABLE_DEFS[type];
    if (!def) { g.explodeAt(pos, { type: 'vxfrag', owner: projectile && projectile.owner }); return; }
    switch (def.kind) {
      case 'frag':
        g.explodeAt(pos, {
          type, owner: projectile && projectile.owner,
          surfacePoint: projectile && projectile.hasSurface ? projectile.surfacePoint : null,
          surfaceNormal: projectile && projectile.hasSurface ? projectile.surfaceNormal : null,
          surfaceMaterial: projectile && projectile.hasSurface ? projectile.surfaceMaterial : null,
        });
        break;
      case 'smoke':
        this.smokeVolumes.push({ pos: pos.clone(), r: 4.2, t: 15 });
        g.audio.impact('metal', pos, 0.4);
        break;
      case 'flash': {
        g.audio.flashbang(pos);
        g.emitNoise(pos, 40, 'explosion');
        g.particles.muzzleFlash(pos, _v2.set(0, 1, 0), true);
        for (const e of g.enemies.list) {
          if (!e.alive) continue;
          if (e.pos.distanceTo(pos) < 14 && g.physics.hasLOS(pos, _v2.copy(e.pos).setY(e.pos.y + 1.3)) && !this.smokeBlocksLOS(pos, e.pos)) {
            e.stunT = 2.6;
            e.suppressT = Math.max(e.suppressT || 0, 3.2);
          }
        }
        const dp = pos.distanceTo(g.camera.position);
        if (dp < 14) {
          const dir = g.camera.getWorldDirection(_v1);
          const toBlast = _v2.copy(pos).sub(g.camera.position).normalize();
          const facing = dir.dot(toBlast);
          if (facing > 0.25 && g.physics.hasLOS(g.camera.position, pos)) {
            const power = Math.max(0.25, 1 - dp / 14) * Math.min(1, (facing - 0.25) / 0.5);
            g.ui.flashbang(power);
            g.suppress = Math.max(g.suppress || 0, power * 0.9);
          }
        }
        break;
      }
      case 'decoy': {
        const mesh = new THREE.Mesh(this._geoBall(), this._mats.decoy);
        mesh.position.copy(pos).setY(pos.y + 0.06);
        g.scene.add(mesh);
        this.decoys.push({ pos: pos.clone(), t: 10, next: 0.35, mesh });
        break;
      }
      case 'flare': {
        const light = new THREE.PointLight(0xff6a3c, 26, 34, 2);
        light.position.copy(pos).setY(pos.y + 0.5);
        g.scene.add(light);
        const mesh = new THREE.Mesh(this._geoBall(), this._fieldMats.flare);
        mesh.position.copy(pos).setY(pos.y + 0.08);
        g.scene.add(mesh);
        this.revealVolumes.push({ pos: pos.clone(), r: 26, t: 25, los: true, light, mesh, smokeT: 0, kind: 'flare' });
        g.audio.impact('metal', pos, 0.5);
        break;
      }
      case 'deploy': { // sensor
        const mesh = new THREE.Mesh(this._geoBox(), this._fieldMats.sensor);
        mesh.position.copy(pos).setY(pos.y + 0.08);
        g.scene.add(mesh);
        this.revealVolumes.push({ pos: pos.clone(), r: 16, t: 22, los: false, mesh, beep: 0, kind: 'sensor' });
        g.audio.deviceChirp(pos);
        break;
      }
      // ---- Phase-14 effect handlers --------------------------------------
      case 'incendiary': {
        // IG-5 PYRO: 8 s burn zone. Hostiles inside take damage-over-time via
        // the real enemy damage path; the zone also ends enemy willingness to
        // stand there by attrition (it is genuine area denial, not a marker).
        const light = new THREE.PointLight(0xff7038, 18, 10, 2);
        light.position.copy(pos).setY(pos.y + 0.5);
        g.scene.add(light);
        this.fireZones.push({ pos: pos.clone(), r: 3.0, t: 8, tickT: 0, light });
        g.audio.impact('metal', pos, 0.6);
        g.emitNoise(pos, 24, 'explosion', projectile && projectile.owner);
        break;
      }
      case 'emp': {
        // EMP-4 ARC: instant 8 m pulse. Kills enemy flashlights (20 s), wipes
        // any active device reveal fields in radius, jams data terminals for
        // 25 s, and tears a hole in deployed barrier walls.
        // Phase-14 DISRUPTOR trait: detonates with a 50% larger radius (8 → 12).
        this._empPulse(pos, 8 * (CHARACTER_TRAITS(this.game).empRadius || 1), { flashKill: 20, wipeReveals: true });
        g.terminalJamT = Math.max(g.terminalJamT || 0, 25);
        g.audio.deviceChirp(pos);
        g.particles.muzzleFlash(pos, _v2.set(0, 1, 0), true);
        g.emitNoise(pos, 30, 'explosion', projectile && projectile.owner);
        break;
      }
      case 'glue': {
        // AD-9 STICC: 4 m adhesive field, 10 s. Hostiles inside are slowed to
        // 45% via the glueT hook consumed in their movement solver.
        const mesh = new THREE.Mesh(this._geoBall(), this._mats.glue);
        mesh.scale.setScalar(1.6);
        mesh.position.copy(pos).setY(pos.y + 0.05);
        g.scene.add(mesh);
        this.glueZones.push({ pos: pos.clone(), r: 4.0, t: 10, tickT: 0, mesh });
        g.audio.impact('metal', pos, 0.5);
        break;
      }
      case 'siren': {
        // NE-2 SIREN: like a decoy but louder, longer and obviously a device —
        // 14 s of wide 'device' pings. Hostiles investigate the sound source.
        const mesh = new THREE.Mesh(this._geoBall(), this._mats.siren);
        mesh.position.copy(pos).setY(pos.y + 0.06);
        g.scene.add(mesh);
        this.sirens.push({ pos: pos.clone(), t: 14, next: 0.2, mesh });
        break;
      }
      case 'barrier_disruptor': {
        // BX-1 SHOCKBOR: anti-barrier charge — 260 damage to any shield wall
        // collider within 7 m (a deployed barrier is usually destroyed), plus
        // a short 6 m EMP-lite that blanks flashlights and reveal fields.
        if (g.shield && g.shield.deployedColliders) {
          for (const c of g.shield.deployedColliders()) {
            _v1.set((c.min.x + c.max.x) / 2, (c.min.y + c.max.y) / 2, (c.min.z + c.max.z) / 2);
            if (_v1.distanceTo(pos) <= 7) g.shield.onHit(c, _v1, 260);
          }
        }
        this._empPulse(pos, 6, { flashKill: 6, wipeReveals: true });
        g.audio.deviceChirp(pos);
        g.particles.muzzleFlash(pos, _v2.set(0, 1, 0), true);
        g.emitNoise(pos, 26, 'explosion', projectile && projectile.owner);
        break;
      }
      default:
        g.explodeAt(pos);
    }
  }

  /**
   * Shared electromagnetic pulse: blank enemy flashlights and dissolve active
   * reveal fields (TS-7 pods, flares, tracker sweeps) inside the radius.
   */
  _empPulse(pos, radius, opts = {}) {
    const g = this.game;
    if (opts.flashKill) {
      for (const e of g.enemies.list) {
        if (!e.alive) continue;
        if (e.pos.distanceTo(pos) <= radius) e.flashKillT = Math.max(e.flashKillT || 0, opts.flashKill);
      }
    }
    if (opts.wipeReveals) {
      for (let i = this.revealVolumes.length - 1; i >= 0; i--) {
        const r = this.revealVolumes[i];
        if (r.pos.distanceTo(pos) > radius) continue;
        if (r.light) g.scene.remove(r.light);
        if (r.mesh) g.scene.remove(r.mesh);
        this.revealVolumes.splice(i, 1);
      }
    }
    return true;
  }

  /**
   * Tracker ability + TS-7 share this entry point: a reveal volume that marks
   * hostiles within radius on the tac map. los:false = through walls.
   */
  spawnRevealPulse(pos, radius = 16, dur = 22, fromAbility = false) {
    const g = this.game;
    this.revealVolumes.push({
      pos: pos.clone(), r: radius, t: dur, los: false,
      mesh: null, beep: 0, kind: fromAbility ? 'ability' : 'sensor',
    });
    if (fromAbility && g.audio && g.audio.deviceChirp) g.audio.deviceChirp(pos);
    return true;
  }

  _geoBall() {
    if (!this._ballGeo) this._ballGeo = new THREE.SphereGeometry(0.07, 8, 6);
    return this._ballGeo;
  }

  // ---------------------------------------------------------------- field queries
  smokeBlocksLOS(a, b) {
    if (!this.smokeVolumes.length) return false;
    _v1.copy(b).sub(a);
    const len2 = _v1.lengthSq();
    if (len2 < 0.0001) return false;
    for (const s of this.smokeVolumes) {
      const t = THREE.MathUtils.clamp(_v2.copy(s.pos).sub(a).dot(_v1) / len2, 0, 1);
      _v3.copy(a).addScaledVector(_v1, t);
      const rr = s.r * (0.6 + 0.4 * Math.min(1, s.t / 3)); // thinning as it dissipates
      if (_v3.distanceToSquared(s.pos) < rr * rr) return true;
    }
    return false;
  }

  /** Tac map aid: is this position covered by an active reveal volume? */
  revealCovers(pos, needLos = true) {
    for (const r of this.revealVolumes) {
      if (r.t <= 0) continue;
      if (pos.distanceToSquared(r.pos) > r.r * r.r) continue;
      if (!r.los || !needLos) return true;
      if (this.game.physics.hasLOS(_v1.copy(r.pos).setY(r.pos.y + 0.5), pos)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- per-frame
  update(dt) {
    const g = this.game;
    // smoke volumes: dissipate + keep pumping particles
    this._smokeT -= dt;
    const puff = this._smokeT <= 0;
    if (puff) this._smokeT = 0.07;
    for (let i = this.smokeVolumes.length - 1; i >= 0; i--) {
      const s = this.smokeVolumes[i];
      s.t -= dt;
      if (s.t <= 0) { this.smokeVolumes.splice(i, 1); continue; }
      if (puff && g.camera.position.distanceToSquared(s.pos) < 90 * 90) {
        for (let k = 0; k < 2; k++) {
          _v1.copy(s.pos);
          _v1.x += (Math.random() - 0.5) * s.r * 1.5;
          _v1.z += (Math.random() - 0.5) * s.r * 1.5;
          _v1.y += Math.random() * 1.2;
          g.particles.smoke.spawn(_v1, _v2.set((Math.random() - 0.5) * 0.4, 0.5 + Math.random() * 0.5, (Math.random() - 0.5) * 0.4), {
            r: 0.52, g: 0.53, b: 0.52, size: 0.9, sizeGrow: 2.6, life: 2.0 + Math.random(), gravity: -0.12, drag: 1.1,
          });
        }
      }
    }
    // decoys: periodic reports
    for (let i = this.decoys.length - 1; i >= 0; i--) {
      const d = this.decoys[i];
      d.t -= dt;
      if (d.t <= 0) { g.scene.remove(d.mesh); this.decoys.splice(i, 1); continue; }
      d.next -= dt;
      if (d.next <= 0) {
        d.next = 0.6 + Math.random() * 0.9;
        g.audio.gunshot('decoy', d.pos, { gain: 0.9 });
        g.emitNoise(d.pos, 50, 'gunfire');
      }
    }
    // ---- Phase-14: burn zones (IG-5) ----
    for (let i = this.fireZones.length - 1; i >= 0; i--) {
      const f = this.fireZones[i];
      f.t -= dt;
      if (f.light) f.light.intensity = 12 + Math.sin(g.time * 23 + i) * 5 + Math.random() * 3;
      if (f.t <= 0) { if (f.light) g.scene.remove(f.light); this.fireZones.splice(i, 1); continue; }
      // fire particles near the zone (camera-culled at 90 m like smoke)
      if (puff && g.camera.position.distanceToSquared(f.pos) < 8100) {
        for (let k = 0; k < 2; k++) {
          _v1.copy(f.pos);
          _v1.x += (Math.random() - 0.5) * f.r * 1.2;
          _v1.z += (Math.random() - 0.5) * f.r * 1.2;
          g.particles.smoke.spawn(_v1, _v2.set((Math.random() - 0.5) * 0.3, 1.4 + Math.random(), (Math.random() - 0.5) * 0.3), {
            r: 1.0, g: 0.42, b: 0.12, size: 0.5, sizeGrow: -0.1, life: 0.55, gravity: -0.9, drag: 0.6,
          });
        }
      }
      // DoT at 0.5 s cadence; armor-less, same damage path as gunfire
      f.tickT -= dt;
      if (f.tickT <= 0) {
        f.tickT = 0.5;
        for (const e of g.enemies.list) {
          if (!e.alive) continue;
          if (e.pos.distanceToSquared(f.pos) <= f.r * f.r) {
            g.enemies.damage(e, 'torso', 7, e.pos, null);
          }
        }
        // honest two-way zone: the thrower is fire too
        if (g.player.alive && g.player.pos.distanceToSquared(f.pos) <= (f.r * 0.8) * (f.r * 0.8)) {
          g.player.damage('torso', 4, f.pos, true);
        }
      }
    }
    // ---- Phase-14: adhesive zones (AD-9) ----
    for (let i = this.glueZones.length - 1; i >= 0; i--) {
      const z = this.glueZones[i];
      z.t -= dt;
      if (z.mesh) z.mesh.rotation.y += dt * 0.6;
      if (z.t <= 0) { if (z.mesh) g.scene.remove(z.mesh); this.glueZones.splice(i, 1); continue; }
      z.tickT -= dt;
      if (z.tickT <= 0) {
        z.tickT = 0.25;
        for (const e of g.enemies.list) {
          if (!e.alive) continue;
          if (e.pos.distanceToSquared(z.pos) <= z.r * z.r) e.glueT = Math.max(e.glueT || 0, 0.5);
        }
      }
    }
    // ---- Phase-14: noise emitters (NE-2) ----
    for (let i = this.sirens.length - 1; i >= 0; i--) {
      const s = this.sirens[i];
      s.t -= dt;
      if (s.t <= 0) { g.scene.remove(s.mesh); this.sirens.splice(i, 1); continue; }
      s.next -= dt;
      if (s.next <= 0) {
        s.next = 1.4;
        g.audio.terminalBeep && g.audio.terminalBeep(s.pos);
        g.emitNoise(s.pos, 38, 'device');  // wider + longer than a decoy's simulated gunfire
        if (s.mesh) s.mesh.scale.setScalar(1 + 0.3 * Math.sin(g.time * 10));
      }
    }
    // reveal volumes (flare / sensor)
    for (let i = this.revealVolumes.length - 1; i >= 0; i--) {
      const r = this.revealVolumes[i];
      r.t -= dt;
      if (r.t <= 0) {
        if (r.light) g.scene.remove(r.light);
        if (r.mesh) g.scene.remove(r.mesh);
        this.revealVolumes.splice(i, 1);
        continue;
      }
      if (r.kind === 'flare') {
        r.light.intensity = 22 + Math.sin(g.time * 17) * 6 + Math.random() * 4;
        r.smokeT = (r.smokeT || 0) - dt;
        if (r.smokeT <= 0) {
          r.smokeT = 0.18;
          _v1.copy(r.pos).setY(r.pos.y + 0.2);
          g.particles.smoke.spawn(_v1, _v2.set((Math.random() - 0.5) * 0.3, 1.1 + Math.random() * 0.6, (Math.random() - 0.5) * 0.3), {
            r: 0.62, g: 0.24, b: 0.16, size: 0.3, sizeGrow: 1.1, life: 1.1 + Math.random() * 0.6, gravity: -0.3, drag: 1.5,
          });
        }
      } else if (r.kind === 'sensor') {
        r.beep = (r.beep || 0) - dt;
        const m = r.mesh.material;
        m.emissiveIntensity = 0.35 + Math.max(0, Math.sin(g.time * 4)) * 0.5;
        if (r.beep <= 0) { r.beep = 1.6; g.audio.deviceChirp(r.pos); }
      }
    }
    // placed charges blink
    for (const c of this.charges) {
      c.blink += dt;
      c.mesh.material.emissiveIntensity = 0.4 + Math.max(0, Math.sin(c.blink * 8)) * 1.2;
    }
  }

  clearField() {
    const g = this.game;
    for (const d of this.decoys) g.scene.remove(d.mesh);
    this.decoys.length = 0;
    for (const r of this.revealVolumes) {
      if (r.light) g.scene.remove(r.light);
      if (r.mesh) g.scene.remove(r.mesh);
    }
    this.revealVolumes.length = 0;
    for (const c of this.charges) this._removeCharge(c);
    this.charges.length = 0;
    this.smokeVolumes.length = 0;
    // Phase-14 zones/emitters
    for (const f of this.fireZones || []) { if (f.light) g.scene.remove(f.light); }
    this.fireZones = [];
    for (const gl of this.glueZones || []) { if (gl.mesh) g.scene.remove(gl.mesh); }
    this.glueZones = [];
    for (const s of this.sirens || []) { if (s.mesh) g.scene.remove(s.mesh); }
    this.sirens = [];
  }
}
