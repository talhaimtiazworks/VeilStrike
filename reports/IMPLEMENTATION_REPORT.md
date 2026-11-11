# VEILSTRIKE v17.6.0 — implementation report

**Date:** 2026-11-06. No deployment or GitHub push was performed.

## Mission scaling correction

The previous investigation found two count defects:

1. `EnemyManager.spawnInitial()` expanded the lifetime spawn cap by 24 beyond the planned formula roster. OP 001 was displayed/planned as 50 but could spawn 74.
2. Checkpoint restart removed actors while retaining prior-attempt spawn counters/limit state, so the old lifetime ledger could disagree with the new actor list.

The +24 cap expansion is removed. `Game.startMission()` derives a campaign target from `MISSION_ORDER` and passes it to supply planning and `beginMissionRun()`. `EnemyManager` retains its staged initial/reserve spawning and active hostile limit, but the campaign target is the hard lifetime cap. Checkpoint retry derives the same target from `cp.mission` and begins a fresh attempt ledger. `reset()` and `beginMissionRun()` clear reserve, surge, NPC/vehicle spawn event, log, and counter state. The start notification no longer suggests an unbounded “+” target.

The formula is `50 + ((Mission Number − 1) × 2)`. Retry and save/failure statistics are not target inputs.

## Offline/PWA changes

Service-worker cache version is `obv-v17.6.0-single-soundtrack-offline-final-20261106`. Its 64 required assets include HTML, CSS, application/vendor modules, manifest, model, menu art, official logo/icons, and the sole soundtrack. Install validates status/MIME and every cache key; an incomplete install deletes only its new cache and rejects installation. Update checks occur on launch, reconnect, tab visibility, and hourly while online. An installed update waits for player consent. A reload request during `playing`, `paused`, or `loading` is deferred. The active version cache is served first; controlled runtime cache misses fail closed rather than requesting the network. Cached audio supports byte ranges. Older app caches are removed only after successful activation.

## Single soundtrack

Only `FEARLESS-PT-II.mp3` is registered, offered in settings, and precached. It is the default. The optional file diagnostic that performed HEAD requests was removed. The source and package inventory test asserts there is exactly one MP3. No replacement or generated audio was added.

## Logo

The supplied source image is copied byte-for-byte to `assets/logo-veilstrike.jpg`. Proportional icon sizes are used in the manifest, favicon, menu, loading, campaign selection, pause, shell avatar, and low-profile HUD position. The source is opaque JPEG (no alpha channel); no transparency was invented. See `LOGO_INTEGRATION_REPORT.md`.

## Files changed

- `js/game.js`, `js/enemies.js`: authoritative mission-index cap, exact display, and clean attempt/checkpoint reset.
- `js/music.js`, `js/ui.js`, `index.html`: one local soundtrack, matching default/selector/status, removed diagnostic HEAD UI.
- `sw.js`, `js/pwa.js`, `manifest.webmanifest`: versioned atomic PWA cache, closed runtime network fallback, update lifecycle and cacheable audio ranges.
- `assets/logo-veilstrike.jpg`, `assets/icons/*`, CSS/HTML brand surfaces: official logo integration.
- `tests/*`: actual enemy-spawn/retry coverage, single-soundtrack contract, PWA atomic install/cache/no-network tests, and local delivery tests.
- Release reports and package instructions were refreshed to match the final behavior.

## Verification boundaries

The mission suite now creates actual `Enemy` instances and exercises the production spawn gate, staged reserves, collision-aware spawn search, reset, and spawn log. To make the complete roster deterministic, test actors are retired between reserve waves; this is a headless simulation, not full combat or a rendered browser play-through. PWA lifecycle tests use a mocked Cache API and network. Real-browser offline/update/audio/visual checks remain blocked by unavailable browser tooling. See `TEST_RESULTS.md` for suite results and known boundaries.
