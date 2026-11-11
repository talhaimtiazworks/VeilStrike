# VEILSTRIKE — offline release

This package is a static single-player game. Serve this folder from an HTTPS origin (or `localhost`) to enable service-worker installation; opening `index.html` directly as `file://` is unsupported.

## Install and cache

1. Upload/serve the contents of this directory as the site root. Keep directory paths intact.
2. Open `index.html` in a current browser with WebGL and Web Audio support.
3. Keep the page online for the first load and let the service worker finish downloading the required local asset bundle. The service worker installs atomically; an incomplete download does not replace a working installed version.
4. Install VEILSTRIKE from the browser's install control if desired. After the initial cache is complete, the bundled game shell and included assets are served locally when offline.
5. Updates are checked while online. When an update is ready, choose RELOAD; a reload request made during a mission is deferred until a safe screen.

## Local content note

`assets/music/FEARLESS-PT-II.mp3` is the only soundtrack asset, the only playlist entry, and is precached for offline playback. No alternate or substitute music is included. All game logic, mission data, Three.js runtime code, model, images, CSS, and included audio are local.

## Compatibility

A modern browser with WebGL and Web Audio is required. This archive does not include development dependencies or the project's test suite. Detailed verification and known limitations are provided in the accompanying release reports outside this runtime archive.
