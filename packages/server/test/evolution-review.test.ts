/**
 * A5 — evolution proposal review: commit / rollback replace the old 501.
 *
 * POST /api/v1/evolution/proposals/:id/review with decision commit writes the
 * reviewer-authored content to the proposal's project-override target (and
 * snapshots any prior file); rollback restores/deletes. Wrong status → 409,
 * missing content → 422, unknown proposal → 404.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Isolate the DB + platform auth dir + keep the ecosystem off BEFORE buildApp
// (same preamble as rest.test.ts).
const home = mkdtempSync(join(tmpdir(), "pp-srv-evo-home-"));
process.env.PP_PLATFORM_DIR = join(home, "platform");
delete process.env.PP_ECOSYSTEM;
delete process.env.PP_API_TOKEN;
process.env.PP_SKIP_CLI_VERSIONS = "1";
process.env.USERPROFILE = home;
process.env.HOME = home;
const dbPath = join(home, "state.db");

let app: FastifyInstance;
let projectDir: string;
let approvedId: string;
let pendingId: string;

beforeAll(async () => {
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ dbPath });

  // Seed a run + proposals directly — the review route only needs the rows.
  projectDir = mkdtempSync(join(tmpdir(), "pp-srv-evo-proj-"));
  mkdirSync(join(projectDir, ".harness"), { recursive: true });
  writeFileSync(join(projectDir, "AGENTS.md"), "# AGENTS\n", "utf8");

  const { db } = await import("@pp/core");
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO runs (id, project_path, request_text, mode, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("run_evo_srv", projectDir, "fixture", "single", "complete", now);

  const insert = db().prepare(
    `INSERT INTO evolution_proposals
       (id, run_id, resource_rid, proposed_change, justification, signal_count, risk_class, status, created_at)
     VALUES (?, 'run_evo_srv', ?, '{}', 'fixture', 3, 'medium', ?, ?)`,
  );
  approvedId = "prop_srv_approved";
  pendingId = "prop_srv_pending";
  insert.run(approvedId, "resource:pp.rubric.server-custom", "approved", now);
  insert.run(pendingId, "resource:pp.rubric.server-pending", "pending", now);
});

afterAll(async () => {
  await app?.close();
});

async function review(id: string, payload: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/api/v1/evolution/proposals/${id}/review`, payload });
}

describe("evolution review — commit / rollback", () => {
  it("commit without content → 422 content_required", async () => {
    const r = await review(approvedId, { decision: "commit" });
    expect(r.statusCode).toBe(422);
    expect((r.json() as { error: string }).error).toBe("content_required");
  });

  it("commit on a non-approved proposal → 409; unknown proposal → 404", async () => {
    const conflict = await review(pendingId, { decision: "commit", content: "x" });
    expect(conflict.statusCode).toBe(409);
    const missing = await review("prop_srv_nope", { decision: "commit", content: "x" });
    expect(missing.statusCode).toBe(404);
    // rollback before any commit is a status conflict too.
    const rb = await review(approvedId, { decision: "rollback" });
    expect(rb.statusCode).toBe(409);
  });

  it("commit → 200 committed and the override file is written", async () => {
    const r = await review(approvedId, { decision: "commit", content: "# Override\n\nSRV-MARKER\n", note: "srv" });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { id: string; decision: string; status: string; updated: boolean; target_path: string; snapshot_path: string | null };
    expect(body).toMatchObject({ id: approvedId, decision: "commit", status: "committed", updated: true });
    expect(body.snapshot_path).toBeNull();
    const target = join(projectDir, ".claude", "rubrics", "server-custom.md");
    expect(body.target_path).toBe(target);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("SRV-MARKER");
  });

  it("rollback → 200 rolled_back and the created file is removed", async () => {
    const r = await review(approvedId, { decision: "rollback" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: approvedId, decision: "rollback", status: "rolled_back", updated: true });
    expect(existsSync(join(projectDir, ".claude", "rubrics", "server-custom.md"))).toBe(false);
    // A second rollback conflicts.
    expect((await review(approvedId, { decision: "rollback" })).statusCode).toBe(409);
  });
});
