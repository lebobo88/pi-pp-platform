/**
 * Post-hoc stage operations for the server run-control routes.
 *
 * - regateStage: re-run ONLY the judge on a stage's most recent attempt (no
 *   regeneration) — the `/pp:gate` behavior. Used when a rubric changed or the
 *   operator wants a fresh verdict.
 * - retryStage: Reflexion ×1 retry of a surfaced stage — feed the last critique
 *   back to the generator, escalate the tier, regenerate, re-judge — the
 *   `/pp:retry` behavior.
 *
 * Both reconstruct a minimal RunContext + StageSpec from the persisted ledger so
 * they can reuse the exact tested stage-loop internals (judge / reflexion /
 * finalize readiness / VG gates). The server (M5d) calls these instead of
 * duplicating judge selection or reporting eligibility only.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  db,
  loadProjectProfile,
  isClaudeTier,
  log,
  type Scope,
  type ClaudeTier,
} from "@pp/core";
import type { Engine } from "@pp/engine";
import { EventBus } from "./events.js";
import { JudgePolicy } from "./judge-policy.js";
import { emit, type RunContext, type StageSpec, type StageOutcome } from "./types.js";
import { judge, driveReadiness, finalizePassed, surface, reflexion } from "./phases/stage-loop.js";
import { resumeRun } from "./resume.js";

export type PostHocResult = {
  ok: boolean;
  stage_id: string;
  outcome?: StageOutcome | "pass" | "fail" | "revise";
  reason?: string;
  /**
   * What the retry route actually did: "retry" = a Reflexion ×1 regenerate;
   * "gate" = smart /pp:retry recognized the latest attempt already carries a
   * real (unverdicted) artifact and re-judged it instead of regenerating.
   * Surfaced by run-control so the client shows the correct action.
   */
  action?: "retry" | "gate";
};

export type PostHocOptions = {
  stageId: string;
  engine: Engine;
  bus?: EventBus;
  signal?: AbortSignal;
  /** Operator override of the Reflexion ×1 budget (deliberate, audited by the
   * caller). Without it a retry on an exhausted stage surfaces immediately. */
  override?: boolean;
};

type Reconstructed = {
  ctx: RunContext;
  stage: StageSpec;
  latestAttemptId: string;
  generatorModel: string;
  initialTier: ClaudeTier;
  artifactText: string;
  latestCritique: string;
  /** Status of the chosen (latest non-error) attempt. */
  latestAttemptStatus: string;
  /** Whether the chosen attempt produced a real artifact (not "commit none"). */
  latestHasRealArtifact: boolean;
  /** Non-retracted verdict count on this stage's attempts. */
  verdictCount: number;
};

