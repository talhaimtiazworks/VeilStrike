# VEILSTRIKE v4.3 — click-to-fire and tactical map: fix report

Date: 2026-11-05. Build: `v17.3.1-clickfire-tacmap-20261105` (service-worker cache version).
Archive: `VeilStrike_v4.3_ClickFire_TacMap_Standalone.zip` (v4.0 / v4.1 / v4.2 archives untouched).
Nothing here is deployed and nothing is pushed to a remote.

---

## 0. What was reported, and what was actually true

| Reported | Verified diagnosis |
| --- | --- |
| "one click still fires three bullets, even after v4.2" | True, and *not* an ammunition bug: the pre-fix pipeline had no discrete-click concept at all. A click is a ~250 ms hold, and automatic fire re-fires on every frame past its RPM timer. Measured ladder: 17 ms → 1 shot, 150 ms → 2, 250 ms → **3**, 500 ms → 5 (VX-4 @ 660 RPM). Same shape for every automatic weapon. |
| "the map is blurred, unreadable, symbols unexplained, player/objective/route indistinguishable, labels sit on the route, FOV cone oversized" | All true in the pre-v4.3 build (a CSS-blurred bitmap snapshot, decorative dashed routes, hand-placed shapes, an unexplained symbol set, a ~40 m FOV wedge). |

The v4.2 ammunition pass was **not** wrong — its claim ("one shot = one round") still holds and is
re-verified here. It simply measured a different invariant: `rounds === shots` is equally true when
one click produces three shots. The missing invariant was `shots === clicks`, and no test entered the
pipeline above `tryFire()`, which is where the defect lived. Details, with the code lines:
**`FIRING_INPUT_ROOT_CAUSE.md`**.

---

## 1. Part A — one click = one firing event = one shot = one round

### 1.1 Files changed

| file | change |
| --- | --- |
| `js/fireinput.js` | **new** — `FireTriggerInput` + `FIRE_INPUT` constants. Turns DOM press/release into discrete firing events. |
| `js/game.js` | `_fireInput` created with the game (`:627`); mousedown/mouseup call `press('mouse')` / `release('mouse')` (`:745-756`); new sole input→fire step `Game.prototype._fireStep(dt)` (`:2417`); every state transition resets the trigger (`:1213`, `:1574`, `:1716`, `:1732`, `:2128`, `:2498`); `_bindInput` made idempotent (`_inputBound` / `_rebindCount`); **mousedown returns early while the tactical map is open** (`:739`); the old "AUTO FIRE" assist checkbox path was removed from `index.html`. |
| `js/weapons.js` | `canAcceptTriggerAt(now)` (`:1179`) and `triggerStateBusy()` (`:1193`) expose the accept/drop decision to the input layer; `spendRound()` (`:1509`) remains the **only** place a round is charged (called once per discharge at `:1709`) — unchanged from v4.2. |
| `js/touch.js` | fire button routes through the same `press('touch')` / `release('touch')` (`:211-212`, `:273-274`); aim-assist hold uses `setAssistHeld(true)` (`:336-339`) — a hold, never a synthetic click. |
| `index.html` | AUTO FIRE checkbox removed; tactical-map toolbar added (see Part B). |
| `tests/firing_input_tests.mjs` | **new** — F1…F16, the shipped-pipeline input suite. |
| `tests/firing_pipeline_tests.mjs` | **new** — P1…P6, the pre-fix contract kept as a pin so the old numbers stay reproducible. |
| `tests/ammunition_tests.mjs` | v4.2 checks untouched; 5 checks added in the v4.2 pass for the single-charge-point rule. |

No weapon definition was edited: fire modes, RPM, damage, zone multipliers, falloff, bloom, recoil,
magazine sizes and start reserves are byte-identical to the `tests/baselines/weapons_v4.1.json`
baseline (checked by `verify_requirements` / the ammunition suite).

### 1.2 How a click becomes a shot now

```
mousedown ─┐
touchstart ─┼─► FireTriggerInput.press(source) ─► queue: 1 firing event per physical press
assist-hold ┘                                     (deduped per source; MAX_QUEUED = 2)
                    │
   every frame: Game._fireStep(dt) ─► sample(time, dt, {mode, accepting, busy})
                    │                    ├─ click event present  -> triggerDown true for one step
                    │                    ├─ held past 0.25 s (auto) -> triggerDown stays true
                    │                    └─ weapon busy -> event dropped, not banked
                    ▼
        WeaponSystem.tryFire(now, triggerDown)     <- semantics unchanged
mouseup ──► FireTriggerInput.release(source)       <- held state ends; auto stops next step
```

