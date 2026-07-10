/**
 * GET /api/v1/runs/compare — run comparison endpoint.
 *
 * Seeds two runs (each with one stage + attempt + verdict) and verifies:
 *   - 200 with correct shape for 2 valid run ids
 *   - 400 on fewer than 2 ids
 *   - 400 on an unknown run id
 *   - /runs/compare is NOT swallowed by /runs/:id (static beats param in find-my-way)
 *   - apiPaths.runsCompare builds the correct URL
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { db } from "@pp/core";
import type { RunComparisonResponse } from "@shared/api-types";

// ── Isolated DB + env setup ───────────────────────────────────────────────

const home = mkdtempSync(join(tmpdir(), "pp-compare-home-"));
process.env.PP_PLATFORM_DIR = join(home, "platform");
delete process.env.PP_ECOSYSTEM;
delete process.env.PP_API_TOKEN;
const dbPath = join(home, "state.db");
mkdirSync(process.env.PP_PLATFORM_DIR, { recursive: true });

writeFileSync(
  join(process.env.PP_PLATFORM_DIR, "catalog.json"),
  JSON.stringify({
    generation_ladders: {
      claude: {
        provider: "anthropic",
        order: ["haiku", "sonnet", "opus"],
        off_ladder: ["fable"],
        tiers: {
          haiku: "claude-haiku-4-5-20251001",
          sonnet: "claude-sonnet-4-6",
          opus: "claude-opus-4-7",
          fable: "claude-fable-5",
        },
      },
    },
  }),
  "utf8",
);

process.env.USERPROFILE = home;
process.env.HOME = home;

let app: FastifyInstance;

// ── Seed constants ────────────────────────────────────────────────────────

const RUN_A   = "run_cmpA000001";
const RUN_B   = "run_cmpB000001";
const STG_A   = "stage_cmpA0001";
const STG_B   = "stage_cmpB0001";
const ATT_A   = "att_cmpA000001";
const ATT_B   = "att_cmpB000001";
const VDT_A   = "vdt_cmpA000001";
const VDT_B   = "vdt_cmpB000001";

const TS_BASE = "2026-07-10T10:00:00.000Z";
const TS_END  = "2026-07-10T10:05:00.000Z"; // 5 min later

beforeAll(async () => {
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ dbPath });

  const d = db();

  // Run A — finished
  d.prepare(
    `INSERT INTO runs(id, project_path, request_text, mode, status, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(RUN_A, "/fake/project", "request A", "single", "complete", TS_BASE, TS_END);

  d.prepare(
    `INSERT INTO stages(id, run_id, kind, gate_type, status, started_at, finished_at, winner_attempt_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(STG_A, RUN_A, "code", "spec", "passed", TS_BASE, TS_END, ATT_A);

  d.prepare(
    `INSERT INTO attempts(id, stage_id, producer, model_id, status, retry_index, tokens_in, tokens_out, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(ATT_A, STG_A, "claude", "claude-sonnet-4-6", "ok", 0, 1000, 500, 0.05, TS_BASE);

  d.prepare(
    `INSERT INTO verdicts(id, attempt_id, judge_producer, judge_model_id, outcome, cross_vendor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(VDT_A, ATT_A, "openai", "gpt-5.4", "pass", 1, TS_END);

  // Run B — finished
  d.prepare(
    `INSERT INTO runs(id, project_path, request_text, mode, status, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(RUN_B, "/fake/project", "request B", "single", "complete", TS_BASE, TS_END);

  d.prepare(
    `INSERT INTO stages(id, run_id, kind, gate_type, status, started_at, finished_at, winner_attempt_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(STG_B, RUN_B, "code", "spec", "passed", TS_BASE, TS_END, ATT_B);

  d.prepare(
    `INSERT INTO attempts(id, stage_id, producer, model_id, status, retry_index, tokens_in, tokens_out, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(ATT_B, STG_B, "claude", "claude-opus-4-7", "ok", 0, 2000, 800, 0.12, TS_BASE);

  d.prepare(
    `INSERT INTO verdicts(id, attempt_id, judge_producer, judge_model_id, outcome, cross_vendor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(VDT_B, ATT_B, "google", "gemini-2.5-pro", "pass", 1, TS_END);
});

afterAll(async () => {
  await app?.close();
});

async function get(url: string) {
  return app.inject({ method: "GET", url });
}

describe("GET /api/v1/runs/compare", () => {
  it("returns 400 when ids param is missing", async () => {
    const r = await get("/api/v1/runs/compare");
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toMatch(/ids/i);
  });

  it("returns 400 when only one id is supplied", async () => {
    const r = await get(`/api/v1/runs/compare?ids=${RUN_A}`);
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toMatch(/2/);
  });

  it("returns 400 when an unknown id is supplied", async () => {
    const r = await get(`/api/v1/runs/compare?ids=${RUN_A},run_doesNotExist`);
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toMatch(/not found/i);
  });

  it("returns 400 on duplicate ids", async () => {
    const r = await get(`/api/v1/runs/compare?ids=${RUN_A},${RUN_A}`);
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toMatch(/duplicate/i);
  });

  it("returns 400 when more than 4 ids are supplied", async () => {
    const ids = [RUN_A, RUN_B, "run_x1", "run_x2", "run_x3"].join(",");
    const r = await get(`/api/v1/runs/compare?ids=${ids}`);
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toMatch(/4/);
  });

  it("returns 200 with correct shape for 2 seeded runs", async () => {
    const r = await get(`/api/v1/runs/compare?ids=${RUN_A},${RUN_B}`);
    expect(r.statusCode).toBe(200);
    const body = r.json() as RunComparisonResponse;

    // run_ids must contain both
    expect(body.run_ids).toContain(RUN_A);
    expect(body.run_ids).toContain(RUN_B);

    // per_run must have entries for both
    expect(body.per_run[RUN_A]).toBeTruthy();
    expect(body.per_run[RUN_B]).toBeTruthy();

    // Totals sanity checks for run A
    const ta = body.per_run[RUN_A]!;
    expect(ta.stage_count).toBe(1);
    expect(ta.cost_usd).toBeCloseTo(0.05, 4);
    expect(ta.tokens_in).toBe(1000);
    expect(ta.tokens_out).toBe(500);
    expect(ta.wall_ms).toBe(5 * 60 * 1000); // 5 minutes
    expect(ta.pass_rate).toBe(1);            // 1/1 verdicts are pass
    expect(ta.reflexion_count).toBe(0);

    // Model usage for run A
    expect(ta.model_usage["claude-sonnet-4-6"]).toBeTruthy();
    expect(ta.model_usage["claude-sonnet-4-6"]!.stages).toBe(1);

    // stage_rows: both runs have a "code" stage at plan_order 0
    const codeRow = body.stage_rows.find((r) => r.stage_kind === "code" && r.plan_order === 0);
    expect(codeRow).toBeTruthy();
    expect(codeRow!.per_run[RUN_A]).toBeTruthy();
    expect(codeRow!.per_run[RUN_A]!.winning_verdict_outcome).toBe("pass");
    expect(codeRow!.per_run[RUN_B]).toBeTruthy();
    expect(codeRow!.per_run[RUN_B]!.winning_verdict_outcome).toBe("pass");
  });

  it("/runs/compare is NOT swallowed by /runs/:id (static beats param)", async () => {
    // If this incorrectly matched /runs/:id with id="compare", the response
    // would be 404 (run "compare" not found) rather than 400 (missing ids param).
    const r = await get("/api/v1/runs/compare");
    // Reaches the compare handler (which rejects missing ids with 400), not the :id handler.
    expect(r.statusCode).toBe(400);
    const body = r.json() as { error: string };
    // The :id handler's 404 body says "not found"; the compare handler's says "ids"
    expect(body.error).not.toMatch(/not found/i);
    expect(body.error).toMatch(/ids/i);
  });

  it("apiPaths.runsCompare builds the correct URL", async () => {
    const { apiPaths } = await import("@shared/api-types");
    const url = apiPaths.runsCompare([RUN_A, RUN_B]);
    expect(url).toBe(`/api/v1/runs/compare?ids=${RUN_A},${RUN_B}`);
  });
});
