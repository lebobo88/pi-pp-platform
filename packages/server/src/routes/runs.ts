/**
 * Run read routes: list (cursor-paginated RunListResponse envelope) / detail
 * (RunTree) / replay / missability / borda, and artifact content. Run-control
 * mutations live in run-control.ts.
 */
import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { listRuns, getRun, buildReplayBundle, db, type RunStatus } from "@pp/core";
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
    return listRuns({
      project_path: q.project_path,
      status: q.status as RunStatus | undefined,
      limit: q.limit ? Number(q.limit) : undefined,
      cursor: q.cursor,
    });
  });

  // Sub-resources before the bare :id.
  app.get(`${V1}/runs/:id/replay`, async (req, reply) => {
    const { id } = req.params as { id: string };
    const bundle = buildReplayBundle(id);
    return bundle ?? reply.code(404).send({ error: `run ${id} not found` });
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
    } | null;
    if (!tree) return reply.code(404).send({ error: `run ${id} not found` });
    // REQ-S-1/S-2/S-3: strip null provider / judge_provider so historical rows
    // omit the field entirely (UI's absence check works uniformly).
    const attempts = tree.attempts.map((a) => {
      if (a["provider"] == null) { const { provider: _p, ...rest } = a; return rest; }
      return a;
    });
    const verdicts = tree.verdicts.map((v) => {
      if (v["judge_provider"] == null) { const { judge_provider: _jp, ...rest } = v; return rest; }
      return v;
    });
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
