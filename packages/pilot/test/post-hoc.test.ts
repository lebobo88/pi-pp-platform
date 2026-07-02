import { describe, it, expect } from "vitest";
import { startRun, startStage, recordAttempt, recordVerdict, finalizeStage, db } from "@pp/core";
import { regateStage, retryStage, EventBus } from "../src/index.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

/** Seed a code stage with a single failing attempt + verdict. */
async function seedFailedCodeStage(projectPath: string) {
  const { run_id } = await startRun({ request_text: "Add a greeting utility.", project_path: projectPath, mode: "single" });
  const { stage_id } = startStage({ run_id, kind: "code", gate_type: "code_style" });
  const { attempt_id } = recordAttempt({
    stage_id,
    producer: "claude",
    model_id: "claude-sonnet-4-6",
    agent_type: "engineer",
    retry_index: 0,
    status: "ok",
    attempted_tier: "sonnet",
    artifact_path: "code/",
  });
  recordVerdict({ attempt_id, judge_producer: "codex", judge_model_id: "gpt-5.4", outcome: "fail", critique_md: "fix the missing null check" });
  return { run_id, stage_id, attempt_id };
}

function stageStatus(stage_id: string): string {
  return (db().prepare(`SELECT status FROM stages WHERE id = ?`).get(stage_id) as { status: string }).status;
}

describe("post-hoc — regateStage (judge-only re-run)", () => {
  it("re-judges the latest attempt and finalizes passed on a fresh pass", async () => {
    const projectPath = makeTempProject();
    const { stage_id } = await seedFailedCodeStage(projectPath);

    const res = await regateStage({ stageId: stage_id, engine: makeScriptedEngine({ verdictPlan: ["pass"] }), bus: new EventBus() });
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("passed");
    expect(stageStatus(stage_id)).toBe("passed");

    // A second (passing) verdict was recorded — no regeneration happened.
    const verdicts = db()
      .prepare(`SELECT COUNT(*) AS n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id WHERE a.stage_id = ?`)
      .get(stage_id) as { n: number };
    expect(verdicts.n).toBe(2);
    const attempts = db().prepare(`SELECT COUNT(*) AS n FROM attempts WHERE stage_id = ?`).get(stage_id) as { n: number };
    expect(attempts.n).toBe(1); // no new attempt
  });
});

describe("post-hoc — retryStage (Reflexion ×1)", () => {
  it("regenerates a surfaced stage with the critique and finalizes passed", async () => {
    const projectPath = makeTempProject();
    const { stage_id } = await seedFailedCodeStage(projectPath);
    await finalizeStage({ stage_id, status: "surfaced" });

    const res = await retryStage({ stageId: stage_id, engine: makeScriptedEngine({ verdictPlan: ["pass"] }), bus: new EventBus() });
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("passed");
    expect(stageStatus(stage_id)).toBe("passed");

    // A retry attempt (retry_index=1) was created and re-judged.
    const retry = db()
      .prepare(`SELECT COUNT(*) AS n FROM attempts WHERE stage_id = ? AND retry_index = 1`)
      .get(stage_id) as { n: number };
    expect(retry.n).toBe(1);
  });

  it("refuses a second Reflexion retry (×1 invariant)", async () => {
    const projectPath = makeTempProject();
    const { run_id, stage_id } = await seedFailedCodeStage(projectPath);
    // Add an already-retried attempt (retry_index=1) with a fail verdict.
    const { attempt_id } = recordAttempt({
      stage_id,
      producer: "claude",
      model_id: "claude-opus-4-7",
      agent_type: "engineer",
      retry_index: 1,
      status: "ok",
      attempted_tier: "opus",
    });
    recordVerdict({ attempt_id, judge_producer: "codex", judge_model_id: "gpt-5.4", outcome: "fail", critique_md: "still broken" });
    void run_id;

    const res = await retryStage({ stageId: stage_id, engine: makeScriptedEngine({ verdictPlan: ["pass"] }), bus: new EventBus() });
    expect(res.outcome).toBe("surfaced"); // Reflexion ×1: the retry is refused, stage surfaces
  });
});
