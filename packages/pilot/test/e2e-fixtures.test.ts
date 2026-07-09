import { describe, it, expect, afterEach } from "vitest";
import { db, loopCeilingStatus, startRun, startStage, recordAttempt, recordVerdict, finalizeStage } from "@pp/core";
import { RunPilot, EventBus, retryStage } from "../src/index.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

const REQUEST = "Add a greeting utility function to the project.";

function runRow(runId: string): { status: string } {
  return db().prepare(`SELECT status FROM runs WHERE id = ?`).get(runId) as { status: string };
}

function stageStatus(stage_id: string): string {
  return (db().prepare(`SELECT status FROM stages WHERE id = ?`).get(stage_id) as { status: string }).status;
}

describe("E2E — double fail surfaces the stage and the run", () => {
  it("code fails initial + retry → stage surfaced, run surfaced, pipeline halts", async () => {
    const projectPath = makeTempProject();
    // spec pass, code fail, code retry fail → surface at code, break.
    const engine = makeScriptedEngine({ verdictPlan: ["pass", "fail", "fail"] });
    const bus = new EventBus();
    const pilot = new RunPilot({ projectPath, requestText: REQUEST, mode: "single", engine, bus });

    const result = await pilot.execute();

    expect(result.status).toBe("surfaced");
    expect(runRow(result.run_id).status).toBe("surfaced");

    const stages = db().prepare(`SELECT kind, status FROM stages WHERE run_id = ? ORDER BY started_at`).all(result.run_id) as Array<{ kind: string; status: string }>;
    // Only spec + code ran; tests/docs never started (surface breaks the loop).
    expect(stages.map((s) => s.kind)).toEqual(["spec", "code"]);
    expect(stages.find((s) => s.kind === "code")!.status).toBe("surfaced");
  });
});

describe("E2E — judge unavailable aborts the run (never fabricate)", () => {
  afterEach(() => {
    delete process.env.PP_DISABLE_OPENAI;
    delete process.env.PP_DISABLE_GOOGLE;
  });

  it("empty cross-vendor judge pool on the spec gate → run aborted", async () => {
    process.env.PP_DISABLE_OPENAI = "1";
    process.env.PP_DISABLE_GOOGLE = "1";
    const projectPath = makeTempProject();
    const engine = makeScriptedEngine({ verdictPlan: ["pass"] });
    const bus = new EventBus();
    const pilot = new RunPilot({ projectPath, requestText: REQUEST, mode: "single", engine, bus });

    const result = await pilot.execute();

    expect(result.status).toBe("aborted");
    expect(runRow(result.run_id).status).toBe("aborted");
    // No verdict was fabricated for the spec stage.
    const verdicts = db()
      .prepare(`SELECT COUNT(*) AS n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id JOIN stages s ON s.id = a.stage_id WHERE s.run_id = ?`)
      .get(result.run_id) as { n: number };
    expect(verdicts.n).toBe(0);
    // The judge-halt path archived a critique_failure artifact.
    const kinds = (db().prepare(`SELECT kind FROM artifacts WHERE run_id = ?`).all(result.run_id) as Array<{ kind: string }>).map((r) => r.kind);
    expect(kinds).toContain("critique_failure");
  });
});

describe("E2E — loop ceiling no longer chokes automatic Reflexion retries", () => {
  it("the docs stage still gets its automatic retry past the run-wide ceiling → run completes", async () => {
    const projectPath = makeTempProject();
    // Every stage fails then passes on retry — by the time docs fails its
    // initial attempt, the run-wide 6-verdict ceiling has already been
    // exhausted by spec/code/tests. The automatic Reflexion retry is exempt
    // from the ceiling (only the Reflexion x1 invariant applies to it), so
    // docs still gets its one automatic retry and the run completes instead
    // of surfacing.
    const engine = makeScriptedEngine({
      verdictPlan: ["fail", "pass", "fail", "pass", "fail", "pass", "fail", "pass"],
    });
    const bus = new EventBus();
    const pilot = new RunPilot({ projectPath, requestText: REQUEST, mode: "single", engine, bus });

    const result = await pilot.execute();

    // The ceiling was exhausted (proves this test still exercises the
    // over-ceiling scenario), but it did not block the automatic retry.
    const ceiling = loopCeilingStatus(result.run_id);
    expect(ceiling.validator_calls).toBeGreaterThanOrEqual(ceiling.ceiling);
    expect(ceiling.blocked).toBe(true);

    expect(result.status).toBe("complete");
    expect(runRow(result.run_id).status).toBe("complete");

    const docs = db().prepare(`SELECT status FROM stages WHERE run_id = ? AND kind = 'docs'`).get(result.run_id) as { status: string } | undefined;
    expect(docs?.status).toBe("passed");

    // Docs did receive a retry attempt (retry_index=1) — the automatic
    // Reflexion path still ran, it just wasn't blocked by the ceiling.
    const docsRetry = db()
      .prepare(`SELECT COUNT(*) AS n FROM attempts a JOIN stages s ON s.id = a.stage_id WHERE s.run_id = ? AND s.kind = 'docs' AND a.retry_index = 1`)
      .get(result.run_id) as { n: number };
    expect(docsRetry.n).toBe(1);
  });

  it("a manual post-hoc retry on an over-ceiling run is still refused by the ceiling", async () => {
    const projectPath = makeTempProject();
    // Seed a run whose ceiling is already exhausted, with a fresh (never
    // retried) surfaced code stage — its Reflexion x1 budget is untouched,
    // so only the run-wide ceiling can block a manual retryStage() call.
    const { run_id } = await startRun({ request_text: REQUEST, project_path: projectPath, mode: "single" });

    // Burn the run-wide ceiling with unrelated verdicts on a throwaway stage.
    const { stage_id: burnStageId } = startStage({ run_id, kind: "spec", gate_type: "spec_review" });
    for (let i = 0; i < 6; i++) {
      const { attempt_id } = recordAttempt({
        stage_id: burnStageId,
        producer: "claude",
        model_id: "claude-sonnet-4-6",
        agent_type: "engineer",
        retry_index: 0,
        status: "ok",
        attempted_tier: "sonnet",
      });
      recordVerdict({ attempt_id, judge_producer: "codex", judge_model_id: "gpt-5.4", outcome: "pass", critique_md: "" });
    }

    // Now seed a surfaced code stage (fresh attempt, no retry yet) in the
    // same run — its first automatic Reflexion budget (retry_index >= 1)
    // has NOT been spent, so only the ceiling can block a manual retry here.
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
    await finalizeStage({ stage_id, status: "surfaced" });

    const ceiling = loopCeilingStatus(run_id);
    expect(ceiling.blocked).toBe(true);

    const res = await retryStage({ stageId: stage_id, engine: makeScriptedEngine({ verdictPlan: ["pass"] }), bus: new EventBus() });
    // reflexion() catches the ineligible check and surfaces the stage rather
    // than throwing (ok=true here just means "did not abort") — the ceiling
    // enforcement shows up as the stage staying surfaced, not passing.
    expect(res.outcome).toBe("surfaced");
    expect(stageStatus(stage_id)).toBe("surfaced");
  });
});
