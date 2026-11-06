#!/usr/bin/env node
/**
 * browser_map_tests.mjs — the v4.4 tactical map, driven in a real browser.
 *
 * The headless suite (tests/tacmap_tests.mjs) proves the map's data and maths are
 * right. It cannot prove the thing a player actually experiences: that a wheel tick
 * lands the map under the cursor on a real compositor, that the panel survives a
 * phone viewport at dpr 3, that a pinch with two real touch points zooms, that no CSS
 * rule resamples the canvas, and that nothing in the console screams while it happens.
 * This file does that, in Chromium, over six environments (desktop 1080p, HiDPI
 * laptop, narrow laptop, ultrawide, tablet touch, phone touch) on six different
 * campaign maps, and writes screenshots to reports/browser/ for a human to look at.
 *
 * It needs Playwright + a Chromium build. Resolution order:
 *   1. $VEIL_PLAYWRIGHT          (a directory that contains node_modules/playwright)
 *   2. /home/user/browsertest    (the local test rig used while building v4.4)
 *   3. a bare `playwright` import from this project's own node_modules
 * A Chromium that cannot start (no libs, no sandbox permission) is reported as a SKIP
 * with exit code 0, so `tests/run_all_suites.sh` stays green on machines without a
 * browser - the headless suite remains the shipped contract. When a browser IS
 * available this file must pass, and it is the evidence behind the v4.4 report.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'reports', 'browser');
const require2 = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// playwright + chromium discovery
// ---------------------------------------------------------------------------
async function findPlaywright() {
  const dirs = [process.env.VEIL_PLAYWRIGHT, '/home/user/browsertest', ROOT].filter(Boolean);
  for (const d of dirs) {
    for (const cand of [path.join(d, 'node_modules', 'playwright'), path.join(d, 'playwright')]) {
      try {
        if (!fs.existsSync(cand)) continue;
        const mod = await import(cand.endsWith('.js') || fs.statSync(cand).isFile() ? cand : path.join(cand, 'index.mjs'));
        if (mod.chromium) return mod;
      } catch { /* try the next candidate */ }
    }
    try {
      const p = require2.resolve('playwright', { paths: [d] });
      const mod = await import('file://' + p);
      if (mod.chromium) return mod;
    } catch { /* not there */ }
  }
  try { const mod = await import('playwright'); if (mod.chromium) return mod; } catch { /* nope */ }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

function serve(root) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) {
      res.writeHead(403); res.end('no'); return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('missing ' + rel); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(0, '0.0.0.0', () => resolve({ server, port: server.address().port })));
}

// ---------------------------------------------------------------------------
// environments: five viewports/inputs is the floor; six maps is the coverage
// ---------------------------------------------------------------------------
const ONLY = (process.env.VEIL_BROWSER_ENV || '').split(',').map((s) => s.trim()).filter(Boolean);
const ENVS = [
  { name: 'desktop-1080p', mission: 'facility', viewport: { width: 1920, height: 1080 }, dpr: 1, touch: false,
    why: 'the default desktop case: the map fills a big box, so the old 1024 px backing-store cap would have been visible immediately' },
  { name: 'hidpi-laptop', mission: 'desert', viewport: { width: 1440, height: 900 }, dpr: 2, touch: false,
    why: 'devicePixelRatio 2: labels and 1 px structure edges must stay hairline, not resampled' },
  { name: 'narrow-laptop', mission: 'urban', viewport: { width: 1024, height: 640 }, dpr: 1, touch: false,
    why: 'short viewport: the toolbar wraps, the canvas must keep the room and the cards must not cover the legend' },
  { name: 'ultrawide', mission: 'snow', viewport: { width: 2560, height: 1080 }, dpr: 1, touch: false,
    why: 'wider than any cap: proves the canvas is sized to its box (2560 px) and the aspect stretch is not squashing the metres' },
  { name: 'tablet-touch', mission: 'recon_desert', viewport: { width: 1024, height: 768 }, dpr: 2, touch: true,
    why: 'touch: one finger pans, two fingers pinch, and the browser must not scroll or select underneath' },
  // isMobile is deliberately off here. Chrome's mobile-viewport emulation rewrites input
  // coordinates and drops a 2-point touch sequence, which made *mouse* clicks land on the
  // wrong feature and the pinch never reach the page - a property of the emulation, not of
  // the map (verified: the same CDP touch reaches the canvas early in the run and is
  // dropped later, and selectAt() at the identical point selects the right marker).
  // Phone-ness that the map actually has to survive is the box, the dpr and touch input.
  { name: 'phone-touch', mission: 'sabotage_industrial', viewport: { width: 412, height: 915 }, dpr: 3, touch: true,
    why: 'the worst case for chrome: 412 px wide, dpr 3, dense industrial geometry, touch input' },
];

// ---------------------------------------------------------------------------
const checks = [];
function t(env, label, ok, detail) {
  checks.push({ env, label, ok: !!ok, detail: detail == null ? '' : String(detail) });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark} ${env} · ${label}${detail ? ' — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The view eases on the frame loop; after a gesture, let it converge (the same
 *  maths the rAF handler runs) so the assertion reads the settled view, not a frame
 *  that headless Chromium may not have scheduled yet. */
const settlePage = (page, n = 40) => page.evaluate((k) => {
  const tm = window.__vs.tacmap;
  // The easing is driven by the wall clock, and headless Chromium commits almost no
  // frames (~0.5 rAF/s measured), so step a clock that runs at 60 Hz for the loop.
  // This is the same maths a real display performs; nothing on the map is stubbed.
  const real = performance.now.bind(performance);
  let t = real();
  performance.now = () => (t += 1000 / 60);
  try { for (let i = 0; i < k; i++) { tm._animateView(); if (tm._animating) tm._syncControls(); } }
  finally { performance.now = real; }
  tm.drawFull();
  return { zoom: tm.zoom, zoomT: tm._zoomT };
}, n);
/** Screenshots are evidence and they ship inside the standalone zip: JPEG at 82. */
/**
 * A point the browser will actually hit, verified twice against the live layout.
 * `fn` runs in the page and returns { x, y, ...meta, cv } where cv is the map canvas box.
 * The stage reflows when the inspector card opens (the canvas is a flex sibling), so a
 * point derived from a stale rect lands on the legend - or on a different marker. Recompute,
 * wait, recompute, and only then drive the mouse or finger at it; `onCanvas` proves the
 * point belongs to the map at that moment.
 */
const stablePoint = async (page, fn, tries = 4) => {
  let prev = null;
  for (let k = 0; k < tries; k++) {
    const cur = await page.evaluate(fn);
    if (!cur) return null;
    if (!cur.cv) return { ...cur, stable: true, onCanvas: true };
    cur.onCanvas = await page.evaluate((pt) => {
      const cv = document.getElementById('tacmap-canvas');
      return !!cv && document.elementFromPoint(Math.round(pt.x), Math.round(pt.y)) === cv;
    }, cur);
    const same = prev && prev.cv && Math.abs(cur.cv.l - prev.cv.l) < 1 && Math.abs(cur.cv.t - prev.cv.t) < 1
      && Math.abs(cur.cv.w - prev.cv.w) < 1 && Math.abs(cur.cv.h - prev.cv.h) < 1;
    if (same && cur.onCanvas) return { ...cur, stable: true };
    prev = cur;
    await new Promise((r) => setTimeout(r, 160));
  }
  return prev ? { ...prev, stable: false } : null;
};

