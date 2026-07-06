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
import { join, isAbsolute } from "node:path";
import { mkdirSync } from "node:fs";
import {
  startStage,
  recordAttempt,
  recordAgentSession,
  recordVerdict,
  getStageFinalizeReadiness,
  finalizeStage,
  archiveArtifact,
  checkRetryEligible,
  getRubric,
  runTddCheck,
  runArtifactValidator,
  selectSkillsForStage,
  promoteArtifact,
  type GateType,
  type Profile,
  type VerdictOutcome,
  type ClaudeTier,
} from "@pp/core";
import { providerForModel, hasCredential, providersWithCredential } from "@pp/engine";
import { loadRolePrompt, renderSystemPrompt, loadAgentsMdForPrompt } from "../prompts/loader.js";
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

/** Default total budget (chars) for skill bodies injected into one prompt. */
const SKILLS_BUDGET_CHARS_DEFAULT = 24_000;

export type SkillsSelection = {
  injected: Array<{ id: string; name: string; body: string }>;
  skipped: string[];
};

/**
 * Select + budget the skills for a generator stage (shared with best-of.ts so
 * candidate prompts carry the same skills a single-attempt stage would). The
 * core selector returns priority-ordered specs but does NOT truncate bodies —
 * the injector enforces both the per-skill max_chars and the total
 * PP_SKILLS_BUDGET_CHARS budget (default 24000) here. Deterministic: skills
 * are taken in selector order (priority asc, id asc); the first one that no
 * longer fits exhausts the budget and everything after it is skipped.
 * Explicit team-yaml ids that fail to resolve are reported as skipped — this
 * is where stale stage.skills references surface (the team loader does not
 * validate them).
 */
