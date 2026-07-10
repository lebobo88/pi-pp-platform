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
import { randomBytes } from "node:crypto";
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
  resolveVerdict,
  getSmokeResults,
  GREENFIELD_SIGNAL,
  type GateType,
  type Profile,
  type VerdictOutcome,
  type ClaudeTier,
  type AttemptStatus,
  type AttemptNotes,
} from "@pp/core";
import { providerForModel, hasCredential, providersWithCredential } from "@pp/engine";
import { loadRolePrompt, renderSystemPrompt, loadAgentsMdForPrompt } from "../prompts/loader.js";
import { resolveTier, escalateTierForRetry } from "../tier-resolver.js";
import { generationModelIdForTier } from "../generation-model.js";
import { providerToProducer, type JudgeSelection } from "../judge-policy.js";
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

/**
 * The artifact kind a stage will archive under (for gate rubric selection
 * AND plan-time completion-gate reconciliation — see
 * `phases/plan-reconciliation.ts`). Mirrors the exact fallback chain used at
 * archive time (the `isTddManifestStage` special case aside, which only
 * affects `tests_pre` manifest stages and never participates in required-
 * artifact reconciliation).
 */
export function resolveArtifactKind(stage: Pick<StageSpec, "kind" | "artifact_kind">): string {
  return stage.artifact_kind ?? ARTIFACT_KIND_BY_KIND[stage.kind] ?? stage.kind;
}

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

/**
 * Pre-mint an attempt id in the driver so `attempt.started`, the live
 * `attempt.output` stream, AND the persisted attempt row all share ONE id.
 * The UI keys its log pane on the attempt id, so a streamed chunk MUST carry
 * the same id `record_attempt` will use — we pass this value as
 * `attempt_slot_id` (core uses it verbatim as the row id). Format mirrors
 * core's `attempt_<id>` slugs; exact entropy is irrelevant (a handful of
 * attempts per run), only per-run uniqueness matters.
 */
export function mintAttemptId(): string {
  return `attempt_${randomBytes(8).toString("hex")}`;
}

/**
 * Lightly coalesces streamed assistant text into `attempt.output` frames so a
 * fast token stream becomes a handful of SSE frames per line instead of one
 * per token: buffer deltas and flush on a newline, on a soft size cap, or after
 * ~100ms of silence. The idle timer is unref'd so a trailing buffer never keeps
 * the process alive; callers MUST call flush() once the session ends to emit the
 * final partial line. attempt_id is threaded top-level (the server folds it into
 * the frame's data, where the UI reads it) alongside the {chunk} payload.
 */
export function makeOutputStreamer(
  ctx: Pick<RunContext, "bus" | "run_id">,
  stage_id: string,
  attempt_id: string,
): { push: (delta: string) => void; flush: () => void } {
  let buf = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (buf.length === 0) return;
    const chunk = buf;
    buf = "";
    emit(ctx, "attempt.output", { chunk }, { stage_id, attempt_id });
  };
  return {
    push(delta: string): void {
      buf += delta;
      if (buf.length >= 4000 || delta.includes("\n")) {
        flush();
        return;
      }
      if (!timer) {
        timer = setTimeout(flush, 100);
        timer.unref?.();
      }
    },
    flush,
  };
}

/** Synchronous sleep (git retry backoff) — the stage loop is already blocking here. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run git, retrying once after a short backoff. A coding session may still be
 * releasing index.lock (its own `git commit`) when the harness runs its
 * bookkeeping — a transient failure here must NOT be silent: it previously
 * read as "no diff" and falsely zero-changed real attempts (judge skipped,
 * run surfaced). Failures are logged with git's stderr.
 */
