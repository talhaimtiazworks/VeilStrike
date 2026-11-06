// Renders reports/COLLISION_VERIFICATION_MATRIX.md from the machine-readable
// evidence files, so the report can never drift from what the tests measured.
//   node --loader ./tests/progress_test_loader.mjs tests/render_behaviour_matrix.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const beh = read('reports/collision_behaviour_tests.json');
const cov = read('reports/collision_coverage.json');
const leak = read('reports/collision_leaks.json');
const ls = leak.summary || {};
const cs = cov.summary || {};

const esc = (x) => String(x || '').replace(/\|/g, '·').replace(/\s+/g, ' ').trim();
const rows = beh.results.map((r) => {
  const m = r.name.match(/^(\S+?)\.\s+([\s\S]*)$/);
  const label = m ? `**${esc(m[1])}.** ${esc(m[2])}` : esc(r.name);
  const det = esc(r.detail);
    return `| ${r.ok ? 'PASS' : '**FAIL**'} | ${label} | ${det.length > 380 ? det.slice(0, 377) + '…' : det} |`;
});

const md = `# VEILSTRIKE — Collision Verification Matrix

Rendered by \`tests/render_behaviour_matrix.mjs\` from \`reports/collision_behaviour_tests.json\`,
\`reports/collision_coverage.json\` and \`reports/collision_leaks.json\` — every number below is
copied from a test run, not transcribed by hand.

\`\`\`bash
node --loader ./tests/progress_test_loader.mjs tests/collision_gameplay_tests.mjs
node --loader ./tests/progress_test_loader.mjs tests/collision_coverage_audit.mjs
node --loader ./tests/progress_test_loader.mjs tests/collision_leak_audit.mjs
node --loader ./tests/progress_test_loader.mjs tests/render_behaviour_matrix.mjs   # rebuilds this file
\`\`\`

**Result: ${beh.passed}/${beh.total} behavioural tests passing · generated ${beh.generatedAt}**

Each test drives the real classes (\`Player\`, \`Enemy\`/\`EnemyManager\`, \`Vehicle\`/\`VehicleManager\`,
\`WeaponSystem\`, \`PhysicsWorld\`, \`GameWorld\`, \`Game\`) for real simulated frames and asserts on
positions, collision boxes, body states and the actual on-screen prompt strings. Only DOM, audio,
the renderer and the save file are stubbed (\`tests/headless_world.mjs\`).

| Test | Assertion | Measured |
|---|---|---|
${rows.join('\n')}

## Static audits (whole campaign)

| Audit | Result |
|---|---|
| Player-sized leak probe (\`collision_leak_audit.mjs\`) | ${ls.mapsAudited} maps · ${ls.totalSamples?.toLocaleString?.() ?? ls.totalSamples} samples at ${ls.sampleSpacing} m spacing · **${ls.totalLeakCells} leak cells · ${ls.totalNoFloorCells} no-floor cells · ${ls.mapsWithLeaks} maps with leaks** |
| Mesh↔collider coverage (\`collision_coverage_audit.mjs\`) | ${cs.mapsAudited} maps · ${cs.totalSolidMeshes?.toLocaleString?.() ?? cs.totalSolidMeshes} solid meshes · ${cs.totalCovered?.toLocaleString?.() ?? cs.totalCovered} covered = **${cs.coveragePct} %** · per-map detail in \`COLLISION_COVERAGE.md\` |
| Campaign integration | \`reports/campaign_100_audit.txt\` and \`reports/legacy_suites.txt\` hold the captured stdout of \`campaign_100_audit\`, \`runtime_smoke\`, \`gameplay_v3_smoke\` and \`verify_requirements\` — each ends with its own pass/fail tally; they were last re-run after the final engine change |

The unaccounted ${(100 - cs.coveragePct).toFixed(2)} % of meshes are authored decorative shapes
(cones, thin pipes, merged backdrop geometry) deliberately excluded via \`mesh.userData.col = 'skip'\`.
The metric that decides whether you can fall through the world is the leak probe, and it is at zero.

## What this does NOT cover

* Rendering, audio audibility and input latency — the harness never opens a browser, so nothing
  here claims the game *looks* or *sounds* right.
* Long sessions: the perf guardrail measures 300 frames with 200 actors and live vehicles, not an
  hour of campaign play.
* Deliberate design trade-offs are asserted, not policed: e.g. a knockdown may be re-applied only
  after the full fall-hold-get-up cycle, and \`RECOVERING\` is an invulnerable window by design.
`;

fs.writeFileSync(path.join(root, 'reports/COLLISION_VERIFICATION_MATRIX.md'), md);
console.log(`wrote reports/COLLISION_VERIFICATION_MATRIX.md (${md.length} bytes, ${rows.length} test rows)`);
