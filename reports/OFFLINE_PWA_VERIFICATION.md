# Offline/PWA verification — v17.6.0

## Implemented

- New cache release: `obv-v17.6.0-single-soundtrack-offline-final-20261106`.
- 64 required HTML/CSS/JS/vendor/model/image/icon/audio assets are staged and verified before install completes.
- A cache miss/failure rejects the new install and deletes only the incomplete new cache. The prior active cache remains untouched.
- Updates are checked on app launch, when visible, after reconnect, and hourly while online. A new worker waits for player consent.
- Reload requested during an active, paused, or loading mission is deferred until a safe screen. It is not forced mid-mission.
- The active version serves cached runtime resources. The controlled fetch handler has no network fallback; cache misses return a local error response.
- The audio cache supports HTTP byte-range responses. Only the approved soundtrack is registered and precached.
- Obsolete app caches are removed after a successfully installed worker activates.
- Offline/update status is a small non-interactive indicator.

## Automated evidence

`tests/pwa_offline_tests.mjs` checks the versioned asset list, local paths, single-soundtrack inventory, static update behavior, absence of runtime network fallback, and a mocked Cache API install. The mocked interrupted download rejects install and leaves the prior cache present. `tests/module_delivery_smoke.py` checks JavaScript MIME delivery and the sole local audio asset.

These checks are not browser tests.

## Real-browser status: not verified

No Playwright/Puppeteer package or browser executable is available in this environment. The existing Chromium browser suite is skipped. Therefore actual PWA installation, offline reload/reopen, mission gameplay offline, audible soundtrack playback offline, update activation, interrupted update in a real browser, multiple browser viewports, and visual screenshots remain unverified. No full offline release acceptance claim is made.
