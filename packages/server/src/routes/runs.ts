/**
 * Run read routes: list (cursor-paginated RunListResponse envelope) / detail
 * (RunTree) / replay / missability / borda, and artifact content. Run-control
 * mutations live in run-control.ts.
 */
import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { listRuns, getRun, getEventLog, getGateHistory, getRunComparison, buildReplayBundle, loopCeilingStatus, db, type RunStatus } from "@pp/core";
import { V1 } from "../deps.js";

function contentKind(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".diff" || ext === ".patch") return "diff";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".json") return "json";
  if (ext === ".yaml" || ext === ".yml") return "yaml";
  return "text";
}

export function registerRunRoutes(app: FastifyInstance): void {
  app.get(`${V1}/runs`, async (req) => {
    const q = req.query as { project_path?: string; status?: string; limit?: string; cursor?: string };
    const page = listRuns({
      project_path: q.project_path,
      status: q.status as RunStatus | undefined,
      limit: q.limit ? Number(q.limit) : undefined,
      cursor: q.cursor,
    });
    // Fill cost from the budgets ledger (scope run:<id>) — the runs table has
    // no cost column, and "—" for every finished run misreads as free.
    const costStmt = db().prepare("SELECT cost_usd FROM budgets WHERE scope = ?");
    const items = (page.items as Array<Record<string, unknown>>).map((r) => {
      if (r["cost_usd"] == null && typeof r["id"] === "string") {
        const b = costStmt.get(`run:${r["id"]}`) as { cost_usd: number } | undefined;
        if (b) return { ...r, cost_usd: b.cost_usd };
      }
      return r;
    });
    return { ...page, items };
  });

  // Static segment — find-my-way prioritises this over /runs/:id regardless
  // of registration order; registered explicitly before the param route for clarity.
  app.get(`${V1}/runs/compare`, async (req, reply) => {
    const q = req.query as { ids?: string };
    if (!q.ids) {
      return reply.code(400).send({ error: "ids query parameter is required (comma-separated, 2–4 run ids)" });
    }
    const ids = q.ids.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length < 2) {
      return reply.code(400).send({ error: "at least 2 run ids are required for comparison" });
    }
    if (ids.length > 4) {
      return reply.code(400).send({ error: "at most 4 run ids may be compared at once" });
    }
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        return reply.code(400).send({ error: `duplicate run id: ${id}` });
      }
      seen.add(id);
    }
    const result = getRunComparison(ids);
    if (result === null) {
      return reply.code(400).send({ error: "one or more run ids not found" });
    }
    return result;
  });

  // Sub-resources before the bare :id.
  app.get(`${V1}/runs/:id/replay`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const bundle = buildReplayBundle(id);
    return bundle ?? reply.code(404).send({ error: `run ${id} not found` });
  });

  app.get(`${V1}/runs/:id/event-log`, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { since?: string; type?: string; limit?: string };
    return getEventLog(id, {
      since: q.since != null ? Number(q.since) : undefined,
      type: q.type,
      limit: q.limit != null ? Number(q.limit) : undefined,
    });
  });

  app.get(`${V1}/runs/:id/gates`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const entries = getGateHistory(id);
    if (entries === null) return reply.code(404).send({ error: `run ${id} not found` });
    return entries;
  });

  app.get(`${V1}/runs/:id/loop-ceiling`, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!getRun(id)) return reply.code(404).send({ error: `run ${id} not found` });
    return loopCeilingStatus(id);
  });

  app.get(`${V1}/runs/:id/missability`, async (req) => {
    const { id } = req.params as { id: string };
    return db()
      .prepare("SELECT id, run_id, check_id, status, evidence_path, created_at FROM missability_checks WHERE run_id = ? ORDER BY created_at")
      .all(id);
  });

  app.get(`${V1}/runs/:id/borda`, async (req) => {
    // Best-effort read of any borda ranking persisted in stage notes_json.
    // DELTA: not in apiPaths; the live ranking normally arrives via SSE.
    const { id } = req.params as { id: string };
    const tree = getRun(id) as { stages?: Array<{ id: string; notes_json?: string | null }> } | null;
    if (!tree?.stages) return [];
    const out: Array<{ stage_id: string; borda: unknown }> = [];
    for (const s of tree.stages) {
      if (!s.notes_json) continue;
      try {
        const notes = JSON.parse(s.notes_json) as { borda?: unknown };
        if (notes.borda) out.push({ stage_id: s.id, borda: notes.borda });
      } catch {
        /* ignore malformed notes */
      }
    }
    return out;
  });

  app.get(`${V1}/runs/:id`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const tree = getRun(id) as {
      run: unknown;
      stages: unknown[];
      attempts: Array<Record<string, unknown>>;
      verdicts: Array<Record<string, unknown>>;
      artifacts: unknown[];
      phases: unknown[];
    } | null;
    if (!tree) return reply.code(404).send({ error: `run ${id} not found` });
    // REQ-S-1/S-2/S-3: omit provider / judge_provider when null OR empty string
    // so historical rows (and defensive-omit-from-pilot rows) drop the field
    // entirely — UI's absence check works uniformly (never sees '' or null).
    const attempts = tree.attempts.map((a) => {
      const p = a["provider"];
      if (p == null || p === "") { const { provider: _p, ...rest } = a; return rest; }
      return a;
    });
    const verdicts = tree.verdicts.map((v) => {
      const jp = v["judge_provider"];
      if (jp == null || jp === "") { const { judge_provider: _jp, ...rest } = v; return rest; }
      return v;
    });
    // The runs table never carried per-run cost; the budgets ledger does
    // (scope run:<id>). Fill run.cost_usd from it so REST readers see the
    // same number the SSE budget ticks report.
    const runRow = tree.run as Record<string, unknown>;
    if (runRow && (runRow["cost_usd"] == null)) {
      const b = db()
        .prepare("SELECT cost_usd FROM budgets WHERE scope = ?")
        .get(`run:${id}`) as { cost_usd: number } | undefined;
      if (b) runRow["cost_usd"] = b.cost_usd;
    }
    return { ...tree, attempts, verdicts };
  });

  // ── Artifact / file content ──
  // Artifact paths are stored RELATIVE to the project root (e.g.
  // ".harness/<run>/..."), but the server cwd is not the project dir — so a bare
  // relative `path` cannot be resolved on its own. Callers pass `project_path`
  // (or `run_id`, from which we look up the project root) to resolve it. Absolute
  // paths are served as-is (e.g. a promoted_path).
  app.get(`${V1}/content`, async (req, reply) => {
    const q = req.query as { path?: string; project_path?: string; run_id?: string };
    const rawPath = q.path;
    if (!rawPath) return reply.code(422).send({ error: "validation failed", details: { path: "required" } });

    let projectRoot = q.project_path;
    if (!projectRoot && q.run_id) {
      const tree = getRun(q.run_id) as { run?: { project_path?: string } } | null;
      projectRoot = tree?.run?.project_path ?? undefined;
    }

    let resolved: string;
    if (isAbsolute(rawPath)) {
      resolved = resolve(rawPath);
    } else if (projectRoot) {
      resolved = resolve(projectRoot, rawPath);
      // Containment guard: never serve a file outside the project root.
      const root = resolve(projectRoot);
      if (resolved !== root && !resolved.startsWith(root + sep)) {
        return reply.code(400).send({ error: "resolved path escapes the project root" });
      }
    } else {
      // No root supplied — fall back to cwd (legacy). A relative artifact path
      // will usually 404 here; the caller should pass project_path or run_id.
      resolved = resolve(rawPath);
    }

    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      return reply.code(404).send({ error: `no file at ${rawPath}`, resolved });
    }
    const content = readFileSync(resolved, "utf8");
    return { path: resolved, kind: contentKind(resolved), content };
  });

  // Run-control POSTs are registered by registerRunControlRoutes (run-control.ts).
}
