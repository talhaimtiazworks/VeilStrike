/**
 * shield.js — AEGIS barrier inventory (Phase-14 system, Master upgrade P5
 * inventory, CRITICAL FIX: explicit CARRIED (held) vs DEPLOYED states).
 *
 * Root cause fixed here (reported "the shield does not move"): the previous
 * build had NO carried representation at all. "Carried" was only a number in
 * the HUD; pressing [V] immediately spawned a 2.3 × 1.85 m translucent world
 * wall 2.5 m ahead of the player, which (a) stayed where it was spawned when
 * the player moved — the "shield that does not move" — and (b) was taller
 * than the standing eye (1.62 m), so aiming from behind it put a large
 * translucent rectangle over the crosshair.
 *
 * Unit state machine (each of the `capacity` units is ONE object with its own
 * HP that moves between states — never duplicated):
 *
 *     carried (stowed on the back) ──raise──▶ held (on the left arm)
 *        ▲  ◀──stow (hold V)──                 │ plant (V)
 *        │                                     ▼
 *        └───────── pick up (V, aimed) ◀── deployed ⇄ damaged ──▶ destroyed
 *
 *  - held: a first-person ballistic shield attached to the CAMERA (it follows
 *    movement/rotation by construction), posed per stance (hip / ADS / sprint /
 *    crouch) with smoothed transitions. While aiming it cants outward and down
 *    — an intentional ADS stance, so it never covers the crosshair. It has no
 *    world collider (it can't block the player's own shots or snag on walls);
 *    protection is directional damage logic: hostile rounds arriving inside the
 *    frontal cover cone hit the shield's HP instead of the player (legs stay
 *    exposed while standing). Sprinting lowers it (no cover).
 *  - deployed: a separate, stationary chest-high world object with a REAL
 *    physics collider tagged 'shield' (weapon / enemy / LOS raycasts intersect
 *    it unchanged). Chest-high (1.2 m): a standing operator aims over it, a
 *    crouched operator (eye 0.92 m, box 1.2 m) is covered.
 *
 * ONE contextual action — [V] tap / mobile BAR tap:
 *     aimed at your deployed wall within reach → PICK UP (into the hands)
 *     holding a shield                          → PLANT it at the validated spot
 *     otherwise, a unit in the pack             → RAISE it
 *   [V] hold ≥ 0.45 s / BAR long-press           → STOW the held shield
 * Count invariant (tested): carried + held + deployed + destroyed === capacity.
 */
import * as THREE from 'three';

export const SHIELD_DEF = {
  name: 'AEGIS FIELD BARRIER',
  hp: 260,
  capacity: 3,         // physical units carried into a mission
  cooldown: 1.5,       // anti-spam seconds between successful plants
  deployRange: 4.0,    // max forward scan
  clearance: 1.35,     // min free distance ahead
  recoverRange: 2.8,   // must be this close (eye → wall) to pick up
  repickDelay: 0.5,    // s (game time) after planting before a tap can pick the same wall up
  width: 2.3, height: 1.2, depth: 0.22,   // CRITICAL FIX: chest-high cover (was 1.85 m)
  damagedRatio: 0.5,   // below this HP fraction a unit reads as DAMAGED
  // held (carried-in-hand) behaviour
  coverHip: 55,        // half-angle (deg) of frontal protection, shield up
  coverAds: 32,        // half-angle while aiming (shield canted aside)
  heldSpeedMul: 0.9,   // restrained realism: a raised shield slows you a little
  heldDamageMul: 0.9,  // same absorption factor as deployed walls
  // FINAL FIX 5: a raised plate against a blast is PARTIAL cover, never immunity
  blastCoverStand: 0.7,   // share of a frontal blast the plate takes (legs exposed)
  blastCoverCrouch: 0.85, // crouched behind it: more of the body is behind the plate
  blastMinDist: 0.6,      // m (horizontal): a charge at your feet is inside the guard
  blastMaxElev: 1.2,      // rise/run above chest beyond which (≈50°) a vertical plate can't help
};
export const SHIELD_STOW_HOLD_MS = 450;

const _fwd = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _bmin = new THREE.Vector3();
const _bmax = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _hp = new THREE.Vector3();
const _hr = new THREE.Euler();

