#!/usr/bin/env bash
# Full verification pass for the collision, enemy-AI, combat, ammunition,
# click-to-fire input and tactical-map work.
# Writes captured evidence into
# reports/ so any claim in the fix reports can be checked against a real run.
set -u
cd "$(dirname "$0")/.."
LOADER="./tests/progress_test_loader.mjs"
run() {                      # run <suite> <label>
  local file="tests/$1.mjs" out="reports/$2.txt"
  local log; log="$(mktemp)"
  timeout 1500 node --loader "$LOADER" "$file" >"$log" 2>&1
  local rc=$?
  grep -vE 'ExperimentalWarning|--import|trace-warnings' "$log" > "$out"
  local pass fail
  pass=$(grep -cE '^PASS ' "$out"); fail=$(grep -cE '^FAIL ' "$out")
  printf '%-28s exit=%s  PASS=%s  FAIL=%s\n' "$2" "$rc" "$pass" "$fail" | tee -a reports/verification_summary.txt
  rm -f "$log"
}
: > reports/verification_summary.txt
run collision_gameplay_tests  collision_behaviour_tests
run collision_coverage_audit  collision_coverage_audit
run collision_leak_audit      collision_leak_audit
run enemy_ai_combat_tests     enemy_ai_combat
run ammunition_tests          ammunition
run pickup_tests              ammo_pickups
run firing_pipeline_tests     firing_pipeline       # v4.3: the pre-fix cadence, kept as a pin
run firing_input_tests        firing_input          # v4.3: one click = one shot, end to end
run tacmap_tests              tactical_map          # v4.3+v4.4: map geometry, routes, and the full interaction contract
# v4.4: the same map driven in a real Chromium (six viewports/inputs, screenshots in
# reports/browser/). Needs Playwright; prints SKIP and exits 0 when there is no browser,
# so this stays safe on a machine that only has node.
browser_map() {
  local out="reports/browser_map.txt" rc pass fail skip tag=""
  timeout 3000 node tests/browser_map_tests.mjs >"$out" 2>&1
  rc=$?
  pass=$(grep -cE '^PASS ' "$out" 2>/dev/null || true)
  fail=$(grep -cE '^FAIL ' "$out" 2>/dev/null || true)
  skip=$(grep -c '^SKIP' "$out" 2>/dev/null || true)
  [ "${skip:-0}" -gt 0 ] && tag="SKIPPED (no Playwright/Chromium here)"
  printf '%-28s exit=%s  PASS=%s  FAIL=%s  %s\n' browser_map "$rc" "${pass:-0}" "${fail:-0}" "$tag" | tee -a reports/verification_summary.txt
}
browser_map
run runtime_smoke             runtime_smoke
run gameplay_v3_smoke         gameplay_v3_smoke
run verify_requirements       verify_requirements
run campaign_100_audit        campaign_100_audit
run mission_scaling_tests     mission_scaling
run pwa_offline_tests         pwa_offline

echo
echo "behavioural detail: reports/COLLISION_VERIFICATION_MATRIX.md"
node --loader "$LOADER" tests/render_behaviour_matrix.mjs 2>&1 | grep -vE 'Warning|--import'
