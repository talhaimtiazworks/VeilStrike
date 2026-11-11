/**
 * game.js
 * Orchestrator: renderer/scene setup, game-state machine, input aggregation,
 * pointer lock, settings persistence, quality tiers, mission lifecycle
 * (start / checkpoint restart / complete / fail) and the main loop.
 */
import * as THREE from 'three';
import { PhysicsWorld } from './physics.js';
import { GameWorld } from './world.js';
import { Particles } from './particles.js';
import { AudioSystem } from './audio.js';
import { WeaponSystem, WEAPON_ORDER, WEAPON_DEFS } from './weapons.js';
import { Player } from './player.js';
import { EnemyManager } from './enemies.js';
import { MissionManager, MISSION_DEFS } from './missions.js';
import { UI, volPct } from './ui.js';
import { TacticalMap } from './tacmap.js';
import { VehicleManager } from './vehicles.js';
import { ThrowableSystem, THROWABLE_DEFS } from './throwables.js';
import { Loadout } from './loadout.js';
import { Progress, MISSION_ORDER, getMissionMinEnemies } from './progress.js';
import { CharacterSystem } from './characters.js';
import { CAMPAIGN_ONLY } from './unlocks.js';
import { ShieldSystem, SHIELD_STOW_HOLD_MS } from './shield.js';
import { Flashlight } from './flashlight.js';          // Master upgrade P4
import { MusicSystem, MUSIC_TRACKS, MUSIC_ORDER, DEFAULT_TRACK } from './music.js';              // Master upgrade P6
import { BaseStrike } from './basestrike.js';          // Master upgrade P8
import { PlayerBody } from './playerbody.js';
import { loadSoldierAsset, awaitSoldierAsset, soldierAssetStatus } from './soldier-rig.js';
import { FireTriggerInput, FIRE_INPUT } from './fireinput.js';

const SETTINGS_KEY = 'obv_settings_v1';

/** Throwable projectile: small swept collider, damped ricochet and per-type fuse. */
class Grenade {
  constructor(game, pos, vel, type = 'vxfrag', owner = null) {
    // Compatibility for the old enemy call shape: (pos, vel, enemyActor).
    if (typeof type !== 'string') { owner = type || owner; type = 'vxfrag'; }
    this.game = game;
    this.type = THROWABLE_DEFS[type] ? type : 'vxfrag';
    this.owner = owner || null;
    this.pos = pos.clone();
    this.vel = vel.clone();
    this.fuse = THROWABLE_DEFS[this.type].fuse;
    this.done = false;
    this.radius = 0.075;
    this.surfacePoint = new THREE.Vector3();
    this.surfaceNormal = new THREE.Vector3(0, 1, 0);
    this.surfaceMaterial = 'soil';
    this.hasSurface = false;
    this._next = new THREE.Vector3();
    this._travel = new THREE.Vector3();
    const mat = (game.throwables && game.throwables._mats[this.type]) || game._grenadeMat;
    this.mesh = new THREE.Mesh(game._grenadeGeo, mat);
    this.mesh.position.copy(pos);
    game.scene.add(this.mesh);
  }
  update(dt) {
    if (this.done || dt <= 0) return;
    let remaining = Math.min(dt, 0.18);
    const physics = this.game.physics;
    // Short integration steps plus a swept sphere keep fast throws from skipping
    // thin walls, doors and props on a long rendered frame.
    while (remaining > 0.0001 && !this.done) {
      const step = Math.min(remaining, 1 / 30);
      this.vel.y -= 9.81 * step;
      this._next.copy(this.pos).addScaledVector(this.vel, step);
      let passes = 0;
      while (physics && passes++ < 4) {
        const hit = physics.sweepSphere(this.pos, this._next, this.radius);
        if (!hit) { this.pos.copy(this._next); break; }
        const collider = hit.collider;
        this.surfacePoint.copy(hit.point).addScaledVector(hit.normal, -this.radius);
        this.surfaceNormal.copy(hit.normal);
        this.surfaceMaterial = collider.material || 'concrete';
        this.hasSurface = true;

        // Thin panes break on a direct hit; continue the same short segment so
        // the projectile still meets any solid geometry immediately beyond it.
        if (collider.breakable && collider.tag === 'glass' && this.game.world?.breakGlass) {
          this.game.world.breakGlass(collider);
          if (this.game.particles?.glassBurst) this.game.particles.glassBurst(this.surfacePoint, hit.normal);
          if (this.game.audio?.impact) this.game.audio.impact('glass', this.surfacePoint, 0.8);
          this._travel.copy(this._next).sub(hit.point).normalize();
          this.pos.copy(hit.point).addScaledVector(this._travel, 0.025);
          if (this.pos.distanceToSquared(this._next) < 0.0004) { this.pos.copy(this._next); break; }
          continue;
        }

        const impactSpeed = this.vel.dot(hit.normal);
        if (Math.abs(impactSpeed) > 2.4) {
          const energy = Math.min(1.2, Math.abs(impactSpeed) / 8);
          if (this.game.particles && this.game.particles.impact) this.game.particles.impact(this.surfacePoint, hit.normal, this.surfaceMaterial, energy);
          if (this.game.audio && this.game.audio.impact) this.game.audio.impact(this.surfaceMaterial, this.surfacePoint, Math.min(0.75, energy * 0.55));
        }
        if (impactSpeed < 0) {
          const restitution = collider.material === 'fabric' ? 0.18 : collider.material === 'wood' ? 0.26 : 0.34;
          this.vel.addScaledVector(hit.normal, -(1 + restitution) * impactSpeed);
          const normalSpeed = this.vel.dot(hit.normal);
          this._travel.copy(this.vel).addScaledVector(hit.normal, -normalSpeed).multiplyScalar(0.72);
          this.vel.copy(this._travel).addScaledVector(hit.normal, normalSpeed);
        }
        this.pos.copy(hit.point).addScaledVector(hit.normal, 0.018);
        if (hit.normal.y > 0.55 && Math.abs(this.vel.y) < 0.92 && Math.hypot(this.vel.x, this.vel.z) < 1.35) this.vel.set(0, 0, 0);
        break;
      }
      this.fuse -= step;
      remaining -= step;
      if (this.fuse <= 0) this.done = true;
    }
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.x += Math.min(dt, 0.18) * 6;
  }
  dispose() { this.game.scene.remove(this.mesh); }
}

export const GameState = {
  BOOT: 'boot',
  MENU: 'menu',
  LOADING: 'loading',
  PLAYING: 'playing',
  PAUSED: 'paused',
  DEAD: 'dead',
  COMPLETE: 'complete',
  FAILED: 'failed',
};

const DEFAULT_SETTINGS = {
  sensitivity: 1.0,
  fov: 75,
  masterVolume: 0.8,
  sfxVolume: 0.9,
  ambVolume: 0.7,
  quality: 'medium',
  perfMode: false,
  dayMode: false,
  minimapOn: true,
  vehSteerInvert: false, vehSteerSens: 1.0, vehCamDist: 1.0,
  // Stage D — touch, accessibility, presentation
  touchControls: 'auto',      // 'auto' | 'on' | 'off'
  joySize: 1.0, joyOpacity: 0.55, btnSize: 1.0, btnOpacity: 0.8,
  lookStickSize: 1.0,          // right (camera) stick radius multiplier
  leftHanded: false, mobilePositions: {},
  mobileHudCompass: true, mobileHudObjective: true,
  mobileHudVitals: true, mobileHudAmmo: true,
  lookSens: 1.0, aimSens: 0.8, invertY: false,
  autoSprint: true, aimMode: 'hold', adsKey: 'KeyX', autoFire: false,
  autoHoldMs: Math.round(FIRE_INPUT.AUTO_ENGAGE_S * 1000),   // a press shorter than this is ONE
                                                              // shot, never a burst (fireinput.js)
  aimAssist: 'low',           // 'off' | 'low' | 'medium' | 'high'
  vibration: true, hudScale: 1.0,
  highContrast: false, largeText: false, reduceMotion: false,
  shakeScale: 1.0, subtitles: true,
  minimapSize: 'm',
  minimapOpacity: 0.85,
  minimapRotate: 'north',
  // Master upgrade (additive keys — older saves load with these defaults)
  adsMag: 1.0,                 // ADS magnification multiplier (0.8–1.3)
  zoomMag: 2.0,                // observation zoom magnification (1.5–4)
  musicVolume: 0.45,           // independent of master/sfx/ambience
  // Sole locally bundled soundtrack (also available to the offline PWA).
  musicTrack: 'ins-fearless-pt-2', // MUSIC_TRACKS id
  musicEnabled: true,          // background music on/off (sound effects unaffected)
  musicShuffle: false,
  musicPaused: false,          // the player pressed PAUSE — don't auto-start next session
};

export class Game {
  constructor() {
    this.state = GameState.BOOT;
    this.time = 0;
    this.settings = { ...DEFAULT_SETTINGS };
    // one-time migration: Phase-13 replaced the mobile layout toolbar with the
    // control editor (js/editor.js); retired keys from the old system are removed.
    try {
      const LEGACY_KEYS = ['obv_mobile_layout_saved', 'obv_touch_tray_v1'];
      if (!localStorage.getItem('obv_p13_migrated_v1')) {
        for (const k of LEGACY_KEYS) localStorage.removeItem(k);
        localStorage.setItem('obv_p13_migrated_v1', '1');
      }
    } catch (_) { /* storage unavailable */ }

    this._loadSettings();

    this.progress = new Progress();
    this.noiseMask = 1;
    this._worldEvT = 40;
    this._lastMission = 'facility';
    this._missionCompletionCommitted = false;
    this.stats = { kills: 0, shots: 0, hits: 0, headshots: 0, missionTime: 0, dataSecured: false, damageTaken: 0, alarm: false, checkpointsUsed: 0, intelRun: 0, minHealth: 100, mapOpens: 0, equipCats: {}, usedVehicle: false, vehicleAbandoned: false, driveDist: 0, throwablesUsed: 0 };

    this.input = {
      moveF: 0, moveR: 0,
      sprint: false, crouch: false, spaceHeld: false,
      vehicleCollective: 0, vehicleHover: false, vehicleHorn: false,
      _spaceKeyHeld: false, _shiftKeyHeld: false, _hoverKey: false,
      _touchVehicleCollective: 0, _touchVehicleHover: false,
      jumpPressed: false,
      leanL: false, leanR: false,
      mouse0: false, mouse2: false,
      lookX: 0, lookY: 0,
      reloadPressed: false,
      fireModePressed: false,
      selectWeapon: null,
      interactPressed: false,
      interactHeld: false,
      escPressed: false,
      wheelHeld: false,
      camPressed: false,
      grenadePressed: false,
      grenadeBackPressed: false,   // Phase-14 (N): cycle throwables backwards
      shieldPressed: false,        // Phase-14 (V on foot): deploy shield wall
      abilityPressed: false,       // Phase-14 (L): character ability
      bandageHeld: false,
      mapPressed: false,
      flashlightPressed: false,    // Master upgrade P4 (T on foot / touch LGT)
      baseStrikePressed: false,    // Master upgrade P8 (K / touch STK / pause menu)
      _zoomKey: false, _zoomMouse: false, _touchZoom: false,   // Master upgrade P3
    };

    this.audio = new AudioSystem();
    this.hackProgress = 0;
    this.terminalJamT = 0;      // Phase-14 EMP-4: seconds of terminal blackout left
    this.hackTarget = null;
    this._zoneT = 0;
    this._fovCurrent = this.settings.fov;
    this._raf = 0;
    this._lastT = 0;
    this._tmpV1 = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();
    this._blastDelta = new THREE.Vector3();
    this._blastDir = new THREE.Vector3();
    this._blastPoint = new THREE.Vector3();
    this._blastPoint2 = new THREE.Vector3();
    this._blastPoint3 = new THREE.Vector3();
    this._blastCenter = new THREE.Vector3();
    this._blastIgnore = new Set();
    this._blastRayOpts = { ignore: this._blastIgnore };
    this.shake = 0;
    this.interactTarget = null;   // touch layer reads the current interactable
    this.suppress = 0;
    this.grenades = [];
  }