// first-person poses (camera space). Hip: left forearm, facing strictly forward.
const POSE = {
  hip:    { p: [-0.26, -0.16, -0.50], r: [0.0, 0.0, 0.0] },
  ads:    { p: [-0.34, -0.26, -0.46], r: [0.0, 0.0, 0.0] },
  sprint: { p: [-0.20, -0.38, -0.42], r: [0.35, 0.0, 0.0] },
  down:   { p: [-0.24, -0.75, -0.38], r: [0.50, 0.0, 0.0] },
};

export class ShieldSystem {
  constructor(game) {
    this.game = game;
    this.units = [];           // [{ id, hp, maxHp, state, collider, mesh, mat, yaw, t }]
    this.cooldownLeft = 0;
    this._geo = null;
    this._seq = 0;
    this.heldModel = null;     // camera-attached first-person shield (built once)
    this._heldVis = 0;         // 0 hidden … 1 raised (smoothed raise/lower)
    this._heldPos = new THREE.Vector3(...POSE.down.p);
    this._heldRot = new THREE.Vector3(...POSE.down.r);
    this._bobT = 0;
  }

  get defHp() {
    const eng = this.game.characters && this.game.characters.id === 'engineer' ? (CHARACTER_TRAITS(this.game).shieldHp || 1) : 1;
    return SHIELD_DEF.hp * eng;
  }
  get defCooldown() {
    const eng = this.game.characters && this.game.characters.id === 'engineer' ? (CHARACTER_TRAITS(this.game).shieldCd || 1) : 1;
    return SHIELD_DEF.cooldown * eng;
  }

  // ---- inventory views -------------------------------------------------
  /** Units stowed in the pack (not in hand). */
  get carried() { return this.units.filter(u => u.state === 'carried'); }
  get deployed() { return this.units.filter(u => u.state === 'deployed' || u.state === 'damaged'); }
  get heldUnit() { return this.units.find(u => u.state === 'held') || null; }
  get carriedCount() { let n = 0; for (const u of this.units) if (u.state === 'carried') n++; return n; }
  get heldCount() { let n = 0; for (const u of this.units) if (u.state === 'held') n++; return n; }
  /** Units physically with the operator (pack + hand). */
  get withPlayerCount() { return this.carriedCount + this.heldCount; }
  get deployedCount() { let n = 0; for (const u of this.units) if (u.state === 'deployed' || u.state === 'damaged') n++; return n; }
  get destroyedCount() { let n = 0; for (const u of this.units) if (u.state === 'destroyed') n++; return n; }
  /** Back-compat for Phase-14/15 callers: the most recently deployed wall (or null). */
  get active() { const d = this.deployed; return d.length ? d[d.length - 1] : null; }
  /** Colliders of every standing wall (blast/EMP code iterates this). */
  deployedColliders() { const out = []; for (const u of this.units) if ((u.state === 'deployed' || u.state === 'damaged') && u.collider) out.push(u.collider); return out; }

  /** Fresh inventory for a mission (also used by checkpoint restart). */
  reset() {
    this.destroy('mission-reset');
    this.units.length = 0;
    const hp = this.defHp;
    for (let i = 0; i < SHIELD_DEF.capacity; i++) this.units.push({ id: ++this._seq, hp, maxHp: hp, state: 'carried', collider: null, mesh: null, mat: null, yaw: 0, t: 0 });
    this.cooldownLeft = 0;
    this._heldVis = 0;
    this._heldPos.set(...POSE.down.p); this._heldRot.set(...POSE.down.r);
    if (this.heldModel) this.heldModel.visible = false;
    this._refreshHud();
  }

  _ensureAssets() {
    if (this._geo) return;
    this._geo = new THREE.BoxGeometry(1, 1, 1);
    this._frameMat = new THREE.MeshStandardMaterial({ color: 0x3a4146, roughness: 0.55, metalness: 0.6 });
    this._emitMat = new THREE.MeshBasicMaterial({ color: 0x6de2c2 });
  }

