/**
 * RunPilot — the in-process lifecycle driver.
 *
 * Replaces pair-programmer's Claude-Code Task-tool orchestration with a single
 * class that drives the 9-phase run lifecycle over @pp/core state and the
 * @pp/engine runtime:
 *
 *   1 triage → 2 profile → 3 startRun → 4 taxonomy → 5 ensure AGENTS.md +
 *   tier_decisions → 6 stage loop (tier resolve · generate · judge · Reflexion
 *   ×1) → 7 missability → 8 master-plan → 9 finalize (+ autogenesis).
 *
 * Every phase is wrapped so an unexpected failure maps the run to "crashed",
 * an AbortSignal maps it to "aborted", and the per-project advisory lock is
 * always released.
 */

import {
  startRun,
  forceUnlock,
  getTeam,
  db,
  heuristicTriage,
  loadProjectProfile,
  detectProfile,
  writeProjectProfile,
  getBuiltinProfile,
  ensureAgentsAndClaudeMd,
  type TeamSpec,
  type Scope,
  type ClaudeTier,
} from "@pp/core";

import { EventBus } from "./events.js";
import { JudgePolicy } from "./judge-policy.js";
import { emit, type RunContext, type RunPilotOptions, type StageSpec } from "./types.js";
import { runStage, reArchiveTierDecisions } from "./phases/stage-loop.js";
import { runMissabilityPhase } from "./phases/missability.js";
import { runMasterPlanPhase } from "./phases/master-plan.js";
import { runFinalizePhase, type StageReport } from "./phases/finalize.js";
import { runTriagePhase } from "./phases/triage.js";
import { runProfilePhase } from "./phases/profile.js";
import { runTaxonomyPhase } from "./phases/taxonomy.js";

export type RunResult = {
  run_id: string;
  status: RunContext["finalStatus"];
  stages: StageReport[];
  abort_reason?: string;
};

export class RunPilot {
  private readonly opts: RunPilotOptions;

  constructor(opts: RunPilotOptions) {
    this.opts = opts;
  }

  async execute(): Promise<RunResult> {
    const o = this.opts;

    // ── Phase 2 (early): profile bootstrap, before startRun snapshots it. ────
    // The heuristic scope + a written profile.yaml must exist before start_run
    // so the run row snapshots them. Neither step needs a run_id.
    bootstrapProfile(o.projectPath);
    const heuristic = heuristicTriage({ request_text: o.requestText });
    const scope: Scope = o.scopeOverride ?? heuristic.scope;

    // ── Phase 3: start run (acquires the project lock, snapshots profile). ───
    const started = await startRun({
      request_text: o.requestText,
      project_path: o.projectPath,
      mode: o.mode,
      team: o.team,
      forum: o.forum,
      n: o.n,
    });

    const ctx: RunContext = {
      run_id: started.run_id,
      artifact_dir: started.artifact_dir,
      started_at: started.started_at,
      projectPath: o.projectPath,
      requestText: o.requestText,
      mode: o.mode,
      teamName: o.team,
      forum: o.forum,
      n: o.n,
      flags: { tierCap: o.tierCap, tierFloor: o.tierFloor, noTierPolicy: o.noTierPolicy },
      engine: o.engine,
      bus: o.bus,
      judgePolicy: new JudgePolicy(),
      clock: o.clock ?? (() => Date.now()),
      signal: o.signal,
      scope,
      signals: heuristic.signals,
      sections: [],
      missabilityRequired: [],
      profile: null,
      team: undefined,
      tierTrace: [],
      finalStatus: "complete",
    };

    emit(ctx, "run.started", { mode: o.mode, scope, project_path: o.projectPath, request: o.requestText });

    const stages: StageReport[] = [];
    try {
      // ── Phases 1/2/4: triage refinement, profile snapshot, taxonomy. ───────
      await runTriagePhase(ctx, o.scopeOverride);
      runProfilePhase(ctx);
      await runTaxonomyPhase(ctx);

      // ── Phase 5: ensure AGENTS.md + seed tier_decisions.json. ──────────────
      ensureAgentsAndClaudeMd(ctx.projectPath);
      reArchiveTierDecisions(ctx);

      // ── Phase 6: build the stage set and run it. ───────────────────────────
      const plan = this.buildStagePlan(ctx);
      if (plan.abort) {
        ctx.finalStatus = "aborted";
        ctx.abortReason = plan.reason;
      } else {
        for (const stage of plan.stages) {
          if (ctx.signal?.aborted) {
            ctx.finalStatus = "aborted";
            ctx.abortReason = "aborted by signal";
            break;
          }
          const outcome = await runStage(ctx, stage);
          stages.push({ kind: stage.kind, outcome });
          if (outcome === "aborted") {
            ctx.finalStatus = "aborted";
            break;
          }
          if (outcome === "surfaced") {
            ctx.finalStatus = "surfaced";
            break; // surface halts the pipeline
          }
        }
      }

      // ── Phases 7/8: missability + master-plan (complete path only). ────────
      if (ctx.finalStatus === "complete") {
        const missability = runMissabilityPhase(ctx);
        if (missability.passed) {
          runMasterPlanPhase(ctx);
        }
      }

      // ── Phase 9: finalize (+ autogenesis). ─────────────────────────────────
      await runFinalizePhase(ctx, stages);
    } catch (err) {
      // AbortSignal → aborted; anything else → crashed.
      const aborted = ctx.signal?.aborted || (err as Error)?.name === "AbortError";
      ctx.finalStatus = aborted ? "aborted" : "crashed";
      ctx.abortReason = (err as Error)?.message ?? String(err);
      await this.finalizeFailure(ctx, stages);
    } finally {
      // Belt-and-suspenders: finalizeRun releases the lock on every non-crash
      // path, but release again in case we bailed before finalize.
      try {
        forceUnlock(ctx.projectPath);
      } catch {
        /* ignore */
      }
    }

    return {
      run_id: ctx.run_id,
      status: ctx.finalStatus,
      stages,
      abort_reason: ctx.abortReason,
    };
  }

