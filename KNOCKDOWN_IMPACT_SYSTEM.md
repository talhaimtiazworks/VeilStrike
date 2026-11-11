# VEILSTRIKE — Knockdown & Impact System (`js/impacts.js`)

A single state machine shared by the player, soldiers, NPCs, vehicle crew and (as attackers)
vehicles. It exists because the game previously had **no** impact response at all: contact either
blocked a move or did nothing, so bodies could occupy the same space and a charge felt like
clicking through a mannequin.

## States

```
STANDING ──applyImpact──▶ STAGGERED ──(timer)──▶ STANDING
    ▲                          │ heavy hit
    │                          ▼
RECOVERING ◀──(timer)── KNOCKED_DOWN  (fall → hold → get-up)
```

Every participant gets the same fields from `initImpactState(actor, { mass })`:
`mass`, `bodyState`, `bodyStateT`, `bodyStateDur`, `impactCd`, `knockSeverity`, `fallDir`,
`downBlend`, `_pairCd`, and the marker `impactFsm = true`.

**A body that is down is still solid.** Its collision box shrinks to `DOWN_BOX_HEIGHT`
(0.98 m) instead of being removed, so you cannot walk through a fallen enemy, and a fallen
player cannot crawl through a keyhole.

## What a hit does

`processMoveContacts(mover, physics, out, dt)` runs after each `moveBox`:

1. Reads the contact records `physics.moveBox` produced — `[body, nx, nz, requestedTravel]`.
2. Picks the strongest contact by **closing speed**, computed as
   `max(relative velocity along the normal, requestedTravel/dt − victim relief, 0.55·|v|)`.
   The middle term is essential: a blocked move damps the mover's velocity to near zero on the
   blocked axis, so measuring a hit from post-collision velocity reports 0.4 m/s for a sprint.
   Impact strength is judged on **intent**.
3. Defenders with `impactFsm` react; anything else (hull, mount, prop) only blocks.
4. The mover then pays for its own hit (`SELF_STAGGER_*`), which is why sprinting into a wall of
   men costs you your feet.

`applyImpact(actor, opts)` decides the outcome:

```
speed   = closing speed (m/s)
attackPower = speed · clamp(attackerMass / 80, 0.7, 6)^0.5
knockAt = KNOCKDOWN_SPEED · (0.72 + 0.28 · clamp(mass/80, 0.6, 2.6))
speed < INCIDENTAL_SPEED          → no reaction (a brush)
attackPower ≥ knockAt             → KNOCKED_DOWN
otherwise                         → STAGGERED
```

so a **heavy charger or a truck bowls you over where a scout bounces off you**, and mass makes you
harder to topple. Impulse is capped and pushed through `wallSafePush`, so a knockback can never
launch a body through geometry — the "no uncontrolled launch" rule.

## Tuning (`IMPACT_TUNE`, `js/impacts.js`)

| Key | Value | Meaning |
|---|---|---|
| `INCIDENTAL_SPEED` | 4.0 | below this a contact is a brush: blocked, no reaction (walk speed is 3.6, so walking into someone never topples them) |
| `STAGGER_SPEED` | 4.0 | start of the severity ramp |
| `KNOCKDOWN_SPEED` | 4.6 | mass-scaled threshold for going down (sprint is ~6–8) |
| `SELF_STAGGER_SPEED` | 5.0 | hitting something this hard costs the *attacker* his balance |
| `SELF_KNOCKDOWN_SPEED` | 6.4 | and this hard, if the target is much heavier, the attacker falls too |
| `SELF_KNOCKDOWN_MASS_RATIO` | 1.45 | "much heavier" ratio for the above |
| `FALL_TIME` / `DOWN_HOLD` / `DOWN_HOLD_EXTRA` | 0.42 / 0.78 / 0.62 | fall animation, time on the floor, extra per severity |
| `GETUP_TIME` | 0.62 | `RECOVERING` window (brief i-frames by design) |
| `STAGGER_TIME` / `STAGGER_TIME_EXTRA` | 0.46 / 0.3 | stagger length |
| `COOLDOWN` | 0.85 | per-actor re-impulse cooldown (+0.5 s after a knockdown) |
| `PAIR_COOLDOWN` | 1.6 | per-*pair* cooldown: two bodies grinding together cannot re-trigger every frame |
| `IMPULSE_GAIN` / `MAX_IMPULSE` / `IMPULSE_PROBE` | 0.3 / 2.2 / 0.55 | knockback strength, its cap, and the wall probe distance |
| `DOWN_BOX_HEIGHT` | 0.98 | collision height while down |
| `VEHICLE_KNOCK_SPEED` | 3.4 | a hull faster than this topples a body outright |
| `VEHICLE_DAMAGE_SPEED` | 5.5 | above this a hull also injures what it hits |
| `CHARGE_MASS_BONUS` | 1.18 | sprint/charge makes you hit as if heavier |

