# VEILSTRIKE final test results — v17.6.0

**Run date:** 2026-11-06. All applicable automated test suites passed on the project source and again from the extracted standalone release package. No browser claim is inferred from headless or mocked tests.

## Full suite

`bash tests/run_all_suites.sh` exited 0. **213 PASS, 0 FAIL** across the executed suites. The one browser-only suite skipped because this environment has neither Playwright/Puppeteer nor an installed browser executable.

| Suite | Passed | Failed | Status |
|---|---:|---:|---|
| Collision gameplay | 33 | 0 | PASS |
| Collision coverage audit | 1 | 0 | PASS |
| Collision leak audit | 1 | 0 | PASS |
| Enemy AI / combat | 27 | 0 | PASS |
| Ammunition | 12 | 0 | PASS |
| Ammo pickups | 20 | 0 | PASS |
| Firing pipeline | 6 | 0 | PASS |
| Firing input | 16 | 0 | PASS |
| Tactical map | 21 | 0 | PASS |
| Browser map / screenshots | 0 | 0 | SKIP — no browser tooling |
| Runtime smoke | 17 | 0 | PASS |
| Gameplay v3 smoke | 1 | 0 | PASS |
| Requirements contracts | 15 | 0 | PASS |
| Campaign 100 audit | 5 | 0 | PASS |
| Mission scaling / retries | 29 | 0 | PASS |
| PWA/offline static + mocked | 9 | 0 | PASS |

Machine-captured suite summary is `reports/verification_summary.txt`; raw output files are under `reports/`.

## Additional delivery and source checks

`python3 tests/module_delivery_smoke.py` passed: 43 local JavaScript modules returned JavaScript MIME, absent modules do not receive an HTML fallback, and the one approved MP3 exists, is locally served as `audio/mpeg`, and is in the worker precache. JavaScript syntax checks for `js/*.js`, `tests/*.mjs`, and `sw.js` also passed.

## Scaling/retry evidence

The scaling suite constructs actual `Enemy` actors for OP 001 across four attempts, OP 002 across two attempts, and OP 003/050/100; it drains production reserve queues between waves, confirms exact total and log, no spawn failures, the unchanged active cap, and no over-cap actor. It also invokes production `Game.restartFromCheckpoint()` after a completed actual-actor attempt and confirms the fresh attempt count/queue and target are reset. `Game.startMission()` is exercised for all ten campaign missions and repeated failure-state entries in the gameplay smoke.

## Limits

The mission tests do not simulate all combat and objectives to natural mission completion. Checkpoint player/presentation effects are stubbed in the focused harness. PWA tests run against source assertions and a mocked Cache API. No actual PWA installation/update, real offline reopen/gameplay, audible audio, rendered desktop/mobile session, or screenshot was performed. `tests/browser_map_tests.mjs` reports SKIP for the missing browser tooling.