  // ---- held (carried-in-hand) first-person model ------------------------
  _ensureHeldModel() {
    if (this.heldModel || !this.game.camera) return;
    this._ensureAssets();
    const g = new THREE.Group();
    g.name = 'aegis-held-shield';
    const plate = new THREE.MeshStandardMaterial({ color: 0x4d565c, roughness: 0.5, metalness: 0.35, emissive: 0x0b0f12 });
    const rim = new THREE.MeshStandardMaterial({ color: 0x15181b, roughness: 0.7, metalness: 0.3 });
    this._heldPlateMat = plate;
    const add = (mat, w, h, d, x, y, z) => { const m = new THREE.Mesh(this._geo, mat); m.scale.set(w, h, d); m.position.set(x, y, z); g.add(m); return m; };
    const W = 0.34, H = 0.56, D = 0.022;
    add(plate, W, H, D, 0, 0, 0);                                 // ballistic plate
    add(rim, W + 0.016, 0.016, D + 0.008, 0, H / 2, 0);           // rim
    add(rim, W + 0.016, 0.016, D + 0.008, 0, -H / 2, 0);
    add(rim, 0.016, H, D + 0.008, -W / 2, 0, 0);
    add(rim, 0.016, H, D + 0.008, W / 2, 0, 0);
    // viewport (dark armoured glass) near the top — OUTWARD facing (towards -Z)
    add(new THREE.MeshStandardMaterial({ color: 0x0c1418, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.85 }), W * 0.62, 0.07, D + 0.004, 0, H * 0.3, -0.002);
    // AEGIS emitter strip (ties it visually to the deployed field barrier) — OUTWARD facing (towards -Z)
    add(this._emitMat, 0.005, H * 0.55, D + 0.006, W / 2 - 0.024, -0.04, -0.003);
    // Grip handle bracket on the inner face (towards +Z, facing player)
    add(rim, 0.12, 0.03, 0.04, 0, -0.02, 0.025);
    g.traverse(o => { if (o.isMesh) { o.renderOrder = 8; o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; } });
    g.visible = false;
    this.game.camera.add(g);
    this.heldModel = g;
  }

  _eyeAndForward() {
    const p = this.game.player;
    _eye.copy(p.pos); _eye.y += p._eyeHeight ? p._eyeHeight() : 1.55;
    _fwd.copy(p.viewDir || _eye); _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
    _fwd.normalize();
  }

  /**
   * Which deployed unit (if any) the player is aiming at, with its distance.
   * Uses the real physics raycast so walls behind other geometry can't be
   * grabbed through it; a narrow forward cone covers looking over the
   * (chest-high) wall.
   */
  targetedUnit(maxDist = 6) {
    const g = this.game, p = g.player;
    if (!p || !this.deployedCount) return null;
    this._eyeAndForward();
    const dir = p.viewDir ? _tmp.copy(p.viewDir).normalize() : _fwd;
    const hit = g.physics.raycast(_eye, dir, maxDist);
    if (hit && hit.collider && hit.collider.tag === 'shield') {
      const u = this.units.find(x => x.collider === hit.collider);
      if (u) return { unit: u, dist: hit.dist };
    }
    let best = null;
    for (const u of this.deployed) {
      _tmp.set(u.mesh.position.x - _eye.x, 0, u.mesh.position.z - _eye.z);
      const d = _tmp.length();
      if (d > SHIELD_DEF.recoverRange + 0.4 || d < 1e-3) continue;
      if (_tmp.multiplyScalar(1 / d).dot(_fwd) < 0.8) continue;
      if (!best || d < best.dist) best = { unit: u, dist: Math.max(0, d - SHIELD_DEF.depth) };
    }
    return best;
  }

  _availability() {
    const g = this.game, p = g.player;
    if (!p || !p.alive) return 'DEAD';
    if (g.state !== 'playing') return 'NOT IN MISSION';
    if (g.vehicleMode) return 'DENIED IN VEHICLE';
    return null;
  }

