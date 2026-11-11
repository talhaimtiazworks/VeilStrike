/**
 * playerbody.js
 *
 * A real, rigged character representation for the operator: head, torso,
 * pelvis, arms (upper/lower), hands, legs (upper/lower) and boots, plus an
 * anchor for a third-person weapon.
 *
 * The SAME rig is used everywhere there is a camera that can see the operator
 * (first-person body awareness, vehicle chase camera), so there is never a
 * second contradictory player state.
 *
 * Performance notes:
 *  - geometry and materials are created once and shared by every limb
 *  - the update path allocates nothing (all scratch vectors are preallocated)
 *  - shadow casting is enabled per-mesh and follows the quality setting
 */
import * as THREE from 'three';
import { attachPlayerSkin, operatorTint, OPERATOR_KITS, soldierAssetStatus } from './soldier-rig.js';

const DEG = Math.PI / 180;

// Proportions are in metres, derived from the gameplay constants so the rig and
// the camera agree:
//   pelvis 0.78 + torso offset 0.10 + torso 0.52 + neck 0.10 + head/2 0.12
//     = 1.62  -> exactly Player.EYE_STAND, so the camera sits at eye level with
//                the whole torso BELOW it (no near-plane clipping, no occlusion).
//   feet land on y = 0 and the helmet tops out at ~1.75, matching BOX_H_STAND.
const LEG_UPPER = 0.37;
const LEG_LOWER = 0.33;
const TORSO_H = 0.52;
const PELVIS_H = 0.20;
const HEAD_H = 0.24;
const ARM_UPPER = 0.28;
const ARM_LOWER = 0.26;
const PELVIS_LIFT = 0.08;   // pelvis rest height above the ankle joint

export class PlayerBody {
  constructor(game) {
    this.game = game;
    this.root = new THREE.Group();
    this.root.name = 'player-body';
    this.built = false;
    this.thirdPerson = false;
    this.visible = true;

    // scratch — never reallocated
    this._v1 = new THREE.Vector3();
    this._walkPhase = 0;
    this._leanT = 0;
    this._crouchT = 0;
    this._sprintT = 0;
    this._adsT = 0;
    this._airT = 0;
    this._recoil = 0;
    this._lastSpeed = 0;

    this._mats = {};
    this._geos = [];
    this._sphere = null;
    this._capsuleCache = new Map();
    this._suitTint = null;   // operator uniform colour (CHARACTER_DEFS.tint)
    // Rigged operator skin (CC0 soldier + UAL clips). Attached lazily once the
    // shared asset is ready; the procedural rig remains the fallback.
    this.skin = null;
    this._operatorId = 'vanguard';
    this._skinState = { vx: 0, vz: 0, yaw: 0, crouch: 0, air: 0, sprint: 0, firstPerson: true, vehicle: false, pitch: 0 };
  }

  _skinOpts() {
    return { tint: operatorTint(this._suitTint ?? 0x394136), kit: OPERATOR_KITS[this._operatorId] || 'rifleman' };
  }

  /** Select the operator's armour kit (CHARACTER_DEFS id). */
  setOperatorKit(id) {
    if (typeof id !== 'string') return;
    this._operatorId = id;
    if (this.skin) this.skin.setOperator(this._skinOpts());
  }

  _driveSkin(dt, player, vehicle) {
    if (!this.skin) {
      if (soldierAssetStatus().status !== 'ready') return;
      this.skin = attachPlayerSkin(this, this._skinOpts());
      if (!this.skin) return;
    }
    const s = this._skinState;
    s.vx = vehicle ? 0 : (player.vel ? player.vel.x : 0);
    s.vz = vehicle ? 0 : (player.vel ? player.vel.z : 0);
    s.yaw = this.root.rotation.y;
    s.crouch = this._crouchT;
    s.air = this._airT;
    s.sprint = this._sprintT;
    s.firstPerson = !this.thirdPerson;
    s.vehicle = !!vehicle;
    s.pitch = player.pitch || 0;
    this.skin.update(dt, s);
  }

