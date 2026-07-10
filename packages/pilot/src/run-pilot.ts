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
  getForum,
  db,
  heuristicTriage,
  loadProjectProfile,
  detectProfile,
  writeProjectProfile,
  getBuiltinProfile,
  recommendTeams,
  ensureAgentsAndClaudeMd,
  ensureTaxonomyBlueprint,
  persistStagePlan,
  recordPhaseTiming,
  type TeamSpec,
  type Forum,
  type Scope,
  type ClaudeTier,
} from "@pp/core";

import { EventBus } from "./events.js";
import { JudgePolicy } from "./judge-policy.js";
import { emit, type RunContext, type RunPilotOptions, type StageSpec, type StageOutcome } from "./types.js";
import { mergeLadderOverride } from "./generation-model.js";
import { runStage, reArchiveTierDecisions } from "./phases/stage-loop.js";
import { runBestOfStage } from "./phases/best-of.js";
import { runBrowserValidationStage } from "./phases/browser-validation.js";
import { runMissabilityPhase } from "./phases/missability.js";
import { runMasterPlanPhase } from "./phases/master-plan.js";
import { runFinalizePhase, type StageReport } from "./phases/finalize.js";
import { runTriagePhase } from "./phases/triage.js";
import { runProfilePhase } from "./phases/profile.js";
import { runTaxonomyPhase } from "./phases/taxonomy.js";
import { reconcilePlanWithRequirements } from "./phases/plan-reconciliation.js";

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

    // best-of-N uses a fixed Sonnet+Opus rotation per candidate; the tier-policy
    // flags are intentionally not applied (ensemble diversity is the point).
    // Reject rather than silently ignore (best-of.md preamble).
    if (o.mode === "best_of" && (o.tierCap || o.tierFloor || o.noTierPolicy)) {
      return {
        run_id: "",
        status: "aborted",
        stages: [],
        abort_reason:
          "best-of-N uses a fixed Sonnet+Opus rotation per candidate slot; the " +
          "--tier-cap/--tier-floor/--no-tier-policy flags are intentionally not applied. " +
          "Re-run without the flag, or use mode=single/team for tier control.",
      };
    }

    // ── Phase 2 (early): profile bootstrap, before startRun snapshots it. ────
    // The heuristic scope + a written profile.yaml must exist before start_run
    // so the run row snapshots them. Neither step needs a run_id.
    bootstrapProfile(o.projectPath, o.requestText);
    const heuristic = heuristicTriage({ request_text: o.requestText });
    const scope: Scope = o.scopeOverride ?? heuristic.scope;

    // ── Phase 3: start run (acquires the project lock, snapshots profile). ───
    // Persist the per-run CLI/override flags to runs.cli_flags_json so replays
    // can reconstruct them. Empty → null (no behavioral change for flagless runs).
    const started = await startRun({
      request_text: o.requestText,
      project_path: o.projectPath,
      mode: o.mode,
      team: o.team,
      forum: o.forum,
      n: o.n,
      cli_flags: buildCliFlags(o),
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
      smokeDecision: o.smokeDecision,
      scope,
      signals: heuristic.signals,
      sections: [],
      missabilityRequired: [],
      profile: null,
      team: undefined,
      stageArtifacts: [],
      tierTrace: [],
      finalStatus: "complete",
    };

    emit(ctx, "run.started", { mode: o.mode, scope, project_path: o.projectPath, request: o.requestText });

    const stages: StageReport[] = [];
    try {
      // ── Phases 1/2/4: triage refinement, profile snapshot, taxonomy. ───────
      await phaseTimer(ctx, "triage", () => runTriagePhase(ctx, o.scopeOverride));
      await phaseTimer(ctx, "profile", () => {
        runProfilePhase(ctx);
        // Assemble the effective-ladder override now that the profile is resolved:
        // per-run request override (highest) merged OVER the profile's ladder /
        // tier_pools. Threaded through every tier resolution in the stage loop.
        ctx.ladderOverride = mergeLadderOverride(
          ctx.profile?.ladder,
          ctx.profile?.tier_pools,
          o.ladderOverride,
          o.tierPoolsOverride,
        );
      });
      await phaseTimer(ctx, "taxonomy", () => runTaxonomyPhase(ctx));

      // ── Phase 5: ensure AGENTS.md + taxonomy blueprint + seed tier_decisions.
      ensureAgentsAndClaudeMd(ctx.projectPath);
      ensureTaxonomyBlueprint(ctx.projectPath);
      reArchiveTierDecisions(ctx);

      // ── Phase 6: build the stage set and run it. ───────────────────────────
      const rawPlan = buildStagePlan(ctx, { stagesOverride: this.opts.stagesOverride });
      // Team-mode plans are reconciled against the taxonomy/profile's
      // required artifact kinds BEFORE persistence — a team pipeline with no
      // stage capable of producing a required artifact would otherwise be
      // structurally unable to reach 'complete' (VG-2 fails deterministically
      // hours later). Other modes (single/best_of/review) keep their
      // existing, narrower stage sets untouched.
      const plan =
        !rawPlan.abort && ctx.mode === "team"
          ? reconcilePlanWithRequirements(ctx, rawPlan.stages)
          : rawPlan;
      if (plan.abort) {
        ctx.finalStatus = "aborted";
        ctx.abortReason = plan.reason;
      } else {
        // Stamp each stage with its slot index in the persisted plan BEFORE
        // execution starts, so startStage/startBestOfStage can record
        // stages.plan_index — a resume needs this to compute "first plan
        // slot with no stage row" rather than guessing from `kind` alone.
        plan.stages.forEach((s, i) => { s.planIndex = i; });
        persistStagePlan(ctx.run_id, plan.stages);
        await phaseTimer(ctx, "stage_loop", async () => {
          for (const stage of plan.stages) {
            if (ctx.signal?.aborted) {
              ctx.finalStatus = "aborted";
              ctx.abortReason = "aborted by signal";
              break;
            }
            const outcome = await dispatchStage(ctx, stage);
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
        });
      }

      // ── Phases 7/8: missability + master-plan (complete path only). ────────
      if (ctx.finalStatus === "complete") {
        const missability = await phaseTimer(ctx, "missability", () => runMissabilityPhase(ctx));
        if (missability.passed) {
          await phaseTimer(ctx, "master_plan", () => runMasterPlanPhase(ctx));
        }
      }

      // ── Phase 9: finalize (+ autogenesis). ─────────────────────────────────
      await phaseTimer(ctx, "finalize", () => runFinalizePhase(ctx, stages));
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
}

/**
 * Build the ordered stage set for a run's mode + scope. Extracted from
 * RunPilot as a standalone, exported function (not a private method) so a
 * later resume (or legacy-run plan reconstruction) can re-invoke the same
 * planning logic without a live RunPilot instance — it only needs the
 * RunContext fields already populated by triage/profile/taxonomy, plus an
 * optional stagesOverride (the test/server seam).
 */
export function buildStagePlan(
  ctx: RunContext,
  opts: { stagesOverride?: StageSpec[] } = {},
): { abort: false; stages: StageSpec[] } | { abort: true; reason: string } {
  // Explicit override wins (test/server seam).
  if (opts.stagesOverride && opts.stagesOverride.length > 0) {
    return { abort: false, stages: opts.stagesOverride };
  }

  // best_of mode: a code request raced across N Claude candidates.
  if (ctx.mode === "best_of") {
    return {
      abort: false,
      stages: [{ kind: "code", gate_type: "code_style", agent: "engineer", bestOf: ctx.n ?? 3 }],
    };
  }

  // review mode: drive one of the governance forums' stage sets generically.
  if (ctx.mode === "review") {
    if (!ctx.forum) return { abort: true, reason: "mode=review requires a forum name" };
    const forum = getForum(ctx.forum);
    if (!forum) return { abort: true, reason: `forum "${ctx.forum}" not found` };
    if (forum.required_missability_checks?.length) {
      ctx.missabilityRequired = [...new Set([...ctx.missabilityRequired, ...forum.required_missability_checks])];
    }
    emit(ctx, "run.context", { phase: "forum", forum: forum.id, produces: forum.produces });
    return { abort: false, stages: forumStages(forum) };
  }

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
      // Deterministic team suggestion — best-effort, never blocks the abort.
      let suggestion = "";
      try {
        const top = recommendTeams({
          request_text: ctx.requestText,
          project_path: ctx.projectPath,
          profile: ctx.profileName,
          scope: "major",
        }).recommendations[0];
        if (top) {
          suggestion = ` Suggested team: "${top.team}"${top.reasons[0] ? ` (${top.reasons[0]})` : ""}`;
        }
      } catch { /* recommendation is advisory only */ }
      return {
        abort: true,
        reason:
          "major-scope request in single mode — re-run with a team pipeline " +
          "(mode=team, e.g. feature-team). Refusing to force a major change through the single-stage path." +
          suggestion,
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

  // team mode → drive the team yaml's stage set generically.
  if (!ctx.teamName) {
    return { abort: true, reason: `mode=${ctx.mode} requires a team name` };
  }
  const found = getTeam({ name: ctx.teamName, project_path: ctx.projectPath });
  if (!found) {
    return { abort: true, reason: `team "${ctx.teamName}" not found` };
  }
  ctx.team = found.team;

  // Profile-compatibility check: warn (don't block) when the active profile
  // isn't in the team's profiles_compatible list.
  const compat = found.team.profiles_compatible;
  if (ctx.profileName && compat && compat.length > 0 && !compat.includes(ctx.profileName)) {
    emit(ctx, "run.context", {
      phase: "team-profile-warning",
      team: found.team.name,
      active_profile: ctx.profileName,
      profiles_compatible: compat,
      message: `profile "${ctx.profileName}" is not in ${found.team.name}.profiles_compatible — proceeding anyway`,
    });
  }

  // Merge the team's declared taxonomy + missability requirements into the run.
  if (found.team.missability_required?.length) {
    ctx.missabilityRequired = [...new Set([...ctx.missabilityRequired, ...found.team.missability_required])];
  }
  emit(ctx, "run.context", { phase: "team", team: found.team.name, taxonomy_required: found.team.taxonomy_required ?? [] });

  return { abort: false, stages: teamStages(found.team, ctx.scope) };
}

/**
 * Dispatch one planned stage to its execution path — browser-validation,
 * best-of-N candidate race, or the standard single-attempt stage loop.
 * Extracted from RunPilot.execute()'s inline switch so the resume flow can
 * dispatch a remaining plan slot identically, without a live RunPilot
 * instance.
 */
export async function dispatchStage(ctx: RunContext, stage: StageSpec): Promise<StageOutcome> {
  return stage.kind === "browser_validation"
    ? await runBrowserValidationStage(ctx, stage)
    : stage.bestOf && stage.bestOf >= 2
      ? await runBestOfStage(ctx, stage, stage.bestOf)
      : await runStage(ctx, stage);
}

/**
 * Map a team yaml's stages onto the pilot's StageSpec (generators are Path-A
 * Claude). A stage's `best_of_n_on_major_scope` promotes it to a best-of-N race
 * when triage classified the request as major.
 */
function teamStages(team: TeamSpec, scope: string): StageSpec[] {
  return team.stages.map((s) => ({
    kind: s.kind,
    gate_type: s.gate_type,
    agent: s.generator.agent,
    artifact_kind: s.artifact_kind,
    teamStageModelTier: s.generator.model_tier as ClaudeTier | undefined,
    rubricHint: s.judge?.rubric,
    judgeModelPref: s.judge?.model_pref,
    skills: s.skills,
    bestOf: scope === "major" && s.best_of_n_on_major_scope ? s.best_of_n_on_major_scope : undefined,
  }));
}

/**
 * Map a governance forum's stage set onto the pilot's StageSpec. Forum roles
 * are advisory/readonly and MUST NOT mutate the project tree, so every stage is
 * pinned to completion execution (the artifact is written under .harness only).
 */
function forumStages(forum: Forum): StageSpec[] {
  return forum.stages.map((s) => ({
    kind: s.kind,
    gate_type: s.gate_type,
    agent: s.generator_agent,
    artifact_kind: s.artifact_kind ?? s.kind,
    rubricHint: s.rubric_id,
    execution: "completion" as const,
  }));
}

/**
 * Bootstrap a profile.yaml when the project has none and detection is
 * confident. Mirrors runProfilePhase but runs BEFORE start_run so the run row
 * snapshots the written profile. Best-effort — generic mode on any failure.
 */
function bootstrapProfile(projectPath: string, requestText?: string): void {
  try {
    if (loadProjectProfile(projectPath)) return;
    const detection = detectProfile(projectPath, { requestText });
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

/**
 * Assemble the per-run CLI/override flags persisted to runs.cli_flags_json.
 * Only non-default fields are included; an empty object collapses to null so a
 * flagless run leaves the column NULL (byte-identical to prior behavior).
 */
function buildCliFlags(o: RunPilotOptions): Record<string, unknown> | null {
  const flags: Record<string, unknown> = {};
  if (o.tierCap) flags.tier_cap = o.tierCap;
  if (o.tierFloor) flags.tier_floor = o.tierFloor;
  if (o.noTierPolicy) flags.no_tier_policy = true;
  if (o.ladderOverride && Object.keys(o.ladderOverride).length > 0) {
    flags.ladder_override = o.ladderOverride;
  }
  if (o.tierPoolsOverride && Object.keys(o.tierPoolsOverride).length > 0) {
    flags.tier_pools_override = o.tierPoolsOverride;
  }
  return Object.keys(flags).length > 0 ? flags : null;
}

/**
 * Wrap a synchronous or asynchronous phase function with wall-clock timing.
 * Always returns a Promise so callers can uniformly `await` it. On completion
 * emits a "phase.completed" bus event and persists a phases row via
 * recordPhaseTiming. Non-fatal: a DB/emit failure is caught so the pilot
 * can never be killed by an observability write.
 */
async function phaseTimer<T>(
  ctx: RunContext,
  phase: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const startMs = Date.now();
  const started_at = new Date(startMs).toISOString();
  const result = await fn();
  const finishMs = Date.now();
  const wall_ms = finishMs - startMs;
  const finished_at = new Date(finishMs).toISOString();
  try {
    emit(ctx, "phase.completed", { phase, wall_ms });
    recordPhaseTiming({ run_id: ctx.run_id, phase, started_at, finished_at, wall_ms });
  } catch {
    // observability writes must never crash the pilot
  }
  return result;
}

export { EventBus };
