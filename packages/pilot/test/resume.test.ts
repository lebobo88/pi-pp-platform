import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "@pp/engine";
import {
  db,
  recordAttempt,
  recordVerdict,
  finalizeStage,
  archiveArtifact,
  getRunCompletionReadiness,
} from "@pp/core";
import { RunPilot, resumeRun, EventBus, type PilotEvent } from "../src/index.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

/** Wraps an engine so every authoring-completion systemPrompt is captured. */
function withPromptCapture(engine: Engine, capture: string[]): Engine {
  return {
    ...engine,
    runAuthoringCompletion: async (o) => {
      capture.push(o.systemPrompt);
      return engine.runAuthoringCompletion(o);
    },
  };
}

const MARKER_ARTIFACT_TEXT = "MARKER_UPSTREAM_CODE_ARTIFACT_42 — approved implementation notes.\n";

function stageRow(stageId: string): { status: string; plan_index: number | null } {
  return db().prepare(`SELECT status, plan_index FROM stages WHERE id = ?`).get(stageId) as {
    status: string;
    plan_index: number | null;
  };
}

function runStatus(runId: string): string {
  return (db().prepare(`SELECT status FROM runs WHERE id = ?`).get(runId) as { status: string }).status;
}

describe("resumeRun — recovery success", () => {
  it("repairs a surfaced code stage out-of-band, then continues remaining planned stages, rehydrating stageArtifacts and rerunning missability/master-plan to reach complete", async () => {
    const projectPath = makeTempProject();
    const prompts: string[] = [];
    const initialEngine = withPromptCapture(
      makeScriptedEngine({ verdictPlan: ["pass", "fail", "fail"] }),
      prompts,
    );
    const bus = new EventBus();

    const pilot = new RunPilot({
      projectPath,
      requestText: "Add a greeting utility function to the project.",
      mode: "single",
      engine: initialEngine,
      bus,
      stagesOverride: [
        { kind: "spec", gate_type: "spec", agent: "spec-author" },
        { kind: "code", gate_type: "code_style", agent: "engineer" },
        { kind: "tests", gate_type: "lint_class", agent: "test-strategist" },
        { kind: "docs", gate_type: "docs_polish", agent: "docs-author" },
      ],
    });

    const first = await pilot.execute();
    expect(first.status).toBe("surfaced");
    expect(runStatus(first.run_id)).toBe("surfaced");

    const rows = db()
      .prepare(`SELECT id, kind, status, plan_index FROM stages WHERE run_id = ? ORDER BY plan_index ASC`)
      .all(first.run_id) as Array<{ id: string; kind: string; status: string; plan_index: number }>;
    expect(rows.map((r) => r.kind)).toEqual(["spec", "code"]);
    const codeStage = rows.find((r) => r.kind === "code")!;
    expect(codeStage.status).toBe("surfaced");

    // Readiness reports the surfaced code stage as the blocker.
    const preReadiness = getRunCompletionReadiness(first.run_id);
    expect(preReadiness.resumable).toBe(false);
    expect(preReadiness.surfaced_stages.map((s) => s.stage_id)).toContain(codeStage.id);
    expect(preReadiness.remaining_planned_stages?.map((s) => s.kind)).toEqual(["tests", "docs"]);

    // Repair the surfaced code stage directly via core primitives (the
    // post-hoc integration is a separate change; this test exercises
    // resumeRun in isolation). Archive a marker artifact so the rehydration
    // assertion below can confirm it reached the next stage's prompt.
    const { attempt_id } = recordAttempt({
      stage_id: codeStage.id,
      producer: "claude",
      model_id: "claude-opus-4-7",
      agent_type: "engineer",
      retry_index: 2,
      status: "ok",
      attempted_tier: "opus",
      artifact_path: "code/",
    });
    recordVerdict({
      attempt_id,
      judge_producer: "codex",
      judge_model_id: "gpt-5.4",
      outcome: "pass",
      critique_md: "looks good now",
    });
    await finalizeStage({ stage_id: codeStage.id, winner_attempt_id: attempt_id, status: "passed" });
    archiveArtifact({
      run_id: first.run_id,
      stage_id: codeStage.id,
      taxonomy_section: "4.8",
      kind: "diff",
      relative_path: `code/diff-${codeStage.id}.patch`,
      bytes: MARKER_ARTIFACT_TEXT,
    });

    // Readiness now reports forward progress is possible (remaining planned
    // stages), no more surfaced/incomplete stages.
    const midReadiness = getRunCompletionReadiness(first.run_id);
    expect(midReadiness.surfaced_stages.length).toBe(0);
    expect(midReadiness.incomplete_stages.length).toBe(0);
    expect(midReadiness.resumable).toBe(true);

    const resumeEngine = withPromptCapture(makeScriptedEngine({ verdictPlan: ["pass", "pass"] }), prompts);
    const resumeBus = new EventBus();
    const resumeEvents: PilotEvent[] = [];
    resumeBus.subscribe((e) => resumeEvents.push(e));

    const result = await resumeRun({ runId: first.run_id, engine: resumeEngine, bus: resumeBus });

    expect(result.resumed).toBe(true);
    expect(result.status).toBe("complete");
    expect(runStatus(first.run_id)).toBe("complete");

    const finalRows = db()
      .prepare(`SELECT kind, status, plan_index FROM stages WHERE run_id = ? ORDER BY plan_index ASC`)
      .all(first.run_id) as Array<{ kind: string; status: string; plan_index: number }>;
    expect(finalRows.map((r) => r.kind)).toEqual(["spec", "code", "tests", "docs"]);
    expect(finalRows.every((r) => r.status === "passed")).toBe(true);
    expect(finalRows.map((r) => r.plan_index)).toEqual([0, 1, 2, 3]);

    // The resumed "tests" stage's generator prompt received the repaired
    // code stage's artifact — proof ctx.stageArtifacts was rehydrated, not
    // left empty (which would silently regress prompt quality on resume).
    expect(prompts.some((p) => p.includes(MARKER_ARTIFACT_TEXT.trim()))).toBe(true);

    // Missability re-ran during resume (fresh events on the resume bus).
    expect(resumeEvents.some((e) => e.type === "missability.result")).toBe(true);
    // Master-plan patched, and run.finalized emitted on the resume's own bus.
    expect(resumeEvents.some((e) => e.type === "run.finalized")).toBe(true);
    const master = readFileSync(join(projectPath, "PROJECT_MASTER.md"), "utf8");
    expect(master).toContain(first.run_id);

    // The refreshed summary reflects the final clean state, not the earlier
    // surfaced-stage text.
    const summary = readFileSync(join(projectPath, ".harness", first.run_id, "run.summary.md"), "utf8");
    expect(summary).toContain("No open follow-ups");
    expect(summary).not.toContain("needs follow-up");
  });
});

