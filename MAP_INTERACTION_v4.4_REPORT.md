# VeilStrike v4.4 — Fully Interactive Tactical Map

Change report. Scope: the tactical map (`M`) went from a *drawing* of the mission to an
instrument the player manipulates — pan, zoom to a point, select, read, plan a route to,
filter, follow, float, resize — with the interaction rules of a navigation application and
none of the decorative excess. The v4.3 map data architecture (classification, routing,
fog of war, the legend, the minimap) is unchanged in meaning: v4.4 changes what you can do
with it, not what it knows.

Everything below was verified in a real Chromium (`tests/browser_map_tests.mjs`, six
environments) **and** by the headless suite (`tests/tacmap_tests.mjs`, 21 checks). The
headline is that the browser run found a defect every previous test could not see.

---

## 1. The defect the browser found — and why no headless test could

```
document.elementFromPoint(720, 412)   →  <canvas> in #game-container      (v4.3)
document.elementFromPoint(720, 412)   →  <canvas id="tacmap-canvas">       (v4.4)
```

`#tacmap` is a direct child of `#hud`, and `css/hud.css:14` declares

```css
#hud > * { pointer-events: none; }
```

The map's buttons each re-enabled themselves (`.tac-btn { pointer-events: auto }`), the
**canvas never did**. So in the shipped game the map drew beautifully and ignored every
pan, every wheel tick and every tap: the browser hit-tested straight through the overlay
onto the WebGL canvas underneath. The v4.3 handlers were bound, correct, and unreachable.

No headless test could see this. Node has no compositor and no hit testing: the suites
call `canvas.fire('wheel', …)` / dispatch events *at the element*, which is exactly what
skips the layer that was broken. That is the whole reason v4.4 made a real browser run part
of the contract.

Fix (`css/hud.css`, v4.4 block):

```css
/* THE reason the v4.3 map could not be dragged: … Buttons opted themselves back in, the
   canvas never did - so every pan, wheel and marker tap was hit-tested straight through
   the map onto the game canvas. In a headless test that dispatches events at the element,
   this is invisible. */
#tacmap { pointer-events: auto; }
#tacmap-canvas { pointer-events: auto; touch-action: none; … }
```

and permanently guarded by a check that fails if it ever regresses:

```
PASS desktop-1080p · the map viewport receives real pointer input — 720,412 -> tacmap-canvas  …
```

### 1.1 …and more, found the same way

The pointer-events hole was not a one-off. Each of these was invisible to every headless
check and is now covered by one, in a real browser:

**The floating window had no position.** `_applyFloat()` wrote `style.left`/`style.top`
and *then* `style.inset = 'auto'` — and `inset` is the shorthand for
`top/right/bottom/left`, so the last write erased the first two. The window opened at
`0,0`, and the title-bar drag looked broken because there was nowhere to see it move to.

```
before  FAIL hidpi-laptop · the title bar moves the window — window 0,0 -> 0,0
after   PASS hidpi-laptop · FLOAT detaches the map into a smaller window — 979x666 window inside 1440x900
```

The harness could not model this either, because `element.style` was a plain object:
`tests/tacmap_tests.mjs` now gives every fake element a `style` proxy that implements the
shorthand, plus `Element.closest`, so both bugs (this one and the next) stay caught headlessly.

**A 1 px transparent seam at fractional devicePixelRatio.** The painter took its box from
`canvas.clientWidth` (which floors) while the backing store came from
`Math.round(rect.width × dpr)` (which rounds). For a `1002 × 389.25` CSS box at dpr 2 the
bitmap is 2004 × **779** rows and the wash painted 778: the last device row of the map was
never drawn. The pixel audit names it exactly — `301 non-opaque` samples, all at `y = 778`,
`x = 0…2003`. `_prepareView` now projects through the same rounded CSS box the clamps and
`fitZoom` use, and `_drawField` floods the **whole backing store** in device space. Both
touch environments now report `0 non-opaque`.

**The detail card ate gestures on a phone.** On ≤860 px the card is a full-width bottom
sheet; on a 394 × 454 phone canvas that reaches the middle of the map. Anything starting
there — a pan, a pinch, a tap — went to the card and never arrived:

```
FAIL phone-touch · drag pans … — press reached the map: 0 pointerdown;
     owner chain div.ti-title > div#tacmap-inspector > canvas#tacmap-canvas
PASS phone-touch · drag pans … — moved the view -90.0,60.0 px; press reached the map: 1 pointerdown;
     owner chain canvas#tacmap-canvas > div#tacmap-stage > div#tacmap-frame
```

