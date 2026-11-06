/* ============================================================================
 * sw.js — service worker for VEILSTRIKE
 *
 * Purpose: make the whole game available offline for single-player use.
 *
 * Design rules followed here:
 *  - Only ever intercepts SAME-ORIGIN, HTTP(S), GET requests.
 *  - Vercel platform routes (/_vercel, /api, /__*) are never intercepted, so
 *    normal online deployment keeps working exactly as before.
 *  - Navigations are network-first with an offline cache fallback, so an online
 *    visitor always gets the freshest HTML while an offline visitor still boots.
 *  - Static assets are cache-first (stale-while-revalidate): never break a
 *    resource that is already cached, even if the network fails.
 *  - The cache name is explicitly versioned; old versions are deleted on
 *    activate. Bump CACHE_VERSION to ship a new offline snapshot.
 *  - Update detection is user-driven: the page shows a banner and only reloads
 *    when the player chooses to, so a mission is never interrupted.
 *  - VERSION CONSISTENCY (Phase 11): stylesheets, JS modules and the manifest
 *    are version-critical — they must match the HTML that references them.
 *    Serving a stale style.css/js beside fresh HTML is what scattered the main
 *    menu after deployments, so those are network-first (cache fallback when
 *    offline). Only rarely-changing binary assets (icons, key art, audio)
 *    remain cache-first with background revalidation.
 * ==========================================================================*/

const CACHE_VERSION = 'v17.4.1-tacmap-interactive-20261105'; // v4.4: fully interactive tactical map (pan/zoom-to-cursor/follow/layers/selectable markers + inspector, floating resizable window) on top of v4.3: discrete click-to-fire input (js/fireinput.js) + data-driven tactical map (js/mapgeom.js) + v4.2 enemy AI, ammunition accounting and typed campaign ammo packs.
const CACHE_NAME = `obv-${CACHE_VERSION}`;
const SHELL = './index.html';

function isJavaScriptPath(value) {
  return /\.(?:js|mjs)$/i.test(new URL(value, self.location.href).pathname);
}

