# Why one click fired three bullets — exact root cause

Scope: the input-to-fire pipeline of VeilStrike, as shipped in v4.2, and what v4.3 changed.
Everything below marked *measured* was produced by running the real code in this workspace:
`tests/firing_pipeline_tests.mjs` (P1–P6) reproduces the pre-fix contract — `tryFire` driven by a
raw held boolean, exactly as v4.2 and earlier fed it — and `tests/firing_input_tests.mjs`
(F1–F16) measures the fixed pipeline end to end. Both are in the suite list, so the old numbers
stay reproducible instead of folklore. Nothing here is inferred from reading alone.

---

## 1. The cause: there was no "click" in the pipeline at all

The pre-fix chain had exactly three links, and none of them ever represented a click:

1. `js/game.js` → `_bindInput()` registered `mousedown` / `mouseup` handlers that only flipped a
   **held-state boolean**: `this.input.mouse0 = true` on press, `false` on release. There was no
   `click` listener and no press-count anywhere. (That boolean is still there today, at
   `js/game.js:745` / `:756` — it now drives the ADS/other consumers, not the trigger edge.)
2. The frame loop passed that boolean straight into the weapon system once per rendered frame:
   `this.weapons.tryFire(this.time, inp.mouse0)`.
3. `js/weapons.js` → `tryFire(now, triggerDown)` decided whether to shoot from the *level* of the
   signal for automatic fire, and only used the press *edge* for semi/burst. The two lines that
   define the behaviour (current numbering):

   ```js
   const freshPress = down && !wasDown;                                  // js/weapons.js:1601
   const canFire = mode === 'auto' ? down
                 : (mode === 'burst' ? burstActive : freshPress);         // js/weapons.js:1661
   ...
   this.nextShotAt = now + shotInterval;   // 60 / rpm for auto          // js/weapons.js:1705-1710
   ```

So "did you just click?" and "is the button down right now?" were the same question. A click is a
hold of a few dozen milliseconds, and in automatic mode the weapon re-fires on **every frame**
whose timestamp has passed `nextShotAt`. Number of shots per click =

```
shots(click) = floor(hold_seconds / (60 / rpm)) + 1
```

### Measured, pre-fix, on the real pipeline

Real `mousedown`/`mouseup` events dispatched at the real `_bindInput` listeners, stepped by the
real per-frame fire step and the real `WeaponSystem` (`tests/firing_pipeline_tests.mjs`):

| hold duration | VX-4 (660 RPM) | PX-9 (720) | MPX-5 (850) | VEKTOR-P (920) | CR-9 (700) | HMG-9 (600) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 frame = 17 ms | 1 | 1 | 1 | 1 | 1 | 1 |
| 9 frames = 150 ms | 2 | 2 | 2 | 3 | 2 | 2 |
| 15 frames = 250 ms | **3** | **3** | **3** | **4** | **3** | **3** |
| 30 frames = 500 ms | 5 | 5 | 6 | 8 | 5 | 5 |

(`P1`/`P2` of `tests/firing_pipeline_tests.mjs`, one fresh weapon per hold, `rounds === shots` in
every cell — the ammo side was never wrong.)

A deliberate, unhurried mouse click is 200–300 ms of button-down. That is exactly the "3 shots per
click" that was reported — on every automatic weapon, at its own RPM. Semi-automatic was never affected (it uses the press edge), which is why
the bug *felt* specific to the rifle's auto mode.

Three things are therefore **not** the cause, and were checked rather than assumed:

* **not duplicate listeners** — one `new Game()`, one `_bindInput()` call per instance, one
  `mousedown` registration in the tree (`js/game.js`);
* **not a second firing path** — `tryFire` had a single call site in the frame loop; the
  `settings.autoFire` aim-assist path was unreachable;
* **not the ammunition layer** — the round counter was already perfectly consistent: three shots
  and three rounds spent is arithmetically *correct* accounting for three shots.

## 2. Why the v4.2 "ammunition fix" could not have fixed this

v4.2 changed the **debit** side only: it collapsed charging into a single call site,
`WeaponSystem.spendRound()` (`js/weapons.js:1509`), invoked once per discharge at
`js/weapons.js:1709`, so a shot can no longer be charged twice (or charged for pellets, tracers or
impact effects). Its suite asserted `rounds consumed === shots fired`.

That assertion is true when one click fires one bullet, and it is *also* true when one click fires
three. The invariant that actually distinguishes the reported bug — `shots === clicks` — was never
measured, and the tests drove `tryFire()` directly, i.e. they entered the pipeline *below* the DOM
listeners where the defect lived. v4.2 also never asserted the click case against the shipped
input layer at all. That is why the fix could be reported, and correctly believed, while gameplay
was unchanged.

## 3. What v4.3 does instead

A discrete trigger object sits between the DOM and the weapon system, and it is the only thing
that can create a firing event.

