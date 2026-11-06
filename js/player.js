/**
 * player.js
 * First-person controller: acceleration-based movement, stances (stand /
 * crouch / sprint), lean, stamina, jump with fall damage, head bob, camera
 * recoil springs, injury modifiers and noise emission for the AI hearing
 * system. Deliberately "heavy": no instant acceleration, no superhuman jump.
 */
import * as THREE from 'three';
import { VXFRAG_MISSION_START, VXFRAG_STOCK_MAX } from './throwables.js';
import {
  BODY_STATE, IMPACT_TUNE, bodyModifiers, clearContacts, initImpactState,
  processMoveContacts, syncActorBody, tickBodyState, unregisterActorBody,
} from './impacts.js';

const EYE_STAND = 1.62;
const EYE_CROUCH = 0.92;
const BOX_H_STAND = 1.8;
const BOX_H_CROUCH = 1.2;
const BOX_R = 0.34;
const GRAVITY = 16.0;
const JUMP_VEL = 4.4;           // ≈0.6 m jump — modest, realistic
const STEP_HEIGHT = 0.42;       // auto step-up onto stairs / low props
const MAX_FALL_SAFE = 11.5;     // below this landing speed: no damage

export const PLAYER_MOVEMENT = Object.freeze({
  walk: 3.6, crouch: 1.15, sprint: 7.8,
  walkAccel: 22, sprintAccel: 22, groundFriction: 9, overspeedDecel: 10,
  // Enough energy for roughly 22 seconds of continuous sprint, then a short
  // recovery window; sustained repositioning is useful without being endless.
  sprintDrain: 4.5, sprintRegenMove: 13, sprintRegenIdle: 18, sprintDelay: 0.5,
  exhaustedRecovery: 24,
});

