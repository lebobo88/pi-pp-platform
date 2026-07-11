// Unit tests for the isSameModel normalization in recordVerdict.
//
// Covers:
//   - recordVerdict rejects when attempt model_id is provider-qualified
//     ("deepseek/deepseek-v4-pro") and judge_model_id is the bare form
//     ("deepseek-v4-pro") for the same producer. Without the isSameModel fix
//     these compared unequal (strict ===) and the guard silently passed.
//   - The reverse case (bare generator, qualified judge) also rejects.
//   - The existing strict-equal case still rejects (non-regression).
//   - Different model ids (the happy path) still succeed.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-same-model-guard-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
delete process.env.PP_DB_PATH;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

function setupProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-smg-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  return dir;
}

async function setup() {
  const project = setupProject();
  const runs = await importDist("orchestrator/runs.js");
  const run = await runs.ensureRun({ request_text: "same-model guard test", project_path: project, mode: "single" });
  const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
  return { project, runs, run, stage };
}

test("recordVerdict rejects qualified generator model vs bare judge model (same producer)", async () => {
  const { project, runs, stage } = await setup();
  try {
    const att = runs.recordAttempt({
      stage_id: stage.stage_id,
      producer: "claude",
      model_id: "deepseek/deepseek-v4-pro",
      status: "ok",
    });
    assert.throws(
      () => runs.recordVerdict({
        attempt_id: att.attempt_id,
        judge_producer: "claude",
        judge_model_id: "deepseek-v4-pro",
        rubric_id: "code-quality@1",
        outcome: "pass",
        critique_md: "test",
      }),
      /same-vendor verdict requires different model ids/,
      "should reject: qualified generator 'deepseek/deepseek-v4-pro' === bare judge 'deepseek-v4-pro'",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("recordVerdict rejects bare generator model vs qualified judge model (same producer)", async () => {
  const { project, runs, stage } = await setup();
  try {
    const att = runs.recordAttempt({
      stage_id: stage.stage_id,
      producer: "claude",
      model_id: "deepseek-v4-pro",
      status: "ok",
    });
    assert.throws(
      () => runs.recordVerdict({
        attempt_id: att.attempt_id,
        judge_producer: "claude",
        judge_model_id: "deepseek/deepseek-v4-pro",
        rubric_id: "code-quality@1",
        outcome: "pass",
        critique_md: "test",
      }),
      /same-vendor verdict requires different model ids/,
      "should reject: bare generator 'deepseek-v4-pro' === qualified judge 'deepseek/deepseek-v4-pro'",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("recordVerdict rejects strict-equal model ids (non-regression)", async () => {
  const { project, runs, stage } = await setup();
  try {
    const att = runs.recordAttempt({
      stage_id: stage.stage_id,
      producer: "claude",
      model_id: "claude-sonnet-4-6",
      status: "ok",
    });
    assert.throws(
      () => runs.recordVerdict({
        attempt_id: att.attempt_id,
        judge_producer: "claude",
        judge_model_id: "claude-sonnet-4-6",
        rubric_id: "code-quality@1",
        outcome: "pass",
        critique_md: "test",
      }),
      /same-vendor verdict requires different model ids/,
      "should reject: same bare model ids",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("recordVerdict accepts same-vendor different model ids (happy path)", async () => {
  const { project, runs, stage } = await setup();
  try {
    const att = runs.recordAttempt({
      stage_id: stage.stage_id,
      producer: "claude",
      model_id: "claude-sonnet-4-6",
      status: "ok",
    });
    const verdict = runs.recordVerdict({
      attempt_id: att.attempt_id,
      judge_producer: "claude",
      judge_model_id: "claude-opus-4-7",
      rubric_id: "code-quality@1",
      outcome: "pass",
      critique_md: "different models — allowed",
    });
    assert.ok(verdict.verdict_id, "verdict_id must be present");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
