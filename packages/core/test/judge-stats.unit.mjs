// Unit tests for judgeStats(): read-only per-judge aggregation over ACTIVE
// verdicts, grouped by (judge_producer, judge_model_id).
//
// Covers:
//  - Aggregation math: n_verdicts, pass/revise/fail rates, cross_vendor_share,
//    and avg_min_dimension_score (mean of per-verdict minimum dimension score,
//    computed only from the sanitized numeric score_json).
//  - Retracted exclusion: a retracted verdict is NOT counted (retracted_at IS
//    NULL), matching the active-verdict invariant every other verdict-sensitive
//    query in runs.ts upholds.
//  - avg_min_dimension_score is null for a group whose verdicts carry no
//    numeric score_json.
//
// Runs against the compiled dist/.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

// Set env BEFORE any dist import so DB_PATH resolves to an isolated file. A
// single fresh DB for the whole file means judgeStats() (which aggregates the
// entire verdicts table, un-scoped) sees ONLY the rows this test seeds.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-judge-stats-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
delete process.env.PP_DB_PATH; // isolate from any live dev server DB
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

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg} (got ${a}, want ${b})`);

function setupProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-judge-stats-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
  return dir;
}

await record("judgeStats aggregates active verdicts and excludes retracted", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const run = await runs.ensureRun({ request_text: "judge stats", project_path: project, mode: "single" });
    const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    // Generator is claude/claude-sonnet-4-6 → codex judge is cross-vendor,
    // claude judge (different model) is same-vendor.
    const att = runs.recordAttempt({
      stage_id: stage.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok",
    });

    // Judge A — codex/gpt-5.4 (cross-vendor). Three verdicts; the revise one
    // is retracted and must drop out of every A statistic.
    runs.recordVerdict({
      attempt_id: att.attempt_id, judge_producer: "codex", judge_model_id: "gpt-5.4",
      outcome: "pass", score_json: { correctness: 0.9, completeness: 0.8 },
    });
    runs.recordVerdict({
      attempt_id: att.attempt_id, judge_producer: "codex", judge_model_id: "gpt-5.4",
      outcome: "fail", score_json: { correctness: 0.4, completeness: 0.9 },
    });
    const toRetract = runs.recordVerdict({
      attempt_id: att.attempt_id, judge_producer: "codex", judge_model_id: "gpt-5.4",
      outcome: "revise", score_json: { correctness: 0.6, completeness: 0.65 },
    });
    runs.retractVerdict({
      verdict_id: toRetract.verdict_id,
      reason: "retracted for the active-verdict exclusion assertion in this test",
    });

    // Judge B — claude/claude-opus-4-6 (same-vendor). One pass verdict.
    runs.recordVerdict({
      attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-opus-4-6",
      outcome: "pass", score_json: { correctness: 0.7 },
    });

    // Judge C — claude/claude-haiku-4-5 (same-vendor). One revise verdict with
    // NO numeric score_json → contributes to counts but not avg_min.
    runs.recordVerdict({
      attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-haiku-4-5",
      outcome: "revise",
    });

    const rows = runs.judgeStats();
    assert.equal(rows.length, 3, "exactly three judge groups (retracted verdict adds none)");

    const a = rows.find(r => r.judge_producer === "codex" && r.judge_model_id === "gpt-5.4");
    assert.ok(a, "codex/gpt-5.4 row present");
    assert.equal(a.n_verdicts, 2, "retracted revise verdict excluded from the count");
    near(a.pass_rate, 0.5, "A pass_rate");
    near(a.fail_rate, 0.5, "A fail_rate");
    near(a.revise_rate, 0, "A revise_rate (retracted revise not counted)");
    near(a.cross_vendor_share, 1, "A cross_vendor_share");
    // min(0.9,0.8)=0.8 ; min(0.4,0.9)=0.4 ; mean=0.6
    near(a.avg_min_dimension_score, 0.6, "A avg_min_dimension_score");

    const b = rows.find(r => r.judge_producer === "claude" && r.judge_model_id === "claude-opus-4-6");
    assert.ok(b, "claude/claude-opus-4-6 row present");
    assert.equal(b.n_verdicts, 1);
    near(b.pass_rate, 1, "B pass_rate");
    near(b.cross_vendor_share, 0, "B cross_vendor_share (same vendor)");
    near(b.avg_min_dimension_score, 0.7, "B avg_min_dimension_score");

    const c = rows.find(r => r.judge_producer === "claude" && r.judge_model_id === "claude-haiku-4-5");
    assert.ok(c, "claude/claude-haiku-4-5 row present");
    assert.equal(c.n_verdicts, 1);
    near(c.revise_rate, 1, "C revise_rate");
    assert.equal(c.avg_min_dimension_score, null, "C avg_min null with no numeric score_json");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
