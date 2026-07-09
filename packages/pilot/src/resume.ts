/**
 * Run-level resume — reopens a `surfaced`/blocked run on the SAME `run_id`:
 * continues any remaining planned stages, then reruns
 * missability/master-plan/finalize. Never forks a child run.
 *
 * `finalizeRun` (packages/core) always releases the project's advisory lock
 * on every terminal write (complete/surfaced/aborted alike), so resuming a
 * stopped run means re-acquiring that lock before touching the working tree
 * again — mirroring `startRun`'s own acquire — and releasing it again when
 * this resume attempt's own finalize completes or errors out.
 *
 * Decision tree (see plan.md, "Key Changes §4"):
 *   1. getRunCompletionReadiness first — surfaced/open stages are a hard
 *      stop; do not guess. No writes.
 *   2. Atomic `UPDATE runs SET status='running' WHERE status='surfaced'` —
 *      the DB-level half of the resume race guard (the in-process
 *      RunSupervisor.active-map check is the other half, added with the
 *      HTTP route).
 *   3. Rehydrate a RunContext from persisted snapshots (taxonomy mapping,
 *      profile, stage plan, prior passed-stage artifacts). On failure,
 *      revert the status transition back to 'surfaced'.
 *   4. Continue any remaining planned stages (persisted plan wins; a legacy
 *      run with no persisted plan reconstructs one deterministically).
 *   5. Rerun missability → (if passed) master-plan → finalize, exactly
 *      mirroring the tail of RunPilot.execute().
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  db,
  getTeam,
  getRunCompletionReadiness,
  claimRunForResume,
  persistStagePlan,
  ProjectLock,
  ProjectLockBusyError,
  forceUnlock,
  type ProfileSpec,
  type Scope,
  type RunStatus,
} from "@pp/core";
import type { Engine } from "@pp/engine";
// @ts-ignore TS6059: shared wire contract source lives outside @pp/pilot's rootDir.
import type { CompletionReadinessResponse, RunResumeResponse } from "../../../shared/api-types.js";
import { EventBus } from "./events.js";
import { JudgePolicy } from "./judge-policy.js";
import { emit, type RunContext, type RunMode, type StageSpec } from "./types.js";
import { buildStagePlan, dispatchStage } from "./run-pilot.js";
import { reconcilePlanWithRequirements } from "./phases/plan-reconciliation.js";
import { runMissabilityPhase } from "./phases/missability.js";
import { runMasterPlanPhase } from "./phases/master-plan.js";
import { runFinalizePhase, type StageReport } from "./phases/finalize.js";

export type ResumeOpts = {
  runId: string;
  engine: Engine;
  bus?: EventBus;
  signal?: AbortSignal;
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

function currentStatus(runId: string): RunStatus {
  const row = db().prepare(`SELECT status FROM runs WHERE id = ?`).get(runId) as { status: RunStatus } | undefined;
  return row?.status ?? "surfaced";
}

/**
 * Rehydrate `ctx.stageArtifacts` (only `.kind`/`.text` are ever read
 * downstream — `.agent`/`.path` are stored but unused, see stage-loop.ts's
 * `upstreamArtifacts` mapping) from every PASSED predecessor stage, plus a
 * `StageReport[]` covering every stage row this run has ever produced (so
 * `buildSummary` reflects the run's full history, not just this resume call
 * — the stale-summary fix) and the set of plan indexes that already have a
 * terminal (passed/surfaced/skipped) row.
 */