  /** Compute a placement or a reason it cannot happen. Pure wrt world state. */
  evaluatePlacement() {
    const g = this.game, p = g.player;
    const na = this._availability();
    if (na) return { ok: false, reason: na };
    if (!this.withPlayerCount) return { ok: false, reason: this.deployedCount ? 'NO BARRIERS CARRIED — PICK ONE UP FIRST' : 'NO BARRIERS LEFT' };
    if (this.cooldownLeft > 0) return { ok: false, reason: 'BARRIER COOLDOWN ' + this.cooldownLeft.toFixed(1) + 'S' };

    this._eyeAndForward();
    const wallHit = g.physics.raycast(_eye, _fwd, SHIELD_DEF.deployRange);
    // the eye ray passes OVER a chest-high wall — also probe at wall height
    _tmp.set(_eye.x, (p.pos.y || 0) + SHIELD_DEF.height * 0.5, _eye.z);
    const lowHit = g.physics.raycast(_tmp, _fwd, SHIELD_DEF.deployRange);
    const near = (!wallHit || (lowHit && lowHit.dist < wallHit.dist)) ? lowHit : wallHit;
    const standDist = near ? near.dist : SHIELD_DEF.deployRange;
    if (standDist < SHIELD_DEF.clearance) return { ok: false, reason: near && near.collider && near.collider.tag === 'shield' ? 'OVERLAPS DEPLOYED BARRIER' : 'NOT ENOUGH ROOM' };

    const dist = Math.max(SHIELD_DEF.clearance, Math.min(standDist - SHIELD_DEF.depth * 0.5 - 0.05, 2.6));
    const cx = _eye.x + _fwd.x * dist, cz = _eye.z + _fwd.z * dist;

    const groundHit = g.physics.raycast(new THREE.Vector3(cx, _eye.y, cz), new THREE.Vector3(0, -1, 0), 6);
    if (!groundHit) return { ok: false, reason: 'NO STABLE GROUND' };

    // Strict forward orientation matching incoming threat direction (no snapping sideways)
    const yaw = Math.atan2(_fwd.x, _fwd.z);
    const hw = SHIELD_DEF.width / 2;
    const hd = SHIELD_DEF.depth / 2;
    const ex = Math.abs(Math.cos(yaw)) * hw + Math.abs(Math.sin(yaw)) * hd;
    const ez = Math.abs(Math.sin(yaw)) * hw + Math.abs(Math.cos(yaw)) * hd;
    const GAP = 0.05;
    const gy = groundHit.point.y;
    _bmin.set(cx - ex - GAP, gy, cz - ez - GAP);
    _bmax.set(cx + ex + GAP, gy + SHIELD_DEF.height, cz + ez + GAP);
    const SG = 0.5;   // barriers keep ≥0.5 m apart — no stacked/overlapping walls
    for (const c of g.physics.colliders) {
      if (!c.enabled || c.sensor) continue;
      const m = c.tag === 'shield' ? SG : 0;
      if (_bmin.x - m < c.max.x && _bmax.x + m > c.min.x &&
          _bmin.z - m < c.max.z && _bmax.z + m > c.min.z &&
          _bmax.y > c.min.y && _bmin.y < c.max.y) {
        if (c.max.y <= gy + 0.12) continue;           // floor slivers are fine
        return { ok: false, reason: c.tag === 'shield' ? 'OVERLAPS DEPLOYED BARRIER' : 'BLOCKED BY GEOMETRY' };
      }
    }
    // never wall the player in: the footprint must not overlap the player box
    const pb = p.box;
    if (pb && _bmin.x < pb.max.x && _bmax.x > pb.min.x && _bmin.z < pb.max.z && _bmax.z > pb.min.z) {
      return { ok: false, reason: 'TOO CLOSE — STEP BACK' };
    }
    return { ok: true, center: new THREE.Vector3(cx, gy + SHIELD_DEF.height / 2, cz), yaw, ex, ez, groundY: gy, dist };
  }

  /** Control hint for the active input lane: keyboard [V] or the mobile BAR button. */
  keyHint() { return this.game && this.game._touchPrimary ? '[BAR]' : '[V]'; }

  /** Contextual [V] tap: pick up the aimed wall, else plant the held one, else raise one. */
  interact() {
    const na = this._availability();
    if (na) { this._say(na); return { ok: false, reason: na }; }
    const tgt = this.targetedUnit(6);
    // a double-tap must not instantly pick back up the wall that was just planted (game time)
    if (tgt && tgt.dist <= SHIELD_DEF.recoverRange && tgt.unit.t < SHIELD_DEF.repickDelay) return { ok: false, reason: 'JUST PLANTED' };
    if (tgt && tgt.dist <= SHIELD_DEF.recoverRange) return this.recover(tgt.unit);
    if (this.heldUnit) return this.deploy();
    if (this.carriedCount) return this.raise();
    if (tgt) { this._say('MOVE CLOSER TO PICK UP BARRIER'); return { ok: false, reason: 'TOO FAR' }; }
    const r = this.deployedCount ? 'NO BARRIERS CARRIED — PICK ONE UP FIRST' : 'NO BARRIERS LEFT';
    this._say(r);
    return { ok: false, reason: r };
  }

  /** Pack → hand. The healthiest stowed unit is raised. */
  raise() {
    const na = this._availability();
    if (na) return { ok: false, reason: na };
    if (this.heldUnit) return { ok: true, unitId: this.heldUnit.id, already: true };
    let unit = null;
    for (const u of this.units) if (u.state === 'carried' && (!unit || u.hp > unit.hp)) unit = u;
    if (!unit) { this._say('NO BARRIERS CARRIED'); return { ok: false, reason: 'NONE' }; }
    this._ensureHeldModel();
    unit.state = 'held';
    this._applyHeldLook();
    this._say(`BARRIER RAISED — ${this.keyHint()} PLANT · HOLD ${this.keyHint()} STOW`, true);
    this.game.audio && this.game.audio.wpnRaise && this.game.audio.wpnRaise(0);
    this._refreshHud();
    return { ok: true, unitId: unit.id };
  }