  /** Recolour the uniform for the selected operator; safe before build(). */
  setSuitTint(hex) {
    if (typeof hex !== 'number' || !Number.isFinite(hex)) return;
    this._suitTint = hex;
    if (this._mats.suit) this._mats.suit.color.setHex(hex);
    if (this.skin) this.skin.setOperator(this._skinOpts());
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------
  _mat(key, color, rough = 0.85, metal = 0.05) {
    if (!this._mats[key]) {
      this._mats[key] = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    }
    return this._mats[key];
  }

  _sphereGeo() {
    if (!this._sphere) {
      this._sphere = new THREE.SphereGeometry(1, 14, 10);
      this._geos.push(this._sphere);
    }
    return this._sphere;
  }

  _capsuleGeo(radius, length, radial = 10) {
    const inner = Math.max(0.025, length - radius * 2);
    const key = `${radius.toFixed(3)}:${inner.toFixed(3)}:${radial}`;
    let g = this._capsuleCache.get(key);
    if (!g) {
      g = new THREE.CapsuleGeometry(radius, inner, 3, radial);
      this._capsuleCache.set(key, g);
      this._geos.push(g);
    }
    return g;
  }

  _mesh(geo, mat, cast = true) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = false;
    return m;
  }

  _ellipsoid(parent, mat, pos, scale, cast = true) {
    const m = this._mesh(this._sphereGeo(), mat, cast);
    m.position.set(pos[0], pos[1], pos[2]);
    m.scale.set(scale[0], scale[1], scale[2]);
    parent.add(m);
    return m;
  }

  _capsule(parent, mat, radius, length, pos, scale = [1, 1, 1], cast = true) {
    const m = this._mesh(this._capsuleGeo(radius, length), mat, cast);
    m.position.set(pos[0], pos[1], pos[2]);
    m.scale.set(scale[0], scale[1], scale[2]);
    parent.add(m);
    return m;
  }