Enforcement, and the check that pins each rule:

* one queued event per press, removed on delivery, never re-delivered — **F1** (220 click cases over
  every weapon × mode × click length), **F6** (a duplicate/stuck mousedown for a held button adds
  nothing), **F6b** (200 clicks inside one frame produce 1 event; the queue never exceeds 2);
* a short press can never engage auto (`AUTO_ENGAGE_S = 0.25 s`, time-based so it is frame-rate
  independent) — **F9** (200 ms click → 1 shot; 1 s hold → 9 shots ≈ 660 RPM; frozen after release);
* semi never repeats, however long the button is held — **F8** (10 s hold = 1 shot; 10 presses = 10
  shots); burst arms exactly one configured burst and may finish after release — **P6**
  (`vekp/cr9/rk4/sz8`: 3 shots / 3 rounds per press);
* a click while reloading, drawing, knocked down, paused, jammed or map-open is swallowed and costs
  nothing — **F10**, **F11**, **F15**, **F16**;
* mouse, touch and assist cannot double-fire the same action — **F7**;
* listeners cannot multiply — **F5** (`mousedown/mouseup/mousemove/keydown` stayed `1/1/1/1` across
  three `_bindInput()` calls, and still only 1 shot);
* the debit is unchanged and single-owner — **F2**: for all 12 weapons × all modes,
  `charges === shots === rounds`, and the ST-12 is 1 discharge / 1 shell / 9 pellets.

### 1.3 Ammunition ladder, counted in clicks (measured)

Starting loadout 300 rounds (`mag + reserve`), one click = one firing event:

| clicks | rounds left | VX-4 semi | VX-4 auto | MR-7 | PX-9 semi | PX-9 auto | ST-12 | VEKTOR-P semi/auto | LB-9 | HMG-9 semi/auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 299 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 2 | 298 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 10 | 290 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 20 | 280 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| 100 | 200 | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |

Asserted in **F3** for one weapon of *every* category and every non-burst fire mode (11 weapon/mode
combinations), with `shots === clicks` and `rounds === clicks` at each step; **F4** repeats it at 20
clicks for 9 pairs; `tests/ammunition_tests.mjs` keeps the pellet/tracer/effect-free charging rules.
Reloads are unaffected: **F12** — 15 clicks → 15 rounds, the following reload moves exactly 15 with
45 in hand.

Note on method: every count is read from `g.stats.shots` and the real `state.mag`/`state.reserve`
through the shipped `spendRound`. No test in this pass asserts a HUD string.

---

## 2. Part B — the tactical map, rebuilt on mission data

### 2.1 What was wrong before

1. The panel painted a *snapshot bitmap* of the 3D view and put `filter: blur()` + `box-shadow`
   glows on it — permanently soft, unreadable at any zoom.
2. Geometry was partly decorative: fixed-size blobs and dashed lines that did not correspond to the
   mission's colliders, so markers could sit where no wall was and a wall could hide no obstacle.
3. No projection contract: world→panel conversions were ad hoc, so markers drifted when the panel was
   resized and the minimap disagreed with the big map.
4. Every symbol was unexplained; enemy, friendly, vehicle and supply marks were near-identical, and
   the player icon, the objective and the route line were not visually distinct.
5. The FOV cone was drawn at a radius that swamped the map (~40 m), labels were painted wherever the
   loop reached, i.e. on top of the route and on top of each other, and the route itself was a dashed
   straight line to the objective — through walls.

### 2.2 How mission geometry is obtained

`js/mapgeom.js` (new, 472 lines) is the only thing that decides what the map may show:

* **Input:** `game.physics.colliders` (the same AABB bodies the player collides with — `js/world.js`
  registers them, `js/physics.js:266 add()` / `:29 Collider`), plus `game.world.bounds` for the
  mission rectangle, `missions.js:810 mapTargets()` for objectives, and the mission's interactables,
  vehicles, doors and supply state. Nothing is authored for the map: **if it is not in the world, it
  is not on the map.**
