# v4.1 — Solid collision, knockdowns, and vehicle interaction (2026-11-05)

New module
* `js/impacts.js` — shared body-state machine (standing / staggered / knocked down / recovering),
  impact resolution, actor-body registration, wall-safe knockback, hull ejection.

Physics
* `js/physics.js` — `ActorField` for characters and vehicle hulls; substepped `moveBox` with
  bounded depenetration; contact records carry requested travel; `{ actors: true }` support in
  `queryAABB`, `isBoxFree` and `raycast`; `findOpenNear` + `repairSpawnPoint` (face escapes of the
  blocking collider, and a no-op is never reported as a repair).

Actors
* `js/player.js` — solid body, intent speed, action/trigger gates, low box while down, camera drop
  and roll, contact resolution on the mover path.
* `js/enemies.js` — per-archetype mass, impact reactions and knock pose, actor-aware whisker
  steering, stuck recovery, `canAct()` gating, spawn-point repair, body unregistration on death.
* `js/weapons.js` — a knocked-down operator cannot fire and loses ADS; the trigger must be released
  and re-pressed; the burst queue is cleared.

Vehicles
* `js/vehicles.js` — hull bodies published after the move, `_processHullContacts` (knockdown +
  damage + ejection, driver exempted per victim), door-aware boarding (`canBoardFrom`,
  `entryPointInfo`), actor-aware and geometry-aware egress (`_safeExit`); the legacy run-over loop
  that braked the truck was removed.
* `js/game.js` — `[F]` boarding handled before the generic interactable pass, prompt text derived
  from the boarding state, `onBodyImpact` feedback.

World
* `js/world.js` — `userData.col` decisions on `box()`/`cyl()` plus `_ensureCollisionCoverage()` for
  meshes no builder decided about, respecting authored spawn/extraction/objective keep-outs.

Tests & evidence
* `tests/collision_gameplay_tests.mjs` — 32 behavioural tests (real classes, real frames).
* `tests/collision_leak_audit.mjs` — 112-map walk-through/fall-through probe, now exits non-zero on
  any leak.
* `tests/collision_coverage_audit.mjs` — 110-map mesh↔collider coverage, now fails below a 95 %
  floor (`MIN_COVERAGE_PCT`).
* `tests/render_behaviour_matrix.mjs`, `tests/run_all_suites.sh` — evidence rendering and one-command
  full verification.
* `COLLISION_PHYSICS_FIX_REPORT.md`, `KNOCKDOWN_IMPACT_SYSTEM.md`,
  `VEHICLE_COLLISION_BOARDING_REPORT.md`, `reports/COLLISION_VERIFICATION_MATRIX.md`.

Operational
* `sw.js` — `CACHE_VERSION` → `v17.1.0-collision-vehicles-20261105`; `js/impacts.js` precached.
* `SHA256SUMS.txt` regenerated over the shipped file set.