```
mousedown / touchstart / aim assist
        -> FireTriggerInput.press(source)      (js/fireinput.js)
        -> queue: exactly one "firing event" per physical press, per source, deduped
        -> Game.prototype._fireStep(dt)        (js/game.js:2417) — the ONLY input -> fire path
        -> WeaponSystem.tryFire(now, triggerDown)  — unchanged semantics
mouseup / touchend
        -> FireTriggerInput.release(source)
```

Rules that make "one click = one shot" structural rather than incidental:

* **A press enqueues one firing event.** It is delivered on the next fire step and then removed.
  A queued event cannot be delivered twice.
* **Short press = click = exactly one shot, in every fire mode.** Under
  `settings.autoHoldMs` (default `FIRE_INPUT.AUTO_ENGAGE_S = 0.25 s`, `js/fireinput.js:29`) the
  trigger is released before auto-fire can engage, so even a 500 ms auto hold can never repeat a
  click that already fired.
* **A long press does NOT re-fire the click event.** Auto continues only from the *held* state
  past the engage threshold, so sustained fire follows RPM; releasing stops it on the next step.
* **Semi never repeats**, however long the button is held (measured: a 10 s hold = 1 shot).
* **Burst keeps its fixed len** — one press arms exactly one configured burst, which is allowed to
  finish after release. That is the fire mode, not a click firing twice.
* **A click the weapon cannot take is dropped, not banked** (`CLICK_STALE_S = 0.28 s`,
  `MAX_QUEUED = 2`): during a reload, a draw animation, a knockdown, a stoppage or with the map
  open. Buffering instead would turn 40 clicks into 40 shots delivered after the fact.
* **Rapid clicking cannot outrun the weapon**: at most `MAX_QUEUED` events wait, and shots can never
  exceed clicks (`triggerStateBusy()` `js/weapons.js:1193` / `canAcceptTriggerAt()` `:1179` decide
  accept-vs-drop in one place, shared by mouse, touch and any future source).
* **Keyboard, touch and mouse are the same mechanism** — `js/touch.js` fire button calls the same
  `press`/`release`; there is no separate touch fire path.
* **A click on an open tactical map cannot fire and cannot grab the pointer** — the mousedown
  handler returns early while `tacmap.open` (`js/game.js:739`).
* **Re-binding cannot duplicate the pipeline** — `_bindInput` is idempotent (`_inputBound`), and
  listener counts are asserted to stay at 1 for `mousedown`/`mouseup`/`mousemove`/`keydown`
  across repeated binds.

## 4. Where the guarantees are pinned down

`tests/firing_input_tests.mjs` (16 checks, all through the shipped DOM listeners + real
`WeaponSystem`; counts read from `stats.shots` and `state.mag/reserve`, never from HUD text):

| check | guarantee |
| --- | --- |
| F1 | 220 click cases: one firing event per click for every weapon x mode x click length |
| F2 | every weapon/mode: charges === shots === rounds; ST-12 = 1 discharge, 1 shell, 9 pellets |
| F3 | 300 -> 299 -> 298 -> 290 -> 280 -> 200 for semi and auto, and the same ladder for one weapon of **every category** (rifle, marksman, pistol, shotgun, SMG, sniper, LMG) in each non-burst mode |
| F4 | 20 separate clicks = 20 shots = 20 rounds (9 weapon/mode pairs) |
| F5 | listener counts stay 1/1/1/1 over 3 binds; still 1 shot |
| F6/F6b | duplicate or stuck mousedown adds no event; 200 clicks in one frame -> 1 event, queue never above 2 |
| F7 | mouse + touch + assist cannot double-fire one physical press |
| F8 | semi: 10 s hold = 1 shot; 10 presses = 10 shots |
| F9 | 200 ms click = 1 shot; 1 s auto hold = 9 shots (~RPM); release stops it |
| F10/F11/F15 | empty mag, reload, knockdown, pause and a stoppage swallow the click and cost nothing |
| F12 | reload transfer accounting still exact after dry press |
| F13 | rapid clicking: never more shots than clicks |
| F14 | fire modes, RPM cadence, damage, capacities unchanged by the input fix |
| F16 | map-open click: no trigger press, no pointer lock; first click after closing fires once |

`tests/ammunition_tests.mjs` (v4.2 suite, unmodified plus 5 added checks) keeps the debit side
pinned: one charge point, pellet/tracer/effect-free charging, shotgun = one shell, pickups never
double-awarded.

## 5. Honest limits

* Verified headlessly, at the event level, with a synthetic document that records listeners and real
  DOM `MouseEvent`s dispatched into the shipped handlers. **No browser was available in this
  environment** (no Playwright/Chromium), so no pixels, no real pointer-lock session, no measured
  human click timing. Behaviour under a real browser should still be spot-checked by eye.
* Click lengths are simulated frame counts; a real 60 Hz click of 200 ms maps onto the 1-shot band
  that was measured directly.
* On a display running above ~240 Hz, a sub-4 ms "click" is below one frame at 60 fps anyway; the
  engage threshold is time-based, not frame-based, so the band holds.
