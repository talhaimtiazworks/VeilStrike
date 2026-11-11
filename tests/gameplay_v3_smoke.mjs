import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { WeaponSystem, WEAPON_DEFS, WEAPON_ORDER } from '../js/weapons.js';
import { Game, GameState } from '../js/game.js';
import { MISSION_DEFS } from '../js/missions.js';
import { DIFFICULTIES, MISSION_ORDER } from '../js/progress.js';
import { ammoHudState } from '../js/ui.js';
import { PhysicsWorld, Material } from '../js/physics.js';
import { PLAYER_MOVEMENT, Player } from '../js/player.js';
import { DEFAULT_TRACK, MUSIC_TRACKS, MusicSystem } from '../js/music.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gameSrc = readFileSync(resolve(root, 'js/game.js'), 'utf8');
const playerSrc = readFileSync(resolve(root, 'js/player.js'), 'utf8');
const enemiesSrc = readFileSync(resolve(root, 'js/enemies.js'), 'utf8');

// Low-level loadout assertion for each initially unlocked mission ID.
const firstTen = MISSION_ORDER.slice(0, 10);
assert.equal(firstTen.length, 10);
const ledger = Object.create(WeaponSystem.prototype);
ledger.state = Object.fromEntries(WEAPON_ORDER.map(id => [id, { mag: 0, reserve: 0, bloom: 0, heat: 0, malf: false, shotIdx: 0, fireMode: 'auto', burstRemaining: 0 }]));
ledger.models = Object.fromEntries(WEAPON_ORDER.map(id => [id, { visible: false }]));
ledger._restoreWeaponVisual = () => {};
ledger.reloadEvents = [];
for (const missionId of firstTen) {
  ledger.applyLoadout('vx4', 'p9');
  assert.equal(ledger.currentId, 'vx4', `${missionId}: VX-4 must be the primary`);
  assert.equal(ledger.state.vx4.mag, 300, `${missionId}: all 300 rounds must start loaded`);
  assert.equal(ledger.state.vx4.reserve, 0, `${missionId}: no hidden reserve is required`);
}
assert.match(gameSrc, /this\.weapons\.applyLoadout\(loc\.primary, loc\.secondary\)/);
assert.equal(WEAPON_DEFS.vx4.noReload, true);
assert.equal(WEAPON_DEFS.vx4.magSize, 300);
assert.equal(WEAPON_DEFS.vx4.startReserve, 0);
assert.equal(WEAPON_DEFS.vx4.damage, 34);

