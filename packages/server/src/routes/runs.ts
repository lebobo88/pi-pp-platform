/**
 * Run routes: list / detail (RunTree) / replay / missability / borda, artifact
 * content, and the run-control surface (registered but 501 until the pilot is
 * wired in M5d).
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
    const q = req.query as { project_path?: string; status?: string; limit?: string };
    return listRuns({
      project_path: q.project_path,
      status: q.status as RunStatus | undefined,
      limit: q.limit ? Number(q.limit) : undefined,
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

  // ── Run control — registered but pending the pilot (M5d) ──
  const pending = async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(501).send({ error: "run_control_pending", hint: "pilot wiring in M5d" });
  app.post(`${V1}/runs`, pending);
  app.post(`${V1}/runs/:id/abort`, pending);
  app.post(`${V1}/runs/:id/stages/:stageId/retry`, pending);
  app.post(`${V1}/runs/:id/stages/:stageId/gate`, pending);
}
