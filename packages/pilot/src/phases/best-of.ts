/**
 * Best-of-N stage: parallel Claude candidates → smoke → diff-entropy → Borda →
 * smoke post-filter → merge-back → teardown.
 *
 * Every candidate authors code in its own git worktree (created by core
 * startBestOfStage). Model + seed rotate per slot for ensemble diversity
 * (best-of.md step 6): sonnet/primary, opus/primary, sonnet/devils-advocate,
 * then cycling. Tier-policy flags are intentionally NOT honored here (the
 * caller rejects them upfront). We judge each candidate for a rubric score
 * (cross-vendor — all candidates are Claude), Borda-pick, apply the smoke
 * post-filter (walk the ranking past any smoke-failed winner), record a single
 * pass verdict on the winner, finalize, merge the winner's worktree back, and
 * tear the candidates down.
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  startBestOfStage,
  recordAttempt,
  recordAgentSession,
  recordVerdict,
  tallyJudgeUsage,
  recordSmokeStatus,
  diffEntropy,
  bordaCount,
  archiveWinnerAndLosers,
  teardownCandidates,
  finalizeStage,
  getStageFinalizeReadiness,
  getRubric,
  resolveVerdict,
  type GateType,
  type Profile,
  type ClaudeTier,
} from "@pp/core";
import { providerForModel, hasCredential, providersWithCredential } from "@pp/engine";
import { generationModelIdForTier } from "../generation-model.js";
import { loadRolePrompt, renderSystemPrompt, loadAgentsMdForPrompt } from "../prompts/loader.js";
import { selectStageSkills, gitHeadSha, gitDiffRange, gitAutoCommitIfDirty, makeOutputStreamer } from "./stage-loop.js";
import { JudgeUnavailableError } from "../errors.js";
import { profileSummary } from "./profile.js";
import { emit, type RunContext, type StageSpec, type StageOutcome } from "../types.js";

const FALLBACK_RUBRIC =
  "Evaluate the candidate for correctness, completeness, and minimality. " +
  "Score each dimension in [0,1].";

/** Fixed Sonnet+Opus / seed rotation per candidate slot (best-of.md step 6). */
const ROTATION: Array<{ tier: ClaudeTier; seed: string }> = [
  { tier: "sonnet", seed: "primary" },
  { tier: "opus", seed: "primary" },
  { tier: "sonnet", seed: "devils-advocate" },
  { tier: "opus", seed: "terse-diff" },
  { tier: "sonnet", seed: "failing-test-first" },
  { tier: "opus", seed: "primary" },
  { tier: "sonnet", seed: "primary" },
  { tier: "opus", seed: "devils-advocate" },
];

function rotationFor(candidateIndex: number): { tier: ClaudeTier; seed: string; model_id: string } {
  const slot = ROTATION[(candidateIndex - 1) % ROTATION.length]!;
  // rotationIndex=candidateIndex so candidates draw distinct models from the
  // tier's pool (when configured); with no pool the single-model id is used and
  // behavior is unchanged.
  return { tier: slot.tier, seed: slot.seed, model_id: generationModelIdForTier(slot.tier, candidateIndex) };
}

