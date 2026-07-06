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
  finalizeRun,
  type Scope,
  type ClaudeTier,
} from "@pp/core";
import type { Engine } from "@pp/engine";
import { EventBus } from "./events.js";
import { JudgePolicy } from "./judge-policy.js";
import { emit, type RunContext, type StageSpec, type StageOutcome } from "./types.js";
import { judge, driveReadiness, finalizePassed, surface, reflexion } from "./phases/stage-loop.js";

export type PostHocResult = {
  ok: boolean;
  stage_id: string;
  outcome?: StageOutcome | "pass" | "fail" | "revise";
  reason?: string;
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

  const attempt = db()
    .prepare(`SELECT id, producer, model_id, attempted_tier, agent_type, artifact_path FROM attempts WHERE stage_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(opts.stageId) as
    | { id: string; producer: string; model_id: string; attempted_tier: string | null; agent_type: string | null; artifact_path: string | null }
    | undefined;
  if (!attempt) throw new Error(`stage ${opts.stageId} has no attempts to re-gate/retry`);

  const latestCritique = (db()
    .prepare(
      `SELECT v.critique_md AS c FROM verdicts v JOIN attempts a ON a.id = v.attempt_id
        WHERE a.stage_id = ? AND v.retracted_at IS NULL ORDER BY v.created_at DESC LIMIT 1`,
    )
    .get(opts.stageId) as { c: string | null } | undefined)?.c ?? "";

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
  };
}

/**
 * A post-hoc stage pass can clear the LAST blocker of a surfaced run: when no
 * stage remains un-passed, re-finalize the run so the run row doesn't read
 * "surfaced" forever after the operator fixed it. finalizeRun's own guards
 * (PP-VG-*) still apply — a downgrade is surfaced back to the caller's bus.
 */
function refinalizeRunIfClear(ctx: RunContext): void {
  const open = db()
    .prepare(`SELECT COUNT(*) AS n FROM stages WHERE run_id = ? AND status NOT IN ('passed', 'complete')`)
    .get(ctx.run_id) as { n: number };
  if (open.n > 0) return;
  const result = finalizeRun({ run_id: ctx.run_id, status: "complete" });
  emit(ctx, "run.finalized", {
    status: result.effective_status,
    requested_status: result.requested_status,
    post_hoc: true,
  });
}

/**
 * Judge-only re-run on a stage's most recent attempt (no regeneration). On a
 * fresh pass the stage is finalized passed; otherwise it is surfaced.
 */
export async function regateStage(opts: PostHocOptions): Promise<PostHocResult> {
  const r = reconstruct(opts);
  const judged = await judge(r.ctx, r.stage, opts.stageId, r.latestAttemptId, r.generatorModel, r.artifactText, false);
  if (judged === "abort") {
    return { ok: false, stage_id: opts.stageId, reason: "judge tool failure during re-gate" };
  }
  emit(r.ctx, "verdict.recorded", { outcome: judged.outcome, regate: true }, { stage_id: opts.stageId, attempt_id: r.latestAttemptId });

  if (judged.outcome === "pass") {
    const settled = await driveReadiness(r.ctx, r.stage, opts.stageId, r.latestAttemptId);
    if (settled.action === "finalize") {
      const outcome = await finalizePassed(r.ctx, r.stage, opts.stageId, r.latestAttemptId);
      refinalizeRunIfClear(r.ctx);
      return { ok: true, stage_id: opts.stageId, outcome };
    }
    const outcome = await surface(r.ctx, opts.stageId, settled.action === "surface" ? settled.reason : "re-gate blocked by finalize readiness");
    return { ok: true, stage_id: opts.stageId, outcome };
  }

  // fail / revise on re-gate: the stage stays open — the operator can /pp:retry.
  return { ok: true, stage_id: opts.stageId, outcome: judged.outcome };
}

/**
 * Reflexion ×1 retry of a stage: feed the last critique back to the generator,
 * escalate the tier, regenerate, re-judge, and finalize/surface.
 */
export async function retryStage(opts: PostHocOptions): Promise<PostHocResult> {
  const r = reconstruct(opts);
  if (!r.latestCritique) {
    return { ok: false, stage_id: opts.stageId, reason: "no critique on record to drive a Reflexion retry" };
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
  if (outcome === "passed") refinalizeRunIfClear(r.ctx);
  return { ok: outcome !== "aborted", stage_id: opts.stageId, outcome };
}
