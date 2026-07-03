/**
 * Run read routes: list (cursor-paginated RunListResponse envelope) / detail
 * (RunTree) / replay / missability / borda, and artifact content. Run-control
 * mutations live in run-control.ts.
 */
import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
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
    const tree = getRun(id);
    return tree ?? reply.code(404).send({ error: `run ${id} not found` });
  });

  // ── Artifact / file content ──
  app.get(`${V1}/content`, async (req, reply) => {
    const q = req.query as { path?: string };
    const path = q.path;
    if (!path) return reply.code(422).send({ error: "validation failed", details: { path: "required" } });
    if (!existsSync(path) || !statSync(path).isFile()) {
      return reply.code(404).send({ error: `no file at ${path}` });
    }
    const content = readFileSync(path, "utf8");
    return { path, kind: contentKind(path), content };
  });

  // Run-control POSTs are registered by registerRunControlRoutes (run-control.ts).
}
