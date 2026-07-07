// Unit test for startRun → runs.cli_flags_json persistence.
//
// startRun previously never wrote runs.cli_flags_json, so per-run CLI/override
// flags (tier caps/floors, ladder + tier-pool overrides) were lost for replay.
// Covers:
//  - provided cli_flags are serialized verbatim into cli_flags_json,
//  - an absent cli_flags leaves the column NULL,
//  - an empty cli_flags object also leaves it NULL (no "{}" noise).

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-cli-flags-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
// Prevent a live PP_DB_PATH from overriding the isolated test database.
delete process.env.PP_DB_PATH;
process.env.PP_SKIP_CLI_VERSIONS = "1";
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let passed = 0;
let failed = 0;
function record(name, fn) {
  return fn().then(
    () => { console.log(`✓ ${name}`); passed++; },
    (err) => { console.error(`✗ ${name}\n  ${err.message}`); failed++; },
  );
}

const { db } = await importDist("db/database.js");
const runs = await importDist("orchestrator/runs.js");

function mkProject(name) {
  const p = join(SUITE_DIR, name);
  mkdirSync(p, { recursive: true });
  return p;
}
function cliFlagsFor(runId) {
  const row = db().prepare("SELECT cli_flags_json FROM runs WHERE id = ?").get(runId);
  return row?.cli_flags_json ?? null;
}

await record("provided cli_flags are serialized verbatim into cli_flags_json", async () => {
  const flags = {
    tier_cap: "opus",
    no_tier_policy: true,
    ladder_override: { sonnet: "openai/gpt-5.5" },
    tier_pools_override: { sonnet: ["openai/gpt-5.5", "anthropic/claude-opus-4-7"] },
  };
  const out = await runs.startRun({
    request_text: "persist my flags",
    project_path: mkProject("proj-flags"),
    mode: "single",
    cli_flags: flags,
  });
  const stored = cliFlagsFor(out.run_id);
  assert.ok(stored, "cli_flags_json is populated");
  assert.deepEqual(JSON.parse(stored), flags, "round-trips the flags object");
});

await record("absent cli_flags leaves cli_flags_json NULL", async () => {
  const out = await runs.startRun({
    request_text: "no flags",
    project_path: mkProject("proj-none"),
    mode: "single",
  });
  assert.equal(cliFlagsFor(out.run_id), null, "column stays NULL for a flagless run");
});

await record("empty cli_flags object leaves cli_flags_json NULL", async () => {
  const out = await runs.startRun({
    request_text: "empty flags",
    project_path: mkProject("proj-empty"),
    mode: "single",
    cli_flags: {},
  });
  assert.equal(cliFlagsFor(out.run_id), null, "empty object collapses to NULL");
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