/** Average of a critique verdict's numeric score entries (0 when absent). */
function scoreOf(parsed: unknown): number {
  const score = (parsed as { score?: Record<string, number> } | undefined)?.score;
  if (!score || typeof score !== "object") return 0;
  const vals = Object.values(score).filter((v) => typeof v === "number");
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

type Cand = {
  index: number;
  attempt_id: string;
  text: string;
  tier: ClaudeTier;
  seed: string;
  smoke: "pass" | "fail" | "infra_error" | "skipped";
};

export async function runBestOfStage(ctx: RunContext, stage: StageSpec, n: number): Promise<StageOutcome> {
  ctx.signal?.throwIfAborted();

  // startBestOfStage enforces the cross-vendor precondition (a non-Claude
  // vendor must be reachable) and provisions the candidate worktrees. If it
  // throws (no judge vendor), let it bubble → the run aborts with the reason.
  const { stage_id, candidates, shuffle_seed } = await startBestOfStage({
    run_id: ctx.run_id,
    kind: stage.kind,
    gate_type: stage.gate_type,
    n,
  });
  emit(ctx, "stage.started", { kind: stage.kind, gate_type: stage.gate_type, agent: stage.agent, best_of: n, shuffle_seed }, { stage_id });

  const role = loadRolePrompt(stage.agent, { projectPath: ctx.projectPath });

  // Skill injection (A1b): same selection + budgeting as the single-attempt
  // stage loop, so a stage with skills promoted to best-of keeps them. Selected
  // once per stage (every candidate gets the identical skills block); the
  // observability event fires once per stage, not per candidate.
  const skills = selectStageSkills(ctx, stage);
  if (skills.injected.length > 0 || skills.skipped.length > 0) {
    emit(ctx, "run.context", {
      phase: "skills",
      stage_kind: stage.kind,
      injected: skills.injected.map((s) => s.id),
      skipped: skills.skipped,
    });
  }

  // ── Generate every candidate (each in its own worktree, rotated model/seed).
  const cand: Cand[] = [];
  for (const c of candidates) {
    ctx.signal?.throwIfAborted();
    const rot = rotationFor(c.candidate_index);
    const sessionDir = join(ctx.artifact_dir, stage.kind, `candidate-${c.candidate_index}`);
    mkdirSync(sessionDir, { recursive: true });
    // Candidate slots are pre-minted by startBestOfStage (c.attempt_slot_id) and
    // passed verbatim to record_attempt below, so attempt.started, the live
    // output stream, and the persisted row all key on the same id.
    emit(
      ctx,
      "attempt.started",
      { candidate_index: c.candidate_index, model: rot.model_id, tier: rot.tier, seed: rot.seed, judge_position: c.judge_position, provider: providerForModel(rot.model_id) || undefined },
      { stage_id, attempt_id: c.attempt_slot_id },
    );

    const systemPrompt = renderSystemPrompt(role, {
      profileSummary: profileSummary(ctx),
      profileName: ctx.profileName,
      requestText: ctx.requestText,
      execution: "session-coding",
      skills: skills.injected.map((s) => ({ name: s.name, body: s.body })),
      upstreamArtifacts: ctx.stageArtifacts.map((a) => ({ kind: a.kind, text: a.text })),
      agentsMd: loadAgentsMdForPrompt(ctx.projectPath) ?? undefined,
    });
    const genProvider = providerForModel(rot.model_id);
    if (!genProvider) {
      console.warn(`[pp/pilot best-of] providerForModel returned no provider for model "${rot.model_id}"; candidate attempt will persist provider=NULL and omit provider from SSE frames`);
    }
    if (ctx.engine.mode === "pi" && !hasCredential(ctx.engine.authStorage, genProvider)) {
      throw new Error(
        `generation model "${rot.model_id}" requires a key for provider "${genProvider}", which is not configured. ` +
          `Add a key in Providers, or point your generation ladder at a keyed provider.`,
      );
    }
    const model = ctx.engine.catalog.resolve(genProvider, rot.model_id);
    const baseSha = gitHeadSha(c.worktree_path);
    // Live-stream this candidate's incremental output keyed on its slot id.
    const streamer = makeOutputStreamer(ctx, stage_id, c.attempt_slot_id);
    const gen = await ctx.engine.runCodingSession({
      cwd: c.worktree_path,
      systemPrompt,
      taskPrompt: `${ctx.requestText}\n\n[diversification seed: ${rot.seed}]`,
      model,
      sessionDir,
      toolPolicy: "coding",
      role: stage.agent,
      attempt: c.candidate_index,
      signal: ctx.signal,
      onOutputDelta: (chunk) => streamer.push(chunk),
    });
    streamer.flush();

    const attempt = recordAttempt({
      stage_id,
      producer: "claude",
      model_id: rot.model_id,
      artifact_path: `${stage.kind}/candidate-${c.candidate_index}/`,
      tokens_in: gen.tokens_in,
      tokens_out: gen.tokens_out,
      cost_usd: gen.cost_usd,
      wall_ms: gen.wall_ms,
      status: "ok",
      attempted_tier: rot.tier,
      agent_type: stage.agent,
      attempt_slot_id: c.attempt_slot_id,
      notes: { candidate_index: c.candidate_index },
      provider: genProvider || undefined,
    });

    if (gen.session_file) {
      recordAgentSession({
        run_id: ctx.run_id,
        attempt_id: attempt.attempt_id,
        role: stage.agent,
        provider: gen.provider,
        model_id: rot.model_id,
        session_file: gen.session_file,
      });
    }

    // Runtime smoke: injectable for tests; a real engineer records the true
    // result. VG-5 needs the WINNER's candidate smoke to be 'pass'.
    const smoke = ctx.smokeDecision ? ctx.smokeDecision(c.candidate_index) : "pass";
    recordSmokeStatus({ stage_id, candidate_index: c.candidate_index, status: smoke });
    emit(ctx, "smoke.status", { candidate_index: c.candidate_index, status: smoke }, { stage_id, attempt_id: attempt.attempt_id });

    // Harness-side commit + attempt-scoped diff (baseSha..HEAD): a candidate
    // that wrote nothing yields empty text and loses on merit, instead of the
    // judge being handed the worktree's pre-existing HEAD commit.
    gitAutoCommitIfDirty(c.worktree_path, `pp ${ctx.run_id} ${stage.kind} candidate ${c.candidate_index}`);
    const rangeDiff = gitDiffRange(c.worktree_path, baseSha);
    cand.push({
      index: c.candidate_index,
      attempt_id: attempt.attempt_id,
      text: rangeDiff && rangeDiff.trim().length > 0 ? rangeDiff : gen.text,
      tier: rot.tier,
      seed: rot.seed,
      smoke,
    });
  }

  // ── Diff entropy (low-diversity warning event when > 0.9). ────────────────
  const entropy = diffEntropy({ candidate_texts: cand.map((c) => c.text) });
  emit(ctx, "borda.updated", { phase: "entropy", max_similarity: entropy.max_similarity, warning: entropy.warning }, { stage_id });

  // ── Judge each candidate for a score (cross-vendor), then Borda-pick. ─────
  let selection;
  try {
    const genModelId = generationModelIdForTier("sonnet");
    selection = ctx.judgePolicy.select(ctx.run_id, {
      gateType: stage.gate_type as GateType,
      generatorProducer: "claude",
      generatorProvider: providerForModel(genModelId),
      keyedProviders:
        ctx.engine.mode === "pi" ? providersWithCredential(ctx.engine.authStorage) : undefined,
      generatorModel: genModelId,
      promptKeywords: ctx.requestText,
      profile: (ctx.profileName as Profile | undefined) ?? null,
      artifactKind: stage.artifact_kind ?? null,
      rubricHint: stage.rubricHint ?? null,
      forceCrossVendor: true,
    });
  } catch (err) {
    if (err instanceof JudgeUnavailableError) {
      await finalizeStage({ stage_id, status: "surfaced" });
      emit(ctx, "stage.surfaced", { reason: err.message, aborting_run: true }, { stage_id });
      ctx.abortReason = err.message;
      return "aborted";
    }
    throw err;
  }
  const rubricMd = (selection.rubric_id ? getRubric(selection.rubric_id)?.markdown : null) ?? FALLBACK_RUBRIC;
  const judgeModel = ctx.engine.catalog.resolve(selection.provider, selection.judge_model);

  // Judge in the daemon-provided shuffled order (position-bias mitigation).
  const byPosition = [...cand].sort(
    (a, b) =>
      candidates.find((c) => c.candidate_index === a.index)!.judge_position -
      candidates.find((c) => c.candidate_index === b.index)!.judge_position,
  );
  // Per-candidate critique usage is captured here so the winner's spend rides
  // its recordVerdict call and each loser's spend is credited via tallyJudgeUsage.
  type JudgeUsage = { tokens_in?: number; tokens_out?: number; cost_usd?: number };
  const scored: Array<{ index: number; attempt_id: string; score: number; scoreMap: unknown; smoke: string; usage: JudgeUsage }> = [];
  for (const c of byPosition) {
    const critique = await ctx.engine.critique({ judgeModel, rubricMd, artifactText: c.text, cwd: ctx.projectPath, signal: ctx.signal });
    if (critique.stop_reason === "invalid_output" || !critique.parsed) {
      await finalizeStage({ stage_id, status: "surfaced" });
      emit(ctx, "stage.surfaced", { reason: "judge critique invalid_output on a candidate", aborting_run: true }, { stage_id });
      ctx.abortReason = "judge tool failure during best-of ranking";
      return "aborted";
    }
    scored.push({
      index: c.index,
      attempt_id: c.attempt_id,
      score: scoreOf(critique.parsed),
      // Keep the raw per-dimension map so the winner verdict can persist the
      // actual sanitized dimension scores used for derivation (finding B).
      scoreMap: (critique.parsed as { score?: unknown }).score,
      smoke: c.smoke,
      usage: { tokens_in: critique.tokens_in, tokens_out: critique.tokens_out, cost_usd: critique.cost_usd },
    });
  }

  const ranking = [...scored].sort((a, b) => b.score - a.score).map((s) => String(s.index));
  const borda = bordaCount({ candidate_ids: scored.map((s) => String(s.index)), rankings: [ranking] });
  const rubricWinnerIndex = Number(borda.winner);
  emit(ctx, "borda.updated", { phase: "winner", rubric_winner: rubricWinnerIndex, scores: borda.scores }, { stage_id });

  // ── Smoke post-filter (best-of.md step 9.5): walk the ranking past any
  //    smoke-failed winner; if none is clean, surface with no merge. ─────────
  const isClean = (s: string) => s === "pass" || s === "skipped" || s === "infra_error";
  const rankedByScore = [...scored].sort((a, b) => b.score - a.score);
  const cleanWinner = rankedByScore.find((s) => isClean(s.smoke));
  if (!cleanWinner) {
    await finalizeStage({ stage_id, status: "surfaced" });
    emit(ctx, "stage.surfaced", { reason: "all best-of candidates failed the runtime smoke test — no winner merged" }, { stage_id });
    return "surfaced";
  }
  if (cleanWinner.index !== rubricWinnerIndex) {
    emit(ctx, "borda.updated", { phase: "smoke-override", rubric_winner: rubricWinnerIndex, smoke_corrected_winner: cleanWinner.index }, { stage_id });
  }
  const winner = cleanWinner;
  const winnerIndex = winner.index;

  // Record a single verdict on the winner (the Borda selection is the passing
  // judgment). The outcome is derived deterministically from the winner's own
  // sanitized dimension scores (Borda "pass" is the advisory label); the
  // persisted score_json is that flat sanitized dimension map — NOT the borda
  // tally (finding B) — so the UI iterates real per-dimension scores. Borda
  // metadata is preserved in critique_md instead.
  const resolvedWinner = resolveVerdict({
    judge_outcome: "pass",
    scores: winner.scoreMap,
    critique_md:
      `Borda winner candidate-${winnerIndex} of ${n} (score ${winner.score.toFixed(3)}). ` +
      `[borda] ${JSON.stringify(borda.scores)}`,
  });
  recordVerdict({
    attempt_id: winner.attempt_id,
    judge_producer: selection.judge_producer,
    judge_model_id: selection.judge_model,
    rubric_id: selection.rubric_id ?? undefined,
    outcome: resolvedWinner.outcome,
    critique_md: resolvedWinner.critique_md,
    score_json: resolvedWinner.score_json,
    judge_provider: selection.provider || undefined,
    // The winner's critique spend rides its verdict row + budget scopes.
    tokens_in: winner.usage.tokens_in,
    tokens_out: winner.usage.tokens_out,
    cost_usd: winner.usage.cost_usd,
  });
  // Losing candidates have no verdict row, so credit their critique spend
  // directly to the run:/day:/model:<judge_model> budget scopes.
  for (const s of scored) {
    if (s.index !== winnerIndex) tallyJudgeUsage(ctx.run_id, selection.judge_model, s.usage);
  }
  emit(ctx, "verdict.recorded", { outcome: resolvedWinner.outcome, winner: winnerIndex, cross_vendor: selection.cross_vendor, judge_provider: selection.provider || undefined, ...(resolvedWinner.disagreed ? { judge_label: resolvedWinner.judge_label } : {}) }, { stage_id, attempt_id: winner.attempt_id });

  // ── Finalize + merge-back + teardown. ─────────────────────────────────────
  const readiness = getStageFinalizeReadiness(stage_id, winner.attempt_id);
  if (!readiness.can_pass) {
    await finalizeStage({ stage_id, status: "surfaced" });
    emit(ctx, "stage.surfaced", { reason: readiness.summary }, { stage_id });
    return "surfaced";
  }
  await finalizeStage({ stage_id, status: "passed", winner_attempt_id: winner.attempt_id });
  emit(ctx, "stage.finalized", { status: "passed", winner_attempt_id: winner.attempt_id, winner_index: winnerIndex }, { stage_id });

  const candidatePaths = candidates.map((c) => c.worktree_path);
  const merge = await archiveWinnerAndLosers({
    run_id: ctx.run_id,
    stage_id,
    stage_kind: stage.kind,
    winner_candidate_index: winnerIndex,
    candidate_paths: candidatePaths,
  });
  emit(ctx, "run.context", { phase: "best-of-merge", merge_status: merge.merge_status, losers_archived: merge.losers_archived }, { stage_id });

  await teardownCandidates({
    project_path: ctx.projectPath,
    candidate_paths: candidatePaths,
    run_id: ctx.run_id,
    stage_kind: stage.kind,
  });
  emit(ctx, "janitor.swept", { phase: "teardown", candidates: candidatePaths.length }, { stage_id });

  // A merge that couldn't land (conflict / empty / smoke_failed) surfaces the
  // stage even though a winner was chosen (best-of.md step 10).
  if (merge.merge_status === "conflict" || merge.merge_status === "empty" || merge.merge_status === "smoke_failed") {
    return "surfaced";
  }

  // Feed the winning candidate's diff to downstream stages, same as the
  // single-attempt path's finalizePassed does.
  const winnerCand = cand.find((c) => c.index === winnerIndex);
  ctx.stageArtifacts.push({
    kind: stage.kind,
    agent: stage.agent,
    path: `${stage.kind}/candidate-${winnerIndex}/`,
    text: winnerCand?.text ?? "",
  });
  return "passed";
}
