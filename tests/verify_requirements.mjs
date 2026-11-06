import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TRACK, MUSIC_ORDER, MUSIC_TRACKS, MusicSystem } from '../js/music.js';
import { DEFAULT_UNLOCKED_CAMPAIGN_COUNT, MISSION_ORDER, Progress } from '../js/progress.js';
import { MISSION_DEFS } from '../js/missions.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const musicSrc = read('js/music.js');
const progressSrc = read('js/progress.js');
const missionsSrc = read('js/missions.js');
const enemiesSrc = read('js/enemies.js');
const gameSrc = read('js/game.js');
const weaponsSrc = read('js/weapons.js');
const throwablesSrc = read('js/throwables.js');
const playerSrc = read('js/player.js');
const vehiclesSrc = read('js/vehicles.js');
const worldSrc = read('js/world.js');
const physicsSrc = read('js/physics.js');
const htmlSrc = read('index.html');
const musicManifestSrc = read('SOUNDTRACK_RESTORE_MANIFEST.md');

const expectedTracks = [
  ['mortals', 'MORTALS', '/assets/music/MORTALS.mp3'],
  ['ins-fearless-pt-2', 'FEARLESS PT 2', '/assets/music/FEARLESS-PT-II.mp3'],
  ['krezus-skins', 'SKINS', '/assets/music/KREZUS-SKINS.mp3'],
];
assert.deepEqual(MUSIC_TRACKS.map(({ id, name, file }) => [id, name, file]), expectedTracks);
assert.equal(MUSIC_ORDER.length, 3);
assert.deepEqual(MUSIC_ORDER, expectedTracks.map(([id]) => id));
assert.equal(DEFAULT_TRACK, 'mortals');
const trackSelect = htmlSrc.match(/<select id="set-music-track">([\s\S]*?)<\/select>/)?.[1] || '';
assert.equal((trackSelect.match(/<option\b/g) || []).length, 3, 'settings selector must expose exactly three tracks');
assert.deepEqual([...musicManifestSrc.matchAll(/`(\/assets\/music\/[^`]+\.mp3)`/g)].map((m) => m[1]), expectedTracks.map(([, , file]) => file), 'soundtrack manifest must document the exact three canonical MP3 paths and capitalization');
for (const [id] of expectedTracks) assert.match(trackSelect, new RegExp(`value="${id}"`));
assert.match(musicSrc, /new URL\(currentUrl, document\.baseURI\)/, 'URL constructor must retain safe path/space encoding');
const music = new MusicSystem({ settings: {} });
assert.equal(music.select('obsolete-track', { play: false }), true);
assert.equal(music.trackId, DEFAULT_TRACK, 'invalid stored track falls back to MORTALS');
music.select('mortals', { play: false });
music.failed.add('ins-fearless-pt-2');
assert.equal(music._pick(+1), 'krezus-skins', 'rotation skips failed tracks but remains inside the three-track registry');

const orderBody = progressSrc.match(/export const MISSION_ORDER = \[([\s\S]*?)\];/)?.[1] || '';
const order = [...orderBody.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const firstTen = [
  'facility', 'desert', 'urban', 'snow', 'recon_desert', 'sabotage_industrial',
  'investigate_rural', 'rescue_rural', 'defense_urban', 'hold_snow',
];
assert.deepEqual(order.slice(0, 10), firstTen, 'first ten must preserve actual campaign order');
assert.deepEqual(MISSION_ORDER.slice(0, 10), firstTen);
assert.equal(MISSION_ORDER.length >= 100, true, 'campaign must expose at least 100 missions');
assert.equal(DEFAULT_UNLOCKED_CAMPAIGN_COUNT, 1, 'progressive unlocking starts from Mission 1 onward');
const progressStore = new Map();
globalThis.localStorage = {
  getItem: (key) => progressStore.has(key) ? progressStore.get(key) : null,
  setItem: (key, value) => progressStore.set(key, String(value)),
  removeItem: (key) => progressStore.delete(key),
};
const progress = new Progress();
assert.equal(progress.isMissionUnlocked('facility'), true, 'Mission 1 should be initially available');
assert.equal(progress.isMissionUnlocked('desert'), false, 'Mission 2 must start locked until Mission 1 completes');
assert.equal(progress.isMissionUnlocked('range'), true, 'training remains separately accessible');
assert.equal(progress.isMissionUnlocked('not-a-mission'), false, 'unknown IDs must be rejected');
assert.equal(progress.isMissionUnlocked('convoy_rural'), false, 'mission 11 must start locked');
progress.recordFailure('facility');
assert.equal(progress.isMissionUnlocked('desert'), false, 'a failure must not unlock the next campaign mission');
progress.evaluateMission({
  missionId: 'facility', type: 'infiltration', quietTypes: true,
  timeSec: 100, parTime: 420, shots: 0, hits: 0, headshots: 0, kills: 50,
  damageTaken: 0, alarm: false, checkpointsUsed: 0, intelFound: 0, intelTotal: 0,
  intelComplete: false, optionalDone: 0, optionalTotal: 0,
  objectivesDone: 3, objectivesTotal: 3, minHealth: 100, finishedHealth: 100,
  extracted: true, mapOpens: 0, fogPct: 0, usedVehicle: false,
  vehicleMission: false, equipCats: 0, driverClean: false, driveDist: 0,
  throwablesUsed: 0,
});
assert.equal(progress.isMissionUnlocked('desert'), true, 'successful completion of Mission 1 should unlock Mission 2');
const reloadedProgress = new Progress();
assert.equal(reloadedProgress.isMissionUnlocked('desert'), true, 'successful prerequisite completion must persist');
assert.match(progressSrc, /DEFAULT_UNLOCKED_CAMPAIGN_COUNT = 1/);
assert.match(progressSrc, /if \(i < 0\) return false/, 'unknown mission IDs must stay locked');
assert.match(progressSrc, /if \(i < DEFAULT_UNLOCKED_CAMPAIGN_COUNT\) return true/);
assert.match(progressSrc, /this\.data\.missions\[prev\].*completed/s, 'later mission unlocks depend on saved predecessor completion');
assert.match(gameSrc, /id === 'range' \|\| MISSION_ORDER\.includes\(id\)/, 'startMission validates mission IDs');
assert.match(gameSrc, /!this\.progress\.isMissionUnlocked\(id\)/, 'locked campaign missions are rejected before teardown');
for (const id of firstTen) {
  assert.match(missionsSrc, new RegExp(`^\\s*${id}:\\s*\\{`, 'm'), `${id} needs an authored mission definition`);
  assert.match(htmlSrc, new RegExp(`id="btn-mission-${id}"`), `${id} needs a selectable campaign card`);
  assert.match(gameSrc, new RegExp(`showBrief\\('${id}', 'select'\\)`), `${id} card must launch the matching mission`);
}
assert.match(htmlSrc, /btn-tutorial-range/, 'training range remains a separate UI activity');
assert.doesNotMatch(progressSrc.match(/export const MISSION_ORDER = \[([\s\S]*?)\];/)?.[1] || '', /range/);

const missionDefsStart = missionsSrc.indexOf('export const MISSION_DEFS = {');
const missionDefsEnd = missionsSrc.indexOf('\n};\n\n//', missionDefsStart);
const missionDefsSrc = missionsSrc.slice(missionDefsStart, missionDefsEnd < 0 ? missionsSrc.length : missionDefsEnd);
function missionBlock(id) {
  const marker = `\n  ${id}: {`;
  const at = missionDefsSrc.indexOf(marker);
  if (at < 0) return '';
  const bodyStart = at + marker.length;
  const next = missionDefsSrc.slice(bodyStart).search(/\n  [A-Za-z_][\w]*: \{/);
  return missionDefsSrc.slice(at, next < 0 ? missionDefsSrc.length : bodyStart + next);
}
function worldMethodBlock(name) {
  const marker = `\n  ${name}(`;
  const at = worldSrc.indexOf(marker);
  if (at < 0) return '';
  const bodyStart = at + marker.length;
  const next = worldSrc.slice(bodyStart).search(/\n  [A-Za-z_$][\w$]*\s*\(/);
  return worldSrc.slice(at, next < 0 ? worldSrc.length : bodyStart + next);
}
const missionContracts = [
  ['facility', 'facility', 'facility', 'build', ["flow: 'infil'", 'stages: STAGE_INFO'], ['this._buildDock();', 'this._buildExtraction();', 'this._buildTerminal();']],
  ['desert', 'desert', 'desert', 'buildDesert', ['approach:', 'enter:', 'locate:', 'escape:', 'extract:'], ['this._objective(', "this._lz(26, 34)", "'DOWNLOAD THE CACHE MANIFEST'"]],
  ['urban', 'urban', 'urban', 'buildUrban', ['approach:', 'enter:', 'locate:', 'escape:', 'extract:'], ['this._objective(', "this._trig('dock'", "this._lz(-28, 34)"]],
  ['snow', 'snow', 'snow', 'buildSnow', ["flow: 'assault'", 'approach:', 'clear:', 'extract:'], ["this._lz(-26, 12)", "this._vehicle('hx7'", 'this._spawn(']],
  ['recon_desert', 'recon_canyon', 'desert', 'buildReconCanyon', ['reach_w', 'obs_a', 'reach_e', 'obs_b', 'obs_c', "kind: 'extract'"], ["'obs_a'", "'obs_b'", "'obs_c'", 'this._lz(56, -34)']],
  ['sabotage_industrial', 'industrial', 'industrial', 'buildIndustrial', ['reach', 'generator', 'enter_forge', 'charge_1', 'charge_2', 'charge_3', "kind: 'extract'"], ['this._generator(', "'charge_1'", "'charge_2'", "'charge_3'", 'this._lz(-46, 58)']],
  ['investigate_rural', 'rural', 'rural', 'buildRural', ['reach', 'collect', 'radio_records', "kind: 'extract'"], ["this._evidence(", "'radio_records'", 'this._lz(-8, 60)']],
  ['rescue_rural', 'riverside_village', 'rural', 'buildRiversideVillage', ['reach', 'npc_contact', 'escort', "kind: 'extract'"], ["this._npc(16, 22, 'contact'", 'this._lz(-38, 58)']],
  ['defense_urban', 'canal_market', 'urban', 'buildCanalMarket', ['reach', 'hold_pos', 'survive', '150', "kind: 'extract'"], ["this._trig('breach'", 'this._lz(54, -49)']],
  ['hold_snow', 'ridge_hold', 'snow', 'buildRidgeHold', ['reach', 'survive', '120', "kind: 'extract'"], ["this._lz(-26, 12)", "this._vehicle('hx7'", 'this._spawn(']],
];
const structuralResults = [];
for (const [id, layout, canonical, worldMethod, objectiveTokens, worldTokens] of missionContracts) {
  const defBlock = missionBlock(id);
  const mapBlock = worldMethodBlock(worldMethod);
  assert.ok(defBlock, `${id} needs an authored mission definition`);
  assert.match(defBlock, new RegExp(`map: '${layout}'`), `${id} must use its distinct layout ID`);
  assert.ok(mapBlock, `${id} needs its ${worldMethod} map builder`);
  assert.ok(mapBlock.includes(`this.map = '${canonical}'`), `${id} builder must preserve canonical intel/weather key ${canonical}`);
  for (const token of objectiveTokens) assert.ok(defBlock.includes(token), `${id}: missing authored objective token ${token}`);
  for (const token of worldTokens) assert.ok(mapBlock.includes(token), `${id}: missing ${worldMethod} map token ${token}`);
  structuralResults.push(`${id}: PASS — ${layout} layout, ${canonical} archive key, authored objective chain, interactables, and LZ contract present`);
}
const firstTenMaps = firstTen.map((id) => MISSION_DEFS[id].map);
assert.equal(new Set(firstTenMaps).size, 10, 'the initially unlocked ten must use ten distinct campaign layout IDs');
assert.match(worldSrc, /map === 'recon_canyon'\) this\.buildReconCanyon/);
assert.match(worldSrc, /map === 'riverside_village'\) this\.buildRiversideVillage/);
assert.match(worldSrc, /map === 'canal_market'\) this\.buildCanalMarket/);
assert.match(worldSrc, /map === 'ridge_hold'\) this\.buildRidgeHold/);
assert.match(missionsSrc, /canCompleteExtraction\(\)/);
assert.match(gameSrc, /if \(this\.state !== GameState\.PLAYING \|\| this\._missionCompletionCommitted\) return false/);
assert.match(gameSrc, /this\._missionCompletionCommitted = true/);
assert.match(gameSrc, /this\.progress\.recordIntel\(map, idx\)/);
assert.match(missionsSrc, /this\.stage !== 'extract'\) return false/);
assert.match(missionsSrc, /this\.def\.flow === 'infil' && !g\.world\.terminalUsed/);
assert.match(gameSrc, /missionIndex >= 0 && !this\.missions\.canCompleteExtraction\(\)/);
assert.match(gameSrc, /missionId === 'range'\) return false/);
assert.match(missionsSrc, /this\.stage === 'extract' \|\| this\.stage === 'complete'/);

assert.match(enemiesSrc, /beginMissionRun\(missionId, spawnLimit = 30\)/);
assert.match(enemiesSrc, /spawnedThisRun >= this\.missionSpawnLimit/);
assert.equal((enemiesSrc.match(/new Enemy\(/g) || []).length, 3, 'all actual Enemy constructors must remain limited to the three existing creation paths');
assert.equal((enemiesSrc.match(/_spawnWithRunCap\(/g) || []).length, 4, 'the initial, vehicle-crew, and reinforcement paths must use the common cap gate');
assert.match(enemiesSrc, /this\.remainingMissionSpawns\);/);
assert.match(gameSrc, /id === 'range' \? 30 : getMissionMinEnemies\(missionIndex \+ 1\)/);
assert.match(gameSrc, /if \(wid === 'vx4'\)[\s\S]*?this\.weapons\.state\.vx4\.reserve = 0/);
assert.match(gameSrc, /reset\(\{ preserveMissionRun: true \}\)/, 'checkpoint retries must preserve the current run budget');
assert.match(enemiesSrc, /if \(!preserveMissionRun\) \{[\s\S]*?this\.spawnedThisRun = 0/);

assert.match(throwablesSrc, /VXFRAG_STOCK_MAX = 20/);
assert.match(throwablesSrc, /VXFRAG_MISSION_START = 20/);
assert.match(throwablesSrc, /Math\.max\(VXFRAG_MISSION_START, configuredFrags\)/);
assert.match(throwablesSrc, /Math\.max\(0, Math\.min\(VXFRAG_STOCK_MAX/);
assert.match(playerSrc, /this\.frags = VXFRAG_MISSION_START/);
assert.match(playerSrc, /Math\.min\(VXFRAG_STOCK_MAX/);
const vx4 = weaponsSrc.match(/vx4:\s*\{([\s\S]*?)\n  \},\n  mr7:/)?.[1] || '';
assert.match(vx4, /damage: 34/);
assert.match(vx4, /magSize: 300, startReserve: 0, reserveMax: 0, noReload: true/);
assert.match(weaponsSrc, /if \(def\.noReload\)[\s\S]*?Never enter a[\s\S]*?reload state/);
assert.match(weaponsSrc, /const ammoAvailable = Math\.max\(0, st\.mag\) \+ \(def\.noReload \? Math\.max\(0, st\.reserve\) : 0\)/);
assert.match(weaponsSrc, /this\.adsT > 0\.5 \|\| this\.zoomT > 0\.05 \|\| isSniper/);
assert.match(gameSrc, /case 'KeyY':[\s\S]*?inp\._zoomKey = !inp\._zoomKey/);
assert.match(gameSrc, /!\['KeyX', 'CapsLock', 'Semicolon', 'KeyU'\]\.includes\(s\.adsKey\)/);
assert.match(playerSrc, /if \(this\.onGround && this\.vel\.y < 0\) this\.vel\.y = 0/);
assert.match(playerSrc, /_recoverFromWorldBoundary\(\)/);
assert.match(physicsSrc, /this\._sweptMin/);
assert.match(physicsSrc, /const newMinY = oldMinY \+ dy/);
assert.match(enemiesSrc, /const MAX_ACTIVE_HOSTILES = 12/);
assert.match(enemiesSrc, /const ADVANCE = \{ facility: 8, range: 7/);
assert.match(musicSrc, /async diagnoseTracks\(\)/);
assert.match(htmlSrc, /id="btn-music-check"/);
assert.equal((htmlSrc.match(/id="set-music-track">[\s\S]*?<\/select>/)?.[0].match(/<option\b/g) || []).length, 3);
assert.equal((weaponsSrc.match(/g\.enemies\.damage\(bestEnemy, bestZone/g) || []).length, 2, 'the hitscan and projectile resolvers each contain one enemy-damage call');
assert.match(weaponsSrc, /if \(bestEnemy\) \{[\s\S]*?g\.enemies\.damage\(bestEnemy, bestZone,[\s\S]*?this\.dead = true;/, 'projectile hit is consumed after one damage application');
assert.match(weaponsSrc, /if \(hitKind === 'enemy' && bestEnemy\) \{[\s\S]*?g\.enemies\.damage\(bestEnemy, bestZone, dmg, point, dir\);[\s\S]*?break;/, 'one hitscan collision applies damage once and exits that ray pass');

assert.match(missionsSrc, /setMissionHelicopterAvailable\(ready\)/);
assert.match(vehiclesSrc, /this\.extractionLocked = this\.isHelicopter && this\.mission/);
assert.match(vehiclesSrc, /if \(v\.isHelicopter && v\.extractionLocked\)/);
assert.match(vehiclesSrc, /missionAircraftHidden/);
assert.match(gameSrc, /v\.isHelicopter && v\.extractionLocked/);

const presentAudio = expectedTracks.map(([, , file]) => file).filter((file) => existsSync(resolve(root, file.replace(/^\//, ''))));
assert.deepEqual(presentAudio, expectedTracks.map(([, , file]) => file), 'all three canonical MP3s must be present in assets/music');

console.log('PASS music registry: exactly 3 existing-ID mappings; selector/rotation/fallback validated');
console.log('PASS campaign progression behavior: 100+ missions; progressive unlock from Mission 1 onward; failure does not unlock next; prerequisite persists; range is separate');
for (const row of structuralResults) console.log(`PASS mission contract — ${row}`);
console.log('PASS spawn, grenade, damage-once, extraction, and helicopter gating source contracts');
console.log('PASS v3 contracts: 300-round continuous VX-4/HUD, Y zoom aim-ray path, swept fall collision/recovery, reduced live enemy pressure, and three-track file diagnostics');
console.log('PASS canonical soundtrack audio present:');
for (const file of presentAudio) console.log(`  PRESENT: ${file}`);
console.log('NOTE These are focused structural checks, not full in-browser mission play-throughs.');