  // =========================================================================
  // Boot
  // =========================================================================
  async boot() {
    this.ui = new UI(this);
    this.tacmap = new TacticalMap(this);
    this.ui.setLoading(0.05, 'CHECKING RENDERER…');
    await raf();

    // --- WebGL availability ---
    try {
      const test = document.createElement('canvas');
      const gl = test.getContext('webgl2') || test.getContext('webgl');
      if (!gl) throw new Error('no webgl');
    } catch (e) {
      this.ui.showError('WebGL is not available in this browser. Enable hardware acceleration or try a different browser (Chrome / Edge / Firefox).');
      return;
    }

    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: !this.settings.perfMode,
        powerPreference: 'high-performance',
      });
    } catch (e) {
      this.ui.showError('Failed to create the WebGL renderer: ' + e.message);
      return;
    }
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    document.getElementById('game-container').appendChild(this.renderer.domElement);

    // Phase 17: opt-in diagnostics for the performance/test harness. Enabled
    // only with ?vsdebug in the URL; exposes read-only handles the probes use
    // (renderer.info, frame-time ring). Inert for ordinary play.
    if (typeof location !== 'undefined' && /[?&](vsdebug|vsauto|vsnorender)\b/.test(location.search)) {
      window.__vs = this;
      this._frameRing = [];
    }
    if (typeof location !== 'undefined' && /[?&]vsnorender\b/.test(location.search)) {
      this._noRender = true;   // test-only: skip GL submission (software-GL measurement rigs)
    }
    // ?vsauto additionally runs an in-page scripted work-out after insertion
    // (rest → walk+look → ADS hold → fire) and publishes per-phase frame-time
    // statistics to window.__vsAutoReport. Software-GL test rigs cannot hold
    // an OPC session responsive enough for real scripted input; driving the
    // scenario in-page keeps the measurement deterministic. Test-only path —
    // never enabled by default and it never bypasses gameplay systems, it
    // only feeds the same input object the devices feed.
    if (typeof location !== 'undefined' && /[?&]vsauto\b/.test(location.search)) {
      this._vsAuto = {
        phase: 'idle', phaseT: 0, skippedClick: false,
        phases: ['rest', 'walk', 'ads', 'fire', 'cooldown'],
        data: {},
      };
    }

    this.scene = new THREE.Scene();
    this._grenadeGeo = new THREE.SphereGeometry(0.07, 6, 5);
    this._grenadeMat = new THREE.MeshStandardMaterial({ color: 0x2c3027, roughness: 0.8 });
    this._markers = [];
    for (let i = 0; i < 4; i++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 24),
        new THREE.MeshBasicMaterial({ color: 0xff3020, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      ring.visible = false;
      this.scene.add(ring);
      this._markers.push(ring);
    }
    this.scene.background = new THREE.Color(0x080c13);
    this.scene.fog = new THREE.FogExp2(0x0a0e14, 0.0095);

    this.camera = new THREE.PerspectiveCamera(this.settings.fov, window.innerWidth / window.innerHeight, 0.05, 220);
    this.scene.add(this.camera);

    this.physics = new PhysicsWorld();
    this.particles = new Particles(this.scene);
    this.world = new GameWorld();
    this.player = new Player(this);
    // Visible operator body (shared by first-person awareness and any
    // third-person camera) — one representation, never two.
    this.body = new PlayerBody(this);
    this.body.build();
    this.scene.add(this.body.root);
    this.weapons = new WeaponSystem(this);
    this.weapons.attachTo(this.camera);
    this.enemies = new EnemyManager(this);
    loadSoldierAsset();   // rigged soldier + UAL clips; never rejects (procedural fallback)
    this.vehicles = new VehicleManager(this);
    this.vehicleMode = null;   // the Vehicle the player is currently driving
    this.throwables = new ThrowableSystem(this);
    this.loadout = new Loadout();
    this.characters = new CharacterSystem(this);   // Phase-14 operator roster
    this.shield = new ShieldSystem(this);          // Phase-14 deployable wall (P5: inventory)
    this.flashlight = new Flashlight(this);        // Master upgrade P4
    this.flashlight.ensure();                      // created once, off (intensity 0) → no shader recompiles on toggle
    this.music = new MusicSystem(this);            // Master upgrade P6
    this.music.trackId = this.settings.musicTrack || DEFAULT_TRACK;
    this.music.state = this.settings.musicEnabled === false ? 'off' : 'stopped';
    this.music.onChange = () => this._syncMusicButton();
    this.baseStrike = new BaseStrike(this);        // Master upgrade P8
    this.handsMode = 'gun';    // 'gun' | 'throwable' | 'utility'
    this.wheelActive = false;
    this.wheelX = 0; this.wheelY = 0;
    this._throwCd = 0;
    this._mouse2Was = false;
    this.missions = new MissionManager(this);

    this.ui.setLoading(0.2, 'PREPARING SYSTEMS…');
    await raf();

    this._bindInput();
    this._bindUI();
    {
      const { TouchControls } = await import('./touch.js');
      this.touch = new TouchControls(this);
      this._detectDevice();
      // Device class must be known before the first resolution/shadow budget is set.
      this.applySettings(true);
    }
    this._losFn = (a, b) => this.physics.hasLOS(a, b);

    window.addEventListener('resize', () => this._onResize());
    window.addEventListener('orientationchange', () => setTimeout(() => this._onResize(), 120));
    document.addEventListener('fullscreenchange', () => this._onResize());
    if (window.visualViewport) window.visualViewport.addEventListener('resize', () => this._onResize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === GameState.PLAYING) this.pause();
    });

    this.ui.setLoading(1, 'READY');
    await raf(250);
    this.setState(GameState.MENU);
    this._loop = this._loop.bind(this);
    this._lastT = performance.now();
    requestAnimationFrame(this._loop);
  }

  // =========================================================================
  // Settings
  // =========================================================================
  _loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (e) { /* first run */ }
    // CRITICAL FIX (Task 3): migrate the retired procedural track ids
    const s = this.settings;
    if (!MUSIC_ORDER.includes(s.musicTrack)) {
      if (s.musicTrack === 'off') s.musicEnabled = false;
      s.musicTrack = DEFAULT_TRACK;
    }
    s.musicVolume = Math.max(0, Math.min(1, Number.isFinite(+s.musicVolume) ? +s.musicVolume : 0.45));
  }
  saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
  }

  applySettings(initial = false) {
    const s = this.settings;
    // Keep Y reserved for observation zoom, even when migrating an older or
    // hand-edited settings save that attempted to bind ADS to the same key.
    if (!['KeyX', 'CapsLock', 'Semicolon', 'KeyU'].includes(s.adsKey)) s.adsKey = 'KeyX';
    s.sensitivity = THREE.MathUtils.clamp(s.sensitivity, 0.2, 3);
    s.fov = THREE.MathUtils.clamp(Math.round(s.fov), 60, 100);

    if (!this.renderer) return;
    const q = s.perfMode ? 'low' : s.quality;

    // resolution — a handheld GPU pushes far fewer pixels per frame than a
    // desktop one, so cap the device pixel ratio harder on phones/tablets.
    // Desktop tiers keep their existing caps.
    const handheld = !!(this.device && (this.device.isPhone || this.device.isTablet));
    const prCap = Math.min(1.5, q === 'high' ? (handheld ? 1.5 : 1.5)
                : q === 'medium' ? (handheld ? 1.25 : 1.5) : 1);
    this._prCap = prCap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, prCap) * (this._prScale || 1));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    // draw distance + fog
    const far = q === 'high' ? 260 : q === 'medium' ? 220 : 160;
    const fogD = q === 'high' ? 0.0075 : q === 'medium' ? 0.0095 : 0.013;
    this.camera.far = far;
    if (this.scene.fog) this.scene.fog.density = fogD * (this.world && this.world.fogMul ? this.world.fogMul : 1);
    this.camera.fov = this._fovCurrent = s.fov;
    this.camera.updateProjectionMatrix();

    // shadows
    if (this.world && this.world.shadowLights) {
      for (const l of this.world.shadowLights) {
        const isMoon = l.isDirectionalLight;
        // Perf: medium tier keeps only the moon's directional shadow map —
        // shadowed point lights re-render the scene 6x per frame (cube maps),
        // which multiplies draw calls far beyond what a phone can submit.
        const wantShadow = isMoon ? true : q === 'high';
        if (l.castShadow !== wantShadow) {
          l.castShadow = wantShadow;
          if (!wantShadow && l.shadow && l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
        }
        let size = isMoon ? (q === 'high' ? 2048 : q === 'medium' ? 1536 : 1024) : (q === 'high' ? 1024 : 512);
        if (handheld) size = Math.min(size, 1024);   // handheld shadow budget
        if (l.shadow.mapSize.x !== size) {
          l.shadow.mapSize.set(size, size);
          if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
        }
      }
    }

    // player body shadows follow the same quality ladder as the world
    if (this.body && this.body.built) {
      this.body.setShadows(q === 'high' || q === 'medium');
    }

    // white mode (daylight relight) — respects authored daytime campaign environments unless overridden
    if (this.world && this.world.scene) {
      const prefTod = this.world._preferredTimeOfDay === 'day' ? 'day' : 'night';
      this.world.setLightingMode(s.dayMode ? 'day' : prefTod);
    }
    document.body.classList.toggle('daymode', !!s.dayMode);
    document.body.classList.toggle('contrast-high', !!s.highContrast);
    document.body.classList.toggle('text-lg', !!s.largeText);
    document.body.classList.toggle('reduce-motion', !!s.reduceMotion);
    document.body.classList.toggle('hide-touch-compass', s.mobileHudCompass === false);
    document.body.classList.toggle('hide-touch-objective', s.mobileHudObjective === false);
    document.body.classList.toggle('hide-touch-vitals', s.mobileHudVitals === false);
    document.body.classList.toggle('hide-touch-ammo', s.mobileHudAmmo === false);
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('--touch-scale', String(s.btnSize != null ? s.btnSize : 1));
    rootStyle.setProperty('--joy-scale', String(s.joySize != null ? s.joySize : 1));
    rootStyle.setProperty('--joy-op', String(s.joyOpacity != null ? s.joyOpacity : 0.55));
    rootStyle.setProperty('--btn-op', String(s.btnOpacity != null ? s.btnOpacity : 0.8));
    rootStyle.setProperty('--hud-scale', String(s.hudScale != null ? s.hudScale : 1));
    rootStyle.setProperty('--look-scale', String(s.lookStickSize != null ? s.lookStickSize : 1));
    const tcFit = Math.max(0.72, Math.min(1.02, (window.innerWidth + window.innerHeight) * 0.0008));
    const tcButtonScale = THREE.MathUtils.clamp(s.btnSize != null ? s.btnSize : 1, 0.7, 1.5);
    rootStyle.setProperty('--tc-fit-global', tcFit.toFixed(4));
    rootStyle.setProperty('--tc-u-global', (tcFit * tcButtonScale).toFixed(4));
    if (this.touch) this.touch.applySettings();

    // particles
    this.particles && this.particles.setQuality(s.quality, s.perfMode);

    // audio
    this.audio.setVolumes(s.masterVolume, s.sfxVolume, s.ambVolume);
    // Master upgrade: music volume/track + flashlight quality ladder
    s.adsMag = THREE.MathUtils.clamp(Number.isFinite(s.adsMag) ? s.adsMag : 1, 0.8, 1.3);
    s.zoomMag = THREE.MathUtils.clamp(Number.isFinite(s.zoomMag) ? s.zoomMag : 2, 1.5, 4);
    if (this.audio.setMusicVolume) this.audio.setMusicVolume(s.musicVolume != null ? s.musicVolume : 0.45);
    if (this.music && this.music.trackId !== (s.musicTrack || DEFAULT_TRACK)) this.music.select(s.musicTrack || DEFAULT_TRACK, {});
    if (this.flashlight) this.flashlight.applyQuality();

    if (!initial) this.saveSettings();
    this.ui && this.ui.syncSettingsControls(s);
  }

  /** CRITICAL FIX (Task 3): every music control mirrors the single player state. */
  _syncMusicButton() {
    const m = this.music;
    if (!m) return;
    const $ = (id) => document.getElementById(id);
    const t = m.track;
    const b = $('btn-pause-music');
    if (b) b.textContent = 'MUSIC: ' + (m.enabled ? (t ? t.name : '—') : 'OFF') + ' ▸';
    const st = $('music-status'); if (st && st.textContent !== m.statusText()) st.textContent = m.statusText();
    const pl = $('btn-music-play'); if (pl) { pl.textContent = m.playLabel(); pl.disabled = !m.enabled; pl.setAttribute('aria-label', m.playLabel().replace(/[^A-Z ]/g, '').trim() + ' MUSIC'); }
    const sh = $('btn-music-shuffle'); if (sh) { sh.textContent = 'SHUFFLE: ' + (m.shuffle ? 'ON' : 'OFF'); sh.setAttribute('aria-pressed', m.shuffle ? 'true' : 'false'); }
    const on = $('set-music-on'); if (on) on.checked = m.enabled;
    const sel = $('set-music-track');
    if (sel) {
      if (sel.options.length !== MUSIC_TRACKS.length) {
        const curVal = sel.value || m.trackId;
        sel.innerHTML = '';
        for (const t of MUSIC_TRACKS) {
          const opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = t.name;
          sel.appendChild(opt);
        }
        sel.value = curVal;
      }
      if (sel.value !== m.trackId) sel.value = m.trackId;
      for (const o of sel.options) {
        const tr = MUSIC_TRACKS.find(x => x.id === o.value);
        const want = tr ? tr.name + (m.failed.has(tr.id) ? ' — UNAVAILABLE' : '') : o.textContent;
        if (o.textContent !== want) o.textContent = want;
      }
    }
    const grp = $('music-settings'); if (grp) grp.classList.toggle('music-off', !m.enabled);
  }

  setActiveFov(fov) {
    if (Math.abs(fov - this._fovCurrent) > 0.02) {
      this._fovCurrent = fov;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  _onResize() {
    if (!this.renderer) return;
    const vv = window.visualViewport;
    const w = Math.max(320, vv ? Math.round(vv.width) : window.innerWidth);
    const h = Math.max(240, vv ? Math.round(vv.height) : window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.touch && this.touch.onResize) this.touch.onResize(w, h);
    if (this.tacmap && this.tacmap.open) this.tacmap.render2D();
    this._updateRotateOverlay();
  }

  /** Portrait gameplay on a touch phone is suboptimal — recommend landscape,
      but never trap the player: the overlay is dismissible per session and
      re-arms the next time they rotate back to portrait from landscape. */
  _updateRotateOverlay() {
    const el = document.getElementById('rotate-overlay');
    if (!el) return;
    const portrait = window.innerHeight > window.innerWidth;
    if (!portrait) this._rotateDismissed = false;      // re-arm for next portrait entry
    const show = !!this._touchPrimary && portrait && this.device && this.device.isPhone
      && this.state === GameState.PLAYING && !this._rotateDismissed;
    el.classList.toggle('hidden', !show);
  }

  /** Classify the device ONCE (capability detection, not UA alone). */
  _detectDevice() {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const touches = (navigator.maxTouchPoints || 0) > 0;
    const ua = navigator.userAgent || '';
    const isPhone = /iPhone|iPod|Android.+Mobile|Windows Phone/i.test(ua)
      || (coarse && Math.min(window.screen ? screen.width : 9999, window.screen ? screen.height : 9999) < 760);
    const isTablet = !isPhone && (/iPad|Android|Tablet|PlayBook/i.test(ua) || (coarse && touches));
    this.device = { coarse, touches, isPhone, isTablet, isDesktop: !coarse && !touches };
    const mode = this.settings.touchControls;
    this._touchPrimary = mode === 'on' ? true : mode === 'off' ? false : coarse;
    document.body.classList.toggle('touch-device', !!this._touchPrimary);
    document.body.classList.toggle('touch-on', !!this._touchPrimary);
    if (this.touch) this.touch.setEnabled(!!this._touchPrimary);
    this._maybeSuggestPerf();
  }

  /** One-shot, NON-BLOCKING performance suggestion — main menu only, auto-hides. */
  _maybeSuggestPerf() {
    try {
      if (this._perfSuggestDone) return;
      if (this.state !== GameState.MENU) return;
      const weak = (navigator.deviceMemory && navigator.deviceMemory <= 4)
        || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
      if (!this._touchPrimary || !weak || localStorage.getItem('obv_perf_suggested')
          || this.settings.perfMode || this.settings.quality === 'low') return;
      this._perfSuggestDone = true;
      const el = document.getElementById('perf-suggest');
      if (!el) return;
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('hidden'), 12000);   // never in the way for long
    } catch (e) { /* never block on detection */ }
  }

  // =========================================================================
  // Input
  // =========================================================================
  _bindInput() {
    // Idempotent on purpose. Every handler below is a *document*-level listener;
    // binding them twice would double-accumulate look deltas and double-count
    // fire presses. Repeated init must not be able to multiply the firing path.
    if (this._inputBound) { this._rebindCount = (this._rebindCount || 0) + 1; return; }
    this._inputBound = true;
    const inp = this.input;
    const holdMs = Number(this.settings && this.settings.autoHoldMs);
    this._fireInput = new FireTriggerInput({
      autoEngageS: (Number.isFinite(holdMs) && holdMs >= 0 ? holdMs : FIRE_INPUT.AUTO_ENGAGE_S * 1000) / 1000,
    });

    // CRITICAL FIX (music, autoplay policy): iOS Safari only honours a Web Audio unlock inside
    // touchend/click; the compatibility mousedown below is not guaranteed on every mobile browser.
    document.addEventListener('touchend', () => { if (!this.audio.ready) this._unlockAudioOnce(); }, { passive: true, capture: true });

    document.addEventListener('keydown', (e) => {
      this._unlockAudioOnce();
      if (e.repeat) {
        if (e.code === 'Space') e.preventDefault();
        return;
      }
      // Phase 15: dedicated ADS keyboard toggle (default X, user-remappable in
      // Settings). The weapons system owns the latch; this only queues the edge.
      // Keys that also map to other actions still fire the ADS toggle — the
      // Settings option list avoids assigned gameplay keys.
      if (e.code === (this.settings.adsKey || 'KeyX') && this.state === GameState.PLAYING && !this.vehicleMode) {
        inp.adsToggleRequested = true;
      }
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': inp._w = true; break;
        case 'KeyS': case 'ArrowDown': inp._s = true; break;
        case 'KeyA': case 'ArrowLeft': inp._a = true; break;
        case 'KeyD': case 'ArrowRight': inp._d = true; break;
        case 'ShiftLeft': case 'ShiftRight': inp._shiftKeyHeld = true; inp.sprint = true; break;
        case 'ControlLeft': case 'ControlRight':
          if (this.state === GameState.PLAYING) inp.crouch = !inp.crouch;
          e.preventDefault();
          break;
        case 'Space': inp.jumpPressed = true; inp._spaceKeyHeld = true; inp.spaceHeld = true; e.preventDefault(); break;
        case 'KeyQ': inp.wheelHeld = true; break;
        case 'KeyE': inp.leanR = true; break;
        case 'KeyZ': inp.leanL = true; break;
        case 'KeyC': inp.camPressed = true; break;
        case 'KeyR': inp.reloadPressed = true; break;
        case 'KeyB': if (this.state === GameState.PLAYING) inp.fireModePressed = true; break;
        case 'KeyG': inp.grenadePressed = true; break;
        case 'KeyN': inp.grenadeBackPressed = true; break;                       // Phase-14
        case 'KeyL': inp.abilityPressed = true; break;                           // Phase-14
        case 'KeyH': inp.bandageHeld = !this.vehicleMode; break;
        case 'KeyV':
          if (this.vehicleMode && this.vehicleMode.isHelicopter) inp._hoverKey = !inp._hoverKey;
          // CRITICAL FIX: tap = contextual (pick up / plant / raise), hold = stow
          else if (!this.vehicleMode && this.state === GameState.PLAYING && !e.repeat) this.shieldPressStart();
          break;
        case 'KeyT':
          if (this.vehicleMode && !this.vehicleMode.isHelicopter) this.vehicleMode.toggleHorn();
          else if (!this.vehicleMode && this.state === GameState.PLAYING) inp.flashlightPressed = true;   // Master upgrade P4
          break;
        case 'KeyY':
          if (this.state === GameState.PLAYING && !this.vehicleMode) inp._zoomKey = !inp._zoomKey; // observation zoom toggle, distinct from ADS
          break;
        case 'KeyK': if (this.state === GameState.PLAYING) inp.baseStrikePressed = true; break;   // Master upgrade P8
        case 'KeyM': inp.mapPressed = true; break;
        case 'KeyF':
          if (this.vehicleMode) {
            inp.interactPressed = true;
          } else if (this.interactTarget && this.state === GameState.PLAYING) {
            inp.interactPressed = true;
            inp.interactHeld = true;
          } else if (this.state === GameState.PLAYING) {
            inp.flashlightPressed = true;
          }
          break;
        case 'Digit1': inp.selectWeapon = 'primary'; break;
        case 'Digit2': inp.selectWeapon = 'secondary'; break;
        case 'Digit3': inp.selectWeapon = 'throwable'; break;
        case 'Digit4': inp.selectWeapon = 'utility'; break;
        case 'Escape':
          if (this.tacmap && this.tacmap.open) this.tacmap.close();
          else if (this.state === GameState.PLAYING) this.pause();
          else if (this.state === GameState.PAUSED) this.resume();
          break;
        default: break;
      }
    });

    document.addEventListener('keyup', (e) => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': inp._w = false; break;
        case 'KeyS': case 'ArrowDown': inp._s = false; break;
        case 'KeyA': case 'ArrowLeft': inp._a = false; break;
        case 'KeyD': case 'ArrowRight': inp._d = false; break;
        case 'ShiftLeft': case 'ShiftRight': inp._shiftKeyHeld = false; inp.sprint = false; break;
        case 'Space': inp.jumpPressed = false; inp._spaceKeyHeld = false; inp.spaceHeld = false; break;
        case 'KeyQ': inp.wheelHeld = false; break;
        case 'KeyE': inp.leanR = false; break;
        case 'KeyZ': inp.leanL = false; break;
        case 'KeyH': inp.bandageHeld = false; break;
        case 'KeyF': inp.interactHeld = false; inp.interactPressed = false; break;
        case 'KeyV': this.shieldPressEnd(); break;
        default: break;
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.renderer.domElement) return;
      const cap = 160; // ignore ridiculous spikes from high-rate mice
      this.input.lookX += THREE.MathUtils.clamp(e.movementX || 0, -cap, cap);
      this.input.lookY += THREE.MathUtils.clamp(e.movementY || 0, -cap, cap);
    });

    document.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest && e.target.closest('#weapon-mode, #touch-controls')) return;
      this._unlockAudioOnce();
      if (this.state !== GameState.PLAYING) return;
      // While the tactical map is open the cursor belongs to the map: panning,
      // wheel-zoom and marker selection must not re-grab pointer lock, and must
      // never reach the trigger. (v4.3: a click on the map used to request lock,
      // which hid the cursor and left the panel unusable.)
      if (this.tacmap && this.tacmap.open) return;
      if (!this._touchPrimary && document.pointerLockElement !== this.renderer.domElement) {
        this._requestLock();
        return;
      }
      if (e.button === 0) {
        this.input.mouse0 = true;
        // The discrete event the old pipeline never had: one press = one firing
        // event, whatever the weapon's fire mode. `mouse0` stays the physical
        // held-state that the rest of the game reads.
        this._fireInput.press('mouse', this.time);
      }
      if (e.button === 2) this.input.mouse2 = true;
      if (e.button === 1) { this.input._zoomMouse = true; e.preventDefault(); }   // Master upgrade P3: hold MMB to observe
    });

    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) { this.input.mouse0 = false; this._fireInput.release('mouse'); }
      if (e.button === 2) this.input.mouse2 = false;
      if (e.button === 1) this.input._zoomMouse = false;
    });

    document.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.renderer.domElement;
      this._locked = locked;
      if (!locked && this.state === GameState.PLAYING && !(this.tacmap && this.tacmap.open)) {
        // browser dropped the lock (ESC etc.) → pause rather than play blind
        // (the tactical map intentionally releases the lock while open)
        this.pause();
      }
    });
    document.addEventListener('pointerlockerror', () => {
      if (this.state === GameState.PLAYING) {
        this.ui.toastBrief('CLICK TO RE-CAPTURE MOUSE');
      }
    });
  }

  toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        const p = document.documentElement.requestFullscreen
          ? document.documentElement.requestFullscreen({ navigationUI: 'hide' }) : null;
        if (p && p.catch) p.catch(() => this.ui.toastBrief('FULLSCREEN UNAVAILABLE ON THIS DEVICE'));
      } else if (document.exitFullscreen) {
        const p = document.exitFullscreen();
        if (p && p.catch) p.catch(() => {});
      }
    } catch (e) { this.ui.toastBrief('FULLSCREEN UNAVAILABLE ON THIS DEVICE'); }
  }

  _requestLock() {
    if (this._touchPrimary) return;   // touch devices play without pointer lock
    const el = this.renderer.domElement;
    try {
      const p = el.requestPointerLock();
      if (p && p.catch) p.catch(() => { this.ui.toastBrief('POINTER LOCK FAILED — CLICK AGAIN'); });
    } catch (e) {
      this.ui.toastBrief('POINTER LOCK FAILED — CLICK AGAIN');
    }
  }

  _unlockAudioOnce() {
    if (!this.audio.ready) {
      if (this.audio.init()) {
        // Master upgrade P1-F2: the unlock only needs the audio volumes. The
        // previous full applySettings(true) re-sized the WebGL renderer,
        // reset pixel ratio and re-allocated shadow maps inside the player's
        // first keypress/click (measured first-input long task).
        const s = this.settings;
        this.audio.setVolumes(s.masterVolume, s.sfxVolume, s.ambVolume);
        if (this.audio.setMusicVolume) this.audio.setMusicVolume(s.musicVolume != null ? s.musicVolume : 0.45);
        if (this.music) this.music.onUnlock();   // CRITICAL FIX: start saved track after the first gesture (autoplay policy)
        if (this.world.map) this.audio.startAmbience(this.world.machinePositions);
      }
    } else {
      this.audio.resume();
    }
  }

  /** Aggregate raw key flags into movement axes each frame. */
  _pollInput() {
    const inp = this.input;
    const keyF = (inp._w ? 1 : 0) - (inp._s ? 1 : 0);
    const keyR = (inp._d ? 1 : 0) - (inp._a ? 1 : 0);
    // touch joysticks contribute analog axes through the SAME command object
    inp.moveF = THREE.MathUtils.clamp(keyF + (inp._touchF || 0), -1, 1);
    inp.moveR = THREE.MathUtils.clamp(keyR + (inp._touchR || 0), -1, 1);
    if (this.vehicleMode && this.vehicleMode.isHelicopter) {
      const keyboard = (inp._spaceKeyHeld ? 1 : 0) - (inp._shiftKeyHeld ? 1 : 0);
      inp.vehicleCollective = THREE.MathUtils.clamp(keyboard + (inp._touchVehicleCollective || 0), -1, 1);
      inp.vehicleHover = !!(inp._hoverKey || inp._touchVehicleHover);
    } else {
      inp.vehicleCollective = 0;
      inp.vehicleHover = false;
    }
  }

  // =========================================================================
  // UI wiring
  // =========================================================================
  _bindUI() {
    const click = (id, fn) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', () => {
        this.audio.init(); this.audio.resume(); this.audio.uiConfirm();
        fn();
      });
      el.addEventListener('mouseenter', () => { if (this.audio.ready) this.audio.uiHover(); });
    };
    const fireModeButton = document.getElementById('weapon-mode');
    if (fireModeButton) fireModeButton.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (this.state !== GameState.PLAYING || this.vehicleMode || this.handsMode !== 'gun') return;
      this.audio.init(); this.audio.resume(); this.audio.uiConfirm();
      this.input.fireModePressed = true;
    });

    click('btn-fullscreen', () => this.toggleFullscreen());
    click('btn-exit', () => {                                                    // Phase 16: honest exit control
      try { window.close(); } catch (_) {}
      const lab = document.getElementById('btn-exit-label');
      setTimeout(() => {
        if (!lab) return;                                                        // still alive: browser blocked close()
        lab.textContent = 'CLOSE THE TAB TO EXIT';
        setTimeout(() => { lab.textContent = 'EXIT'; }, 2600);
      }, 250);
    });
    click('btn-pause-objectives', () => { this.ui.buildObjectivesPanel(); this.ui.showScreen('objectives'); });
    click('btn-objectives-back', () => this.ui.showScreen('pause'));
    click('btn-pause-map', () => { this.resume(); this.tacmap.toggle(); });
    click('btn-pause-equipment', () => { this.ui.buildEquipmentPanel(); this.ui.showScreen('objectives'); });
    const perfApply = document.getElementById('btn-perf-apply');
    if (perfApply) perfApply.addEventListener('click', () => {
      this.settings.perfMode = true; this.saveSettings(); this.applySettings();
      document.getElementById('perf-suggest').classList.add('hidden');
      try { localStorage.setItem('obv_perf_suggested', '1'); } catch (e) { /* ignore */ }
      this.ui.syncSettingsControls(this.settings);
    });
    const perfDismiss = document.getElementById('btn-perf-dismiss');
    if (perfDismiss) perfDismiss.addEventListener('click', () => {
      document.getElementById('perf-suggest').classList.add('hidden');
      try { localStorage.setItem('obv_perf_suggested', '1'); } catch (e) { /* ignore */ }
    });
    click('btn-select-back', () => { this.ui.refreshMenuBadges(); this.ui.showScreen('menu'); });
    click('btn-mission-facility', () => this.ui.showBrief('facility', 'select'));
    click('btn-mission-snow', () => this.ui.showBrief('snow', 'select'));
    click('btn-mission-desert', () => this.ui.showBrief('desert', 'select'));
    click('btn-mission-urban', () => this.ui.showBrief('urban', 'select'));
    click('btn-mission-recon_desert', () => this.ui.showBrief('recon_desert', 'select'));
    click('btn-mission-sabotage_industrial', () => this.ui.showBrief('sabotage_industrial', 'select'));
    click('btn-mission-investigate_rural', () => this.ui.showBrief('investigate_rural', 'select'));
    click('btn-mission-rescue_rural', () => this.ui.showBrief('rescue_rural', 'select'));
    click('btn-mission-defense_urban', () => this.ui.showBrief('defense_urban', 'select'));
    click('btn-mission-hold_snow', () => this.ui.showBrief('hold_snow', 'select'));
    click('btn-brief-start', () => {
      // Phase-14: armory-equipped roster weapon rides into the corresponding
      // loadout slot (source of truth: progress.equippedWeaponId). Locked
      // selections were already filtered out of the pickers, so this can only
      // substitute something the operator legitimately owns.
      if (this.progress && this.loadout) {
        const eqId = this.progress.equippedWeaponId;
        if (eqId && this.progress.weaponUnlocked(eqId)) {
          const def = WEAPON_DEFS[eqId];
          if (def) {
            this.loadout.set(def.sidearm ? 'secondary' : 'primary', eqId);
            this.loadout.save();
          }
        }
      }
      if (this.ui._briefId) this.startMission(this.ui._briefId);
    });
    click('btn-brief-back', () => { this.ui.refreshMenuBadges(); this.ui.showScreen(this.ui._briefOrigin || 'select'); });
    click('btn-brief-loadout', () => this.ui.showScreen('select'));
    click('btn-training', () => this.ui.showTutorial('menu'));
    click('btn-tutorial-prev', () => this.ui.previousTutorialStep());
    click('btn-tutorial-next', () => this.ui.nextTutorialStep());
    click('btn-tutorial-range', () => this.startMission('range'));
    click('btn-tutorial-back', () => this.ui.closeTutorial());

    click('btn-rotate-continue', () => { this._rotateDismissed = true; this._updateRotateOverlay(); });
    click('btn-nav-deploy', () => { this.ui.syncSelectScreen(); this.ui.showScreen('select'); });           // Phase 16: DEPLOY = select theater + kit
    click('btn-select-all-ops', () => { this.ui.buildMissionsList(); this.ui.showScreen('missions'); });
    click('btn-missions', () => { this.ui.buildMissionsList(); this.ui.showScreen('missions'); });
    click('btn-missions-back', () => { this.ui.refreshMenuBadges(); this.ui.showScreen('menu'); });
    click('btn-fieldload', () => { this.ui.syncSelectScreen(); this.ui.showScreen('select'); });        // Phase 15: FIELD LOADOUT entry (pre-deploy gear)
    click('btn-armory', () => { this.ui.bindArmoryTabs(); this.ui.buildArmoryPanel(); this.ui.showScreen('armory'); });
    click('btn-armory-ops', () => { this.ui.bindArmoryTabs(); this.ui.openArmory('operators'); });  // Phase 15: ARMORY → OPERATORS deep entry
    click('btn-armory-back', () => this.ui.showScreen('menu'));
    click('btn-loadout', () => { this.ui.buildLoadoutList(); this.ui.showScreen('loadout'); });
    click('btn-loadout-back', () => this.ui.showScreen('menu'));
    click('btn-intel', () => { this.ui.buildIntelList(); this.ui.showScreen('intel'); });
    click('btn-intel-back', () => this.ui.showScreen('menu'));
    click('btn-awards', () => { this.ui.buildAwardsList(); this.ui.showScreen('awards'); });
    click('btn-awards-back', () => this.ui.showScreen('menu'));
    click('btn-stats', () => { this.ui.buildStatsList(); this.ui.showScreen('stats'); });
    click('btn-stats-back', () => this.ui.showScreen('menu'));
    click('btn-complete-retry', () => this.startMission(this._lastMission));
    click('btn-complete-next', () => {
      const next = MISSION_ORDER[MISSION_ORDER.indexOf(this._lastMission) + 1];
      if (next && this.progress.isMissionUnlocked(next)) this.startMission(next);
      else this.abortToMenu();
    });
    const diffSel = document.getElementById('set-difficulty');
    if (diffSel) diffSel.addEventListener('change', (e) => {
      this.progress.setDifficulty(e.target.value);
      this.ui.syncDifficultyControl();
    });
    click('btn-settings', () => { this.ui.syncSettingsControls(this.settings); this.ui.showScreen('settings'); });
    click('btn-credits', () => { this.ui.showScreen('credits'); });
    click('btn-settings-back', () => {
      const confirmBox = document.getElementById('reset-confirm-box');
      if (confirmBox) confirmBox.classList.add('hidden');
      if (this.state === GameState.PAUSED) this.ui.showScreen('pause');
      else this.ui.showScreen('menu');
    });

    // Tactical Settings Tabs switching
    document.querySelectorAll('.set-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        if (this.audio && this.audio.ready) this.audio.uiConfirm();
        const targetId = tab.dataset.tab;
        document.querySelectorAll('.set-tab').forEach(t => {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });
        document.querySelectorAll('.settings-tab-pane').forEach(p => {
          p.classList.add('hidden');
          p.classList.remove('active');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        const pane = document.getElementById(targetId);
        if (pane) {
          pane.classList.remove('hidden');
          pane.classList.add('active');
        }
      });
    });

    // Display tab fullscreen toggle
    click('btn-fullscreen-toggle', () => this.toggleFullscreen());

    // Reset settings to defaults handler with confirmation modal
    const resetBtn = document.getElementById('btn-settings-reset');
    const confirmBox = document.getElementById('reset-confirm-box');
    if (resetBtn && confirmBox) {
      resetBtn.addEventListener('click', () => {
        confirmBox.classList.remove('hidden');
        if (this.audio && this.audio.ready) this.audio.uiConfirm();
      });
    }
    click('btn-reset-cancel', () => {
      if (confirmBox) confirmBox.classList.add('hidden');
    });
    click('btn-reset-confirm', () => {
      if (confirmBox) confirmBox.classList.add('hidden');
      this.settings = { ...DEFAULT_SETTINGS };
      this.applySettings();
      this.saveSettings();
      this.ui.syncSettingsControls(this.settings);
      this.ui.toastBrief('SETTINGS RESTORED TO FACTORY DEFAULTS');
      if (this.audio && this.audio.ready) this.audio.uiConfirm();
    });
    click('btn-customize-hud', () => {
      if (!this.touch) return;
      this.touch.beginCustomization();   // Phase-13: opens the dedicated editor screen
    });
    click('btn-credits-back', () => this.ui.showScreen('menu'));

    click('btn-resume', () => this.resume());
    // Master upgrade: one-tap music cycle + base strike from the pause menu
    click('btn-pause-music', () => { this._unlockAudioOnce(); if (!this.music.enabled) this.music.setEnabled(true); else this.music.next(false); this.saveSettings(); this._syncMusicButton(); });
    click('btn-pause-strike', () => { this.input.baseStrikePressed = true; this.resume(); });
    click('btn-pause-settings', () => { this.ui.settingsReturnTo = 'pause'; this.ui.syncSettingsControls(this.settings); this.ui.showScreen('settings'); });
    click('btn-restart-cp', () => this.restartFromCheckpoint());
    click('btn-restart-mission', () => this.startMission(this.missions.missionId || 'facility'));
    click('btn-quit', () => this.abortToMenu());

    click('btn-death-cp', () => this.restartFromCheckpoint());
    click('btn-death-mission', () => this.startMission(this.missions.missionId || 'facility'));
    click('btn-death-menu', () => this.abortToMenu());

    click('btn-failed-cp', () => this.restartFromCheckpoint());
    click('btn-failed-mission', () => this.startMission(this.missions.missionId || 'facility'));
    click('btn-failed-menu', () => this.abortToMenu());

    click('btn-complete-menu', () => this.abortToMenu());

    // tactical map controls + HUD map button
    click('hud-mapbtn', () => this.tacmap.toggle());
    // v4.4: the map's own toolbar (zoom, fit, rotate, follow, layers, route, float,
    // close) is bound inside TacticalMap._bindControls. Bind nothing here: two
    // handlers on one button double every press - the same class of defect that made
    // a single click fire three shots. tests/browser_map_tests.mjs asserts one
    // listener per control in a real browser.

    // mini-map settings
    const mmOn = document.getElementById('set-minimap');
    if (mmOn) mmOn.addEventListener('change', e => { this.settings.minimapOn = e.target.checked; this.saveSettings(); });
    const mmSize = document.getElementById('set-minimap-size');
    if (mmSize) mmSize.addEventListener('change', e => { this.settings.minimapSize = e.target.value; this.saveSettings(); });
    const mmRot = document.getElementById('set-minimap-rotate');
    if (mmRot) mmRot.addEventListener('change', e => { this.settings.minimapRotate = e.target.value; this.saveSettings(); });

    // settings controls
    const bindRange = (id, valId, key, fmt, live) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        this.settings[key] = v;
        const valEl = document.getElementById(valId);
        if (valEl) valEl.textContent = fmt(v);
        if (live) live(v);
        this.saveSettings();
      });
    };
    bindRange('set-sens', 'val-sens', 'sensitivity', v => v.toFixed(2));
    bindRange('set-fov', 'val-fov', 'fov', v => String(v | 0), () => this.applySettings());
    bindRange('set-master', 'val-master', 'masterVolume', volPct, v => this.audio.setVolumes(v, this.settings.sfxVolume, this.settings.ambVolume));
    bindRange('set-sfx', 'val-sfx', 'sfxVolume', volPct, v => this.audio.setVolumes(this.settings.masterVolume, v, this.settings.ambVolume));
    bindRange('set-amb', 'val-amb', 'ambVolume', volPct, v => this.audio.setVolumes(this.settings.masterVolume, this.settings.sfxVolume, v));
    bindRange('set-minimap-opacity', 'val-minimap-opacity', 'minimapOpacity', v => v.toFixed(2));
    // Master upgrade P3/P6 settings (persisted through the existing settings store)
    bindRange('set-music-vol', 'val-music-vol', 'musicVolume', volPct, v => this.music.setVolume(v));
    bindRange('set-ads-mag', 'val-ads-mag', 'adsMag', v => v.toFixed(2) + '×');
    bindRange('set-zoom-mag', 'val-zoom-mag', 'zoomMag', v => v.toFixed(2) + '×');
    // CRITICAL FIX (Task 3): music section — choosing a track plays it (if music is on)
    const mt = document.getElementById('set-music-track');
    if (mt) mt.addEventListener('change', e => { this._unlockAudioOnce(); this.music.select(e.target.value, { play: this.music.enabled }); this.saveSettings(); });
    const mOn = document.getElementById('set-music-on');
    if (mOn) mOn.addEventListener('change', e => { this._unlockAudioOnce(); this.music.setEnabled(e.target.checked); this.saveSettings(); });
    click('btn-music-play', () => {
      const m = this.music;
      this._unlockAudioOnce();
      // the same gesture may already have auto-started the saved track (mousedown
      // → unlock → onUnlock) — don't immediately pause what PLAY just started
      if (m.playing && performance.now() - (m._autoStartAt || 0) < 1500) return;
      m.toggle(); this.saveSettings();
    });
    click('btn-music-next', () => { this._unlockAudioOnce(); this.music.next(false); this.saveSettings(); });
    click('btn-music-prev', () => { this._unlockAudioOnce(); this.music.prev(); this.saveSettings(); });
    click('btn-music-shuffle', () => { this.music.setShuffle(!this.music.shuffle); this.saveSettings(); });
    bindRange('set-veh-sens', 'val-veh-sens', 'vehSteerSens', v => v.toFixed(2));
    bindRange('set-veh-cam', 'val-veh-cam', 'vehCamDist', v => v.toFixed(2));
    const vInv = document.getElementById('set-veh-invert');
    if (vInv) vInv.addEventListener('change', e => { this.settings.vehSteerInvert = e.target.checked; this.saveSettings(); });

    // touch controls + accessibility (Stage D)
    const bindSelect = (id, key, after) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', e => {
        this.settings[key] = e.target.value; this.saveSettings();
        if (after) after(e.target.value);
      });
    };
    const bindCheck = (id, key, after) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', e => {
        this.settings[key] = e.target.checked; this.saveSettings(); this.applySettings();
        if (after) after(e.target.checked);
      });
    };
    bindSelect('set-touch-mode', 'touchControls', () => { this._detectDevice(); });
    const handLayout = document.getElementById('set-handed-layout');
    if (handLayout) handLayout.addEventListener('change', (e) => {
      this.settings.leftHanded = e.target.value === 'left';
      this.saveSettings(); this.applySettings();
    });
    bindCheck('set-mobile-hud-compass', 'mobileHudCompass');
    bindCheck('set-mobile-hud-objective', 'mobileHudObjective');
    bindCheck('set-mobile-hud-vitals', 'mobileHudVitals');
    bindCheck('set-mobile-hud-ammo', 'mobileHudAmmo');
    const syncTouchLayout = () => {
      const root = document.documentElement.style;
      root.setProperty('--touch-scale', String(this.settings.btnSize != null ? this.settings.btnSize : 1));
      root.setProperty('--joy-scale', String(this.settings.joySize != null ? this.settings.joySize : 1));
      root.setProperty('--joy-op', String(this.settings.joyOpacity != null ? this.settings.joyOpacity : 0.55));
      root.setProperty('--btn-op', String(this.settings.btnOpacity != null ? this.settings.btnOpacity : 0.8));
      root.setProperty('--hud-scale', String(this.settings.hudScale != null ? this.settings.hudScale : 1));
      root.setProperty('--look-scale', String(this.settings.lookStickSize != null ? this.settings.lookStickSize : 1));
      if (this.touch) this.touch.applySettings();
    };
    bindRange('set-joy-size', 'val-joy-size', 'joySize', v => v.toFixed(2), syncTouchLayout);
    bindRange('set-look-stick-size', 'val-look-stick-size', 'lookStickSize', v => v.toFixed(2), syncTouchLayout);
    bindRange('set-joy-opacity', 'val-joy-opacity', 'joyOpacity', v => v.toFixed(2), syncTouchLayout);
    bindRange('set-look-sens', 'val-look-sens', 'lookSens', v => v.toFixed(2));
    bindRange('set-aim-sens', 'val-aim-sens', 'aimSens', v => v.toFixed(2));
    bindRange('set-btn-size', 'val-btn-size', 'btnSize', v => v.toFixed(2), syncTouchLayout);
    bindRange('set-btn-opacity', 'val-btn-opacity', 'btnOpacity', v => v.toFixed(2), syncTouchLayout);
    bindRange('set-hud-scale', 'val-hud-scale', 'hudScale', v => v.toFixed(2), syncTouchLayout);
    bindRange('set-shake', 'val-shake', 'shakeScale', v => v.toFixed(2));
    bindCheck('set-invert-y', 'invertY');
    bindCheck('set-auto-sprint', 'autoSprint');
    bindCheck('set-auto-fire', 'autoFire');
    bindCheck('set-vibration', 'vibration');
    bindSelect('set-aim-mode', 'aimMode', () => this.touch && this.touch.applySettings());
    bindSelect('set-ads-key', 'adsKey');
    bindSelect('set-aim-assist', 'aimAssist');
    bindCheck('set-contrast', 'highContrast');
    bindCheck('set-large-text', 'largeText');
    bindCheck('set-reduce-motion', 'reduceMotion');
    bindCheck('set-subtitles', 'subtitles');
    document.getElementById('set-quality').addEventListener('change', (e) => {
      this.settings.quality = e.target.value;
      this.saveSettings();
      this.applySettings();
    });
    document.getElementById('set-perf').addEventListener('change', (e) => {
      this.settings.perfMode = e.target.checked;
      this.saveSettings();
      this.applySettings();
    });
    document.getElementById('set-daymode').addEventListener('change', (e) => {
      this.settings.dayMode = e.target.checked;
      this.saveSettings();
      this.applySettings();
    });
  }

  // =========================================================================
  // State machine
  // =========================================================================
  setState(s) {
    if (s === GameState.MENU && this.ui) { this.ui.refreshMenuBadges(); this.ui.syncDifficultyControl(); }
    const prev = this.state;
    if (prev === s) return;
    this.state = s;
    this._updateRotateOverlay();

    switch (s) {
      case GameState.MENU:
        this.ui.showScreen('menu');
        if (this.ui.buildLobby) this.ui.buildLobby();
        this._maybeSuggestPerf();
        break;
      case GameState.LOADING:
        this.ui.showScreen('loading');
        break;
      case GameState.PLAYING:
        this.ui.hideAll();
        this.ui.hud.classList.remove('hidden');
        break;
      case GameState.PAUSED:
        this.ui.showScreen('pause');
        document.getElementById('btn-restart-cp').style.display = this.missions.hasCheckpoint ? '' : 'none';
        break;
      case GameState.DEAD:
        break; // death screen shown by onPlayerDeath (needs cause)
      case GameState.COMPLETE:
        break; // shown by missionComplete
      case GameState.FAILED:
        break; // shown by missionFailed
      default: break;
    }
  }

  pause() {
    if (this.state !== GameState.PLAYING) return;
    this.setState(GameState.PAUSED);
    if (document.pointerLockElement) document.exitPointerLock();
    this.input.mouse0 = false; this.input.mouse2 = false;
    this.weapons.blockTriggerUntilRelease();
    this._fireInput && this._fireInput.reset();
    this.weapons.cancelAds();                    // Phase-14/15: pause cancels latched ADS (mouse + keyboard)
    this.weapons.cancelZoom();                   // Master upgrade P3
    this.wheelActive = false;
    this.ui.hideEqWheel();
    this.characters.cancel('pause');        // Phase-14: active effects end on pause (cooldown state persists)
    this._syncMusicButton();
    this.audio.suspend();
  }

  resume() {
    if (this.state !== GameState.PAUSED) return;
    this.audio.resume();
    this.setState(GameState.PLAYING);
    this._requestLock();
    // zero accumulated look deltas so the resume click doesn't jerk the view
    this.input.lookX = 0; this.input.lookY = 0;
  }

  // =========================================================================
  // Mission lifecycle
  // =========================================================================
  async startMission(id, checkpoint = null) {
    if (this.state === GameState.LOADING) return;
    const validId = id === 'range' || MISSION_ORDER.includes(id);
    const def = id === 'range' ? null : MISSION_DEFS[id];
    if (!validId || (id !== 'range' && !def)) {
      if (this.ui && this.ui.toast) this.ui.toast('MISSION UNAVAILABLE', 'SELECT A VALID CAMPAIGN OPERATION');
      return;
    }
    if (id !== 'range' && !this.progress.isMissionUnlocked(id)) {
      if (this.ui && this.ui.toast) this.ui.toast('MISSION LOCKED', 'COMPLETE THE PREVIOUS OPERATION FIRST');
      return;
    }
    // Phase-14: programmatic starts (tests, refs) get the same armory-
    // equipped slot substitution as the briefing START button.
    if (this.progress && this.loadout) {
      const eqId = this.progress.equippedWeaponId;
      if (eqId && this.progress.weaponUnlocked(eqId)) {
        const def = WEAPON_DEFS[eqId];
        if (def) { this.loadout.set(def.sidearm ? 'secondary' : 'primary', eqId); this.loadout.save(); }
      }
    }
    this._missionCompletionCommitted = false;
    this.setState(GameState.LOADING);
    this.ui.setLoading(0.05, 'DEPLOYING…', id);
    await raf(60);

    // tear down any previous mission
    this._teardownMission();

    this.ui.setLoading(0.15, 'GENERATING TERRAIN…', id);
    await raf();

    this.stats = { kills: 0, shots: 0, hits: 0, headshots: 0, missionTime: 0, dataSecured: false, damageTaken: 0, alarm: false, checkpointsUsed: 0, intelRun: 0, minHealth: 100, mapOpens: 0, equipCats: {}, usedVehicle: false, vehicleAbandoned: false, driveDist: 0, throwablesUsed: 0 };
    this.physics.clear();
    this.world.terminalUsed = false;

    this.ui.setLoading(0.35, def ? `CONSTRUCTING ${def.title}…` : 'BUILDING RANGE…', id);
    await raf();
    // Field supplies are a property of the operation, not of the layout: the
    // budget scales with how many hostiles the mission throws at you, and the
    // placer refuses any spot that is not clear on the finished map.
    const planIndex = MISSION_ORDER.indexOf(id);
    // Enemy target is a pure function of the authoritative campaign index.
    // Mission definition metadata and attempt/failure counters are not inputs.
    const campaignEnemyTarget = planIndex >= 0 ? getMissionMinEnemies(planIndex + 1) : 30;
    this.world._supplyPlan = (def && planIndex >= 0) ? {
      missionNumber: planIndex + 1,
      minEnemies: campaignEnemyTarget,
      near: def.spawnPos || [0, 0],
    } : null;
    this.world.buildByMap(def ? def.map : 'range', this.scene, this.physics);
    this.noiseMask = { rain: 0.72, snow: 0.88, dust: 0.94, fog: 1 }[this.world.weather] || 1;
    this._worldEvT = 35 + Math.random() * 45;
    this.tacmap.reset();

    this.ui.setLoading(0.6, 'DEPLOYING UNITS…', id);
    await raf();
    // Rigged soldiers: wait (bounded) for the shared asset; on timeout or
    // failure the mission continues with the procedural soldiers.
    if (soldierAssetStatus().status === 'loading') await awaitSoldierAsset(8000);
    this.enemies.reset();
    const missionIndex = MISSION_ORDER.indexOf(id);
    const spawnLimit = id === 'range' ? 30 : getMissionMinEnemies(missionIndex + 1);
    this.enemies.beginMissionRun(id, spawnLimit);
    this.enemies.group.clear();
    if (id !== 'range') {
      this.enemies.spawnInitial(id, def);
      this.enemies.spawnNPCs();
    }
    // Master upgrade P8: designate the enemy base (real destructible structures)
    try { this.baseStrike.setupForMission(id); } catch (e) { console.warn('base strike setup failed', e); }
    this.vehicleMode = null;
    this.vehicles.reset();
    this.vehicles.spawnFromWorld();
    this.ui.hideVehicleHUD();

    this.ui.setLoading(0.75, 'CALIBRATING WEAPONS…', id);
    await raf();
    this.weapons.reset(id === 'range');
    if (id === 'range') {
      for (const wid of WEAPON_ORDER) {
        if (wid === 'vx4') {
          // The training range may supply generous ammunition for other kits,
          // but the continuous-feed VX-4 remains a finite 300-round weapon.
          this.weapons.state.vx4.mag = 300;
          this.weapons.state.vx4.reserve = 0;
          continue;
        }
        if (wid === 'lb9' && !this.progress.weaponUnlocked('lb9')) {
          this.weapons.state.lb9.freeAllowance = 100;
          this.weapons.state.lb9.mag = 5;
          this.weapons.state.lb9.reserve = 95;
        } else {
          this.weapons.state[wid].reserve = 9999;
          if (wid === 'lb9') this.weapons.state.lb9.freeAllowance = null;
        }
      }
      this.throwables.reset({ throwable: 'vxfrag', throwableCount: 3, utility: 'medkit', utilityCount: 2 });
    } else {
      if (this.loadout.validate()) {   // invalid stored loadout → fall back to defaults
        Object.assign(this.loadout, { primary: 'vx4', secondary: 'p9', throwable: 'vxfrag', throwableCount: 2, utility: 'medkit', utilityCount: 1 });
        this.loadout.save();
      }
      // Phase-14: a locked armory selection never reaches the field — swap the
      // locked slot to the starting weapon, keep the operator's other choices.
      const lokP = !CAMPAIGN_ONLY.includes(this.loadout.primary) && !this.progress.weaponUnlocked(this.loadout.primary);
      const lokS = !CAMPAIGN_ONLY.includes(this.loadout.secondary) && !this.progress.weaponUnlocked(this.loadout.secondary);
      if (lokP || lokS) {
        if (lokP) this.loadout.primary = 'vx4';
        if (lokS) this.loadout.secondary = 'p9';
        this.loadout.save();
      }
      const loc = this.loadout.current();
      this.weapons.applyLoadout(loc.primary, loc.secondary);
      this.throwables.reset(loc);
    }
    this.handsMode = 'gun';
    this.wheelActive = false;
    this.ui.hideEqWheel();
    this.player.reset(this.world.spawnPoint, this.world.spawnYaw);
    if (this.body && this.body.built) {
      this.body.setVisible(true);
      this.body.setThirdPerson(false);
      this.body.snug();          // avoid a one-frame lerp from the previous spawn
    }
    const diff = this.progress.difficulty;
    this.player.armor = diff.armor;
    this.player.bandageCdRate = diff.bandageCd;
    for (const ws of Object.values(this.weapons.state)) {
      if (ws.reserve > 1000) continue;
      ws.reserve = Math.max(0, Math.round(ws.reserve * diff.reserve));
    }
    this.weapons.applyFinish();
    this.particles.clear();
    this._clearGrenades();
    // Phase-14: per-mission operator + barrier lifecycle
    this.characters.select(this.progress.selectedCharacterId);
    this.characters.reset();
    this.shield.reset();
    this.flashlight.reset();
    this.weapons.cancelZoom();

    this.ui.setLoading(0.9, 'SYNCING OBJECTIVES…', id);
    await raf();
    if (!checkpoint) MissionManager.clearStoredCheckpoint();
    this.missions.checkpointData = null;
    this.missions._wave2 = false;
    this.missions.start(id, checkpoint);
    if (this.missions.def && this.missions.def.setup) {
      try { this.missions.def.setup(this); } catch (e) { console.warn('mission setup failed', e); }
    }

    this.particles.setWeather(this.world.weather || null);
    this.audio.setWind(this.world.windLevel || 0);
    if (this.audio.ready) {
      this.audio.startAmbience(this.world.machinePositions);
      this.audio.setZone('open');
    }
    // Phase 17: adaptive resolution now RAMPS UP from the floor instead of
    // starting at full and stepping down after a burst of stalls — measured
    // evidence showed insertion-time raster+compile pressure peaks in the
    // first seconds on weak GPUs (SwiftShader: multi-minute first-frame
    // stalls at full res). Warm-up from 0.6 makes the first playable seconds
    // responsive on slow devices; fast GPUs climb to cap in ~8 ticks (~13 s).
    this._prScale = 0.6; this._frameEMA = 16.7; this._prT = 0;
    if (this.renderer) this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._prCap || 1) * this._prScale);
    this.applySettings();

    // Phase 08: pre-compile all shader programs while the splash is still
    // visible (KHR_parallel_shader_compile when the driver offers it) so the
    // first playable frame doesn't stall on a full program build storm.
    this.ui.setLoading(0.9, 'CALIBRATING OPTICS…', id);
    await raf();
    if (this.renderer) {
      try {
        if (this.renderer.compileAsync) await this.renderer.compileAsync(this.scene, this.camera);
        else this.renderer.compile(this.scene, this.camera);
      } catch (e) { /* driver support varies; first-frame compile is the safe fallback */ }
    }

    this.ui.setLoading(1, 'INSERTION COMPLETE — CLICK TO TAKE CONTROL', id);
    await raf(350);
    this.setState(GameState.PLAYING);
    this.music.begin();                     // Master upgrade P6 (no-op until audio is unlocked / track OFF)
    if (this.world) this.world._driveBatchBuckets();   // bake static merges one bucket/frame now
    this._requestLock();
    if (id === 'range') this.ui.toast('VEILSTRIKE', 'WEAPONS TRAINING — FIRE AT WILL');
    else if (checkpoint) this.ui.toast('CHECKPOINT', 'RESTORED — OBJECTIVE ACTIVE');
    else {
      const opBadge = missionIndex >= 0 ? `OP ${String(missionIndex + 1).padStart(3, '0')}/${MISSION_ORDER.length} · ` : '';
      this.ui.toast('VEILSTRIKE — ' + def.title, `${opBadge}${spawnLimit} HOSTILES IN SECTOR`);
    }
  }

  _teardownMission() {
    if (this.world.group) {
      this.world.dispose(this.scene);
    }
    this.enemies.reset();
    this.vehicles.reset();
    this.vehicleMode = null;
    this.throwables.clearField();
    this.characters.cancel('teardown');     // Phase-14: abilities never leak across missions
    this.shield.destroy('teardown');        // Phase-14: barrier leaves with the world
    this.baseStrike.reset();                // Master upgrade P8: cancel any strike in flight
    this.flashlight.reset();                // Master upgrade P4
    this.weapons.cancelZoom();              // Master upgrade P3
    this.music.end();                       // Master upgrade P6
    if (this.ui.clearKillFeed) this.ui.clearKillFeed();
    this.handsMode = 'gun';
    this.wheelActive = false;
    this.ui.hideEqWheel();
    if (this.audio.ready && this.audio.engineStop) this.audio.engineStop();
    this.particles.clear();
    this._clearGrenades();
    this.audio.stopAmbience();
    this.physics.clear();
    this.world.group = null;
    this.world.terminalUsed = false;
  }

  /** In-place reset back to the last checkpoint (fast — no world rebuild). */
  restartFromCheckpoint() {
    const cp = this.missions.checkpointData || MissionManager.loadStoredCheckpoint();
    if (!cp) { this.startMission(this.missions.missionId || 'facility'); return; }
    if (cp.mission && cp.mission !== this.missions.missionId) {
      this.startMission(cp.mission, cp);
      return;
    }

    // reset doors to their initial closed state
    for (const d of this.world.doors) {
      d.open = false; d.t = 0; d.moving = false;
      if (!d.slideUp) d.pivot.rotation.y = d.rotY;
      else d.mesh.position.y = d.height / 2;
      d.colliderObj.enabled = true;
      const c = d._makeCollider();
      d.colliderObj.min.copy(c.min);
      d.colliderObj.max.copy(c.max);
    }
    // Reset the explicit Phase 7 prop whitelist on an in-place checkpoint retry.
    // Old checkpoint data has no destruction field, so the world state remains
    // additive and backward-compatible rather than requiring a save migration.
    if (this.world.resetDestructibles) this.world.resetDestructibles();
    // reset pickups
    for (const it of this.world.interactables) {
      if (it.reset) it.reset();
      else if (it.id !== 'terminal') it.used = false;
    }
    // reset enemies & effects
    this.enemies.reset({ preserveMissionRun: true });
    this.enemies.group.clear();
    const checkpointMissionIndex = MISSION_ORDER.indexOf(cp.mission);
    const checkpointEnemyTarget = checkpointMissionIndex >= 0
      ? getMissionMinEnemies(checkpointMissionIndex + 1) : 30;
    // A checkpoint retry is a fresh enemy-spawn attempt even though the map
    // is retained: reset its count, log, cap and staged queues from the same
    // campaign-index target as a full mission restart.
    this.enemies.beginMissionRun(cp.mission, checkpointEnemyTarget);
    this.enemies.spawnInitial(cp.mission, MISSION_DEFS[cp.mission]);
    this.enemies.spawnNPCs();
    this.vehicleMode = null;
    this.vehicles.reset();
    this.vehicles.spawnFromWorld();
    this.ui.hideVehicleHUD();
    this.particles.clear();
    this._clearGrenades();
    this.hackProgress = 0;
    this.hackTarget = null;

    this.stats.checkpointsUsed++;
    this.missions._wave2 = false;
    this.missions.checkpointData = cp;
    this.missions.start(cp.mission, cp);
    if (this.missions.def && this.missions.def.setup) {
      try { this.missions.def.setup(this); } catch (e) { console.warn('mission setup failed', e); }
    }
    this.player.restoreSnapshot(cp.player);
    if (cp.throwables) this.throwables.restoreInv(cp.throwables);
    else this.throwables.reset(this.loadout.current());
    this.throwables.clearField();
    this.handsMode = 'gun';
    this.weapons.rig.visible = true;
    this.ui.setThrowHighlight(null);
    // Phase-14: re-apply operator package after snapshot restore; barrier never
    // persists across a checkpoint restore (matches throwable field cleanup).
    this.characters.select(this.progress.selectedCharacterId);
    this.characters.reset();
    this.shield.reset();
    this.baseStrike.resetForCheckpoint();   // Master upgrade P8 (structures restored by resetDestructibles)
    this.flashlight.reset();
    this.weapons.cancelZoom();
    if (this.ui.clearKillFeed) this.ui.clearKillFeed();

    if (this.audio.ready) {
      this.audio.resume();
      this.audio.startAmbience(this.world.machinePositions);
    }
    this.setState(GameState.PLAYING);
    this.music.begin();
    this._requestLock();
    this.ui.toast('CHECKPOINT', 'RESTORED — OBJECTIVE ACTIVE');
  }

  missionComplete() {
    if (this.state !== GameState.PLAYING || this._missionCompletionCommitted) return false;
    const missionId = this.missions && this.missions.missionId;
    if (missionId === 'range') return false; // training never writes campaign progress
    const missionIndex = MISSION_ORDER.indexOf(missionId);
    if (missionIndex >= 0 && !this.missions.canCompleteExtraction()) {
      if (this.ui && this.ui.radio) this.ui.radio('EXTRACTION DENIED — COMPLETE THE REQUIRED OBJECTIVES FIRST');
      return false;
    }
    this._missionCompletionCommitted = true;
    this._clearVehicleMode();
    this.stats.dataSecured = this.world.terminalUsed;
    this.setState(GameState.COMPLETE);
    if (document.pointerLockElement) document.exitPointerLock();
    MissionManager.clearStoredCheckpoint();
    this.progress.save();
    this._lastMission = this.missions.missionId;
    const ctx = this.missions.missionRunContext(true);
    const result = this.progress.evaluateMission(ctx);
    this.ui.showDebrief(result, this.missions.def, ctx);
    this.audio.objectiveComplete();
    this.music.end();                       // Master upgrade P6
    return true;
  }

  missionFailed(reason) {
    if (this.state !== GameState.PLAYING) return;
    this._clearVehicleMode();
    this.progress.recordFailure(this.missions.missionId);
    this.music.end();                       // Master upgrade P6
    this.setState(GameState.FAILED);
    if (document.pointerLockElement) document.exitPointerLock();
    this.ui.showFailed(reason, !!this.missions.checkpointData);
  }

  onPlayerDeath(cause) {
    if (this.state !== GameState.PLAYING) return;
    this._clearVehicleMode();
    this.characters.cancel('death');        // Phase-14
    this.weapons.cancelZoom();              // Master upgrade P3
    this.flashlight.reset();                // Master upgrade P4
    this.music.end();                       // Master upgrade P6
    this.setState(GameState.DEAD);
    if (document.pointerLockElement) document.exitPointerLock();
    this.input.mouse0 = false;
    this._fireInput && this._fireInput.reset();
    this.weapons.rig.visible = false;
    // let the death cam play for a beat before the screen
    setTimeout(() => {
      if (this.state === GameState.DEAD) {
        this.ui.showDeath(
          cause === 'injuries' ? 'You succumbed to your injuries.' : 'You were eliminated by hostile fire.',
          !!this.missions.checkpointData
        );
      }
    }, 1400);
  }

  abortToMenu() {
    this.particles.setWeather(null);
    if (this.audio.ready) this.audio.setWind(0);
    this.setState(GameState.MENU);
    if (document.pointerLockElement) document.exitPointerLock();
    this._teardownMission();
    this.missions.missionId = null;
    this.missions.stage = null;
    this.audio.stopAmbience();
  }

  onAlarmRaised(force = false) {
    void force;
    this.stats.alarm = true;
  }

  // =========================================================================
  // Shared simulation hooks
  // =========================================================================
  emitNoise(pos, radius, kind, source = null, intensity = null) {
    if (radius <= 0) return;
    this.enemies.hearNoise(pos, radius * this.noiseMask, kind, source, intensity);
  }

  /** ambient world events: distant firefights, intercepted radio chatter */
  _worldEvent() {
    if (this.missions.missionId === 'range') return;
    const b = this.world.bounds || { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
    const a = Math.random() * Math.PI * 2;
    const d = 60 + Math.random() * 55;
    const px = THREE.MathUtils.clamp(this.player.pos.x + Math.cos(a) * d, b.minX + 4, b.maxX - 4);
    const pz = THREE.MathUtils.clamp(this.player.pos.z + Math.sin(a) * d, b.minZ + 4, b.maxZ - 4);
    if (Math.random() < 0.62) {
      const p = new THREE.Vector3(px, 1, pz);
      const n = 1 + Math.floor(Math.random() * 4);
      let t = 0;
      for (let i = 0; i < n; i++) { this.audio.gunshot('enemy_ar', p, { delay: t }); t += 0.12 + Math.random() * 0.35; }
    } else {
      const lines = {
        facility: 'RADIO (intercepted): "…conveyor two is jammed again — send the welder down…"',
        snow: 'RADIO (intercepted): "…relay goes dark at oh-three-hundred. Count your batteries…"',
        desert: 'RADIO (intercepted): "…sand in everything. The wadi route is hot — avoid it…"',
        urban: 'RADIO (intercepted): "…toll booths are closed. Nobody enters the district tonight…"',
        metro: 'RADIO (intercepted): "…northbound trains are suspended. Keep the civic ledger off the line…"',
        industrial: 'RADIO (intercepted): "…forge is running hot. Night shift stays clear of the hall…"',
        rural: 'RADIO (intercepted): "…livestock is spooked again. Check the fence line at dawn…"',
      };
      this.audio.radioSquelch(null);
      this.ui.radio(lines[this.world.map] || lines.facility);
    }
  }

  /** an intel document was picked up on the current map */
  onIntelPicked(map, idx, label) {
    let fresh = false;
    let healthRestored = 0;
    try {
      if (this.progress && this.progress.recordIntel) {
        fresh = !!this.progress.recordIntel(map, idx);
      }
      if (!this.stats) this.stats = {};
      if (fresh) this.stats.intelRun = (this.stats.intelRun || 0) + 1;

      // P0-D: Intel collection triggers damage recovery, restoring health up to max (100)
      if (this.player && this.player.alive && this.player.health > 0) {
        healthRestored = this.player.recoverHealth(100, 'INTEL');
      }

      if (this.audio && this.audio.pickup) {
        this.audio.pickup(this.player ? this.player.pos : null);
      }
      if (this.ui) {
        const healMsg = healthRestored > 0 ? ` · VITALITY RESTORED (+${Math.round(healthRestored)} HP)` : '';
        const msg = (fresh ? 'INTEL RECOVERED — ' : 'INTEL RETRIEVED — ') + (label || 'DOCUMENT') + healMsg;
        if (this.ui.radio) this.ui.radio(msg);
        else if (this.ui.toast) this.ui.toast('INTEL', msg);
        if (healthRestored > 0 && this.ui.toast) {
          this.ui.toast('DAMAGE RECOVERED', `VITALITY RESTORED TO ${Math.round(this.player.health)}%`);
        }
        if (this.ui.healthFill) {
          this.ui.healthFill.classList.add('flash');
          setTimeout(() => { if (this.ui && this.ui.healthFill) this.ui.healthFill.classList.remove('flash'); }, 400);
        }
      }
    } catch (e) {
      console.warn('[game] onIntelPicked error:', e);
    }
    return { fresh, healthRestored, finalHealth: this.player ? this.player.health : 0 };
  }

  spawnGrenade(pos, vel, type = 'vxfrag', owner = null) {
    this.grenades.push(new Grenade(this, pos, vel, type, owner));
    const marker = this._markers.find(m => !m.visible);
    if (marker) {
      marker.visible = true;
      marker.position.set(pos.x + vel.x * 0.9, 0.05, pos.z + vel.z * 0.9);
      marker.userData.t = 0;
    }
    this.audio.impact('metal', pos, 0.5);
  }

  /** Convenience wrapper kept for compatibility — routes through the throwable system. */
  spawnThrowable(pos, vel, type, owner = null) {
    this.spawnGrenade(pos, vel, type || 'vxfrag', owner);
  }

  throwPlayerGrenade() {
    this.throwables.throwCurrent(false);
  }

  // =========================================================================
  // Hands state machine (C3): gun / throwable / utility + equipment wheel
  // =========================================================================
  equipGun() {
    if (this.handsMode === 'gun') return;
    this.weapons.blockTriggerUntilRelease();
    this.handsMode = 'gun';
    this.weapons.rig.visible = !this.vehicleMode;
    this.ui.setThrowHighlight(null);
  }

  equipThrowable(id) {
    if (this.vehicleMode) return;
    if (id) { if (!this.throwables.select(id)) { this.ui.radio('NONE LEFT'); return; } }
    else if (!this.throwables.equipped || this.throwables.count(this.throwables.equipped) <= 0) {
      if (!this.throwables.cycle('throwable')) { this.ui.radio('NO THROWABLES LEFT'); return; }
    }
    this.weapons.cancelForEquipment();
    this.input.mouse0 = false; this.input.mouse2 = false; this._mouse2Was = false;
    this._fireInput && this._fireInput.reset();
    this.handsMode = 'throwable';
    this.weapons.rig.visible = false;
    this.stats.equipCats.throwable = true;
    this.ui.setThrowHighlight('throwable');
    this.ui.toastBrief(THROWABLE_DEFS[this.throwables.equipped].name + ' — LMB THROW · RMB SOFT TOSS · G CYCLE · 1 BACK TO GUN');
  }

  equipUtility(id) {
    if (this.vehicleMode) return;
    if (id) { if (!this.throwables.select(id)) { this.ui.radio('NONE LEFT'); return; } }
    else if (!this.throwables.utility || this.throwables.count(this.throwables.utility) <= 0) {
      if (!this.throwables.cycle('utility')) { this.ui.radio('NO UTILITY ITEMS LEFT'); return; }
    }
    this.weapons.cancelForEquipment();
    this.input.mouse0 = false; this.input.mouse2 = false; this._mouse2Was = false;
    this._fireInput && this._fireInput.reset();
    this.handsMode = 'utility';
    this.weapons.rig.visible = false;
    this.stats.equipCats.utility = true;
    this.ui.setThrowHighlight('utility');
    const d = THROWABLE_DEFS[this.throwables.utility];
    this.ui.toastBrief(d.name + (d.kind === 'place' ? ' — LMB PLACE · RMB DETONATE' : ' — LMB USE · 1 BACK TO GUN'));
  }

  _cycleHands() {
    if (this.vehicleMode) return;
    if (this.handsMode === 'gun') this.equipThrowable();
    else if (this.handsMode === 'throwable') {
      const id = this.throwables.cycle('throwable');
      if (id) this.ui.toastBrief(THROWABLE_DEFS[id].name + ' READY');
      else this.equipGun();
    } else {
      const id = this.throwables.cycle('utility');
      if (id) this.ui.toastBrief(THROWABLE_DEFS[id].name + ' READY');
      else this.equipGun();
    }
  }

  _selectSlot(slot) {
    if (slot === 'throwable') { this.equipThrowable(); return; }
    if (slot === 'utility') { this.equipUtility(); return; }
    const id = slot === 'secondary' ? this.loadout.secondary : this.loadout.primary;
    if (!id || !this.weapons.owned.has(id)) { this.ui.radio('NOT IN LOADOUT'); return; }
    this.equipGun();
    this.weapons.select(id);
  }

  _applyWheel(sel) {
    if (!sel) return;
    if (sel.cat === 'primary') { this.loadout.primary = sel.id; this.weapons.owned.add(sel.id); this.equipGun(); this.weapons.select(sel.id); this.stats.equipCats.primary = true; }
    else if (sel.cat === 'secondary') { this.loadout.secondary = sel.id; this.weapons.owned.add(sel.id); this.equipGun(); this.weapons.select(sel.id); this.stats.equipCats.secondary = true; }
    else if (sel.cat === 'throwable') this.equipThrowable(sel.id);
    else if (sel.cat === 'utility') this.equipUtility(sel.id);
    else if (sel.cat === 'mission') this.ui.toastBrief('MISSION GEAR IS ALWAYS CARRIED');
  }

  /** LMB/RMB while holding a throwable or utility item. */
  _handsFire(dt, inp) {
    this._throwCd -= dt;
    if (inp.mouse0 && this._throwCd <= 0) {
      this._throwCd = 0.5;
      this.throwables.throwCurrent(false);
    }
    if (inp.mouse2 && !this._mouse2Was) {
      this._throwCd = Math.max(this._throwCd, 0.35);
      this.throwables.altUse();
    }
    this._mouse2Was = inp.mouse2;
  }

  _blastPointForBox(box, anchor, out) {
    if (!box || !box.min || !box.max) return out.copy(anchor);
    return out.set(
      THREE.MathUtils.clamp(anchor.x, box.min.x, box.max.x),
      THREE.MathUtils.clamp(anchor.y, box.min.y, box.max.y),
      THREE.MathUtils.clamp(anchor.z, box.min.z, box.max.z),
    );
  }

  _blastFactor(origin, target, radius, ignoreColliderId = null) {
    const distance = origin.distanceTo(target);
    if (distance >= radius) return 0;
    const transmission = this._blastTransmission(origin, target, ignoreColliderId);
    return transmission > 0 ? Math.pow(1 - distance / radius, 1.35) * transmission : 0;
  }

  /** Ray-check an explosive path. Solid cover blocks pressure; breakable glass
   * is shattered once and transmits a reduced, not full-strength, blast. */
  _blastTransmission(origin, target, ignoreColliderId = null) {
    if (!this.physics || !this.physics.raycast) return 1;
    const delta = this._blastDelta.copy(target).sub(origin);
    const distance = delta.length();
    if (distance < 0.08) return 1;
    const dir = this._blastDir.copy(delta).multiplyScalar(1 / distance);
    this._blastIgnore.clear();
    if (ignoreColliderId != null) this._blastIgnore.add(ignoreColliderId);
    let transmission = 1;
    for (let pass = 0; pass < 5; pass++) {
      const hit = this.physics.raycast(origin, dir, Math.max(0, distance - 0.035), this._blastRayOpts);
      if (!hit) return transmission;
      const c = hit.collider;
      if (c && c.tag === 'glass' && c.breakable) {
        this._breakGlassFromBlast(c, hit.point, hit.normal);
        this._blastIgnore.add(c.id);
        transmission *= 0.62;
        if (transmission < 0.12) return 0;
        continue;
      }
      return 0;
    }
    return 0;
  }

  _breakGlassFromBlast(collider, point, normal) {
    if (!collider || !collider.breakable || !this.world || !this.world.breakGlass) return false;
    this.world.breakGlass(collider);
    if (this.particles && this.particles.glassBurst) this.particles.glassBurst(point, normal || _upTmp);
    if (this.audio && this.audio.impact) this.audio.impact('glass', point, 0.9);
    return true;
  }

  explodeAt(pos, options = {}) {
    const breach = options.type === 'breach' || options.type === 'brx' || !!options.forceDoors;
    const radius = Number.isFinite(options.radius) ? options.radius : breach ? 6.4 : 7.5;
    // Master upgrade P8: optional power scale (default 1 → every existing caller unchanged)
    const power = Number.isFinite(options.power) ? Math.max(0.1, Math.min(3, options.power)) : 1;
    const playerBase = (breach ? 78 : 92) * power;
    const enemyBase = (breach ? 112 : 135) * power;
    const vehicleBase = (breach ? 150 : 112) * power;
    const objectBase = (breach ? 190 : 150) * power;
    let surfacePoint = options.surfacePoint || null;
    let surfaceNormal = options.surfaceNormal || null;
    let surfaceMaterial = options.surfaceMaterial || null;

    // Find the actual nearby floor/prop surface for dust and the pooled scorch
    // decal. Airbursts remain volumetric and do not stamp a decal at y=0.
    if (!surfacePoint && this.physics && this.physics.raycast) {
      const origin = this._blastCenter.copy(pos).addScaledVector(_upTmp, 0.08);
      const maxDown = Math.min(6, Math.max(0.6, pos.y + 0.75));
      const hit = this.physics.raycast(origin, _downTmp, maxDown);
      if (hit) {
        surfacePoint = hit.point;
        surfaceNormal = hit.normal;
        surfaceMaterial = hit.collider.material || 'concrete';
      }
    }
    const fxNormal = surfaceNormal || _upTmp;
    if (this.particles) {
      if (this.particles.explosion) this.particles.explosion(pos, fxNormal, breach ? 1.0 : 1.15);
      else if (this.particles.muzzleFlash) this.particles.muzzleFlash(pos, fxNormal, true, breach ? 1 : 1.15);
      if (surfacePoint && this.particles.impact) this.particles.impact(surfacePoint, fxNormal, surfaceMaterial || 'concrete', breach ? 1.5 : 1.8);
      if (surfacePoint && this.particles.decals) this.particles.decals.spawn(surfacePoint, fxNormal, 'scorch', breach ? 1.2 : 1.5);
    }
    if (this.audio && this.audio.explosion) this.audio.explosion(pos);
    if (this.emitNoise) this.emitNoise(pos, breach ? 84 : 90, 'explosion', options.owner || options.source || null);

    // An explosive BR-X charge can force a door only if the charge has a clear
    // pressure path to that door. Ordinary fragmentation does not unlock doors.
    if (breach && this.world && this.world.doors) {
      const forceRadius = Math.min(radius, options.doorRadius || 5.6);
      for (const door of this.world.doors) {
        if (!door || !door.pos || (door.open && !door.locked)) continue;
        const angle = door.rotY || 0;
        this._blastCenter.set(
          door.pos.x + Math.cos(angle) * door.width * 0.5,
          door.pos.y + door.height * 0.5,
          door.pos.z - Math.sin(angle) * door.width * 0.5,
        );
        if (pos.distanceTo(this._blastCenter) >= forceRadius) continue;
        const transmission = this._blastTransmission(pos, this._blastCenter, door.colliderObj ? door.colliderObj.id : null);
        if (transmission > 0 && door.forceOpen) door.forceOpen(this, true);
      }
    }

    // Glass is stateful world geometry: break only panes actually reached by
    // this blast, and preserve their collision removal/debris path.
    if (this.world && this.world.glassPanes) {
      for (let i = this.world.glassPanes.length - 1; i >= 0; i--) {
        const pane = this.world.glassPanes[i];
        const c = pane && pane.collider;
        if (!c || !c.enabled || !c.breakable) continue;
        this._blastCenter.set((c.min.x + c.max.x) * 0.5, (c.min.y + c.max.y) * 0.5, (c.min.z + c.max.z) * 0.5);
        if (pos.distanceTo(this._blastCenter) >= radius * 0.92) continue;
        if (this._blastTransmission(pos, this._blastCenter, c.id) > 0) {
          const normal = this._blastDelta.copy(this._blastCenter).sub(pos).normalize();
          this._breakGlassFromBlast(c, this._blastCenter, normal);
        }
      }
    }

    // Phase-14: deployed barrier walls take real blast damage with the same
    // distance falloff as everything else — they are cover, not invulnerability.
    // Master upgrade P5: every standing wall (inventory may deploy several).
    // FINAL FIX 5: the pressure must actually REACH the wall — distance to the
    // wall's nearest face point (or centre), each sample LOS-checked with
    // _blastTransmission while ignoring only the wall's own collider. A wall
    // behind solid cover (or behind another wall) takes no blast damage.
    if (this.shield && this.shield.deployedColliders) {
      for (const sc of this.shield.deployedColliders()) {
        let wf = 0;
        this._blastPointForBox(sc, pos, this._blastPoint);
        this._blastCenter.set((sc.min.x + sc.max.x) / 2, (sc.min.y + sc.max.y) / 2, (sc.min.z + sc.max.z) / 2);
        for (const tp of [this._blastPoint, this._blastCenter]) {
          const sd = pos.distanceTo(tp);
          if (sd >= radius) continue;
          const tr = this._blastTransmission(pos, tp, sc.id);
          if (tr > 0) wf = Math.max(wf, (1 - sd / radius) * tr);
        }
        if (wf > 0) this.shield.onHit(sc, this._blastPoint.clone(), objectBase * wf);
      }
    }

    let playerFactor = 0;
    const playerBox = this.player && this.player.box;
    if (this.player && this.player.alive) {
      this._blastPointForBox(playerBox, pos, this._blastPoint);
      playerFactor = this._blastFactor(pos, this._blastPoint, radius);
      if (playerBox) {
        const p = this.player.pos;
        this._blastPoint2.set(
          THREE.MathUtils.clamp(p.x, playerBox.min.x, playerBox.max.x),
          THREE.MathUtils.clamp(p.y + 1.02, playerBox.min.y, playerBox.max.y),
          THREE.MathUtils.clamp(p.z, playerBox.min.z, playerBox.max.z),
        );
        playerFactor = Math.max(playerFactor, this._blastFactor(pos, this._blastPoint2, radius));
        this._blastPoint3.set(
          THREE.MathUtils.clamp(p.x, playerBox.min.x, playerBox.max.x),
          THREE.MathUtils.clamp(p.y + 1.55, playerBox.min.y, playerBox.max.y),
          THREE.MathUtils.clamp(p.z, playerBox.min.z, playerBox.max.z),
        );
        playerFactor = Math.max(playerFactor, this._blastFactor(pos, this._blastPoint3, radius));
      }
      if (playerFactor > 0.005) {
        // FINAL FIX 5: a raised (held) plate facing the blast intercepts part of
        // it ONCE; whatever exceeds its remaining HP passes through. Deployed
        // walls already block via the LOS rays above, so nothing double-counts.
        let blastDmg = playerBase * playerFactor;
        const cover = this.shield && this.shield.heldBlastCover ? this.shield.heldBlastCover(pos) : 0;
        if (cover > 0) blastDmg -= this.shield.absorbHeldBlast(blastDmg * cover, this._blastPoint2);
        this._lastBlast = { factor: playerFactor, raw: playerBase * playerFactor, cover, applied: blastDmg };
        if (blastDmg > 0.01) this.applyDamageToPlayer('torso', blastDmg, pos.clone());
        if (this.player.addSuppress) this.player.addSuppress(Math.min(0.9, 0.9 * playerFactor));
      }
    }
    const playerVehicleDamaged = !!(this.vehicleMode && playerFactor > 0.005);

    // Route all soldier damage through EnemyManager.damage so armor, hit state,
    // morale, death/corpse handling and mission kill counts remain authoritative.
    if (this.enemies && this.enemies.list) {
      for (const enemy of this.enemies.list) {
        if (!enemy.alive) continue;
        const box = enemy.box;
        this._blastPointForBox(box, pos, this._blastPoint);
        let factor = this._blastFactor(pos, this._blastPoint, radius);
        if (box) {
          this._blastPoint2.set(
            THREE.MathUtils.clamp(enemy.pos.x, box.min.x, box.max.x),
            THREE.MathUtils.clamp(enemy.pos.y + 0.98, box.min.y, box.max.y),
            THREE.MathUtils.clamp(enemy.pos.z, box.min.z, box.max.z),
          );
          factor = Math.max(factor, this._blastFactor(pos, this._blastPoint2, radius));
          this._blastPoint3.set(
            THREE.MathUtils.clamp(enemy.pos.x, box.min.x, box.max.x),
            THREE.MathUtils.clamp(enemy.pos.y + 1.58, box.min.y, box.max.y),
            THREE.MathUtils.clamp(enemy.pos.z, box.min.z, box.max.z),
          );
          factor = Math.max(factor, this._blastFactor(pos, this._blastPoint3, radius));
        }
        if (factor > 0.005) {
          this._blastDir.copy(enemy.pos).sub(pos).setY(0).normalize();
          this.enemies.damage(enemy, 'torso', enemyBase * factor, pos.clone(), this._blastDir);
        }
      }
    }

    // Vehicles use their existing health/state/effects path. When the player is
    // in a vehicle, applyDamageToPlayer already routes the exposed blast to it;
    // skip that same vehicle here to avoid double damage from one detonation.
    if (this.vehicles && this.vehicles.list) {
      for (const vehicle of this.vehicles.list) {
        if (!vehicle || vehicle.hp <= 0) continue;
        const box = vehicle.box;
        this._blastPointForBox(box, pos, this._blastPoint);
        let factor = this._blastFactor(pos, this._blastPoint, radius);
        if (box) {
          this._blastPoint2.set(
            THREE.MathUtils.clamp(vehicle.pos.x, box.min.x, box.max.x),
            THREE.MathUtils.clamp(vehicle.pos.y + (vehicle.def ? vehicle.def.h * 0.55 : 1), box.min.y, box.max.y),
            THREE.MathUtils.clamp(vehicle.pos.z, box.min.z, box.max.z),
          );
          factor = Math.max(factor, this._blastFactor(pos, this._blastPoint2, radius));
        }
        if (factor <= 0.005) continue;
        if (vehicle === this.vehicleMode && playerVehicleDamaged) continue;
        vehicle.damage(vehicleBase * factor, this, this._blastPoint.clone(), 'body');
      }
    }

    // Only a few authored industrial props are eligible. Their own collider is
    // excluded from the visibility ray; all other world cover remains intact.
    if (this.world && this.world.destructibles && this.world.damageDestructible) {
      for (const item of this.world.destructibles) {
        if (!item || item.destroyed || !item.collider) continue;
        this._blastPointForBox(item.collider, pos, this._blastPoint);
        const factor = this._blastFactor(pos, this._blastPoint, radius, item.collider.id);
        if (factor <= 0.005) continue;
        const incoming = this._blastDelta.copy(item.pos).sub(pos).normalize();
        this.world.damageDestructible(item, objectBase * factor, this, this._blastPoint, incoming);
      }
    }

    const playerDistance = this.player ? pos.distanceTo(this.player.pos) : radius;
    if (playerDistance < 16 && this.addShake) {
      const coverScale = playerFactor > 0 ? Math.max(0.18, playerFactor) : 0.18;
      this.addShake(Math.min(0.9, 0.85 * (1 - playerDistance / 16) * coverScale));
    }
  }

  _clearGrenades() {
    for (const gr of this.grenades) gr.dispose();
    this.grenades.length = 0;
    for (const m of this._markers) { m.visible = false; m.material.opacity = 0; }
    this.suppress = 0;
  }

  /**
   * Feedback for a solid-body impact (player ↔ soldier, vehicle ↔ soldier …).
   * Deliberately cheap and non-blocking: it never touches the simulation, only
   * presents the contact the physics layer already resolved.
   */
  onBodyImpact(actor, state, speed, severity) {
    if (!actor || this.state !== GameState.PLAYING) return;
    const s = Math.max(0, Math.min(1, severity != null ? severity : 0.4));
    const isPlayer = actor === this.player;
    const at = actor.pos;
    if (this.audio && this.audio.impact) this.audio.impact(isPlayer ? 'fabric' : 'concrete', at, 0.5 + s * 0.7);
    if (this.particles && this.particles.impact) {
      this.particles.impact(this._tmpV3 || (this._tmpV3 = new THREE.Vector3()).set(at.x, at.y + 0.9, at.z), new THREE.Vector3(0, 1, 0), 'concrete', 0.35 + s * 0.4);
    }
    if (isPlayer) {
      this.addShake(state === 'knocked_down' ? 0.55 + s * 0.35 : 0.18 + s * 0.2);
      if (state === 'knocked_down' && this.ui && this.ui.toastBrief) this.ui.toastBrief('KNOCKED DOWN');
      else if (state === 'staggered' && this.ui && this.ui.toastBrief && s > 0.5) this.ui.toastBrief('STAGGERED');
      if (this.ui && this.ui.playerDamaged && s > 0.55) this.ui.playerDamaged(0, null, at);
      return;
    }
    // a soldier going down under the operator's shoulder is worth a marker
    if (state === 'knocked_down' && actor.health != null) {
      this.stats.damageDealt = (this.stats.damageDealt || 0) + 0;
      if (this.ui && this.ui.hitMarker) this.ui.hitMarker(false);
      if (this.audio && this.audio.hitMarker) this.audio.hitMarker(false);
      this.emitNoise(at, 9, 'impact');
    }
  }

  addShake(amount) {
    this.shake = Math.min(1, this.shake + amount * (this.settings.shakeScale != null ? this.settings.shakeScale : 1));
  }

  // =========================================================================
  // Vehicles (C2)
  // =========================================================================
  /**
   * Driver's-door boarding gate. Returns true when a vehicle took over this
   * frame's [F] (either by boarding it or by showing the prompt), so the
   * generic interactable picker can never hand out a vehicle from the wrong
   * side of the hull or from an arbitrary distance.
   */
  _updateVehicleBoarding(inp) {
    if (!this.vehicles || !this.vehicles.list.length) return false;
    const q = this._boardingQuery || (this._boardingQuery = { vehicle: null, interactable: null, distance: Infinity, reason: '' });
    this.vehicles.boardingCandidate(this.player, q);
    const v = q.vehicle;
    if (!v) {
      if (q.reason && q.reason !== 'OCCUPIED' && q.reason !== 'WRECKED' && this.ui && this.ui.setInteract) {
        this.ui.setInteract(q.reason === 'AIRBORNE' ? 'LAND THE HELICOPTER TO BOARD' : q.reason === 'MOVING' ? 'STOP THE VEHICLE TO BOARD' : 'AT THE DOOR — OPEN ANGLE REQUIRED');
      }
      return false;
    }
    if (this.ui && this.ui.setInteract) this.ui.setInteract('PRESS [F] — ENTER VEHICLE');
    this.interactTarget = q.interactable || null;
    if (inp.interactPressed) {
      inp.interactPressed = false;
      this.enterVehicle(v);
    }
    return true;
  }

  enterVehicle(v) {
    if (this.state !== GameState.PLAYING || this.vehicleMode || !v.drivable) return false;
    if (v.isHelicopter && v.extractionLocked) { this.ui.toastBrief('EXTRACTION NOT READY'); return false; }
    if (v.isHelicopter && (v.pos.y > 1.25 || !v.landed && v.pos.y > 0.5)) return false;
    if (v.driver === 'ai' && Math.abs(v.speed) > 2.5) return false;
    if (this.touch && this.touch.resetForVehicleTransition) this.touch.resetForVehicleTransition();
    if (v.driver === 'ai') { v.driver = null; v.aiMode = 'parked'; } // commandeered, route no longer drives
    if (this.vehicles && this.vehicles._safeExit(v, this._tmpV1)) v._lastSafeExit.copy(this._tmpV1);
    else v._lastSafeExit.copy(this.player.pos);
    v.openForEntry(this.player.pos);
    v.entryT = v.entryDuration;
    v.engineStarted = true;
    v.firstPerson = false;
    v.cameraYaw = 0;
    v.cameraPitch = v.isHelicopter ? 0.16 : 0.19;
    v.hoverAltitude = null;
    v.occupants = 1;
    this.vehicleMode = v;
    v.driver = 'player';
    this.stats.usedVehicle = true;
    this.stats.equipCats.vehicle = true;
    this.weapons.cancelForEquipment();
    this.input.mouse0 = false; this.input.mouse2 = false; this._mouse2Was = false;
    this._fireInput && this._fireInput.reset();
    this.input._touchVehicleCollective = 0; this.input._touchVehicleHover = false;
    this.input._hoverKey = false;
    this.input.vehicleCollective = 0; this.input.vehicleHover = false;
    this.weapons.rig.visible = false;
    // Camera eases into the seat/chase orbit; the shared operator rig moves to
    // the selected driver seat during the short, door-animated entry sequence.
    this.body.setThirdPerson(!v.firstPerson);
    this.body.setVisible(!v.firstPerson);
    this.ui.showVehicleHUD(v);
    const controls = v.isHelicopter
      ? 'W/S forward · A/D yaw · SPACE climb · SHIFT descend · V hover · C camera · F exit'
      : `W/S throttle · A/D steer · SPACE handbrake · ${v.lowRangeCapable ? 'SHIFT low-range 4WD · ' : ''}T horn · C camera · F exit`;
    this.ui.toast('VEHICLE ACQUIRED', v.def.name + ' — ' + controls);
    this.emitNoise(v.pos, v.isHelicopter ? 22 : 16, v.isHelicopter ? 'rotor' : 'machine', v);
    return true;
  }

  exitVehicle(forced = false) {
    const v = this.vehicleMode;
    if (!v) return false;
    const chosen = this._tmpV1;
    let safe = this.vehicles && this.vehicles._safeExit(v, chosen);
    if (!safe && forced) {
      const last = v._lastSafeExit;
      if (last && last.distanceToSquared(v.pos) < 11 * 11) { chosen.copy(last); safe = true; }
    }
    if (!safe) {
      if (!forced) this.ui.toastBrief(v.isHelicopter ? 'LAND AND STABILIZE BEFORE EXITING' : 'NO CLEAR EGRESS — MOVE THE VEHICLE');
      return false;
    }
    if (this.touch && this.touch.resetForVehicleTransition) this.touch.resetForVehicleTransition();
    v.setDoor(true, v.entryDoorSide);
    v._exitDoorTimer = 0.52;
    if (v.driver === 'player') v.driver = null;
    if (!forced && this.missions.isDriveStepActive) this.stats.vehicleAbandoned = true;
    this.vehicleMode = null;
    this.input._touchVehicleCollective = 0; this.input._touchVehicleHover = false;
    this.input.vehicleCollective = 0; this.input.vehicleHover = false; this.input._hoverKey = false;
    if (!this.input._spaceKeyHeld) this.input.spaceHeld = false;
    this.player.pos.copy(chosen);
    this.player.vel.set(0, 0, 0);
    this.player.yaw = v.heading;
    this.weapons.rig.visible = true;
    this.body.setThirdPerson(false);
    this.body.setVisible(true);
    this.ui.hideVehicleHUD();
    if (forced) this.ui.toast('VEHICLE LOST', 'CONTINUE ON FOOT');
    return true;
  }

  /** Clear vehicle state without side effects (death / failure / completion). */
  _clearVehicleMode() {
    if (!this.vehicleMode) return;
    if (this.touch && this.touch.resetForVehicleTransition) this.touch.resetForVehicleTransition();
    if (this.vehicleMode.driver === 'player') this.vehicleMode.driver = null;
    this.vehicleMode = null;
    this.input._touchVehicleCollective = 0; this.input._touchVehicleHover = false;
    this.input.vehicleCollective = 0; this.input.vehicleHover = false; this.input._hoverKey = false;
    if (!this.input._spaceKeyHeld) this.input.spaceHeld = false;
    this.weapons.rig.visible = true;
    this.body.setThirdPerson(false);
    this.ui.hideVehicleHUD();
    if (this.audio.ready && this.audio.engineStop) this.audio.engineStop();
    if (this.audio.ready && this.audio.rotorStop) this.audio.rotorStop();
  }

  /** CRITICAL FIX: [V] / BAR press edge — the action fires on release (tap) or on the hold timer (stow). */
  // The hold is measured in clamped simulation time (_shieldHoldT, advanced per frame), not wall
  // time, so a single long frame/hitch between press and release can never turn a tap into a stow.
  shieldPressStart() { if (!this._shieldDownAt) { this._shieldDownAt = performance.now(); this._shieldHoldT = 0; } }
  shieldPressEnd() {
    if (!this._shieldDownAt) return;            // hold already consumed (stowed)
    this._shieldDownAt = 0; this._shieldHoldT = 0;
    if (this.state === GameState.PLAYING && !this.vehicleMode) this.input.shieldPressed = true;
  }

  /** Central damage gate: while driving, most incoming damage goes to the vehicle. */
  applyDamageToPlayer(zone, amount, fromPos) {
    const v = this.vehicleMode;
    if (v && v.drivable) {
      let impact = null;
      if (fromPos) {
        const dir = this._tmpV2.copy(this.player.pos).sub(fromPos);
        const dist = dir.length();
        if (dist > 0.001) {
          dir.divideScalar(dist);
          const hit = v.visibleHit(fromPos, dir, dist + 5);
          impact = hit ? this._tmpV1.copy(hit.point) : v.pos;
        }
      }
      v.damage(amount * 1.6, this, impact);
      this.player.damage(zone, amount * 0.12, fromPos);   // small shock bleed-through
      return;
    }
    this.player.damage(zone, amount, fromPos);
  }

  onWorldImpact(point, normal, material, energy) {
    this.particles.impact(point, normal, material, energy);
    const d = point.distanceTo(this.player.pos);
    if (d < 14) this.addShake(0.22 * energy * (1 - d / 14));
    if (material !== 'glass') this.particles.decals.spawn(point, normal, 'hole', 0.1 + energy * 0.05);
    this.audio.impact(material, point, energy);
    if (material === 'metal' && energy > 1) this.emitNoise(point, 8, 'impact');
  }

  // =========================================================================
  // Interaction (doors, terminal, pickups)
  // =========================================================================
  _updateInteraction(dt) {
    const inp = this.input;
    const cam = this.camera;
    cam.getWorldDirection(this._tmpV1);
    // Boarding is resolved *before* the generic ray picker: it is door-specific
    // (reach + correct side of the hull + clear line to the aperture) rather
    // than "anything the crosshair happens to pass over".
    const boarding = this._updateVehicleBoarding(inp);
    if (boarding) return;
    const it = this.world.findInteractable(cam.position, this._tmpV1, 2.6);

    this.interactTarget = it || null;
    if (!it || it.hold <= 0) {
      // instant interactions on key press edge
      if (this.hackTarget && (!it || it !== this.hackTarget)) {
        this.hackProgress = Math.max(0, this.hackProgress - dt * 2);
        if (this.hackProgress <= 0.001) this.hackTarget = null;
      }
      if (it && inp.interactPressed) {
        inp.interactPressed = false;
        const result = it.action(this);
        if (result !== false && !it.reusable && it.hold <= 0 && !it.id.startsWith('door')) it.used = true;
      }
      this.ui.setInteract(it ? (it.getPrompt ? it.getPrompt() : it.prompt) : null);
      if (!this.hackTarget) this.ui.setHackProgress(null);
      return;
    }

    // Phase-14 EMP-4: data terminals are electromagnetically jammed — the hold
    // simply refuses to start until the pulse decays. Physical interactions
    // (doors, resupply crates) are not electronic and stay usable.
    if (this.terminalJamT > 0 && it.id === 'terminal') {
      this.ui.setInteract('⛔ TERMINAL JAMMED — EMP ACTIVE (' + Math.ceil(this.terminalJamT) + 'S)');
      this.ui.setHackProgress(null);
      this.hackTarget = null;
      this.hackProgress = 0;
      return;
    }

    // hold interaction (terminal / resupply / intel)
    this.ui.setInteract(`HOLD [F] — ${it.getPrompt ? it.getPrompt() : it.prompt}`);
    this.hackTarget = it;
    if (inp.interactHeld) {
      this.hackProgress += dt / it.hold;
      if (this.hackProgress >= 1) {
        this.hackProgress = 0;
        const target = this.hackTarget;
        this.hackTarget = null;
        this.ui.setHackProgress(null);
        if (target && !target.reusable) target.used = true;
        try {
          if (target && target.action) target.action(this);
        } catch (e) {
          console.warn('[game] interaction action error:', e);
        }
        return;
      }
      if (Math.random() < dt * 6) this.audio.terminalBeep(it.pos);
    } else {
      this.hackProgress = Math.max(0, this.hackProgress - dt * 0.8);
    }
    const hackDesc = it.id === 'terminal' ? 'DOWNLOADING TARGET DATA…' : (it.id && it.id.startsWith('intel_')) ? 'RECOVERING INTEL…' : 'RESUPPLYING…';
    this.ui.setHackProgress(this.hackProgress, hackDesc);
  }

  // =========================================================================
  // Main loop
  // =========================================================================
  /** Phase 17: vsauto scripted work-out driver (test-only, see constructor). */
  _vsAutoTick(dt) {
    const A = this._vsAuto;
    A.phaseT += dt;
    const START = { rest: 0, walk: 5, ads: 11, fire: 17, cooldown: 21, done: 25.5 };
    const ensureData = (name) => {
      const D = A.data[name] = A.data[name] || { frames: [], px0: this.renderer.getPixelRatio(), t0: this.time };
      return D;
    };
    const closeData = (name) => {
      const D = A.data[name];
      if (!D) return;
      D.px1 = this.renderer.getPixelRatio();
      D.prScale = this._prScale;
      D.alive = this.enemies.list.filter(e => e.alive).length;
      const info = this.renderer.info;
      D.calls = info.render.calls; D.tris = info.render.triangles;
      D.progs = info.programs.length; D.geos = info.memory.geometries; D.texs = info.memory.textures;
      D.seg = JSON.parse(JSON.stringify(this._prof || {}));
      this._prof = {};
    };
    for (let i = 0; i < A.phases.length; i++) {
      const name = A.phases[i];
      if (A.phaseT >= START[name] && (i === A.phases.length - 1 || A.phaseT < START[A.phases[i + 1]])) {
        if (A.phase !== name) { if (A.phase !== 'idle') closeData(A.phase); A.phase = name; ensureData(name); }
        break;
      }
    }
    const D = A.data[A.phase];
    if (D) {
      const raw = this._frameRing.length ? this._frameRing[this._frameRing.length - 1] : 0;
      D.frames.push(raw);
      if (raw > (D.worst || 0)) D.worst = +raw.toFixed(1);
      // ADS stability evidence (P2): rig transform ONLY after adsT≥0.995 has
      // held for 12 consecutive frames with the sway spring settled — snap0
      // taken earlier measures the convergence tail, not the hold.
      if (A.phase === 'ads') {
        const w = this.weapons, rig = w.rig;
        const m = Math.max(Math.abs(w.swayX), Math.abs(w.swayY));
        D.swayMax = Math.max(D.swayMax || 0, +m.toFixed(5));
        const settled = w.adsT >= 0.995 && m < 0.003 &&
          rig.position.distanceTo(w._targetPos) < 0.002;
        D.settleFrames = settled ? (D.settleFrames || 0) + 1 : 0;
        const snap6 = () => ({
          t: +A.phaseT.toFixed(3), fov: +(this._fovCurrent || 0).toFixed(2),
          adsT: +w.adsT.toFixed(4), swayX: +w.swayX.toFixed(5), swayY: +w.swayY.toFixed(5),
          pos: rig.position.toArray().map(v => +v.toFixed(5)),
          rot: [rig.rotation.x, rig.rotation.y, rig.rotation.z].map(v => +v.toFixed(5)),
          tgt: w._targetPos.toArray().map(v => +v.toFixed(5)),
        });
        if (!D.adsSnap0 && D.settleFrames >= 12) D.adsSnap0 = snap6();
        if (D.adsSnap0) D.adsSnap1 = snap6();
      }
    }
    // scripted inputs for the NEXT frame (input fields end-of-frame resets)
    if (A.phase === 'walk') {
      this.input.moveF = 1;
      this.input.lookX -= 9;                     // slow continuous turn
    } else if (A.phase === 'ads') {
      if (!this.weapons._adsKeyLatch && A.phaseT < START.ads + 0.1) this.weapons._adsKeyLatch = true;
      this.input.mouse2 = true;
    } else if (A.phase === 'fire') {
      if (this.weapons._adsKeyLatch) this.weapons.cancelAds();
      this.input.mouse0 = true;
    }
    if (A.phaseT >= START.done && !A.finished) {
      A.finished = true;
      closeData('cooldown');
      const out = {};
      for (const k in A.data) {
        const Dk = A.data[k];
        const f = Dk.frames.slice().sort((a, b) => a - b);
        const q = x => f.length ? +f[Math.min(f.length - 1, Math.floor(f.length * x))].toFixed(1) : 0;
        const seg = {};
        for (const sk in (Dk.seg || {})) { const s = Dk.seg[sk]; seg[sk] = { avg: +(s.sum / s.n).toFixed(2), max: +s.max.toFixed(1) }; }
        out[k] = {
          frames: f.length, p50: q(0.5), p90: q(0.9), worst: Dk.worst || q(1),
          pxFrom: +Dk.px0.toFixed(2), pxTo: +Dk.px1.toFixed(2), prScale: Dk.prScale,
          calls: Dk.calls, tris: Dk.tris, progs: Dk.progs, geos: Dk.geos, texs: Dk.texs,
          alive: Dk.alive, seg,
        };
        if (k === 'ads' && Dk.adsSnap0 && Dk.adsSnap1) {
          const s0 = Dk.adsSnap0, s1 = Dk.adsSnap1;
          const dPos = Math.max(...s0.pos.map((v, i) => Math.abs(v - s1.pos[i])));
          const dRot = Math.max(...s0.rot.map((v, i) => Math.abs(v - s1.rot[i])));
          out.ads_drift = {
            dt: +(s1.t - s0.t).toFixed(2), dPosMax: +dPos.toFixed(5), dRotMax: +dRot.toFixed(5),
            fovFrom: +s0.fov.toFixed(1), fovTo: +s1.fov.toFixed(1), adsTEnd: s1.adsT,
            swayMaxDuringHold: Dk.swayMax,
            held: s1.adsT > 0.98, posStable: dPos < 0.0015, rotStable: dRot < 0.001,
          };
        }
      }
      if (typeof performance !== 'undefined' && performance.memory) {
        out.heapMB = +(performance.memory.usedJSHeapSize / 1048576).toFixed(1);
      }
      window.__vsAutoReport = out;
      if (this.weapons._adsKeyLatch || this.input.mouse0 || this.input.mouse2) {
        this.weapons.cancelAds();
        this.input.mouse0 = false; this.input.mouse2 = false;
      }
    }
  }

  /**
   * The authoritative input → fire step: one call per played frame, and the only
   * route by which a click reaches a weapon. Kept as a method (rather than inlined
   * in the frame loop) so the shipped pipeline is exactly what the automated
   * tests drive. One accepted click = one firing event here, one round charged
   * inside tryFire, and nothing else.
   */
  _fireStep(dt) {
    const ws = this.weapons;
    if (!this._fireInput) this._fireInput = new FireTriggerInput();
    const triggerDown = this._fireInput.sample(this.time, dt, {
      mode: ws.st ? ws.st.fireMode : 'semi',
      accepting: ws.canAcceptTriggerAt(this.time),
      busy: ws.triggerStateBusy(),
    });
    ws.tryFire(this.time, triggerDown);
  }

  /** Phase 17 diagnostics: per-segment frame-cost accumulator (vsdebug only). */
  _segMark(key, closeFrame = false) {
    const now = performance.now();
    const dt = now - this._profT0;
    this._profT0 = now;
    const seg = this._prof = this._prof || {};
    const s = seg[key] = seg[key] || { n: 0, sum: 0, max: 0 };
    s.n++; s.sum += dt; if (dt > s.max) s.max = dt;
    if (closeFrame) {
      if (!this._profFrameStart) { this._profFrameStart = now; return; }
      const all = this._profAll = this._profAll || { n: 0, sum: 0, max: 0 };
      const fr = now - this._profFrameStart;
      all.n++; all.sum += fr; if (fr > all.max) all.max = fr;
      this._profFrameStart = now;
    }
  }

  _loop(nowMs) {
    requestAnimationFrame(this._loop);
    const rawMs = nowMs - this._lastT;
    let dt = rawMs / 1000;
    this._lastT = nowMs;
    if (this._frameRing) {
      this._rafCount = (this._rafCount || 0) + 1;   // rAF heartbeat (vsdebug)
      if (this._rafCount % 30 === 0) console.log('HB', this._rafCount, this.state, this.time.toFixed(1), 'buckets=' + (this.world && this.world._batchBuckets ? this.world._batchBuckets.length : 0));
    }
    if (this._frameRing && this.state === GameState.PLAYING) {
      this._frameRing.push(rawMs);
      if (this._frameRing.length > 900) this._frameRing.splice(0, 450);
    }
    if (!isFinite(dt) || dt <= 0) dt = 0.016;
    dt = Math.min(dt, 0.05); // clamp after tab-outs; simulation stays stable

    if (this.touch) this.touch.update(dt);

    // Adaptive resolution: EMA of real frame time steps the render pixel ratio
    // down under sustained load and back up when frames get cheap. Raster cost
    // scales roughly with fill area, so this is the cheapest recovery lever on
    // weak GPUs; user quality/perfMode caps remain the ceiling (see applyQuality).
    if (this.state === GameState.PLAYING && this.renderer && !this.tacmap.open) {
      this._frameEMA = (this._frameEMA || 16.7) * 0.92 + Math.min(rawMs, 250) * 0.08;
      this._prT = (this._prT || 0) + dt;
      if (this._prT >= 1.6) {
        this._prT = 0;
        let s = this._prScale == null ? 1 : this._prScale;
        if (this._frameEMA > 33 && s > 0.6) s = Math.max(0.6, +(s * 0.85).toFixed(2));
        else if (this._frameEMA < 19 && s < 1) s = Math.min(1, +(s + 0.08).toFixed(2));
        if (s !== this._prScale) {
          this._prScale = s;
          this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this._prCap || 1) * s);
          this.renderer.setSize(window.innerWidth, window.innerHeight);
        }
      }
    }

    const st = this.state;
    if (st === GameState.PLAYING) {
      this._pollInput();
      if (this.input.mapPressed) { this.input.mapPressed = false; this.tacmap.toggle(); }
      if (this.tacmap.open) {
        // partial pause: discard gameplay edge inputs so map interaction never
        // queues a delayed reload, weapon swap or fire-mode change.
        this.input.lookX = 0; this.input.lookY = 0;
        this.input.jumpPressed = false; this.input.interactPressed = false;
        this.input.reloadPressed = false; this.input.fireModePressed = false;
        this.input.selectWeapon = null; this.input.grenadePressed = false;
        this.input.grenadeBackPressed = false; this.input.shieldPressed = false; this.input.abilityPressed = false;
        this.input.flashlightPressed = false; this.input.baseStrikePressed = false;   // Master upgrade
        this.weapons.cancelZoom();
        this.input.mouse0 = false; this.input.mouse2 = false;
        this._fireInput && this._fireInput.reset();
        this.weapons.cancelAds();               // Phase-14/15: opening the map cancels a latched ADS too
        this.weapons.blockTriggerUntilRelease();
        this.ui.updateHUD(dt);
        this.renderer.render(this.scene, this.camera);
        return;
      }
      this.time += dt;
      this.stats.missionTime += dt;
      this.progress.tick(dt);
      if (this.player.health < this.stats.minHealth) this.stats.minHealth = this.player.health;

      const inp = this.input;

      // weapon / hands commands (edge-triggered)
      if (inp.reloadPressed) {
        inp.reloadPressed = false;
        if (this.handsMode !== 'gun') this.equipGun();
        else this.weapons.startReload();
      }
      if (inp.fireModePressed) {
        inp.fireModePressed = false;
        if (!this.vehicleMode && this.handsMode === 'gun') this.weapons.cycleFireMode();
      }
      if (inp.selectWeapon) { const slot = inp.selectWeapon; inp.selectWeapon = null; this._selectSlot(slot); }

      if (this.vehicleMode) {
        // edge inputs only — simulation happens in vehicles.update() below
        const v = this.vehicleMode;
        // Master upgrade: strike works from a vehicle; on-foot-only edges never stay latched
        if (inp.baseStrikePressed) { inp.baseStrikePressed = false; this.baseStrike.activate(); }
        inp.flashlightPressed = false;
        if (this.weapons.zoomT) this.weapons.cancelZoom();
        if (inp.camPressed) {
          inp.camPressed = false; v.firstPerson = !v.firstPerson;
          this.ui.toastBrief(v.firstPerson ? 'DRIVER CAMERA' : 'CHASE CAMERA');
          this.body.setThirdPerson(!v.firstPerson);
          this.body.setVisible(!v.firstPerson);
        }
        if (inp.interactPressed) { inp.interactPressed = false; this.exitVehicle(); }
      } else {
        if (this._frameRing) this._profT0 = performance.now();
        this.player.update(dt, inp);
        if (this._frameRing) { this._segMark('player'); }
        if (this.handsMode === 'gun') {
          this._fireStep(dt);
          this.weapons.update(dt, this.time, this.player);
          this._mouse2Was = inp.mouse2;
        } else {
          this._handsFire(dt, inp);
        }
      }
      if (this.shake > 0.001) {
        const s = this.shake;
        this.camera.rotation.x += (Math.random() - 0.5) * 0.028 * s;
        this.camera.rotation.y += (Math.random() - 0.5) * 0.028 * s;
        this.camera.rotation.z += (Math.random() - 0.5) * 0.02 * s;
        this.shake *= Math.exp(-6 * dt);
      } else this.shake = 0;
      if (this._frameRing) this._segMark('weapons');
      this.enemies.update(dt);
      if (this._frameRing) this._segMark('enemies');
      this.missions.update(dt);
      this.missions.refreshEnemyTelemetry(dt);
      this._worldEvT -= dt;
      if (this._worldEvT <= 0) {
        this._worldEvT = 55 + Math.random() * 75;
        this._worldEvent();
      }
      // equipment wheel (hold Q): virtual cursor from mouse deltas, resolve on release
      if (inp.wheelHeld && !this.wheelActive && !this.vehicleMode && !this.tacmap.open) {
        this.wheelActive = true;
        this.wheelX = 0; this.wheelY = 0;
        this.ui.showEqWheel(this);
      }
      if (this.wheelActive) {
        if (inp.wheelHeld) {
          this.wheelX = THREE.MathUtils.clamp(this.wheelX + inp.lookX * 0.55, -180, 180);
          this.wheelY = THREE.MathUtils.clamp(this.wheelY - inp.lookY * 0.55, -180, 180);
          this.ui.moveWheelCursor(this.wheelX, this.wheelY);
          inp.lookX = 0; inp.lookY = 0;
        } else {
          this.wheelActive = false;
          const sel = this.ui.resolveWheel(this.wheelX, this.wheelY);
          this.ui.hideEqWheel();
          this._applyWheel(sel);
        }
      }

      // interaction while driving: the contextual action IS exiting (F / touch INTERACT)
      if (this.vehicleMode) {
        this.interactTarget = null;
        this.ui.setInteract('EXIT VEHICLE');
        if (this.hackTarget) { this.hackTarget = null; this.hackProgress = 0; this.ui.setHackProgress(null); }
      } else {
        this._updateInteraction(dt);
      }

      // consumed once per frame
      inp.lookX = 0; inp.lookY = 0;
      inp.jumpPressed = false;
      inp.interactPressed = false;
      inp.camPressed = false;

      if (this._frameRing) this._segMark('missions');
      this.world.update(dt, this);
      this.vehicles.update(dt);
      this.throwables.update(dt);
      if (this._frameRing) this._segMark('world');
      this.terminalJamT = Math.max(0, this.terminalJamT - dt);
      this.characters.update(dt);     // Phase-14 ability lifecycle (single tick — had been called twice per frame since P14)
      this.shield.update(dt);
      this.baseStrike.update(dt);     // Master upgrade P8 (game-time countdown + impacts)         // Phase-14 barrier lifecycle (single tick — had been called twice per frame since P14)
      const vm = this.vehicleMode;
      if (vm) {
        // the player entity rides the vehicle so triggers/missions/AI target it
        this.player.pos.copy(vm.pos);
        this.player.yaw = vm.heading;
        this.player.vel.set(0, 0, 0);
        vm.updateCamera(dt, this);
        this.ui.updateVehicleHUD(vm);
        this.stats.driveDist += Math.abs(vm.speed) * dt;
        if (this.shake > 0.001) {
          this.camera.rotation.x += (Math.random() - 0.5) * 0.028 * this.shake;
          this.camera.rotation.y += (Math.random() - 0.5) * 0.028 * this.shake;
          this.camera.rotation.z += (Math.random() - 0.5) * 0.02 * this.shake;
        }
        // engine noise attracts attention
        vm._noiseT = (vm._noiseT || 0) - dt;
        if (vm._noiseT <= 0 && Math.abs(vm.speed) > 1.5) {
          vm._noiseT = 0.5;
          this.emitNoise(vm.pos, 12 + Math.abs(vm.speed) * 0.9, 'machine');
        }
      }
      if (this.input.grenadePressed) { this.input.grenadePressed = false; this._cycleHands(); }
      // Phase-14: backwards cycle equips the previous stocked throwable
      if (this.input.grenadeBackPressed) {
        this.input.grenadeBackPressed = false;
        if (this.handsMode !== 'throwable') this.equipThrowable();
        else {
          const id = this.throwables.cycle('throwable', -1);
          if (id) this.equipThrowable(id);
        }
      }
      // Phase-14: one-tap shield deploy (keyboard V on foot / mobile button)
      // Master upgrade P4/P8: flashlight toggle + base strike (edge-triggered)
      if (this.input.flashlightPressed) { this.input.flashlightPressed = false; this.flashlight.toggle(); }
      if (this.input.baseStrikePressed) { this.input.baseStrikePressed = false; this.baseStrike.activate(); }
      // CRITICAL FIX: long-press [V] / BAR stows the held shield
      if (this._shieldDownAt) this._shieldHoldT = (this._shieldHoldT || 0) + Math.min(dt, 0.05);
      if (this._shieldDownAt && this._shieldHoldT * 1000 >= SHIELD_STOW_HOLD_MS) {
        this._shieldDownAt = 0; this._shieldHoldT = 0;
        if (this.shield.heldUnit) this.shield.stow(); else this.input.shieldPressed = true;
      }
      if (this.input.shieldPressed) {
        this.input.shieldPressed = false;
        this.shield.interact();      // contextual: pick up / plant / raise
      }
      // Phase-14: character ability
      if (this.input.abilityPressed) {
        this.input.abilityPressed = false;
        this.characters.activate();
      }
      this.tacmap.update(dt);
      for (let i = this.grenades.length - 1; i >= 0; i--) {
        const gr = this.grenades[i];
        gr.update(dt);
        if (gr.done) { this.throwables.detonate(gr.type, gr.pos, gr); gr.dispose(); this.grenades.splice(i, 1); }
      }
      for (const m of this._markers) {
        if (!m.visible) continue;
        m.userData.t += dt;
        m.material.opacity = 0.35 + 0.3 * Math.sin(m.userData.t * 10);
        if (m.userData.t > 2.7) { m.visible = false; m.material.opacity = 0; }
      }
      this.suppress *= Math.exp(-0.85 * dt);
      if (this.suppress < 0.01) this.suppress = 0;
      this.audio.setSuppression(this.suppress);
      this.ui.setPinned(this.suppress > 0.5);
      this.particles.update(dt, this);

      // visible operator body: the same rig in first and third person
      if (this.body && this.body.built) {
        const bodyOn = !(this.vehicleMode && this.vehicleMode.firstPerson);
        if (this._bodyOn !== bodyOn) { this._bodyOn = bodyOn; this.body.setVisible(bodyOn); }
        if (bodyOn) {
          if (this.vehicleMode) this.body.updateVehicle(dt, this.player, this.vehicleMode);
          else this.body.update(dt, this.player);
        }
      }

      // audio listener + zone
      this._zoneT -= dt;
      if (this._zoneT <= 0) {
        this._zoneT = 0.5;
        this.audio.setZone(this.world.getAudioZone(this.player.pos));
      }
      this.audio.update(this.camera, this.time, this._losFn);

      this.ui.updateTacticalMarkers(this.missions.liveEnemyTelemetry, dt);
      this.ui.updateHUD(dt);
      if (this._frameRing) this._segMark('hud');
      // Test path (?vsnorender): skip the GL submit so software-GL rigs can
      // measure simulation costs (movement/ADS/segments) at full speed.
      if (!this._noRender) this.renderer.render(this.scene, this.camera);
      if (this._frameRing) this._segMark('render', true);
      if (this._vsAuto) this._vsAutoTick(dt);
    } else if (st === GameState.PAUSED || st === GameState.DEAD || st === GameState.COMPLETE || st === GameState.FAILED) {
      // Perf: PAUSED / COMPLETE / FAILED show a frozen world behind a DOM panel;
      // nothing moves, so re-render at a trickle (12 Hz) instead of full rate.
      // The death cam (DEAD) animates and keeps full frame rate.
      if (st !== GameState.DEAD) {
        this._pauseRaf = (this._pauseRaf || 0) + 1;
        if (this._pauseRaf < 5) return;
        this._pauseRaf = 0;
      }
      if (st === GameState.DEAD) {
        this.player.update(dt, this.input);
        this.particles.update(dt, this);
        this.world.update(dt, this);
        this.enemies.update(dt);
        // the death camera sinks to the ground — hide the rig so it cannot clip
        if (this.body && this.body.built) this.body.setVisible(false);
      }
      this.renderer.render(this.scene, this.camera);
    } else if (st === GameState.LOADING) {
      // Phase 10: the loading splash is fully opaque, so rendering the
      // partially-built scene here is invisible work — and each render forces
      // per-frame SYNCHRONOUS shader compiles of whatever materials exist at
      // that moment (measured as three multi-second main-thread stalls and
      // ~73% of mission startup on this build). Everything compiles exactly
      // once in the OPTICS stage (KHR_parallel_shader_compile) instead.
      // Intentionally render nothing while LOADING.
    }
    // MENU / BOOT: nothing rendered (opaque menu covers the viewport)
  }
}

function raf(delay = 0) {
  return new Promise(res => {
    if (delay > 0) setTimeout(() => requestAnimationFrame(() => res()), delay);
    else requestAnimationFrame(() => res());
  });
}

const _upTmp = new THREE.Vector3(0, 1, 0);
const _downTmp = new THREE.Vector3(0, -1, 0);
