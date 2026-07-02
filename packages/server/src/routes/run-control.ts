/**
 * Run-control mutations, live via the RunSupervisor:
 *   POST /runs                         — start a run (detached; returns run_id)
 *   POST /runs/:id/abort               — abort a live run
 *   POST /runs/:id/stages/:sid/retry   — Reflexion-honoring manual retry (eligibility)
 *   POST /runs/:id/stages/:sid/gate    — re-judge only (engine critique → recordVerdict)
 */
import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { z } from "zod";
import {
  registerProject, ProjectDirNotFoundError,
  checkRetryEligible, recordVerdict, getRun, db,
} from "@pp/core";
import { providerToProducer } from "@pp/pilot";
import { toGenProvider } from "@pp/engine";
import { V1, type ServerDeps } from "../deps.js";

const TIER = z.enum(["haiku", "sonnet", "opus", "fable"]);
const StartBody = z.object({
  project_path: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  request_text: z.string().min(1),
  mode: z.enum(["single", "team", "best_of", "review"]),
  team: z.string().optional(),
  forum: z.string().optional(),
  n: z.number().int().min(2).max(7).optional(),
  scope_override: z.enum(["trivial", "standard", "major"]).optional(),
  tier_cap: TIER.optional(),
  tier_floor: TIER.optional(),
  no_tier_policy: z.boolean().optional(),
});

function producerToProviderStr(producer: string): "anthropic" | "openai" | "google" {
  if (producer === "codex") return "openai";
  if (producer === "gemini") return "google";
  return "anthropic";
}

function readArtifact(path: string, projectPath: string): string {
  const abs = isAbsolute(path) ? path : join(projectPath, path);
  if (existsSync(abs)) return readFileSync(abs, "utf8");
  if (existsSync(path)) return readFileSync(path, "utf8");
  return "";
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

  // ── Manual retry (Reflexion ×1) — eligibility via core ──
  app.post(`${V1}/runs/:id/stages/:stageId/retry`, async (req, reply) => {
    const { id, stageId } = req.params as { id: string; stageId: string };
    const att = db()
      .prepare("SELECT id FROM attempts WHERE stage_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(stageId) as { id: string } | undefined;
    if (!att) return reply.code(404).send({ error: "stage has no attempt to retry", stage_id: stageId });

    const elig = checkRetryEligible({ attempt_id: att.id });
    if (!elig.ok) return reply.code(409).send({ error: "retry_exhausted", reason: elig.reason });
    return reply.code(202).send({
      run_id: id,
      stage_id: stageId,
      action: "retry",
      ok: true,
      parent_attempt_id: elig.parent_attempt_id,
      note: "eligible; live regeneration is driven by a pilot re-entry helper (M5d follow-up)",
    });
  });

  // ── Re-judge only (the /pp:gate equivalent) ──
  // NOTE: candidate to move into @pp/pilot as a first-class helper. Implemented
  // here with core gate state + engine critique.
  app.post(`${V1}/runs/:id/stages/:stageId/gate`, async (req, reply) => {
    const { id, stageId } = req.params as { id: string; stageId: string };
    const tree = getRun(id) as { run?: { project_path: string } } | null;
    if (!tree?.run) return reply.code(404).send({ error: `run ${id} not found` });

    const att = db()
      .prepare("SELECT id, producer, model_id FROM attempts WHERE stage_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(stageId) as { id: string; producer: string; model_id: string } | undefined;
    const artifact = db()
      .prepare("SELECT path FROM artifacts WHERE stage_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(stageId) as { path: string } | undefined;
    if (!att || !artifact) return reply.code(409).send({ error: "gate_unavailable", details: "no attempt/artifact to re-judge" });

    const artifactText = readArtifact(artifact.path, tree.run.project_path);
    if (!artifactText) return reply.code(409).send({ error: "gate_unavailable", details: "artifact content not found on disk" });

    const genProvider = producerToProviderStr(att.producer);
    const sel = deps.engine.catalog.pickJudge(genProvider, { requiredCrossVendor: true });
    if (!sel) return reply.code(409).send({ error: "no_eligible_judge", details: "all cross-vendor judge providers disabled" });

    try {
      const judgeModel = deps.engine.catalog.resolve(sel.provider, sel.model);
      const result = await deps.engine.critique({
        judgeModel,
        rubricMd: "Re-evaluate the artifact against the stage's gate criteria. Score correctness and completeness (0..1) and return outcome pass|fail|revise with a substantive critique.",
        artifactText,
      });
      const verdict = result.parsed as { outcome?: string; critique_md?: string; score?: Record<string, number> } | undefined;
      if (verdict?.outcome) {
        recordVerdict({
          attempt_id: att.id,
          judge_producer: providerToProducer(toGenProvider(sel.provider)),
          judge_model_id: sel.model,
          outcome: verdict.outcome as "pass" | "fail" | "revise",
          critique_md: verdict.critique_md,
          score_json: verdict.score,
        });
      }
      return reply.code(200).send({ run_id: id, stage_id: stageId, action: "gate", ok: true, outcome: verdict?.outcome ?? null });
    } catch (err) {
      return reply.code(502).send({ error: "gate_failed", details: (err as Error).message });
    }
  });
}
