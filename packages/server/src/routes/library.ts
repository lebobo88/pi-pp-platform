/**
 * Library + system read routes: teams, rubrics, profiles, forums, taxonomy,
 * models, budgets (+ caps), evolution proposals, doctor, janitor.
 *
 * Contract deltas (flagged for ui-foundation — these paths are NOT yet in
 * shared/api-types.ts apiPaths): /forums, /forums/:id, /taxonomy.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  listTeams, getTeam,
  listRubrics, getRubric,
  listBuiltinProfiles, getBuiltinProfile,
  listForums, getForum,
  TAXONOMY_SECTIONS,
  budgetStatus,
  getBudgetCaps, setBudgetCaps,
  runJanitor,
  doctor,
  listProposals, setProposalStatus,
  getPlatformSetting, setPlatformSetting,
  catalog, judgePool, judgePoolProviders,
} from "@pp/core";
import { modelsWire } from "../wire.js";
import { V1, type ServerDeps } from "../deps.js";

const CapSchema = z.object({
  scope: z.string().min(1),
  limit_usd: z.number().nonnegative(),
  warn_pct: z.number().min(0).max(1),
  block_pct: z.number().min(0).max(1),
});
const CapsBody = z.object({ caps: z.array(CapSchema) });

const ReviewBody = z.object({
  decision: z.enum(["approve", "reject", "commit", "rollback"]),
  note: z.string().optional(),
});

const SETTINGS_KEY = "harness_settings";
// Generalized beyond the fixed 4 Claude tiers: `ladders` is ladderName ->
// (tier -> model id); `judge_pool` is an ordered list of {provider, model}.
const SettingsBody = z.object({
  ladders: z.record(z.record(z.string().min(1))),
  judge_pool: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) })).min(1),
});
function defaultSettings() {
  const c = catalog();
  const ladders: Record<string, Record<string, string>> = {};
  for (const [name, l] of Object.entries(c.generation_ladders)) {
    ladders[name] = { ...l.tiers };
  }
  return {
    ladders,
    judge_pool: judgePool().map((e) => ({ provider: e.provider, model: e.model })),
  };
}

export function registerLibraryRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // ── Teams ──
  app.get(`${V1}/teams`, async (req) => {
    const q = req.query as { project_path?: string };
    return listTeams({ project_path: q.project_path ?? process.cwd() });
  });
  app.get(`${V1}/teams/:name`, async (req, reply) => {
    const { name } = req.params as { name: string };
    const q = req.query as { project_path?: string };
    const t = getTeam({ name, project_path: q.project_path ?? process.cwd() });
    if (!t) return reply.code(404).send({ error: `team ${name} not found` });
    return t;
  });

  // ── Rubrics ──
  app.get(`${V1}/rubrics`, async () => listRubrics());
  app.get(`${V1}/rubrics/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = getRubric(id);
    if (!r) return reply.code(404).send({ error: `rubric ${id} not found` });
    return r;
  });

  // ── Profiles (library) ──
  app.get(`${V1}/profiles`, async () => listBuiltinProfiles());
  app.get(`${V1}/profiles/:name`, async (req, reply) => {
    const { name } = req.params as { name: string };
    const p = getBuiltinProfile(name);
    if (!p) return reply.code(404).send({ error: `profile ${name} not found` });
    return p;
  });

  // ── Forums (DELTA: not in apiPaths yet) ──
  app.get(`${V1}/forums`, async () => listForums());
  app.get(`${V1}/forums/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const f = getForum(id);
    if (!f) return reply.code(404).send({ error: `forum ${id} not found` });
    return f;
  });

  // ── Taxonomy (DELTA: not in apiPaths yet) ──
  app.get(`${V1}/taxonomy`, async () => TAXONOMY_SECTIONS);

  // ── Models ──
  app.get(`${V1}/models`, async () => modelsWire());

  // ── Harness settings (tier ladder + judge pool) persisted to platform_settings ──
  app.get(`${V1}/settings`, async () => getPlatformSetting(SETTINGS_KEY) ?? defaultSettings());
  app.put(`${V1}/settings`, async (req, reply) => {
    const parsed = SettingsBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "validation failed", details: parsed.error.flatten() });
    }
    setPlatformSetting(SETTINGS_KEY, parsed.data);
    return parsed.data;
  });

  // ── Budgets + caps (caps BEFORE :scope so it doesn't shadow) ──
  app.get(`${V1}/budgets/caps`, async () => getBudgetCaps());
  app.put(`${V1}/budgets/caps`, async (req, reply) => {
    const parsed = CapsBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "validation failed", details: parsed.error.flatten() });
    }
    return setBudgetCaps(parsed.data.caps);
  });
  app.get(`${V1}/budgets`, async (req) => {
    const q = req.query as { scope?: string };
    return budgetStatus(q.scope);
  });
  app.get(`${V1}/budgets/:scope`, async (req) => {
    const { scope } = req.params as { scope: string };
    return budgetStatus(scope);
  });

  // ── Evolution proposals ──
  app.get(`${V1}/evolution/proposals`, async (req) => {
    const q = req.query as { project_path?: string; status?: string; limit?: string };
    return listProposals({
      project_path: q.project_path ?? process.cwd(),
      status: q.status as never,
      limit: q.limit ? Number(q.limit) : undefined,
    });
  });
  app.post(`${V1}/evolution/proposals/:id/review`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ReviewBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(422).send({ error: "validation failed", details: parsed.error.flatten() });
    }
    const decision = parsed.data.decision;
    if (decision === "commit" || decision === "rollback") {
      // commit/rollback route through the ecosystem PpWriteBridge — not wired here.
      return reply.code(501).send({ error: "evolution_commit_pending", hint: "ecosystem commit/rollback wiring pending" });
    }
    const updated = setProposalStatus(id, decision === "approve" ? "approved" : "rejected");
    if (!updated) return reply.code(404).send({ error: `proposal ${id} not pending or not found` });
    return { id, decision, status: decision === "approve" ? "approved" : "rejected", updated: true };
  });

  // ── Doctor: GET quick, POST async (emits doctor.result on the bus) ──
  app.get(`${V1}/doctor`, async () => doctor({ smoke: false }));
  app.post(`${V1}/doctor`, async (req, reply) => {
    const body = (req.body ?? {}) as { smoke?: boolean };
    const smoke = !!body.smoke;
    // Fire-and-forget: core doctor (+ critique smokes when smoke) + per-provider
    // engine probes, then publish doctor.result on the bus.
    void (async () => {
      try {
        const report = (await doctor({ smoke })) as Record<string, unknown>;
        const engine_probes: Record<string, unknown> = {};
        if (smoke) {
          for (const vendor of judgePoolProviders()) {
            try {
              engine_probes[vendor] = await deps.engine.doctorProbe(vendor);
            } catch (err) {
              engine_probes[vendor] = { ok: false, error: (err as Error).message };
            }
          }
        }
        deps.bus.publish({ type: "doctor.result", data: { ...report, engine_probes } });
      } catch {
        /* best-effort */
      }
    })();
    return reply.code(202).send({ ok: true, started: true, smoke });
  });

  // ── Janitor: GET reports nothing swept yet; POST runs it (dry_run previews) ──
  app.get(`${V1}/system/janitor`, async () => ({
    ran_at: null,
    swept: 0,
    reclaimed_bytes: 0,
    entries: [],
  }));
  app.post(`${V1}/system/janitor`, async (req) => {
    const body = (req.body ?? {}) as { dry_run?: boolean };
    if (body.dry_run) {
      // No side-effect preview available from core; report an empty plan.
      return { ran_at: new Date().toISOString(), swept: 0, reclaimed_bytes: 0, entries: [], dry_run: true };
    }
    const r = runJanitor();
    const entries = [
      ...r.swept_worktrees.map((path) => ({ path, kind: "worktree", bytes: 0, age_days: 0 })),
      ...r.swept_locks.map((path) => ({ path, kind: "lock", bytes: 0, age_days: 0 })),
      ...r.swept_branches.map((path) => ({ path, kind: "branch", bytes: 0, age_days: 0 })),
    ];
    const report = { ran_at: new Date().toISOString(), swept: entries.length, reclaimed_bytes: 0, entries, crashed_runs: r.crashed_runs };
    deps.bus.publish({ type: "janitor.result", data: { swept: report.swept, reclaimed_bytes: 0, details: report } });
    return report;
  });
}