  /** Hand → pack (no world change). */
  stow(quiet = false) {
    const u = this.heldUnit;
    if (!u) return { ok: false, reason: 'NOTHING HELD' };
    u.state = 'carried';
    if (!quiet) this._say(`BARRIER STOWED — ${this.withPlayerCount}/${SHIELD_DEF.capacity} CARRIED`, true);
    this._refreshHud();
    return { ok: true, unitId: u.id };
  }

  /** Plant a unit as a stationary world wall (the held one first). */
  deploy() {
    const plan = this.evaluatePlacement();
    if (!plan.ok) { this._say(plan.reason); return plan; }
    this._ensureAssets();
    const g = this.game;
    let unit = this.heldUnit;
    if (!unit) for (const u of this.units) if (u.state === 'carried' && (!unit || u.hp > unit.hp)) unit = u;
    if (!unit) return { ok: false, reason: 'NO BARRIERS CARRIED' };
    const size = new THREE.Vector3(
      plan.ex ? Math.max(SHIELD_DEF.depth, plan.ex * 2) : SHIELD_DEF.width,
      SHIELD_DEF.height,
      plan.ez ? Math.max(SHIELD_DEF.depth, plan.ez * 2) : SHIELD_DEF.depth
    );
    const collider = g.physics.addBox(plan.center.clone(), size, 'metal', { dynamic: true, tag: 'shield' });
    if (!collider) return { ok: false, reason: 'PHYSICS REJECTED' };
    const mat = new THREE.MeshBasicMaterial({ color: 0x6de2c2, transparent: true, opacity: 0.26, depthWrite: false, side: THREE.DoubleSide });
    const mesh = this._buildWallMesh(mat);
    mesh.position.copy(plan.center);
    mesh.rotation.y = plan.yaw;
    g.scene.add(mesh);
    collider.userData = { shield: this, unitId: unit.id };
    Object.assign(unit, { collider, mesh, mat, yaw: plan.yaw, t: 0 });
    unit.state = unit.hp < unit.maxHp * SHIELD_DEF.damagedRatio ? 'damaged' : 'deployed';
    this._applyLook(unit);
    this.cooldownLeft = this.defCooldown;
    this._say(`BARRIER PLANTED — ${this.withPlayerCount}/${SHIELD_DEF.capacity} CARRIED`, true);
    g.audio && g.audio.uiConfirm && g.audio.uiConfirm();
    g.stats.shieldsDeployed = (g.stats.shieldsDeployed || 0) + 1;
    this._refreshHud();
    return { ok: true, unitId: unit.id };
  }

  /** Deployed wall: metal frame (posts, rails, feet) + translucent field panel. */
  _buildWallMesh(panelMat) {
    const W = SHIELD_DEF.width, H = SHIELD_DEF.height, D = SHIELD_DEF.depth;
    const grp = new THREE.Group();
    grp.name = 'aegis-deployed-wall';
    const add = (mat, w, h, d, x, y, z) => { const m = new THREE.Mesh(this._geo, mat); m.scale.set(w, h, d); m.position.set(x, y, z); grp.add(m); return m; };
    const panel = add(panelMat, W - 0.1, H - 0.1, D * 0.35, 0, 0, 0);
    panel.renderOrder = 4;
    add(this._frameMat, 0.07, H, D, -W / 2 + 0.035, 0, 0);          // posts
    add(this._frameMat, 0.07, H, D, W / 2 - 0.035, 0, 0);
    add(this._frameMat, W, 0.06, D, 0, H / 2 - 0.03, 0);            // top rail
    add(this._frameMat, W, 0.05, D, 0, -H / 2 + 0.025, 0);          // bottom rail
    add(this._frameMat, 0.12, 0.04, 0.55, -W / 2 + 0.12, -H / 2 + 0.02, 0);   // feet
    add(this._frameMat, 0.12, 0.04, 0.55, W / 2 - 0.12, -H / 2 + 0.02, 0);
    add(this._emitMat, W - 0.2, 0.012, D + 0.01, 0, H / 2 - 0.065, 0);       // emitter strip
    return grp;
  }