// Exercise the actual Game.startMission() path with its peripheral services
// stubbed. This checks the real initialization/reset/loadout sequence for all
// ten campaigns and the separate training range.
globalThis.requestAnimationFrame = fn => { queueMicrotask(fn); return 1; };
const startWeapons = Object.create(WeaponSystem.prototype);
startWeapons.state = Object.fromEntries(WEAPON_ORDER.map(id => [id, { mag: 0, reserve: 0, bloom: 0, heat: 0, malf: false, shotIdx: 0, fireMode: 'auto', burstRemaining: 0 }]));
startWeapons.models = Object.fromEntries(WEAPON_ORDER.map(id => [id, { visible: false }]));
startWeapons._restoreWeaponVisual = () => {};
startWeapons.reloadEvents = []; startWeapons.projectiles = [];
startWeapons.rig = { position: new THREE.Vector3(), rotation: { set() {} } };
startWeapons.hipPos = new THREE.Vector3();
startWeapons.applyFinish = () => {}; startWeapons.cancelZoom = () => {};
const startWorld = {
  map: '', layoutId: '', spawnPoint: new THREE.Vector3(), spawnYaw: 0, weather: null,
  windLevel: 0, machinePositions: [], terminalUsed: false,
  buildByMap(id) { this.layoutId = id; this.map = id; this.spawnPoint.set(0, 0, 0); },
  _driveBatchBuckets() {},
};
const startGame = {
  state: GameState.MENU, settings: {}, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
  renderer: null, world: startWorld, physics: new PhysicsWorld(), weapons: startWeapons,
  progress: { equippedWeaponId: null, selectedCharacterId: 'operator', difficulty: DIFFICULTIES.standard,
    isMissionUnlocked: () => true, weaponUnlocked: () => true },
  loadout: { primary: 'vx4', secondary: 'p9', validate: () => false, save() {}, set() {},
    current: () => ({ primary: 'vx4', secondary: 'p9', throwable: 'vxfrag', throwableCount: 2, utility: 'medkit', utilityCount: 1 }) },
  ui: { setLoading() {}, hideVehicleHUD() {}, hideEqWheel() {}, toast() {}, toastBrief() {}, clearKillFeed() {} },
  enemies: { group: new THREE.Group(), reset() {}, beginMissionRun(_id, cap) { this.cap = cap; }, spawnInitial() {}, spawnNPCs() {} },
  vehicles: { reset() {}, spawnFromWorld() {} }, vehicleMode: null,
  baseStrike: { setupForMission() {}, resetForCheckpoint() {} },
  throwables: { reset() {}, clearField() {}, clearField() {} },
  player: null,
  body: null,
  particles: { clear() {}, setWeather() {} },
  characters: { select() {}, reset() {}, cancel() {} },
  shield: { reset() {}, destroy() {} }, flashlight: { reset() {} },
  audio: { ready: false, setWind() {}, startAmbience() {}, setZone() {}, engineStop() {} },
  music: { begin() {}, end() {} },
  tacmap: { reset() {} }, missions: { checkpointData: null, _wave2: false, start(id) { this.missionId = id; this.def = { setup: null }; } },
  setState(state) { this.state = state; }, _teardownMission() {}, _clearGrenades() {},
  applySettings() {}, _requestLock() {},
};
startGame.player = new Player(startGame);
for (let i = 0; i < firstTen.length; i++) {
  const missionId = firstTen[i];
  await Game.prototype.startMission.call(startGame, missionId);
  assert.equal(startGame.weapons.currentId, 'vx4', `${missionId}: mission start should equip default VX-4`);
  assert.equal(startGame.weapons.state.vx4.mag, 300, `${missionId}: actual startMission path must load 300 VX-4 rounds`);
  assert.equal(startGame.weapons.state.vx4.reserve, 0, `${missionId}: campaign VX-4 has no extra/unlimited reserve`);
  assert.equal(startGame.enemies.cap, 50 + i * 2, `${missionId}: mission ${i + 1} enforces 50 + (N - 1) * 2 hostile spawns`);
}
await Game.prototype.startMission.call(startGame, 'range');
assert.equal(startGame.weapons.state.vx4.mag, 300, 'range also starts VX-4 with 300 loaded');
assert.equal(startGame.weapons.state.vx4.reserve, 0, 'range cannot silently make the finite VX-4 supply unlimited');
assert.equal(startGame.enemies.cap, 30, 'training range keeps the 30 hostile spawn cap');
for (let retry = 1; retry <= 3; retry++) {
  startGame.setState(GameState.FAILED);
  await Game.prototype.startMission.call(startGame, 'facility');
  assert.equal(startGame.enemies.cap, 50, `full mission retry ${retry} stays at OP 001 target`);
}
startGame.setState(GameState.FAILED);
await Game.prototype.startMission.call(startGame, 'desert');
assert.equal(startGame.enemies.cap, 52, 'OP 002 retry keeps its campaign target');

// Test the actual key handler: Y toggles on/off, ignores key-repeat, and cannot
// double as the dedicated ADS key even if a stale settings value asks for Y.
const sanitizedKeyGame = Object.create(Game.prototype);
sanitizedKeyGame.settings = { adsKey: 'KeyY', sensitivity: 1, fov: 90 };
sanitizedKeyGame.renderer = null;
sanitizedKeyGame.applySettings();
assert.equal(sanitizedKeyGame.settings.adsKey, 'KeyX', 'Y stays reserved for zoom, separate from ADS');
const handlers = new Map();
globalThis.document = { addEventListener(type, fn) { handlers.set(type, fn); }, pointerLockElement: null };
const inputGame = Object.create(Game.prototype);
inputGame.input = { _zoomKey: false };
inputGame.state = GameState.PLAYING; inputGame.settings = { adsKey: 'KeyX' };
inputGame.audio = { ready: true }; inputGame.vehicleMode = null;
inputGame._unlockAudioOnce = () => {}; inputGame.shieldPressStart = () => {}; inputGame.shieldPressEnd = () => {};
inputGame._bindInput();
const keydown = handlers.get('keydown');
keydown({ code: 'KeyY', repeat: false, preventDefault() {} });
assert.equal(inputGame.input._zoomKey, true);
keydown({ code: 'KeyY', repeat: true, preventDefault() {} });
assert.equal(inputGame.input._zoomKey, true, 'key repeat must not undo the toggle');
keydown({ code: 'KeyY', repeat: false, preventDefault() {} });
assert.equal(inputGame.input._zoomKey, false, 'second Y press toggles zoom off');
assert.equal(inputGame.input.adsToggleRequested, undefined, 'Y must not also toggle ADS');

