# VEILSTRIKE — Gameplay, Environments & Music Changelog

## VEILSTRIKE v3.2 music filename correction (2026-11-01)

- Corrected the registry to `/assets/music/MORTALS.mp3`, `/assets/music/FEARLESS-PT-II.mp3`, and
  `/assets/music/KREZUS-SKINS.mp3`. Existing track IDs, display names, UI, and controls are unchanged.
- Updated soundtrack instructions, manifests, diagnostics tests, and verification reports to match
  exact case and hyphenation. Bumped only the service-worker cache identifier needed to deliver the
  corrected registry.
- The three originals are absent from this source tree. No files were renamed or substituted. The
  existing deployed MORTALS URL returns audio; the other two exact URLs return 404. See
  `MUSIC_FILENAME_PLAYBACK_REPORT.md`. No deployment occurred.

VEILSTRIKE v3.1 combat, movement, world-boundary, and music follow-up to the existing v16.4.4 source
tree. Mission IDs, campaign order, canonical intel/weather archive keys, VX-FRAG/VX-4 damage,
helicopter gates, visual identity, existing art/assets, and the separate training range are retained.
No rendering/performance system, deployment, or production site was changed.

## VEILSTRIKE v3.1 gameplay update (2026-10-28)

- VX-4 now starts with all **300 rounds in the loaded supply**, has no extra reserve or reload
  transition, does not jam, remains fireable while sprinting, and keeps per-shot accounting. Legacy
  reserve state is consumed continuously without a magazine-swap pause. Damage remains 34. Its
  training-range supply is finite too; other range kit reserves retain their prior behavior.
- HUD shows the 300-round total, labels continuous feed, suppresses the false magazine-empty reload
  cue for VX-4, and clearly reports that exhausted supply cannot be reloaded. A harness ran the real
  `Game.startMission()` initialization path for all ten initially unlocked mission IDs and the range;
  weapon reset/loadout state ended at 300/300 each time.
- Y is now a tap-to-toggle observation zoom. It is reserved separately from the ADS keyboard toggle;
  an invalid saved ADS binding to Y is remapped to X. Zoomed shots originate at the camera and follow
  its aim ray; firing remains enabled zoomed and unzoomed.
- Vertical collision now sweeps the full frame segment so fast falls cannot tunnel through thin
  floors/ceilings. Downward velocity is cleared on landing. Outside authored bounds or below the
  world, the player returns to verified safe footing without changing mission, enemy, health,
  ammo, or progression state. Runtime tests exercised below-world and edge recovery on all ten actual
  generated campaign maps; no map-wide invisible floor was added.
- Player tuning is now 3.6 m/s walk / 7.8 m/s sprint, 22 m/s² target acceleration, and 4.5 stamina
  units/s sprint drain (about 22 seconds continuous sprint). Enemy opening parties are 7–9 rather
  than 14–18, the simultaneous hostile budget is 12 (previously 36), engagement/reaction pacing is
  slower, and the lifetime spawn limits remain exactly 30 for range/first ten missions and 40 later.
- Added an explicit **CHECK FILES** control that performs HEAD checks only against the exact three
  canonical user-supplied MP3 paths and reports missing files, HTTP errors, non-audio MIME, or blocked
  checks. No tracks or substitute audio are bundled.

## Imported-module delivery follow-up

- The current production page is served at `/`, but its project modules are published one directory down under `/VeilStrike/`. Consequently `/js/main.js` is 404 at the root while `/VeilStrike/js/main.js` returns JavaScript. All 35 module URLs in the `/VeilStrike/` import graph return HTTP 200 with JavaScript MIME. The live game entry route is `https://veilstrike.vercel.app/VeilStrike/`.
- To publish at `/`, set the hosting project root to the folder containing `index.html`, `vercel.json`, `js/`, `css/`, and `assets/`, or publish the flattened ready-to-publish archive so those files sit directly at the site root. No module URL should be rewritten to HTML.
- The hosting configs contain no SPA fallback rewrite. Bumped the service-worker cache version and added MIME validation so a wrong-type HTML response cannot poison the module cache. Added `tests/module_delivery_smoke.py` for local static HTTP checks.
- No deployment was performed by the agent. See `MODULE_DELIVERY_DIAGNOSIS.md` and `README_START_HERE.txt` for the verified root paths and publish steps.

## Ten distinct campaign environments

- The first ten campaign missions now dispatch to ten separate environment layout IDs:
  `facility`, `desert`, `urban`, `snow`, `recon_canyon`, `industrial`, `rural`,
  `riverside_village`, `canal_market`, and `ridge_hold`.
- Added four materially different world builders: Sandglass Canyon (switchback wadi/mesa shelves),
  Riverbend (split-bank village/bridges/orchard), Canal Market (flooded street grid/arcade/archive),
  and Rime Ridge (exposed radar shelf/trenches/west helipad). Their geometry, traversable routes,
  landmarks, cover, patrol/surge entry points, objectives, and LZ approaches are separately authored.