  build() {
    if (this.built) return;
    this.built = true;

    const suit = this._mat('suit', this._suitTint ?? 0x3a4238, 0.94, 0.01);
    const armour = this._mat('armour', 0x2c322c, 0.74, 0.1);
    const vest = this._mat('vest', 0x292f29, 0.9, 0.04);
    const skin = this._mat('skin', 0x94785f, 0.96, 0.0);
    const gear = this._mat('gear', 0x202622, 0.82, 0.08);
    const boot = this._mat('boot', 0x171a18, 0.94, 0.02);
    const helmetMat = this._mat('helmet', 0x313a34, 0.72, 0.12);
    const lensMat = this._mat('lens', 0x111819, 0.28, 0.42);
    const pouchMat = this._mat('pouch', 0x343b32, 0.92, 0.02);

    // Feet remain on the ground; the pelvis pivot carries the full rig through
    // standing, crouching and jump poses. Front is -Z, matching the camera.
    this.pelvis = new THREE.Group();
    this.pelvis.position.y = LEG_UPPER + LEG_LOWER + PELVIS_LIFT;
    this.root.add(this.pelvis);
    this._ellipsoid(this.pelvis, suit, [0, 0.02, 0], [0.205, 0.13, 0.14]);

    this.torso = new THREE.Group();
    this.torso.position.y = PELVIS_H * 0.5;
    this.pelvis.add(this.torso);
    this._ellipsoid(this.torso, suit, [0, 0.27, 0], [0.215, 0.30, 0.135]);
    this._capsule(this.torso, vest, 0.19, 0.15, [0, 0.28, -0.008], [1.14, 1.04, 0.78]);

    // Layered plate carrier, webbing and rounded pouches add a human-scale
    // silhouette while keeping geometry shared and the draw count low.
    this._ellipsoid(this.torso, gear, [0, 0.30, -0.132], [0.155, 0.18, 0.026]);
    const strap = this._capsuleGeo(0.018, 0.34, 8);
    for (const side of [-1, 1]) {
      const m = this._mesh(strap, pouchMat);
      m.position.set(side * 0.105, 0.34, -0.10);
      m.rotation.z = -side * 0.08;
      this.torso.add(m);
    }
    const belt = this._capsule(this.torso, gear, 0.032, 0.36, [0, 0.075, 0.005], [1, 1, 1]);
    belt.rotation.z = Math.PI / 2;
    for (const x of [-0.12, -0.04, 0.04, 0.12]) {
      this._capsule(this.torso, pouchMat, 0.024, 0.062, [x, 0.16, -0.164], [1.05, 0.86, 0.62], false);
    }
    this._ellipsoid(this.torso, gear, [0.183, 0.35, -0.04], [0.045, 0.075, 0.05]); // radio pouch
    this._ellipsoid(this.torso, this._mat('radio-face', 0x536056, 0.5, 0.22), [0.198, 0.36, -0.075], [0.018, 0.043, 0.023], false);
    // Plate-carrier wrap: side plates, rear plate and padded shoulder straps.
    for (const side of [-1, 1]) {
      this._ellipsoid(this.torso, armour, [side * 0.212, 0.25, -0.01], [0.03, 0.11, 0.095]);
      this._ellipsoid(this.torso, vest, [side * 0.12, 0.47, -0.01], [0.055, 0.022, 0.13], false);
    }
    this._ellipsoid(this.torso, armour, [0, 0.31, 0.128], [0.15, 0.17, 0.028]);

    const neck = this._capsule(this.torso, skin, 0.056, 0.055, [0, 0.535, 0]);
    this.head = new THREE.Group();
    this.head.position.y = TORSO_H + 0.10 + HEAD_H * 0.5;
    this.torso.add(this.head);
    this._ellipsoid(this.head, skin, [0, 0, 0], [0.102, 0.122, 0.105]);

    const domeGeo = new THREE.SphereGeometry(1, 14, 9, 0, Math.PI * 2, 0, Math.PI * 0.62);
    this._geos.push(domeGeo);
    const dome = this._mesh(domeGeo, helmetMat);
    dome.position.y = 0.035;
    dome.scale.set(0.123, 0.087, 0.132);
    this.head.add(dome);
    const brim = this._mesh(new THREE.CylinderGeometry(0.124, 0.137, 0.025, 16), helmetMat);
    this._geos.push(brim.geometry);
    brim.position.y = 0.005;
    this.head.add(brim);
    this._ellipsoid(this.head, lensMat, [0, 0.005, -0.098], [0.082, 0.021, 0.019], false);
    // High-cut helmet details: accessory rails, NVG shroud, counterweight.
    for (const side of [-1, 1]) this._ellipsoid(this.head, gear, [side * 0.124, 0.045, 0], [0.011, 0.018, 0.085], false);
    this._ellipsoid(this.head, gear, [0, 0.085, -0.122], [0.03, 0.022, 0.014], false);
    this._ellipsoid(this.head, pouchMat, [0, 0.04, 0.128], [0.05, 0.03, 0.02], false);
    for (const side of [-1, 1]) this._ellipsoid(this.head, skin, [side * 0.101, -0.01, 0], [0.018, 0.035, 0.034]);

    this.armL = this._buildArm(suit, gear, skin, -1);
    this.armR = this._buildArm(suit, gear, skin, 1);
    this.armL.group.position.set(-0.27, TORSO_H - 0.06, 0);
    this.armR.group.position.set(0.27, TORSO_H - 0.06, 0);
    this.torso.add(this.armL.group, this.armR.group);

    // Reusable weapon anchor for the same original fictional rifle silhouette
    // in a third-person camera. First person keeps the animated weapon viewmodel.
    this.handAnchor = new THREE.Object3D();
    this.handAnchor.position.set(0, -ARM_LOWER - 0.035, -0.045);
    this.armR.lower.add(this.handAnchor);
    this._buildThirdPersonWeapon();

    this.legL = this._buildLeg(suit, boot, -1);
    this.legR = this._buildLeg(suit, boot, 1);
    this.legL.group.position.set(-0.12, 0, 0);
    this.legR.group.position.set(0.12, 0, 0);
    this.pelvis.add(this.legL.group, this.legR.group);
    this.setThirdPerson(false);
  }