function git(cwd: string, args: string[]): string | null {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (e) {
      const stderr = (e as { stderr?: Buffer | string }).stderr?.toString?.().trim();
      if (attempt === 0) {
        sleepSync(250);
        continue;
      }
      console.warn(`[pilot] git ${args[0]} failed after retry${stderr ? `: ${stderr.slice(0, 300)}` : ""}`);
      return null;
    }
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
  const diff = git(cwd, ["diff", "--stat", "--patch", baseSha, "HEAD", "--", ".", ...EXCLUDE_HARNESS]);
  if (diff !== null) return diff;
  // HEAD moved but the diff command failed (lock/AV transient). The attempt
  // DID change the tree — never classify this as zero-change. Try log -p as a
  // fallback renderer; as a last resort return an explicit marker so the
  // caller records a real (if unrenderable) change instead of a false zero.
  const logp = git(cwd, ["log", "--stat", "--patch", `${baseSha}..HEAD`, "--", ".", ...EXCLUDE_HARNESS]);
  if (logp !== null) return logp;
  return `[pilot] git diff unavailable after retries, but HEAD moved ${baseSha.slice(0, 8)}..${head.slice(0, 8)} — the attempt committed changes; see git log for the real diff.`;
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

/**
 * The rubric markdown a stage will be judged against, resolved BEFORE
 * generation so the generator can be shown its definition of done. The
 * generator historically never saw the rubric (it was resolved only inside
 * judge(), after generation) — first-pass quality suffered
 * (docs/retrospective-first-pass-quality.md). Uses the SAME gate inputs
 * judge()'s select() feeds `evaluateGate`, so the rubric id shown to the
 * generator is exactly the id later recorded on the verdict. Returns undefined
 * when no rubric binds — the prompt then stays byte-identical; only the judge
 * falls back to a generic rubric.
 */
export function resolveStageRubricMd(
  ctx: RunContext,
  stage: StageSpec,
  generatorModel: string,
): string | undefined {
  const rubricId = ctx.judgePolicy.rubricIdFor({
    gateType: stage.gate_type as GateType,
    generatorProducer: "claude",
    generatorModel,
    promptKeywords: ctx.requestText,
    profile: (ctx.profileName as Profile | undefined) ?? null,
    artifactKind: stage.artifact_kind ?? null,
    rubricHint: stage.rubricHint ?? null,
    greenfield: runIsGreenfield(ctx),
  });
  return rubricId ? getRubric(rubricId)?.markdown ?? undefined : undefined;
}

/** True when the run carries the triage `greenfield` signal — drives the
 * greenfield-aware rubric selection and generator tier floor. */
export function runIsGreenfield(ctx: RunContext): boolean {
  return ctx.signals.includes(GREENFIELD_SIGNAL);
}

/** Drives one stage to a terminal outcome. */
export async function runStage(ctx: RunContext, stage: StageSpec): Promise<StageOutcome> {
  ctx.signal?.throwIfAborted();
  const { stage_id } = startStage({ run_id: ctx.run_id, kind: stage.kind, gate_type: stage.gate_type, plan_index: stage.planIndex ?? null });
  emit(ctx, "stage.started", { kind: stage.kind, gate_type: stage.gate_type, agent: stage.agent }, { stage_id });

  // Resolve the Claude tier for this stage (generators are always Path-A Claude).
  const resolution = resolveTier({
    agent: stage.agent,
    stageKind: stage.kind,
    scope: ctx.scope,
    greenfield: runIsGreenfield(ctx),
    teamStageModelTier: stage.teamStageModelTier,
    profilePolicy: ctx.profile?.model_tier_policy ?? null,
    ladderOverride: ctx.ladderOverride,
    flags: ctx.flags,
  });
  recordTierTrace(ctx, stage, resolution.tier, resolution.model_id, resolution.trace);

  // Resolve the rubric the judge will grade against BEFORE generating, so the
  // generator sees its definition of done. Same gate inputs judge() uses → the
  // id shown to the generator is the id recorded on the verdict.
  const rubricMd = resolveStageRubricMd(ctx, stage, resolution.model_id);

  // Capture the stage's ORIGINAL base sha ONCE, before attempt 0's auto-commit
  // moves HEAD. A later Reflexion retry judges against the cumulative diff from
  // this base to HEAD (the whole change since the stage started) rather than
  // just the incremental attempt0→retry diff — see buildRetryContext.
  const stageBaseSha = gitHeadSha(ctx.projectPath);

  // ── Attempt 0: generate → judge ──────────────────────────────────────────
  const gen0 = await generate(ctx, stage, stage_id, resolution.model_id, resolution.tier, 0, undefined, [], undefined, rubricMd);

  // Errored-attempt guard: a provider error (quota / rate limit / other) is NOT
  // a quality failure — it never reaches a judge and never consumes the
  // Reflexion slot. Take ONE infra retry (retry_index=0, parent chained),
  // rotating the generation pool away from a cooled-down provider on
  // quota/rate. Two consecutive errors surface with the real reason. See
  // handleErroredAttempt.
  if (gen0.errorClass) {
    return handleErroredAttempt(ctx, stage, stage_id, gen0, resolution.tier, stageBaseSha, rubricMd);
  }

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
    return reflexion(ctx, stage, stage_id, gen0.attempt_id, resolution.tier, ZERO_CHANGE_CRITIQUE, gen0.artifactText, { stageBaseSha, automatic: true });
  }

  return settleGenerated(ctx, stage, stage_id, gen0, resolution.tier, stageBaseSha);
}