  /**
   * Finalize on a crash/abort path. finalizeRun cannot write "crashed", so we
   * finalize as "aborted" (releases the lock, writes the summary) and then
   * stamp the terminal status the pilot actually reached.
   */
  private async finalizeFailure(ctx: RunContext, stages: StageReport[]): Promise<void> {
    const target = ctx.finalStatus; // "crashed" | "aborted"
    try {
      // finalizeRun only accepts complete|surfaced|aborted; use "aborted" for
      // the summary + lock release, then stamp "crashed" if that's the reality.
      ctx.finalStatus = "aborted";
      await runFinalizePhase(ctx, stages);
      if (target === "crashed") {
        db().prepare(`UPDATE runs SET status = 'crashed' WHERE id = ?`).run(ctx.run_id);
      }
    } catch {
      // Last-resort: stamp the status directly so the run never dangles "running".
      try {
        db().prepare(`UPDATE runs SET status = ? WHERE id = ?`).run(
          target === "crashed" ? "crashed" : "aborted",
          ctx.run_id,
        );
      } catch {
        /* ignore */
      }
    }
    ctx.finalStatus = target;
  }

  /** Build the ordered stage set for this run's mode + scope. */
  private buildStagePlan(
    ctx: RunContext,
  ): { abort: false; stages: StageSpec[] } | { abort: true; reason: string } {
    if (ctx.mode === "single") {
      if (ctx.scope === "trivial") {
        const docShaped = ctx.signals.includes("doc-only");
        return {
          abort: false,
          stages: docShaped
            ? [{ kind: "docs", gate_type: "docs_polish", agent: "docs-author" }]
            : [{ kind: "code", gate_type: "code_style", agent: "engineer" }],
        };
      }
      if (ctx.scope === "major") {
        if (ctx.signals.includes("doc-only")) {
          // major but doc-only → a single doc/spec stage rather than aborting.
          const specShaped = /\b(adr|madr|spec|prd|rfc)\b/i.test(ctx.requestText);
          return {
            abort: false,
            stages: specShaped
              ? [{ kind: "spec", gate_type: "spec", agent: "spec-author" }]
              : [{ kind: "docs", gate_type: "docs_polish", agent: "docs-author" }],
          };
        }
        return {
          abort: true,
          reason:
            "major-scope request in single mode — re-run with a team pipeline " +
            "(mode=team, e.g. feature-team). Refusing to force a major change through the single-stage path.",
        };
      }
      // standard
      return {
        abort: false,
        stages: [
          { kind: "spec", gate_type: "spec", agent: "spec-author" },
          { kind: "code", gate_type: "code_style", agent: "engineer" },
          { kind: "tests", gate_type: "lint_class", agent: "test-strategist" },
          { kind: "docs", gate_type: "docs_polish", agent: "docs-author" },
        ],
      };
    }

    // team / best_of / review → drive the team yaml's stage set generically.
    if (!ctx.teamName) {
      return { abort: true, reason: `mode=${ctx.mode} requires a team name` };
    }
    const found = getTeam({ name: ctx.teamName, project_path: ctx.projectPath });
    if (!found) {
      return { abort: true, reason: `team "${ctx.teamName}" not found` };
    }
    ctx.team = found.team;
    return { abort: false, stages: teamStages(found.team) };
  }
}

/** Map a team yaml's stages onto the pilot's StageSpec (generators are Path-A Claude). */
function teamStages(team: TeamSpec): StageSpec[] {
  return team.stages.map((s) => ({
    kind: s.kind,
    gate_type: s.gate_type,
    agent: s.generator.agent,
    artifact_kind: s.artifact_kind,
    teamStageModelTier: s.generator.model_tier as ClaudeTier | undefined,
    rubricHint: s.judge?.rubric,
    judgeModelPref: s.judge?.model_pref,
  }));
}

/**
 * Bootstrap a profile.yaml when the project has none and detection is
 * confident. Mirrors runProfilePhase but runs BEFORE start_run so the run row
 * snapshots the written profile. Best-effort — generic mode on any failure.
 */
function bootstrapProfile(projectPath: string): void {
  try {
    if (loadProjectProfile(projectPath)) return;
    const detection = detectProfile(projectPath);
    if (detection.recommendation && (detection.confidence === "high" || detection.confidence === "medium")) {
      writeProjectProfile(projectPath, detection.recommendation, {
        source: "detected",
        signals: detection.signals,
      });
      getBuiltinProfile(detection.recommendation);
    }
  } catch {
    /* generic mode */
  }
}

export { EventBus };
