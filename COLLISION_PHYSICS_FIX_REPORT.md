# VEILSTRIKE v4.1 — Collision & Physics Fix Report

Scope: solid-world collision for characters and vehicles — walking through enemies, walls,
buildings, barriers and parked vehicles; impact/knockdown reactions; vehicle boarding and
egress. Everything below was measured by simulating real frames of the shipped classes
(`node --loader ./tests/progress_test_loader.mjs tests/collision_gameplay_tests.mjs`).

---

## 1. Root causes found

| # | Symptom | Cause (verified in source) |
|---|---------|----------------------------|
| 1 | The player walks straight through enemy soldiers, and they through him | `PhysicsWorld` stored **static colliders only**. Nothing registered a character body, so `moveBox` had nothing to collide with. There was no actor layer at all. |
| 2 | No stagger/knockdown existed anywhere | No impact system existed in the codebase; contact produced either a blocked move or nothing. |
| 3 | Vehicles were ghosts — you could walk through a parked truck, and driving through soldiers did nothing | `VehicleManager`/`Vehicle` never called `physics.add`/`addBox`. A hull existed visually, never as geometry. |
| 4 | `F` entered vehicles from anywhere, any side, through walls | The vehicle interactable was authored with `radius: 2.7, hold: 0.42` and the generic ray picker; distance/side/occlusion were not part of the decision. |
| 5 | Egress dropped the operator inside walls, props and the hull itself | `_safeExit` tested one candidate point with a static-only query, and actor bodies did not exist to be tested against. |
| 6 | Invisible walls / gaps in wall coverage | Coverage came only from `world.box()` calls. Meshes built by other helpers (`cyl`, structures, merged geometry) had collider *meshes* with no collider *volume*, so the audit and the game disagreed. |
| 7 | Fast movers tunnelling thin geometry on a hitched frame | `moveBox` resolved a single displacement per frame with no substepping, so a 50 ms frame at sprint speed (0.39 m) could cross a 0.18 m panel. |
| 8 | Soldiers walked into each other, into walls and jammed against obstacles | AI steering used no collision-aware probing and no stuck recovery, because there was no body/field to probe against. |

### Bugs introduced *and then found* during this work (all fixed, all caught by the harness)

These matter because they were real defects in the fix itself, not in the original game. Each
one was proven by a failing test, not by review:

1. **`ActorField.query()` cleared the caller's output array.** `PhysicsWorld.queryAABB` collects
   statics into `out`, then appends actors — and the append *reset the array*, so every
   `{ actors: true }` query reported open space where there were walls. This silently disabled
   spawn repair, egress clearance and boarding occlusion. (`reports/collision_leaks.json` was
   clean while this bug existed, which is exactly why a behavioural suite was needed.)
2. **Impact strength was measured from post-collision velocity.** The resolver damps the mover's
   velocity on the blocked axis, so a sprinting body "hit" at ~0.4 m/s and nobody ever fell. Now
   movers publish `_intentSpeed` (requested planar speed) and `moveBox` carries the requested
   travel in each contact record.
3. **The pair cooldown vetoed the attacker's own recoil.** `applyImpact` wrote a per-pair cooldown
   for the defender first, then the mover's self-reaction was rejected by that same cooldown. The
   self-reaction now bypasses the pair cooldown (still not the anti-spam state check).
4. **The driver exemption in `_processHullContacts` skipped the whole loop.** It read
   `if (game.vehicleMode === this) continue;`, so a *player-driven* vehicle could never knock
   anybody down — the exact case that matters. Now only the seated driver is exempt.
5. **`applyImpact` was called on vehicle hulls** (a hull has no balance to lose) and crashed on a
   missing field. Actors now carry an explicit `impactFsm` marker; non-FSM bodies block but never
   topple.
6. **A hull collider lagged its mesh by one frame** (`_syncBox` ran before the move). At 12.7 m/s
   that was a 124 mm gap between visual and solid. The hull body is now republished after the move.
7. **The legacy driver run-over block braked the truck** (`speed *= 0.72` per body per frame) and
   duplicated damage. Removed; `_processHullContacts` is the single owner of run-over.
8. **A body caught by a rolling hull could be left inside it.** Knockback alone cannot clear a 6 m
   box in the six frames it takes to pass, so `ejectFromHull` now resolves the contact
   geometrically, wall-safe.
9. **`findOpenNear` could return the origin as "open" and `repairSpawnPoint` reported success
   without moving anything.** It searched rings only; a vehicle hull or building footprint is
   wider than the ring spacing luck allows. It now first tries the four faces of whatever actually
   blocks the origin, and a no-op result is no longer reported as a repair.
10. **Getting up was not protected.** A knockdown could be re-applied 1.67 s after it started —
   0.15 s *before* the get-up animation finished — because `impactCd` and `PAIR_COOLDOWN` both
   expire while the victim is still on the floor. A single heavy that kept ramming pinned the
   player permanently (84 % of frames non-standing). `RECOVERING` is now an invulnerable window
   (`applyImpact` refuses it unless `forceState`, so a truck can still hit you as you rise).