/**
 * Judge a real (non-errored, non-zero-change) generation and settle the stage:
 * pass → finalize (or Reflexion on a readiness blocker); fail/revise → Reflexion
 * ×1. Shared by attempt 0 and the errored-attempt infra retry so both drive the
 * exact same tested judge/finalize/Reflexion path. `gen.modelId` is the model
 * that actually generated (post-rotation), so cross-vendor judging excludes the
 * true generator.
 */
async function settleGenerated(
  ctx: RunContext,
  stage: StageSpec,
  stage_id: string,
  gen: GenOut,
  tier: ClaudeTier,
  stageBaseSha: string | null,
): Promise<StageOutcome> {
  const judged = await judge(ctx, stage, stage_id, gen.attempt_id, gen.modelId, gen.artifactText, false);
  if (judged === "abort") return abortStage(ctx, stage_id, "judge tool failure");

  if (judged.outcome === "pass") {
    const settled = await driveReadiness(ctx, stage, stage_id, gen.attempt_id);
    if (settled.action === "finalize") return finalizePassed(ctx, stage, stage_id, gen.attempt_id, gen);
    if (settled.action === "surface") return surface(ctx, stage_id, settled.reason);
    // action === "retry": fall through to Reflexion using the blocker message.
    return reflexion(ctx, stage, stage_id, gen.attempt_id, tier, settled.critique, gen.artifactText, { stageBaseSha, automatic: true });
  }

  // fail / revise → Reflexion ×1.
  return reflexion(ctx, stage, stage_id, gen.attempt_id, tier, judged.critique_md, gen.artifactText, { stageBaseSha, automatic: true });
}

/**
 * Handle a generation that resolved with a provider error. Takes exactly ONE
 * infra retry at the SAME tier (retry_index=0, parent chained — so the
 * Reflexion ×1 slot stays intact), skipping the judge entirely. On a quota /
 * rate-limit class, rotate the generation pool (draw the next pool model, which
 * may be a different provider) to skip the cooled-down provider; other classes
 * retry the same model (a transient blip). If the retry ALSO errors → surface
 * with the real provider cause (zero judge calls). If it produces a real
 * artifact → settle it normally (Reflexion still available). If it zero-changes
 * → the existing zero-change Reflexion path.
 */