Anti-loop rules, all covered by tests:

* an identical state within 35 % of its duration is not re-triggered;
* a body already `KNOCKED_DOWN` is not re-hypnotised by the paired self-reaction;
* `RECOVERING` cannot be re-toppled at all (except by `forceState`, i.e. a vehicle) — measured gap
  between knockdowns is now ≥ one full fall-hold-get-up cycle, where before the fix a second hit
  landed at 1.67 s, 0.15 s before the get-up finished;
* the pair budget is spent by attacks only, so a mover's own stagger cannot lock its defender out
  of being hit ever again;
* `impactCd`/`_pairCd` decay in `tickBodyState`, which runs on the actor's own clock, so a wedged
  body always stands up again.

Measured (**A3**, **B2**): 600 frames of resting contact produce **0** knockdowns; 10 s of 7.5 m/s
ramming produced **1** knockdown with the player standing **76 %** of that time; three bodies
ramming simultaneously for 15 s kept him off-balance **26 %** of the time — pressure, not a
stun-lock.

## Presentation hooks

* **Player** — camera `viewDrop` + `knockRoll` driven by `downBlend` (measured peak 1.00), spread
  and speed multipliers impaired while down, `canFire()` false so the trigger and ADS are
  released; getting up requires a fresh trigger press.
* **Soldiers** — the rig's `body` rotates toward `fallDir` (measured peak tilt 1.43 rad), the
  rifle is hidden, the scan strobe is suppressed, and `_wish`/`moveSpeed` are zeroed so a knocked
  down AI stops trying to walk; `aiMode: 'route'` degrades to `'staggered'`.
* **Feedback** — `Game.onBodyImpact` plays the impact cue, spawns a particle, adds camera shake,
  toasts `KNOCKED DOWN` / `STAGGERED`, and emits noise for a downed hostile.

## Verified behaviour

Every row below is measured by the current run (`reports/collision_behaviour_tests.json`).

| Case | Measured |
|---|---|
| Walk into a soldier (test A) | blocked: closest approach 0.66 m, worst overlap −0.001 m; 4 s of sprint input travelled only 1.54 m |
| Slow brush (test B2) | 1.2 m/s over 173 contact frames → **0** reactions |
| Sprint into a soldier (test C) | defender `standing → knocked_down → recovering`, attacker ends `staggered` |
| Heavy charges the player (test B) | `downBlend` peaked at **1.00**, then recovered to standing on the timer |
| Resting contact, 600 frames (test A3) | **0** knockdowns, separation held |
| Shoved into a wall by a heavy, 600 frames (test A4) | worst penetration into the wall **−0.026 m** — never pushed through |
| Downed soldier presentation (test A5) | peak rig tilt **1.43 rad**, box lowered to **0.98 m**, recovers |
| Full FSM lifecycle (test P2) | `knocked_down → recovering → standing`, box restored to 1.82 m, stagger lasted 35 frames with no residual lean, and death leaves **no** body registered |
| Knocked down by a truck (test G3) | knocked down at 23.5 m/s, victim peak speed 1.44 m/s, never inside the hull |
| Weapons while down (test M) | 0 rounds from 120 frames of held trigger, ADS released, re-press required |
