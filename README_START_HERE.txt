VEILSTRIKE v4.4 — FULLY INTERACTIVE TACTICAL MAP (VERIFIED IN A REAL BROWSER) — DEPLOY & PLAY
==============================================================================================

PACKAGE ROOT
  Extract the ZIP into a directory. That directory is the site/project root:
  index.html, vercel.json, js/, css/, and assets/ are directly inside it.
  Do not upload the ZIP to a raw-file viewer or point hosting at a parent folder.

V4.0 100-MISSION CAMPAIGN EXPANSION
  - 100 playable, completable campaign operations across 5 Acts (OP 001 through OP 100),
    plus extensible registration (`extendCampaignMission()`) for Operations 101+.
  - Progressive campaign unlocking from Mission 1 onward: Mission 1 is unlocked initially;
    completing Mission N unlocks Mission N+1 and persists in localStorage.
  - 100 unique 3D combat environments spanning all 20 tactical environment categories
    (military bases, dense urban blocks, industrial works, abandoned factories, desert
    installations, mountain passes, woodland outposts, coastal batteries, port harbors,
    airfields/hangars, underground tunnels, bunker networks, research labs, power stations,
    oil refineries, rural villages, highway bridges/dams, border checkpoints, rail hubs,
    and fortified command citadels) with 22+ modular collidable 3D structure kits.
  - Progressive enemy scaling: Minimum Hostiles = 50 + (Mission Number - 1) * 2
    (OP 001 >= 50, OP 050 >= 148, OP 100 >= 248), streamed smoothly in tactical waves
    (<= 12 simultaneous active AI actors) with live HUD hostile/wave tracking.
  - Scalable 100+ Operations Command selector with Act tabs, 20-category filter, live search,
    completion ratings, and lock status.
  - Preserves all v3.2 weapons (300-round continuous VX-4, Y zoom, swept physics/fall recovery,
    vehicles, helicopter extraction gating, touch controls, and 3-track MP3 soundtrack).