async function handleErroredAttempt(
  ctx: RunContext,
  stage: StageSpec,
  stage_id: string,
  errored: GenOut,
  tier: ClaudeTier,
  stageBaseSha: string | null,
  rubricMd: string | undefined,
): Promise<StageOutcome> {
  emit(
    ctx,
    "gate.blocked",
    {
      reason: `generation provider error (${errored.errorClass}) — judge skipped, infra retry`,
      gate_type: stage.gate_type,
      error_class: errored.errorClass,
      provider_error: true,
    },
    { stage_id, attempt_id: errored.attempt_id },
  );

  const rotate = errored.errorClass === "quota_exhausted" || errored.errorClass === "rate_limited";
  // Rotation index 1 draws the next pool model for the tier (a different
  // provider when a pool spans vendors); with no pool configured this returns
  // the same model id, so a same-provider transient simply retries in place.
  const retryModel = rotate ? generationModelIdForTier(tier, 1, ctx.ladderOverride) : errored.modelId;

  const gen1 = await generate(ctx, stage, stage_id, retryModel, tier, 0, errored.attempt_id, [], undefined, rubricMd);

  if (gen1.errorClass) {
    // Two consecutive errored attempts — surface with the real reason, never a
    // fabricated verdict. Reflexion was never consumed.
    return surface(
      ctx,
      stage_id,
      `provider error persisted after infra retry: ${gen1.errorClass}: ${gen1.errorMessage ?? "unknown provider error"}`,
    );
  }

  if (gen1.zeroChange) {
    emit(
      ctx,
      "gate.blocked",
      { reason: "infra-retry attempt produced zero file changes — judge skipped", gate_type: stage.gate_type, zero_change: true },
      { stage_id },
    );
    return reflexion(ctx, stage, stage_id, gen1.attempt_id, tier, ZERO_CHANGE_CRITIQUE, gen1.artifactText, { stageBaseSha, automatic: true });
  }

  return settleGenerated(ctx, stage, stage_id, gen1, tier, stageBaseSha);
}

// ── generation ───────────────────────────────────────────────────────────────

type GenOut = {
  attempt_id: string;
  artifactText: string;
  artifactPath: string;
  /** session-coding attempt that left the working tree untouched. */
  zeroChange: boolean;
  /** Concrete model id that actually generated this attempt (post-rotation). */
  modelId: string;
  /** Recorded attempt status ("ok" | "error" | "timeout"). */
  status: AttemptStatus;
  /** Provider-error classification when the generation itself errored. */
  errorClass?: string;
  /** Real provider cause when the generation errored. */
  errorMessage?: string;
};

/**
 * Derive the persisted attempt status from a GenResult. A provider error
 * (error_class set by the envelope on stopReason:"error") is "error"; a timeout
 * sentinel is "timeout"; an empty generation (a completion with no text, or a
 * coding session that drove no mutating tool call) is also "error" — recording
 * it as "ok" (the old hardcode) was the root of the silent attempt-waste loop.
 */