export function selectStageSkills(ctx: RunContext, stage: StageSpec): SkillsSelection {
  const specs = selectSkillsForStage({
    stage_kind: stage.kind,
    agent: stage.agent,
    gate_type: stage.gate_type,
    profile: ctx.profileName,
    project_path: ctx.projectPath,
    explicit: stage.skills,
  });
  const raw = Number(process.env.PP_SKILLS_BUDGET_CHARS);
  let remaining = Number.isFinite(raw) && raw >= 0 ? raw : SKILLS_BUDGET_CHARS_DEFAULT;
  const injected: SkillsSelection["injected"] = [];
  const skipped: string[] = [];
  let exhausted = false;
  for (const spec of specs) {
    const body = spec.body.length > spec.max_chars ? spec.body.slice(0, spec.max_chars) : spec.body;
    if (exhausted || body.length > remaining) {
      exhausted = true;
      skipped.push(spec.id);
      continue;
    }
    remaining -= body.length;
    injected.push({ id: spec.id, name: spec.name, body });
  }
  // Unresolvable explicit ids (never selected, so never budgeted).
  for (const id of stage.skills ?? []) {
    if (!specs.some((s) => s.id === id) && !skipped.includes(id)) skipped.push(id);
  }
  return { injected, skipped };
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** HEAD sha, or null in a repo with no commits (or no repo). */
export function gitHeadSha(cwd: string): string | null {
  return git(cwd, ["rev-parse", "HEAD"])?.trim() ?? null;
}

/**
 * Pathspec that keeps harness metadata (.harness transcripts, snapshots,
 * archived artifacts) out of attempt commits and judged diffs — judges must
 * see only the product change. (The judges on run_pIgGjPhWo59e explicitly
 * dinged the attempt for committed harness artifacts.)
 */
const EXCLUDE_HARNESS = [":(exclude).harness", ":(exclude).harness/**"] as const;

/**
 * The diff an attempt actually produced: baseSha..HEAD. With no base (fresh
 * repo) falls back to the full HEAD patch. NEVER use `git show HEAD` directly
 * for judging — when an attempt commits nothing, that hands the judge whatever
 * pre-existing commit happens to be HEAD (the exact bug behind
 * run_pIgGjPhWo59e, where judges graded the scaffolding commit).
 */
export function gitDiffRange(cwd: string, baseSha: string | null): string | null {
  if (!baseSha) return git(cwd, ["show", "--stat", "--patch", "HEAD", "--", ".", ...EXCLUDE_HARNESS]);
  const head = gitHeadSha(cwd);
  if (!head || head === baseSha) return null;
  return git(cwd, ["diff", "--stat", "--patch", baseSha, "HEAD", "--", ".", ...EXCLUDE_HARNESS]);
}

/**
 * Commit whatever the session left in the working tree (minus .harness).
 * Models narrate commits they never ran (deepseek's engineer-0 did exactly
 * that) — the harness owns the commit so the attempt diff is always real.
 * Returns true when a commit was created.
 */
export function gitAutoCommitIfDirty(cwd: string, message: string): boolean {
  const status = git(cwd, ["status", "--porcelain", "--", ".", ...EXCLUDE_HARNESS]);
  if (!status || status.trim().length === 0) return false;
  if (git(cwd, ["add", "-A", "--", ".", ...EXCLUDE_HARNESS]) === null) return false;
  return (
    git(cwd, [
      "-c",
      "user.email=pp@local",
      "-c",
      "user.name=pi-pp-platform",
      "commit",
      "-m",
      message,
    ]) !== null
  );
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

  // Zero-change guard: a coding attempt that wrote nothing has no diff to
  // judge — skip the (paid) judge call entirely and go straight to Reflexion
  // with a synthetic critique. Never let a judge grade a stale HEAD commit.
  if (gen0.zeroChange) {
    emit(
      ctx,
      "gate.blocked",
      { reason: "attempt produced zero file changes — judge skipped", gate_type: stage.gate_type, zero_change: true },
      { stage_id },
    );
    return reflexion(ctx, stage, stage_id, gen0.attempt_id, resolution.tier, ZERO_CHANGE_CRITIQUE, gen0.artifactText);
  }

  const judged0 = await judge(ctx, stage, stage_id, gen0.attempt_id, resolution.model_id, gen0.artifactText, false);
  if (judged0 === "abort") return abortStage(ctx, stage_id, "judge tool failure");

  if (judged0.outcome === "pass") {
    const settled = await driveReadiness(ctx, stage, stage_id, gen0.attempt_id);
    if (settled.action === "finalize") return finalizePassed(ctx, stage, stage_id, gen0.attempt_id, gen0);
    if (settled.action === "surface") return surface(ctx, stage_id, settled.reason);
    // action === "retry": fall through to Reflexion using the blocker message.
    return reflexion(ctx, stage, stage_id, gen0.attempt_id, resolution.tier, settled.critique, gen0.artifactText);
  }

  // fail / revise → Reflexion ×1.
  return reflexion(ctx, stage, stage_id, gen0.attempt_id, resolution.tier, judged0.critique_md, gen0.artifactText);
}

// ── generation ───────────────────────────────────────────────────────────────

type GenOut = {
  attempt_id: string;
  artifactText: string;
  artifactPath: string;
  /** session-coding attempt that left the working tree untouched. */
  zeroChange: boolean;
};

/** Synthetic critique for the zero-change Reflexion retry — no judge involved. */
export const ZERO_CHANGE_CRITIQUE =
  "The attempt produced ZERO file changes: no tool calls reached disk, so there is nothing to " +
  "review. You must create real files in the working directory with your write/edit/bash tools. " +
  "Do not answer with code blocks or descriptions — every file must be written via a tool call.";

/** Task prompt for coding sessions: the ask + how the harness captures work. */
function buildCodingTaskPrompt(ctx: RunContext): string {
  const upstream =
    ctx.stageArtifacts.length > 0
      ? " Approved upstream artifacts (spec, design, …) are in your system prompt — implement THOSE, not a re-interpretation of the request."
      : "";
  return (
    `${ctx.requestText}\n\n` +
    `Implement this in the current working directory using your write/edit/bash tools.${upstream} ` +
    `The harness only captures changes actually written to disk; verify your files exist before finishing.`
  );
}

async function generate(
  ctx: RunContext,
  stage: StageSpec,
  stage_id: string,
  modelId: string,
  tier: ClaudeTier,
  retryIndex: number,
  parentAttemptId: string | undefined,
  priorCritiques: string[],
  priorArtifact?: string,
): Promise<GenOut> {
  const role = loadRolePrompt(stage.agent, { projectPath: ctx.projectPath });
  // A tests_pre stage always produces a completion (the tdd_manifest YAML).
  const isTddManifestStage = stage.kind === "tests_pre";
  const execution = isTddManifestStage ? "completion" : stage.execution ?? role.execution;
  // Skill injection (A1b): explicit team-yaml ids + registry auto-selection,
  // budgeted here (the loader does not truncate). Observability mirrors the
  // tier-resolve run.context emit; silent when nothing matched so default
  // runs stay byte-identical.
  const skills = selectStageSkills(ctx, stage);
  if (skills.injected.length > 0 || skills.skipped.length > 0) {
    emit(ctx, "run.context", {
      phase: "skills",
      stage_kind: stage.kind,
      injected: skills.injected.map((s) => s.id),
      skipped: skills.skipped,
    });
  }
  const systemPrompt = renderSystemPrompt(role, {
    profileSummary: profileSummary(ctx),
    profileName: ctx.profileName,
    priorCritiques,
    requestText: ctx.requestText,
    execution,
    skills: skills.injected.map((s) => ({ name: s.name, body: s.body })),
    // Cross-stage cohesion: passed artifacts (the approved spec, etc.), the
    // project's AGENTS.md conventions, and — on retries — the rejected attempt.
    upstreamArtifacts: ctx.stageArtifacts.map((a) => ({ kind: a.kind, text: a.text })),
    agentsMd: loadAgentsMdForPrompt(ctx.projectPath) ?? undefined,
    priorArtifact,
  });
  // Resolve the generator's provider FROM the model (effective ladder), not the
  // legacy hardcoded "anthropic". Preflight the credential so a missing key
  // surfaces a clear, actionable reason instead of pi's raw auth error.
  const genProvider = providerForModel(modelId);
  if (!genProvider) {
    // REQ-P-4: defensive log when providerForModel fails to resolve. In
    // practice a launched attempt should always resolve (preflight below
    // would already have thrown for a missing key), so this is a canary
    // rather than an expected code path.
    console.warn(`[pp/pilot] providerForModel returned no provider for model "${modelId}"; attempt will persist provider=NULL and omit provider from SSE frames`);
  }
  if (ctx.engine.mode === "pi" && !hasCredential(ctx.engine.authStorage, genProvider)) {
    throw new Error(
      `generation model "${modelId}" requires a key for provider "${genProvider}", which is not configured. ` +
        `Add a key in Providers, or point your generation ladder at a provider you have keyed.`,
    );
  }
  const model = ctx.engine.catalog.resolve(genProvider, modelId);
  const sessionDir = join(ctx.artifact_dir, stage.kind);
  mkdirSync(sessionDir, { recursive: true });

  emit(ctx, "attempt.started", { agent: stage.agent, model: modelId, tier, retry_index: retryIndex, provider: genProvider || undefined }, { stage_id });

  let artifactText: string;
  let artifactPath: string;
  let zeroChange = false;
  let genResult;

  if (execution === "session-coding" || execution === "session-readonly") {
    const coding = execution === "session-coding";
    const baseSha = coding ? gitHeadSha(ctx.projectPath) : null;
    genResult = await ctx.engine.runCodingSession({
      cwd: ctx.projectPath,
      systemPrompt,
      taskPrompt: coding ? buildCodingTaskPrompt(ctx) : ctx.requestText,
      model,
      sessionDir,
      toolPolicy: coding ? "coding" : "readonly",
      role: stage.agent,
      attempt: retryIndex,
      signal: ctx.signal,
    });
    if (coding) {
      // The harness owns the commit; then the judge sees exactly what this
      // attempt changed (baseSha..HEAD), never a stale pre-existing commit.
      gitAutoCommitIfDirty(ctx.projectPath, `pp ${ctx.run_id} ${stage.kind} attempt ${retryIndex}`);
      const rangeDiff = gitDiffRange(ctx.projectPath, baseSha);
      zeroChange = !rangeDiff || rangeDiff.trim().length === 0;
      artifactText = zeroChange ? genResult.text : rangeDiff!;
      artifactPath = `${stage.kind}/ (commit ${zeroChange ? "none" : (gitHeadSha(ctx.projectPath) ?? "n/a")})`;
    } else {
      // Readonly sessions deliver a document, not a diff — the assistant text
      // IS the artifact. (Previously this fed `git show HEAD` to the judge.)
      artifactText = genResult.text;
      artifactPath = `${stage.kind}/ (session ${genResult.session_id ?? "n/a"})`;
    }
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
    provider: genProvider || undefined,
  });

  // Record the engine session (transcript file) for replay/audit when one exists
  // (coding/readonly sessions; single completions have no session file).
  if (genResult.session_file) {
    recordAgentSession({
      run_id: ctx.run_id,
      attempt_id: attempt.attempt_id,
      role: stage.agent,
      provider: genResult.provider,
      model_id: modelId,
      session_file: genResult.session_file,
    });
  }

  emit(
    ctx,
    "attempt.completed",
    {
      model: modelId,
      tokens_in: genResult.tokens_in,
      tokens_out: genResult.tokens_out,
      cost_usd: genResult.cost_usd,
      stop_reason: genResult.stop_reason,
      tool_call_count: genResult.tool_call_count,
      files_changed: genResult.files_changed,
      materialized_files: genResult.materialized_files,
      zero_change: zeroChange,
      provider: genProvider || undefined,
    },
    { stage_id, attempt_id: attempt.attempt_id },
  );

  return { attempt_id: attempt.attempt_id, artifactText, artifactPath, zeroChange };
}

