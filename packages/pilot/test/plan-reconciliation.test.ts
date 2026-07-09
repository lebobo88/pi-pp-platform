import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { getTeam, db } from "@pp/core";
import { reconcilePlanWithRequirements } from "../src/phases/plan-reconciliation.js";
import { resolveArtifactKind } from "../src/phases/stage-loop.js";
import { RunPilot, EventBus } from "../src/index.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";
import type { RunContext, StageSpec } from "../src/types.js";

/** Minimal RunContext stub — reconciliation only reads sections/profile/
 * projectPath/teamName/profileName. */
function ctxFor(opts: {
  sections?: RunContext["sections"];
  profileRequiredArtifacts?: string[];
  profileRequiredSections?: string[];
}): RunContext {
  return {
    projectPath: process.cwd(),
    teamName: "feature-team",
    profileName: "ai-agentic",
    sections: opts.sections ?? [],
    profile: {
      name: "ai-agentic",
      required_taxonomy_sections: opts.profileRequiredSections ?? [],
      required_artifacts: opts.profileRequiredArtifacts ?? [],
    },
  } as unknown as RunContext;
}

describe("plan-reconciliation — 4.15 AI-controls coverage closure", () => {
  it("appends the AI-controls stages that produce the missing required kinds", () => {
    const found = getTeam({ name: "feature-team", project_path: process.cwd() });
    expect(found).not.toBeNull();
    const baseStages: StageSpec[] = found!.team.stages.map((s) => ({
      kind: s.kind,
      gate_type: s.gate_type,
      agent: s.generator.agent,
      artifact_kind: s.artifact_kind,
    }));

    // Synthetic profile requiring exactly the 4 AI-controls artifact kinds
    // (data_egress_review deliberately excluded here — see the separate
    // "genuinely impossible requirement" test below for that case).
    const ctx = ctxFor({
      profileRequiredSections: ["4.15"],
      profileRequiredArtifacts: ["ai_system_spec", "eval_suite", "tool_permission_matrix", "hitl_workflow"],
    });

    const result = reconcilePlanWithRequirements(ctx, baseStages);
    expect(result.abort).toBe(false);
    if (result.abort) return;

    const producedKinds = new Set(result.stages.map((s) => resolveArtifactKind(s)));
    expect(producedKinds.has("ai_system_spec")).toBe(true);
    expect(producedKinds.has("eval_suite")).toBe(true);
    expect(producedKinds.has("tool_permission_matrix")).toBe(true);
    expect(producedKinds.has("hitl_workflow")).toBe(true);

    // feature-team's own 7 stages are untouched, plus exactly the 4
    // AI-controls stages were appended (no duplicate docs — feature-team
    // already has one).
    expect(result.stages.length).toBe(baseStages.length + 4);
    expect(result.stages.filter((s) => s.kind === "docs").length).toBe(1);
  });

  it("does not augment when the plan already covers every required kind", () => {
    const found = getTeam({ name: "feature-team", project_path: process.cwd() });
    const baseStages: StageSpec[] = found!.team.stages.map((s) => ({
      kind: s.kind,
      gate_type: s.gate_type,
      agent: s.generator.agent,
      artifact_kind: s.artifact_kind,
    }));

    const ctx = ctxFor({ profileRequiredSections: ["4.13"], profileRequiredArtifacts: ["test_plan"] });
    const result = reconcilePlanWithRequirements(ctx, baseStages);
    expect(result.abort).toBe(false);
    if (result.abort) return;
    expect(result.stages.length).toBe(baseStages.length); // no augmentation needed
  });

  it("appends a docs stage when a required 4.13 section has no docs-kind stage", () => {
    const noDocsStages: StageSpec[] = [
      { kind: "code", gate_type: "code_style", agent: "engineer" },
    ];
    const ctx = ctxFor({ profileRequiredSections: ["4.13"] });
    const result = reconcilePlanWithRequirements(ctx, noDocsStages);
    expect(result.abort).toBe(false);
    if (result.abort) return;
    expect(result.stages.some((s) => s.kind === "docs")).toBe(true);
  });

  it("surfaces a structured, non-resumable blocker for a genuinely impossible requirement", () => {
    const found = getTeam({ name: "feature-team", project_path: process.cwd() });
    const baseStages: StageSpec[] = found!.team.stages.map((s) => ({
      kind: s.kind,
      gate_type: s.gate_type,
      agent: s.generator.agent,
      artifact_kind: s.artifact_kind,
    }));

    // data_egress_review has no producing stage anywhere in the asset
    // library (not in ai-controls-team.yaml or any other team) — this must
    // abort at plan-build time rather than silently dropping the
    // requirement or starting a run VG-2 will deterministically block later.
    const ctx = ctxFor({
      profileRequiredSections: ["4.15"],
      profileRequiredArtifacts: ["ai_system_spec", "data_egress_review"],
    });

    const result = reconcilePlanWithRequirements(ctx, baseStages);
    expect(result.abort).toBe(true);
    if (!result.abort) return;
    expect(result.reason).toContain("data_egress_review");
    // ai_system_spec WAS coverable — only the truly impossible kind is named.
    expect(result.reason).not.toContain("ai_system_spec]");
  });
});