describe("resumeRun — run-level recovery (no remaining stages, only completion phases blocked)", () => {
  it("reruns missability/master-plan/finalize and completes the same run when every stage already passed", async () => {
    const projectPath = makeTempProject();
    const engine = makeScriptedEngine({ verdictPlan: ["pass", "pass", "pass", "pass"] });
    const bus = new EventBus();

    const pilot = new RunPilot({
      projectPath,
      requestText: "Add a greeting utility function to the project.",
      mode: "single",
      engine,
      bus,
      stagesOverride: [
        { kind: "spec", gate_type: "spec", agent: "spec-author" },
        { kind: "code", gate_type: "code_style", agent: "engineer" },
        { kind: "tests", gate_type: "lint_class", agent: "test-strategist" },
        { kind: "docs", gate_type: "docs_polish", agent: "docs-author" },
      ],
    });

    const first = await pilot.execute();
    expect(first.status).toBe("complete");
    // Force the run back to 'surfaced' to simulate a run that surfaced
    // solely on a completion-phase gate (e.g. a required master-plan section
    // landed late) rather than a stage judge verdict — every stage row is
    // already 'passed'; nothing remains to (re)execute.
    db().prepare(`UPDATE runs SET status = 'surfaced' WHERE id = ?`).run(first.run_id);

    const readiness = getRunCompletionReadiness(first.run_id);
    expect(readiness.surfaced_stages.length).toBe(0);
    expect(readiness.incomplete_stages.length).toBe(0);
    expect(readiness.remaining_planned_stages).toEqual([]);
    expect(readiness.resumable).toBe(true);

    const resumeBus = new EventBus();
    const resumeEvents: PilotEvent[] = [];
    resumeBus.subscribe((e) => resumeEvents.push(e));

    const result = await resumeRun({ runId: first.run_id, engine, bus: resumeBus });

    expect(result.resumed).toBe(true);
    expect(result.status).toBe("complete");
    expect(runStatus(first.run_id)).toBe("complete");
    // No new stage rows were created — only completion phases re-ran.
    const rowCount = (
      db().prepare(`SELECT COUNT(*) AS n FROM stages WHERE run_id = ?`).get(first.run_id) as { n: number }
    ).n;
    expect(rowCount).toBe(4);
    expect(resumeEvents.some((e) => e.type === "missability.result")).toBe(true);

    // ctx.sections was rehydrated from taxonomy_mapping_json (not left empty,
    // as post-hoc.ts's stage-scoped reconstruct() would give it): the
    // master-plan phase patched a section derived from the "4.8" (diff)
    // requirement, not just the always-included executive summary.
    const masterPlanEvent = resumeEvents.find(
      (e) => e.type === "run.context" && (e.data as { phase?: string }).phase === "master-plan",
    );
    expect(masterPlanEvent).toBeDefined();
    const patched = (masterPlanEvent!.data as { patched?: string[] }).patched ?? [];
    expect(patched).toContain("13. Engineering standards and delivery model");
  });
});

