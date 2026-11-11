/* VEILSTRIKE atomic, versioned offline shell. Release: 2026-11-06. */
const CACHE_VERSION = 'v17.6.0-single-soundtrack-offline-final-20261106';
const CACHE_NAME = `obv-${CACHE_VERSION}`;
const CACHE_PREFIX = 'obv-';
const SHELL = './index.html';
const PRECACHE = [
  "./index.html",
  "./manifest.webmanifest",
  "./style.css",
  "./css/base.css",
  "./css/hud.css",
  "./css/menu.css",
  "./css/shell.css",
  "./css/touch.css",
  "./js/ammo.js",
  "./js/audio.js",
  "./js/basestrike.js",
  "./js/campaign-data.js",
  "./js/campaign-maps.js",
  "./js/characters.js",
  "./js/editor.js",
  "./js/enemies.js",
  "./js/enemy-soldier.js",
  "./js/environment.js",
  "./js/fireinput.js",
  "./js/flashlight.js",
  "./js/game.js",
  "./js/geometry.js",
  "./js/impacts.js",
  "./js/layout.js",
  "./js/loadout.js",
  "./js/main.js",
  "./js/map3d.js",
  "./js/mapgeom.js",
  "./js/missions.js",
  "./js/music.js",
  "./js/particles.js",
  "./js/physics.js",
  "./js/player.js",
  "./js/playerbody.js",
  "./js/progress.js",
  "./js/pwa.js",
  "./js/shield.js",
  "./js/soldier-rig.js",
  "./js/tacmap.js",
  "./js/throwables.js",
  "./js/touch.js",
  "./js/ui.js",
  "./js/unlocks.js",
  "./js/vehicles.js",
  "./js/weapons.js",
  "./js/world-structures.js",
  "./js/world.js",
  "./assets/characters/vs_soldier.glb",
  "./assets/environments/phase1-night-insertion.jpg",
  "./assets/icons/apple-touch-icon.png",
  "./assets/icons/favicon-16.png",
  "./assets/icons/favicon-32.png",
  "./assets/icons/favicon-48.png",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/maskable-192.png",
  "./assets/icons/maskable-512.png",
  "./assets/logo-veilstrike.jpg",
  "./assets/menu-wall.jpg",
  "./assets/music/FEARLESS-PT-II.mp3",
  "./assets/vendor/jsm/loaders/GLTFLoader.js",
  "./assets/vendor/jsm/utils/BufferGeometryUtils.js",
  "./assets/vendor/jsm/utils/SkeletonUtils.js",
  "./assets/vendor/three.module.js"
];

const isScript = (url) => /\.(?:js|mjs)$/i.test(new URL(url, self.location.href).pathname);
const jsMimeOk = (response) => {
  const mime = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  return mime === 'text/javascript' || mime === 'application/javascript';
};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      // Install is atomic: one missing/invalid required file rejects install;
      // the browser keeps the current active worker and its cache untouched.
      for (const path of PRECACHE) {
        const request = new Request(path, { cache: 'reload' });
        const response = await fetch(request);
        if (!response.ok || response.type !== 'basic') throw new Error(`${path}: HTTP ${response.status}`);
        if (isScript(path) && !jsMimeOk(response)) throw new Error(`${path}: invalid JavaScript MIME`);
        await cache.put(request, response);
      }
      const missing = [];
      for (const path of PRECACHE) if (!(await cache.match(path))) missing.push(path);
      if (missing.length) throw new Error(`incomplete install cache: ${missing.join(', ')}`);
      console.info(`[sw] complete ${CACHE_VERSION} (${PRECACHE.length} assets)`);
      // Deliberately do not skipWaiting here. Updates wait for player consent.
    } catch (error) {
      await caches.delete(CACHE_NAME);
      console.error('[sw] atomic install failed; previous version retained', error);
      throw error;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // This worker only activates after its complete install succeeded.
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

function rangeResponse(response, rangeHeader) {
  if (!rangeHeader || !/^bytes=\d*-\d*$/.test(rangeHeader)) return response;
  return response.arrayBuffer().then((buffer) => {
    const size = buffer.byteLength;
    const match = rangeHeader.slice(6).split('-');
    let start = match[0] ? Number(match[0]) : Math.max(0, size - Number(match[1] || 0));
    let end = match[1] ? Number(match[1]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    end = Math.min(end, size - 1);
    const headers = new Headers(response.headers);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    headers.set('Content-Length', String(end - start + 1));
    return new Response(buffer.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
  });
}

function isOwnRequest(url) {
  if (url.origin !== self.location.origin || !/^https?:$/.test(url.protocol)) return false;
  const path = url.pathname;
  return !(path.startsWith('/_vercel') || path.startsWith('/api/') || path.startsWith('/__') || path.startsWith('/.well-known/'));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!isOwnRequest(url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) {
      if (request.headers.has('range')) return rangeResponse(cached, request.headers.get('range'));
      return cached;
    }

    // A controlled game session never falls through to the network. All
    // runtime resources are required in the verified precache; a missing key
    // is an honest package error rather than a hidden online dependency.
    if (request.mode === 'navigate') {
      const shell = await cache.match(SHELL) || await cache.match('./index.html');
      if (shell) return shell;
    }
    return new Response('VEILSTRIKE resource is not present in the installed offline bundle.', {
      status: 504, statusText: 'Offline resource missing',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data && event.data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
  }
});