  _buildArm(suit, gear, skin, side) {
    const group = new THREE.Group();
    const upper = new THREE.Group();
    group.add(upper);
    this._capsule(upper, suit, 0.071, ARM_UPPER, [0, -ARM_UPPER * 0.5, 0], [1.02, 1, 0.94]);
    this._ellipsoid(upper, gear, [0, -0.055, -0.006], [0.086, 0.072, 0.088]);

    const lower = new THREE.Group();
    lower.position.y = -ARM_UPPER;
    upper.add(lower);
    this._capsule(lower, suit, 0.062, ARM_LOWER, [0, -ARM_LOWER * 0.5, 0], [0.98, 1, 0.92]);
    this._ellipsoid(lower, gear, [0, -0.12, -0.052], [0.065, 0.077, 0.026]); // forearm guard
    this._ellipsoid(lower, this._mat('armour', 0x2c322c, 0.74, 0.1), [0, -0.015, 0], [0.074, 0.045, 0.074], false); // elbow pad
    const hand = this._ellipsoid(lower, gear, [0, -ARM_LOWER - 0.035, -0.025], [0.056, 0.061, 0.069]);
    this._ellipsoid(lower, skin, [side * -0.035, -ARM_LOWER - 0.038, -0.047], [0.023, 0.038, 0.034], false);
    group.rotation.z = side * 4 * DEG;
    return { group, upper, lower, hand, side };
  }

  _buildLeg(suit, boot, side) {
    const group = new THREE.Group();
    const upper = new THREE.Group();
    group.add(upper);
    this._capsule(upper, suit, 0.095, LEG_UPPER, [0, -LEG_UPPER * 0.5, 0], [1, 1, 0.9]);
    this._ellipsoid(upper, this._mat('knee-pad', 0x252b26, 0.8, 0.08), [0, -LEG_UPPER * 0.82, -0.065], [0.082, 0.075, 0.028]);
    this._ellipsoid(upper, this._mat('cargo', 0x30372f, 0.95, 0.01), [side * 0.07, -LEG_UPPER * 0.53, -0.035], [0.035, 0.075, 0.036], false);

    const lower = new THREE.Group();
    lower.position.y = -LEG_UPPER;
    upper.add(lower);
    this._capsule(lower, suit, 0.073, LEG_LOWER, [0, -LEG_LOWER * 0.5, 0], [0.96, 1, 0.94]);
    const foot = this._ellipsoid(lower, boot, [0, -LEG_LOWER - 0.035, -0.052], [0.079, 0.056, 0.137]);
    this._ellipsoid(lower, this._mat('sole', 0x0e1110, 0.98, 0), [0, -LEG_LOWER - 0.078, -0.035], [0.08, 0.018, 0.135], false);
    return { group, upper, lower, foot, side };
  }