const hudFull = ammoHudState(WEAPON_DEFS.vx4, { mag: 300, reserve: 0 });
assert.deepEqual(hudFull, { total: 300, suggestReload: false, noReloadMessage: 'CONTINUOUS SUPPLY · NO RELOAD' });
const hudEmpty = ammoHudState(WEAPON_DEFS.vx4, { mag: 0, reserve: 0, malf: true });
assert.equal(hudEmpty.total, 0);
assert.equal(hudEmpty.suggestReload, false);
assert.equal(hudEmpty.noReloadMessage, 'OUT OF AMMO — RESUPPLY UNAVAILABLE');
const hudLegacyReserve = ammoHudState(WEAPON_DEFS.vx4, { mag: 0, reserve: 17 });
assert.equal(hudLegacyReserve.total, 17, 'legacy reserve remains accounted for as continuous feed');
assert.equal(hudLegacyReserve.suggestReload, false);
assert.equal(ammoHudState(WEAPON_DEFS.p9, { mag: 0, reserve: 1 }).suggestReload, true, 'standard weapons retain reload messaging');

// Exercise the real firing/accounting path with external presentation/audio
// effects stubbed. Holding the trigger while sprinting consumes exactly 300
// rounds without a reload transition or jam.
const weapon = Object.create(WeaponSystem.prototype);
weapon.currentId = 'vx4';
weapon.state = { vx4: { mag: 300, reserve: 0, bloom: 0, heat: 0, malf: false, shotIdx: 0, fireMode: 'auto', burstRemaining: 0 } };
weapon.owned = new Set(['vx4']);
weapon.state_ = 'ready'; weapon.stateT = 0; weapon.stateDur = 0;
weapon.triggerWasDown = false; weapon.triggerBlockedUntilRelease = false;
weapon.dryFireLatch = false; weapon.nextShotAt = 0; weapon.reloadEvents = [];
weapon._shellReload = false; weapon._rackMalf = false; weapon._reloadQueuedUntil = 0;
weapon.adsT = 0; weapon.zoomT = 0; weapon.malfLatch = false;
weapon.kickZ = 0; weapon.kickPitch = 0;
weapon._camDir = new THREE.Vector3(); weapon._right = new THREE.Vector3(); weapon._up = new THREE.Vector3();
weapon._shotDir = new THREE.Vector3(); weapon._muzzleWorld = new THREE.Vector3();
weapon._ejectCasing = () => {}; weapon._restoreWeaponVisual = () => {};
let lastRay = null;
weapon._hitscan = (origin, dir) => { lastRay = { origin: origin.clone(), dir: dir.clone() }; };
const camera = {
  position: new THREE.Vector3(0, 1.6, 0), quaternion: new THREE.Quaternion(),
  getWorldDirection(out) { return out.set(0, 0, -1); },
};
let dryClicks = 0;
const gunGame = {
  state: 'playing', time: 0, camera,
  player: { pos: new THREE.Vector3(), headPos: new THREE.Vector3(), speed: 7.8, sprinting: true,
    onGround: true, spreadMultiplier: () => 1, addRecoil() {} },
  stats: { shots: 0 },
  audio: { gunshot() {}, casingDrop() {}, dryFire() { dryClicks++; }, wpnClick() {} },
  particles: { muzzleFlash() {}, gunSmoke() {}, tracer() {} },
  addShake() {}, emitNoise() {}, ui: { toastBrief() {} },
};
weapon.game = gunGame;
weapon.models = { vx4: { userData: { muzzle: { getWorldPosition(out) { return out.set(0.25, 1.35, -0.35); } } } } };
weapon._camDir.set(0, 0, -1);
const interval = 60 / WEAPON_DEFS.vx4.rpm + 0.001;
for (let i = 0; i < 300; i++) weapon.tryFire(i * interval, true);
assert.equal(weapon.state.vx4.mag, 0);
assert.equal(weapon.state.vx4.reserve, 0);
assert.equal(gunGame.stats.shots, 300);
assert.equal(weapon.state.vx4.malf, false);
assert.equal(weapon.state_, 'ready');
assert.equal(weapon.startReload(), false, 'R must not start or interrupt a VX-4 reload');
assert.equal(weapon.state_, 'ready');
weapon.tryFire(301 * interval, true);
assert.equal(gunGame.stats.shots, 300, 'empty trigger cannot create a 301st round');
assert.equal(dryClicks, 1, 'empty trigger gives one latched dry-fire cue');