The card is information, the canvas is the control surface, so the card container is now
`pointer-events: none` with its buttons opting back in, and its height is capped at 34 % on
narrow viewports. A drag can start under the card; the buttons still answer.

**Float mode was measured against the wrong ruler.** `#tacmap-frame { max-width: 96vw }`
(a rule for the full-screen frame) capped the canvas inside a floating window, so the
resize grip grew the *window* without growing the *map*, and `min-height: 42vh` on the
canvas meant 42 % of the **viewport**, not of the window, so a small window clipped its own
map. In float mode the frame is uncapped, the canvas floor is a fixed 160 px and the legend
is capped as a share of the window: `canvas 338 -> 462x353 CSS px backed by 924 device px at
render dpr 2` with the view preserved.

**The tally.** All told, **seven defects** were found only because a real browser was in the
loop — each now carries a browser assertion and, wherever a fake DOM can express it, a headless
one: the pointer-events hole (§1); the float window's position erased by the `inset` shorthand,
and its size measured against the wrong ruler (above); the legend painting captions across
columns (§6); a zoom readout that went stale after an anchored zoom (§2); the 1 px unpainted
seam at fractional devicePixelRatio (above); a window that could be dragged out of reach — or
dragged by pressing its own buttons (§5); and the detail card eating gestures on a phone
(above). Reviewing the same screenshots later caught two phone-layout mistakes — the toolbar
row running past a 412 px panel, and the always-painted status strip colliding with map labels
— fixed the same way (§5, §6).

### 1.2 What the browser run taught the tests

Two environment properties had to be handled before any of this could be *measured*, and
both are recorded in `tests/browser_map_tests.mjs` because a naive suite silently passes on them:

- **Headless Chromium commits almost no frames** (measured: 2 `requestAnimationFrame`
  callbacks in 3750 ms) even with `--disable-frame-rate-limit`. The view eases on the wall
  clock, so every assertion about a settled view now steps a 60 Hz clock through
  `_animateView()` (`settlePage`) instead of sleeping. `?vsdebug&vsnorender` also keeps the
  WebGL scene from being rasterised 1080p-wide on every test frame.
- **Chrome's mobile emulation rewrites input**: it reports one touch point unless
  `Emulation.setTouchEmulationEnabled({maxTouchPoints: 5})` is sent, `page.touchscreen.tap`
  rejects fractional coordinates, and a page-zoom-eligible two-finger sequence can be
  dropped before it reaches JS. The suite therefore drives raw
  `Input.dispatchTouchEvent` for both touch environments (the same CDP path the tablet uses
  and that demonstrably reaches the canvas), counts the pointer events the *canvas* saw, and
  checks `document.elementFromPoint` before and after every synthetic gesture. Where a point
  was ambiguous, the fix was to recompute it against the live layout (`stablePoint`) — which
  is how the card defect above was pinned to an owner chain instead of a guess.

---

## 2. Interaction model

One view object, two values. `_zoomT/_panXT/_panYT` are where the view is *going*;
`zoom/panX/panY` are what is on screen. The rendered view eases toward the target
(`k = 1 − exp(−dt/0.055)`, zoom interpolated in log space so a 2× zoom feels the same at
every scale), driven from the wall clock inside `drawFull()`.

| Gesture / control | Behaviour |
| --- | --- |
| Drag (mouse, one finger) | 1:1 pan. The rendered view takes the same step the pointer does — no chase, no lag. A drag that moved is never also a click. |
| Wheel / trackpad pinch | Zoom about the **cursor**, solved against the target view so the world point under the pointer stays under it. `ctrl+wheel` (real trackpad pinch) uses a 5.4× stronger gain than a plain wheel. `preventDefault` + `stopPropagation`, non-passive. |
| Pinch (two fingers) | Zoom about the midpoint **and** pan by how far the midpoint travelled, from raw pointer positions so no transform is inverted. |
| `+` `−` `0` | One `ZOOM_STEP` (1.45×) per press; `0` frames the whole mission. |
| Arrows / Shift+Arrows | Pan by 52 / 190 screen pixels, so the key step scales with the view instead of the world. |
| `C` `G` `F` `N` `U` `L` `Enter` | Centre on self · centre on the active objective · toggle follow · north-up · player-up · layer switches · navigate to the selection. |
| Click a symbol | Selects it and opens the detail card. **A click on empty map only clears the selection** — v4.3 re-ran `fit()` there, which yanked the view out from under the player's hand. |
| `M` / `Esc` | Close. A gesture in flight is dropped (`_pointers.clear()`, `_pinch = null`, `_drag = null`) so a half-finished drag cannot leak into gameplay input. |
| Reopen | The view you left is restored, provided the mission geometry is unchanged (`geom.key` is the same staleness signature the geometry cache uses). A new mission reframes. |

