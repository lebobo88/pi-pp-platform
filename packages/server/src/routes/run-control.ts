/**
 * Run-control mutations, live via the RunSupervisor:
 *   POST /runs                         — start a run (detached; returns run_id)
 *   POST /runs/:id/abort               — abort a live run
 *   POST /runs/:id/stages/:sid/retry   — Reflexion-honoring manual retry (eligibility)
 *   POST /runs/:id/stages/:sid/gate    — re-judge only (engine critique → recordVerdict)
 */
import { execFileSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { registerProject, ProjectDirNotFoundError, checkRetryEligible, db } from "@pp/core";
import { retryStage, regateStage, EventBus, type PilotEvent } from "@pp/pilot";
import { V1, type ServerDeps } from "../deps.js";

/**
 * Ensure the project is a git repo — worktrees, diff capture, and coding stages
 * all need one. Best-effort: a fresh project directory is initialized with an
 * initial commit so HEAD exists. Never blocks the run.
 */
function ensureGitRepo(path: string): void {
  try {
    execFileSync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
    return; // already a repo
  } catch {
    /* not a repo — initialize below */
  }
  try {
    execFileSync("git", ["-C", path, "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", path, "add", "-A"], { stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.email=pp@local", "-c", "user.name=pi-pp-platform", "-C", path,
       "commit", "-m", "initial commit (pi-pp-platform)", "--allow-empty"],
      { stdio: "ignore" },
    );
  } catch {
    /* best-effort — the pilot degrades gracefully if git remains unavailable */
  }
}

const TIER = z.enum(["haiku", "sonnet", "opus", "fable"]);
const StartBody = z.object({
  project_path: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  request_text: z.string().min(1),
  mode: z.enum(["single", "team", "best_of", "review"]),
  team: z.string().optional(),
  forum: z.string().optional(),
  n: z.number().int().min(2).max(8).optional(),
  scope_override: z.enum(["trivial", "standard", "major"]).optional(),
  tier_cap: TIER.optional(),
  tier_floor: TIER.optional(),
  no_tier_policy: z.boolean().optional(),
  // Per-run effective-ladder overrides (top precedence). Partial tier→model /
  // tier→pool maps; forwarded to the pilot and persisted to runs.cli_flags_json.
  ladder_override: z.record(TIER, z.string().min(1)).optional(),
  tier_pools_override: z.record(TIER, z.array(z.string().min(1)).min(1)).optional(),
});

/** A fresh pilot EventBus whose events are forwarded to the server SSE bus. */
function bridgeBus(deps: ServerDeps): EventBus {
  const eb = new EventBus();
  eb.subscribe((ev: PilotEvent) =>
    deps.bus.publish({
      type: ev.type,
      run_id: ev.run_id,
      data: { ...ev.data, stage_id: ev.stage_id, attempt_id: ev.attempt_id, pilot_seq: ev.seq },
    }),
  );
  return eb;
}

function runIdForStage(stageId: string): string | null {
  const row = db().prepare("SELECT run_id FROM stages WHERE id = ?").get(stageId) as { run_id: string } | undefined;
  return row?.run_id ?? null;
}

export function registerRunControlRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // ── Start ──
  app.post(`${V1}/runs`, async (req, reply) => {
    const parsed = StartBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(422).send({ error: "validation failed", details: parsed.error.flatten() });
    }
    const b = parsed.data;

    // Mirror the pilot rule: best-of uses a fixed rotation; tier flags are rejected.
    if (b.mode === "best_of" && (b.tier_cap || b.tier_floor || b.no_tier_policy)) {
      return reply.code(422).send({
        error: "validation failed",
        details: { tier: "best-of-N ignores tier flags; re-run without --tier-cap/--tier-floor/--no-tier-policy or use mode=single/team" },
      });
    }
    if (b.mode === "team" && !b.team) return reply.code(422).send({ error: "validation failed", details: { team: "required for mode=team" } });
    if (b.mode === "review" && !b.forum) return reply.code(422).send({ error: "validation failed", details: { forum: "required for mode=review" } });

    const path = b.project_path ?? b.project_id;
    if (!path) return reply.code(422).send({ error: "validation failed", details: { project_path: "project_path or project_id required" } });

    // Auto-register the project (idempotent). Choice: an unregistered path is
    // registered on first run rather than 404'd, so the launch wizard can start
    // a run against a fresh path without a separate registration step.
    try {
      registerProject({ path });
    } catch (err) {
      if (err instanceof ProjectDirNotFoundError) {
        return reply.code(404).send({ error: "project_not_found", details: err.message });
      }
      throw err;
    }

    // A new project directory may not be a git repo yet — worktrees/diffs need one.
    ensureGitRepo(path);

    try {
      const { run_id, queued } = await deps.supervisor.start({
        projectPath: path,
        requestText: b.request_text,
        mode: b.mode,
        team: b.team,
        forum: b.forum,
        n: b.n,
        scopeOverride: b.scope_override,
        tierCap: b.tier_cap,
        tierFloor: b.tier_floor,
        noTierPolicy: b.no_tier_policy,
        ladderOverride: b.ladder_override,
        tierPoolsOverride: b.tier_pools_override,
      });
      return reply.code(200).send({ run_id, queued });
    } catch (err) {
      return reply.code(409).send({ error: "run_start_failed", details: (err as Error).message });
    }
  });

  // ── Abort ──
  app.post(`${V1}/runs/:id/abort`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = deps.supervisor.abort(id);
    if (!ok) return reply.code(404).send({ error: "run_not_active", run_id: id });
    return reply.code(202).send({ run_id: id, status: "aborted" });
  });

  // ── Manual retry (Reflexion ×1) — drives the pilot's retryStage helper ──
  // The Reflexion ×1 invariant is the enforced DEFAULT: a stage whose latest
  // attempt already retried returns 409. An operator may explicitly override
  // with `{ override: true }` (body) or `?override=true` — a deliberate, logged
  // human action. The daemon's AUTOMATIC retry path is never affected, so the
  // invariant is never broken implicitly.
  app.post(`${V1}/runs/:id/stages/:stageId/retry`, async (req, reply) => {
    const { id, stageId } = req.params as { id: string; stageId: string };
    if (!runIdForStage(stageId)) return reply.code(404).send({ error: "stage not found", stage_id: stageId });

    const body = (req.body ?? {}) as { override?: boolean };
    const query = (req.query ?? {}) as { override?: string };
    const override = body.override === true || query.override === "true" || query.override === "1";

    const att = db()
      .prepare("SELECT id FROM attempts WHERE stage_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(stageId) as { id: string } | undefined;
    if (!att) return reply.code(404).send({ error: "stage has no attempt to retry", stage_id: stageId });
    const elig = checkRetryEligible({ attempt_id: att.id });
    if (!elig.ok && !override) {
      // Not eligible and no override → keep the 409, but tell the client an
      // override is available so it can offer "retry anyway".
      return reply.code(409).send({
        error: "retry_exhausted",
        reason: elig.reason,
        override_available: true,
      });
    }

    const overridden = !elig.ok && override;
    if (overridden) {
      // Audit the deliberate bypass of the Reflexion ×1 budget.
      req.log.warn(
        { run_id: id, stage_id: stageId, attempt_id: att.id, reason: elig.reason },
        "operator override: retrying a Reflexion-exhausted stage",
      );
    }

    // Actually re-drive the stage (critique fed back, tier +1, regenerate,
    // re-judge). The operator override must reach the pilot, or an exhausted
    // stage silently re-surfaces without ever generating.
    const res = await retryStage({ stageId, engine: deps.makeEngine(), bus: bridgeBus(deps), override: overridden });
    if (!res.ok) return reply.code(409).send({ error: "retry_unavailable", reason: res.reason });
    return reply.code(202).send({
      run_id: id,
      stage_id: stageId,
      action: "retry",
      ok: true,
      overridden,
      outcome: res.outcome,
    });
  });

  // ── Re-judge only (the /pp:gate equivalent) — pilot's regateStage helper ──
  app.post(`${V1}/runs/:id/stages/:stageId/gate`, async (req, reply) => {
    const { id, stageId } = req.params as { id: string; stageId: string };
    if (!runIdForStage(stageId)) return reply.code(404).send({ error: "stage not found", stage_id: stageId });

    const res = await regateStage({ stageId, engine: deps.makeEngine(), bus: bridgeBus(deps) });
    if (!res.ok) return reply.code(502).send({ error: "gate_failed", reason: res.reason });
    return reply.code(200).send({ run_id: id, stage_id: stageId, action: "gate", ok: true, outcome: res.outcome });
  });
}
