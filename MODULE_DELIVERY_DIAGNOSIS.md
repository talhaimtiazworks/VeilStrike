# VEILSTRIKE — Launch & Publish Diagnosis

**Date:** 2026-10-28 (Asia/Karachi)  
**Latest check:** Read-only HTTP checks of the current production URL after the user's renewed report. No deployment, commit, or push was performed.

## Current production finding

The production site is publishing the game files one directory below the site's root:

| Request | Result |
|---|---|
| `/` | 200 `text/html` — returns the VEILSTRIKE entry page |
| `/js/main.js` | 404 `text/plain` |
| `/assets/vendor/three.module.js` | 404 `text/plain` |
| `/VeilStrike/js/main.js` | 200 `application/javascript` |
| `/VeilStrike/assets/vendor/three.module.js` | 200 `application/javascript` |

The root page uses relative module URLs such as `js/main.js`. At `/`, that resolves to `/js/main.js`, where the deployed server has no file. The game files are actually under `/VeilStrike/`. This is a **publish-root / nested-folder mismatch**, not a JavaScript MIME problem or a fallback rewrite.

I then traversed the full deployed import graph from `https://veilstrike.vercel.app/VeilStrike/`: all **35 module URLs** returned HTTP 200 with a JavaScript MIME type, including `world.js`, `weapons.js`, `ui.js`, `vehicles.js`, and `unlocks.js`. The entry page, all six CSS files, manifest, service worker, soldier GLB, and sampled icon/environment assets also returned HTTP 200 with their expected MIME types. Therefore the current game should launch from:

**https://veilstrike.vercel.app/VeilStrike/**

These are HTTP/resource checks, not a browser-rendered gameplay test.

> This latest probe supersedes the earlier report that five modules were missing at the site root: the current deployment now has the project under `/VeilStrike/`; the root-level requests fail because the site is serving from one directory too high.

## Fix and ready-to-publish setup

- For Vercel, set **Project Root Directory** to the folder containing `index.html`, `vercel.json`, `js/`, `css/`, and `assets/`. If that folder is named `VeilStrike`, select it. Alternatively, publish the files from the flattened ready-to-publish ZIP so `index.html` and `js/` are at the archive/site root.
- For Netlify Drop, extract the flattened ZIP and drop the folder whose top level contains `index.html` and `js/`—not its parent.
- For GitHub Pages, publish the project files directly at the repository root (or use the repo's supported Pages root configuration); do not leave the game under a nested `VeilStrike/` folder while serving a separate root entry page.
- Do not add an SPA rewrite for `/js/` or `/assets/vendor/`. Missing module requests should stay 404, never return `index.html`.
- After publishing to the root, verify `/js/main.js` and `/assets/vendor/three.module.js` both return HTTP 200 with `text/javascript` or `application/javascript`.

The project service worker uses cache version `v16.4.4-module-delivery-fix1` and rejects a successful non-JavaScript response from being cached as a module. `tests/module_delivery_smoke.py` passes locally for all 36 project/vendor JavaScript files and confirms that an absent module stays 404. No deployment was made.
