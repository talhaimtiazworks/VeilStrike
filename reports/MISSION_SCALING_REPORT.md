# Campaign enemy scaling verification — v17.6.0

## Rule

`target = 50 + ((mission number - 1) × 2)`; attempt/death/time/save history is not an input. Key campaign targets: OP 001=50, OP 002=52, OP 003=54, OP 050=148, OP 100=248. Range remains separately capped at 30.

## Production changes

The previous manager expanded its lifetime campaign target by 24, so its permitted spawn count could exceed the displayed/planned total. The extra allowance is removed. Mission start computes one campaign-index target for planning, manager cap, HUD/start notice, and the spawn ledger. Checkpoint restart uses its checkpoint mission ID for the same target, clears old actor and attempt records, and starts a new reserve sequence. Streamed spawn staging and the existing 12-live hostile cap remain. Campaign progression changes only when the next campaign mission is started.

## Automated results

`tests/mission_scaling_tests.mjs`: **29 passed, 0 failed**.

- Seven direct formula boundaries (OP 001, 002, 003, 004, 010, 050, 100).
- Four OP 001 production-manager attempts and two OP 002 attempts, plus single runs at OP 003/050/100.
- Actual `Enemy` instances run through collision-aware position selection, `spawnInitial`, and production reserve drains; spawned totals and spawn logs exactly equal their targets, there are no failed spawns, active hostiles remain at or below 12, and the manager rejects one more actor after its cap.
- An actual `Game.restartFromCheckpoint()` production path starts a fresh OP 001 attempt after a completed 50-actor attempt: its opening actor/log count is reset, target remains 50, and reserve remaining is 42.
- Failure-save/load and mission re-entry do not affect the target. Existing progression tests confirm a successful progression step advances OP 001 to OP 002.
- The separate gameplay smoke invokes the actual `Game.startMission()` path for all ten campaign missions, the range, and repeated failure/retry entry for OP 001/002, asserting their exact manager targets.

The deterministic full-roster test retires active actors between streamed echelons to exercise the intended reserve drain without simulating 100 missions of combat. The checkpoint harness uses production checkpoint logic but stubs unrelated presentation/player restoration. This is not a full rendered combat/mission-completion play-through. Browser completion/count UI remains unverified in a real browser due unavailable browser tooling.
