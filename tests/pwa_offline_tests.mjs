import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swSource = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
const results = [];
function check(name, fn) {
  try { fn(); results.push(true); console.log(`PASS ${name}`); }
  catch (error) { results.push(false); console.log(`FAIL ${name} — ${error.message}`); }
}

const precacheMatch = swSource.match(/const PRECACHE = (\[[\s\S]*?\]);/);
assert.ok(precacheMatch, 'service worker has explicit precache list');
const precache = JSON.parse(precacheMatch[1]);
check('release precache is versioned and includes all required modules, styles and runtime assets', () => {
  assert.match(swSource, /v17\.6\.0-single-soundtrack-offline-final-20261106/);
  assert.ok(precache.includes('./index.html'));
  assert.ok(precache.includes('./manifest.webmanifest'));
  assert.ok(precache.includes('./assets/music/FEARLESS-PT-II.mp3'));
  assert.ok(precache.includes('./assets/vendor/three.module.js'));
  for (const file of precache) assert.ok(fs.existsSync(path.join(root, file.slice(2))), `missing ${file}`);
});
check('only the bundled soundtrack is registered, present and precached with no music diagnostic requests', () => {
  const tracks = [...(fs.readFileSync(path.join(root, 'js/music.js'), 'utf8').matchAll(/file: ['"]([^'"]+\.mp3)['"]/g))].map((match) => match[1]);
  assert.deepEqual(tracks, ['/assets/music/FEARLESS-PT-II.mp3']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'assets/music')).filter((name) => name.endsWith('.mp3')), ['FEARLESS-PT-II.mp3']);
  assert.ok(precache.includes('./assets/music/FEARLESS-PT-II.mp3'));
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'js/music.js'), 'utf8'), /\bfetch\s*\(/);
  assert.doesNotMatch(html, /btn-music-check|FILES NOT CHECKED/);
  assert.doesNotMatch(html, /\bfetch\s*\(/, 'launch diagnostics must not issue an extra runtime request');
});
check('manifest icon variants and browser favicon paths exist', () => {
  for (const item of manifest.icons) {
    assert.ok(fs.existsSync(path.join(root, item.src.replace(/^\.\//, ''))), item.src);
    assert.match(item.sizes, /^(192|512)x\1$/);
  }
  for (const n of [16, 32, 48]) assert.ok(fs.existsSync(path.join(root, `assets/icons/favicon-${n}.png`)));
  assert.match(html, /assets\/icons\/favicon-16\.png/);
  assert.match(html, /assets\/icons\/favicon-32\.png/);
  assert.match(html, /assets\/icons\/favicon-48\.png/);
});
check('official logo appears at menu, loading, campaign select, pause, HUD and shell-avatar surfaces', () => {
  for (const snippet of ['loading-logo', 'menu-logo', 'campaign-logo', 'pause-logo', 'hud-brand', 'stb-ava']) assert.ok(html.includes(snippet), snippet);
  for (const snippet of ['assets/logo-veilstrike.jpg', 'assets/icons/favicon-48.png']) assert.ok(html.includes(snippet), snippet);
});
check('service worker installs atomically, keeps the current cache on failure, and waits for player consent', () => {
  assert.match(swSource, /await caches\.delete\(CACHE_NAME\);[\s\S]*?throw error/);
  assert.doesNotMatch(swSource.slice(swSource.indexOf("addEventListener('install'"), swSource.indexOf("addEventListener('activate'")), /skipWaiting\(\)/);
  assert.match(swSource, /cache\.match\(path\)/);
  assert.match(swSource, /self\.skipWaiting\(\)/);
});
check('controlled gameplay never falls through to runtime network; cache misses fail closed', () => {
  const fetchHandler = swSource.slice(swSource.indexOf("addEventListener('fetch'"));
  assert.match(fetchHandler, /const cached = await cache.match\(request/);
  assert.doesNotMatch(fetchHandler, /\bfetch\s*\(/, 'runtime fetch handler must not make a network request');
  assert.match(fetchHandler, /installed offline bundle/);
  assert.match(swSource, /Content-Range/);
});
check('online update checks, offline status, and mission-safe reload deferral are present', () => {
  const pwa = fs.readFileSync(path.join(root, 'js/pwa.js'), 'utf8');
  assert.match(pwa, /registration\.update\(\)/);
  assert.match(pwa, /addEventListener\('online'/);
  assert.match(pwa, /addEventListener\('offline'/);
  assert.match(pwa, /\['playing', 'paused', 'loading'\]/);
  assert.match(pwa, /updatePendingSafePoint/);
  assert.match(pwa, /OFFLINE · INSTALLED GAME READY/);
});

// Exercise worker install handlers in a small service-worker API harness. This
// verifies success/failure cache behavior, not browser installation or WebGL.
async function simulateInstall(failingSuffix = null) {
  const listeners = {};
  const stores = new Map([['obv-previous-good', new Map([['old', 'working']])]]);
  const cacheCalls = [];
  let skipWaitingCalls = 0;
  class MockRequest {
    constructor(url) { this.url = new URL(url, 'https://game.test/sw.js').href; this.headers = new Headers(); this.mode = 'same-origin'; this.method = 'GET'; }
  }
  class MockCache {
    constructor(name) { this.name = name; if (!stores.has(name)) stores.set(name, new Map()); this.data = stores.get(name); }
    async put(req, res) { this.data.set(req.url, res.clone()); }
    async match(req) { const url = req instanceof MockRequest ? req.url : new URL(req, 'https://game.test/sw.js').href; return this.data.get(url) || null; }
  }
  const caches = {
    async open(name) { cacheCalls.push(name); return new MockCache(name); },
    async delete(name) { return stores.delete(name); },
    async keys() { return [...stores.keys()]; },
  };
  const self = {
    location: { href: 'https://game.test/sw.js', origin: 'https://game.test' },
    clients: { claim: async () => {} },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => { skipWaitingCalls++; },
  };
  const mockFetch = async (req) => {
    const url = req.url || String(req);
    if (failingSuffix && url.endsWith(failingSuffix)) throw new Error('simulated interrupted network');
    return {
      ok: true, status: 200, type: 'basic', headers: new Headers({ 'content-type': url.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }),
      clone() { return this; }, async arrayBuffer() { return new ArrayBuffer(1); },
    };
  };
  const quietConsole = { info() {}, error() {} };
  const context = vm.createContext({ self, caches, fetch: mockFetch, Request: MockRequest, URL, Headers, Response, console: quietConsole, Promise });
  vm.runInContext(swSource, context, { filename: 'sw.js' });
  const wait = [];
  listeners.install({ waitUntil: (promise) => wait.push(promise) });
  const settled = await Promise.allSettled(wait);
  return { stores, settled, skipWaitingCalls, cacheCalls };
}

const good = await simulateInstall();
check('mocked SW install caches all required assets without skipWaiting and preserves previous cache until activation', () => {
  assert.equal(good.settled[0].status, 'fulfilled');
  const current = [...good.stores.keys()].find((key) => key.startsWith('obv-v17.6.0'));
  assert.ok(current);
  assert.equal(good.stores.get(current).size, precache.length);
  assert.ok(good.stores.has('obv-previous-good'));
  assert.equal(good.skipWaitingCalls, 0);
});
const broken = await simulateInstall('assets/vendor/three.module.js');
check('mocked interrupted install deletes incomplete new cache and leaves previous version usable', () => {
  assert.equal(broken.settled[0].status, 'rejected');
  assert.ok(broken.stores.has('obv-previous-good'));
  assert.equal([...broken.stores.keys()].some((key) => key.startsWith('obv-v17.6.0')), false);
  assert.equal(broken.skipWaitingCalls, 0);
});

const failed = results.filter((passed) => !passed).length;
console.log(`\nPWA/offline static + mocked checks: ${results.length - failed} passed, ${failed} failed.`);
if (failed) process.exitCode = 1;
