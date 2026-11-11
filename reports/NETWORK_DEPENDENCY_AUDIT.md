# VEILSTRIKE runtime network dependency audit — v17.6.0

## Allowed network paths

1. First page load and the service-worker installation's required-asset download.
2. Service-worker registration/update checks while online. An update install downloads the next full local release into its own versioned cache before it may activate.

The service worker does **not** fall back to network for controlled runtime GET requests. A missing cached entry is returned as a package/offline error instead of becoming an untracked online dependency.

## Runtime dependency review

- No external CDN, remote font, remote image/texture, external JavaScript runtime library, remote audio host, external API, account/cloud-save/multiplayer service, analytics, tracking, or online configuration is present in the game runtime.
- Three.js and its loaders, the character model, all CSS/JS, menu art, logo/icons, campaign data, and the soundtrack are local.
- Player settings and progression use local storage.
- `js/music.js` uses a same-origin media URL for the one bundled soundtrack; the worker serves it from the installed cache, including byte-range requests. Music diagnostic HEAD requests were removed.
- External URLs present in vendored source comments or the Vercel schema metadata are references only, not runtime resource requests.

## Audit verdict

After successful initial installation, gameplay resource requests are cache-only. When online, the browser may contact the current app origin for service-worker update checks and the next release download. No external runtime internet dependency remains. The one soundtrack file is locally present and precached; its audible browser playback remains browser-unverified.