V4.4 TACTICAL-MAP INTERACTION PASS (this build)
  - The map is now an instrument you manipulate, not a drawing you look at. Pan by drag (mouse, one
    finger, or two fingers), zoom to a point with the wheel / pinch / +/- keys with the world point under
    the cursor staying under the cursor, 0.06x-10x continuous zoom that never leaves the mission area,
    and drag-vs-tap disambiguated so selecting a marker is never an accidental pan.
  - Everything on the map is selectable: 42 kinds of tap target per operation (objectives, extraction,
    hostiles, contacts, power, terminals, doors, building masses, props) open a detail card with type,
    distance/bearing and status, and one button (NAVIGATE) plans a walkable route to that exact thing;
    the route line, the "NO WALKABLE ROUTE" verdict and the inspector update together.
  - Eleven content layers (buildings, walls, roads, cover, vehicles, doors, interior, terrain, routes,
    labels, fog) can be switched off from LAYERS without changing what is walkable - hiding walls cannot
    hide an obstacle, because routing reads the collision grid, not the paint.
  - Full interface: the panel floats (FLOAT / double-click the bar to maximise), moves by its title bar,
    resizes from the corner grip, and the canvas follows the window pixel-for-pixel at any
    devicePixelRatio. FOLLOW keeps you centred until you grab the map; ROT switches north-up/player-up;
    VIEW: 3D hands the same mission to the real fly-through and back to a working 2D map.
  - Input isolation is explicit: while the map is up, W/A/D/Shift/3/R/E and the trigger do nothing at all
    (measured: player position, facing, health and trigger state untouched through every key), and no
    gesture reaches the game canvas underneath. Closing and reopening restores the exact view you left.
  - Seven defects were found ONLY by running a real browser, and are fixed with permanent guards (the
    tally is in MAP_INTERACTION_v4.4_REPORT.md section 1.1): (1) the map overlay had no pointer-events
    of its own, so in v4.3 every pan, wheel tick and marker tap was hit-tested straight through the map
    onto the game canvas (all headless tests passed because they dispatch events at the element, not at
    a point); (2) the float window wrote style.left/top before style.inset and the shorthand erased
    them, and the same window was sized against rules meant for the full-screen frame (max-width:96vw /
    min-height:42vh); (3) the legend painted its captions across column boundaries so they lay on top of
    each other; (4) the zoom readout went stale after an anchored zoom; (5) at a fractional
    devicePixelRatio the last device row of the map was never painted (a 1 px transparent seam); (6) the
    floating window could be dragged out of reach, and dragged by pressing its own buttons; (7) on a
    phone the detail card covered the middle of the map and swallowed every gesture starting there.
    Two phone-layout mistakes from the same screenshot review (the toolbar row running past a 412 px
    panel; the status strip colliding with map labels) were fixed the same way.
  - Verified in real Chromium 141 (Playwright + CDP) across 6 environments - 1920x1080, 1440x900 @2x,
    1024x640, 2560x1080 ultrawide, 1024x768 touch and 412x915 @3x touch - with hit testing, painted
    pixels, palette conformance, backing-store math, gesture deltas, frame budget and console cleanliness
    asserted from the live page: 226/226 checks passed across 6 environments, 0 failures. Evidence: tests/browser_map_tests.mjs,
    reports/browser_map_tests.txt and reports/browser/*.jpg (the screenshots the suite checked).
    Headless: the 13 headless suites report 175 checks across 13 suites, 0 failures. Docs: MAP_INTERACTION_v4.4_REPORT.md.
  - Browser tests are optional at runtime and skip cleanly: `bash tests/run_all_suites.sh` runs them when
    Playwright and Chromium are installed and prints a SKIP line when they are not - no dependency is
    added to the game. To run them directly: `npm i playwright@1.56.1 && node tests/browser_map_tests.mjs`
    (env `VEIL_BROWSER_ENV=phone-touch,tablet-touch` runs a subset).

V4.3 CLICK-FIRE AND TACTICAL MAP PASS (retained and regression-tested in v4.4)
  - One mouse click now means exactly one shot, in every fire mode. The old pipeline had no concept
    of a click at all: mousedown set a held boolean and the frame loop fed that boolean to
    tryFire(), so automatic fire re-fired on every frame past its RPM timer and a normal 250 ms
    click cost 3 rounds (measured: 17 ms -> 1, 150 ms -> 2, 250 ms -> 3, 500 ms -> 5 shots, for each
    automatic weapon). js/fireinput.js turns a press into one discrete firing event;
    Game.prototype._fireStep() is the only place input becomes fire. Rapid clicking works with no
    hold required, a click the weapon cannot take is dropped rather than banked, mouse/touch/assist
    share the one mechanism, and a click on an open map neither fires nor grabs the cursor. The
    300-round ladder is exact for every weapon category: 1 click -> 299, 2 -> 298, 10 -> 290,
    20 -> 280, 100 -> 200 (a shotgun shell is one round however many pellets it throws).
    Root cause, fix and enforcement: FIRING_INPUT_ROOT_CAUSE.md.
  - The tactical map (M) is rebuilt from mission data instead of decoration. Every painted shape comes
    from the live world: colliders are classified into buildings, walls, cover, vehicles, terrain and
    landmarks by js/mapgeom.js, projected through one exact world-to-map transform, with roads, bounds
    and objective positions taken from the mission itself - nothing is invented or hand-placed.
    Heavy blur is gone (the map is drawn as vector primitives in screen space, so there is no bitmap to
    resample or soften), text is a constant readable size on a solid plate, the legend is generated from
    the same table that paints the symbols, and the player icon, facing and a small 11 m field-of-view
    wedge are separate from the objective markers (primary / secondary / extraction / interaction).
  - Routes are computed, not drawn: A* over the collision grid, smoothed only along lines that are
    verified clear, snapped to the last walkable cell with an honest "LAST n m ON FOOT" spur, re-planned
    when the objective changes, and reporting "NO WALKABLE ROUTE" when the objective really is sealed.
    Enemies appear only when the existing detection rules have actually seen them - no wallhack.
  - Map controls: wheel/pinch zoom, drag/two-finger pan, FIT (frame the whole mission area), ROT
    (north-up / player-up), ROUTE (auto or click-to-select objective), 3D (real fly-through), CLOSE,
    click a marker to select it. Zoom, pan and label density work at desktop and narrow widths.
  - Docs: FIRE_INPUT_TACMAP_FIX_REPORT.md (root causes, architecture, automated results, what could
    not be tested in a browser) + reports/tactical_map.txt + reports/firing_input.txt +
    reports/firing_pipeline.txt.
  - Honesty note (as written for v4.3): that build was verified headlessly only - no browser was
    available, so nothing about pixels, font rendering or pointer-lock feel had been eyeballed. v4.4
    closed that gap: the same map was re-tested in a real browser, and the pointer-events defect above is
    what a headless-only claim could not have caught. The v4.3 firing numbers still stand (they are
    arithmetic on the model, not on pixels).

V4.2 ENEMY AI, COMBAT BEHAVIOUR & AMMUNITION PASS (retained and regression-tested in v4.3)
  - Enemies now find you the way the brief asks: recognition accrues from line of sight, distance,
    field of view, stance and noise — not from a distance counter. A wall means never spotted, and a
    shot fired at you cannot pass through one either (verified on operations 12, 44 and 88: 0 shots
    through verified geometry). Gunfire draws nearby squads to the report.
  - Full combat behaviour: PATROL / SUSPICIOUS / ALERT / COMBAT / SEARCH / REPOSITION / DEAD. Soldiers
    orient before they fire, have a reaction and aim-convergence delay, fire at weapon-specific rates
    in bursts, miss sometimes, reload when dry, walk to your last known position when they lose you,
    and stop everything when you are dead or out of sight. A killed soldier stops moving and shooting.
  - Movement is smoothed without touching collision: ramped acceleration/braking, state-capped turning,
    a controlled about-face instead of a 180° snap, obstacle routing, stuck recovery and squad spacing.
    The v4.1 collision system is unchanged and still passes.
  - Ammunition accounting is fixed at the model, not the display: one successful shot = exactly one
    round for every weapon, fire mode, frame rate and click length (176 measured cases, 0 mismatches),
    the VX-4 ladder reads 300 → 299 → 298 → 290 → 250 → 200 in both semi and auto, blocked or early
    presses cost nothing, an empty magazine blocks firing, reloads transfer once, and the HUD number is
    the same arithmetic the weapon holds. No weapon setting changed: the table diffs clean against the
    pre-fix baseline.
  - Campaign ammunition supplies: 531 typed packs totalling 15,000 rounds across all 100 operations,
    sized only from the fixed +10/+20/+30/+40/+50 ladder, 133 of them off the direct route as exploration
    rewards, plus the 450 legacy field crates — now each worth one bounded family allocation instead of
    an unlimited top-up. Rifle ammo never feeds a shotgun, packs never exceed a weapon's real capacity,
    nothing spawns buried or unreachable (validated against the final world, and withdrawn if no legal
    seat exists), and a pack you cannot use stays available instead of disappearing.
  - Docs: ENEMY_AI_AMMUNITION_FIX_REPORT.md (root causes, fixes, tuning, tests, results, known
    limitations), reports/enemy_ai_combat.txt + reports/ammunition.txt + reports/ammo_pickups.txt
    (per-check evidence from the real update loops).
  - Honesty note: this environment has no browser, so enemy AI, movement and pickups are verified
    headlessly (real modules, frame-by-frame measurement). Visual polish was quantified, not eyeballed.

V4.1 COLLISION, IMPACT AND VEHICLE PASS (retained and regression-tested in v4.2)
  - Characters and vehicles are now real bodies. You cannot walk through an enemy, and an
    enemy cannot walk through you; soldiers cannot walk through each other or into props
    and vanish.
  - Being hit has consequences: a brush blocks, a charge staggers, a heavy or a charging
    vehicle knocks you flat. A knocked-down operator loses movement, aim and trigger control
    and must get up before firing again. Getting up is a protected window, so one relentless
    attacker cannot pin you to the floor forever.
  - Vehicle hulls are solid and stay in sync with their visuals (no one-frame ghost gap), so
    you cannot step into a parked truck or drive through a squad without effect. Struck
    pedestrians are knocked down and pushed clear of the hull instead of being left inside it.
  - [F] boarding is door-aware: the prompt only appears when entering is actually possible,
    the wrong side and out-of-reach approaches are refused, and exiting relocates you when the
    doorway is blocked by a wall, a prop or a crowd.
  - Spawn placement is repaired against geometry and vehicles, so soldiers never materialise
    inside a wall or a hull.
  - Docs: COLLISION_PHYSICS_FIX_REPORT.md (root causes and fixes),
    KNOCKDOWN_IMPACT_SYSTEM.md (impact tuning), VEHICLE_COLLISION_BOARDING_REPORT.md,
    reports/COLLISION_VERIFICATION_MATRIX.md (33 behavioural tests, measured output).
  - Verify this build yourself, from the project root (Node 18+; no npm install needed —
    three.js is vendored in assets/vendor/):
      bash tests/run_all_suites.sh
    It runs 13 headless suites (175 checks, all passing in this build) plus the real-browser
    suite (226 checks over 6 Chromium environments, all passing; it prints one SKIP line and
    exits 0 where Playwright is not installed), namely: the 33 behavioural collision tests, the
    campaign-wide walk-through/fall-through leak probe (112 maps), the mesh-coverage audit, the
    27 enemy AI/combat/movement checks, the 12 ammunition-accounting checks, the 20
    ammunition-pickup checks, the 6 pre-fix firing-cadence pins, the 16 click-to-fire input checks
    (F1-F16, real mousedown/mouseup through the shipped listeners), the 21 tactical-map checks
    (T1-T21: projection, geometry provenance, ground/road data, no bitmap/blur, markers, legend,
    fog, routes, controls, labels, all 100 missions, minimap, caching, performance, float/resize
    chrome, listener and repaint budget), the browser interaction contract (hit testing, painted
    pixels, gestures, layers, routing, window chrome and console cleanliness, asserted in a live
    page), and the existing regression suites (runtime, gameplay v3, requirements, 100-mission
    campaign audit). PASS/FAIL evidence is written into reports/ and
    reports/verification_summary.txt; the browser run also writes reports/browser_map_tests.txt
    and the screenshots it inspected into reports/browser/. Exit status is non-zero if anything
    fails.
    Also worth running: python3 tests/module_delivery_smoke.py (module MIME + service-worker
    delivery, including js/ammo.js, js/mapgeom.js and js/fireinput.js).

SOUNDTRACK (LOCAL AND OFFLINE READY)
  FEARLESS PT 2 is the one bundled soundtrack at /assets/music/FEARLESS-PT-II.mp3.
  It is included in the service-worker precache and can play after installation while offline.
  The settings transport keeps its existing Play/Pause, Next/Previous, shuffle and volume controls.
  No soundtrack diagnostic requests are made.

CAMPAIGN & TRAINING
  Mission 1 (OP 001: NIGHTFALL PROTOCOL) is unlocked initially. Completing Mission N
  unlocks Mission N+1 sequentially across all 100 operations and persists in localStorage.
  The training range is a separate activity accessible anytime; it does not unlock campaign missions.

VERCEL (static deployment)
  Import the extracted project folder / repository in Vercel.
  Set the Vercel Project Root Directory to the folder containing index.html, vercel.json, and js/.
  The included vercel.json selects the current folder as static output and sets MIME headers.
  No build command or SPA fallback/rewrite is required. Do not point output at a different folder.
  IMPORTANT: deploy the project contents at the site root, not inside an extra `VeilStrike/`
  directory. A successful root check is https://YOUR-SITE/js/main.js returning HTTP 200 JavaScript.
  If only https://YOUR-SITE/VeilStrike/js/main.js works, set Project Root Directory to `VeilStrike`
  (if that is where the files are) or flatten the project contents before publishing.
  Confirm all files under js/ and assets/vendor/ are included. Before publishing, run
  `python3 tests/module_delivery_smoke.py` from the project root. Never rewrite module requests
  under /js/ or /assets/vendor/ to index.html.
  Music files are excluded from the service-worker cache and use revalidation-friendly HTTP
  cache headers so newly added or replaced files are not intentionally pinned as immutable.

NETLIFY
  Drag and drop the extracted project-root folder into Netlify Drop.
  The included _headers file sets JavaScript, CSS, manifest, GLB, image and MP3 MIME types.

GITHUB PAGES
  Publish the extracted project root. GitHub Pages serves JavaScript by file extension;
  .nojekyll is included. GitHub Pages does not apply the Netlify _headers file.

LOCAL PLAY (HTTP server required; do not open index.html using file://)
  From the extracted project root, run:
    python -m http.server 8080
  Then open http://localhost:8080/ in a modern browser.
  If a local server reports JavaScript as text/plain, use a current Node static server
  or the separate launcher-tools package; do not disable browser security.

Requires a modern browser with WebGL (Chrome, Edge, Firefox, Safari).
