# VEILSTRIKE — Vehicle Collision, Boarding & Run-over Report

Vehicles were the worst hole in the old collision model: they existed only as meshes. You could
walk through a parked truck, drive one straight through a squad with no effect, and `F` put you in
the driver's seat from anywhere — through a wall, from the wrong side, or from six metres away.

## 1. A vehicle is now a body

`Vehicle` publishes its hull to the actor field every frame, **after** the move:

```js
// js/vehicles.js:940 — inside the post-move sync
syncActorBody(g.physics, this, this.box, { tag: 'vehicle', material: 'metal', mass: this.collisionMass });
```

The hull itself is resolved with `moveBox(..., { actors: false, maxDepenetrate: 0.5 })`
(`js/vehicles.js:1352`, `:1550`): a hull never *shoves* bodies through the generic resolver —
contacts are handled by one owner, `_processHullContacts`, so damage, knockdown and ejection can't
be applied twice.

Ordering mattered more than the geometry: `_syncBox()` used to run *before* the move, so the solid
hull trailed the visible truck by one frame — at 12.7 m/s that is a **124 mm** gap where you could
stand inside a bumper. Measured now (test **G2**): drove 7.47 m, collider divergence **0.0 mm**.

The seated driver is *not* unregistered — his actor body keeps following the car (player.js
republishes it in `_syncBox`). Instead, `canAct()`/`canFire()` and the movement gate short-circuit
in vehicle mode, and `_processHullContacts` exempts the current driver per victim.

## 2. Running people over (`_processHullContacts`)

Runs once per frame per vehicle, only within 60 m of the player:

1. Early-out when `speedAbs < 1.1 && sink < 1.0` (a parked truck does no work).
2. `physics.actors.query(hullMin, hullMax, list, this._body)` — the hull's own actor body is
   excluded; the loop then keeps only `body.tag === 'actor'`, so other hulls and props are ignored.
3. Skips the seated driver — **only** the driver (`victim === game.player && this.driver === 'player'`),
   which is the bug that used to disable run-overs entirely (see §5).
4. `applyImpact(victim, { closingSpeed: max(closing, speedAbs, sink), attackerMass:
   this.collisionMass, forceState: vehSpeed >= VEHICLE_KNOCK_SPEED ? KNOCKED_DOWN : STAGGERED })`
   — under 3.4 m/s a hull staggers you, at or above it you go down; `forceState` is why a hull can
   still topple you *while you are getting up* (the recovery window only protects against actors).
   Above `VEHICLE_DAMAGE_SPEED` (5.5 m/s) it also inflicts `min(58, (closing − 5.5) · 9)` damage,
   with noise and an impact cue, on the player and on any NPC alike.
5. `ejectFromHull(victim, hullBox, physics, selfBody)` — geometric separation along the shallowest
   exit axis, wall-safe, because knockback alone cannot clear a 6 m box in the ~6 frames it takes a
   truck to pass through you.

Measured (test **G3**): a truck at **23.5 m/s** knocks the soldier down, his peak post-hit speed is
**1.44 m/s** (capped — no helicopter launch), and he is **never inside the hull** on any frame.
Measured (test **N**, 8 map families): **4,320** walk/run/crouch approaches into a parked hull,
**0** entries.

## 3. Getting in

`_updateVehicleBoarding` in `js/game.js` owns `[F]` for vehicles *before* the generic interactable
pass, and the decision comes from geometry rather than a radius:

* `driverDoorWorld()` / `doorInfo()` — the door's world position and its outward normal.
* `canBoardFrom(pos)` — a ordered list of refusals, not a radius test: `WRECKED`, `OCCUPIED`,
  `LOCKED`/`AIRBORNE` (helicopter state), `MOVING` (above 1.35 m/s for a parked vehicle, 2.5 m/s
  if AI-driven), then **reach** (`NEAR_DOOR` within `reach + 3`, else `TOO_FAR`), then **side**
  (`WRONG_SIDE` if the operator is inside the door plane), then a raycast from the operator's eye to
  the door aperture so a wall between them refuses the grab.
* `boardingCandidate()` in `js/game.js` is what turns a refusal into UI: no prompt is shown unless
  `canBoardFrom().ok`.
* Prompt text is authored from that state, so the HUD never says `PRESS [F]` when `[F]` would fail.

Measured: **H** — prompt is exactly `PRESS [F] — ENTER VEHICLE` at the door, and the operator seats
within **2.06 m** of it, with `driver === 'player'`. **I** — approaching from the far side is refused
(`NEAR_DOOR`/wrong side), and standing 3.4 m away is refused rather than teleporting him in.

## 4. Getting out

`_safeExit(v, out)` enumerates candidate positions (door side, far side, front, rear, raised and
lowered variants), scores them, and accepts the first that is simultaneously:

* free of static geometry (`isBoxFree` with the player's box at standing height),
* free of actor bodies — soldiers, other vehicles, crowds — via the `{ actors: true }` query,
* above a real floor (downward raycast, `normal.y ≥ 0.5`), and
* not inside the hull you just left.

If a wall is built flush against the driver's door, the operator is *not* dropped into it:
measured **J** — egress relocated to the clear side, **3.52 m** from the doorway, box free of
statics, never inside the hull, on the ground. **J2** — a ring of soldiers: relocated to a gap
between bodies. **J3** — after 18.4 m of driving, exit is clean and the camera/velocity stay finite.

## 5. Bugs found and fixed in the vehicle work

| Bug | Symptom | Fix |
|---|---|---|
| `if (game.vehicleMode === this) continue;` inside the *per-victim* loop | while the **player** was driving, no pedestrian anywhere could be knocked down — the one case that mattered | exempt only the seated driver of that vehicle, per victim |
| Legacy run-over block braked the truck (`speed *= 0.72` per body per frame) and applied damage twice | driving through a crowd decelerated the vehicle to a crawl | deleted; `_processHullContacts` is the single owner of run-over |
| `applyImpact` called on hull bodies | `TypeError` on a missing field / hulls toppling over | actors carry `impactFsm`; a hull blocks but never topples |
| Hull collider published before the move | 124 mm one-frame ghost at speed | republish after the move (G2: 0.0 mm) |
| `spawnFromWorld()` resets actor bodies | a freshly spawned hull is absent from the actor field until the next tick (this bit the *test harness* first) | one `vehicles.update(1/60)` tick before querying; noted so nobody "fixes" it in the engine |
| A victim caught mid-hull | left standing inside the truck after it passed | `ejectFromHull` resolves the contact geometrically, wall-safe |

## 6. Limits

* Hulls are single boxes (`wd × hl` from `VEHICLE_DEFS`), so a truck's bed overhang and mirrored
  side-mirror geometry are not individually solid. This is deliberate: the box is what the mover,
  the resolver and the boarding checks all share.
* Only vehicles within 60 m of the player run the contact pass; distant traffic still collides with
  the world through `moveBox` but does not resolve body impacts.
* Under-water/flipping vehicle states reuse the same hull volume; no per-state collider swap.