// Observation zoom routes the shot from the camera and along the camera aim
// direction; sprinting does not block a shot.
weapon.state.vx4.mag = 1; weapon.triggerWasDown = false; weapon.nextShotAt = 0; weapon.dryFireLatch = false;
weapon.zoomT = 1; weapon.adsT = 0; gunGame.player.sprinting = true;
weapon.tryFire(0, true);
assert.equal(gunGame.stats.shots, 301);
assert.ok(lastRay.origin.distanceTo(camera.position) < 1e-6, 'zoomed shot starts at camera/crosshair');
assert.ok(lastRay.dir.dot(new THREE.Vector3(0, 0, -1)) > 0.996, 'shot stays within the authored spread cone around camera aim ray');
assert.equal(gunGame.player.sprinting, true);

// Exercise the real hitscan resolver while zoomed (stationary) and unzoomed
// (moving): the target is a controlled AABB and damage must be applied once.
gunGame.physics = { raycast() { return null; } };
gunGame.world = { rangeTargets: [], shootables: [] };
const target = { alive: true, box: { min: new THREE.Vector3(-1, 0, -5.5), max: new THREE.Vector3(1, 2.5, -4.5) } };
const appliedDamage = [];
gunGame.enemies = { list: [target], damage(enemy, zone, damage) { appliedDamage.push({ enemy, zone, damage }); } };
weapon._hitscan = function(origin, dir, range) {
  lastRay = { origin: origin.clone(), dir: dir.clone() };
  return WeaponSystem.prototype._hitscan.call(this, origin, dir, range);
};
gunGame.stats.hits = 0; gunGame.stats.headshots = 0;
gunGame.player.sprinting = false; gunGame.player.speed = 0;
weapon.state.vx4.mag = 1; weapon.triggerWasDown = false; weapon.nextShotAt = 0; weapon.dryFireLatch = false;
weapon.zoomT = 1; weapon.tryFire(1, true);
assert.equal(gunGame.stats.hits, 1, 'zoomed camera-ray hit must register');
assert.equal(appliedDamage.length, 1, 'one zoomed hit must apply damage exactly once');
assert.equal(appliedDamage[0].damage, 34, 'close VX-4 torso hit retains intended damage 34');
assert.ok(lastRay.origin.distanceTo(camera.position) < 1e-6);

gunGame.player.speed = 2;
weapon.state.vx4.mag = 1; weapon.triggerWasDown = false; weapon.nextShotAt = 0; weapon.dryFireLatch = false;
weapon.zoomT = 0; weapon.tryFire(2, true);
assert.ok(lastRay.origin.distanceTo(new THREE.Vector3(0.25, 1.35, -0.35)) < 1e-6, 'unzoomed shot returns to muzzle origin');
assert.equal(gunGame.stats.hits, 2, 'unzoomed shot remains functional while moving');
assert.equal(appliedDamage.length, 2, 'unzoomed hit also applies damage exactly once');

