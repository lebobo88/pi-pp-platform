/**
 * Phase 6 — the stage loop.
 *
 * Per stage: start → gate/tier resolve → generate (per execution mode) →
 * record attempt → judge → verdict → on pass drive finalize readiness; on
 * fail/revise run Reflexion ×1 with a +1 tier escalation and an escalated
 * judge, then finalize or surface. A judge tool failure (invalid critique or an
 * empty judge pool) halts the run — surface the stage, abort the run, never
 * fabricate a verdict.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  startStage,
  recordAttempt,
  recordVerdict,
  getStageFinalizeReadiness,
  finalizeStage,
  archiveArtifact,
  checkRetryEligible,
  getRubric,
  runTddCheck,
  runArtifactValidator,
  type GateType,
  type Profile,
  type VerdictOutcome,
  type ClaudeTier,
} from "@pp/core";
import { loadRolePrompt, renderSystemPrompt } from "../prompts/loader.js";
import { resolveTier, escalateTierForRetry } from "../tier-resolver.js";
import { JudgeUnavailableError } from "../errors.js";
import { profileSummary } from "./profile.js";
import { emit, type RunContext, type StageSpec, type StageOutcome } from "../types.js";

const FALLBACK_RUBRIC =
  "Evaluate the artifact for correctness, completeness, and minimality. " +
  "Score each dimension in [0,1]; pass requires every dimension >= 0.7.";

/** taxonomy section per default stage kind, for artifact archival. */
const SECTION_BY_KIND: Record<string, string> = {
  spec: "4.3",
  code: "4.8",
  tests: "4.10",
  docs: "4.13",
  architecture: "4.6",
  contracts: "4.7",
};

/** Default archived artifact kind per stage kind (single-mode pipeline). */
const ARTIFACT_KIND_BY_KIND: Record<string, string> = {
  spec: "spec",
  docs: "changelog",
  tests: "test_plan",
  architecture: "adr",
  contracts: "openapi",
};