* **Classification** (`classifyCollider`, one collider → one feature): tags and material first, then
  height/extent rules. `vehicle` tags → vehicles; `door` → doors (walkable for planning, drawn as
  gaps); `glass` → transparent barrier unless its top is above the step height; flat ground/decks →
  non-blocking washes; `*_room` tags → rooms labelled by name; `pillbox`/`radar_plinth`/`tunnel`/
  `dam_crest` … → landmarks; tall + wide → **building**; thin + tall → **wall**; mid-height → cover
  **barrier**; `h < 0.45` → **flat** (drawn, never blocking). Collision metadata is *simplified for
  display only* — the physics bodies are untouched (`nav` is a display/planning annotation).
* **Ground cover (v4.3 review fix):** roads and open ground come from
  `world.vehicleSurfaces` (`js/world.js:1077`) — the same rectangles the vehicle physics
  samples for grip and drag. Each rect is classified by the material name the mission gave it
  (`asphalt/pave/road/street/tarmac/runway/bridge-deck/helipad/concrete/dock` → **ROAD**,
  everything else → **OPEN GROUND**) and painted as a wash under the structures. The map drew no
  roads at all before this pass; it still draws none where a mission registers none, because the
  alternative would be decoration. T15 pins the provenance (10 metro lanes = 10 authored records,
  exact rectangle and material match, none blocking a route) and T11 checks the equality across all
  100 operations.
* **Culling for legibility:** a rect must reach `minWallThickness` 1.45 m / `minBuildingArea` 26 m² /
  `minBuildingSpan` 3.2 m to be painted as a mass; smaller things still feed the nav grid, so the
  route respects cover the map chooses not to draw. Hard caps (`maxRects` 2600, `maxNavCells` 260k)
  guard a runaway draw.