// Swept vertical AABB collision catches high-speed falls and ceilings.
const physics = new PhysicsWorld();
physics.add(new THREE.Vector3(-5, -0.2, -5), new THREE.Vector3(5, 0, 5), Material.CONCRETE, { tag: 'ground' });
const fallBox = { min: new THREE.Vector3(-0.3, 10, -0.3), max: new THREE.Vector3(0.3, 11.8, 0.3) };
const fallOut = {};
physics.moveBox(fallBox, 0, -50, 0, fallOut, 0);
assert.equal(fallOut.onGround, true, 'high-speed fall must collide with a thin ground slab');
assert.ok(Math.abs(fallBox.min.y - 0.001) < 1e-6, `fall should stop on the floor, got ${fallBox.min.y}`);
physics.add(new THREE.Vector3(-5, 2, -5), new THREE.Vector3(5, 2.2, 5), Material.CONCRETE, { tag: 'ceiling' });
const riseBox = { min: new THREE.Vector3(-0.3, 0, -0.3), max: new THREE.Vector3(0.3, 1.8, 0.3) };
const riseOut = {};
physics.moveBox(riseBox, 0, 5, 0, riseOut, 0);
assert.equal(riseOut.hitCeil, true, 'high-speed ascent must collide with a ceiling');
assert.ok(Math.abs(riseBox.max.y - 1.999) < 1e-6);

// Recovery is a player-only return to the latest verified safe footing; it
// preserves mission facts and never rebuilds the world or enemies.
const recoveryGame = {
  physics,
  world: { bounds: { minX: -10, maxX: 10, minZ: -10, maxZ: 10 }, spawnPoint: new THREE.Vector3(0, 0, 0), spawnYaw: 0 },
  stats: { kills: 4, missionTime: 72 },
  ui: { toastBrief() {} },
};
const player = new Player(recoveryGame);
player.reset(new THREE.Vector3(0, 0, 0), 0.7);
player.pos.set(0, -20, 0);
assert.equal(player._recoverFromWorldBoundary(), true);
assert.ok(player.pos.distanceTo(new THREE.Vector3(0, 0.02, 0)) < 1e-6);
assert.equal(player.yaw, 0.7);
assert.equal(player.health, 100);
assert.equal(player.fallRecoveryCount, 1);
assert.equal(recoveryGame.stats.kills, 4);
assert.equal(recoveryGame.stats.missionTime, 72);
player.pos.set(12, 0, 0);
assert.equal(player._recoverFromWorldBoundary(), true);
assert.equal(player.fallRecoveryCount, 2);
assert.equal(recoveryGame.stats.fallRecoveries, 2);

assert.equal(PLAYER_MOVEMENT.sprint, 7.8);
assert.ok(PLAYER_MOVEMENT.sprintDrain < 10 && PLAYER_MOVEMENT.walkAccel >= 20);
assert.match(playerSrc, /if \(this\.onGround && this\.vel\.y < 0\) this\.vel\.y = 0/);
assert.match(playerSrc, /_recoverFromWorldBoundary\(\)/);
assert.match(enemiesSrc, /const MAX_ACTIVE_HOSTILES = 12/);
assert.match(gameSrc, /id === 'range' \? 30 : getMissionMinEnemies\(missionIndex \+ 1\)/);
assert.match(enemiesSrc, /this\.spawnedThisRun >= this\.missionSpawnLimit/);

// Soundtrack is local-only: no diagnostics or unrelated network requests.
const music = new MusicSystem({ settings: {} });
assert.equal(MUSIC_TRACKS.length, 1);
assert.equal(DEFAULT_TRACK, 'ins-fearless-pt-2');
assert.equal(music.track.file, '/assets/music/FEARLESS-PT-II.mp3');
assert.ok(existsSync(resolve(root, 'assets/music/FEARLESS-PT-II.mp3')));
assert.doesNotMatch(readFileSync(resolve(root, 'js/music.js'), 'utf8'), /\bfetch\s*\(/);
assert.match(readFileSync(resolve(root, 'sw.js'), 'utf8'), /assets\/music\/FEARLESS-PT-II\.mp3/);

console.log('PASS v3 targeted smoke: actual campaign startMission path for all ten and range (300 VX-4 rounds), 300-shot firing, sprint/zoom firing, real hitscan damage once, HUD, swept collision/recovery, movement, caps, and sole-local-soundtrack configuration.');
console.log('NOTE Browser-rendered missions and audible playback remain unverified; the included MP3 is present and in the service-worker precache.');