function gitDiffHead(cwd: string): string | null {
  try {
    return execFileSync("git", ["show", "--stat", "--patch", "HEAD"], { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** Rebuild the RunContext + StageSpec needed to drive a post-hoc op on a stage. */
function reconstruct(opts: PostHocOptions): Reconstructed {
  const stageRow = db()
    .prepare(`SELECT id, run_id, kind, gate_type FROM stages WHERE id = ?`)
    .get(opts.stageId) as { id: string; run_id: string; kind: string; gate_type: string } | undefined;
  if (!stageRow) throw new Error(`stage ${opts.stageId} not found`);

  const run = db()
    .prepare(`SELECT project_path, request_text, taxonomy_mapping_json FROM runs WHERE id = ?`)
    .get(stageRow.run_id) as { project_path: string; request_text: string; taxonomy_mapping_json: string | null } | undefined;
  if (!run) throw new Error(`run ${stageRow.run_id} not found`);

  // Prefer the latest NON-ERROR attempt: an errored (provider quota/rate)
  // attempt carries no real artifact, so a post-hoc regate/retry must operate
  // on the last attempt that actually produced something. `(status='error')
  // ASC` sorts non-error rows first; created_at DESC then picks the most recent.
  const attempt = db()
    .prepare(`SELECT id, producer, model_id, attempted_tier, agent_type, artifact_path, status FROM attempts WHERE stage_id = ? ORDER BY (status='error') ASC, created_at DESC, rowid DESC LIMIT 1`)
    .get(opts.stageId) as
    | { id: string; producer: string; model_id: string; attempted_tier: string | null; agent_type: string | null; artifact_path: string | null; status: string }
    | undefined;
  if (!attempt) throw new Error(`stage ${opts.stageId} has no attempts to re-gate/retry`);

  const latestCritique = (db()
    .prepare(
      `SELECT v.critique_md AS c FROM verdicts v JOIN attempts a ON a.id = v.attempt_id
        WHERE a.stage_id = ? AND v.retracted_at IS NULL ORDER BY v.created_at DESC LIMIT 1`,
    )
    .get(opts.stageId) as { c: string | null } | undefined)?.c ?? "";

  // Non-retracted verdict count across the stage's attempts — used by smart
  // /pp:retry to detect a real-but-unjudged attempt (route to gate, not retry).
  const verdictCount = (db()
    .prepare(
      `SELECT COUNT(*) AS n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id
        WHERE a.stage_id = ? AND v.retracted_at IS NULL`,
    )
    .get(opts.stageId) as { n: number }).n;
  const latestHasRealArtifact =
    attempt.status !== "error" && !(attempt.artifact_path ?? "").includes("commit none");

  const artifactDir = join(run.project_path, ".harness", stageRow.run_id);
  const profile = loadProjectProfile(run.project_path);

  // Reconstruct the artifact text: prefer the archived artifact file, else the
  // committed git diff for coding stages.
  let artifactText = "";
  const artRow = db()
    .prepare(`SELECT path FROM artifacts WHERE stage_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(opts.stageId) as { path: string } | undefined;
  if (artRow) {
    const abs = join(run.project_path, artRow.path);
    if (existsSync(abs)) artifactText = readFileSync(abs, "utf8");
  }
  if (!artifactText) artifactText = gitDiffHead(run.project_path) ?? "";

  const scope: Scope = (() => {
    try {
      const m = run.taxonomy_mapping_json ? (JSON.parse(run.taxonomy_mapping_json) as { scope?: Scope }) : null;
      return m?.scope ?? "standard";
    } catch {
      return "standard";
    }
  })();

  const tier: ClaudeTier = attempt.attempted_tier && isClaudeTier(attempt.attempted_tier) ? attempt.attempted_tier : "sonnet";

  const ctx: RunContext = {
    run_id: stageRow.run_id,
    artifact_dir: artifactDir,
    started_at: new Date().toISOString(),
    projectPath: run.project_path,
    requestText: run.request_text,
    mode: "single",
    flags: {},
    engine: opts.engine,
    bus: opts.bus ?? new EventBus(),
    judgePolicy: new JudgePolicy(),
    clock: () => Date.now(),
    signal: opts.signal,
    scope,
    signals: [],
    sections: [],
    missabilityRequired: [],
    profile,
    profileName: profile?.name,
    stageArtifacts: [],
    tierTrace: [],
    finalStatus: "complete",
  };

  const stage: StageSpec = {
    kind: stageRow.kind,
    gate_type: stageRow.gate_type,
    agent: attempt.agent_type ?? "engineer",
  };

  return {
    ctx,
    stage,
    latestAttemptId: attempt.id,
    generatorModel: attempt.model_id,
    initialTier: tier,
    artifactText,
    latestCritique,
    latestAttemptStatus: attempt.status,
    latestHasRealArtifact,
    verdictCount,
  };
}

/**
 * A post-hoc stage pass can clear the LAST blocker of a surfaced run — not
 * just its own stage, but every remaining planned stage plus the completion
 * phases (missability/master-plan/finalize). Delegate to the shared
 * `resumeRun` flow (packages/pilot/src/resume.ts) rather than a shallow
 * `finalizeRun({status:"complete"})`: resumeRun's own readiness check
 * (`getRunCompletionReadiness`) already uses the correct terminal-status
 * predicate (`'surfaced'`/`'open'` block; `'passed'`/`'skipped'` do not) and
 * continues any stages this repair didn't touch, instead of only re-checking
 * finalize eligibility.
 *
 * If the run isn't actually `'surfaced'` (e.g. this regate/retry ran against
 * an already-`'complete'` run, or the run is still mid-execution), resumeRun's
 * atomic claim is simply a no-op (`resumed: false`) — nothing to do here.
 */
async function refinalizeRunIfClear(ctx: RunContext): Promise<void> {
  try {
    const result = await resumeRun({ runId: ctx.run_id, engine: ctx.engine, bus: ctx.bus, signal: ctx.signal });
    if (result.resumed) {
      emit(ctx, "run.finalized", {
        status: result.status,
        requested_status: "complete",
        post_hoc: true,
      });
    }
  } catch (e) {
    // A finalize guard (PP-VG-*) refusing "complete", or any other resume
    // failure, must not fail the regate/retry HTTP request that merely
    // triggered the recheck — the run simply stays in its current status and
    // the reason is logged.
    log.warn({ err: e }, "[pilot] post-hoc run resume blocked");
  }
}

/**
 * Judge-only re-run on a stage's most recent attempt (no regeneration). On a
 * fresh pass the stage is finalized passed; otherwise it is surfaced.
 */
export async function regateStage(opts: PostHocOptions): Promise<PostHocResult> {
  const r = reconstruct(opts);
  const stageWasPassed =
    ((db().prepare(`SELECT status FROM stages WHERE id = ?`).get(opts.stageId) as { status?: string } | undefined)
      ?.status ?? "") === "passed";
  const judged = await judge(r.ctx, r.stage, opts.stageId, r.latestAttemptId, r.generatorModel, r.artifactText, false);
  if (judged === "abort") {
    return { ok: false, stage_id: opts.stageId, reason: "judge tool failure during re-gate" };
  }
  emit(r.ctx, "verdict.recorded", { outcome: judged.outcome, regate: true }, { stage_id: opts.stageId, attempt_id: r.latestAttemptId });

  if (judged.outcome === "pass") {
    // Already-finalized stage + fresh pass: there is nothing to re-drive —
    // readiness would refuse a second finalize and the fallback used to
    // DEMOTE the passed stage to surfaced. Record the concurring verdict and
    // let the run row catch up to stage reality.
    if (stageWasPassed) {
      await refinalizeRunIfClear(r.ctx);
      return { ok: true, stage_id: opts.stageId, outcome: "passed" };
    }
    const settled = await driveReadiness(r.ctx, r.stage, opts.stageId, r.latestAttemptId);
    if (settled.action === "finalize") {
      const outcome = await finalizePassed(r.ctx, r.stage, opts.stageId, r.latestAttemptId);
      await refinalizeRunIfClear(r.ctx);
      return { ok: true, stage_id: opts.stageId, outcome };
    }
    const outcome = await surface(r.ctx, opts.stageId, settled.action === "surface" ? settled.reason : "re-gate blocked by finalize readiness");
    return { ok: true, stage_id: opts.stageId, outcome };
  }

  // fail / revise on re-gate: the stage's status is untouched (a passed stage
  // stays passed — the dissenting verdict is recorded, not enforced). The run
  // row must still track stage reality: if every stage is passed, finalize.
  await refinalizeRunIfClear(r.ctx);
  return { ok: true, stage_id: opts.stageId, outcome: judged.outcome };
}

/**
 * Reflexion ×1 retry of a stage: feed the last critique back to the generator,
 * escalate the tier, regenerate, re-judge, and finalize/surface.
 */
export async function retryStage(opts: PostHocOptions): Promise<PostHocResult> {
  const r = reconstruct(opts);

  // Smart /pp:retry: when the latest attempt already carries a REAL artifact
  // (not errored, not "commit none") but has NO non-retracted verdict, there is
  // nothing to regenerate — the attempt was simply never judged (e.g. an
  // errored judge on the prior pass, or an errored-attempt infra retry that
  // produced a real artifact). Re-judge it via regateStage instead of burning
  // the Reflexion slot, and surface `action:"gate"`.
  if (r.latestHasRealArtifact && r.verdictCount === 0) {
    const gated = await regateStage(opts);
    return { ...gated, action: "gate" };
  }

  if (!r.latestCritique) {
    return { ok: false, stage_id: opts.stageId, reason: "no critique on record to drive a Reflexion retry", action: "retry" };
  }
  const outcome = await reflexion(
    r.ctx,
    r.stage,
    opts.stageId,
    r.latestAttemptId,
    r.initialTier,
    r.latestCritique,
    r.artifactText,
    { budgetOverride: opts.override === true },
  );
  if (outcome === "passed") await refinalizeRunIfClear(r.ctx);
  return { ok: outcome !== "aborted", stage_id: opts.stageId, outcome, action: "retry" };
}
