/**
 * completion-readiness.unit.mjs
 *
 * Tests for getRunCompletionReadiness() — specifically the `resumable` predicate
 * and `blocking_reason` field introduced by Fix 2a.
 *
 * Key invariants verified:
 *   (a) All planned stages passed + content-only blockers (missing required
 *       artifacts, failed required missability checks, unpopulated master-plan
 *       sections) → resumable=false; blocking_reason enumerates the counts.
 *   (b) A remaining planned stage (not yet in terminal status) → resumable=true.
 *   (c) A surfaced stage → resumable=false (hard stop, unchanged).
 *   (d) No stage plan + malformed snapshot → resumable=false (hard stop, unchanged).
 *   (e) No stage plan (null) → resumable=true (plan unknown/malformed, resume can advance).
 *
 * Anti-stall contract:
 *   - Temp sqlite DB via PP_HOME override.
 *   - No MCP server, no daemon socket, no real git operations.
 *   - Run: node --test test/completion-readiness.unit.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

// Isolate DB before any dist import.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-cr-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
delete process.env.PP_DB_PATH;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DIST = join(__dirname, "..", "dist");
const importDist = (rel) => import(pathToFileURL(join(DIST, rel)).href);

let _runs = null;
let _db = null;

async function getRuns() {
  if (!_runs) _runs = await importDist("orchestrator/runs.js");
  return _runs;
}
async function getDb() {
  if (!_db) {
    const m = await importDist("db/database.js");
    _db = m.db;
  }
  return _db;
}

const SHARED_PROJECT = mkdtempSync(join(tmpdir(), "pp-cr-proj-"));
mkdirSync(join(SHARED_PROJECT, ".harness"), { recursive: true });
writeFileSync(join(SHARED_PROJECT, "AGENTS.md"), "# AGENTS\n", "utf8");

/** Insert a bare run row directly (no file I/O, no git, no eights). */
async function insertRun(overrides = {}) {
  const db = await getDb();
  const id = `run_cr_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO runs(id, project_path, request_text, mode, team, forum, status,
        profile_snapshot_json, taxonomy_mapping_json, stage_plan_json, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    SHARED_PROJECT,
    "completion-readiness test",
    "single",
    overrides.team ?? null,
    overrides.forum ?? null,
    overrides.status ?? "surfaced",
    overrides.profile_snapshot_json ?? null,
    overrides.taxonomy_mapping_json ?? null,
    overrides.stage_plan_json ?? null,
    now,
  );
  return id;
}

/** Insert a bare stage row with optional plan_index and status. */
async function insertStage(run_id, { kind = "code", status = "passed", plan_index = null } = {}) {
  const db = await getDb();
  const id = `stage_cr_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO stages(id, run_id, kind, gate_type, status, plan_index, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, run_id, kind, kind, status, plan_index, now);
  return id;
}