**Bounds.** A gesture may slide the map until the visible rectangle stops overlapping the
mission area plus 18 m of air; when the whole mission already fits, the centre locks to it.
An *explicit* recentre (`ME`, `OBJECTIVE`, follow mode) is bounded by the world instead —
the centre may go anywhere inside the mission area — because the player asked for that
point, not for a frame. Consequence, asserted in both suites: the map can be panned to any
edge, and can never be lost.

**Follow mode** keeps `_panXT/_panYT` at zero from `update()` every frame, so the player
stays welded to the centre while walking, driving or being thrown by an explosion; the
first grab disengages it (the button label and `aria-pressed` follow the state, and the
status line carries `FOLLOW`).

## 3. Selection, the detail card, and navigation

Every symbol a full paint draws registers a **screen-space** hit box
(`_markHit`, minimum 9 px radius, `+HIT_PAD` slack), so a marker is as easy to hit at
0.2× as at 8×. Hit scoring is `distance + 0.25·radius`, which makes a small mission marker
beat the large footprint box of the building it sits on.

Selectable: mission targets (objective, extraction, each secondary — keyed `optional:i`,
because a mission can carry two and both used to open the same card), structures
(`SELECTABLE_ROLES`, from the collider that is drawn: size, height, material tag, and
whether it is solid), doors (open/closed, live), vehicles (pads and live hulls), supply and
intel the player has discovered, known hostiles (seen or remembered, never through a
wall), friendly contacts, and the player themself.

The card (`#tacmap-inspector`, a DOM layer, not canvas text, so it stays selectable-free,
crisp and layout-managed) shows name · kind · what is actually known · distance and bearing
· walking distance when a route exists · `PLANNED` when this marker owns the route, with
`NAVIGATE`, `CENTRE`, `ACTIVE OBJ`, `CLEAR`.

`NAVIGATE` on a marker with a routing identity selects it; on plain geometry it sets
`customTarget` and routes there as `ROUTE: WAYPOINT`. Routes are still computed on the
walkability grid, so a route to a solid building stops at its last walkable cell and says so
(`LAST n m ON FOOT`), and an unreachable selection prints `NO WALKABLE ROUTE` instead of
inventing a line.

The minimap registers nothing: `tap targets` exist only on the big map (`_markHit` is gated
on `_paintingFull`), so the HUD can never steal a tap.

## 4. Layers

`MAP_LAYERS` — 11 switches (buildings, walls & obstacles, roads & paths, terrain,
objectives, friendly units, known enemies, vehicles, discovered supply, route, fog) — each
one a real `<button role="switch">`-style row built from the same table the paint reads,
with its explanation in `title`, `aria-pressed` on state, and a `LAYERS: n/11` count on the
toolbar. `ROLE_LAYER` / `SURFACE_LAYER` / `ITEM_LAYER` map every classified role, ground
wash and item kind to exactly one switch, so a layer is a *paint filter*, never a data
filter:

* toggling a layer repaints; it does not move the view, and it does not rebuild the
  geometry (`geom.key` is asserted unchanged);
* **hiding WALLS cannot hide an obstacle** — the nav grid and the route are computed from
  the full collider set, and the route length is asserted identical with the layer off;
* **hiding ROUTE suppresses the line, not the verdict** — the status line and the card's
  walking distance are still computed, so a critical state cannot be lost to a toggle;
* every layer off still paints the paper, the mission boundary, the scale bar, the compass
  and the player: no void.

## 5. A full interface

`#tacmap` is now a window, not a screenshot overlay: a title bar (`TACTICAL MAP`, the
orientation readout, drag to move, double-click to maximise/restore), a grouped toolbar
(zoom −/readout/+, RESET, ME, OBJECTIVE, FOLLOW, ROT, ROUTE, LAYERS, VIEW 2D/3D, FLOAT,
CLOSE), a DOM compass (needle rotates to the player's bearing in player-up mode; click it
to switch orientation), a layer popover, the detail card, a resize grip, and the
auto-generated legend underneath.

