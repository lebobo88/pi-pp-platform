/**
 * GET /api/v1/runs/:id/gates — gate history endpoint.
 *
 * Seeds a run with a tdd_check and a verdict via direct DB inserts, then
 * asserts ordering, discriminators, and the 404 path for unknown runs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { db } from "@pp/core";
import type { GateHistoryEntry, TddCheckGateEntry, VerdictGateEntry } from "@shared/api-types";

// ── Isolated DB + env setup ───────────────────────────────────────────────

const home = mkdtempSync(join(tmpdir(), "pp-gates-home-"));
process.env.PP_PLATFORM_DIR = join(home, "platform");
delete process.env.PP_ECOSYSTEM;
delete process.env.PP_API_TOKEN;
const dbPath = join(home, "state.db");
mkdirSync(process.env.PP_PLATFORM_DIR, { recursive: true });

// Minimal catalog so buildApp can boot without hitting the network.
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

// Isolate user scope so no real ~/.claude skills interfere.
process.env.USERPROFILE = home;
process.env.HOME = home;

let app: FastifyInstance;

// ── Seed constants ────────────────────────────────────────────────────────

const RUN_ID    = "run_gatesT0001";
const STAGE_ID  = "stage_gateT001";
const ATT_ID    = "att_gatesT0001";
const VDT_ID    = "vdt_gatesT0001";
const TC_ID     = "tc_gatesT00001";

const TS_RUN    = "2026-07-10T00:00:00.000Z";
const TS_STAGE  = "2026-07-10T00:01:00.000Z";
const TS_TDD    = "2026-07-10T00:01:30.000Z";
const TS_ATT    = "2026-07-10T00:02:00.000Z";
const TS_VDT    = "2026-07-10T00:02:30.000Z";

beforeAll(async () => {
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ dbPath });

  // Seed: run → stage → attempt → verdict + tdd_check
  const d = db();

  d.prepare(
    `INSERT INTO runs(id, project_path, request_text, mode, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(RUN_ID, "/fake/project", "test gates", "single", "complete", TS_RUN);

  d.prepare(
    `INSERT INTO stages(id, run_id, kind, gate_type, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(STAGE_ID, RUN_ID, "code", "spec", "passed", TS_STAGE);

  d.prepare(
    `INSERT INTO tdd_checks(
       id, run_id, stage_id, phase, mode, test_runner, test_command,
       test_files_json, expected, actual, status, passed_count, failed_count,
       exit_code, duration_ms, manifest_path, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    TC_ID, RUN_ID, STAGE_ID, "pre", "feature-tdd", "vitest", "npx vitest",
    '["test/foo.test.ts"]', "all_fail", "all_fail", "verified",
    null, 3, 1, 1234, "/fake/manifest.yaml", TS_TDD,
  );

  d.prepare(
    `INSERT INTO attempts(id, stage_id, producer, model_id, status, retry_index, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ATT_ID, STAGE_ID, "claude", "claude-sonnet-4-6", "ok", 0, TS_ATT);

  d.prepare(
    `INSERT INTO verdicts(id, attempt_id, judge_producer, judge_model_id, outcome, cross_vendor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(VDT_ID, ATT_ID, "openai", "gpt-5.4", "pass", 1, TS_VDT);
});

afterAll(async () => {
  await app?.close();
});

async function get(url: string) {
  return app.inject({ method: "GET", url });
}

describe("GET /api/v1/runs/:id/gates", () => {
  it("returns 404 for an unknown run id", async () => {
    const r = await get("/api/v1/runs/run_does_not_exist/gates");
    expect(r.statusCode).toBe(404);
    expect((r.json() as { error: string }).error).toContain("not found");
  });

  it("returns a JSON array for a known run", async () => {
    const r = await get(`/api/v1/runs/${encodeURIComponent(RUN_ID)}/gates`);
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json())).toBe(true);
  });

  it("entries are ordered by timestamp ascending", async () => {
    const entries = (await get(`/api/v1/runs/${encodeURIComponent(RUN_ID)}/gates`)).json() as GateHistoryEntry[];
    const tss = entries.map((e) => e.ts);
    expect(tss).toEqual([...tss].sort());
  });

  it("contains a tdd_check entry with correct discriminator and fields", async () => {
    const entries = (await get(`/api/v1/runs/${encodeURIComponent(RUN_ID)}/gates`)).json() as GateHistoryEntry[];
    const tddEntry = entries.find((e): e is TddCheckGateEntry => e.gate === "tdd_check");
    expect(tddEntry).toBeTruthy();
    expect(tddEntry!.id).toBe(TC_ID);
    expect(tddEntry!.stage_id).toBe(STAGE_ID);
    expect(tddEntry!.phase).toBe("pre");
    expect(tddEntry!.mode).toBe("feature-tdd");
    expect(tddEntry!.test_runner).toBe("vitest");
    expect(tddEntry!.status).toBe("verified");
    expect(tddEntry!.failed_count).toBe(3);
    expect(tddEntry!.duration_ms).toBe(1234);
    expect(tddEntry!.ts).toBe(TS_TDD);
  });

  it("contains a verdict entry with correct discriminator and fields", async () => {
    const entries = (await get(`/api/v1/runs/${encodeURIComponent(RUN_ID)}/gates`)).json() as GateHistoryEntry[];
    const vdtEntry = entries.find((e): e is VerdictGateEntry => e.gate === "verdict");
    expect(vdtEntry).toBeTruthy();
    expect(vdtEntry!.id).toBe(VDT_ID);
    expect(vdtEntry!.stage_id).toBe(STAGE_ID);
    expect(vdtEntry!.attempt_id).toBe(ATT_ID);
    expect(vdtEntry!.judge_producer).toBe("openai");
    expect(vdtEntry!.judge_model_id).toBe("gpt-5.4");
    expect(vdtEntry!.outcome).toBe("pass");
    expect(vdtEntry!.cross_vendor).toBe(true);
    expect(vdtEntry!.retracted).toBe(false);
    expect(vdtEntry!.ts).toBe(TS_VDT);
  });

  it("tdd_check appears before verdict (earlier timestamp)", async () => {
    const entries = (await get(`/api/v1/runs/${encodeURIComponent(RUN_ID)}/gates`)).json() as GateHistoryEntry[];
    const tddIdx = entries.findIndex((e) => e.gate === "tdd_check");
    const vdtIdx = entries.findIndex((e) => e.gate === "verdict");
    expect(tddIdx).toBeGreaterThanOrEqual(0);
    expect(vdtIdx).toBeGreaterThan(tddIdx);
  });

  it("apiPaths.runGates produces the correct URL", async () => {
    // Import the wire contract and verify the path matches what we registered.
    const { apiPaths } = await import("@shared/api-types");
    expect(apiPaths.runGates(RUN_ID)).toBe(`/api/v1/runs/${RUN_ID}/gates`);
  });
});