- The four new layout IDs retain their original canonical archive/weather families (`desert`,
  `rural`, `urban`, `snow`), so intel totals and saved data remain compatible.
- Collision-route testing found the proposed Sandglass extraction coordinate inside a cliff slab;
  the LZ was moved to the open saddle between wall segments. No obstacle was made non-colliding to
  conceal the issue.
- The range remains its own non-campaign map/activity. The first 10 operations remain initially
  unlocked; later missions remain progression-gated.

## Enemy movement, difficulty & locomotion

- The procedural fallback gait now advances from collision-resolved actor displacement and holds
  a fixed leg pose while idle. The former fallback phase/swing continued while stationary.
- Combat strafe movement now commits to one fixed endpoint, pauses briefly, then reverses. Previously
  each AI tick recalculated the endpoint from the moving actor position, so the destination receded
  and the strafe could continue indefinitely.
- Reduced the simultaneous hostile budget to 12 and staged smaller opening parties/echelons; the
  lifetime spawn counters stay at 30 for range and the first ten missions, and 40 later. Cadence,
  burst pauses, reaction wind-up, and chase-speed caps were moderated without disabling enemy fire.
- Runtime smoke exercised idle/patrol, gradual visual detection, pursuit, a capped search movement
  request, cover targeting, burst scheduling, lethal damage and death presentation in a controlled
  Node arena. Attack scheduling used a stubbed firing callback; this was not a rendered firefight or
  a full mission encounter.

## Player movement & touch sprint

- Centralized movement tuning in `PLAYER_MOVEMENT`: 3.6 m/s normal movement and 7.8 m/s forward
  sprint. Sprint drain is 4.5 stamina units/second, with increased acceleration and unchanged
  collision/combat constraints.
- A real `Player.update()` + `PhysicsWorld` smoke test measured 3.60 m/s walking and 7.80 m/s sprint,
  sustained sprint for about 22 seconds, and exercised stopping, turning, ADS speed cap, and a solid
  wall obstacle.
- Touch movement-stick updates now preserve the sprint button's held state instead of overwriting
  it, fixing touch sprint cancellation while steering.

## Music

- Kept exactly the three user-supplied tracks and canonical paths:
  - MORTALS — `/assets/music/MORTALS.mp3`
  - FEARLESS PT 2 — `/assets/music/FEARLESS-PT-II.mp3`
  - SKINS — `/assets/music/KREZUS-SKINS.mp3`
- A user pause or disable now invalidates a pending `HTMLMediaElement.play()` promise, preventing a
  late resolution from incorrectly restoring PLAYING after pause/off.
- Promise-state tests used a fake audio element to verify autoplay rejection (`NotAllowedError`),
  pause/disable races and exact URL mapping. A separate opt-in HEAD diagnostic checks only the three
  canonical paths and reports HTTP/file/MIME outcomes without downloading or playing a track.
- No MP3, substitute, download, or generated audio was added. All three expected user files are
  absent from this source tree and are listed in `VERIFICATION_REPORT.md`; audible playback remains
  unverified until those files are supplied and tested in a browser.

## Preserved campaign/gameplay requirements

- First 10 campaign missions unlocked by default; training range separate.
- VX-FRAG starts with at least 20 and remains bounded by the existing stock cap.
- Existing VX-4 identity and damage 34 remain; resolved hits retain the existing one-damage-call
  flow.
- Intel/data and final-stage extraction guards remain; mission completion/progression remains
  latched once. HX-7 helicopter availability/boarding continues to follow the mission gate.
- Spawn limits remain 30 for the first 10 missions and range, 40 for later campaign missions;
  checkpoint retries preserve the per-run counter.

## Verification artifacts

- `tests/verify_requirements.mjs`: focused progression, source-contract, cap, grenade, weapon,
  extraction, helicopter and missing-audio checks.
- `tests/gameplay_v3_smoke.mjs`: real `Game.startMission()` path for ten campaigns and the range,
  Y-key toggle/ADS separation, 300-shot weapon accounting, actual zoomed/unzoomed hitscan against a
  controlled target with one damage call each, VX-4 HUD math, swept vertical physics, recovery
  invariants, and mocked track diagnostics.
- `tests/runtime_smoke.mjs`: headless generated-world geometry/collision-route checks, safe fall/
  boundary recovery on all ten layouts, actual 7–9 actor opening parties on those layouts, player
  physics, selected enemy state-machine behavior, procedural idle gait, and mocked music promise
  states. These are not full browser/gameplay checks.
- `VERIFICATION_REPORT.md`: commands, exact pass/blocked/unverified results, test limitations,
  missing music paths and package integrity details.