  _buildThirdPersonWeapon() {
    const metal = this._mat('weapon-metal', 0x23272a, 0.42, 0.62);
    const polymer = this._mat('weapon-polymer', 0x292f2b, 0.86, 0.04);
    const root = new THREE.Group();
    root.name = 'operator-carried-weapon';
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.017, 0.40, 10), metal);
    this._geos.push(barrel.geometry);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.018, -0.30);
    root.add(barrel);
    const receiver = this._capsule(root, metal, 0.038, 0.25, [0, 0, -0.105], [1, 1, 1]);
    receiver.rotation.x = Math.PI / 2;
    const handguard = this._capsule(root, polymer, 0.028, 0.17, [0, 0.015, -0.265], [1, 1, 1]);
    handguard.rotation.x = Math.PI / 2;
    const stock = this._capsule(root, polymer, 0.035, 0.15, [0, -0.004, 0.15], [1, 1, 1]);
    stock.rotation.x = Math.PI / 2;
    this._capsule(root, polymer, 0.021, 0.105, [0, -0.086, -0.075], [0.88, 1, 0.88]); // magazine
    this._capsule(root, polymer, 0.018, 0.09, [0, -0.075, 0.025], [0.85, 1, 0.8]); // grip
    const optic = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.085, 10), metal);
    this._geos.push(optic.geometry);
    optic.rotation.x = Math.PI / 2;
    optic.position.set(0, 0.054, -0.13);
    root.add(optic);
    root.position.set(0.015, -0.005, -0.02);
    this.handAnchor.add(root);
    this.weaponRoot = root;
  }

  // -------------------------------------------------------------------------
  // Visibility / mode
  // -------------------------------------------------------------------------
  /**
   * First person hides the head (the camera lives inside it) to guarantee no
   * near-plane clipping. Third person shows the complete operator.
   */
  setThirdPerson(on) {
    if (!this.built) return;
    this.thirdPerson = !!on;
    this.head.visible = this.thirdPerson;
    this.root.visible = this.visible;
    if (this.weaponRoot) this.weaponRoot.visible = this.thirdPerson && this.game.handsMode === 'gun';
  }

  setVisible(on) {
    this.visible = !!on;
    this.root.visible = this.visible;
  }

  setShadows(enabled) {
    if (!this.built) return;
    this.root.traverse(o => { if (o.isMesh) o.castShadow = !!enabled; });
  }

  /**
   * Recoil absorption. Called by the weapon system on every shot so the
   * operator's shoulders and arms take the impulse instead of only the
   * view model. `strength` is roughly 0..1 (heavier weapons hit harder).
   */
  addRecoil(strength) {
    if (!this.built) return;
    this._recoil = Math.min(1.4, this._recoil + (strength || 0.2));
  }

  /**
   * Snap every smoothed value to the player's current state so the rig never
   * lerps across the map from a stale pose (mission start / respawn).
   */
  snug() {
    if (!this.built) return;
    const p = this.game.player;
    if (!p) return;
    this._crouchT = p.crouchT || 0;
    this._sprintT = p.sprinting ? 1 : 0;
    this._adsT = (this.game.weapons && this.game.weapons.adsT) || 0;
    this._leanT = p.lean || 0;
    this._airT = p.onGround ? 0 : 1;
    this._walkPhase = 0;
    this._lastSpeed = p.speed || 0;
    this.root.position.set(p.pos.x, p.pos.y, p.pos.z);
    this.root.rotation.y = p.yaw || 0;
  }

  // -------------------------------------------------------------------------
  // Per-frame update — allocation free
  // -------------------------------------------------------------------------
  update(dt, player) {
    if (!this.built || !this.visible) return;

    const sprinting = !!player.sprinting;
    const speed = player.speed || 0;
    const grounded = !!player.onGround;

    // smoothed stance weights
    const k = (rate) => 1 - Math.exp(-rate * dt);
    this._crouchT += (player.crouchT - this._crouchT) * k(14);
    this._sprintT += ((sprinting ? 1 : 0) - this._sprintT) * k(8);
    this._adsT += (((player.game.weapons && player.game.weapons.adsT) || 0) - this._adsT) * k(12);
    this._leanT += ((player.lean || 0) - this._leanT) * k(10);
    this._airT += ((grounded ? 0 : 1) - this._airT) * k(9);
    // recoil absorption: shoulders take the impulse, then settle
    this._recoil = Math.max(0, this._recoil - dt * (2.4 + this._recoil * 5));
    const recoil = Math.min(1, this._recoil);

    // place the rig: feet on the ground, facing the aim yaw
    this.root.position.set(player.pos.x, player.pos.y, player.pos.z);
    this.root.rotation.y = player.yaw;

    // ---- pelvis height: stand / crouch / airborne -------------------------
    const standY = LEG_UPPER + LEG_LOWER + PELVIS_LIFT;
    const crouchY = standY * 0.55;
    let pelvisY = THREE.MathUtils.lerp(standY, crouchY, this._crouchT);
    if (this._airT > 0.01) pelvisY += this._airT * 0.09;      // tuck slightly
    this.pelvis.position.y = pelvisY;

    // ---- walk cycle --------------------------------------------------------
    // Phase is driven by distance travelled so the stride never skates.
    this._walkPhase += (speed * dt) * (sprinting ? 2.6 : 3.1);
    const stride = Math.min(1, speed / (sprinting ? 5.4 : 3.0));
    const swing = Math.sin(this._walkPhase) * stride;
    const swing2 = Math.cos(this._walkPhase) * stride;

    // legs counter-swing; airborne tucks them
    const legAmp = (sprinting ? 0.62 : 0.42) * stride;
    const tuck = this._airT * 0.55;
    this._setLeg(this.legL, swing * legAmp, tuck);
    this._setLeg(this.legR, -swing * legAmp, tuck);

    // vertical body bob follows the same cycle
    const bob = Math.abs(Math.sin(this._walkPhase)) * stride * (sprinting ? 0.035 : 0.018);
    this.pelvis.position.y += bob - this._crouchT * 0.0;

    // ---- torso: forward lean when sprinting, upright when aiming ----------
    const leanFwd = this._sprintT * 9 * DEG + this._crouchT * 12 * DEG - this._adsT * 4 * DEG;
    this.torso.rotation.x = leanFwd - recoil * 5 * DEG;   // shot pushes the shoulders back
    this.torso.rotation.z = -this._leanT * 5 * DEG;
    // head counter-rotates so the operator still looks where they aim
    this.head.rotation.x = -leanFwd * 0.75 + THREE.MathUtils.clamp(
      (player.pitch || 0) * (this.thirdPerson ? 0.82 : -0.35), -0.6, 0.6);

    // ---- arms --------------------------------------------------------------
    if (this.thirdPerson) {
      // A relaxed ready carry blends into a two-hand sight picture; sprinting
      // lowers the muzzle without snapping the arms out of their sockets.
      const gunMode = this.game.handsMode === 'gun';
      const ready = (gunMode ? 0.62 + this._adsT * 0.38 : 0.24) * (1 - this._sprintT * 0.78);
      const aimPitch = THREE.MathUtils.clamp(player.pitch || 0, -0.75, 0.75);
      this.armR.upper.rotation.x = THREE.MathUtils.lerp(
        -swing2 * 0.30 * stride, 72 * DEG + aimPitch * 0.55, ready);
      this.armR.upper.rotation.z = -10 * DEG * ready + 7 * DEG;
      this.armR.lower.rotation.x = THREE.MathUtils.lerp(-18 * DEG, 12 * DEG, ready);

      this.armL.upper.rotation.x = THREE.MathUtils.lerp(
        swing2 * 0.30 * stride, 62 * DEG + aimPitch * 0.55, ready);
      this.armL.upper.rotation.z = 16 * DEG * ready - 7 * DEG;
      this.armL.lower.rotation.x = THREE.MathUtils.lerp(-16 * DEG, 22 * DEG, ready);
      if (this.weaponRoot) this.weaponRoot.visible = gunMode;
    } else {
      // First person: arms are represented by the weapon viewmodel, so the rig
      // arms hang naturally and simply counter-swing with the stride.
      this.armR.upper.rotation.x = -swing2 * 0.34 * stride - this._crouchT * 10 * DEG - recoil * 6 * DEG;
      this.armR.upper.rotation.z = 8 * DEG;
      this.armR.lower.rotation.x = -22 * DEG - this._crouchT * 18 * DEG - recoil * 8 * DEG;

      this.armL.upper.rotation.x = swing2 * 0.34 * stride - this._crouchT * 10 * DEG - recoil * 6 * DEG;
      this.armL.upper.rotation.z = -8 * DEG;
      this.armL.lower.rotation.x = -22 * DEG - this._crouchT * 18 * DEG - recoil * 8 * DEG;
    }

    this._lastSpeed = speed;
    this._driveSkin(dt, player, null);
  }

  /** Seated driver pose for the shared operator rig in a vehicle chase camera. */
  updateVehicle(dt, player, vehicle) {
    if (!this.built || !this.visible || !vehicle) return;
    const seatBase = Math.max(0.03, vehicle.def.seatH - 1.62);
    const seatX = vehicle.isHelicopter ? -0.36 : -vehicle.def.wd * 0.17;
    const seatZ = vehicle.isHelicopter ? -0.38 : -vehicle.def.hl * 0.25;
    vehicle.localToWorld(seatX, seatBase, seatZ, this._v1);
    this.root.position.copy(this._v1);
    this.root.rotation.set(0, vehicle.heading, 0);

    this._crouchT += (0.22 - this._crouchT) * (1 - Math.exp(-dt * 7));
    this._sprintT += (0 - this._sprintT) * (1 - Math.exp(-dt * 8));
    this._adsT += (0 - this._adsT) * (1 - Math.exp(-dt * 8));
    this._airT += (0 - this._airT) * (1 - Math.exp(-dt * 8));
    this._leanT += (0 - this._leanT) * (1 - Math.exp(-dt * 8));
    this._recoil = Math.max(0, this._recoil - dt * (2.4 + this._recoil * 5));
    this._walkPhase = 0;
    this._lastSpeed = vehicle.speed || 0;
    this.pelvis.position.y = LEG_UPPER + LEG_LOWER + PELVIS_LIFT - 0.18;
    this.torso.rotation.x = (vehicle.pitchT || 0) * 0.35;
    this.torso.rotation.z = (vehicle.rollT || 0) * 0.45;
    this.head.rotation.x = 0;

    // Knees fold toward the dash; arms sit forward at the steering wheel or
    // cyclic controls without changing the infantry animation state machine.
    this.legL.upper.rotation.x = -0.68; this.legL.lower.rotation.x = 1.05;
    this.legR.upper.rotation.x = -0.68; this.legR.lower.rotation.x = 1.05;
    this.armR.upper.rotation.x = 58 * DEG;
    this.armR.upper.rotation.z = -9 * DEG;
    this.armR.lower.rotation.x = 18 * DEG;
    this.armL.upper.rotation.x = 56 * DEG;
    this.armL.upper.rotation.z = 8 * DEG;
    this.armL.lower.rotation.x = 20 * DEG;
    if (this.weaponRoot) this.weaponRoot.visible = false;
    this._driveSkin(dt, player, vehicle);
  }

  _setLeg(leg, swing, tuck) {
    leg.upper.rotation.x = swing - tuck;
    leg.lower.rotation.x = Math.max(0, -swing * 0.85) + tuck * 1.35;
  }

  // -------------------------------------------------------------------------
  dispose() {
    if (!this.built) return;
    if (this.skin) { this.skin.dispose(); this.skin = null; }
    this.root.traverse(o => { if (o.isMesh) o.geometry = null; });
    for (const g of this._geos) g.dispose();
    for (const m of Object.values(this._mats)) m.dispose();
    this._geos.length = 0;
    this._mats = {};
    this._capsuleCache.clear();
    this._sphere = null;
    this.weaponRoot = null;
    this.built = false;
  }
}
