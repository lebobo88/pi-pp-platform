/**
 * Legacy read-only routes preserved from packages/core/src/http/server.ts so
 * `pp:status` and any pre-/api client keep working: /healthz, /runs, /runs/:id,
 * /runs/:id/replay, /budgets, /master-plan.
 */
import type { FastifyInstance } from "fastify";
import { listRuns, getRun, budgetStatus, masterPlanStatus, buildReplayBundle, type RunStatus } from "@pp/core";

export function registerLegacyRoutes(app: FastifyInstance): void {
  app.get("/healthz", async () => ({ ok: true, version: "0.1.0", ts: new Date().toISOString() }));

  app.get("/runs", async (req) => {
    const q = req.query as { project_path?: string; status?: string; limit?: string };
    return listRuns({
      project_path: q.project_path,
      status: q.status as RunStatus | undefined,
      limit: q.limit ? Number(q.limit) : undefined,
    });
  });

  app.get("/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const tree = getRun(id);
    if (!tree) return reply.code(404).send({ error: "run_not_found" });
    return tree;
  });

  app.get("/runs/:id/replay", async (req, reply) => {
    const { id } = req.params as { id: string };
    const bundle = buildReplayBundle(id);
    if (!bundle) return reply.code(404).send({ error: "run_not_found" });
    return bundle;
  });

  app.get("/budgets", async (req) => {
    const q = req.query as { scope?: string };
    return budgetStatus(q.scope);
  });

  app.get("/master-plan", async (req, reply) => {
    const q = req.query as { project_path?: string };
    if (!q.project_path) return reply.code(400).send({ error: "project_path required" });
    return masterPlanStatus(q.project_path);
  });
}