const shot = (page, env, what) => page.screenshot({ path: path.join(OUT, `${env.name}-${what}.jpg`), type: 'jpeg', quality: 82 });

async function runEnv(browser, env, base) {
  const ctx = await browser.newContext({
    viewport: env.viewport, deviceScaleFactor: env.dpr, hasTouch: !!env.touch, isMobile: !!env.mobile,
    reducedMotion: 'no-preference', colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  // One CDP session does double duty: it configures touch emulation for the mobile
  // environment (Chrome defaults that to a single touch point, which silently drops a
  // two-finger sequence before it reaches JS - so "pinch" would assert nothing) and it
  // delivers the gestures. Re-using it matters: a second session reset the touch config.
  const input = await ctx.newCDPSession(page);
  const maxTouch = env.mobile ? 5 : (env.touch ? 5 : 0);
  if (env.touch) await input.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: maxTouch });
  const touchSend = async (type, pts) => input.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: (pts || []).map((q) => ({ x: Math.round(q.x), y: Math.round(q.y), id: q.id })),
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e && e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('requestfailed', (r) => { if (!/favicon/.test(r.url())) errors.push('requestfailed: ' + r.url()); });

  try {
    // ?vsdebug is the shipped opt-in that publishes the game instance on window.__vs
    // (js/game.js:283) - the probes read real runtime state through it, never a stub.
    // ?vsnorender skips GL submission: this suite measures the 2D map canvas, and on a
    // software-GL rig rasterising a 1080p FPS scene every frame costs minutes of CPU.
    // The 3D map mode is still exercised (its stage, camera and data), just not painted.
    await page.goto(base + '/index.html?vsdebug&vsnorender', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('!!(window.__vs && window.__vs.player)', null, { timeout: 90000 });
    // unlock the campaign for this context only, then deploy the map under test
    await page.evaluate(() => {
      const g = window.__vs;
      for (const id of ['facility', 'desert', 'urban', 'snow', 'recon_desert', 'sabotage_industrial']) {
        g.progress.data.missions[id] = { completed: true, rating: 3, xp: 100 };
      }
    });
    await page.evaluate(async (m) => { await window.__vs.startMission(m); }, env.mission);
    await page.waitForFunction('window.__vs.state === "playing"', null, { timeout: 90000 });
    await sleep(400);
    const started = await page.evaluate(() => ({
      state: String(window.__vs.state),
      mission: (window.__vs.missions && window.__vs.missions.missionId) || null,
      map: (window.__vs.world && (window.__vs.world.mapName || window.__vs.world.name)) || null,
    }));
    t(env.name, 'mission deployed', started.state === 'playing' && started.mission === env.mission,
      `${env.mission}: state ${started.state}, world ${started.map || 'n/a'}`);

    // ---- open the map through the keyboard, the way a player does
    await page.keyboard.press('KeyM');
    await page.waitForFunction("!!document.getElementById('tacmap') && !document.getElementById('tacmap').classList.contains('hidden')", null, { timeout: 8000 });
    await sleep(180);
    const openState = await page.evaluate(() => ({
      open: window.__vs.tacmap.open,
      panel: document.getElementById('tacmap').getBoundingClientRect(),
      geo: (() => { const c = document.getElementById('tacmap-canvas'); const r = c.getBoundingClientRect(); return { w: c.width, h: c.height, cw: r.width, ch: r.height }; })(),
      zoom: window.__vs.tacmap.zoom, fit: window.__vs.tacmap.fitZoom(),
    }));
    t(env.name, 'M opens the map', openState.open === true, `panel ${Math.round(openState.panel.width)}x${Math.round(openState.panel.height)} in a ${env.viewport.width}x${env.viewport.height} viewport`);
    // hit test: the map must be the thing the browser sees under the cursor. This is
    // the check that catches a pointer-events override swallowing the whole overlay -
    // the defect that made v4.3's map look interactive in tests and not in the game.
    const hitTest = await page.evaluate(() => {
      const cv = document.getElementById('tacmap-canvas');
      const r = cv.getBoundingClientRect();
      const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 40, r.top + 40], [r.right - 60, r.bottom - 60]];
      return pts.map(([x, y]) => {
        const el = document.elementFromPoint(Math.round(x), Math.round(y));
        return { at: `${Math.round(x)},${Math.round(y)}`, got: el ? (el.id || el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]) : 'nothing', canvas: !!el && el === cv };
      });
    });
    t(env.name, 'the map viewport receives real pointer input', hitTest.every((h) => h.canvas),
      hitTest.map((h) => `${h.at} -> ${h.got}`).join('  '));
    const edpr = Math.min(2, env.dpr);        // MAP_RENDER_CAP in _sizeCanvas
    // A counter the touch checks read before/after every gesture, so a failure can say
    // whether the browser delivered the touch at all or the map ignored it.
    await page.evaluate(() => {
      window.__tv = { pointerdown: 0, touchstart: 0, pointerup: 0, type: '' };
      const cv = document.getElementById('tacmap-canvas');
      cv.addEventListener('pointerdown', (e) => { window.__tv.pointerdown++; window.__tv.type = e.pointerType; }, true);
      cv.addEventListener('pointerup', () => { window.__tv.pointerup++; }, true);
      cv.addEventListener('touchstart', () => { window.__tv.touchstart++; }, true);
    });
    if (env.touch) {
      const before = await page.evaluate(() => ({ ...window.__tv }));
      const pt = await page.evaluate(() => { const r = document.getElementById('tacmap-canvas').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
      await touchSend('touchStart', [{ x: pt.x, y: pt.y, id: 91 }]);
      await sleep(60);
      await touchSend('touchEnd', []);
      const after = await page.evaluate(() => ({ ...window.__tv }));
      t(env.name, 'a raw touch pointer reaches the map canvas', after.pointerdown > before.pointerdown && after.type === 'touch',
        `touch at ${pt.x},${pt.y}: canvas saw pointerdown ${after.pointerdown - before.pointerdown}, touchstart ${after.touchstart - before.touchstart} (pointerType "${after.type}")`);
    }

    const want = { w: Math.round(openState.geo.cw * edpr), h: Math.round(openState.geo.ch * edpr) };
    t(env.name, 'backing store is the CSS box x devicePixelRatio',
      Math.abs(openState.geo.w - want.w) <= 2 && Math.abs(openState.geo.h - want.h) <= 2,
      `${openState.geo.w}x${openState.geo.h} device px for a ${Math.round(openState.geo.cw)}x${Math.round(openState.geo.ch)} CSS box at dpr ${env.dpr}`
      + (edpr < env.dpr ? ` (the map renders at 2x on a 3x phone: no legibility gain, 2.25x the fill rate)` : ''));
    t(env.name, 'fit frames the whole mission area', openState.zoom <= openState.fit + 1e-6 && openState.zoom > 0,
      `zoom ${openState.zoom.toFixed(3)} = fit ${openState.fit.toFixed(3)}`);

    // ---- what is actually on the pixels
    const paint = await page.evaluate(() => {
      const cv = document.getElementById('tacmap-canvas');
      const ctx = cv.getContext('2d');
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const colors = new Map(); const pal = ['#0d1218', '#080b0f', '#1f2830', '#24313c', '#2b2318', '#1c2f39', '#151d24', '#1e1b24', '#111820', '#18222b', '#1d2a34', '#161f27', '#1b242d', '#101922', '#202b33', '#54677a', '#3ddc84', '#e8b64a', '#37b8d9', '#ff5c47', '#6fa8ff', '#cfe0e6', '#0d1218', '#3d4a55'];
      const parse = pal.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
      let sum = 0, sq = 0, alphaBad = 0, nearPal = 0, n = 0;
      const step = Math.max(4, Math.floor(4096 / cv.width)) * 4;   // sample a dense grid, not every pixel
      for (let i = 0; i < d.length; i += step) {
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        if (a < 250) alphaBad++;
        const q = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        colors.set(q, (colors.get(q) || 0) + 1);
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sum += lum; sq += lum * lum; n++;
        let best = 1e9;
        for (const p of parse) { const dr = r - p[0], dg = g - p[1], db = b - p[2]; const e = dr * dr + dg * dg + db * db; if (e < best) best = e; }
        if (best < 40 * 40) nearPal++;
      }
      const mean = sum / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
      return { distinct: colors.size, mean, sd, alphaBad, nearPalFrac: nearPal / n, sampled: n };
    });
    t(env.name, 'the map is painted, not blank or transparent', paint.distinct >= 10 && paint.alphaBad === 0,
      `${paint.distinct} distinct colours over ${paint.sampled} samples, ${paint.alphaBad} non-opaque`);
    t(env.name, 'contrast stays in the field-manual range', paint.mean > 8 && paint.mean < 130 && paint.sd > 4.5,
      `mean luminance ${paint.mean.toFixed(1)}, std dev ${paint.sd.toFixed(1)}`);
    t(env.name, 'no resampling: pixels come from the map palette', paint.nearPalFrac > 0.7,
      `${(paint.nearPalFrac * 100).toFixed(1)}% of samples within 40/255 of a declared map colour`);

    // ---- wheel / trackpad zoom. Two things are asserted separately, because they are
    // two different rules: at fit zoom an axis the whole mission fits inside is
    // centre-locked on purpose (the map cannot drift off the mission, so the anchor has
    // nowhere to go), and only once the view is narrower than the mission does the
    // cursor become the pivot.
    const box = await page.locator('#tacmap-canvas').boundingBox();
    const cursor = { x: Math.round(box.x + box.width * 0.34), y: Math.round(box.y + box.height * 0.42) };
    const atFit = await page.evaluate((c) => {
      const tm = window.__vs.tacmap;
      const r = tm.fullCv.getBoundingClientRect();
      const local = { x: Math.round(c.x - r.left), y: Math.round(c.y - r.top) };
      const w0 = tm._screenToWorld(local.x, local.y, tm._view());
      return { local, w0, z0: tm.zoom, centreX: window.__vs.player.pos.x + tm.panX, centreZ: window.__vs.player.pos.z + tm.panY };
    }, cursor);
    await page.mouse.move(cursor.x, cursor.y);
    const wheelEv = await page.evaluate(() => {
      const cv = document.getElementById('tacmap-canvas');
      const r = cv.getBoundingClientRect();
      const e = new WheelEvent('wheel', { deltaY: -120, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true });
      cv.dispatchEvent(e);
      return { prevented: e.defaultPrevented, zoomT: window.__vs.tacmap._zoomT };
    });
    await page.mouse.wheel(0, -300);
    await sleep(140); await settlePage(page);
    const atFitAfter = await page.evaluate((a) => {
      const tm = window.__vs.tacmap;
      const now = tm._screenToWorld(a.local.x, a.local.y, tm._view());
      const m = tm._viewMetrics(); const b = tm.geom.bounds; const air = 18;
      const halfX = m.w / 2 / (4 * tm.zoom), halfZ = m.h / 2 / (4 * tm.zoom);
      const lockedX = halfX > (b.maxX - b.minX) / 2 + air, lockedZ = halfZ > (b.maxZ - b.minZ) / 2 + air;
      const cx = window.__vs.player.pos.x + tm.panX, cz = window.__vs.player.pos.z + tm.panY;
      return {
        zoom: tm.zoom, slide: Math.hypot(now.x - a.w0.x, now.z - a.w0.z) * 4 * tm.zoom,
        lockedX, lockedZ, readout: document.getElementById('tac-zoomval').textContent,
        heldX: !lockedX || Math.abs(cx - (b.minX + b.maxX) / 2) < 0.6,
        heldZ: !lockedZ || Math.abs(cz - (b.minZ + b.maxZ) / 2) < 0.6,
        centre: { x: +cx.toFixed(1), z: +cz.toFixed(1) },
        missionC: { x: +((b.minX + b.maxX) / 2).toFixed(1), z: +((b.minZ + b.maxZ) / 2).toFixed(1) },
      };
    }, atFit);
    t(env.name, 'wheel zoom magnifies the map', atFitAfter.zoom > atFit.z0 * 1.05,
      `${atFit.z0.toFixed(2)}x -> ${atFitAfter.zoom.toFixed(2)}x from a -300 wheel at the cursor; readout "${atFitAfter.readout}"`);
    t(env.name, 'the wheel is not also a page scroll', wheelEv.prevented === true, 'the map calls preventDefault on the wheel event');
    t(env.name, 'the zoom readout tracks the eased view', /\d/.test(atFitAfter.readout)
      && atFitAfter.readout === atFitAfter.zoom.toFixed(atFitAfter.zoom < 1 ? 2 : 1) + '\u00d7',
      `readout "${atFitAfter.readout}" against zoom ${atFitAfter.zoom.toFixed(3)}x - the readout is refreshed while the view eases, not only on press`);
    t(env.name, 'an axis the whole mission fits inside stays centred', atFitAfter.heldX && atFitAfter.heldZ,
      `centre-lock holds on ${[atFitAfter.lockedX && 'X', atFitAfter.lockedZ && 'Z'].filter(Boolean).join('+') || 'no axis'} at ${atFitAfter.zoom.toFixed(2)}x; view centre ${atFitAfter.centre.x},${atFitAfter.centre.z} vs mission ${atFitAfter.missionC.x},${atFitAfter.missionC.z}`);

    // now push past the lock on both axes and assert the cursor really is the pivot
    const deep = await page.evaluate(() => {
      const tm = window.__vs.tacmap;
      const m = tm._viewMetrics(); const b = tm.geom.bounds; const air = 18;
      const need = Math.max(m.w / ((b.maxX - b.minX + 2 * air) * 4), m.h / ((b.maxZ - b.minZ + 2 * air) * 4)) * 1.08;
      tm._setView(Math.max(tm._zoomT, need), tm._panXT, tm._panYT, { instant: true });
      return { zoom: tm.zoom, need };
    });
    const anchor = await page.evaluate((c) => {
      const tm = window.__vs.tacmap;
      const r = tm.fullCv.getBoundingClientRect();
      const local = { x: Math.round(c.x - r.left), y: Math.round(c.y - r.top) };
      return { local, w0: tm._screenToWorld(local.x, local.y, tm._view()) };
    }, cursor);
    await page.mouse.wheel(0, -240);
    await sleep(140); await settlePage(page);
    const anchored = await page.evaluate((a) => {
      const tm = window.__vs.tacmap;
      const now = tm._screenToWorld(a.local.x, a.local.y, tm._view());
      return { slide: Math.hypot(now.x - a.w0.x, now.z - a.w0.z) * 4 * tm.zoom, zoom: tm.zoom };
    }, anchor);
    t(env.name, 'zoom pivots on the world point under the cursor', anchored.slide < 4,
      `at ${deep.zoom.toFixed(2)}x -> ${anchored.zoom.toFixed(2)}x (deeper than the centre-lock, ${deep.need.toFixed(2)}x) the point under the pointer moved ${anchored.slide.toFixed(2)} px`);

    // ---- clamps
    const clamps = await page.evaluate(() => {
      const tm = window.__vs.tacmap;
      const step = (dir, n) => { for (let i = 0; i < n; i++) tm.zoomBy(dir, null); return { t: tm._zoomT, z: tm.zoom }; };
      const rawLo = step(1 / 1.45, 40);
      const rawHi = step(1.45, 90);
      return { rawLo, rawHi, min: tm.minZoom, max: tm.maxZoom };
    });
    await settlePage(page);
    const clamped = await page.evaluate(() => ({ lo: window.__vs.tacmap.zoom, hi: window.__vs.tacmap._zoomT, z: window.__vs.tacmap.zoom }));
    t(env.name, 'zoom clamps hold at both ends', Math.abs(clamps.rawLo.t - clamps.min) < 1e-6 && Math.abs(clamps.rawHi.t - clamps.max) < 1e-6
      && Math.abs(clamped.lo - clamps.max) < 1e-6,
      `target reached ${clamps.rawLo.t} / ${clamps.rawHi.t} against ${clamps.min}..${clamps.max}, and the view settled onto the clamp (${clamped.lo.toFixed(2)}x)`);
    // ---- pan: drag is 1:1, and the mission cannot be pushed off-screen
    const panProbe = await page.evaluate(() => {
      const tm = window.__vs.tacmap;
      const settle = (n) => {
        const real = performance.now.bind(performance);
        let k = real();
        performance.now = () => (k += 1000 / 60);
        try { for (let i = 0; i < n; i++) tm._animateView(); } finally { performance.now = real; }
      };
      tm.recenter('fit'); settle(30);
      tm.zoomBy(2.5, null); settle(40);
      const p = tm._worldToScreen(window.__vs.player.pos.x, window.__vs.player.pos.z, tm._view());
      const m = tm._viewMetrics(); const b = tm.geom.bounds; const air = 18;
      // How far each axis can actually travel from where the view sits now, in screen px:
      // the mission cannot be pushed out of the viewport, so a drag is truncated by the
      // boundary - and when the whole mission already fits an axis the limit is negative and
      // that axis is centre-locked. Expect exactly that, not a blind 1:1.
      const roomX = Math.max(0, ((b.maxX - b.minX) / 2 + air) - m.w / 2 / (4 * tm.zoom)) * 4 * tm.zoom;
      const roomZ = Math.max(0, ((b.maxZ - b.minZ) / 2 + air) - m.h / 2 / (4 * tm.zoom)) * 4 * tm.zoom;
      return {
        p, zoom: tm.zoom, pan: { x: tm._panXT, y: tm._panYT },
        wantX: Math.min(90, roomX), wantZ: Math.min(60, roomZ),
        lockedX: roomX < 1, lockedZ: roomZ < 1,
      };
    });
    const centre = await stablePoint(page, () => {
      const r = window.__vs.tacmap.fullCv.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, cv: { l: r.left, t: r.top, w: r.width, h: r.height } };
    });
    const from = { x: Math.round(centre.x), y: Math.round(centre.y) };
    const who = await page.evaluate((pt) => {
      const chain = document.elementsFromPoint(pt.x, pt.y).slice(0, 3)
        .map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : ''}`);
      return { chain, tv: { ...window.__tv }, cv: (() => { const r = document.getElementById('tacmap-canvas').getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })() };
    }, from);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    const dPanSeen = await page.evaluate((b) => window.__tv.pointerdown - b, who.tv.pointerdown).catch(() => 0);
    await page.mouse.move(from.x + 90, from.y - 60, { steps: 8 });
    await page.mouse.up();
    await sleep(120); await settlePage(page);
    const panAfter = await page.evaluate(() => {
      const tm = window.__vs.tacmap;
      const s = tm._worldToScreen(window.__vs.player.pos.x, window.__vs.player.pos.z, tm._view());
      return { s, drag: !!tm._drag, cls: tm.fullCv.className, sel: tm.selected && tm.selected.key, moved: { px: tm._panXT, py: tm._panYT } };
    });
    const movedPx = Math.hypot(panAfter.s.x - panProbe.p.x, panAfter.s.y - panProbe.p.y);
    const dPan = { x: (panAfter.moved.px - panProbe.pan.x) * 4 * panProbe.zoom, y: (panAfter.moved.py - panProbe.pan.y) * 4 * panProbe.zoom };
    // A wide viewport can show the mission's full width at once; on that axis the view is
    // centre-locked by design (the map cannot slide off the mission), so the drag must move
    // 0 px there and exactly 1:1 on every axis that is free.
    const wantX = -Math.round(panProbe.wantX * 10) / 10, wantZ = Math.round(panProbe.wantZ * 10) / 10;
    t(env.name, 'drag pans 1:1 on every free axis, and a centre-locked axis stays put',
      Math.abs(dPan.x - wantX) <= 2 && Math.abs(dPan.y - wantZ) <= 2 && !panAfter.drag,
      `a 90,-60 px drag from ${from.x},${from.y} moved the view ${dPan.x.toFixed(1)},${dPan.y.toFixed(1)} px (want ${wantX},${wantZ} - that is the drag truncated by the mission boundary, not a dead axis); `
      + `screen movement ${movedPx.toFixed(1)} px; centre-lock on ${[panProbe.lockedX && 'X', panProbe.lockedZ && 'Z'].filter(Boolean).join('+') || 'neither axis'}; press reached the map: ${dPanSeen} pointerdown; owner chain ${who.chain.join(' > ')}; canvas box ${who.cv.l},${who.cv.t} ${who.cv.w}x${who.cv.h}; released cleanly${env.touch ? ' from touch pointer events' : ''}`);
    const farPan = await page.evaluate(() => {
      const tm = window.__vs.tacmap;
      const b = tm.geom.bounds;
      for (let i = 0; i < 80; i++) tm._panByPx(700, 700);
      for (let i = 0; i < 20; i++) tm._animateView();
      const v = tm._view();
      const c = tm._screenToWorld(v.w / 2, v.h / 2, v);
      return { outX: c.x < b.minX - 19 || c.x > b.maxX + 19, outZ: c.z < b.minZ - 19 || c.z > b.maxZ + 19 };
    });
    t(env.name, 'the view cannot be panned off the mission', !farPan.outX && !farPan.outZ, farPan.outX || farPan.outZ ? 'the centre escaped the mission bounds' : 'centre stayed inside the mission area + air');

    // ---- selection + inspector, driven by a real click on a real marker
    // settle the view first, then sample: recenter() inside the sampler made the legend
    // (and with it the canvas box) reflow between the two samples, and the point the test
    // clicked was no longer the point the map had drawn.
    await page.evaluate(() => { const tm = window.__vs.tacmap; tm.recenter('fit'); });
    await settlePage(page);
    const marker = await stablePoint(page, () => {
      const tm = window.__vs.tacmap;
      const r = tm.fullCv.getBoundingClientRect();
      const cv = { l: r.left, t: r.top, w: r.width, h: r.height };
      const cvEl = tm.fullCv;
      const onCanvas = (x, y) => document.elementFromPoint(Math.round(x), Math.round(y)) === cvEl;
      const hits = (tm._hits || []).filter((h) => h && h.payload);
      const order = hits.filter((h) => h.payload.kind === 'extraction')
        .concat(hits.filter((h) => h.payload.kind === 'objective'), hits);
      const pick = order.find((h) => onCanvas(r.left + h.x, r.top + h.y)) || null;
      if (!pick) return { x: 0, y: 0, key: null, kind: null, cv, candidates: hits.length };
      return { x: r.left + pick.x, y: r.top + pick.y, key: pick.payload.key, kind: pick.payload.kind, cv, candidates: hits.length };
    });
    await page.mouse.click(Math.round(marker.x), Math.round(marker.y));
    await sleep(150); await settlePage(page);
    const insp = await page.evaluate(() => {
      const tm = window.__vs.tacmap;
      const card = document.getElementById('tacmap-inspector');
      const rect = card.getBoundingClientRect();
      return {
        sel: tm.selected && tm.selected.key, hidden: card.classList.contains('hidden'),
        title: tm._insp && tm._insp.title.textContent, where: tm._insp && tm._insp.where.textContent,
        rect: { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.left), y: Math.round(rect.top) },
        routeBtn: document.getElementById('tac-routebtn').textContent,
        inside: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
      };
    });
    t(env.name, 'clicking a marker opens its card', insp.sel === marker.key && !insp.hidden && !!insp.title
      && marker.stable === true && marker.onCanvas === true,
      `selected ${insp.sel}; title "${insp.title}"; where "${insp.where}"`
      + `; clicked ${Math.round(marker.x)},${Math.round(marker.y)} for "${marker.key}" (layout ${marker.stable ? 'settled' : 'STILL MOVING'}, canvas under the point: ${marker.onCanvas}, canvas box ${Math.round(marker.cv.l)},${Math.round(marker.cv.t)} ${Math.round(marker.cv.w)}x${Math.round(marker.cv.h)})`);
    t(env.name, 'the card is on screen and legible', insp.inside && insp.rect.w > 180 && insp.rect.h > 60,
      `${insp.rect.w}x${insp.rect.h} at ${insp.rect.x},${insp.rect.y}`);
    await shot(page, env, '03-marker-selected');
    const nav = await page.evaluate(async () => {
      const tm = window.__vs.tacmap;
      document.getElementById('tacmap-inspect-nav').click();
      await new Promise((r) => requestAnimationFrame(r));
      tm.drawFull();
      return { sel: tm.selected && tm.selected.key, routeSel: tm.routeSel, pts: tm._route && tm._route.pts ? tm._route.pts.length : 0, walk: tm.selected && tm.selected.walk, btn: document.getElementById('tac-routebtn').textContent };
    });
    t(env.name, 'NAVIGATE plans a route to the selection', nav.routeSel && (nav.pts > 0 || nav.walk == null),
      `routeSel ${nav.routeSel}, ${nav.pts} path points, walk ${nav.walk == null ? 'n/a' : Math.round(nav.walk) + ' m'}, button "${nav.btn}"`);

    // ---- layers
    const layers = await page.evaluate(async () => {
      const tm = window.__vs.tacmap;
      document.getElementById('tac-layersbtn').click();
      await new Promise((r) => requestAnimationFrame(r));
      const panel = document.getElementById('tacmap-layers');
      const rows = [...panel.querySelectorAll('.tac-layer')];
      const r0 = rows[0] ? rows[0].getBoundingClientRect() : null;
      const before = { count: tm._drawCalls, buildings: tm.layers.buildings };
      const bRow = rows.find((r) => r.dataset.layer === 'buildings');
      if (bRow) bRow.click();
      tm.drawFull();
      const after = { count: tm._drawCalls, buildings: tm.layers.buildings };
      if (bRow) bRow.click();
      const rect = panel.getBoundingClientRect();
      return {
        rows: rows.length, labels: rows.map((r) => r.textContent.trim()).slice(0, 3),
        visible: !panel.classList.contains('hidden'),
        tapTargets: rows.map((r) => (r.getBoundingClientRect().width >= 40 && r.getBoundingClientRect().height >= 20)),
        inside: rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0,
        before, after, btn: document.getElementById('tac-layersbtn').textContent,
        r0: r0 ? Math.round(r0.height) : 0,
      };
    });
    t(env.name, 'layer popover lists every layer, tappable', layers.visible && layers.rows === 11,
      `${layers.rows} rows (${layers.labels.join(' / ')}...), row height ${layers.r0} px, "${layers.btn}"`);
    t(env.name, 'every layer row is a real touch target', layers.tapTargets.every(Boolean), `${layers.tapTargets.filter(Boolean).length}/${layers.tapTargets.length} rows >= 40x20 px`);
    t(env.name, 'a layer switch changes the paint, not the plan', layers.after.buildings === false && layers.after.count < layers.before.count && layers.before.buildings === true,
      `draw calls ${layers.before.count} -> ${layers.after.count} with BUILDINGS off`);
    t(env.name, 'the popover stays inside the viewport', layers.inside);
    await shot(page, env, '04-layers-open');
    await page.evaluate(() => document.getElementById('tac-layersbtn').click());

    // ---- follow mode tracks a moving player
    const follow = await page.evaluate(async () => {
      const tm = window.__vs.tacmap;
      const g = window.__vs;
      tm.recenter('fit');
      tm.zoomBy(3, null);
      document.getElementById('tac-followbtn').click();
      for (let i = 0; i < 25; i++) tm._animateView();
      const p0 = tm._worldToScreen(g.player.pos.x, g.player.pos.z, tm._view());
      g.player.pos.x += 38; g.player.pos.z -= 22;
      for (let k = 0; k < 8; k++) { tm.update(0.016); tm.drawFull(); }
      for (let i = 0; i < 25; i++) tm._animateView();
      tm.drawFull();
      const p1 = tm._worldToScreen(g.player.pos.x, g.player.pos.z, tm._view());
      const r = tm.fullCv.getBoundingClientRect();
      return {
        on: tm.follow, label: document.getElementById('tac-followbtn').textContent,
        centre: { x: r.width / 2, y: r.height / 2 }, p0, p1,
        bits: (tm._overlayBits || ''), status: [...document.querySelectorAll('#tacmap-canvas')].length,
      };
    });
    t(env.name, 'FOLLOW keeps the player centred while the world moves',
      follow.on === true && Math.hypot(follow.p1.x - follow.centre.x, follow.p1.y - follow.centre.y) < 3,
      `player sat ${(follow.p1.x - follow.centre.x).toFixed(1)},${(follow.p1.y - follow.centre.y).toFixed(1)} px from centre after a 44 m move; button "${follow.label}"`);
    const disengage = await page.evaluate(() => {
      const tm = window.__vs.tacmap;
      const cv = tm.fullCv;
      const r = cv.getBoundingClientRect();
      const ev = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, { pointerId: 77, pointerType: 'mouse', clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, buttons: 1, button: 0 }));
      ev('pointerdown', r.width / 2, r.height / 2);
      ev('pointermove', r.width / 2 + 60, r.height / 2);
      ev('pointerup', r.width / 2 + 60, r.height / 2);
      return { follow: tm.follow, label: document.getElementById('tac-followbtn').textContent };
    });
    t(env.name, 'a grab takes the view over from follow', disengage.follow === false && /OFF/.test(disengage.label), `"${disengage.label}"`);

    // ---- the map owns the keyboard while it is up
    const isolation = await page.evaluate(async () => {
      const g = window.__vs;
      const before = { x: g.player.pos.x, z: g.player.pos.z, yaw: g.player.yaw, hp: g.player.hp };
      const fire = () => g.input.fireHeld === true;
      const opts = { bubbles: true, cancelable: true };
      for (const code of ['KeyW', 'KeyA', 'KeyD', 'ShiftLeft', 'KeyR', 'Digit3']) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code, ...opts }));
        document.dispatchEvent(new KeyboardEvent('keydown', { code, ...opts }));
      }
      await new Promise((r) => setTimeout(r, 260));
      for (const code of ['KeyW', 'KeyA', 'KeyD', 'ShiftLeft', 'KeyR', 'Digit3']) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code, ...opts }));
      }
      return { before, after: { x: g.player.pos.x, z: g.player.pos.z, yaw: g.player.yaw, hp: g.player.hp }, fire: fire(), open: g.tacmap.open };
    });
    const still = Math.hypot(isolation.after.x - isolation.before.x, isolation.after.z - isolation.before.z) < 0.02
      && isolation.after.yaw === isolation.before.yaw && isolation.after.hp === isolation.before.hp;
    t(env.name, 'gameplay keys do nothing while the map is up', still && !isolation.fire && isolation.open,
      still ? 'player position, facing, health and trigger untouched through W/A/D/Shift/R/3' : 'the sim moved behind the map');

    // ---- 3D toggle must not break the 2D map it shares data with
    const three = await page.evaluate(async () => {
      const tm = window.__vs.tacmap;
      document.getElementById('tac-3dbtn').click();
      await new Promise((r) => setTimeout(r, 260));
      const stage = document.getElementById('map3d-stage');
      const vis = stage && !stage.classList.contains('hidden');
      document.getElementById('tac-3dbtn').click();
      await new Promise((r) => requestAnimationFrame(r));
      tm.drawFull();
      return { vis, mode: tm.mode, open: tm.open, label: document.getElementById('tac-3dbtn').textContent };
    });
    t(env.name, 'the 3D view opens and hands back a working 2D map', three.vis === true && three.mode === '2d' && three.open,
      `3D stage shown: ${three.vis}; back to "${three.label}"`);

    // ---- float window: move, resize, maximise — and the view never moves
    const chrome = await page.evaluate(() => {
      const tm = window.__vs.tacmap;
      const view0 = { z: tm.zoom, px: tm.panX, py: tm.panY };
      document.getElementById('tac-floatbtn').click();
      const panel = document.getElementById('tacmap');
      const r0 = panel.getBoundingClientRect();
      const cb = tm.fullCv.getBoundingClientRect();
      return { cls: panel.className, box: { w: Math.round(r0.width), h: Math.round(r0.height), x: Math.round(r0.left), y: Math.round(r0.top) }, cvw: Math.round(cb.width), view0, vw: innerWidth, vh: innerHeight, label: document.getElementById('tac-floatbtn').textContent };
    });
    t(env.name, 'FLOAT detaches the map into a smaller window', /floating/.test(chrome.cls) && chrome.box.w < chrome.vw - 4 && chrome.box.h < chrome.vh - 4 && /MAXIMIZE/.test(chrome.label),
      `${chrome.box.w}x${chrome.box.h} window inside ${chrome.vw}x${chrome.vh}; button "${chrome.label}"`);
    await shot(page, env, '05-floating');
    // Grab a point on the bar that is not a control. On a 340 px phone window the bar is a
    // two-column grid of buttons, so the title's centre can sit on one - and the product
    // (rightly) ignores a press that starts on a button. Scan, and say so if nothing is free.
    const grab = await stablePoint(page, () => {
      const bar = document.getElementById('tacmap-topbar');
      const r = bar.getBoundingClientRect();
      const title = document.getElementById('tacmap-title');
      const cands = [];
      if (title && title.getBoundingClientRect) {
        const tr = title.getBoundingClientRect();
        cands.push({ x: tr.left + 6, y: tr.top + tr.height / 2 }, { x: tr.left + 2, y: tr.bottom - 3 });
      }
      cands.push({ x: r.left + r.width - 60, y: r.bottom - 5 }, { x: r.left + 4, y: r.bottom - 5 });
      const free = (p) => {
        if (p.x < r.left + 1 || p.x > r.right - 1 || p.y < r.top + 1 || p.y > r.bottom - 1) return false;
        const el = document.elementFromPoint(Math.round(p.x), Math.round(p.y));
        if (!el || !bar.contains(el)) return false;
        return !(el.closest && el.closest('button, input, select, a'));
      };
      const hit = cands.find(free);
      return {
        x: Math.round(hit ? hit.x : r.left + 4), y: Math.round(hit ? hit.y : r.top + 4),
        cv: null, found: !!hit, bar: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      };
    });
    const from2 = { x: grab.x, y: grab.y };
    const to2 = { x: from2.x - 60, y: from2.y + 40 };
    await page.mouse.move(from2.x, from2.y);
    await page.mouse.down();
    await page.mouse.move(to2.x, to2.y, { steps: 6 });
    await page.mouse.up();
    const moved = await page.evaluate((c) => {
      const tm = window.__vs.tacmap;
      const r = document.getElementById('tacmap').getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), same: Math.abs(tm.zoom - c.view0.z) < 1e-6 && Math.abs(tm.panX - c.view0.px) < 1e-6 && Math.abs(tm.panY - c.view0.py) < 1e-6, was: c.box };
    }, chrome);
    t(env.name, 'the title bar moves the window, never the map',
      Math.abs(moved.x - (moved.was.x + (to2.x - from2.x))) <= 2 && Math.abs(moved.y - (moved.was.y + (to2.y - from2.y))) <= 2 && moved.same,
      `dragged ${to2.x - from2.x},${to2.y - from2.y} px from the free bar point ${grab.found ? 'found' : 'NOT FOUND - bar is all controls'}: window ${moved.was.x},${moved.was.y} -> ${moved.x},${moved.y}; bar box ${grab.bar.l},${grab.bar.t} ${grab.bar.w}x${grab.bar.h}; zoom/pan untouched: ${moved.same}`);
    t(env.name, 'the floating window opens somewhere usable', chrome.box.x > 0 && chrome.box.y > 0 && chrome.box.x + chrome.box.w <= chrome.vw,
      `placed at ${chrome.box.x},${chrome.box.y} sizing ${chrome.box.w}x${chrome.box.h} in ${chrome.vw}x${chrome.vh}`);
    const gripBox = await page.locator('#tacmap-grip').boundingBox();
    if (gripBox) {
      await page.mouse.move(gripBox.x + 6, gripBox.y + 6);
      await page.mouse.down();
      await page.mouse.move(gripBox.x + 130, gripBox.y + 90, { steps: 6 });
      await page.mouse.up();
    }
    const resized = await page.evaluate(async (c) => {
      const tm = window.__vs.tacmap;
      await new Promise((r) => setTimeout(r, 60));      // headless rAF is starved; a timer is not
      const cv = tm.fullCv;
      const r = cv.getBoundingClientRect();
      const panel = document.getElementById('tacmap').getBoundingClientRect();
      return {
        w: Math.round(r.width), h: Math.round(r.height), panelW: Math.round(panel.width),
        dev: cv.width, dpr: window.devicePixelRatio, grew: r.width > c.cvw + 20, before: c.cvw,
        same: Math.abs(tm.zoom - c.view0.z) < 1e-6,
        edpr: Math.min(2, window.devicePixelRatio),
      };
    }, chrome);
    t(env.name, 'the resize grip grows the canvas and the canvas keeps pace',
      resized.grew && Math.abs(resized.dev - resized.w * resized.edpr) <= 3 && resized.same
      && Math.abs((resized.w - resized.before) - (resized.panelW - chrome.box.w)) <= 3,
      `canvas ${resized.before} -> ${resized.w}x${resized.h} CSS px (window ${chrome.box.w} -> ${resized.panelW}) backed by ${resized.dev} device px at render dpr ${resized.edpr}; view preserved: ${resized.same}`);
    await page.evaluate(() => document.querySelector('#tacmap-topbar').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
    const maximised = await page.evaluate(() => ({
      cls: document.getElementById('tacmap').className,
      label: document.getElementById('tac-floatbtn').textContent,
      wide: Math.round(document.getElementById('tacmap').getBoundingClientRect().width), vw: innerWidth,
    }));
    t(env.name, 'double-clicking the bar restores the full frame', !/floating/.test(maximised.cls) && /FLOAT/.test(maximised.label) && maximised.wide > maximised.vw * 0.9,
      `${maximised.wide} px wide again; button "${maximised.label}"`);

    // ---- pinch, with two real touch points
    if (env.touch) {
      if (env.mobile) await input.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      const cvs = await stablePoint(page, () => {
        const r = window.__vs.tacmap.fullCv.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, cv: { l: r.left, t: r.top, w: r.width, h: r.height } };
      });
      const cv = { x: cvs.cv.l, y: cvs.cv.t, width: cvs.cv.w, height: cvs.cv.h };
      const cx = cvs.x, cy = cvs.y;
      const zBefore = await page.evaluate(() => window.__vs.tacmap._zoomT);
      const pts = (a, b) => [{ x: Math.round(a.x), y: Math.round(a.y), id: 1 }, { x: Math.round(b.x), y: Math.round(b.y), id: 2 }];
      // Real hardware reports the second finger as a touchStart carrying *both* live
      // points; one event listing two new points is not something a phone does, and
      // Chrome's mobile pipeline drops it.
      const first = { x: cx - 40, y: cy };
      await touchSend('touchStart', [first]);
      await touchSend('touchStart', pts(first, { x: cx + 40, y: cy }));
      for (let i = 1; i <= 6; i++) {
        const d = 40 + i * 22;
        await touchSend('touchMove', pts({ x: cx - d, y: cy }, { x: cx + d, y: cy }));
        if (i === 3) var mid = await page.evaluate(() => ({ n: window.__vs.tacmap._pointers.size, spread: window.__vs.tacmap._pinch && window.__vs.tacmap._pinch.dist, z: window.__vs.tacmap._zoomT }));
      }
      await touchSend('touchEnd', [{ x: cx + 172, y: cy, id: 2 }]);
      await touchSend('touchEnd', []);
      await sleep(200); await settlePage(page);
      let pinch = await page.evaluate(() => ({ z: window.__vs.tacmap.zoom, stuck: window.__vs.tacmap._pointers.size, readout: document.getElementById('tac-zoomval').textContent }));
      let how = 'two raw CDP touch points';
      if (pinch.z <= zBefore * 1.05) {
        // Chrome's mobile emulation keeps a 2-finger spread for the page-zoom gesture
        // itself, so the raw touchPoints never reach JS. Route the same gesture through
        // the browser's own recogniser (Input.synthesizePinchGesture) and see whether the
        // map answers *that* - which is what a real finger does on a real phone.
        try {
          await page.pinch(2.4, { x: cx, y: cy });
          how = 'page.pinch() through the Chrome gesture pipeline';
          await sleep(240); await settlePage(page);
          pinch = await page.evaluate(() => ({ z: window.__vs.tacmap.zoom, stuck: window.__vs.tacmap._pointers.size, readout: document.getElementById('tac-zoomval').textContent }));
        } catch (e) { how = `page.pinch() unavailable (${e.message.split('\n')[0]})`; }
      }
      const tv = await page.evaluate(() => ({ ...window.__tv }));
      t(env.name, 'a two-finger spread zooms the map in', pinch.z > zBefore * 1.05 && pinch.stuck === 0,
        `${zBefore.toFixed(2)}x -> ${pinch.z.toFixed(2)}x via ${how}; mid-gesture the map held ${mid ? mid.n : '?'} pointers (spread ${mid && mid.spread ? Math.round(mid.spread) : '?'} px, target ${mid ? mid.z.toFixed(2) : '?'}x); ${pinch.stuck} pointers left captured; readout "${pinch.readout}"; canvas totals pointerdown ${tv.pointerdown} / touchstart ${tv.touchstart}`);
      // and a tap on a marker still selects, on touch
      const tap = await stablePoint(page, () => {
        const tm = window.__vs.tacmap;
        tm.clearSelection();
        tm.drawFull();
        // Only a target the eye can see counts: the point must be on the canvas at the
        // time of the tap, not behind the inspector card or off the visible rect.
        const r = tm.fullCv.getBoundingClientRect();
        const cand = (tm._hits || []).filter((h) => h.payload && h.payload.key);
        const cv = tm.fullCv;
        const hit = cand.find((h) => {
          const x = r.left + h.x, y = r.top + h.y;
          if (x < r.left + 12 || y < r.top + 12 || x > r.right - 12 || y > r.bottom - 12) return false;
          return document.elementFromPoint(Math.round(x), Math.round(y)) === cv;
        }) || null;
        if (!hit) return null;
        return {
          x: Math.round(r.left + hit.x), y: Math.round(r.top + hit.y), key: hit.payload.key,
          cv: { l: r.left, t: r.top, w: r.width, h: r.height },
        };
      });
      const selBefore = await page.evaluate(() => window.__vs.tacmap.selected);
      // Trace the raw pointer pipeline while tapping, and keep an in-page control call:
      // if selectAt() finds the marker but the real tap does not, the gesture is being
      // swallowed on the way in, and the log below says where.
      await page.evaluate(() => {
        window.__taplog = [];
        const cv = document.getElementById('tacmap-canvas');
        for (const ty of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'touchstart', 'touchend']) {
          cv.addEventListener(ty, (e) => window.__taplog.push(`${ty}${e.pointerId != null ? '#' + e.pointerId : ''}`), true);
        }
      });
      const local = tap ? await page.evaluate((tp) => {
        const tm = window.__vs.tacmap;
        const r = tm.fullCv.getBoundingClientRect();
        return { p: { x: Math.round(tp.x - r.left), y: Math.round(tp.y - r.top) }, rect: { l: Math.round(r.left), t: Math.round(r.top) } };
      }, tap) : null;
      // Playwright's touchscreen.tap throws on fractional points under mobile emulation;
      // the raw CDP sequence is what a phone actually sends, so send that.
      if (tap) { await touchSend('touchStart', [{ x: tap.x, y: tap.y, id: 9 }]); await sleep(60); await touchSend('touchEnd', []); }
      await sleep(120); await settlePage(page);
      const selAfter = await page.evaluate(() => window.__vs.tacmap.selected && window.__vs.tacmap.selected.key);
      const taplog = await page.evaluate(() => window.__taplog || []);
      // control: the same point through the product's own select entry point
      const control = local ? await page.evaluate((p) => {
        const tm = window.__vs.tacmap;
        tm.clearSelection();
        tm.selectAt(p.x, p.y);
        const k = tm.selected && tm.selected.key;
        return { key: k };
      }, local.p) : null;
      const tv2 = await page.evaluate(() => ({ ...window.__tv }));
      t(env.name, 'a tap selects a marker on touch', !!tap && selAfter === tap.key,
        `tapped ${tap && tap.x},${tap.y} -> ${selAfter || 'nothing'} (was ${selBefore ? 'selected' : 'clear'}); same point through selectAt(${local ? local.p.x + ',' + local.p.y : 'n/a'}) -> ${control ? control.key || 'nothing' : 'n/a'}; events ${taplog.join(' ') || 'NONE'}; canvas pointerdown total ${tv2.pointerdown}`);
    } else {
      t(env.name, 'mouse wheel and drag cover the pointer path', true, 'touch pinch asserted on the two touch environments');
    }

    // ---- close, and the view is kept
    const keep = await page.evaluate(() => {
      const tm = window.__vs.tacmap;
      return { z: tm._zoomT, px: tm._panXT, py: tm._panYT };
    });
    await page.keyboard.press('KeyM');
    await sleep(150);
    const closed = await page.evaluate(() => ({
      open: window.__vs.tacmap.open,
      hidden: document.getElementById('tacmap').classList.contains('hidden'),
      hud: !document.getElementById('hud').classList.contains('hidden'),
      state: String(window.__vs.state),
      saved: { ...window.__vs.tacmap._savedView },
    }));
    t(env.name, 'the map closes back to the game cleanly', closed.open === false && closed.hidden && closed.hud && closed.state === 'playing',
      `state ${closed.state}, HUD restored`);
    await page.keyboard.press('KeyM');
    await sleep(180);
    const reopened = await page.evaluate(() => {
      const tm = window.__vs.tacmap;
      return { open: tm.open, z: tm._zoomT, px: tm._panXT, py: tm._panYT };
    });
    t(env.name, 'reopening restores the view you left', reopened.open && Math.abs(reopened.z - keep.z) < 1e-6
      && Math.abs(reopened.px - keep.px) < 0.6 && Math.abs(reopened.py - keep.py) < 0.6,
      `${keep.z.toFixed(2)}x at (${keep.px.toFixed(0)},${keep.py.toFixed(0)}) came back as ${reopened.z.toFixed(2)}x at (${reopened.px.toFixed(0)},${reopened.py.toFixed(0)})`);
    await shot(page, env, '01-map-open');

    // ---- perf, measured in the browser
    const perf = await page.evaluate(() => {
      const tm = window.__vs.tacmap;
      const t = [];
      for (let i = 0; i < 24; i++) { const a = performance.now(); tm.drawFull(); t.push(performance.now() - a); }
      t.sort((x, y) => x - y);
      return { avg: t.reduce((a, b) => a + b, 0) / t.length, p95: t[Math.floor(t.length * 0.95)], calls: tm._drawCalls, ms: tm._lastDrawMs };
    });
    t(env.name, 'an interactive repaint fits the 45 ms budget', perf.avg <= 45,
      `avg ${perf.avg.toFixed(1)} ms, p95 ${perf.p95.toFixed(1)} ms, ${perf.calls} draw calls per frame`);
    await page.evaluate(() => { const tm = window.__vs.tacmap; tm.fit(); });
    await shot(page, env, '02-fit');

    t(env.name, 'the page stays quiet', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : 'no page errors, no console errors, no failed requests');
  } catch (err) {
    const where = String((err && err.stack) || '').split('\n').slice(1, 3).join(' | ');
    t(env.name, 'environment completed', false, `${err && err.name}: ${err && err.message} @ ${where}`);
    try { await shot(page, env, 'FAILED'); } catch { /* the screenshot is a bonus */ }
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const pw = await findPlaywright();
  if (!pw) {
    console.log('SKIP browser_map_tests.mjs — Playwright is not installed here.');
    console.log('  install: npm i playwright && npx playwright install chromium');
    console.log('  or point $VEIL_PLAYWRIGHT at a directory containing node_modules/playwright');
    return 0;
  }
  const { server, port } = await serve(ROOT);
  const base = `http://127.0.0.1:${port}`;
  let browser = null;
  try {
    browser = await pw.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--font-render-hinting=none',
        // headless Chromium throttles rAF hard (the probe measured 0.5 fps), and the map's
        // view easing is driven from the frame loop: let frames run so the test sees the
        // same convergence a player sees.
        '--disable-frame-rate-limit', '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    });
  } catch (err) {
    console.log(`SKIP browser_map_tests.mjs — Chromium could not start here: ${err.message}`);
    server.close();
    return 0;
  }
  const envs = ONLY.length ? ENVS.filter((e) => ONLY.includes(e.name)) : ENVS;
  console.log(`Chromium ${browser.version()} · ${envs.length} environments · serving ${ROOT} at ${base}`);
  for (const env of envs) {
    console.log(`\n--- ${env.name} (${env.viewport.width}x${env.viewport.height} @ dpr ${env.dpr}${env.touch ? ', touch' : ', mouse'}) — ${env.why}`);
    await runEnv(browser, env, base);
  }
  await browser.close();
  server.close();

  const failed = checks.filter((c) => !c.ok);
  const byEnv = new Map();
  for (const c of checks) byEnv.set(c.env, (byEnv.get(c.env) || 0) + (c.ok ? 0 : 1));
  const lines = [
    `browser_map_tests — ${checks.length - failed.length}/${checks.length} checks passed in ${ONLY.length ? ONLY.length + ' (filtered)' : ENVS.length} environments`,
    ...envs.map((e) => `  ${e.name.padEnd(16)} ${String((byEnv.get(e.name) || 0) === 0 ? 'clean' : byEnv.get(e.name) + ' failed')}`),
    '',
    ...checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.env} · ${c.label}${c.detail ? ' — ' + c.detail : ''}`),
  ];
  fs.writeFileSync(path.join(ROOT, 'reports', 'browser_map_tests.txt'), lines.join('\n') + '\n');
  console.log('');
  console.log(`${checks.length - failed.length}/${checks.length} browser checks passed across ${envs.length} environments`);
  if (failed.length) for (const f of failed.slice(0, 12)) console.log(`FAIL ${f.env} · ${f.label} — ${f.detail}`);
  return failed.length ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error('browser suite blew up:', err && err.stack || err);
  process.exitCode = 1;
});