export class Player {
  constructor(game) {
    this.game = game;

    this.pos = new THREE.Vector3();      // feet position
    this.vel = new THREE.Vector3();
    this.lastSafePos = new THREE.Vector3();
    this.lastSafeYaw = 0;
    this._hasSafeGround = false;
    this.fallRecoveryCount = 0;
    this._down = new THREE.Vector3(0, -1, 0);
    this._recoveryPos = new THREE.Vector3();
    this._safeHits = [];
    this._safeGroundCheckT = 0;
    this.yaw = 0;
    this.pitch = 0;

    this.box = { min: new THREE.Vector3(), max: new THREE.Vector3() };
    this._moveOut = { onGround: false, hitX: false, hitZ: false, hitCeil: false, steppedUp: false, groundCollider: null };
    this._moveOpts = { ignoreBody: null, actors: true };
    // Solid-body state machine (standing / staggered / knocked_down / recovering).
    initImpactState(this, { mass: 84 });
    this._halfWidth = BOX_R;
    this._height = BOX_H_STAND;
    this._body = null;
    this.knockRoll = 0;
    this.knockView = 0;

    this.onGround = true;
    this.crouching = false;
    this.crouchT = 0;      // 0 stand → 1 crouch (animated)
    this.sprinting = false;
    this.lean = 0;         // -1 left, +1 right
    this.leanT = 0;

    this.health = 100;
    this.frags = VXFRAG_MISSION_START;
    this.maxHealth = 100;
    this.stamina = 100;
    this.exhausted = false;
    this.staminaDelay = 0;

    this.speed = 0;
    this.bobPhase = 0;
    this.bobAmp = 0;
    this.landImpulse = 0;
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;

    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.rollT = 0;

    this.legInjury = 0;    // seconds remaining
    this.armor = 50;       // plate: absorbs 65% of damage until it shreds
    this.bandageT = 0;
    this.bandageCd = 0;
    this.bandageCdRate = 1;
    this.mantleT = 0; this.mantleDur = 0.45;
    this.mantleFrom = new THREE.Vector3();
    this.mantleTo = new THREE.Vector3();
    this.armInjury = 0;
    this.timeSinceDamage = 99;

    this.stepAccum = 0;
    this._groundMat = 'concrete';
    this._groundMatT = 0;

    this.headPos = new THREE.Vector3();
    this.viewDir = new THREE.Vector3();

    this.alive = true;
    this._tmp1 = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._tmp3 = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  reset(spawn, yaw, restore) {
    this.pos.copy(spawn);
    this.vel.set(0, 0, 0);
    this.lastSafePos.copy(spawn);
    this.lastSafeYaw = yaw;
    this._hasSafeGround = true; // every authored campaign insertion point has a floor collider
    this._safeGroundCheckT = 0;
    this.yaw = yaw;
    this.pitch = 0;
    this.health = 100;
    this.maxHealth = 100;          // Phase-14: CharacterSystem.apply() may raise/lower after this line
    this.charSpeedMult = 1;
    this.charHandlingMult = 1;
    this.charSpreadMult = 1;
    this.visibilityMult = 1;       // consumed by enemy perception gain
    this.frags = VXFRAG_MISSION_START;
    this.stamina = 100;
    this.exhausted = false;
    this.crouching = false;
    this.crouchT = 0;
    this.lean = 0; this.leanT = 0;
    this.recoilPitch = 0; this.recoilYaw = 0;
    this.legInjury = 0; this.armInjury = 0;
    this.armor = 50;
    this.bandageT = 0; this.bandageCd = 0; this.mantleT = 0;
    this.timeSinceDamage = 99;
    this.landImpulse = 0;
    this.alive = true;
    this.bodyState = BODY_STATE.STANDING;
    this.bodyStateT = 0; this.bodyStateDur = 0;
    this.impactCd = 0; this.knockSeverity = 0; this.downBlend = 0;
    this.knockRoll = 0; this.knockView = 0;
    if (this._pairCd) this._pairCd.clear();
    if (this._touching) this._touching.clear();
    this._syncBox();
    // The operator is a solid body too: enemies must not walk through him.
    if (this.game && this.game.physics && this.game.physics.actors) {
      this._body = syncActorBody(this.game.physics, this, this.box, { tag: 'actor', material: 'fabric' });
    }
    if (restore) {
      this.health = restore.health ?? 100;
      this.stamina = restore.stamina ?? 100;
    }
  }

  _syncBox() {
    const h = this._standingHeight();
    this._height = h;
    this.box.min.set(this.pos.x - BOX_R, this.pos.y, this.pos.z - BOX_R);
    this.box.max.set(this.pos.x + BOX_R, this.pos.y + h, this.pos.z + BOX_R);
    // Publish the same volume to the physics actor field so every other body
    // (soldiers, vehicles) is resolved against the operator, not just him
    // against them.
    if (this._body && this.game && this.game.physics) {
      this.game.physics.syncActorBody(this._body, this.box.min, this.box.max);
    }
  }

  /** A body state has a real collision volume: downed keeps a low but solid
   * box, so nobody can walk through a fallen operator either. */
  _standingHeight() {
    if (this.bodyState === BODY_STATE.KNOCKED_DOWN || this.bodyState === BODY_STATE.RECOVERING) {
      return IMPACT_TUNE.DOWN_BOX_HEIGHT;
    }
    return THREE.MathUtils.lerp(BOX_H_STAND, BOX_H_CROUCH, this.crouchT);
  }

  /** Physics options for this mover: never collide with own body. */
  _moveOptions() {
    this._moveOpts.ignoreBody = this._body;
    this._moveOpts.actors = !this.game.vehicleMode;
    return this._moveOpts;
  }

  /** True while the operator can still act (used by weapons + vehicle code). */
  canAct() {
    return this.bodyState === BODY_STATE.STANDING || this.bodyState === BODY_STATE.STAGGERED;
  }
  canFire() {
    return this.bodyState !== BODY_STATE.KNOCKED_DOWN && this.bodyState !== BODY_STATE.RECOVERING;
  }

  _withinPlayableBounds(pos, inset = 0.35) {
    const b = this.game.world && this.game.world.bounds;
    return !b || (pos.x >= b.minX + inset && pos.x <= b.maxX - inset &&
      pos.z >= b.minZ + inset && pos.z <= b.maxZ - inset);
  }

  _hasSafeGroundAt(pos, out = this._recoveryPos) {
    const g = this.game;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z) || !this._withinPlayableBounds(pos)) return false;
    const origin = this._tmp1.set(pos.x, pos.y + 0.42, pos.z);
    const hit = g.physics.raycast(origin, this._down, 2.8);
    if (!hit || Math.abs(hit.point.y - pos.y) > 0.38) return false;
    const footY = hit.point.y + 0.02;
    const min = this._tmp2.set(pos.x - BOX_R, footY + 0.03, pos.z - BOX_R);
    const max = this._tmp3.set(pos.x + BOX_R, footY + BOX_H_STAND, pos.z + BOX_R);
    const blockers = g.physics.queryAABB(min, max, this._safeHits);
    if (blockers.some(c => c.max.y > footY + 0.05 && c.min.y < footY + BOX_H_STAND - 0.03)) return false;
    out.set(pos.x, footY, pos.z);
    return true;
  }

  _rememberSafeGround(dt = 0) {
    if (!this.onGround || !this._withinPlayableBounds(this.pos)) return;
    this._safeGroundCheckT -= dt;
    if (this._safeGroundCheckT > 0) return;
    this._safeGroundCheckT = 0.25;
    if (!this._hasSafeGroundAt(this.pos, this._recoveryPos)) return;
    this.lastSafePos.copy(this._recoveryPos);
    this.lastSafeYaw = this.yaw;
    this._hasSafeGround = true;
  }

  /** Recover only after leaving authored bounds or falling below the map.
   * This is a player-only teleport; it does not rebuild enemies or mission state. */
  _recoverFromWorldBoundary() {
    const g = this.game;
    const b = g.world && g.world.bounds;
    const outside = b && (this.pos.x < b.minX + 0.35 || this.pos.x > b.maxX - 0.35 ||
      this.pos.z < b.minZ + 0.35 || this.pos.z > b.maxZ - 0.35);
    const belowWorld = !Number.isFinite(this.pos.y) || this.pos.y < -8;
    if (!outside && !belowWorld) return false;

    let safe = false;
    if (this._hasSafeGround) safe = this._hasSafeGroundAt(this.lastSafePos, this._recoveryPos);
    if (!safe && g.world && g.world.spawnPoint) {
      safe = this._hasSafeGroundAt(g.world.spawnPoint, this._recoveryPos);
      if (safe) this.lastSafeYaw = g.world.spawnYaw || 0;
    }
    if (!safe) return false;

    this.pos.copy(this._recoveryPos);
    this.vel.set(0, 0, 0);
    this.yaw = this.lastSafeYaw;
    this.pitch = 0;
    this.recoilPitch = 0; this.recoilYaw = 0;
    this.onGround = true;
    this.sprinting = false;
    this.crouching = false; this.crouchT = 0;
    this.lean = 0; this.leanT = 0;
    this.mantleT = 0;
    this.landImpulse = 0;
    this.bobAmp = 0;
    this.speed = 0;
    this.bodyState = BODY_STATE.STANDING;
    this.bodyStateT = 0; this.bodyStateDur = 0; this.downBlend = 0;
    this.knockSeverity = 0; this.knockRoll = 0; this.knockView = 0;
    this._syncBox();
    this.lastSafePos.copy(this.pos);
    this._hasSafeGround = true;
    this.fallRecoveryCount++;
    if (g.stats) g.stats.fallRecoveries = (g.stats.fallRecoveries || 0) + 1;
    if (g.ui && g.ui.toastBrief) g.ui.toastBrief('FALL RECOVERY — RETURNED TO LAST SAFE GROUND');
    return true;
  }

  handlingMultiplier() {
    // arm injuries slow weapon handling (>1 = worse)
    let m = this.armInjury > 0 ? 1.35 : 1.0;
    // Phase-14 character package (marksman/engineer/specialist handle faster).
    // Expressed as a bonus: 1.15 handling = 15% better swaps/reloads.
    const ch = this.charHandlingMult || 1;
    if (ch !== 1) m /= ch; // multiplier is "worse" scale; invert the bonus
    return m;
  }
  spreadMultiplier() {
    let m = 1;
    if (this.armInjury > 0) m *= 1.3;
    const bm = this._bodyMods;
    if (bm && bm.aimSpreadMul !== 1) m *= bm.aimSpreadMul;
    if (this.health < 30) m *= 1.15;
    // Stance matters: a crouched operator is braced, a leaning one is not.
    if (this.crouching) m *= 0.72;
    if (Math.abs(this.lean) > 0.4) m *= 1.12;
    m *= this.charSpreadMult || 1;   // Phase-14 character spread package
    return m;
  }

  /**
   * Weapon-pose stability. Lower = steadier. Used for view-model sway so a
   * braced stance visibly settles the weapon instead of only shrinking the
   * crosshair.
   */
  stabilityMultiplier() {
    let m = 1;
    if (this.crouching) m *= 0.7;                    // braced
    if (Math.abs(this.lean) > 0.4) m *= 1.15;        // off-axis
    if (!this.onGround) m *= 1.5;                    // no footing
    if (this.armInjury > 0) m *= 1.25;
    return m;
  }
  speedMultiplier() {
    let m = 1;
    if (this.legInjury > 0) m *= 0.62;
    if (this._bodyMods && this._bodyMods.mobility < 1) m *= 0.55 + 0.45 * this._bodyMods.mobility;
    if (this.health < 25) m *= 0.85;
    // Phase-14 character package (stat mult + active burst/adrenal ability).
    const cs = this.game && this.game.characters;
    m *= cs ? cs.liveSpeedMult() : (this.charSpeedMult || 1);
    // CRITICAL FIX: a raised AEGIS shield costs a little mobility
    const sh = this.game && this.game.shield;
    if (sh && sh.heldUnit) m *= 0.9;
    return m;
  }

  addRecoil(pitch, yaw) {
    this.recoilPitch = THREE.MathUtils.clamp(this.recoilPitch + pitch, -6 * THREE.MathUtils.DEG2RAD, 8 * THREE.MathUtils.DEG2RAD);
    this.recoilYaw = THREE.MathUtils.clamp(this.recoilYaw + yaw, -4 * THREE.MathUtils.DEG2RAD, 4 * THREE.MathUtils.DEG2RAD);
  }

  weaponBob() {
    // figure-eight style bob fed to the weapon rig
    const amp = this.bobAmp;
    return {
      x: Math.cos(this.bobPhase) * amp * 1.35,
      y: -Math.abs(Math.sin(this.bobPhase)) * amp * 1.6 + amp * 0.35,
    };
  }

  // -------------------------------------------------------------------------
  update(dt, input) {
    const g = this.game;
    // Body-state timers run on their own clock: a wedged body still stands up.
    tickBodyState(this, dt);
    if (!this.alive) {
      // death cam: slowly sink / tilt
      this.pitch = THREE.MathUtils.lerp(this.pitch, -0.5, 1 - Math.exp(-2 * dt));
      this.rollT = THREE.MathUtils.lerp(this.rollT, 0.9, 1 - Math.exp(-2 * dt));
      this._applyCamera();
      return;
    }

    // ---- look ----
    // Master upgrade P3: aim speed follows the view. While magnified (ADS or
    // observation zoom) the turn rate scales with the FOV ratio so a pixel of
    // mouse travel covers the same on-screen distance; desktop ADS also honours
    // the AIM (ADS) SENSITIVITY slider (touch applies it in touch.js already).
    const w = g.weapons;
    const touchLook = !!(g.touch && g.touch.enabled);
    const adsE = w && w.adsT ? w.easeInOut(w.adsT) : 0;
    const aimMul = touchLook ? 1 : 1 + ((g.settings.aimSens != null ? g.settings.aimSens : 0.8) / 0.8 - 1) * adsE;
    const zoomMul = w && w.zoomFactor > 1.0005 ? 1 / w.zoomFactor : 1;
    const sens = g.settings.sensitivity * 0.0022 * aimMul * zoomMul;
    this.lookDeltaX = input.lookX;
    this.lookDeltaY = input.lookY;
    this.yaw -= input.lookX * sens;
    this.pitch -= input.lookY * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.53, 1.53);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

    // ---- recoil recovery springs ----
    const rk = 1 - Math.exp(-7.5 * dt);
    this.recoilPitch = THREE.MathUtils.lerp(this.recoilPitch, 0, rk);
    this.recoilYaw = THREE.MathUtils.lerp(this.recoilYaw, 0, rk * 1.2);

    // ---- stance ----
    const wantsCrouch = input.crouch;
    if (this.bodyState === BODY_STATE.KNOCKED_DOWN || this.bodyState === BODY_STATE.RECOVERING) {
      this.crouching = false;      // the body, not the player, owns the volume
      this.crouchT = 0;
    } else if (wantsCrouch !== this.crouching) {
      if (!wantsCrouch) {
        // stand-up headroom check
        const h = BOX_H_STAND;
        const min = this._tmp1.set(this.pos.x - BOX_R, this.pos.y + 0.02, this.pos.z - BOX_R);
        const max = this._tmp2.set(this.pos.x + BOX_R, this.pos.y + h, this.pos.z + BOX_R);
        const hits = g.physics.queryAABB(min, max, []);
        const blocked = hits.some(c => c.enabled && c.max.y > this.pos.y + BOX_H_CROUCH + 0.05);
        if (!blocked) this.crouching = false;
      } else {
        this.crouching = true;
      }
    }
    const crouchTarget = this.crouching ? 1 : 0;
    this.crouchT = THREE.MathUtils.lerp(this.crouchT, crouchTarget, 1 - Math.exp(-11 * dt));
    this._syncBox();

    // ---- lean ----
    const leanWant = (input.leanL ? -1 : 0) + (input.leanR ? 1 : 0);
    this.leanT = THREE.MathUtils.lerp(this.leanT, leanWant, 1 - Math.exp(-10 * dt));
    this.lean = this.leanT;

    // ---- stamina ----
    this.staminaDelay = Math.max(0, this.staminaDelay - dt);
    const ads = g.weapons.adsT > 0.5;
    const mods = bodyModifiers(this);
    this._bodyMods = mods;
    const wantSprint = input.sprint && !this.crouching && !ads && input.moveF > 0.2 && this.stamina > 1 && !this.exhausted && mods.canSprint;
    this.sprinting = wantSprint && this.onGround;
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - PLAYER_MOVEMENT.sprintDrain * dt);
      this.staminaDelay = PLAYER_MOVEMENT.sprintDelay;
      if (this.stamina <= 0) this.exhausted = true;
    } else if (this.staminaDelay <= 0) {
      this.stamina = Math.min(100, this.stamina + (this.speed < 0.5 ? PLAYER_MOVEMENT.sprintRegenIdle : PLAYER_MOVEMENT.sprintRegenMove) * dt);
      if (this.exhausted && this.stamina > PLAYER_MOVEMENT.exhaustedRecovery) this.exhausted = false;
    }

    // ---- movement wish ----
    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
    // camera faces -Z at yaw 0 → forward = (-sin? ) compute:
    const fwdX = -sinY, fwdZ = -cosY;
    const rightX = cosY, rightZ = -sinY;
    let wishX = fwdX * input.moveF + rightX * input.moveR;
    let wishZ = fwdZ * input.moveF + rightZ * input.moveR;
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 1) { wishX /= wishLen; wishZ /= wishLen; }

    let targetSpeed = PLAYER_MOVEMENT.walk;                   // brisk, responsive walk
    if (this.crouching) targetSpeed = PLAYER_MOVEMENT.crouch;
    else if (this.sprinting) targetSpeed = PLAYER_MOVEMENT.sprint; // forward sprint only
    if (ads && !this.crouching) targetSpeed = Math.min(targetSpeed, 1.75);
    if (Math.abs(this.lean) > 0.4) targetSpeed *= 0.78;
    targetSpeed *= g.weapons.def.handling || 1;
    targetSpeed *= this.speedMultiplier();
    if (mods.speedMul !== 1) targetSpeed *= mods.speedMul;
    if (wishLen < 0.05) targetSpeed = 0;
    else targetSpeed *= Math.min(1, wishLen);

    // accel / friction (ground)
    const horizVel = this._tmp1.set(this.vel.x, 0, this.vel.z);
    const curSpeed = horizVel.length();
    if (this.onGround) {
      const accel = this.sprinting ? PLAYER_MOVEMENT.sprintAccel : PLAYER_MOVEMENT.walkAccel; // quicker starts and direction changes
      if (targetSpeed > 0.01) {
        // accelerate toward wish direction, but never above targetSpeed
        const desiredX = wishX * targetSpeed, desiredZ = wishZ * targetSpeed;
        let dvx = desiredX - this.vel.x, dvz = desiredZ - this.vel.z;
        const dvLen = Math.hypot(dvx, dvz);
        const maxDv = accel * dt;
        if (dvLen > maxDv) { dvx = dvx / dvLen * maxDv; dvz = dvz / dvLen * maxDv; }
        this.vel.x += dvx; this.vel.z += dvz;
        // clamp overspeed when slowing from sprint
        const nh = Math.hypot(this.vel.x, this.vel.z);
        const cap = Math.max(targetSpeed, curSpeed - PLAYER_MOVEMENT.overspeedDecel * dt);
        if (nh > cap) { this.vel.x *= cap / nh; this.vel.z *= cap / nh; }
      } else {
        // friction decel
        const drop = Math.max(curSpeed - PLAYER_MOVEMENT.groundFriction * dt, 0) / Math.max(curSpeed, 0.0001);
        this.vel.x *= drop; this.vel.z *= drop;
        if (curSpeed < 0.05) { this.vel.x = 0; this.vel.z = 0; }
      }
    } else {
      // air control — weak
      if (targetSpeed > 0.01) {
        this.vel.x += wishX * 2.2 * dt * targetSpeed;
        this.vel.z += wishZ * 2.2 * dt * targetSpeed;
      }
    }

    // ---- jump ----
    if (input.jumpPressed && this.onGround && !this.crouching && this.stamina > 8 && mods.canJump) {
      this.vel.y = JUMP_VEL;
      this.onGround = false;
      this.stamina -= 10;
      this.staminaDelay = 1.0;
      g.audio.jump(this.headPos);
      g.emitNoise(this.pos, this.sprinting ? 14 : 8, 'jump');
    }

    // gravity
    this.vel.y -= GRAVITY * dt;
    if (this.vel.y < -40) this.vel.y = -40;

    // ---- integrate + collide ----
    // A downed body is dragged along the ground: kill the walk acceleration and
    // let a heavier friction bring it to rest, so a knockdown can never turn
    // into a slide across the map.
    if (mods.mobility < 0.99) {
      const drag = Math.exp(-(4.2 + (1 - mods.mobility) * 9) * dt);
      this.vel.x *= drag; this.vel.z *= drag;
      if (Math.hypot(this.vel.x, this.vel.z) < 0.08) { this.vel.x = 0; this.vel.z = 0; }
    }
    const dx = this.vel.x * dt, dy = this.vel.y * dt, dz = this.vel.z * dt;
    // how hard this body intends to hit whatever is ahead of it this frame —
    // the impact resolver reads it because a blocked move zeroes `vel`
    this._intentSpeed = dt > 1e-4 ? Math.hypot(dx, dz) / dt : 0;
    const wasAir = !this.onGround;
    g.physics.moveBox(this.box, dx, dy, dz, this._moveOut, this.onGround ? STEP_HEIGHT : 0, this._moveOptions());
    // Solid contact with another body: stagger/knockdown response, reciprocal.
    if (!g.vehicleMode && this._moveOut.contactedActor) {
      const res = processMoveContacts(this, g.physics, this._moveOut, dt, {
        skip: (m, other) => !!(g.vehicleMode && g.vehicleMode === other),
      });
      if (res && res.hit && g.onBodyImpact) g.onBodyImpact(res.other || this, res.hit.state, res.speed, res.hit.severity);
    } else if (!this._moveOut.contactedActor) {
      clearContacts(this);
    }
    this.pos.set(this.box.min.x + BOX_R, this.box.min.y, this.box.min.z + BOX_R);
    const out = this._moveOut;
    this.onGround = out.onGround;
    // Gravity is applied each frame; clear the landing impulse or it builds to
    // the velocity cap while standing and later lets edge/platform transitions
    // tunnel through collision floors.
    if (this.onGround && this.vel.y < 0) this.vel.y = 0;
    if (out.hitX) this.vel.x = 0;
    if (out.hitZ) this.vel.z = 0;
    if (out.hitCeil) this.vel.y = Math.min(0, this.vel.y);

    // ---- mantle / vault (ledges up to ~1.1 m) ----
    if (this.mantleT > 0) {
      this.mantleT -= dt;
      const k = 1 - Math.max(0, this.mantleT) / this.mantleDur;
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.pos.lerpVectors(this.mantleFrom, this.mantleTo, e);
      this.pos.y += Math.sin(k * Math.PI) * 0.16;
      this.vel.set(0, 0, 0);
      this._syncBox();
      if (this.mantleT <= 0) this.onGround = true;
    } else if (out.onGround && (out.hitX || out.hitZ) && !this.crouching &&
               this.stamina > 14 && this.bandageT <= 0 && mods.canAim &&
               (input.moveF > 0.3 || Math.abs(input.moveR) > 0.6)) {
      this._tryMantle(wishX, wishZ);
    }

    // landing
    if (wasAir && this.onGround) {
      const impactV = Math.abs(Math.min(0, dy / Math.max(dt, 0.0001)));
      this.landImpulse = THREE.MathUtils.clamp(impactV / 14, 0, 1.4);
      g.audio.land(this.headPos, impactV > 6);
      g.emitNoise(this.pos, impactV > 8 ? 16 : impactV > 4 ? 8 : 3, 'land');
      if (impactV > MAX_FALL_SAFE) {
        const dmg = (impactV - MAX_FALL_SAFE) * 7;
        this.damage('legs', dmg, null, true);
      }
      if (impactV > 2) {
        g.particles.footDust(this._tmp2.set(this.pos.x, this.pos.y + 0.05, this.pos.z), this._groundMaterial());
      }
    }
    this.landImpulse = Math.max(0, this.landImpulse - dt * 3.2);
    this._rememberSafeGround(dt);

    this.speed = Math.hypot(this.vel.x, this.vel.z);

    // ---- footsteps / noise ----
    this._groundMatT -= dt;
    if (this.onGround && this.speed > 0.35) {
      const stride = this.sprinting ? 2.35 : this.crouching ? 1.3 : 1.85;
      this.stepAccum += this.speed * dt;
      if (this.stepAccum >= stride) {
        this.stepAccum = 0;
        this._footstep();
      }
    } else {
      this.stepAccum = Math.min(this.stepAccum, 0.5);
    }

    // ---- head bob ----
    const bobTarget = this.onGround && this.speed > 0.4
      ? (this.sprinting ? 0.055 : this.crouching ? 0.018 : 0.032) * Math.min(1, this.speed / 3)
      : 0;
    this.bobAmp = THREE.MathUtils.lerp(this.bobAmp, bobTarget, 1 - Math.exp(-8 * dt));
    this.bobPhase += dt * (this.sprinting ? 11.5 : this.crouching ? 5.2 : 7.6) * Math.min(1.4, this.speed / 2.2 + 0.25);

    // ---- bandage hold (H): stop the clock on injuries + patch up ----
    this.bandageCd = Math.max(0, this.bandageCd - dt);
    if (input.bandageHeld && this.bandageCd <= 0 && this.mantleT <= 0 &&
        (this.armInjury > 0 || this.legInjury > 0 || this.health < 75)) {
      this.bandageT += dt;
      if (this.bandageT >= 2.8) {
        this.bandageT = 0;
        this.bandageCd = 12 * (this.bandageCdRate || 1);
        this.health = Math.min(this.maxHealth || 100, this.health + 28);
        this.armInjury = 0;
        this.legInjury = 0;
        g.audio.impact('fabric', this.headPos, 0.5);
        g.ui.radio('FIELD DRESSING APPLIED');
      }
    } else {
      this.bandageT = Math.max(0, this.bandageT - dt * 2);
    }

    // ---- injuries / regen ----
    this.legInjury = Math.max(0, this.legInjury - dt);
    this.armInjury = Math.max(0, this.armInjury - dt);
    this.timeSinceDamage += dt;
    if (this.timeSinceDamage > 12 && this.health < 50 && this.health > 0) {
      this.health = Math.min(50, this.health + 2.4 * dt); // field stabilisation, partial only
    }

    this.setLastDt(dt);
    this._recoverFromWorldBoundary();
    this._applyCamera();
    this._syncBox();

    // view vectors for interaction / AI
    g.camera.getWorldDirection(this.viewDir);
    this.headPos.set(this.pos.x, this.pos.y + this._eyeHeight(), this.pos.z);
  }

  _tryMantle(wishX, wishZ) {
    const g = this.game;
    const len = Math.hypot(wishX, wishZ);
    if (len < 0.05) return;
    const dx = wishX / len, dz = wishZ / len;
    // chest-high probe: anything taller than ~1.1 m is a wall, not a ledge
    const o1 = this._tmp1.set(this.pos.x + dx * 0.1, this.pos.y + 1.38, this.pos.z + dz * 0.1);
    const d1 = this._tmp2.set(dx, 0, dz);
    if (g.physics.raycast(o1, d1, 0.8)) return;
    // find the ledge surface just past the obstacle
    const p3 = this._tmp3.set(this.pos.x + dx * 0.75, this.pos.y + 1.5, this.pos.z + dz * 0.75);
    const hit = g.physics.raycast(p3, this._tmp2.set(0, -1, 0), 2.6);
    if (!hit) return;
    const ledgeY = hit.point.y;
    const rise = ledgeY - this.pos.y;
    if (rise < 0.32 || rise > 1.28) return;
    // headroom over the ledge
    const o4 = this._tmp1.set(p3.x, ledgeY + 0.35, p3.z);
    if (g.physics.raycast(o4, this._tmp2.set(dx, 0, dz), 0.55)) return;
    this.mantleFrom.copy(this.pos);
    this.mantleTo.set(this.pos.x + dx * 0.8, ledgeY + 0.02, this.pos.z + dz * 0.8);
    this.mantleT = this.mantleDur;
    this.stamina -= 9;
    this.staminaDelay = 0.7;
    this.onGround = false;
    g.audio.jump(this.headPos);
    g.emitNoise(this.pos, 6, 'mantle');
  }

  _eyeHeight() {
    return THREE.MathUtils.lerp(EYE_STAND, EYE_CROUCH, this.crouchT);
  }

  /** dt for presentation-only easing (set by update()). */
  setLastDt(dt) { this._lastDt = dt; }

  _applyCamera() {
    const cam = this.game.camera;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * this.bobAmp;
    const bobX = Math.cos(this.bobPhase) * this.bobAmp * 0.55;

    // Knockdown view: the eye falls to ground height and the horizon rolls,
    // then recovers with the body. Driven by downBlend so the visual and the
    // collision volume can never disagree.
    const down = this.downBlend || 0;
    this.knockView += ((this.knockView - down * 0.62) * -1) * (1 - Math.exp(-14 * (this._lastDt || 1 / 60)));
    const viewDrop = down * (this._eyeHeight() - 0.44);
    this.knockRoll = down * 0.42 * (this.fallDir && this.fallDir.x >= 0 ? 1 : -1);

    // lean: offset along the local right vector + roll
    const rightX = Math.cos(this.yaw), rightZ = -Math.sin(this.yaw);
    const leanOff = this.lean * 0.26;

    cam.position.set(
      this.pos.x + rightX * leanOff + (-Math.sin(this.yaw + Math.PI / 2)) * bobX * 0,
      this.pos.y + this._eyeHeight() + bobY - viewDrop,
      this.pos.z + rightZ * leanOff
    );
    // apply bob along the right axis too
    cam.position.x += rightX * bobX;
    cam.position.z += rightZ * bobX;

    cam.rotation.order = 'YXZ';
    cam.rotation.y = this.yaw + this.recoilYaw;
    cam.rotation.x = THREE.MathUtils.clamp(this.pitch + this.recoilPitch, -1.55, 1.55);

    // roll: lean + slight strafe tilt + death tilt
    const strafeRoll = THREE.MathUtils.clamp(-this.vel.x * Math.cos(this.yaw) - this.vel.z * -Math.sin(this.yaw), -3, 3);
    const targetRoll = -this.lean * 0.055 + strafeRoll * 0.002 + this.rollT + this.knockRoll;
    this.rollT = this.alive ? THREE.MathUtils.lerp(this.rollT, 0, 0.1) : this.rollT;
    cam.rotation.z = THREE.MathUtils.lerp(cam.rotation.z || 0, targetRoll, 0.25);

    this.headPos.set(cam.position.x, cam.position.y, cam.position.z);
  }

  _groundMaterial() {
    if (this._groundMatT > 0) return this._groundMat;
    this._groundMatT = 0.35;
    const origin = this._tmp3.set(this.pos.x, this.pos.y + 0.15, this.pos.z);
    const hit = this.game.physics.raycast(origin, this._downDir || (this._downDir = new THREE.Vector3(0, -1, 0)), 0.8);
    this._groundMat = hit ? hit.collider.material : 'concrete';
    return this._groundMat;
  }

  _footstep() {
    const g = this.game;
    const mat = this._groundMaterial();
    const intensity = this.sprinting ? 1.25 : this.crouching ? 0.4 : 0.8;
    g.audio.footstep(mat, this._tmp2.set(this.pos.x, this.pos.y + 0.2, this.pos.z), intensity);
    if (!this.crouching || Math.random() < 0.4) {
      g.particles.footDust(this._tmp2.set(this.pos.x, this.pos.y + 0.04, this.pos.z), mat);
    }
    // AI hearing radii by gait (crouch-walking is nearly silent)
    let radius = 0;
    if (this.sprinting) radius = mat === 'metal' ? 26 : 18;
    else if (this.crouching) radius = mat === 'metal' ? 4 : 2.2;
    else radius = mat === 'metal' ? 13 : 8;
    g.emitNoise(this.pos, radius, 'footstep');
  }

  // -------------------------------------------------------------------------
  damage(zone, amount, fromPos, silent = false) {
    if (!this.alive || this.game.state !== 'playing') return;
    if (this.armor > 0 && amount > 0) {
      const absorbed = Math.min(this.armor, amount * 0.65);
      this.armor -= absorbed;
      amount -= absorbed;
      if (amount < 0.6) {
        this.timeSinceDamage = 0;
        this.game.ui.armorFlash();
        return;
      }
    }
    this.game.stats.damageTaken += amount;
    this.health -= amount;
    this.timeSinceDamage = 0;

    if (zone === 'legs') this.legInjury = Math.max(this.legInjury, 5.5);
    if (zone === 'arms') this.armInjury = Math.max(this.armInjury, 7);

    const g = this.game;
    if (!silent) g.audio.playerHurt();
    g.ui.playerDamaged(amount, fromPos, this.pos);
    // Phase-14 ghost discipline: taking a hit that reaches the body breaks
    // LOW SIGNATURE. Armour-only grazes don't (returned before this point).
    if (g.characters) g.characters.onDamaged();

    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      g.onPlayerDeath(fromPos ? 'hostile fire' : 'injuries');
    }
  }

  addSuppress(a) { this.game.suppress = Math.min(1, this.game.suppress + a); }

  /**
   * Armoury pad / field resupply. Credits ammunition through the weapon system's
   * single accounting path, so nothing is ever overwritten or lost.
   *
   * The previous version assigned `reserve = min(reserveMax, reserve + n)`
   * directly, which for a continuous-feed weapon (the VX-4, `reserveMax: 0`, all
   * 300 rounds carried in `mag`) both destroyed a saved legacy reserve and gave
   * the primary rifle nothing at all.
   */
  resupplyAll(full = false) {
    this.frags = Math.min(VXFRAG_STOCK_MAX, Math.max(0, this.frags || 0) + 1);
    this.armor = Math.min(100, this.armor + 50);
    const ws = this.game.weapons;
    if (!ws || !ws.addRounds) return;
    let granted = 0;
    for (const id of Object.keys(ws.state)) {
      const def = ws.defs[id];
      if (!def) continue;
      const amount = full ? def.magSize + def.reserveMax : Math.ceil(def.magSize * 2.5);
      granted += ws.addRounds(id, amount).added;
    }
    return granted;
  }

  /**
   * Field damage recovery (P0-D):
   * Restores player health up to max (100) and clears limb injuries.
   * Returns the numeric HP restored (0 if already full or deceased).
   */
  recoverHealth(amount = 100, reason = 'INTEL') {
    if (!this.alive || this.health <= 0) return 0;
    const max = this.maxHealth || 100;
    const prior = this.health;
    const target = Math.min(max, this.health + Math.max(0, amount));
    const restored = target - prior;
    if (restored > 0) {
      this.health = target;
      this.armInjury = 0;
      this.legInjury = 0;
      this.timeSinceDamage = Math.max(this.timeSinceDamage, 4.0);
    }
    return restored;
  }

  // -------------------------------------------------------------------------
  snapshot() {
    return {
      pos: this.pos.toArray(),
      yaw: this.yaw,
      health: this.health,
      frags: this.frags,
      armor: this.armor,
      stamina: this.stamina,
      ammo: JSON.parse(JSON.stringify(this.game.weapons.state)),
      weapon: this.game.weapons.currentId,
    };
  }

  restoreSnapshot(snap) {
    if (!snap) return;
    this.reset(new THREE.Vector3().fromArray(snap.pos), snap.yaw, { health: snap.health, stamina: snap.stamina });
    this.frags = snap.frags != null
      ? Math.max(0, Math.min(VXFRAG_STOCK_MAX, Math.floor(Number(snap.frags) || 0)))
      : VXFRAG_MISSION_START;
    this.armor = snap.armor != null ? snap.armor : 50;
    const ws = this.game.weapons;
    if (snap.ammo && typeof snap.ammo === 'object') {
      Object.assign(ws.state, JSON.parse(JSON.stringify(snap.ammo)));
    }
    ws.currentId = snap.weapon && ws.models[snap.weapon] ? snap.weapon : 'vx4';
    for (const [id, state] of Object.entries(ws.state)) {
      const def = ws.defs[id];
      if (!def || !state) continue;
      state.mag = Math.max(0, Math.min(def.magSize, Math.floor(Number(state.mag) || 0)));
      state.reserve = Math.max(0, Math.min(1000000, Math.floor(Number(state.reserve) || 0)));
      const modes = def.fireModes || [def.auto ? 'auto' : 'semi'];
      if (!modes.includes(state.fireMode)) state.fireMode = def.defaultFireMode || modes[0];
      state.burstRemaining = 0;
      state.bloom = Math.max(0, Number(state.bloom) || 0);
      state.heat = Math.max(0, Number(state.heat) || 0);
      state.malf = !!state.malf;
      ws._restoreWeaponVisual(id);
    }
    for (const m of Object.values(ws.models)) m.visible = false;
    ws.models[ws.currentId].visible = true;
    ws.state_ = 'ready';
    ws.stateT = 0; ws.stateDur = 0; ws.pendingSelect = null; ws.queuedSelect = null;
    ws.nextShotAt = 0;
    ws.reloadEvents.length = 0; ws.projectiles.length = 0;
    ws._shellReload = false; ws._rackMalf = false;
    ws.triggerWasDown = false; ws.triggerBlockedUntilRelease = false;
    ws.dryFireLatch = false;
    ws.adsT = 0;
    ws._adsToggled = false;   // Phase-14: a toggle-latched ADS must not survive death/restore
    if (ws.rebuildOwned) ws.rebuildOwned();
  }
}