11. **A mover's self-reaction consumed the pair cooldown.** `applyImpact` wrote `_pairCd` even for
   the attacker's own stagger, so a body that keeps bumping refreshed the lock every cycle and its
   *defender* could never be knocked down again. The pair budget is now spent only by real attacks.

---

## 2. What the systems look like now

**`js/physics.js`** — static grid + `ActorField` (generation-aware, 2 m cells) for characters,
NPCs and vehicle hulls. `moveBox(box, dx,dy,dz, out, stepHeight, opts)` substeps horizontal travel
(`MAX_SUBSTEP`), resolves X/Z against both layers, steps up, and finishes with bounded
depenetration (`maxDepenetrate`) so an actor that is *already* inside something is pushed out at a
limited rate instead of launched. Contact records are `[body, nx, nz, travel]` 4-tuples.
`isBoxFree`, `findOpenNear`, `repairSpawnPoint` and `raycast` all accept `{ actors: true }`.

**`js/impacts.js`** (new) — one knockdown state machine shared by the player, soldiers, NPCs and
vehicle crews: `applyImpact`, `tickBodyState`, `downBlend`, `bodyModifiers`,
`processMoveContacts` (mover → defender *and* mover self-reaction), `syncActorBody`,
`unregisterActorBody`, `ejectFromHull`. Tuning lives in `IMPACT_TUNE`; see
`KNOCKDOWN_IMPACT_SYSTEM.md`.

**`js/player.js`** — registers its body every frame, gates movement/actions on
`canAct()`/`canFire()`, lowers its box while down, reads `moveOpts` with actor awareness, applies
camera `viewDrop`/`knockRoll` while knocked down, and resets recovery state at boundaries.

**`js/enemies.js`** — mass table per archetype, impact-aware movement, actor-aware whisker
steering, `_stuckRecover()`, `canAct()` gating of shooting/advancing, a knock pose that rotates the
rig and hides the rifle, crouch blend while staggering, `repairSpawnPoint` (with one wider retry)
at spawn, and body unregistration on death/despawn. Authored spawn validation
(`_spawnPositionClear`) now sees vehicles and bodies, not just walls.

**`js/vehicles.js`** — hull actor bodies published after the move, per-frame `_processHullContacts`
(only for vehicles within 60 m of the player), `doorInfo`/`entryPointInfo`/`canBoardFrom`,
`boardingCandidate`, actor-aware `_safeExit`, and `ejectFromHull` for run-overs. See
`VEHICLE_COLLISION_BOARDING_REPORT.md`.

**`js/world.js`** — `box()`/`cyl()` stamp `mesh.userData.col` (`'solid'`/`'skip'`) so decor is a
*decision*, not a heuristic, and `_ensureCollisionCoverage(physics)` synthesises colliders for any
mesh no builder made a decision about (respecting keep-outs around spawn, extraction, objectives,
interactables, surge points and patrol waypoints, with `dedupe: true` so it is idempotent).

**`js/game.js`** — `_updateVehicleBoarding(inp)` owns `[F]` for boarding before the generic
interactable pass; `onBodyImpact(actor, state, speed, severity)` provides the audio/particle/shake
plus `KNOCKED DOWN` / `STAGGERED` feedback and noise for downed hostiles.

**`js/weapons.js`** — a knocked-down operator cannot fire and loses ADS: the trigger is blocked
until release, the burst queue is cleared, and `adsT` decays while down.

### Consumer contract (for future actors)

```js
// every frame, after the position is final:
this._body = syncActorBody(game.physics, this, this.box, { tag: 'actor', mass: this.mass });
// movement:
const out = {};
physics.moveBox(this.box, dx, dy, dz, out, step, { ignoreBody: this._body, actors: true });
processMoveContacts(this, physics, out, dt);      // defender + self reaction
// on death / despawn:
unregisterActorBody(physics, this);
// before placing any actor:
physics.repairSpawnPoint(pos, 0.32, 1.8);
```

---

## 3. Verification (all re-run after the final edits)

One command runs the whole thing and captures the evidence under `reports/`:

```bash
bash tests/run_all_suites.sh
```

| Check | Result |
|---|---|
| `tests/collision_gameplay_tests.mjs` — 32 behavioural tests, A–P2 | **32/32 PASS** (matrix: `reports/COLLISION_VERIFICATION_MATRIX.md`) |
| `tests/collision_leak_audit.mjs` — player-sized lattice probe, 112 maps | 4,220,734 samples, **0 leak cells, 0 no-floor cells, 0 maps with leaks** — exits non-zero if any appear |
| `tests/collision_coverage_audit.mjs` gate | fails the run below 95 % coverage (`MIN_COVERAGE_PCT` overrides); verified to fail at 99 % |
| `tests/collision_coverage_audit.mjs` — mesh↔collider coverage, 110 maps | 24,524 solid meshes, 23,947 covered = **97.65%** (was 90.78% before the coverage pass) |
| `tests/runtime_smoke.mjs` | 17 PASS, 0 FAIL |
| `tests/gameplay_v3_smoke.mjs` | 1 PASS, 0 FAIL |
| `tests/verify_requirements.mjs` | 15 PASS, 0 FAIL |
| `tests/campaign_100_audit.mjs` | 5 PASS, 0 FAIL — 100/100 missions, 100/100 layouts + fingerprints, 20/20 categories, **15,244 hostiles** spawned and neutralised through the new actor-body path (captured stdout:
  `reports/campaign_100_audit.txt`) |