function deriveAttemptStatus(
  genResult: { error_class?: string; stop_reason: string; text: string },
  execution: string,
  zeroChange: boolean,
): AttemptStatus {
  if (genResult.error_class) return "error";
  if (genResult.stop_reason === "timeout") return "timeout";
  const isSession = execution === "session-coding" || execution === "session-readonly";
  if (!isSession) return genResult.text.trim().length === 0 ? "error" : "ok";
  if (execution === "session-coding" && zeroChange && genResult.stop_reason === "no_tool_calls") {
    return "error";
  }
  return "ok";
}

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
  /** The rubric the judge grades against, shown to the generator as its
   * definition of done. Omitted when no rubric binds (prompt stays identical). */
  rubricMd?: string,
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
    rubricMd,
  });
  // Resolve the generator's provider FROM the model (effective ladder), not the
  // legacy hardcoded "anthropic" — credential-aware, so ambiguous ids land on
  // a keyed provider. Preflight the credential so a missing key surfaces a
  // clear, actionable reason instead of pi's raw auth error.
  const genProvider = providerForModel(modelId, ctx.engine.authStorage);
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

  // Pre-mint the attempt id BEFORE generation so attempt.started, the live
  // output stream, and the persisted attempt row (via attempt_slot_id) all key
  // on the same id — the UI's log pane depends on that equality.
  const attemptSlotId = mintAttemptId();

  emit(ctx, "attempt.started", { agent: stage.agent, model: modelId, tier, retry_index: retryIndex, provider: genProvider || undefined }, { stage_id, attempt_id: attemptSlotId });

  let artifactText: string;
  let artifactPath: string;
  let zeroChange = false;
  let genResult;

  if (execution === "session-coding" || execution === "session-readonly") {
    const coding = execution === "session-coding";
    const baseSha = coding ? gitHeadSha(ctx.projectPath) : null;
    // Live-stream the model's incremental output into attempt.output frames so
    // the UI log pane fills DURING generation, not only on completion. Flushed
    // right after the session ends (below) to emit any trailing partial line.
    const streamer = makeOutputStreamer(ctx, stage_id, attemptSlotId);
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
      onOutputDelta: (chunk) => streamer.push(chunk),
    });
    streamer.flush();
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

  // Record the attempt with its TRUTHFUL status (no more hardcoded "ok"): a
  // provider error or an empty generation is persisted as "error"/"timeout" so
  // the errored-attempt guard can skip judging, and the real cause is kept in
  // notes_json for the operator + smart /pp:retry. notes stay null for healthy
  // attempts so existing rows are byte-identical.
  const attemptStatus = deriveAttemptStatus(genResult, execution, zeroChange);
  const errorNotes: AttemptNotes | undefined =
    attemptStatus === "ok"
      ? undefined
      : {
          ...(genResult.error_class ? { error_class: genResult.error_class } : {}),
          ...(genResult.error_message ? { error_message: genResult.error_message } : {}),
          stop_reason: genResult.stop_reason,
          files_changed: genResult.files_changed ?? false,
        };
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
    status: attemptStatus,
    notes: errorNotes,
    attempted_tier: tier,
    agent_type: stage.agent,
    provider: genProvider || undefined,
    // Bind the row to the pre-minted id so the streamed attempt.output frames
    // and this persisted attempt share one id (constraint: they MUST match).
    attempt_slot_id: attemptSlotId,
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
      status: attemptStatus,
      error_class: genResult.error_class,
      provider: genProvider || undefined,
    },
    { stage_id, attempt_id: attempt.attempt_id },
  );

  return {
    attempt_id: attempt.attempt_id,
    artifactText,
    artifactPath,
    zeroChange,
    modelId,
    status: attemptStatus,
    errorClass: genResult.error_class,
    errorMessage: genResult.error_message,
  };
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
  /** Cumulative retry context (prior critique, whole-stage diff, execution
   * evidence) surfaced to the judge on a Reflexion retry. Omitted on first
   * attempts so their judging stays byte-identical. */
  contextMd?: string,
): Promise<JudgeOut> {
  const keyedProviders =
    ctx.engine.mode === "pi" ? providersWithCredential(ctx.engine.authStorage) : undefined;
  const generatorProvider = providerForModel(generatorModel);

  // Re-select a judge, excluding providers that already errored this stage. The
  // real generator provider is derived from its model (effective ladder), so
  // cross-provider judging excludes the actual generator, and only keyed
  // providers are eligible — never routes to an unconfigured vendor.
  const selectJudge = (excludeProviders: string[]): JudgeSelection =>
    ctx.judgePolicy.select(ctx.run_id, {
      gateType: stage.gate_type as GateType,
      generatorProducer: "claude",
      generatorProvider,
      keyedProviders,
      generatorModel,
      promptKeywords: ctx.requestText,
      profile: (ctx.profileName as Profile | undefined) ?? null,
      artifactKind: stage.artifact_kind ?? null,
      rubricHint: stage.rubricHint ?? null,
      greenfield: runIsGreenfield(ctx),
      retry,
      excludeProviders,
    });

  // ── Bounded judge-failover loop ───────────────────────────────────────────
  // On a provider error (quota/rate/other) or an unvalidatable verdict, fail
  // over WITHOUT fabricating a result: (a) de-escalate an escalated judge to
  // its provider's default model; (b) then move to the next eligible provider
  // (max 2 providers total); (c) exhausted → archive + gate.blocked + abort.
  const excluded: string[] = [];
  let selection: JudgeSelection;
  try {
    selection = selectJudge(excluded);
  } catch (err) {
    if (err instanceof JudgeUnavailableError) {
      archiveCritiqueFailure(ctx, stage_id, { reason: err.message, kind: "judge_pool_empty" });
      emit(ctx, "gate.blocked", { reason: err.message, gate_type: stage.gate_type }, { stage_id });
      return "abort";
    }
    throw err;
  }

  let judgeModelId = selection.judge_model;
  // Only the escalated lane has a lower model to de-escalate TO; otherwise the
  // provider offers no second model, so skip straight to the next provider.
  let deEscalationAvailable = selection.escalated && selection.default_model !== judgeModelId;
  let providersTried = 1;

  for (;;) {
    const rubricMd = (selection.rubric_id ? getRubric(selection.rubric_id)?.markdown : null) ?? FALLBACK_RUBRIC;
    const judgeModel = ctx.engine.catalog.resolve(selection.provider, judgeModelId);

    const critiqueRes = await ctx.engine.critique({
      judgeModel,
      rubricMd,
      artifactText,
      contextMd,
      cwd: ctx.projectPath,
      signal: ctx.signal,
    });

    const failed =
      critiqueRes.stop_reason === "invalid_output" ||
      critiqueRes.stop_reason === "provider_error" ||
      !critiqueRes.parsed;

    if (!failed) {
      // Record the verdict under the model + provider that ACTUALLY judged.
      const verdict = critiqueRes.parsed as { outcome: VerdictOutcome; critique_md?: string; score?: unknown };
      const resolved = resolveVerdict({
        judge_outcome: verdict.outcome,
        scores: verdict.score,
        critique_md: verdict.critique_md,
      });
      const judgeProvider = selection.provider || undefined;
      const judgeProducer = providerToProducer(selection.provider);
      if (!judgeProvider) {
        console.warn(`[pp/pilot] judge selection produced no provider for judge model "${judgeModelId}"; verdict will persist judge_provider=NULL and omit judge_provider from SSE frame`);
      }
      const rec = recordVerdict({
        attempt_id,
        judge_producer: judgeProducer,
        judge_model_id: judgeModelId,
        rubric_id: selection.rubric_id ?? undefined,
        outcome: resolved.outcome,
        critique_md: resolved.critique_md,
        score_json: resolved.score_json,
        judge_provider: judgeProvider,
        tokens_in: critiqueRes.tokens_in,
        tokens_out: critiqueRes.tokens_out,
        cost_usd: critiqueRes.cost_usd,
      });
      emit(
        ctx,
        "verdict.recorded",
        {
          outcome: resolved.outcome,
          judge_producer: judgeProducer,
          judge_model: judgeModelId,
          cross_vendor: rec.cross_vendor,
          escalated: selection.escalated && judgeModelId === selection.judge_model,
          rubric_id: selection.rubric_id,
          judge_provider: judgeProvider,
          ...(resolved.disagreed ? { judge_label: resolved.judge_label } : {}),
        },
        { stage_id, attempt_id },
      );
      return { outcome: resolved.outcome, critique_md: resolved.critique_md };
    }

    // Judge failed. Hop 1: de-escalate an escalated judge to the provider's
    // default model (same provider, cheaper/stabler model).
    if (deEscalationAvailable) {
      emit(
        ctx,
        "gate.blocked",
        { reason: `judge failover (de-escalate) after ${critiqueRes.stop_reason}`, gate_type: stage.gate_type, failover: true, from_model: judgeModelId, to_model: selection.default_model, provider: selection.provider },
        { stage_id },
      );
      judgeModelId = selection.default_model;
      deEscalationAvailable = false;
      continue;
    }

    // Hop 2: abandon this provider. Bounded to 2 providers total.
    excluded.push(selection.provider);
    if (providersTried >= 2) {
      archiveCritiqueFailure(ctx, stage_id, {
        reason: `judge failover exhausted after ${providersTried} providers (last stop_reason=${critiqueRes.stop_reason})`,
        kind: "critique_invalid",
        failure_archive_path: critiqueRes.session_file,
      });
      emit(ctx, "gate.blocked", { reason: "judge failover exhausted", judge_model: judgeModelId, gate_type: stage.gate_type }, { stage_id });
      return "abort";
    }
    let next: JudgeSelection;
    try {
      next = selectJudge(excluded);
    } catch (err) {
      if (err instanceof JudgeUnavailableError) {
        archiveCritiqueFailure(ctx, stage_id, { reason: err.message, kind: "judge_pool_empty" });
        emit(ctx, "gate.blocked", { reason: err.message, gate_type: stage.gate_type }, { stage_id });
        return "abort";
      }
      throw err;
    }
    emit(
      ctx,
      "gate.blocked",
      { reason: `judge failover (next provider) after ${critiqueRes.stop_reason}`, gate_type: stage.gate_type, failover: true, from_model: judgeModelId, to_model: next.judge_model, from_provider: selection.provider, to_provider: next.provider },
      { stage_id },
    );
    selection = next;
    judgeModelId = next.judge_model;
    deEscalationAvailable = next.escalated && next.default_model !== judgeModelId;
    providersTried++;
  }
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

/**
 * Per-section char caps for the retry judge's cumulative context (sum ≈ 8k).
 * The whole-stage diff gets the bulk; the prior critique and execution evidence
 * keep guaranteed room so a large diff can never crowd them out of the budget.
 */
const RETRY_CTX_DIFF_CAP = 4_700;
const RETRY_CTX_CRITIQUE_CAP = 2_500;
const RETRY_CTX_EVIDENCE_CAP = 800;
const RETRY_CTX_TRUNC = "\n…[truncated to fit judge context budget]";

/** heading + body, body truncated (with a marker) to `cap` total chars. */
function retryContextSection(heading: string, body: string, cap: number): string {
  const room = Math.max(0, cap - heading.length - 1 - RETRY_CTX_TRUNC.length);
  const trimmed = body.length > room ? body.slice(0, room) + RETRY_CTX_TRUNC : body;
  return `${heading}\n${trimmed}`;
}

/**
 * Build the cumulative context a Reflexion retry judge sees so it grades the
 * retry against the whole change since the stage started — with the prior
 * critique it claims to address and any recorded execution evidence — instead
 * of only the incremental diff between attempt 0's commit and the retry commit
 * (which made it re-flag resolved issues and miss regressions; code-gate retry
 * rescue was only 47%). Budgeted to ~8k chars with per-section truncation
 * markers. Returns undefined when no section has content, so the judge then
 * sees no Context block — byte-identical to a first attempt.
 */
export function buildRetryContext(
  ctx: RunContext,
  stage_id: string,
  stageBaseSha: string | null | undefined,
  priorCritique: string,
): string | undefined {
  const sections: string[] = [];

  // (a) The whole change since the stage started (harness paths excluded, same
  // exclusions as the archived attempt diff). Omitted with no base (post-hoc).
  const cumulativeDiff = stageBaseSha ? gitDiffRange(ctx.projectPath, stageBaseSha) : null;
  if (cumulativeDiff && cumulativeDiff.trim().length > 0) {
    sections.push(retryContextSection("## Cumulative diff since stage start", cumulativeDiff, RETRY_CTX_DIFF_CAP));
  }

  // (b) The failed verdict's critique — the retry claims to address it.
  if (priorCritique.trim().length > 0) {
    sections.push(
      retryContextSection(
        "## Prior critique (the retry claims to address this — verify rather than re-flag)",
        priorCritique,
        RETRY_CTX_CRITIQUE_CAP,
      ),
    );
  }

  // (c) Execution evidence: a recorded smoke/validator result for this stage.
  const smoke = Object.values(getSmokeResults(stage_id))[0];
  if (smoke) {
    const body = `status=${smoke.status}${smoke.reason ? `\nreason=${smoke.reason}` : ""}`;
    sections.push(retryContextSection("## Execution evidence", body, RETRY_CTX_EVIDENCE_CAP));
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

export async function reflexion(
  ctx: RunContext,
  stage: StageSpec,
  stage_id: string,
  parentAttemptId: string,
  initialTier: ClaudeTier,
  critique: string,
  /** The rejected attempt's output, injected as "Your previous attempt" context. */
  priorArtifactText?: string,
  /** budgetOverride: operator-audited bypass of the Reflexion ×1 budget (the
   * run-control retry endpoint's explicit override). The automatic in-run
   * path never sets it, so the invariant holds implicitly.
   * stageBaseSha: the stage's ORIGINAL base sha (captured before attempt 0's
   * auto-commit) so the retry judge sees the cumulative diff since stage start.
   * Absent on post-hoc retries — the whole-stage diff section is then omitted.
   * automatic: true ONLY for the in-run automatic retry (runStage's own
   * fail/revise → reflexion calls). Exempts this call from the run-wide loop
   * ceiling (see checkRetryEligible's `automatic` doc) so early-stage judge
   * calls elsewhere in the run can never silently consume the one automatic
   * Reflexion attempt this stage is entitled to. post-hoc.ts's manual
   * `retryStage` MUST leave this unset — manual retries keep the ceiling
   * (with budgetOverride as the deliberate bypass). */
  opts?: { budgetOverride?: boolean; stageBaseSha?: string | null; automatic?: boolean },
): Promise<StageOutcome> {
  const eligible = checkRetryEligible({
    attempt_id: parentAttemptId,
    budget_override: opts?.budgetOverride === true,
    automatic: opts?.automatic === true,
  });
  if (!eligible.ok) {
    return surface(ctx, stage_id, `Reflexion not eligible: ${eligible.reason}`);
  }

  // Reflexion is the single retry (attempt index 1), so rotationIndex=1 draws
  // the NEXT model from the escalated tier's pool (pool[0] was the first
  // attempt). No pool configured → the index is ignored, model id unchanged.
  const esc = escalateTierForRetry(initialTier, ctx.flags, "retry", 1, ctx.ladderOverride);
  ctx.tierTrace.push({
    stage_kind: stage.kind,
    agent: stage.agent,
    initial_tier: initialTier,
    model_id: esc.model_id,
    trace: [esc.trace],
  });
  reArchiveTierDecisions(ctx);
  emit(ctx, "reflexion.retry", { initial_tier: initialTier, retry_tier: esc.tier, critique_excerpt: critique.slice(0, 240) }, { stage_id });

  // The retry generator keeps its prior-critique/prior-attempt blocks AND is
  // shown the same rubric it will be judged against (resolved here so post-hoc
  // retries — which enter via this function directly — get it too).
  const rubricMd = resolveStageRubricMd(ctx, stage, esc.model_id);
  const gen1 = await generate(ctx, stage, stage_id, esc.model_id, esc.tier, 1, parentAttemptId, [critique], priorArtifactText, rubricMd);

  // Zero-change retry: HEAD genuinely didn't move (git failures no longer
  // read as zero-change). Surface with an honest reason — do not burn a judge
  // call on an empty diff. Note: a retry that verifies the prior attempt and
  // correctly changes nothing lands here too; the human reviews HEAD as-is.
  if (gen1.zeroChange) {
    return surface(
      ctx,
      stage_id,
      "code stage produced zero file changes after Reflexion ×1 — the retry session ran but committed no changes (it may have verified the prior attempt as already correct); review HEAD",
    );
  }

  // Give the retry judge cumulative context: the whole-stage diff, the prior
  // critique it claims to have addressed, and any execution evidence — so it
  // grades against the full change, not just the incremental attempt0→retry
  // diff (which made it re-flag resolved issues and miss regressions).
  const contextMd = buildRetryContext(ctx, stage_id, opts?.stageBaseSha, critique);
  const judged1 = await judge(ctx, stage, stage_id, gen1.attempt_id, esc.model_id, gen1.artifactText, true, contextMd);
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