function hasJavaScriptMime(response) {
  const mime = (response && response.headers && response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  return mime === 'text/javascript' || mime === 'application/javascript';
}

/* Everything required for a complete offline single-player session. */
const PRECACHE = [
  './index.html',
  './css/base.css',
  './css/menu.css',
  './css/hud.css',
  './css/touch.css',
  './css/shell.css',
  './style.css',
  './manifest.webmanifest',

  './js/main.js',
  './js/pwa.js',
  './js/game.js',
  './js/player.js',
  './js/playerbody.js',
  './js/weapons.js',
  './js/ammo.js',
  './js/enemies.js',
  './js/enemy-soldier.js',
  './js/physics.js',
  './js/impacts.js',
  './js/world.js',
  './js/world-structures.js',
  './js/campaign-data.js',
  './js/campaign-maps.js',
  './js/environment.js',
  './js/geometry.js',
  './js/audio.js',
  './js/particles.js',
  './js/missions.js',
  './js/tacmap.js',
  './js/mapgeom.js',
  './js/fireinput.js',
  './js/map3d.js',
  './js/vehicles.js',
  './js/throwables.js',
  './js/loadout.js',
  './js/progress.js',
  './js/ui.js',
  './js/touch.js',
  './js/layout.js',
  './js/editor.js',
  './js/unlocks.js',
  './js/characters.js',
  './js/shield.js',
  './js/flashlight.js',
  './js/music.js',
  './js/basestrike.js',
  './js/soldier-rig.js',

  './assets/vendor/three.module.js',
  './assets/vendor/jsm/loaders/GLTFLoader.js',
  './assets/vendor/jsm/utils/BufferGeometryUtils.js',
  './assets/vendor/jsm/utils/SkeletonUtils.js',
  './assets/characters/vs_soldier.glb',

  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/maskable-192.png',
  './assets/icons/maskable-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon-32.png',
  './assets/environments/phase1-night-insertion.jpg',
  './assets/menu-wall.jpg',
  './assets/logo-veilstrike.jpg',
];

/* ---------------------------------------------------------------- install -- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Settle individually so one missing optional file cannot brick the install.
    const results = await Promise.allSettled(
      PRECACHE.map(async (url) => {
        const request = new Request(url, { cache: 'reload' });
        const response = await fetch(request);
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        // A host rewrite can return index.html with HTTP 200 for a missing
        // module. Never poison the versioned cache with that HTML response.
        if (isJavaScriptPath(url) && !hasJavaScriptMime(response)) {
          throw new Error(`invalid JavaScript MIME for ${url}: ${response.headers.get('content-type') || '(missing)'}`);
        }
        await cache.put(request, response);
      })
    );
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? PRECACHE[i] : null))
      .filter(Boolean);
    if (failed.length) {
      console.warn('[sw] precache incomplete, missing:', failed);
    } else {
      console.log(`[sw] precached ${PRECACHE.length} resources (${CACHE_NAME})`);
    }
    // Take control immediately so the very first load is already offline-capable.
    await self.skipWaiting();
  })());
});

/* --------------------------------------------------------------- activate -- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Remove every obsolete version of our cache (and only ours).
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('obv-') && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );
    // Refresh the shell so the offline entry point is current.
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.add(new Request(SHELL, { cache: 'reload' }));
    } catch (e) { /* offline during activate — cached copy stays */ }
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------------ fetch -- */
function isOwnRequest(url) {
  if (url.origin !== self.location.origin) return false;          // cross-origin
  if (!/^https?:$/.test(url.protocol)) return false;              // chrome/data/etc
  const p = url.pathname;
  // Never touch Vercel platform / reserved routes, and never shadow hidden files.
  if (p.startsWith('/_vercel') || p.startsWith('/api/') || p.startsWith('/__')) return false;
  if (p.startsWith('/.well-known/')) return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                                // no mutations
  const url = new URL(req.url);
  if (!isOwnRequest(url)) return;                                  // default handling
  // User-added music is network-only: never precache/intercept it. This lets the
  // browser send native HTTP Range requests and ensures newly added/replaced files
  // are not served from a stale service-worker cache. The host's MP3 rules revalidate.
  if (url.pathname.includes('/assets/music/')) return;

  const wantsHTML =
    req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  /* --- Navigations: network-first, fall back to the cached shell ---------- */
  if (wantsHTML) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok && fresh.type === 'basic') {
          const cache = await caches.open(CACHE_NAME);
          cache.put(SHELL, fresh.clone());
        }
        return fresh;
      } catch (err) {
        const cache = await caches.open(CACHE_NAME);
        return (
          (await cache.match(SHELL)) ||
          (await cache.match('./index.html')) ||
          new Response('Offline and no cached copy of the game is available.', {
            status: 503,
            statusText: 'Offline',
            headers: { 'Content-Type': 'text/plain' },
          })
        );
      }
    })());
    return;
  }

  /* --- Version-critical assets: network-first with cache fallback ----------
     style.css, every JS module and the manifest must stay in lockstep with
     the fresh HTML. Online they always come from the network (and refresh the
     cache); offline they fall back to the cached copy of THIS cache version.
     A stale file is never served while the network is reachable, so the menu
     markup and its stylesheet/scripts can no longer drift apart. */
  const versionCritical =
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.mjs') ||
    url.pathname.endsWith('.webmanifest');

  if (versionCritical) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok && fresh.type === 'basic') {
          if (isJavaScriptPath(url.pathname) && !hasJavaScriptMime(fresh)) {
            // Do not cache (or serve) a successful HTML fallback as executable
            // module source. A clear 502 avoids a misleading browser MIME error.
            console.error('[sw] module request returned non-JavaScript MIME:', url.pathname, fresh.headers.get('content-type'));
            return new Response('Module request returned a non-JavaScript response. Check the static hosting root and fallback rules.', {
              status: 502,
              statusText: 'Invalid module response',
              headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
            });
          }
          await cache.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        return (
          (await cache.match(req)) ||
          // Never substitute the HTML shell for a code file — a 504 is honest.
          new Response('', { status: 504, statusText: 'Offline' })
        );
      }
    })());
    return;
  }

  /* --- Binary assets: cache-first, revalidate in the background ----------- */
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(req);
    if (hit) {
      // Keep the cache warm while online; failure here is irrelevant because we
      // are already serving a valid cached response.
      fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
        })
        .catch(() => {});
      return hit;
    }
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      return (
        (await cache.match(SHELL)) ||
        new Response('', { status: 504, statusText: 'Offline' })
      );
    }
  })());
});

/* ---------------------------------------------------------------- message -- */
/* The page posts SKIP_WAITING when the player accepts an update. */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