| Per-frame cost at campaign scale | 200 actors + vehicles: **0.80 ms/frame** for AI + collision + vehicle integration |

Highlights from the behavioural suite (full table in `reports/COLLISION_VERIFICATION_MATRIX.md`):

* Walking into a soldier: sustained separation, worst penetration **−0.001 m**, and 4 s of sprint
  input travelled only **1.54 m** because a body stopped him.
* Sprinting into a soldier: he goes down (`standing → knocked_down → recovering`), and the attacker
  is **staggered** by his own hit; a charging heavy knocks the **player** down with camera
  `downBlend` peaking at **1.00**, then he recovers to standing.
* A **1.2 m/s** brush over 173 contact frames: **0 reactions** — walking into someone is not a
  tackle.
* Rate limiting is asserted as *spacing*, not a count: 10 s of 7.5 m/s ramming produced **1**
  knockdown and left the player standing for **76 %** of it (the rammer is locked in its own
  stagger cycle), and 3 bodies ramming at once for 15 s kept the player off-balance only **26 %**
  of the time — pressure, never a stun-lock.
* 600 frames of resting contact produce **0 knockdowns** — no spam, no loop.
* 600 frames of a heavy shoving the player into a real wall: worst penetration **−0.026 m** — never
  pushed through.
* 180 mm panel vs 50 ms hitched sprint frames: **blocked on every frame** (no tunnelling).
* 8 map families × 540 walk/run/crouch approaches to a parked truck: **4,320 approaches, 0 hull
  entries**.
* Hull collider vs mesh while driving: divergence **0.0 mm**.
* Driven truck run-over: knockdown at 23.5 m/s, peak victim speed 1.44 m/s, victim never left
  inside the hull.
* Boarding: prompt is exactly `PRESS [F] — ENTER VEHICLE` at the door; refused from the opposite
  side and from 3.4 m away; egress with a wall built flush against the door relocates to the clear
  side, **3.52 m** from the doorway, never inside the hull.
* 143 authored spawn points across 8 maps: **0 left embedded**; 9 deliberately buried spawns
  (8 inside a vehicle hull, 1 inside a wall) all relocated by the spawn repair.
* 120 frames of held trigger while knocked down: **0 rounds fired**, ADS released, and the trigger
  has to be re-pressed after standing up.

**Known limit (unchanged, stated honestly):** this is a headless harness. It drives the real
`Player`/`Enemy`/`Vehicle`/`WeaponSystem`/`Game` code paths and asserts on transforms, collision
state and the real prompt strings, but it does not rasterise the scene — browser-rendered look,
audio audibility and input latency remain unverified in this environment.

---

## 4. Packaging

| Item | Value |
|---|---|
| Archive | `VeilStrike_v4.1_CollisionVehicles_Fixed.zip` (workspace root, next to the untouched `VeilStrike_v4.0_Campaign100_Standalone.zip`) |
| Contents | 107 files — the game (index, css, js, assets incl. vendored `three`), `tests/`, and the `reports/` evidence · `SHA256SUMS.txt` lists every one |
| Manifest | `SHA256SUMS.txt` regenerated over exactly the shipped file set (105 hashes + itself) |
| Service worker | `CACHE_VERSION` bumped to `v17.1.0-collision-vehicles-20261105`, and `js/impacts.js` added to `PRECACHE` — without the bump an already-installed PWA would keep serving the *old* `physics.js`/`player.js` from cache and none of this would be visible to players |

**Clean-extract verification (not just a directory copy):** the archive was extracted to a fresh
empty directory and the shipped verification was run *from that extraction*:

```
OK lines: 105 / 105                      # every file matches its published hash
collision_behaviour_tests    exit=0  PASS=32  FAIL=0
collision_coverage_audit     exit=0  PASS=1   FAIL=0
collision_leak_audit         exit=0  PASS=1   FAIL=0
runtime_smoke                exit=0  PASS=17  FAIL=0
gameplay_v3_smoke            exit=0  PASS=1   FAIL=0
verify_requirements          exit=0  PASS=15  FAIL=0
campaign_100_audit           exit=0  PASS=5   FAIL=0
```

The extraction needs no `npm install` and no network: `tests/progress_test_loader.mjs` maps the
`three` import to `assets/vendor/three.module.js`, which ships in the archive.