// ── judging ────────────────────────────────────────────────────────────────

export type JudgeOut = { outcome: VerdictOutcome; critique_md: string } | "abort";

export async function judge(
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
      // The real generator provider is derived from its model (effective ladder),
      // so cross-provider judging excludes the actual generator, and only
      // keyed providers are eligible — never routes to an unconfigured vendor.
      generatorProvider: providerForModel(generatorModel),
      keyedProviders:
        ctx.engine.mode === "pi" ? providersWithCredential(ctx.engine.authStorage) : undefined,
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
  const judgeProvider = selection.provider || undefined;
  if (!judgeProvider) {
    // REQ-P-7: defensive log when the judge selection produced no provider.
    console.warn(`[pp/pilot] judge selection produced no provider for judge model "${selection.judge_model}"; verdict will persist judge_provider=NULL and omit judge_provider from SSE frame`);
  }
  const rec = recordVerdict({
    attempt_id,
    judge_producer: selection.judge_producer,
    judge_model_id: selection.judge_model,
    rubric_id: selection.rubric_id ?? undefined,
    outcome: verdict.outcome,
    critique_md: verdict.critique_md,
    score_json: verdict.score ?? critiqueRes.parsed,
    judge_provider: judgeProvider,
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
      judge_provider: judgeProvider,
    },
    { stage_id, attempt_id },
  );

  return { outcome: verdict.outcome, critique_md: verdict.critique_md ?? "" };
}