function gitDiffHead(cwd: string): string | null {
  try {
    return execFileSync("git", ["show", "--stat", "--patch", "HEAD"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** Drives one stage to a terminal outcome. */
export async function runStage(ctx: RunContext, stage: StageSpec): Promise<StageOutcome> {
  ctx.signal?.throwIfAborted();
  const { stage_id } = startStage({ run_id: ctx.run_id, kind: stage.kind, gate_type: stage.gate_type });
  emit(ctx, "stage.started", { kind: stage.kind, gate_type: stage.gate_type, agent: stage.agent }, { stage_id });

  // Resolve the Claude tier for this stage (generators are always Path-A Claude).
  const resolution = resolveTier({
    agent: stage.agent,
    stageKind: stage.kind,
    scope: ctx.scope,
    teamStageModelTier: stage.teamStageModelTier,
    profilePolicy: ctx.profile?.model_tier_policy ?? null,
    flags: ctx.flags,
  });
  recordTierTrace(ctx, stage, resolution.tier, resolution.model_id, resolution.trace);

  // ── Attempt 0: generate → judge ──────────────────────────────────────────
  const gen0 = await generate(ctx, stage, stage_id, resolution.model_id, resolution.tier, 0, undefined, []);
  const judged0 = await judge(ctx, stage, stage_id, gen0.attempt_id, resolution.model_id, gen0.artifactText, false);
  if (judged0 === "abort") return abortStage(ctx, stage_id, "judge tool failure");

  if (judged0.outcome === "pass") {
    const settled = await driveReadiness(ctx, stage, stage_id, gen0.attempt_id);
    if (settled.action === "finalize") return finalizePassed(ctx, stage, stage_id, gen0.attempt_id);
    if (settled.action === "surface") return surface(ctx, stage_id, settled.reason);
    // action === "retry": fall through to Reflexion using the blocker message.
    return reflexion(ctx, stage, stage_id, gen0.attempt_id, resolution.tier, settled.critique);
  }

  // fail / revise → Reflexion ×1.
  return reflexion(ctx, stage, stage_id, gen0.attempt_id, resolution.tier, judged0.critique_md);
}

// ── generation ───────────────────────────────────────────────────────────────

type GenOut = { attempt_id: string; artifactText: string };

async function generate(
  ctx: RunContext,
  stage: StageSpec,
  stage_id: string,
  modelId: string,
  tier: ClaudeTier,
  retryIndex: number,
  parentAttemptId: string | undefined,
  priorCritiques: string[],
): Promise<GenOut> {
  const role = loadRolePrompt(stage.agent);
  const systemPrompt = renderSystemPrompt(role, {
    profileSummary: profileSummary(ctx),
    profileName: ctx.profileName,
    priorCritiques,
    requestText: ctx.requestText,
  });
  const model = ctx.engine.catalog.resolve("anthropic", modelId);
  const sessionDir = join(ctx.artifact_dir, stage.kind);
  mkdirSync(sessionDir, { recursive: true });

  emit(ctx, "attempt.started", { agent: stage.agent, model: modelId, tier, retry_index: retryIndex }, { stage_id });

  // A tests_pre stage must produce a `tdd_manifest` artifact (YAML), which the
  // TDD gate loads to run the red/green check — always a completion, even
  // though test-strategist is otherwise a coding role.
  const isTddManifestStage = stage.kind === "tests_pre";
  const execution = isTddManifestStage ? "completion" : stage.execution ?? role.execution;

  let artifactText: string;
  let artifactPath: string;
  let genResult;

  if (execution === "session-coding" || execution === "session-readonly") {
    genResult = await ctx.engine.runCodingSession({
      cwd: ctx.projectPath,
      systemPrompt,
      taskPrompt: ctx.requestText,
      model,
      sessionDir,
      toolPolicy: role.execution === "session-readonly" ? "readonly" : "coding",
      role: stage.agent,
      attempt: retryIndex,
      signal: ctx.signal,
    });
    artifactText = gitDiffHead(ctx.projectPath) ?? genResult.text;
    artifactPath = `${stage.kind}/ (commit ${genResult.session_id ?? "n/a"})`;
  } else {
    genResult = await ctx.engine.runAuthoringCompletion({
      model,
      systemPrompt,
      userPrompt: ctx.requestText,
      signal: ctx.signal,
    });
    artifactText = genResult.text;
    const kind = isTddManifestStage
      ? "tdd_manifest"
      : stage.artifact_kind ?? ARTIFACT_KIND_BY_KIND[stage.kind] ?? stage.kind;
    const ext = isTddManifestStage ? "yaml" : "md";
    const rel = `${stage.kind}/${stage.agent}${retryIndex > 0 ? `-retry${retryIndex}` : ""}.${ext}`;
    const res = archiveArtifact({
      run_id: ctx.run_id,
      // Tie completion artifacts to the stage so the run-level artifact
      // availability gate (VG-2), which INNER-JOINs artifacts→stages, counts
      // them. Safe: VG-5's smoke gate only fires on `code`/`diff` kinds.
      stage_id,
      taxonomy_section: SECTION_BY_KIND[stage.kind],
      kind,
      relative_path: rel,
      bytes: artifactText,
    });
    artifactPath = res.status === "ok" ? res.absolute_path : rel;
  }

  const attempt = recordAttempt({
    stage_id,
    producer: "claude",
    model_id: modelId,
    artifact_path: artifactPath,
    tokens_in: genResult.tokens_in,
    tokens_out: genResult.tokens_out,
    cost_usd: genResult.cost_usd,
    wall_ms: genResult.wall_ms,
    retry_index: retryIndex,
    parent_attempt_id: parentAttemptId,
    status: "ok",
    attempted_tier: tier,
    agent_type: stage.agent,
  });

  emit(
    ctx,
    "attempt.completed",
    { model: modelId, tokens_in: genResult.tokens_in, tokens_out: genResult.tokens_out, cost_usd: genResult.cost_usd },
    { stage_id, attempt_id: attempt.attempt_id },
  );

  return { attempt_id: attempt.attempt_id, artifactText };
}

// ── judging ────────────────────────────────────────────────────────────────

type JudgeOut = { outcome: VerdictOutcome; critique_md: string } | "abort";

async function judge(
  ctx: RunContext,
  stage: StageSpec,
  stage_id: string,
  attempt_id: string,
  generatorModel: string,
  artifactText: string,
  retry: boolean,
): Promise<JudgeOut> {
  let selection;
  try {
    selection = ctx.judgePolicy.select(ctx.run_id, {
      gateType: stage.gate_type as GateType,
      generatorProducer: "claude",
      generatorModel,
      promptKeywords: ctx.requestText,
      profile: (ctx.profileName as Profile | undefined) ?? null,
      artifactKind: stage.artifact_kind ?? null,
      rubricHint: stage.rubricHint ?? null,
      retry,
    });
  } catch (err) {
    if (err instanceof JudgeUnavailableError) {
      archiveCritiqueFailure(ctx, stage_id, { reason: err.message, kind: "judge_pool_empty" });
      emit(ctx, "gate.blocked", { reason: err.message, gate_type: stage.gate_type }, { stage_id });
      return "abort";
    }
    throw err;
  }

  const rubricMd = (selection.rubric_id ? getRubric(selection.rubric_id)?.markdown : null) ?? FALLBACK_RUBRIC;
  const judgeModel = ctx.engine.catalog.resolve(selection.provider, selection.judge_model);

  const critiqueRes = await ctx.engine.critique({
    judgeModel,
    rubricMd,
    artifactText,
    cwd: ctx.projectPath,
    signal: ctx.signal,
  });

  // Judge tool failure: the critique never validated (invalid_output sentinel).
  // Never fabricate a verdict — halt.
  if (critiqueRes.stop_reason === "invalid_output" || !critiqueRes.parsed) {
    archiveCritiqueFailure(ctx, stage_id, {
      reason: `judge critique failed to validate (stop_reason=${critiqueRes.stop_reason})`,
      kind: "critique_invalid",
      failure_archive_path: critiqueRes.session_file,
    });
    emit(ctx, "gate.blocked", { reason: "critique invalid_output", judge_model: selection.judge_model }, { stage_id });
    return "abort";
  }

  const verdict = critiqueRes.parsed as { outcome: VerdictOutcome; critique_md?: string; score?: unknown };
  const rec = recordVerdict({
    attempt_id,
    judge_producer: selection.judge_producer,
    judge_model_id: selection.judge_model,
    rubric_id: selection.rubric_id ?? undefined,
    outcome: verdict.outcome,
    critique_md: verdict.critique_md,
    score_json: verdict.score ?? critiqueRes.parsed,
  });
  emit(
    ctx,
    "verdict.recorded",
    {
      outcome: verdict.outcome,
      judge_producer: selection.judge_producer,
      judge_model: selection.judge_model,
      cross_vendor: rec.cross_vendor,
      escalated: selection.escalated,
      rubric_id: selection.rubric_id,
    },
    { stage_id, attempt_id },
  );

  return { outcome: verdict.outcome, critique_md: verdict.critique_md ?? "" };
}

// ── readiness / finalize ─────────────────────────────────────────────────────

type ReadinessSettled =
  | { action: "finalize" }
  | { action: "retry"; critique: string }
  | { action: "surface"; reason: string };

async function driveReadiness(
  ctx: RunContext,
  stage: StageSpec,
  stage_id: string,
  winnerAttemptId: string,
): Promise<ReadinessSettled> {
  for (let i = 0; i < 4; i++) {
    const r = getStageFinalizeReadiness(stage_id, winnerAttemptId);
    switch (r.next_action) {
      case "finalize_passed":
        return { action: "finalize" };
      case "run_tdd_pre_check":
        await runTddCheck({ stage_id, phase: "pre" });
        continue;
      case "run_tdd_post_check":
        await runTddCheck({ stage_id, phase: "post" });
        continue;
      case "run_artifact_validate": {
        const blk = r.blockers.find((b) => b.gate === "artifact_validation");
        if (blk && blk.gate === "artifact_validation") {
          await runArtifactValidator({
            stage_id,
            kind: blk.validator_kind,
            artifact_path: blk.artifact_path,
          });
        }
        continue;
      }
      case "retry_with_critique":
      case "retry_or_surface":
        return { action: "retry", critique: r.blockers[0]?.message ?? r.summary };
      default:
        // surface_stage / dispatch_cross_vendor_rejudge / record_smoke_or_assertion
        return { action: "surface", reason: r.summary };
    }
  }
  return { action: "surface", reason: "finalize readiness did not converge after running required gates" };
}

async function finalizePassed(
  ctx: RunContext,
  stage: StageSpec,
  stage_id: string,
  winnerAttemptId: string,
): Promise<StageOutcome> {
  await finalizeStage({ stage_id, winner_attempt_id: winnerAttemptId, status: "passed" });
  emit(ctx, "stage.finalized", { status: "passed", winner_attempt_id: winnerAttemptId }, { stage_id });

  // VG-2 needs a run-wide `diff` artifact (counted via an artifacts→stages
  // join) to finalize the run as complete. The change lives in a git commit,
  // so archive the diff AFTER finalize_stage(passed): the code stage's VG-5
  // smoke gate was already evaluated (with no code/diff artifact present, so it
  // passed), and tying the diff to the stage now lets VG-2 count it without
  // retriggering VG-5. Best-effort; a missing diff simply lets VG-2 surface.
  if (stage.kind === "code") {
    const diff = gitDiffHead(ctx.projectPath);
    if (diff) {
      archiveArtifact({
        run_id: ctx.run_id,
        stage_id,
        taxonomy_section: "4.8",
        kind: "diff",
        relative_path: `code/diff-${stage_id}.patch`,
        bytes: diff,
      });
    }
  }
  return "passed";
}

async function surface(ctx: RunContext, stage_id: string, reason: string): Promise<StageOutcome> {
  await finalizeStage({ stage_id, status: "surfaced" });
  emit(ctx, "stage.surfaced", { reason }, { stage_id });
  return "surfaced";
}

async function abortStage(ctx: RunContext, stage_id: string, reason: string): Promise<StageOutcome> {
  await finalizeStage({ stage_id, status: "surfaced" });
  emit(ctx, "stage.surfaced", { reason, aborting_run: true }, { stage_id });
  ctx.abortReason = reason;
  return "aborted";
}

// ── Reflexion ×1 ──────────────────────────────────────────────────────────────

async function reflexion(
  ctx: RunContext,
  stage: StageSpec,
  stage_id: string,
  parentAttemptId: string,
  initialTier: ClaudeTier,
  critique: string,
): Promise<StageOutcome> {
  const eligible = checkRetryEligible({ attempt_id: parentAttemptId, budget_override: false });
  if (!eligible.ok) {
    return surface(ctx, stage_id, `Reflexion not eligible: ${eligible.reason}`);
  }

  const esc = escalateTierForRetry(initialTier, ctx.flags, "retry");
  ctx.tierTrace.push({
    stage_kind: stage.kind,
    agent: stage.agent,
    initial_tier: initialTier,
    model_id: esc.model_id,
    trace: [esc.trace],
  });
  reArchiveTierDecisions(ctx);
  emit(ctx, "reflexion.retry", { initial_tier: initialTier, retry_tier: esc.tier, critique_excerpt: critique.slice(0, 240) }, { stage_id });

  const gen1 = await generate(ctx, stage, stage_id, esc.model_id, esc.tier, 1, parentAttemptId, [critique]);
  const judged1 = await judge(ctx, stage, stage_id, gen1.attempt_id, esc.model_id, gen1.artifactText, true);
  if (judged1 === "abort") return abortStage(ctx, stage_id, "judge tool failure on retry");

  if (judged1.outcome === "pass") {
    const settled = await driveReadiness(ctx, stage, stage_id, gen1.attempt_id);
    if (settled.action === "finalize") return finalizePassed(ctx, stage, stage_id, gen1.attempt_id);
    return surface(ctx, stage_id, settled.action === "surface" ? settled.reason : "retry still blocked by finalize readiness");
  }

  // Second failure: the daemon rejects a third generator call — surface + break.
  return surface(ctx, stage_id, `stage still ${judged1.outcome} after Reflexion ×1`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function recordTierTrace(
  ctx: RunContext,
  stage: StageSpec,
  tier: ClaudeTier,
  modelId: string,
  trace: RunContext["tierTrace"][number]["trace"],
): void {
  ctx.tierTrace.push({ stage_kind: stage.kind, agent: stage.agent, initial_tier: tier, model_id: modelId, trace });
  emit(ctx, "run.context", { phase: "tier-resolve", stage_kind: stage.kind, tier, model_id: modelId });
}

/** (Re)archive the accumulated tier decisions as tier_decisions.json. */
export function reArchiveTierDecisions(ctx: RunContext): void {
  const payload = {
    cli_flags: ctx.flags,
    profile_policy: ctx.profile?.model_tier_policy ?? null,
    per_stage: ctx.tierTrace,
  };
  archiveArtifact({
    run_id: ctx.run_id,
    taxonomy_section: "4.14",
    kind: "tier_decisions",
    relative_path: "tier_decisions.json",
    bytes: JSON.stringify(payload, null, 2),
    force_overwrite: true,
  });
}

function archiveCritiqueFailure(
  ctx: RunContext,
  stage_id: string,
  payload: Record<string, unknown>,
): void {
  archiveArtifact({
    run_id: ctx.run_id,
    stage_id,
    kind: "critique_failure",
    taxonomy_section: "4.14",
    relative_path: `critique_failures/${stage_id}.json`,
    bytes: JSON.stringify({ stage_id, ...payload }, null, 2),
    force_overwrite: true,
  });
}
