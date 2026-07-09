/**
 * loop-ceiling-automatic.unit.mjs
 *
 * Self-contained unit tests for `checkRetryEligible`'s `automatic` parameter
 * (the "replace the self-defeating retry budget model" fix):
 *
 *   - The run-wide loop ceiling (DEFAULT_LOOP_CEILING=6 validator calls/run)
 *     must NOT block the automatic Reflexion path (`automatic: true`) even
 *     when the ceiling is already exhausted for the run — only the
 *     Reflexion x1 invariant (retry_index >= 1) applies to that path.
 *   - The manual/operator retry path (automatic omitted/false) and the MCP
 *     retry_with_critique path (also automatic omitted/false) MUST still be
 *     blocked by the ceiling when exhausted, unless budget_override is set —
 *     byte-identical to pre-fix behavior.
 *   - The Reflexion x1 invariant itself (retry_index >= 1) is NOT bypassed by
 *     `automatic: true` — it still requires budget_override to force a
 *     second automatic-looking retry.
 *
 * Anti-stall contract:
 *   - Uses a temp sqlite DB (PP_HOME override), direct dist function calls
 *     and direct SQL row inserts (no startRun/eights-daemon calls needed —
 *     checkRetryEligible only reads attempts/stages).
 *   - No MCP server, no daemon socket, no smoke files touched.
 *   - Run: timeout 90 node --test test/loop-ceiling-automatic.unit.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Set PP_HOME BEFORE any dist import so the DB is isolated.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-loop-ceiling-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
delete process.env.PP_DB_PATH; // isolate from any live dev server DB
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let _loopCeiling = null;
let _db = null;

async function getLoopCeiling() {
  if (!_loopCeiling) _loopCeiling = await importDist("orchestrator/loop-ceiling.js");
  return _loopCeiling;
}
async function getDb() {
  if (!_db) {
    const m = await importDist("db/database.js");
    _db = m.db;
  }
  return _db;
}

const SHARED_PROJECT = mkdtempSync(join(tmpdir(), "pp-lc-shared-"));

/** Insert a bare run row directly (no file I/O, no git, no eights). */
async function insertRun() {
  const db = await getDb();
  const id = `run_lc_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO runs(id, project_path, request_text, mode, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, SHARED_PROJECT, "loop-ceiling test", "single", "running", now);
  return id;
}

/** Insert a bare stage row directly. */
async function insertStage(run_id, kind = "code") {
  const db = await getDb();
  const id = `stage_lc_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO stages(id, run_id, kind, gate_type, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, run_id, kind, kind, "running", now);
  return id;
}

/** Insert a bare attempt row directly, with an explicit retry_index. */
async function insertAttempt(stage_id, { retry_index = 0 } = {}) {
  const db = await getDb();
  const id = `attempt_lc_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO attempts(id, stage_id, producer, model_id, status, retry_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, stage_id, "claude", "claude-sonnet-4-6", "ok", retry_index, now);
  return id;
}

/** Insert a verdict row directly, tallying one validator call against the run. */
async function insertVerdict(attempt_id) {
  const db = await getDb();
  const id = `verdict_lc_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO verdicts(id, attempt_id, judge_producer, judge_model_id, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, attempt_id, "codex", "gpt-5.4", "fail", now);
  return id;
}

/** Exhausts the run-wide loop ceiling (6 validator calls) with 6 distinct
 * stage/attempt/verdict rows on the given run. */
async function exhaustLoopCeiling(run_id) {
  for (let i = 0; i < 6; i++) {
    const stage_id = await insertStage(run_id, `filler-${i}`);
    const attempt_id = await insertAttempt(stage_id);
    await insertVerdict(attempt_id);
  }
}

describe("checkRetryEligible — automatic Reflexion path is exempt from the run-wide loop ceiling", () => {
  it("automatic:true is NOT blocked by an exhausted loop ceiling (first retry, retry_index=0)", async () => {
    const { checkRetryEligible, loopCeilingStatus } = await getLoopCeiling();
    const run_id = await insertRun();
    await exhaustLoopCeiling(run_id);
    assert.equal(loopCeilingStatus(run_id).blocked, true, "ceiling should be exhausted after 6 verdicts");

    const stage_id = await insertStage(run_id, "code");
    const attempt_id = await insertAttempt(stage_id, { retry_index: 0 });

    const result = checkRetryEligible({ attempt_id, automatic: true });
    assert.equal(result.ok, true, "automatic retry must not be blocked by the exhausted ceiling");
  });

  it("automatic omitted (manual/operator path) IS blocked by an exhausted loop ceiling, unchanged from pre-fix behavior", async () => {
    const { checkRetryEligible, loopCeilingStatus } = await getLoopCeiling();
    const run_id = await insertRun();
    await exhaustLoopCeiling(run_id);
    assert.equal(loopCeilingStatus(run_id).blocked, true);

    const stage_id = await insertStage(run_id, "code");
    const attempt_id = await insertAttempt(stage_id, { retry_index: 0 });

    const result = checkRetryEligible({ attempt_id }); // automatic omitted
    assert.equal(result.ok, false);
    assert.match(result.reason, /loop ceiling reached/);
  });

  it("automatic:false (explicit, e.g. MCP retry_with_critique forwarding its own flag) is also blocked by the ceiling", async () => {
    const { checkRetryEligible } = await getLoopCeiling();
    const run_id = await insertRun();
    await exhaustLoopCeiling(run_id);

    const stage_id = await insertStage(run_id, "code");
    const attempt_id = await insertAttempt(stage_id, { retry_index: 0 });

    const result = checkRetryEligible({ attempt_id, automatic: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /loop ceiling reached/);
  });

  it("budget_override:true bypasses the ceiling for the manual path exactly as before (unaffected by the automatic fix)", async () => {
    const { checkRetryEligible } = await getLoopCeiling();
    const run_id = await insertRun();
    await exhaustLoopCeiling(run_id);

    const stage_id = await insertStage(run_id, "code");
    const attempt_id = await insertAttempt(stage_id, { retry_index: 0 });

    const result = checkRetryEligible({ attempt_id, budget_override: true });
    assert.equal(result.ok, true, "operator override still bypasses the ceiling");
  });

  it("automatic:true does NOT bypass the Reflexion x1 invariant itself (retry_index >= 1 still blocks)", async () => {
    const { checkRetryEligible } = await getLoopCeiling();
    const run_id = await insertRun(); // ceiling NOT exhausted here — isolates the Reflexion x1 check
    const stage_id = await insertStage(run_id, "code");
    const attempt_id = await insertAttempt(stage_id, { retry_index: 1 }); // already a retry

    const result = checkRetryEligible({ attempt_id, automatic: true });
    assert.equal(result.ok, false, "Reflexion x1 invariant applies regardless of automatic");
    assert.match(result.reason, /Reflexion ×1 invariant/);
  });

  it("a fresh (non-exhausted) run allows both automatic and manual retries without needing override", async () => {
    const { checkRetryEligible, loopCeilingStatus } = await getLoopCeiling();
    const run_id = await insertRun();
    assert.equal(loopCeilingStatus(run_id).blocked, false);

    const stage_id = await insertStage(run_id, "code");
    const attempt_id = await insertAttempt(stage_id, { retry_index: 0 });

    assert.equal(checkRetryEligible({ attempt_id, automatic: true }).ok, true);
    assert.equal(checkRetryEligible({ attempt_id }).ok, true);
  });
});