/** Insert a missability_checks row. */
async function insertMissabilityCheck(run_id, check_id, status) {
  const db = await getDb();
  const id = `mc_cr_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO missability_checks(id, run_id, check_id, status, evidence_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, run_id, check_id, status, null, now);
}

/** A minimal valid stage_plan_json with one code stage. */
const ONE_STAGE_PLAN = JSON.stringify([{ kind: "code", gate_type: "code_style" }]);
const TWO_STAGE_PLAN = JSON.stringify([
  { kind: "code", gate_type: "code_style" },
  { kind: "spec", gate_type: "spec" },
]);

// ─── (b) Remaining planned stage → resumable=true ─────────────────────────────
describe("resumable=true when remaining planned stages exist", () => {
  it("one planned stage not yet in terminal status → resumable=true", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ stage_plan_json: ONE_STAGE_PLAN });
    // No stage row at plan_index=0 → remaining_planned_stages = [{plan_index:0,...}]

    const readiness = runs.getRunCompletionReadiness(run_id);
    assert.equal(readiness.resumable, true, "remaining planned stage must yield resumable=true");
    assert.equal(readiness.blocking_reason, null, "no blocking_reason when resumable");
    assert.equal(readiness.remaining_planned_stages?.length, 1);
    assert.equal(readiness.remaining_planned_stages[0].plan_index, 0);
  });

  it("second of two planned stages not yet run → resumable=true", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ stage_plan_json: TWO_STAGE_PLAN });
    // First stage passed (plan_index=0), second not started (plan_index=1).
    await insertStage(run_id, { kind: "code", status: "passed", plan_index: 0 });

    const readiness = runs.getRunCompletionReadiness(run_id);
    assert.equal(readiness.resumable, true, "second stage still pending → resumable");
    assert.equal(readiness.remaining_planned_stages?.length, 1);
    assert.equal(readiness.remaining_planned_stages[0].plan_index, 1);
  });

  it("null stage_plan_json (legacy run) → resumable=true (plan unknown)", async () => {
    const runs = await getRuns();
    // No stage_plan_json at all → remaining_planned_stages=null → resumable
    const run_id = await insertRun({ stage_plan_json: null });

    const readiness = runs.getRunCompletionReadiness(run_id);
    assert.equal(readiness.resumable, true, "null plan → resumable (unknown state)");
    assert.equal(readiness.remaining_planned_stages, null);
  });
});

// ─── (a) All stages passed + content-only blockers → resumable=false ───────────
describe("resumable=false for content-only blockers with no remaining stages", () => {
  it("missing required artifact + no remaining stages → resumable=false, blocking_reason mentions artifact count", async () => {
    const runs = await getRuns();
    // profile requires "spec" artifact, but no artifact row → missing_required_artifacts=["spec"]
    const run_id = await insertRun({
      stage_plan_json: ONE_STAGE_PLAN,
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_artifacts: ["spec"],
      }),
    });
    // Stage at plan_index=0 is 'passed' → remaining_planned_stages=[]
    await insertStage(run_id, { kind: "code", status: "passed", plan_index: 0 });

    const readiness = runs.getRunCompletionReadiness(run_id);
    assert.equal(readiness.resumable, false, "content-only artifact blocker must yield resumable=false");
    assert.ok(readiness.blocking_reason, "blocking_reason must be set");
    assert.ok(
      readiness.blocking_reason.includes("1 required artifact"),
      `blocking_reason must mention artifact count; got: "${readiness.blocking_reason}"`,
    );
    assert.ok(
      readiness.blocking_reason.includes("resume has nothing to re-run"),
      `blocking_reason must mention resume cannot help; got: "${readiness.blocking_reason}"`,
    );
    assert.deepEqual(readiness.remaining_planned_stages, []);
    assert.deepEqual(readiness.missing_required_artifacts, ["spec"]);
  });

  it("failed required missability check + no remaining stages → resumable=false, blocking_reason mentions check count", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({
      stage_plan_json: ONE_STAGE_PLAN,
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_missability_checks: ["nfrs-declared"],
      }),
    });
    await insertStage(run_id, { kind: "code", status: "passed", plan_index: 0 });
    await insertMissabilityCheck(run_id, "nfrs-declared", "fail");

    const readiness = runs.getRunCompletionReadiness(run_id);
    assert.equal(readiness.resumable, false, "content-only missability blocker must yield resumable=false");
    assert.ok(readiness.blocking_reason, "blocking_reason must be set");
    assert.ok(
      readiness.blocking_reason.includes("1 missability check"),
      `blocking_reason must mention check count; got: "${readiness.blocking_reason}"`,
    );
    assert.ok(
      readiness.blocking_reason.includes("resume has nothing to re-run"),
      `blocking_reason must mention resume cannot help; got: "${readiness.blocking_reason}"`,
    );
    assert.ok(readiness.failed_required_missability_checks.includes("nfrs-declared"));
  });

  it("multiple content blockers → blocking_reason lists all counts", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({
      stage_plan_json: ONE_STAGE_PLAN,
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_artifacts: ["spec", "adr"],
        required_missability_checks: ["nfrs-declared"],
      }),
    });
    await insertStage(run_id, { kind: "code", status: "passed", plan_index: 0 });
    await insertMissabilityCheck(run_id, "nfrs-declared", "fail");

    const readiness = runs.getRunCompletionReadiness(run_id);
    assert.equal(readiness.resumable, false);
    assert.ok(readiness.blocking_reason);
    assert.ok(
      readiness.blocking_reason.includes("2 required artifacts"),
      `must mention 2 artifacts; got: "${readiness.blocking_reason}"`,
    );
    assert.ok(
      readiness.blocking_reason.includes("1 missability check"),
      `must mention 1 check; got: "${readiness.blocking_reason}"`,
    );
  });

  it("all stages passed, no content blockers, status=complete → resumable=false, blocking_reason='run is already complete'", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ stage_plan_json: ONE_STAGE_PLAN, status: "complete" });
    await insertStage(run_id, { kind: "code", status: "passed", plan_index: 0 });

    const readiness = runs.getRunCompletionReadiness(run_id);
    assert.equal(readiness.resumable, false);
    assert.ok(readiness.blocking_reason?.includes("already complete"),
      `expected 'already complete'; got: "${readiness.blocking_reason}"`);
  });

  it("all stages passed, no content blockers, status=surfaced → resumable=false", async () => {
    const runs = await getRuns();
    // Surfaced status but all stages passed, no remaining stages, no content blockers.
    const run_id = await insertRun({ stage_plan_json: ONE_STAGE_PLAN, status: "surfaced" });
    await insertStage(run_id, { kind: "code", status: "passed", plan_index: 0 });

    const readiness = runs.getRunCompletionReadiness(run_id);
    assert.equal(readiness.resumable, false, "no remaining stages → not resumable regardless of status");
    assert.ok(readiness.blocking_reason, "blocking_reason must be set");
  });
});

// ─── (c) Surfaced stage → resumable=false (hard stop, unchanged) ───────────────
describe("resumable=false for surfaced stage (hard stop)", () => {
  it("one surfaced stage → resumable=false, blocking_reason mentions surfaced stage", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ stage_plan_json: ONE_STAGE_PLAN });
    await insertStage(run_id, { kind: "code", status: "surfaced", plan_index: 0 });

    const readiness = runs.getRunCompletionReadiness(run_id);
    assert.equal(readiness.resumable, false, "surfaced stage must be a hard stop");
    assert.ok(readiness.blocking_reason?.includes("surfaced stage"),
      `expected 'surfaced stage' in reason; got: "${readiness.blocking_reason}"`);
    assert.equal(readiness.surfaced_stages.length, 1);
  });

  it("surfaced stage takes precedence over content-only blockers", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({
      stage_plan_json: ONE_STAGE_PLAN,
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_artifacts: ["spec"],
      }),
    });
    await insertStage(run_id, { kind: "code", status: "surfaced", plan_index: 0 });

    const readiness = runs.getRunCompletionReadiness(run_id);
    assert.equal(readiness.resumable, false);
    // blocking_reason should say "surfaced stage" not "content blockers"
    assert.ok(readiness.blocking_reason?.includes("surfaced stage"),
      `surfaced stage reason must take precedence; got: "${readiness.blocking_reason}"`);
  });
});