function rehydrateStageHistory(
  runId: string,
  projectPath: string,
): {
  stageArtifacts: RunContext["stageArtifacts"];
  stageReports: StageReport[];
  coveredPlanIndexes: Set<number>;
} {
  const rows = db()
    .prepare(
      `SELECT id AS stage_id, kind, status, plan_index FROM stages
       WHERE run_id = ? ORDER BY plan_index ASC, started_at ASC, rowid ASC`,
    )
    .all(runId) as Array<{ stage_id: string; kind: string; status: string; plan_index: number | null }>;

  const stageArtifacts: RunContext["stageArtifacts"] = [];
  const stageReports: StageReport[] = [];
  const coveredPlanIndexes = new Set<number>();

  for (const row of rows) {
    if (row.plan_index !== null) coveredPlanIndexes.add(row.plan_index);
    if (row.status === "passed" || row.status === "surfaced" || row.status === "skipped") {
      stageReports.push({ kind: row.kind, outcome: row.status, stage_id: row.stage_id });
    }
    if (row.status !== "passed") continue;

    const winner = db()
      .prepare(
        `SELECT a.agent_type AS agent_type FROM stages s
         LEFT JOIN attempts a ON a.id = s.winner_attempt_id
         WHERE s.id = ?`,
      )
      .get(row.stage_id) as { agent_type: string | null } | undefined;
    const artRow = db()
      .prepare(`SELECT path FROM artifacts WHERE stage_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(row.stage_id) as { path: string } | undefined;

    let text = "";
    if (artRow) {
      const abs = join(projectPath, artRow.path);
      if (existsSync(abs)) text = readFileSync(abs, "utf8");
    }
    if (!text) text = gitDiffHead(projectPath) ?? "";

    stageArtifacts.push({ kind: row.kind, agent: winner?.agent_type ?? row.kind, path: artRow?.path ?? "", text });
  }

  return { stageArtifacts, stageReports, coveredPlanIndexes };
}

type ReconstructResult =
  | {
      ok: true;
      ctx: RunContext;
      plan: StageSpec[];
      stageReports: StageReport[];
      coveredPlanIndexes: Set<number>;
    }
  | { ok: false; reason: string };

/**
 * Rebuild the RunContext + ordered stage plan needed to continue a run.
 * Distinct from post-hoc.ts's `reconstruct()` (stage-scoped, hard-codes
 * empty `stageArtifacts`/`sections`/`missabilityRequired` — correct for a
 * single judge-only regate/retry, but wrong here: a run-level resume that
 * continues later stages or reruns missability/master-plan needs the exact
 * upstream artifacts and taxonomy snapshot the original unbroken pass would
 * have carried forward, or those downstream steps silently do nothing).
 */
function reconstructRunContextForResume(
  runId: string,
  opts: { engine: Engine; bus: EventBus; signal?: AbortSignal },
): ReconstructResult {
  const run = db()
    .prepare(
      `SELECT project_path, request_text, mode, team, forum, status,
              profile_snapshot_json, taxonomy_mapping_json, stage_plan_json, started_at
       FROM runs WHERE id = ?`,
    )
    .get(runId) as
    | {
        project_path: string;
        request_text: string;
        mode: string;
        team: string | null;
        forum: string | null;
        status: string;
        profile_snapshot_json: string | null;
        taxonomy_mapping_json: string | null;
        stage_plan_json: string | null;
        started_at: string;
      }
    | undefined;
  if (!run) return { ok: false, reason: `run ${runId} not found` };

  type TaxonomySnapshot = {
    scope: Scope;
    signals: string[];
    sections: RunContext["sections"];
    missability_required: string[];
  };
  let taxonomy: TaxonomySnapshot | null = null;
  try {
    taxonomy = run.taxonomy_mapping_json ? (JSON.parse(run.taxonomy_mapping_json) as TaxonomySnapshot) : null;
  } catch {
    taxonomy = null;
  }
  if (!taxonomy) {
    return { ok: false, reason: "taxonomy_mapping_json is missing or malformed — cannot safely resume" };
  }

  let profile: ProfileSpec | null = null;
  try {
    profile = run.profile_snapshot_json ? (JSON.parse(run.profile_snapshot_json) as ProfileSpec) : null;
  } catch {
    return { ok: false, reason: "profile_snapshot_json is malformed — cannot safely resume" };
  }

  const ctx: RunContext = {
    run_id: runId,
    artifact_dir: join(run.project_path, ".harness", runId),
    started_at: run.started_at,
    projectPath: run.project_path,
    requestText: run.request_text,
    mode: run.mode as RunMode,
    teamName: run.team ?? undefined,
    forum: run.forum ?? undefined,
    flags: {},
    engine: opts.engine,
    bus: opts.bus,
    judgePolicy: new JudgePolicy(),
    clock: () => Date.now(),
    signal: opts.signal,
    scope: taxonomy.scope,
    signals: taxonomy.signals,
    sections: taxonomy.sections,
    missabilityRequired: taxonomy.missability_required,
    profile,
    profileName: profile?.name,
    stageArtifacts: [],
    tierTrace: [],
    finalStatus: "complete",
  };

  if (ctx.mode === "team" && ctx.teamName) {
    // buildStagePlan re-resolves the team for the legacy-reconstruction path
    // below anyway; resolving it here too keeps a persisted-plan resume's
    // early abort message accurate if the team yaml no longer exists.
    // ctx.team itself is otherwise unused downstream (only ever set, never
    // read, in run-pilot.ts) so a resolution failure here is advisory only
    // for the persisted-plan path and a hard stop only for legacy plans
    // (handled inside buildStagePlan itself).
    const found = getTeam({ name: ctx.teamName, project_path: ctx.projectPath });
    if (found) ctx.team = found.team;
  }

  const { stageArtifacts, stageReports, coveredPlanIndexes } = rehydrateStageHistory(runId, run.project_path);
  ctx.stageArtifacts = stageArtifacts;

  // ── Resolve the ordered plan. ─────────────────────────────────────────
  if (run.stage_plan_json !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.stage_plan_json);
    } catch {
      return { ok: false, reason: "stage_plan_json is malformed — cannot safely resume" };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: "stage_plan_json is not an array — cannot safely resume" };
    }
    return { ok: true, ctx, plan: parsed as StageSpec[], stageReports, coveredPlanIndexes };
  }

  // Legacy run (predates stage_plan_json): reconstruct deterministically the
  // same way RunPilot.execute() builds + reconciles a fresh plan, fed from
  // the persisted snapshots above (never live files) — mirrors the
  // fail-closed snapshot discipline VG-2/VG-4 already use.
  const rawPlan = buildStagePlan(ctx, {});
  if (rawPlan.abort) {
    return { ok: false, reason: `legacy plan reconstruction failed: ${rawPlan.reason}` };
  }
  const reconciled = ctx.mode === "team" ? reconcilePlanWithRequirements(ctx, rawPlan.stages) : rawPlan;
  if (reconciled.abort) {
    return { ok: false, reason: `legacy plan reconstruction failed: ${reconciled.reason}` };
  }
  const plan = reconciled.stages;

  // Positional fallback: a truly legacy run's existing stage rows all have
  // plan_index = NULL (the migration is additive-only, no backfill), so
  // `coveredPlanIndexes` is empty even though stages already executed. Those
  // rows ran, in chronological order, as the first N slots of whatever plan
  // the OLD code built — the only order they could have executed in before
  // plan_index existed. Verify each slot's `kind` actually matches the
  // freshly reconstructed plan before trusting the positional guess; a
  // mismatch means reconstruction has diverged from what really ran, and
  // resume must refuse rather than silently re-run (duplicate) or skip
  // (silently drop) a stage.
  if (coveredPlanIndexes.size === 0 && stageReports.length > 0) {
    for (let i = 0; i < stageReports.length; i++) {
      const report = stageReports[i];
      const planSlot = plan[i];
      if (!report || report.kind !== planSlot?.kind) {
        return {
          ok: false,
          reason:
            `legacy run's executed stage #${i} (kind="${report?.kind ?? "none"}") does not match the ` +
            `reconstructed plan slot ${i} (kind="${planSlot?.kind ?? "none"}") — plan reconstruction ` +
            `diverges from execution history; cannot safely resume`,
        };
      }
      coveredPlanIndexes.add(i);
    }
    // Backfill plan_index on the existing rows now that positional alignment
    // is verified, so future readiness/resume calls no longer need to guess.
    for (let i = 0; i < stageReports.length; i++) {
      const stageId = stageReports[i]?.stage_id;
      if (stageId) db().prepare(`UPDATE stages SET plan_index = ? WHERE id = ?`).run(i, stageId);
    }
  }

  // Persist the reconstructed (and now positionally-verified) plan so this
  // run becomes fully v10-compliant from here on — future readiness/resume
  // calls read a real stage_plan_json instead of re-deriving it every time.
  plan.forEach((s, i) => {
    s.planIndex = i;
  });
  persistStagePlan(runId, plan);

  return { ok: true, ctx, plan, stageReports, coveredPlanIndexes };
}