Floating sizes the window to `min(0.68·vw, 1180) × min(0.74·vh, 820)`, clamped into the
viewport and centred — v4.4 initially sized it from the maximised box, i.e. exactly the
viewport, which is floating in name only; a test now pins it smaller than the viewport.
Resizing drives `_sizeCanvas`, so the backing store follows the CSS box × `devicePixelRatio`
and the map gets *more* detail, not a stretched bitmap. Chrome drags never touch the view
(`panX/panY/zoom` are asserted unchanged through a title-bar move and a grip resize). Two
rules were added after the first browser pass: a press that starts on a **control** inside
the bar (a button, an input) is that control's press and never a window grab — `closest
('button, input, select, a')` — and a drag can never put the window out of reach, because
`float.x/float.y` are clamped so at least 48 px of it stays on screen. Both are pinned
headlessly (T20), the second because only the browser showed the window sitting at `0,0`.

Below 860 px the toolbar stops trying to be a row: `#tacmap-controls` becomes a two-column
grid with wrapping, ellipsised-free buttons, so on a 412 px phone all nine controls, the
compass and CLOSE are inside the frame and tappable. Before this, VIEW / FLOAT / CLOSE
existed in the DOM and were off the right edge of the screen.

## 6. Visual quality

* **Sharpness is structural.** `drawFull` sizes the backing store to the box × DPR (cap
  4096, and the old 1024 cap is gone), sets the transform to DPR, and never scales the
  canvas with CSS. `image-rendering: pixelated` and `backdrop-filter`/`filter: blur` are
  asserted absent by *parsing* the stylesheet (a comment mentioning blur cannot pass or
  fail the check).
* Labels are constant screen size (10–11 px mono), collision-reserved so they never cover
  features, the player icon or the route line, and they are reflowed rather than rewrapped.
* Furniture is minimal and functional: scale bar (round metre length near 70 px, moved
  under the status line so the card cannot sit on it), north arrow (bottom-right, clear of
  both cards), one status line (`FOLLOW · PLAYER-UP · ROUTE n m VIA DOOR · ZOOM 1.4× ·
  SELECTED INTEL 120 m NE`). No glow, no pulsing, no scanlines, no gradient washes.
* Palette unchanged (the v4.3 field-manual set); the browser pixel audit measures it:
  ≥10 distinct quantised colours, mean luminance in the 8–130 band, ≥70 % of samples within
  40/255 of a declared map colour, **and zero non-opaque samples** — that last one is the
  backing-store seam (`1002 × 389.25` CSS at dpr 2 is a 2004 × **779** bitmap; filling the
  rounded 389 left row 778 unpainted). `_drawField` now floods the whole backing store in
  device space and `_prepareView` projects through the same rounded CSS box the clamps use.
* Rendering caps at 2× DPR by design (`787x908 device px for a 394x454 CSS box at dpr 3`);
  the audit states the cap so the mismatch is a decision, not an accident.
* The legend cannot overlap itself any more: one caption per grid column (`auto-fill`,
  `minmax(232px, 1fr)`), the text in its own `.lg-txt` box with `text-overflow: ellipsis`,
  and a length budget asserted in the headless suite (≤44 characters). Two legend captions
  that carried developer notes ("from mission ground data") were shortened — the legend
  explains what a symbol *means*, not where the data came from.
* The status strip reserves its own rectangle in the label declutter list before any feature
  label is placed (the scale bar too), so on a short canvas a map label cannot land under it.

## 7. Input isolation

* The map binds its own listeners once (`_on` records them; `_mapBound` makes re-entry a
  no-op counter `_mapRebinds`), scoped to the canvas, and `js/game.js` no longer binds any
  `tac-*` toolbar click — the map owns its toolbar (a test asserts `game.js` has zero
  `click('tac-` bindings, because double-binding doubles every press).
* Keyboard handlers are capture-phase on `document`, gated on `open && mode !== '3d'`, and
  call `preventDefault` + `stopPropagation` **only** for the twelve map keys. `W`, `E` and
  everything else pass through untouched, and every key is inert while the map is closed.
* Gameplay edge input is still discarded by the game loop while the map is up (v4.3's
  partial-pause), so a map interaction cannot queue a reload, a weapon swap or a latched
  trigger. Verified end-to-end in the browser: dispatching `W/A/D/Shift/R/3` for 260 ms
  with the map open leaves position, facing, health and the trigger bit untouched.
* Wheel and touch are `preventDefault`ed on the canvas with `touch-action: none`;
  `dragstart`/`drag`/`selectstart`/`contextmenu` are suppressed there, and `#tacmap`
  (plus its subtree) opts out of `user-select`, so a pan never rubber-bands a selection
  and the canvas is never dragged as an image.
