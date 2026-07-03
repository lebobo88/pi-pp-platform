import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";

// Isolate the DB + platform auth dir + keep the ecosystem off BEFORE buildApp.
const home = mkdtempSync(join(tmpdir(), "pp-page-home-"));
process.env.PP_PLATFORM_DIR = join(home, "platform");
process.env.PP_SKIP_CLI_VERSIONS = "1";
delete process.env.PP_ECOSYSTEM;
delete process.env.PP_API_TOKEN;
const dbPath = join(home, "state.db");

const TOKEN = "s3kret-test-token";

let app: FastifyInstance;          // no token — pagination + validation
let tokenApp: FastifyInstance;     // bearer-gated — SSE ?token= auth
let tokenBase: string;

interface RunListPage {
  items: Array<{ id: string; project_path: string }>;
  next_cursor: string | null;
}

beforeAll(async () => {
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ dbPath });

  // Seed rows straight into the runs table (read-path test; no pilot needed).
  const { db } = await import("@pp/core");
  const insert = db().prepare(
    `INSERT INTO runs(id, project_path, request_text, mode, status, started_at)
     VALUES (?, ?, 'seed', 'single', 'complete', ?)`,
  );
  for (let i = 1; i <= 5; i++) {
    insert.run(`run_page_${String(i).padStart(2, "0")}`, join(home, "proj"), `2026-07-01T00:00:0${i}.000Z`);
  }
  // Two rows tied on started_at, newest overall — the id DESC tie-break.
  insert.run("run_tie_b", join(home, "proj"), "2026-07-02T00:00:00.000Z");
  insert.run("run_tie_a", join(home, "proj"), "2026-07-02T00:00:00.000Z");

  tokenApp = await buildApp({ dbPath, token: TOKEN });
  await tokenApp.listen({ port: 0, host: "127.0.0.1" });
  const addr = tokenApp.server.address() as AddressInfo;
  tokenBase = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app?.close();
  await tokenApp?.close();
});

async function get(url: string) {
  return app.inject({ method: "GET", url });
}

/** Fetch and immediately abort once headers arrive (SSE streams never end). */
async function sseProbe(url: string, headers: Record<string, string> = {}) {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  const status = res.status;
  const contentType = res.headers.get("content-type") ?? "";
  ac.abort();
  try { await res.body?.cancel(); } catch { /* aborted */ }
  return { status, contentType };
}

describe("GET /api/v1/runs — cursor-paginated envelope", () => {
  it("returns {items, next_cursor} and pages round-trip without dup/gap", async () => {
    const all = (await get("/api/v1/runs")).json() as RunListPage;
    expect(Array.isArray(all.items)).toBe(true);
    expect(all.items).toHaveLength(7);
    expect(all.next_cursor).toBeNull();
    // Ties order by id DESC.
    expect(all.items[0]!.id).toBe("run_tie_b");
    expect(all.items[1]!.id).toBe("run_tie_a");

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = cursor
        ? `/api/v1/runs?limit=3&cursor=${encodeURIComponent(cursor)}`
        : "/api/v1/runs?limit=3";
      const page = (await get(url)).json() as RunListPage;
      seen.push(...page.items.map((r) => r.id));
      cursor = page.next_cursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3); // 7 rows at limit 3
    expect(seen).toEqual(all.items.map((r) => r.id)); // no dup, no gap, same order
  });

  it("legacy GET /runs keeps the bare-array shape", async () => {
    const r = await get("/runs");
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json())).toBe(true);
    expect(r.json()).toHaveLength(7);
  });
});

describe("POST /runs — n accepts 2..8", () => {
  it("n=8 passes schema validation (fails later on the tier-flag rule, not on n)", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      payload: { project_path: tmpdir(), request_text: "x", mode: "best_of", n: 8, tier_cap: "opus" },
    });
    expect(r.statusCode).toBe(422);
    const body = r.json() as { details: { tier?: string; fieldErrors?: Record<string, unknown> } };
    expect(body.details.tier).toBeTruthy(); // reached the post-parse tier rule
    expect(body.details.fieldErrors).toBeUndefined(); // no zod complaint about n
  });

  it("n=9 is rejected by the schema", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      payload: { project_path: tmpdir(), request_text: "x", mode: "best_of", n: 9 },
    });
    expect(r.statusCode).toBe(422);
    const body = r.json() as { details: { fieldErrors: Record<string, unknown> } };
    expect(body.details.fieldErrors).toHaveProperty("n");
  });
});

describe("SSE ?token= auth (EventSource cannot send headers)", () => {
  it("valid ?token= opens both SSE streams (200 + event-stream)", async () => {
    const global_ = await sseProbe(`${tokenBase}/api/v1/events?token=${encodeURIComponent(TOKEN)}`);
    expect(global_.status).toBe(200);
    expect(global_.contentType).toContain("text/event-stream");

    const perRun = await sseProbe(`${tokenBase}/api/v1/runs/run_tie_a/events?token=${encodeURIComponent(TOKEN)}`);
    expect(perRun.status).toBe(200);
    expect(perRun.contentType).toContain("text/event-stream");
  });

  it("wrong or missing ?token= is 401", async () => {
    const wrong = await fetch(`${tokenBase}/api/v1/events?token=wrong`);
    expect(wrong.status).toBe(401);
    const missing = await fetch(`${tokenBase}/api/v1/events`);
    expect(missing.status).toBe(401);
  });

  it("?token= is NOT accepted on non-SSE endpoints; the bearer header still is", async () => {
    const viaQuery = await fetch(`${tokenBase}/api/v1/runs?token=${encodeURIComponent(TOKEN)}`);
    expect(viaQuery.status).toBe(401);
    const viaHeader = await fetch(`${tokenBase}/api/v1/runs`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(viaHeader.status).toBe(200);
  });

  it("the bearer header also works on the SSE streams", async () => {
    const r = await sseProbe(`${tokenBase}/api/v1/events`, { authorization: `Bearer ${TOKEN}` });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain("text/event-stream");
  });
});