/**
 * Reopen a surfaced/blocked run on the same `run_id`. See the module
 * docblock for the full decision tree.
 */
export async function resumeRun(opts: ResumeOpts): Promise<RunResumeResponse> {
  const { runId } = opts;
  const bus = opts.bus ?? new EventBus();

  // 1. Read-only readiness check first — no writes.
  const readiness = getRunCompletionReadiness(runId) as unknown as CompletionReadinessResponse;
  if (readiness.surfaced_stages.length > 0 || readiness.incomplete_stages.length > 0 || !readiness.resumable) {
    return { run_id: runId, status: currentStatus(runId), resumed: false, readiness };
  }

  // 2. Atomic status-transition guard — the DB-level half of the resume race
  // guard (the server route's in-process RunSupervisor.active-map check is
  // the other half, added with the HTTP route).
  if (!claimRunForResume(runId)) {
    return { run_id: runId, status: currentStatus(runId), resumed: false, readiness };
  }

  const projectPath = (
    db().prepare(`SELECT project_path FROM runs WHERE id = ?`).get(runId) as { project_path: string }
  ).project_path;

  // 3. Re-acquire the project lock — finalizeRun always releases it on every
  // terminal write, so a resumed run must reclaim it before touching the
  // working tree again.
  try {
    new ProjectLock(projectPath).acquireOrReapStale();
  } catch (err) {
    // No forward progress was made — revert the status transition so the
    // run stays a recoverable 'surfaced' dead end rather than dangling in
    // 'running' with nothing actually resumed.
    db().prepare(`UPDATE runs SET status = 'surfaced' WHERE id = ?`).run(runId);
    const reason =
      err instanceof ProjectLockBusyError
        ? "project lock is held by another active run — cannot resume concurrently"
        : `failed to acquire project lock: ${(err as Error).message}`;
    return {
      run_id: runId,
      status: "surfaced",
      resumed: false,
      readiness: { ...readiness, resumable: false, blocking_reason: reason },
    };
  }

  emit({ bus, run_id: runId }, "run.context", { phase: "resume", status: "running" });

  try {
    // 4. Rehydrate the run context.
    const reconstructed = reconstructRunContextForResume(runId, {
      engine: opts.engine,
      bus,
      signal: opts.signal,
    });
    if (!reconstructed.ok) {
      db().prepare(`UPDATE runs SET status = 'surfaced' WHERE id = ?`).run(runId);
      return {
        run_id: runId,
        status: "surfaced",
        resumed: false,
        readiness: { ...readiness, resumable: false, blocking_reason: reconstructed.reason },
      };
    }
    const { ctx, plan, stageReports, coveredPlanIndexes } = reconstructed;
    ctx.finalStatus = "complete"; // optimistic; downgraded below by any surfaced/aborted outcome

    // 5. Continue any remaining planned stages.
    for (let i = 0; i < plan.length; i++) {
      if (coveredPlanIndexes.has(i)) continue;
      if (ctx.signal?.aborted) {
        ctx.finalStatus = "aborted";
        ctx.abortReason = "aborted by signal";
        break;
      }
      const stage = plan[i];
      if (!stage) continue; // defensive: sparse/short plan array (should not happen)
      stage.planIndex = i;
      const outcome = await dispatchStage(ctx, stage);
      stageReports.push({ kind: stage.kind, outcome });
      if (outcome === "aborted") {
        ctx.finalStatus = "aborted";
        break;
      }
      if (outcome === "surfaced") {
        ctx.finalStatus = "surfaced";
        break; // surface halts the pipeline, same as RunPilot.execute()
      }
    }

    // 6. Completion phases — only when every stage is clear.
    if (ctx.finalStatus === "complete") {
      const missability = runMissabilityPhase(ctx);
      if (missability.passed) runMasterPlanPhase(ctx);
    }

    // 7. Finalize. stageReports covers the run's FULL history (rehydrated +
    // any newly-dispatched stages), so buildSummary's "What changed"/"What's
    // next" reflects current reality — a once-surfaced run that now passes
    // no longer leaves stale "needs follow-up" text behind.
    await runFinalizePhase(ctx, stageReports);

    return { run_id: runId, status: ctx.finalStatus, resumed: true };
  } catch (err) {
    // Unexpected failure mid-resume: fold back to 'surfaced' (a recoverable
    // dead end per Goal 1) rather than leaving the run dangling in 'running'.
    try {
      db().prepare(`UPDATE runs SET status = 'surfaced' WHERE id = ?`).run(runId);
    } catch {
      /* best-effort */
    }
    return {
      run_id: runId,
      status: "surfaced",
      resumed: false,
      readiness: { ...readiness, resumable: false, blocking_reason: (err as Error).message },
    };
  } finally {
    // Belt-and-suspenders: finalizeRun releases the lock on every non-crash
    // path, but release again in case we bailed before finalize.
    try {
      forceUnlock(projectPath);
    } catch {
      /* ignore */
    }
  }
}