  /** Pick a deployed wall back up — into the hands if they are free, else the pack. */
  recover(unit) {
    const g = this.game;
    if (!unit || (unit.state !== 'deployed' && unit.state !== 'damaged')) { this._say('NOTHING TO PICK UP'); return { ok: false, reason: 'INVALID' }; }
    if (this._availability()) return { ok: false, reason: 'NOT AVAILABLE' };
    this._removeWorld(unit);
    const toHand = !this.heldUnit;
    if (toHand) this._ensureHeldModel();
    unit.state = toHand ? 'held' : 'carried';   // HP is kept — recovering never repairs
    if (toHand) this._applyHeldLook();
    this._say(toHand ? `BARRIER PICKED UP — CARRYING · ${this.keyHint()} PLANT` : `BARRIER RECOVERED — ${this.withPlayerCount}/${SHIELD_DEF.capacity} CARRIED`, true);
    g.audio && g.audio.pickup && g.audio.pickup(null);
    g.stats.shieldsRecovered = (g.stats.shieldsRecovered || 0) + 1;
    this._refreshHud();
    return { ok: true, unitId: unit.id, toHand };
  }

  /** Back-compat entry used by older callers (Phase-14 one-tap). */
  // eslint-disable-next-line class-methods-use-this
  get maxActive() { return SHIELD_DEF.capacity; }

  /** Damage entry from weapons / enemy fire / blasts on a DEPLOYED wall. */
  onHit(collider, point, dmg = 10) {
    const u = this.units.find(x => x.collider === collider && (x.state === 'deployed' || x.state === 'damaged'));
    if (!u) return;
    u.hp -= dmg;
    const g = this.game;
    g.particles && g.particles.impact && g.particles.impact(point, new THREE.Vector3(0, 1, 0), 'metal', 0.5);
    if (u.hp <= 0) {
      u.hp = 0;
      this._removeWorld(u);
      u.state = 'destroyed';
      this._say('BARRIER DESTROYED');
      this._refreshHud();
      return;
    }
    const was = u.state;
    u.state = u.hp < u.maxHp * SHIELD_DEF.damagedRatio ? 'damaged' : 'deployed';
    this._applyLook(u);
    if (was !== u.state) this._refreshHud();
  }

