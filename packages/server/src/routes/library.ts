/**
 * Library + system read routes: teams, agents, skills, rubrics, profiles,
 * forums, taxonomy, models, budgets (+ caps), evolution proposals, doctor,
 * janitor.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  listTeams, getTeam,
  listAgents, getAgent,
  listSkills, getSkill,
  recommendTeams,
  listRubrics, getRubric,
  judgeStats,
  listBuiltinProfiles, getBuiltinProfile,
  listForums, getForum,
  TAXONOMY_SECTIONS,
  budgetStatus,
  getBudgetCaps, setBudgetCaps,
  runJanitor, getJanitorReport,
  doctor,
  listProposals, setProposalStatus,
  commitProposal, rollbackProposal,
  CommitContentRequiredError, ProposalNotFoundError, ProposalStatusError, EvolutionTargetError,
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
  /** Reviewer-authored override body — required by decision=commit (the analyzer authors no patch). */
  content: z.string().optional(),
});

const RecommendBody = z.object({
  request_text: z.string().min(1),
  project_path: z.string().optional(),
  profile: z.string().optional(),
  scope: z.enum(["trivial", "standard", "major"]).optional(),
});

const SETTINGS_KEY = "harness_settings";
// Generalized beyond the fixed 4 Claude tiers: `ladders` is ladderName ->
// (tier -> model id), plus an optional reserved `tier_pools` key (tier ->
// model pool) mirroring the catalog ladder; `judge_pool` is an ordered list of
// {provider, model}. The `catchall` keys are tier names (string model ids);
// `tier_pools` is the one reserved non-tier key.
const LadderBody = z
  .object({ tier_pools: z.record(z.array(z.string().min(1)).min(1)).optional() })
  .catchall(z.string().min(1));
const SettingsBody = z.object({
  ladders: z.record(LadderBody),
  judge_pool: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) })).min(1),
});
function defaultSettings() {
  const c = catalog();
  const ladders: Record<string, Record<string, string | Record<string, string[]>>> = {};
  for (const [name, l] of Object.entries(c.generation_ladders)) {
    ladders[name] = {
      ...l.tiers,
      ...(l.tier_pools ? { tier_pools: l.tier_pools } : {}),
    };
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
  app.post(`${V1}/teams/recommend`, async (req, reply) => {
    const parsed = RecommendBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "validation failed", details: parsed.error.flatten() });
    }
    const b = parsed.data;
    return recommendTeams({ ...b, project_path: b.project_path ?? process.cwd() });
  });

  // ── Agents ──
  app.get(`${V1}/agents`, async (req) => {
    const q = req.query as { project_path?: string };
    return listAgents({ project_path: q.project_path ?? process.cwd() });
  });
  app.get(`${V1}/agents/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { project_path?: string };
    // Core rejects ids outside [\w.-] (path-traversal guard) by returning null.
    const a = getAgent({ id, project_path: q.project_path ?? process.cwd() });
    if (!a) return reply.code(404).send({ error: `agent ${id} not found` });
    return a;
  });

  // ── Skills ──
  app.get(`${V1}/skills`, async (req) => {
    const q = req.query as { project_path?: string };
    return listSkills({ project_path: q.project_path ?? process.cwd() });
  });
  app.get(`${V1}/skills/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { project_path?: string };
    // Core rejects ids outside [\w.-] (path-traversal guard) by returning null.
    const s = getSkill({ id, project_path: q.project_path ?? process.cwd() });
    if (!s) return reply.code(404).send({ error: `skill ${id} not found` });
    return s;
  });

  // ── Rubrics ──
  app.get(`${V1}/rubrics`, async () => listRubrics());
  app.get(`${V1}/rubrics/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = getRubric(id);
    if (!r) return reply.code(404).send({ error: `rubric ${id} not found` });
    return r;
  });

  // ── Judges (read-only verdict aggregation) ──
  app.get(`${V1}/judges/stats`, async () => ({ items: judgeStats() }));

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

  // ── Taxonomy (declared as apiPaths.taxonomy in shared/api-types.ts) ──
  app.get(`${V1}/taxonomy`, async () => TAXONOMY_SECTIONS);

  // ── Models (pi catalog for every visible provider) ──
  app.get(`${V1}/models`, async () => modelsWire(deps.engine.authStorage));

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
      // A5: local evolution commit/rollback — writes the project-scoped
      // override target (path-guarded to .claude/ + .harness/) and keeps a
      // reversible snapshot + evolution_commits audit row.
      try {
        if (decision === "commit") {
          const res = commitProposal({ id, content: parsed.data.content, note: parsed.data.note });
          return {
            id, decision, status: "committed", updated: true,
            target_path: res.target_path, snapshot_path: res.snapshot_path,
          };
        }
        const res = rollbackProposal({ id });
        return {
          id, decision, status: "rolled_back", updated: true,
          target_path: res.target_path, snapshot_path: res.snapshot_path,
        };
      } catch (err) {
        if (err instanceof CommitContentRequiredError) {
          return reply.code(422).send({ error: "content_required", message: err.message });
        }
        if (err instanceof ProposalNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        if (err instanceof ProposalStatusError || err instanceof EvolutionTargetError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
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

  // ── Janitor: GET returns the last persisted report; POST runs it (dry_run previews) ──
  app.get(`${V1}/system/janitor`, async () =>
    getJanitorReport() ?? { ran_at: null, dry_run: false, crashed_runs: [], entries: [], swept: 0, reclaimed_bytes: 0 });
  app.post(`${V1}/system/janitor`, async (req) => {
    const body = (req.body ?? {}) as { dry_run?: boolean; deep?: boolean };
    const report = runJanitor({ dry_run: body.dry_run === true, deep: body.deep === true });
    if (!report.dry_run) {
      // Events reflect mutations only — a dry_run plan sweeps nothing.
      deps.bus.publish({ type: "janitor.result", data: { swept: report.swept, reclaimed_bytes: report.reclaimed_bytes, details: report } });
    }
    return report;
  });
}
