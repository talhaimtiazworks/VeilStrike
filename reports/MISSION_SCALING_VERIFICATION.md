# Mission scaling verification — v17.6.0

See the expanded `MISSION_SCALING_REPORT.md` for production changes, test boundaries, and details.

- Formula: `50 + ((n - 1) × 2)` for one-based campaign operation `n`.
- Verified boundaries: OP 001=50, OP 002=52, OP 003=54, OP 004=56, OP 010=68, OP 050=148, OP 100=248.
- Latest `tests/mission_scaling_tests.mjs`: **29 passed, 0 failed**.
- Tests exercise production manager streaming with actual Enemy instances at OP 001 (four tries), OP 002 (two), OP 003, OP 050, and OP 100; exact spawn totals/logs, zero failed spawns, active cap, and overflow rejection are checked.
- Production checkpoint restart after a full 50-actor attempt clears the previous counter/log and starts a fresh OP 001 opening reserve at target 50.
- `Game.startMission()` tests cover all ten campaign missions, the training range, repeated OP 001/002 failure retries, and target progression.
- Spawn waves are streamed under the existing active-hostile cap. Test actors are retired between echelons for deterministic reserve drains; combat/mission objectives and UI rendering are not simulated by this suite.