* Right/middle mouse buttons are ignored by the 2D map and belong to the 3D view.

## 8. What was deliberately preserved

`js/mapgeom.js` (classification, `geometryKey`, nav grid, A* `routeTo`, `MAP_ITEM_KINDS`),
the fog model, the detection rules, the legend generated from `MAP_LEGEND`, the 3D view
(`js/map3d.js`, still fed from `tacmap.known`), the HUD minimap (same geometry, same
projection, 15 Hz cadence, no labels), and every v4.3 test. The v4.3 suites
(`firing_input`, `firing_pipeline`, `ammunition`, `enemy_ai_combat`, collision, campaign
audit) run unmodified as part of the same `tests/run_all_suites.sh` pass.

Two side fixes fell out of the work: `_sizeCanvas` compared the box against the unclamped
size, so it re-set `canvas.width` every frame (a full canvas clear — the flicker source),
and `_ensureRoute` rebuilt the nav grid before checking its cache. Both are fixed and both
are asserted (`repaint cost`, `the map is repainted exactly once per frame`).

## 9. Verification

### Headless — `tests/tacmap_tests.mjs` (21 checks, all passing)

| # | Check |
| --- | --- |
| T1 | world→map conversion exact for real mission coordinates |
| T2 | every painted structure maps to a real collider; nothing invented |
| T3 | no bitmap upscaling, canvas filters or glow in the render path |
| T4 | player icon: position + facing, small controlled FOV wedge |
| T5 | every symbol has a legend entry, and the legend reaches the DOM |
| T6 | hostiles appear only through the detection rules, never through walls |
| T7 | route walkable in the geometry shown, follows the active objective |
| T8 | no walkable path is stated, not drawn |
| T9 | zoom, fit, pan, rotate, marker select, route cycling |
| T10 | labels keep constant screen size and never cover features or each other |
| T11 | all 100 campaign missions supply geometry, nav grid and a route verdict |
| T12 | the HUD minimap shares the geometry, stays uncluttered, on a cadence |
| T13 | opening the map does not disturb gameplay; stale geometry detected |
| T14 | fog reveal and route cost inside a frame budget |
| T15 | roads are mission data, painted as washes, never blocking a route |
| **T16** | **zoom lands under the cursor, pan tracks the finger, the mission can't be lost** |
| **T17** | **every marker is selectable, the card explains it, navigation routes to it** |
| **T18** | **layer switches change what is drawn and never what is true** |
| **T19** | **recentre, follow and the keyboard drive the map and nothing else** |
| **T20** | **the window floats and resizes without touching the view; canvas pixel-exact** |
| **T21** | **one set of listeners, no double-binding, repaint inside budget** |