describe("resumeRun — legacy run (no persisted plan)", () => {
  it("reconstructs the plan deterministically from mode/scope/taxonomy snapshot and resumes correctly", async () => {
    const projectPath = makeTempProject();
    const engine = makeScriptedEngine({ verdictPlan: ["pass", "pass", "pass", "pass"] });
    const bus = new EventBus();

    const pilot = new RunPilot({
      projectPath,
      requestText: "Add a greeting utility function to the project.",
      mode: "single", // no stagesOverride: buildStagePlan's default "standard" plan is
      // [spec, code, tests, docs] — the same sequence a legacy pre-migration
      // run of this same request would have executed.
      engine,
      bus,
    });

    const first = await pilot.execute();
    expect(first.status).toBe("complete");
    expect(
      (db().prepare(`SELECT kind FROM stages WHERE run_id = ? ORDER BY plan_index ASC`).all(first.run_id) as Array<{
        kind: string;
      }>).map((r) => r.kind),
    ).toEqual(["spec", "code", "tests", "docs"]);

    // Simulate a pre-v10 row: no persisted plan, and no plan_index on any
    // stage row (the additive migration never backfills existing rows).
    db().prepare(`UPDATE runs SET stage_plan_json = NULL, status = 'surfaced' WHERE id = ?`).run(first.run_id);
    db().prepare(`UPDATE stages SET plan_index = NULL WHERE run_id = ?`).run(first.run_id);

    const readiness = getRunCompletionReadiness(first.run_id);
    // Legacy: remaining_planned_stages is null (no persisted plan to compare
    // against) — the readiness inspector defers to resumeRun's own
    // reconstruction rather than guessing.
    expect(readiness.remaining_planned_stages).toBeNull();
    expect(readiness.resumable).toBe(true);

    const result = await resumeRun({ runId: first.run_id, engine, bus: new EventBus() });

    expect(result.resumed).toBe(true);
    expect(result.status).toBe("complete");
    expect(runStatus(first.run_id)).toBe("complete");

    // The reconstructed plan was persisted and plan_index backfilled — this
    // run is now fully v10-compliant going forward.
    const runRow = db().prepare(`SELECT stage_plan_json FROM runs WHERE id = ?`).get(first.run_id) as {
      stage_plan_json: string | null;
    };
    expect(runRow.stage_plan_json).not.toBeNull();
    const backfilled = db()
      .prepare(`SELECT kind, plan_index FROM stages WHERE run_id = ? ORDER BY plan_index ASC`)
      .all(first.run_id) as Array<{ kind: string; plan_index: number }>;
    expect(backfilled.map((r) => r.plan_index)).toEqual([0, 1, 2, 3]);
    expect(backfilled.map((r) => r.kind)).toEqual(["spec", "code", "tests", "docs"]);
  });
});

describe("resumeRun — negative paths", () => {
  it("refuses to resume while a surfaced stage remains, and makes no writes", async () => {
    const projectPath = makeTempProject();
    const engine = makeScriptedEngine({ verdictPlan: ["fail", "fail"] });
    const bus = new EventBus();

    const pilot = new RunPilot({
      projectPath,
      requestText: "Add a greeting utility function to the project.",
      mode: "single",
      engine,
      bus,
      stagesOverride: [{ kind: "code", gate_type: "code_style", agent: "engineer" }],
    });

    const first = await pilot.execute();
    expect(first.status).toBe("surfaced");

    const before = db().prepare(`SELECT COUNT(*) AS n FROM stages WHERE run_id = ?`).get(first.run_id) as {
      n: number;
    };

    const result = await resumeRun({ runId: first.run_id, engine, bus: new EventBus() });

    expect(result.resumed).toBe(false);
    expect(result.readiness?.surfaced_stages.length).toBeGreaterThan(0);
    expect(runStatus(first.run_id)).toBe("surfaced"); // unchanged
    const after = db().prepare(`SELECT COUNT(*) AS n FROM stages WHERE run_id = ?`).get(first.run_id) as {
      n: number;
    };
    expect(after.n).toBe(before.n); // no new stage rows
  });

  it("rejects a concurrent resume attempt on an already-running run (atomic claim guard)", async () => {
    const projectPath = makeTempProject();
    const engine = makeScriptedEngine({ verdictPlan: ["pass"] });
    const bus = new EventBus();

    const pilot = new RunPilot({
      projectPath,
      requestText: "Add a greeting utility function to the project.",
      mode: "single",
      engine,
      bus,
      stagesOverride: [{ kind: "spec", gate_type: "spec", agent: "spec-author" }],
    });

    const first = await pilot.execute();
    // Force the run back to 'running' to simulate "already active elsewhere"
    // (the original execute() still in flight, or a concurrent resume).
    db().prepare(`UPDATE runs SET status = 'running' WHERE id = ?`).run(first.run_id);

    const result = await resumeRun({ runId: first.run_id, engine, bus: new EventBus() });
    expect(result.resumed).toBe(false);
    expect(runStatus(first.run_id)).toBe("running"); // untouched by the rejected resume
  });
});