* **Cache key** (`geometryKey`): `mapId | colliderCount | enabledCount | openDoors | objectivesVersion
  | chargeCount` — rebuilt when the world changes (T13 measures 47 → 48 features when a collider is
  added and back to 47 when destroyed, with the player's state untouched by a repaint).

### 2.3 Rendering architecture

`js/tacmap.js` (rewritten, 1338 lines) draws **vector primitives directly in screen space** each
frame. That choice is the whole blur fix: there is no bitmap to resample, no `filter`, no
`shadowBlur`, no CSS glow, and text is painted at a constant device-pixel size at every zoom.

* one projection (`_prepareView` → `_worldToScreen` / `_screenToWorld`), used by the full map *and*
  the minimap, so the two can never disagree (T1: 83 coordinate assertions, 3 mission types × 2
  orientations, all within 1.3 px of an independently computed projection; T12: the minimap paints
  18 vector rects from the same classified features and no bitmaps).
* layers painted in a fixed order: `_drawField` (ground washes, roads, terrain tint) → `_drawMasses`
  (buildings/walls/cover/rooms/landmarks, tinted by material) → `_drawFog` (unseen area as hard-edged
  run-length rects with `imageSmoothingEnabled = false`) → `_drawRoute` → `_drawMarkers` (objectives,
  friendlies, vehicles, discovered supply, enemies) → `_drawPlayer` → `_paintLabels` (de-collision) →
  `_paintOverlays` (scale bar, status line, legend-adjacent plates).
* **player icon**: chevron + facing + a **11 m** FOV wedge at ±33° (`MAP_STYLE.fovRadius`) — about 7 %
  of a fitted view instead of the old 40 m sweep; it tracks `yaw` (T4).
* **knowledge, not wallhacks**: enemies are painted only if the mission's own detection/reveal rules
  already know them (`tm.known`); an unseen enemy behind a wall yields 0 markers, an enemy in view
  yields 1, a killed one is pruned (T6). No raycast peeking was added for the map.
* **labels**: solid plate + 10–11 px type at every zoom, placed in the least crowded of the candidate
  slots, priority-ordered (player 0 < objective 1 < extraction 2 < route 3 < building 4 < cosmetic
  5+); critical labels are never dropped, cosmetic ones are. T10 measures 0 plate overlaps and 0
  labels over the player icon or the route line at fit zoom; T1/T7 also assert labels stay off the
  route.
* **legend**: `MAP_LEGEND` (33 rows, incl. `ROAD / PAVED SURFACE` and
  `OPEN / UNPAVED GROUND`) in `js/tacmap.js` is the single source for both the DOM key in
  `index.html` and every painted glyph; a symbol with no legend row, or a legend row with no symbol,
  fails T5. The 11 interaction kinds (door, terminal, crate, cache, hostage, vault, …) each map to a
  glyph through `INTERACTABLE_KIND`.
* **no blur, measured**: T3 asserts 0 `drawImage`/`putImageData`/`filter`/`shadowBlur` calls at 5 zoom
  levels, `imageSmoothingEnabled` written `false` at every paint, and no `blur` in the map's CSS rules.

### 2.4 Route computation (not decoration)

* A* on a `MAP_GEOM.navCell = 1.5 m` grid; a cell is blocked when a collider overlaps it at body
  height (`max.y > 1.15 m && min.y < 1.80 m`), inflated by `clearance = 0.55 m`; no corner cutting
  through diagonals.
* A straight-line fast path is used when the segment is verified clear; otherwise the path is smoothed
  with `segmentClear` re-verification, falling back to the raw A* path if smoothing would cut a corner.
* Doors: the primary grid treats a closed door as solid. If no route exists, the planner retries with
  `throughDoors` and, when the only path goes that way, the route is labelled **THROUGH DOOR** and the
  status line says **VIA DOOR** — an honest statement about a path you must open something to walk.
* Ends that are not walkable (objective on a deck, in a sealed room) snap to the last legal cell and
  paint a dotted **"LAST n m ON FOOT"** spur with the residual distance, rather than pretending the
  route reaches the marker.
* **No route ⇒ no line.** The map paints a red X at the objective and the status line reads **NO
  WALKABLE ROUTE** (T8 pins this with a sealed objective).
* Re-planned when the objective changes, the world changes, or the player crosses a cell boundary;
  the cache key is `geom.key | playerCell | targetCell | kind | routeSel`, which is why the route costs
  0 ms to keep while you walk inside the same cell (T14: long route in 0 ms).
* Measured across the campaign: **T11 — 100 of 100 operations** mapped from 100 unique layouts (min 42
  features/map), geometry built + routed in ~31 ms average, worst ~59 ms, 100 routed with 0 cases of a
  route drawn through impassable geometry, and 8 sample layouts repainted in 1.2–3.4 ms / 596 draw
  calls. T7 validated **32 routes segment-by-segment against the collision grid** on 5 missions: 14
  stopped at the last walkable cell and 15 of those reported the residual hop.

### 2.5 Controls and responsiveness

Toolbar (`index.html`): `ZOOM-` `ZOOM+` `FIT` `ROT` `ROUTE` `3D` `CLOSE`; the legend is generated
into `#tacmap-legend` by the module. Pointer/wheel/touch: drag to pan, wheel/pinch to zoom (clamped
to `[0.08, 4]`), double-tap-free, `touch-action: none` on the canvas so the page does not scroll,
click/tap a marker to select the objective (`_selectAt`, with `EXTRACTION — 120 m NE`-style distance
plates). Opening the map **fits the whole mission area** (T9: open framed the full 164×164 m area,
FIT centres the map bounds not the player, pan moves by exactly the dragged pixel count, and 176 → 40
draw calls when zoomed in with 0 off-screen rects painted). `ROT` switches north-up/player-up; `3D`
keeps the existing fly-through panel; the minimap keeps its own cadence gate (~15 Hz) and never paints
labels (T12). CSS (`css/hud.css`): `.lg-*` legend grid, `#tacmap-controls { flex-wrap: wrap }`,
`#tacmap-canvas { min-height: 42vh; touch-action: none; cursor: grab }`.

### 2.6 Performance

Per repaint, measured on real missions (T11/T14): full-size repaint **≤ 1.9 ms / 596 draw calls**
at fit zoom, **0.54 ms / 230 calls** mid-game with fog; zoomed-in culling cuts a 183-call frame to
44; fog growth is local (0 → 354 of 3364 cells after a walk); route re-planning is cached (0 ms on
the common path); geometry build is amortised once per world change (~31 ms average per mission, worst
~59 ms, and it is off the render path — it runs on the map-open/objective-change/key-change events).
The old build's per-frame bitmap copy + CSS filter is gone entirely.
Re-running the whole 13-suite script inside the extracted archive (so 13 node processes were
competing for the same cores) measured the same geometry at 32.2 ms average build, worst repaint
6.6 ms — still inside the suite's own 45 ms gate, and the number to read as "worst case under
self-inflicted load" rather than a single map open.

---

## 3. Automated results

`bash tests/run_all_suites.sh` from the project root (Node 18+, no install step), 13 suites:

```
collision_behaviour_tests    exit=0  PASS=33  FAIL=0
collision_coverage_audit     exit=0  PASS=1  FAIL=0
collision_leak_audit         exit=0  PASS=1  FAIL=0
enemy_ai_combat              exit=0  PASS=27  FAIL=0
ammunition                   exit=0  PASS=12  FAIL=0
ammo_pickups                 exit=0  PASS=20  FAIL=0
firing_pipeline              exit=0  PASS=6  FAIL=0
firing_input                 exit=0  PASS=16  FAIL=0
tactical_map                 exit=0  PASS=15  FAIL=0
runtime_smoke                exit=0  PASS=17  FAIL=0
gameplay_v3_smoke            exit=0  PASS=1  FAIL=0
verify_requirements          exit=0  PASS=15  FAIL=0
campaign_100_audit           exit=0  PASS=5  FAIL=0
```

Totals: **13 suites, 169 checks, 0 failures** (verbatim `reports/verification_summary.txt` from a
single clean run of the script, exit status 0). Highlights of the new suites, with the exact evidence lines:

* **firing_pipeline** 6/6 — P1 VX-4 pre-fix ladder `1f->1 9f->2 15f->3 30f->5`; P2 the same for
  `vx4 1/2/3/5 @660`, `p9 1/2/3/5 @720`, `mpx5 1/2/3/6 @850`, `vekp 1/3/4/8 @920`, `cr9 1/2/3/5 @700`,
  `hmg9 1/2/3/5 @600`; P3 semi immune (10 s hold = 1 shot, 20 presses = 20 shots); P4 the shipped
  pipeline makes the same 250 ms click exactly 1 shot / 1 round for 9 weapon/mode pairs; P5 a real hold
  still auto-fires at RPM (cadence gaps ≥ 60/RPM, frozen on release); P6 one press = one burst.
* **firing_input** 16/16 — see §1.2/§1.3.
* **tactical_map** 15/15 — see §2.2–§2.6 (T1 projection, T2 provenance, T3 no blur, T4 icon/FOV, T5
  legend, T6 knowledge, T7 route validity, T8 no-route state, T9 fit/controls/culling, T10 labels,
  T11 all 100 missions, T12 minimap, T13 cache invalidation, T14 fog/performance).
- **Regressions, all still green:** collision behaviour 33, collision mesh coverage 1, 112-map
  walk-through/fall-through leak audit 1, enemy AI/combat 27, ammunition accounting 12, ammo pickups
  20, runtime smoke 17, gameplay v3 smoke 1, requirements 15, 100-mission campaign audit 5.
- `python3 tests/module_delivery_smoke.py` → **PASS**, 43 JavaScript modules served with JavaScript
  MIME (now including `js/mapgeom.js` and `js/fireinput.js`), no missing-module fallback, and the
  three soundtrack paths served as `audio/mpeg`. `sw.js` PRECACHE lists both new modules, and the
  cache version was bumped so existing clients re-precache.

## 4. Browser testing — what was and was not possible

**No browser verification was performed, because none is possible in this environment.** There is no
Playwright, no Puppeteer-managed Chrome and no `chromium`/`firefox` binary in the sandbox
(`which chromium chromium-browser google-chrome firefox` → nothing; `npx playwright` is not
installed), and installing one is out of scope per the brief's "no unnecessary installs". There is
therefore **no screenshot, no pixel comparison, no real pointer-lock session, no measured human click
duration and no eyeballed font rendering** behind this report — including for the "no blur" and
"readable labels" claims.

What was done instead, and why it is a reasonable (but *partial*) substitute:

* the DOM layer is exercised for real: a recording `document` with the shipped `_bindInput` and
  actual `MouseEvent` dispatch, so listener counts, press/release ordering and the map-open guard are
  executed code, not mocks;
* the map is exercised through a recording 2D context with a real 2×3 CTM: every rect/arc/text/line is
  captured and asserted geometrically against an independent projection — a claim like "labels never
  cover the route" is a box-overlap test over the captured plates, and "no blur" is the absence of any
  rasterising call plus `imageSmoothingEnabled = false`;
* `node --check` on every edited JS file, plus `tests/module_delivery_smoke.py` for delivery, and the
  suites re-run inside the extracted ZIP (see §6).

**Please re-check these in a browser** (they cannot be asserted headlessly): perceived crispness of
text at the smallest supported width, the map's colour contrast under your monitor's gamma, the feel of
drag-to-pan on a trackpad, and the click→shot cadence with a real mouse at your hand speed.

## 5. Remaining limitations (no hand-waving)

1. **Classification is heuristic.** `classifyCollider` reasons from tags, material and AABB extents; a
   prop whose tag is unknown is placed by height, so an unusually tall crate could be drawn as a wall
   mass (it would still be *nav-correct*, because nav uses the real AABBs). It is a legibility issue,
   not a truth issue.
2. **Grid resolution.** The route grid is 1.5 m cells with 0.55 m clearance. A route can therefore be
   planned through a gap of 1.5–3 m that a skilled player could squeeze through differently; it will
   never plan *through* a solid body, but it is not a capsule-exact sweep.
3. **Verticality is flattened.** The map is a top-down projection: decks, rooftops and tunnels are
   painted and labelled, but a route is computed in 2D, so multi-level interiors can show a route that
   is walkable in plan but needs a stair/ramp. The `LAST n m ON FOOT` spur and `NO WALKABLE ROUTE`
   plates are the honest signals there; the `3D` fly-through panel remains the way to see height.
4. **Visibility is the mission's, not the map's.** If the detection model has not seen an enemy, the
   map cannot show one. That is deliberate (no wallhack) but it means "clear on the map" ≠ "clear in
   the world".
5. **Ground data is vehicle-surface data.** Roads and open ground are only as complete as
   `world.vehicleSurfaces`: a lane drawn as pure scenery with no surface record is not on the map
   (measured coverage: metro 10, harbor 4, canal market 9, rural 4, desert 1, snow 2, facility 7,
   industrial 0 — the last is genuinely all building, no authored ground records).
6. **Click vs cycle time.** A click faster than the weapon's own cycle is dropped, not queued — by
   design (F11): no shot debt is paid out after a reload or a knockdown. A human mashing 12 clicks/s on
   a 0.5 s bolt-action gets one shot per cycle, not twelve; the same is true of the real rifle.
7. **The VX-4's 300-round continuous feed** keeps its v4.2 semantics (no reload gate); the ladder in
   §1.3 therefore measures pure click→shot→round arithmetic for it and a mag+reserve pool for others.
8. **Route labels describe the plan, not the world state**: "THROUGH DOOR" means the only legal path
   uses a door that is currently closed. Nothing forces you through it.
9. **Headless only**, per §4.

## 6. Files added / changed in v4.3 (complete)

```
added    js/fireinput.js              discrete trigger input (press/release, queue, dedupe, auto engage)
added    js/mapgeom.js                mission-data -> map geometry: classification, nav grid, A*, routes
changed  js/tacmap.js                 full rewrite: vector renderer, projection, layers, legend, controls
changed  js/game.js                   fire step, input binding idempotence, map-open click guard, resets
changed  js/weapons.js                canAcceptTriggerAt / triggerStateBusy exposed; spendRound unchanged
changed  js/touch.js                  fire button through the same press/release
changed  index.html                   map toolbar + legend host; AUTO FIRE checkbox removed
changed  css/hud.css                  map panel: legend grid, control wrapping, canvas min-height, cursor
changed  sw.js                        PRECACHE += js/mapgeom.js, js/fireinput.js; CACHE_VERSION v17.3.1
changed  tests/run_all_suites.sh      + firing_pipeline_tests, firing_input_tests, tacmap_tests (13 suites)
changed  tests/ammunition_tests.mjs   (v4.2 additions kept; no v4.2 check weakened or removed)
added    tests/firing_pipeline_tests.mjs   P1-P6   (pre-fix cadence, pinned)
added    tests/firing_input_tests.mjs      F1-F16   (shipped input layer, all weapons, ammo ladder)
added    tests/tacmap_tests.mjs           T1-T15   (geometry, projection, no-blur, routes, controls, ground data, perf)
added    FIRING_INPUT_ROOT_CAUSE.md      exact root cause + enforcement
added    FIRE_INPUT_TACMAP_FIX_REPORT.md this file
```

How to re-verify locally (from the extracted root):

```
bash tests/run_all_suites.sh            # 13 suites, writes reports/*.txt + verification_summary.txt
python3 tests/module_delivery_smoke.py  # module MIME / service-worker delivery
node --loader ./tests/progress_test_loader.mjs tests/firing_input_tests.mjs
node --loader ./tests/progress_test_loader.mjs tests/tacmap_tests.mjs
```
