# VEILSTRIKE v3.2 — Verification Report

**Date:** 2026-11-01 (Asia/Karachi)  
**Scope:** Correct the three exact music filenames/absolute paths and verify music delivery; the v3.1
combat, movement, recovery, and enemy-pacing changes are preserved and regression-tested.  
**Not performed:** deployment, commit, push, or changes to unrelated gameplay/rendering systems.

## Passed checks

### Syntax and static requirements

- All `js/*.js`, `tests/*.mjs`, and `sw.js` passed Node syntax checks.
- `tests/verify_requirements.mjs` passed: first ten campaign missions remain initially unlocked;
  training range remains separate; mission/campaign contract, 30/40 per-run spawn caps, at least
  20 VX-FRAG per mission, VX-4 damage 34, extraction/intel gates, exactly-once completion, and the
  new v3 weapon/HUD/zoom/fall/enemy/music code contracts are checked.
- `tests/module_delivery_smoke.py` passed after the source edits: all local JavaScript files
  returned HTTP 200 with JavaScript MIME; a missing module remained 404; and it verified the
  corrected exact-case music registry paths. The three source-tree audio files are absent, so local
  HEAD checks returned 404 and were reported as blocked rather than as successful audio delivery.
  No HTML fallback was configured.

### VX-4, HUD, movement and physics

- `tests/gameplay_v3_smoke.mjs` passed. It called the real `Game.startMission()` initialization path
  for each of the first ten mission IDs and the separate range with peripherals/world generation
  stubbed: the real weapon reset/loadout flow ended at 300 loaded, 0 reserve each time. This is not
  ten complete missions or browser startups.
- The real `WeaponSystem.tryFire()` accounting path fired 300 held-trigger rounds with visual/audio
  effects stubbed: ammo reached 0/300, no jam/reload occurred, and a 301st shot did not fire. Sprint
  firing passed. The actual hitscan resolver then struck a controlled target while zoomed and while
  unzoomed/moving; each hit registered once and applied VX-4 damage 34 once. This controlled AABB
  test is not a rendered scene review or natural mission firefight.
- Pure HUD accounting tests passed for 300 total, empty/no-reload state, legacy reserve accounting,
  and the conventional-weapon reload suggestion. The real key handler was also exercised: Y toggles
  observation zoom on/off, key-repeat does not undo it, and a stale ADS binding to Y is sanitized to X.
- The same v3 test verified high-speed swept AABB contact with a floor and ceiling, plus a safe
  recovery invariant preserving kills and mission time.
- `tests/runtime_smoke.mjs` generated the actual ten campaign worlds and exercised below-world and
  beyond-authored-boundary recovery on each. Recovery found safe footing and preserved mission facts.
  Each world also spawned its actual 7–9 actor opening party under the 12-live/30-total test budget.
  No map-wide invisible floor was added.
- The real `Player.update()` + `PhysicsWorld` harness measured 3.60 m/s walk and 7.80 m/s sprint,
  sustained sprint for about 22 seconds, and passed stopping, turning, ADS speed cap, and wall
  collision checks. A source-level check confirms downward velocity is cleared on landing.

### Enemies and music

- Enemy runtime smoke passed idle/patrol, gradual detection, pursuit, movement cap, cover approach,
  fixed strafe endpoint, burst scheduler, lethal damage, and death-state checks. The actual attack
  callback was stubbed; no live firefight, player-hit, or full encounter-balance claim is made.
- Static/source checks confirm the simultaneous hostile budget is 12, smaller opening parties are
  authored (7–9), and lifetime mission spawn caps remain 30 for range/first ten and 40 later. Full
  all-trigger live spawn-cap stress testing was not performed.
- Mock music tests passed the exact corrected three paths, playback-promise error states,
  pause/disable races, volume handling, and next/previous URL switching. The explicit diagnostic
  was tested with mocked HEAD responses. In the existing deployed site, ranged GETs returned 206
  `audio/mpeg` for MORTALS and 404 for FEARLESS-PT-II and KREZUS-SKINS. No deployment was performed.

## Missing / blocked / unverified

- All three exact MP3 files are absent from this source workspace and the v3.2 ZIP, so audible
  playback, track transitions against the packaged originals, and volume-by-ear are blocked/unverified.
  No audio was downloaded, fabricated, renamed, substituted, or packaged. Expected paths:
  - `/assets/music/MORTALS.mp3`
  - `/assets/music/FEARLESS-PT-II.mp3`
  - `/assets/music/KREZUS-SKINS.mp3`
- No browser GUI was run. Rendered scenes, actual ten-mission play-throughs, natural hit registration,
  and in-game subjective balance remain unverified. The headless tests are not a browser substitute.
- The runtime tests use a controlled Node canvas shim and stub presentation/audio in targeted places.
  No project build command or `npm test` script exists; these checks were run explicitly.
- The Settings CHECK FILES control itself was not clicked in a browser. Its exact-three-path HEAD
  diagnostic method was tested with mocked response types; the separate local static-server check
  confirmed the three absent paths return 404. Use the in-game control after adding the MP3s to
  verify the actual host paths and MIME types.

## Commands run

```sh
for f in js/*.js tests/*.mjs sw.js; do node --check "$f"; done
node --experimental-loader ./tests/progress_test_loader.mjs ./tests/verify_requirements.mjs
node --experimental-loader ./tests/progress_test_loader.mjs ./tests/gameplay_v3_smoke.mjs
node --experimental-loader ./tests/progress_test_loader.mjs ./tests/runtime_smoke.mjs
python3 tests/module_delivery_smoke.py
```

The test-only loader maps the bare `three` specifier to the vendored module and substitutes the
unlock service only for the isolated persistence checks.

## Package integrity

The versioned deliverable is `VEILSTRIKE_V3_2_MUSIC_FILENAMES_PLAYBACK_FIX.zip` with the adjacent
`VEILSTRIKE_V3_2_MUSIC_FILENAMES_PLAYBACK_FIX.zip.sha256` sidecar. The archive is flattened so `index.html`,
`js/`, `css/`, and `assets/` are at its root. See `MUSIC_FILENAME_PLAYBACK_REPORT.md` for exact source,
archive, and existing-deployment audio availability. The flattened archive contains 76 project files; `SHA256SUMS.txt` covers the 75 other files,
excluding itself. The ZIP SHA-256 is recorded in the adjacent sidecar. No deployment was performed.