describe("plan-reconciliation — wired end-to-end through RunPilot.execute() (mode=team)", () => {
  it("augments a team-mode plan with the ai_system_spec stage and actually produces the previously-missing artifact, completing the run", async () => {
    const projectPath = makeTempProject();

    // A synthetic profile (deliberately not one of the 14 built-ins — the
    // loader only requires a `.name` field) requiring exactly the concrete
    // reproduction cited in the plan: `ai_system_spec` required, but the
    // resolved plan (feature-team-shaped: spec/code only) has no stage
    // capable of producing it. `ai_system_spec` uses the `ai-controls-author`
    // agent, which is a completion-execution role (not session-coding/
    // session-readonly) — the fake engine's completion path genuinely
    // archives an artifact under the resolved kind, so this scenario proves
    // real end-to-end completion, not just plan-time augmentation.
    mkdirSync(join(projectPath, ".harness"), { recursive: true });
    writeFileSync(
      join(projectPath, ".harness", "profile.yaml"),
      YAML.stringify({
        name: "test-ai-controls-closure",
        description: "synthetic profile for coverage-closure e2e test",
        required_taxonomy_sections: ["4.15"],
        required_artifacts: ["ai_system_spec"],
      }),
      "utf8",
    );

    // A minimal 2-stage override plan (feature-team-shaped: no AI-controls
    // coverage) so we assert the pipeline actually appends and executes the
    // ai-controls-team's ai_system_spec stage via the real
    // dispatchStage/runStage path — not just via a direct
    // reconcilePlanWithRequirements() unit call.
    const engine = makeScriptedEngine({ verdictPlan: ["pass", "pass", "pass", "pass"] });
    const bus = new EventBus();
    const pilot = new RunPilot({
      projectPath,
      requestText: "Add an agentic tool-using feature that calls external APIs.",
      mode: "team",
      engine,
      bus,
      stagesOverride: [
        { kind: "spec", gate_type: "spec", agent: "spec-author" },
        { kind: "code", gate_type: "code_style", agent: "engineer" },
      ],
    });

    const result = await pilot.execute();
    expect(result.status).toBe("complete");

    const stageRows = db()
      .prepare(`SELECT kind, plan_index FROM stages WHERE run_id = ? ORDER BY plan_index ASC`)
      .all(result.run_id) as Array<{ kind: string; plan_index: number }>;
    // Original 2 override stages + a heuristically-required docs stage (the
    // near-universal 4.13 taxonomy heuristic) + the appended ai_system_spec
    // stage.
    expect(stageRows.map((r) => r.kind)).toEqual(["spec", "code", "docs", "ai_system_spec"]);
    expect(stageRows.every((r) => r.plan_index !== null)).toBe(true);

    // The persisted plan reflects the augmented (not raw) stage set.
    const runRow = db().prepare(`SELECT stage_plan_json FROM runs WHERE id = ?`).get(result.run_id) as {
      stage_plan_json: string | null;
    };
    expect(runRow.stage_plan_json).not.toBeNull();
    const persistedKinds = (JSON.parse(runRow.stage_plan_json!) as StageSpec[]).map((s) => s.kind);
    expect(persistedKinds).toEqual(stageRows.map((r) => r.kind));

    // The previously-impossible-to-produce artifact was actually archived by
    // the real stage-loop execution, proving the augmented stage ran (not
    // just planned) and that VG-2 no longer blocks finalize for this
    // combination.
    const artifacts = db().prepare(`SELECT kind FROM artifacts WHERE run_id = ?`).all(result.run_id) as Array<{
      kind: string;
    }>;
    expect(artifacts.some((a) => a.kind === "ai_system_spec")).toBe(true);
  });

  it("appends all 4 AI-controls stages (structural coverage) even though only ai_system_spec's completion-role agent archives in the fake-engine harness", async () => {
    const projectPath = makeTempProject();

    // Same augmentation as the "genuinely impossible requirement" unit test
    // above, driven through the real pilot this time: eval_suite,
    // tool_permission_matrix, and hitl_workflow use session-coding/
    // session-readonly agents (test-strategist, security-reviewer,
    // architect) whose real production archival happens via the agent's own
    // `archive_artifact` MCP tool call during its session — the fake engine
    // used in this test suite doesn't simulate that, so VG-2 blocks
    // finalize(complete) for those 3 kinds (a pre-existing, orthogonal
    // fake-engine limitation, not a reconciliation bug — VG-2 throws rather
    // than downgrading, per runs.ts:2547, so the pilot's outer catch maps
    // this to "crashed", matching finalizeRun's existing, documented
    // behavior). What this test proves is narrower but still load-bearing:
    // reconciliation appends the correct 4 stages (not fewer, not
    // duplicated) and the real dispatcher (dispatchStage/runStage) drives
    // every one of them to a terminal `passed` status.
    mkdirSync(join(projectPath, ".harness"), { recursive: true });
    writeFileSync(
      join(projectPath, ".harness", "profile.yaml"),
      YAML.stringify({
        name: "test-ai-controls-closure-full",
        description: "synthetic profile requiring all 4 AI-controls artifact kinds",
        required_taxonomy_sections: ["4.15"],
        required_artifacts: ["ai_system_spec", "eval_suite", "tool_permission_matrix", "hitl_workflow"],
      }),
      "utf8",
    );

    const engine = makeScriptedEngine({ verdictPlan: ["pass", "pass", "pass", "pass", "pass", "pass", "pass"] });
    const bus = new EventBus();
    const pilot = new RunPilot({
      projectPath,
      requestText: "Add an agentic tool-using feature that calls external APIs.",
      mode: "team",
      engine,
      bus,
      stagesOverride: [
        { kind: "spec", gate_type: "spec", agent: "spec-author" },
        { kind: "code", gate_type: "code_style", agent: "engineer" },
      ],
    });

    const result = await pilot.execute();

    const stageRows = db()
      .prepare(`SELECT kind, status, plan_index FROM stages WHERE run_id = ? ORDER BY plan_index ASC`)
      .all(result.run_id) as Array<{ kind: string; status: string; plan_index: number }>;
    expect(stageRows.map((r) => r.kind)).toEqual([
      "spec",
      "code",
      "docs",
      "ai_system_spec",
      "eval_suite",
      "tool_permissions",
      "hitl_workflow",
    ]);
    // Every augmented stage actually ran to a terminal passed outcome — the
    // dispatch wiring (Step 2/6) is correct regardless of the orthogonal
    // fake-engine archival gap for session-based roles.
    expect(stageRows.every((r) => r.status === "passed")).toBe(true);

    // ai_system_spec (completion role) archived; the 3 session-role kinds did
    // not (fake-engine limitation, not a reconciliation bug) — so VG-2
    // blocks finalize(complete) and the pilot maps the resulting throw to
    // "crashed" (finalizeRun's existing, documented VG-2 behavior — it
    // throws rather than downgrading, unlike VG-7's surfaced-stage path).
    const artifacts = db().prepare(`SELECT kind FROM artifacts WHERE run_id = ?`).all(result.run_id) as Array<{
      kind: string;
    }>;
    expect(artifacts.some((a) => a.kind === "ai_system_spec")).toBe(true);
    expect(result.status).toBe("crashed");
    expect(result.abort_reason).toContain("PP-VG-2");
  });
});
