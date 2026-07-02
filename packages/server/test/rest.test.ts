import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Isolate the DB + platform auth dir + keep the ecosystem off BEFORE buildApp.
const home = mkdtempSync(join(tmpdir(), "pp-srv-home-"));
process.env.PP_PLATFORM_DIR = join(home, "platform");
delete process.env.PP_ECOSYSTEM;
delete process.env.PP_API_TOKEN;
const dbPath = join(home, "state.db");

let app: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ dbPath });
});

afterAll(async () => {
  await app?.close();
});

async function get(url: string) {
  return app.inject({ method: "GET", url });
}

describe("health + library reads", () => {
  it("GET /healthz", async () => {
    const r = await get("/healthz");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true });
  });

  it("GET /api/v1/rubrics + /rubrics/:id", async () => {
    const list = await get("/api/v1/rubrics");
    expect(list.statusCode).toBe(200);
    const rubrics = list.json() as Array<{ id: string }>;
    expect(rubrics.length).toBeGreaterThan(0);
    const one = await get(`/api/v1/rubrics/${encodeURIComponent(rubrics[0]!.id)}`);
    expect(one.statusCode).toBe(200);
    expect(typeof (one.json() as { markdown?: string }).markdown).toBe("string");
  });

  it("GET /api/v1/profiles (16), /forums (10), /taxonomy (16), /teams, /models", async () => {
    expect((await get("/api/v1/profiles")).json()).toHaveLength(16);
    expect((await get("/api/v1/forums")).json()).toHaveLength(10);
    expect((await get("/api/v1/taxonomy")).json()).toHaveLength(16);
    expect(Array.isArray((await get("/api/v1/teams")).json())).toBe(true);
    expect(Array.isArray((await get("/api/v1/models")).json())).toBe(true);
  });

  it("GET /api/v1/doctor is reachable", async () => {
    const r = await get("/api/v1/doctor");
    expect(r.statusCode).toBe(200);
    expect((r.json() as { db_reachable?: boolean }).db_reachable).toBe(true);
  });
});

describe("budgets + caps", () => {
  it("GET /budgets and caps roundtrip; PUT validates", async () => {
    expect(Array.isArray((await get("/api/v1/budgets")).json())).toBe(true);
    expect((await get("/api/v1/budgets/caps")).json()).toEqual([]);

    const ok = await app.inject({
      method: "PUT",
      url: "/api/v1/budgets/caps",
      payload: { caps: [{ scope: "day", limit_usd: 8, warn_pct: 0.8, block_pct: 1.0 }] },
    });
    expect(ok.statusCode).toBe(200);
    expect((await get("/api/v1/budgets/caps")).json()).toHaveLength(1);

    const bad = await app.inject({
      method: "PUT",
      url: "/api/v1/budgets/caps",
      payload: { caps: [{ scope: "day", limit_usd: -1, warn_pct: 2 }] },
    });
    expect(bad.statusCode).toBe(422);
    expect((bad.json() as { error: string }).error).toBe("validation failed");
  });
});

describe("projects CRUD", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pp-srv-proj-"));

  it("lists empty, registers, 422s a bad dir, gets detail, deletes", async () => {
    expect((await get("/api/v1/projects")).json()).toEqual([]);

    const created = await app.inject({ method: "POST", url: "/api/v1/projects", payload: { path: projectDir, name: "Demo" } });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { name: string }).name).toBe("Demo");

    const bad = await app.inject({ method: "POST", url: "/api/v1/projects", payload: { path: join(projectDir, "nope") } });
    expect(bad.statusCode).toBe(422);

    const detail = await get(`/api/v1/projects/${encodeURIComponent(projectDir)}`);
    expect(detail.statusCode).toBe(200);
    const d = detail.json() as { name: string; constitution: unknown; recent_runs: unknown[] };
    expect(d.name).toBe("Demo");
    expect(d.constitution).toBeTruthy();
    expect(Array.isArray(d.recent_runs)).toBe(true);

    const del = await app.inject({ method: "DELETE", url: `/api/v1/projects/${encodeURIComponent(projectDir)}` });
    expect((del.json() as { removed: boolean }).removed).toBe(true);
  });

  it("PUT profile with invalid yaml → 422", async () => {
    const r = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${encodeURIComponent(projectDir)}/profile`,
      payload: { yaml: "just a string, no mapping" },
    });
    expect(r.statusCode).toBe(422);
    expect((r.json() as { error: string }).error).toBe("validation failed");
  });
});

describe("provider keys — write-only + masked", () => {
  const RAW = "sk-ant-secrettestkey1234";

  it("PUT stores a key and returns a masked status; GET never leaks the raw key", async () => {
    const put = await app.inject({ method: "PUT", url: "/api/v1/providers/anthropic/key", payload: { api_key: RAW } });
    expect(put.statusCode).toBe(200);
    const body = put.json() as { has_api_key: boolean; masked_key: string | null };
    expect(body.has_api_key).toBe(true);
    expect(body.masked_key).toBeTruthy();
    expect(put.payload).not.toContain(RAW); // response never echoes the raw key

    const list = await get("/api/v1/providers");
    const providers = list.json() as Array<{ vendor: string; has_api_key: boolean; masked_key: string | null }>;
    const ant = providers.find((p) => p.vendor === "anthropic")!;
    expect(ant.has_api_key).toBe(true);
    expect(ant.masked_key).not.toBe(RAW);
    expect(list.payload).not.toContain(RAW);

    const del = await app.inject({ method: "DELETE", url: "/api/v1/providers/anthropic/key" });
    expect((del.json() as { has_api_key: boolean }).has_api_key).toBe(false);
  });

  it("PUT with a too-short key → 422", async () => {
    const r = await app.inject({ method: "PUT", url: "/api/v1/providers/anthropic/key", payload: { api_key: "x" } });
    expect(r.statusCode).toBe(422);
  });
});

describe("run reads + run-control 501", () => {
  it("GET /runs empty, unknown run 404", async () => {
    expect((await get("/api/v1/runs")).json()).toEqual([]);
    expect((await get("/api/v1/runs/run_missing")).statusCode).toBe(404);
  });

  it("run-control routes return 501 run_control_pending", async () => {
    const start = await app.inject({ method: "POST", url: "/api/v1/runs", payload: { project_path: "x", request_text: "y", mode: "single" } });
    expect(start.statusCode).toBe(501);
    expect((start.json() as { error: string }).error).toBe("run_control_pending");

    const abort = await app.inject({ method: "POST", url: "/api/v1/runs/run_x/abort" });
    expect(abort.statusCode).toBe(501);
  });
});