New in v4.4: T16–T21 (108 assertions' worth of interaction contract). The v4.3 harness was
extended, honestly: `getElementById` now auto-vivifies but *records* which ids it invented,
and T20 asserts every one of them exists in `index.html` or is created by `tacmap.js` — so
the convenience cannot mask a missing element. `PAN_KEY_PX` and the zoom clamps are read
back out of the module source, and the DOM contract is checked against the real stylesheet.

### Browser — `tests/browser_map_tests.mjs`, real Chromium 141 over 6 environments

Driven through Playwright + CDP against the shipped `index.html`. The only test hook is the
`?vsdebug&vsnorender` query that already exists in the build (it exposes `window.__vs` and,
in this run, skips rasterising the WebGL scene so the suite measures the 2D canvas). Every
assertion is made on the live page: `document.elementFromPoint`, `getImageData` read back from
the map canvas, real `Input.dispatchMouseEvent` wheel / drag / click sequences, real
`Input.dispatchTouchEvent` two-finger gestures, and the product's own repaint timing.
Headless Chromium commits almost no animation frames, so each gesture is followed by
`settlePage()` — a stepped 60 Hz clock driving the product's `_animateView()` — rather than a
sleep, and the view is then read back rather than assumed.

**226/226 checks passed across 6 environments** (desktop-1080p: clean, hidpi-laptop: clean, narrow-laptop: clean, ultrawide: clean, tablet-touch: clean, phone-touch: clean).
Full transcript: `reports/browser_map_tests.txt`; the screenshots the suite looked at:
`reports/browser/*.jpg`; the same command captured by the runner: `reports/browser_map.txt`.

| environment | geometry | checks | representative evidence from the live page |
|---|---|---|---|
| `desktop-1080p` | 1920x1080 @ dpr 1, mouse | 37/37 clean | **pointer hit testing**: 960,502 -> tacmap-canvas  51,110 -> tacmap-canvas  1849,874 -> tacmap-canvas<br>**backing store**: 1898x864 device px for a 1898x864 CSS box at dpr 1<br>**pixel audit**: 165 distinct colours over 409968 samples, 0 non-opaque<br>**palette conformance**: 99.8% of samples within 40/255 of a declared map colour<br>**anchored zoom**: at 2.77x -> 5.18x (deeper than the centre-lock, 1.91x) the point under the pointer moved 0.00 px<br>**float window**: 1180x799 window inside 1920x1080; button "MAXIMIZE"<br>**input isolation**: player position, facing, health and trigger untouched through W/A/D/Shift/R/3 |
| `hidpi-laptop` | 1440x900 @ dpr 2, mouse | 37/37 clean | **pointer hit testing**: 720,392 -> tacmap-canvas  51,110 -> tacmap-canvas  1369,653 -> tacmap-canvas<br>**backing store**: 2836x1286 device px for a 1418x643 CSS box at dpr 2<br>**pixel audit**: 206 distinct colours over 911774 samples, 0 non-opaque<br>**palette conformance**: 99.8% of samples within 40/255 of a declared map colour<br>**anchored zoom**: at 1.43x -> 1.95x (deeper than the centre-lock, 1.43x) the point under the pointer moved 0.00 px<br>**float window**: 979x666 window inside 1440x900; button "MAXIMIZE"<br>**input isolation**: player position, facing, health and trigger untouched through W/A/D/Shift/R/3 |
| `narrow-laptop` | 1024x640 @ dpr 1, mouse | 37/37 clean | **pointer hit testing**: 512,273 -> tacmap-canvas  51,162 -> tacmap-canvas  953,364 -> tacmap-canvas<br>**backing store**: 1002x302 device px for a 1002x302 CSS box at dpr 1<br>**pixel audit**: 190 distinct colours over 75651 samples, 0 non-opaque<br>**palette conformance**: 99.5% of samples within 40/255 of a declared map colour<br>**anchored zoom**: at 1.01x -> 1.88x (deeper than the centre-lock, 1.01x) the point under the pointer moved 0.00 px<br>**float window**: 696x474 window inside 1024x640; button "MAXIMIZE"<br>**input isolation**: player position, facing, health and trigger untouched through W/A/D/Shift/R/3 |
| `ultrawide` | 2560x1080 @ dpr 1, mouse | 37/37 clean | **pointer hit testing**: 1280,512 -> tacmap-canvas  51,110 -> tacmap-canvas  2489,894 -> tacmap-canvas<br>**backing store**: 2538x884 device px for a 2538x884 CSS box at dpr 1<br>**pixel audit**: 153 distinct colours over 560898 samples, 0 non-opaque<br>**palette conformance**: 99.9% of samples within 40/255 of a declared map colour<br>**anchored zoom**: at 2.84x -> 5.30x (deeper than the centre-lock, 2.56x) the point under the pointer moved 0.00 px<br>**float window**: 1180x799 window inside 2560x1080; button "MAXIMIZE"<br>**input isolation**: player position, facing, health and trigger untouched through W/A/D/Shift/R/3 |
| `tablet-touch` | 1024x768 @ dpr 2, touch | 39/39 clean | **pointer hit testing**: 512,317 -> tacmap-canvas  51,162 -> tacmap-canvas  953,451 -> tacmap-canvas<br>**backing store**: 2004x779 device px for a 1002x389 CSS box at dpr 2<br>**pixel audit**: 183 distinct colours over 390279 samples, 0 non-opaque<br>**palette conformance**: 99.7% of samples within 40/255 of a declared map colour<br>**anchored zoom**: at 1.35x -> 1.85x (deeper than the centre-lock, 1.35x) the point under the pointer moved 0.00 px<br>**pinch**: 1.78x -> 10.00x via two raw CDP touch points; mid-gesture the map held 3 pointers (spread 66 px, target 5.34x); 0 pointers left captured; readout "10.0×"; canvas totals pointerdown 7 / touchstart 4<br>**float window**: 696x568 window inside 1024x768; button "MAXIMIZE"<br>**input isolation**: player position, facing, health and trigger untouched through W/A/D/Shift/R/3 |
| `phone-touch` | 412x915 @ dpr 3, touch | 39/39 clean | **pointer hit testing**: 204,455 -> tacmap-canvas  47,280 -> tacmap-canvas  341,610 -> tacmap-canvas<br>**backing store**: 787x860 device px for a 394x430 CSS box at dpr 3 (the map renders at 2x on a 3x phone: no legibility gain, 2.25x the fill rate)<br>**pixel audit**: 200 distinct colours over 135364 samples, 0 non-opaque<br>**palette conformance**: 98.9% of samples within 40/255 of a declared map colour<br>**anchored zoom**: at 1.26x -> 1.56x (deeper than the centre-lock, 0.67x) the point under the pointer moved 0.06 px<br>**pinch**: 2.14x -> 10.00x via two raw CDP touch points; mid-gesture the map held 3 pointers (spread 66 px, target 6.42x); 0 pointers left captured; readout "10.0×"; canvas totals pointerdown 7 / touchstart 4<br>**float window**: 340x677 window inside 412x915; button "MAXIMIZE"<br>**input isolation**: player position, facing, health and trigger untouched through W/A/D/Shift/R/3 |

What that collectively proves, in the order the brief asks for it:

- **Pointer input really arrives.** Three points on the canvas (centre, top-left inset,
  bottom-right inset) must hit-test to `#tacmap-canvas`. This is the check that caught the
  v4.3 defect in section 1, and it is the one no headless test can perform.
- **The canvas is pixel-exact, not upscaled.** The backing store is asserted to equal the CSS
  box × the render DPR (capped at 2× by design), and the pixel audit compares every 4th sampled
  pixel against the palette the map declares: distinct-colour count, non-opaque count (a
  transparent pixel in the map body means an unpainted row), mean luminance and standard
  deviation, and the share of samples within 40/255 of a declared map colour.
- **Gestures do the arithmetic they claim.** The wheel pivots on the world point under the
  cursor (measured slide 0.00 px once the view is deeper than the centre-lock), a drag is 1:1
  up to the mission-boundary limit and truncated *by that limit* on the axis where the whole
  mission already fits, a two-finger spread zooms a 412 × 915 phone from 2.14× to 10.00×, and
  a tap on that same phone selects the marker under the finger.
- **The interface is a window.** FLOAT produces a smaller movable window placed inside the
  viewport; the title bar moves the window and never the map; the grip grows the canvas and the
  backing store keeps pace at the render DPR; double-click restores the full frame.
- **Input isolation holds in the browser, not just in Node.** W/A/D/Shift/3/R/E leave player
  position, facing, health and trigger state untouched while the map is open, and closing the
  map hands back a live game frame with the view you left.
- **The page stays quiet.** No console errors, no page errors, no failed requests — a single
  message fails the whole environment.

### Cross-check against the headless suite

The tactical-map suite (`tests/tacmap_tests.mjs`, T1-T21) runs the same contracts against the
real modules with a DOM that now models the two things that hid the browser-only defects: an
`inset`-shorthand-aware `style` proxy, and `Element.closest`. The wider battery it sits in —
13 headless suites, 175 checks in this build — stayed green throughout (see
`reports/verification_summary.txt`). Where a check exists in both environments, the numbers agree
(e.g. float geometry, backing-store size, listener counts) — which is the point: the browser run
is a stricter *environment*, not a different feature set.


## 10. Performance

The map repaints once per frame while it is open (the HUD's duplicate `drawFull` was
removed), the route is cached on `geom.key + quantised player + target`, and every paint
pass culls to the visible rectangle, so zooming in *reduces* work instead of increasing it.

| interactive repaint, measured in the live page | avg | p95 | draw calls per frame |
|---|---|---|---|
| `desktop-1080p` (1920×1080) | 1.4 ms | 5.1 ms | 204 |
| `hidpi-laptop` (1440×900 @2×) | 2.2 ms | 6.6 ms | 262 |
| `narrow-laptop` (1024×640) | 2.1 ms | 6.3 ms | 285 |
| `ultrawide` (2560×1080) | 1.1 ms | 1.2 ms | 258 |
| `tablet-touch` (1024×768 @2×) | 0.4 ms | 0.6 ms | 54 |
| `phone-touch` (412×915 @3×) | 0.6 ms | 0.9 ms | 99 |
| headless worst case (`tests/tacmap_tests.mjs` T21) | 0.3 ms | — | 97, or 15 with the layers off |

How it is measured: `tests/browser_map_tests.mjs` calls the product's own `drawFull()` 24 times
on a live map — geometry cache warm, all eleven layers on, the detail card open, at whatever zoom
the environment had reached — times each call with `performance.now()`, asserts the average stays
under the 45 ms budget, and reports the p95 plus `TacticalMap._drawCalls` (a counter in the product,
not a wrapper, so the number belongs to the code that ships). The headless row is the same
instrumentation across 96 paint calls, including the worst case of a layer toggle.

Two things the numbers say. A repaint is single-digit milliseconds on the largest canvas in the
matrix (2560 × 1080 ultrawide: 1.1 ms average, 1.2 ms p95), so a pan or a wheel tick stays inside
one frame budget even while the whole mission is being drawn; and the interaction layer costs
nothing in listeners — one handler per gesture type across four open/close cycles (46 listeners,
0 re-binds), so it cannot accumulate the way v4.3's duplicated toolbar bindings did.

Nothing in the gesture path allocates per frame beyond the projection temporaries: the map draws
from the same `geom` cache the 3D view uses, `update()` is not called while the map is open, and
the minimap keeps its own ~15 Hz cadence and dirty flag.

## 11. Deliberate limits

* The map is modal: opening it pauses gameplay forward motion (v4.3's partial pause) and
  the sim keeps running. That is the existing contract, not a new one.
* Zoom is clamped to 0.06×–10× (≈2.4–400 px per metre). Below that the mission is a smudge;
  above it a 4096 px canvas covers well under a sector, and the bounds keep it honest.
* There is no rotation *drag* (only north-up/player-up toggle) and no free rotation: a
  rotated map with a 1:1 pan and a bearing readout is a different, larger piece of work,
  and half-measures here would break the "up is where you are facing" rule the rest of the
  HUD uses.
* Marker hit testing is per-symbol, not per-path: the route line itself is not a click
  target (its ends are, via the markers that own it).
* The float window is a single-window panel: it is movable, resizable and maximisable, but
  it does not persist its geometry across a reload or across missions.
* On a viewport under ~860 px the toolbar becomes a two-column grid rather than a row, so
  the bar is tall on a phone (~230 px of a 915 px screen) and every control stays inside
  the frame. Compacting it further would put the labels under 10 px, which the legibility
  budget in the map's own test does not allow.
* Rendering stops at 2× devicePixelRatio by design: a dpr-3 phone gets a 2× backing store
  (measured: `787x908 device px for a 394x454 CSS box at dpr 3`), because the third scale
  buys no legibility on vector map strokes and costs 2.25× the fill rate.

## 12. Files

| File | Change |
| --- | --- |
| `js/tacmap.js` | view model (target + eased pair, clamps, follow, fit, recenter modes), cursor-anchored zoom, pinch, screen-space hit testing, selection + detail card, layer system, window chrome, keyboard, per-canvas DPR sizing, `render2D` |
| `js/game.js` | toolbar ownership handed to the map (five duplicated `click('tac-*')` bindings removed); map keeps repainting itself from the frame loop |
| `js/ui.js` | removed the duplicate full-map repaint per HUD frame |
| `index.html` | the map panel rebuilt: grouped toolbar, compass, layer popover, detail card, resize grip, `role="dialog"` labelling, 3D stage unchanged |
| `css/hud.css` | v4.4 block: `pointer-events` fix (the map *and* its canvas opt in, and the portrait rotate prompt yields to the map), `touch-action: none`, no-selection/no-drag, float + resize chrome with viewport-independent sizing, inspector card (pointer-transparent, so it cannot swallow a gesture that starts on it), layer rows, a two-column toolbar grid below 860 px, ellipsised legend columns; no blur, no image-rendering tricks |
| `sw.js` | cache version → `v17.4.1-tacmap-interactive-20261105` |
| `tests/tacmap_tests.mjs` | harness (listener-recording elements, auto-vivifying `getElementById` with a recorded id contract, deterministic settle clock) + T16–T21, T9/T12/T17/T20/T21 updated to the new semantics |
| `tests/browser_map_tests.mjs` | new: the real-browser suite described above; SKIPs cleanly where no Playwright/Chromium exists |
| `tests/run_all_suites.sh` | browser suite wired into the full pass (with its SKIP path) |
| `reports/browser/`, `reports/browser_map_tests.txt`, `reports/browser_map.txt` | the screenshots the suite inspected, its per-check transcript, and the copy the full pass captures |
| `js/tacmap.js` (also) | the map's own DPR render cap (2×), a status strip that reserves its footprint before labels are placed, and a float window that can never be dragged out of reach |