  /**
   * Held-shield protection test for one hostile round.
   * @param {THREE.Vector3} shotDir  normalised travel direction of the round
   * @param {string} zone            hit zone the round would have struck
   */
  heldBlocks(shotDir, zone) {
    const u = this.heldUnit, g = this.game, p = g.player;
    if (!u || !p || !p.alive || g.vehicleMode || this._heldVis < 0.6) return false;
    const w = g.weapons;
    if (p.sprinting || (w && w.sprintT > 0.5)) return false;      // lowered while sprinting
    if (zone === 'legs' && !p.crouching) return false;             // standing: legs below the plate
    _tmp.set(-shotDir.x, 0, -shotDir.z);                            // toward the shooter
    if (_tmp.lengthSq() < 1e-8) return false;
    _tmp.normalize();
    _fwd.set(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    const adsT = w ? w.adsT : 0;
    const half = THREE.MathUtils.lerp(SHIELD_DEF.coverHip, SHIELD_DEF.coverAds, adsT) * Math.PI / 180;
    return _tmp.dot(_fwd) >= Math.cos(half);
  }

  /**
   * FINAL FIX 5 — how much of an explosion the HELD plate intercepts.
   * Geometry only: same raise/sprint/vehicle rules and frontal cone as
   * heldBlocks(); a blast at the feet, behind/beside the cone or steeply
   * above gets no cover. Returns a fraction in [0, blastCoverCrouch] (< 1).
   */
  heldBlastCover(blastPos) {
    const u = this.heldUnit, g = this.game, p = g.player;
    if (!u || !p || !p.alive || g.vehicleMode || this._heldVis < 0.6 || !blastPos) return 0;
    const w = g.weapons;
    if (p.sprinting || (w && w.sprintT > 0.5)) return 0;
    const dx = blastPos.x - p.pos.x, dz = blastPos.z - p.pos.z;
    const horiz = Math.hypot(dx, dz);
    if (horiz < SHIELD_DEF.blastMinDist) return 0;
    const chestY = p.pos.y + (p.crouching ? 0.75 : 1.15);
    if (blastPos.y - chestY > horiz * SHIELD_DEF.blastMaxElev) return 0;
    _fwd.set(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    const adsT = w ? w.adsT : 0;
    const half = THREE.MathUtils.lerp(SHIELD_DEF.coverHip, SHIELD_DEF.coverAds, adsT) * Math.PI / 180;
    if ((dx * _fwd.x + dz * _fwd.z) / horiz < Math.cos(half)) return 0;
    return p.crouching ? SHIELD_DEF.blastCoverCrouch : SHIELD_DEF.blastCoverStand;
  }

  /**
   * FINAL FIX 5 — the held plate soaks up to `amount` blast damage ONCE.
   * Returns the damage actually absorbed; anything beyond the plate's
   * remaining HP is NOT absorbed (the caller passes it to the player).
   */
  absorbHeldBlast(amount, point) {
    const u = this.heldUnit;
    if (!u || !(amount > 0)) return 0;
    const mul = SHIELD_DEF.heldDamageMul;
    const absorbed = Math.min(amount, Math.max(0, u.hp) / mul);
    u.hp -= absorbed * mul;
    const g = this.game;
    if (point && g.particles && g.particles.impact) g.particles.impact(point, new THREE.Vector3(0, 1, 0), 'metal', 0.6);
    g.stats.shieldBlastBlocks = (g.stats.shieldBlastBlocks || 0) + 1;
    if (u.hp <= 1e-6) {
      u.hp = 0;
      u.state = 'destroyed';
      this._say('BARRIER DESTROYED');
      this._refreshHud();
      return absorbed;
    }
    this._applyHeldLook();
    this._refreshHud();
    return absorbed;
  }

  /** A blocked round lands on the held shield (per-unit HP). */
  absorbHeld(dmg, point) {
    const u = this.heldUnit;
    if (!u) return false;
    u.hp -= dmg * SHIELD_DEF.heldDamageMul;
    const g = this.game;
    if (point && g.particles && g.particles.impact) g.particles.impact(point, new THREE.Vector3(0, 1, 0), 'metal', 0.45);
    if (g.audio && g.audio.impact && point) g.audio.impact('metal', point, 0.6);
    g.stats.shieldBlocks = (g.stats.shieldBlocks || 0) + 1;
    if (u.hp <= 0) {
      u.hp = 0;
      u.state = 'destroyed';
      this._say('BARRIER DESTROYED');
      this._refreshHud();
      return true;
    }
    this._applyHeldLook();
    this._refreshHud();
    return true;
  }

  _applyHeldLook() {
    const u = this.heldUnit;
    if (!u || !this._heldPlateMat) return;
    const dmg = u.hp < u.maxHp * SHIELD_DEF.damagedRatio;
    this._heldPlateMat.color.setHex(dmg ? 0x5a4a38 : 0x4d565c);
    this._emitMat && this._emitMat.color.setHex(dmg ? 0xe2a96d : 0x6de2c2);
  }

  _applyLook(u) {
    if (!u.mat) return;
    const ratio = Math.max(0, u.hp / u.maxHp);
    u.mat.opacity = 0.1 + 0.18 * ratio;
    u.mat.color.setHex(u.state === 'damaged' ? 0xe2a96d : 0x6de2c2);
  }

  update(dt) {
    if (this.cooldownLeft > 0) this.cooldownLeft = Math.max(0, this.cooldownLeft - dt);
    for (const u of this.units) if (u.state === 'deployed' || u.state === 'damaged') u.t += dt;
    const g = this.game;
    // entering a vehicle / dying puts the hand shield back on the back
    if (this.heldUnit && (g.vehicleMode || (g.player && !g.player.alive))) this.stow(true);
    this._updateHeldPose(dt);
  }

  /** Smoothed first-person pose of the held shield (camera space). */
  _updateHeldPose(dt) {
    const m = this.heldModel;
    if (!m) return;
    const g = this.game, p = g.player, w = g.weapons;
    const want = !!this.heldUnit && g.state === 'playing' && !g.vehicleMode && p && p.alive;
    this._heldVis = THREE.MathUtils.clamp(this._heldVis + (want ? dt / 0.28 : -dt / 0.2), 0, 1);
    if (this._heldVis <= 0.001) { m.visible = false; return; }
    m.visible = g.state === 'playing' || g.state === 'paused';
    const adsT = w ? w.adsT : 0;
    const spr = w ? w.sprintT : 0;
    const e = adsT * adsT * (3 - 2 * adsT);
    const H = POSE.hip, A = POSE.ads, S = POSE.sprint, D = POSE.down;
    _hp.set(
      THREE.MathUtils.lerp(H.p[0], A.p[0], e), THREE.MathUtils.lerp(H.p[1], A.p[1], e), THREE.MathUtils.lerp(H.p[2], A.p[2], e));
    _hr.set(
      THREE.MathUtils.lerp(H.r[0], A.r[0], e), THREE.MathUtils.lerp(H.r[1], A.r[1], e), THREE.MathUtils.lerp(H.r[2], A.r[2], e));
    _hp.lerp(_tmp.set(...S.p), spr);
    _hr.x += (S.r[0] - _hr.x) * spr; _hr.y += (S.r[1] - _hr.y) * spr; _hr.z += (S.r[2] - _hr.z) * spr;
    if (p && p.crouching) _hp.y -= 0.025;
    // walk bob (shared phase with the camera) — damped while aiming
    if (p) {
      const amp = Math.min(1, (p.speed || 0) / 3) * (1 - 0.8 * e);
      _hp.x += Math.cos(p.bobPhase || 0) * 0.008 * amp;
      _hp.y += Math.abs(Math.sin(p.bobPhase || 0)) * 0.010 * amp;
    }
    // raise/lower: blend from the lowered pose
    const v = this._heldVis * this._heldVis * (3 - 2 * this._heldVis);
    _hp.lerp(_tmp.set(...D.p), 1 - v);
    _hr.x += (D.r[0] - _hr.x) * (1 - v); _hr.y += (D.r[1] - _hr.y) * (1 - v); _hr.z += (D.r[2] - _hr.z) * (1 - v);
    // exponential smoothing — no snaps on stance changes
    const k = 1 - Math.exp(-14 * dt);
    this._heldPos.lerp(_hp, k);
    this._heldRot.x += (_hr.x - this._heldRot.x) * k;
    this._heldRot.y += (_hr.y - this._heldRot.y) * k;
    this._heldRot.z += (_hr.z - this._heldRot.z) * k;
    m.position.copy(this._heldPos);
    m.rotation.set(this._heldRot.x, this._heldRot.y, this._heldRot.z);
  }

  _removeWorld(u) {
    if (u.collider) { try { this.game.physics.remove(u.collider); } catch (_) { /* already gone */ } }
    if (u.mesh) { try { this.game.scene.remove(u.mesh); } catch (_) { /* scene torn down */ } }
    if (u.mat) u.mat.dispose();
    u.collider = null; u.mesh = null; u.mat = null;
  }

  /** Remove every standing wall from the world (teardown / reset). */
  destroy(reason = 'manual') {
    for (const u of this.units) {
      if (u.state === 'deployed' || u.state === 'damaged') {
        this._removeWorld(u);
        // teardown returns walls to the pack only as part of a full reset();
        // a plain teardown just leaves the world clean
        u.state = reason === 'mission-reset' ? 'carried' : u.state;
      }
      if (u.state === 'held' && reason === 'mission-reset') u.state = 'carried';
    }
    if (this.heldModel && reason !== 'manual') { this._heldVis = 0; this.heldModel.visible = false; }
    this._refreshHud();
  }

  /** HUD cooldown ring (0..1 remaining). */
  cooldownRatio() { return this.cooldownLeft > 0 ? this.cooldownLeft / this.defCooldown : 0; }

  /** Compact HUD text, e.g. "BARRIER 2/3 · HELD · 1 OUT". */
  hudText() {
    const c = this.withPlayerCount, d = this.deployedCount, x = this.destroyedCount;
    let t = `BARRIER ${c}/${SHIELD_DEF.capacity}`;
    if (this.heldUnit) t += ` · HELD ${Math.ceil(this.heldUnit.hp)}`;
    if (d) t += ` · ${d} OUT`;
    if (x) t += ` · ${x} LOST`;
    return t;
  }

  /* FINAL MOBILE UX FIX — one event, one channel. Before, negative messages
   * went through toastBrief AND radio with the same text (shown 2–3 times). */
  _say(text, positive = false) {
    const ui = this.game.ui;
    if (!ui) return;
    if (positive) ui.toastBrief(text);
    else ui.radio(text);
  }
  _refreshHud() { const ui = this.game.ui; if (ui && ui.refreshTacticalChips) { try { ui.refreshTacticalChips(); } catch (_) { /* HUD not built yet */ } } }
}

/** Local trait lookup (avoids import cycle with characters.js). */
function CHARACTER_TRAITS(game) {
  const sys = game.characters;
  if (!sys || !sys.def) return {};
  return sys.def.traits || {};
}