// ── readiness / finalize ─────────────────────────────────────────────────────

export type ReadinessSettled =
  | { action: "finalize" }
  | { action: "retry"; critique: string }
  | { action: "surface"; reason: string };

export async function driveReadiness(
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

export async function finalizePassed(
  ctx: RunContext,
  stage: StageSpec,
  stage_id: string,
  winnerAttemptId: string,
  /** The winning attempt's output — its artifactText is the attempt's real diff/document. */
  winner?: { artifactText: string; artifactPath: string },
): Promise<StageOutcome> {
  await finalizeStage({ stage_id, winner_attempt_id: winnerAttemptId, status: "passed" });
  emit(ctx, "stage.finalized", { status: "passed", winner_attempt_id: winnerAttemptId }, { stage_id });

  // VG-2 needs a run-wide `diff` artifact (counted via an artifacts→stages
  // join) to finalize the run as complete. The change lives in a git commit,
  // so archive the diff AFTER finalize_stage(passed): the code stage's VG-5
  // smoke gate was already evaluated (with no code/diff artifact present, so it
  // passed), and tying the diff to the stage now lets VG-2 count it without
  // retriggering VG-5. Best-effort; a missing diff simply lets VG-2 surface.
  // The archived diff is the WINNING ATTEMPT's baseSha..HEAD range (its
  // artifactText), never a re-run of `git show HEAD`.
  if (stage.kind === "code") {
    const diff = winner?.artifactText ?? gitDiffRange(ctx.projectPath, null);
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

  // Make the passed artifact available to downstream stages ("Approved
  // upstream artifacts" prompt block) — this is how the code stage sees the
  // approved spec instead of re-deriving the request from scratch.
  if (winner) {
    ctx.stageArtifacts.push({
      kind: stage.kind,
      agent: stage.agent,
      path: winner.artifactPath,
      text: winner.artifactText,
    });

    // Promote passed completion artifacts (spec, docs, ADRs, …) into the
    // project tree at docs/pp/<run_id>/ so they're visible outside .harness
    // even if a later stage surfaces. Committed immediately in a dedicated
    // harness commit so the next attempt's baseSha..HEAD diff never sweeps
    // them in. Best-effort — a skipped promotion never fails the stage.
    // Review/forum runs are advisory and must leave the project tree
    // untouched (zero commits), so they never promote.
    if (ctx.mode !== "review" && stage.kind !== "code" && isAbsolute(winner.artifactPath)) {
      const ext = winner.artifactPath.endsWith(".yaml") ? "yaml" : "md";
      const promoted = promoteArtifact({
        run_id: ctx.run_id,
        source_abs_path: winner.artifactPath,
        dest_name: `${stage.kind}-${stage.agent}.${ext}`,
      });
      if (promoted.status === "ok") {
        gitAutoCommitIfDirty(ctx.projectPath, `pp ${ctx.run_id} promote ${stage.kind} artifact`);
        emit(ctx, "run.context", { phase: "artifact-promotion", promoted_path: promoted.promoted_path }, { stage_id });
      }
    }
  }
  return "passed";
}

export async function surface(ctx: RunContext, stage_id: string, reason: string): Promise<StageOutcome> {
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

export async function reflexion(
  ctx: RunContext,
  stage: StageSpec,
  stage_id: string,
  parentAttemptId: string,
  initialTier: ClaudeTier,
  critique: string,
  /** The rejected attempt's output, injected as "Your previous attempt" context. */
  priorArtifactText?: string,
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

  const gen1 = await generate(ctx, stage, stage_id, esc.model_id, esc.tier, 1, parentAttemptId, [critique], priorArtifactText);

  // Zero-change retry: still nothing on disk. Surface with the real reason —
  // do not burn a judge call on an empty diff.
  if (gen1.zeroChange) {
    return surface(
      ctx,
      stage_id,
      "code stage produced zero file changes after Reflexion ×1 (model emitted text instead of tool calls)",
    );
  }

  const judged1 = await judge(ctx, stage, stage_id, gen1.attempt_id, esc.model_id, gen1.artifactText, true);
  if (judged1 === "abort") return abortStage(ctx, stage_id, "judge tool failure on retry");

  if (judged1.outcome === "pass") {
    const settled = await driveReadiness(ctx, stage, stage_id, gen1.attempt_id);
    if (settled.action === "finalize") return finalizePassed(ctx, stage, stage_id, gen1.attempt_id, gen1);
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
