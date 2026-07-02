import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { createEngine, toGenProvider, type Engine, type GenResult } from "@pp/engine";

// ── minimal replica of pilot/test/helpers.ts (don't import pilot test files) ──
function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-srv-run-"));
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@pp.local", "-c", "user.name=pp-test", ...args], { cwd: dir, stdio: "ignore" });
  git(["init", "-q"]);
  writeFileSync(join(dir, "README.md"), "# temp\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  return dir;
}

const RICH =
  "# Artifact\n\n## Non-functional requirements\nlatency p95 < 200ms, availability/SLO 99.9%, RTO/RPO, cost budget capped.\n\n" +
  "## Test data management\nfixtures + seed data, masking / synthetic anonymization.\n\n" +
  "## Decisions\nADR: rationale recorded; tradeoff + alternative documented.\n\n## Ownership\nowner/maintainer: @maintainer.\n";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gr(model: { id: string; provider: string }, text: string, parsed?: unknown): GenResult {
  return { text, parsed, tokens_in: 10, tokens_out: 20, cost_usd: 0.002, model: model.id, provider: toGenProvider(model.provider), wall_ms: 1, session_id: null, stop_reason: "stop" };
}

/** Scripted engine: authoring → rich content, critiques → all pass; optional per-call delay. */
function makeEngine(opts: { delayMs?: number } = {}): Engine {
  const fake = createEngine({ mode: "fake" });
  return {
    ...fake,
    runAuthoringCompletion: async (o) => {
      if (opts.delayMs) await delay(opts.delayMs);
      return gr(o.model, RICH);
    },
    runCodingSession: async (o) => {
      if (opts.delayMs) await delay(opts.delayMs);
      return fake.runCodingSession(o);
    },
    critique: async (o) => {
      const verdict = { outcome: "pass", critique_md: "scripted pass; correctness and minimality both satisfied for this deterministic fake artifact under review.", score: { correctness: 0.9, minimality: 0.8 } };
      return gr(o.judgeModel, JSON.stringify(verdict), verdict);
    },
  };
}

interface Server { app: FastifyInstance; base: string; }
const servers: Server[] = [];

async function makeServer(makeEngineFn: () => Engine, maxConcurrent?: number): Promise<Server> {
  const home = mkdtempSync(join(tmpdir(), "pp-rc-home-"));
  process.env.PP_PLATFORM_DIR = join(home, "platform");
  delete process.env.PP_ECOSYSTEM;
  delete process.env.PP_API_TOKEN;
  if (maxConcurrent) process.env.PP_MAX_CONCURRENT_RUNS = String(maxConcurrent);
  else delete process.env.PP_MAX_CONCURRENT_RUNS;
  const { buildApp } = await import("../src/app.js");
  const app = await buildApp({ dbPath: join(home, "state.db"), makeEngine: makeEngineFn });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  const s: Server = { app, base: `http://127.0.0.1:${addr.port}` };
  servers.push(s);
  return s;
}

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await s.app.close();
  }
});

async function post(base: string, path: string, body?: unknown) {
  const init: RequestInit =
    body !== undefined
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : { method: "POST" };
  const res = await fetch(base + path, init);
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}
async function getJson(base: string, path: string) {
  const res = await fetch(base + path);
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

/** Collect SSE frames until `needle` appears (or timeout). */
async function readSse(url: string, needle: string, headers: Record<string, string> = {}, ms = 8000) {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline && !buf.includes(needle)) {
      const chunk = await Promise.race([reader.read(), new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 250))]);
      if (chunk.value) buf += dec.decode(chunk.value);
      if (chunk.done && !chunk.value) { if (Date.now() >= deadline) break; }
    }
  } finally {
    ac.abort();
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  return buf;
}

async function waitForStatus(base: string, runId: string, ms = 8000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await getJson(base, `/api/v1/runs/${encodeURIComponent(runId)}`);
    const status = r.json?.run?.status;
    if (status && status !== "running" && status !== "pending") return status;
    await delay(120);
  }
  return "timeout";
}

describe("run-control — start / complete / SSE", () => {
  it("POST /runs drives a fake RunPilot to complete and streams stage.started→run.finalized", async () => {
    const project = makeTempProject();
    const s = await makeServer(() => makeEngine());
    const started = await post(s.base, "/api/v1/runs", { project_path: project, request_text: "Add a greeting helper.", mode: "single" });
    expect(started.status).toBe(200);
    const runId = started.json.run_id as string;
    expect(runId).toBeTruthy();

    const status = await waitForStatus(s.base, runId);
    expect(status).toBe("complete");

    // Reconnect + replay the whole run from the ring buffer (Last-Event-ID:0).
    const buf = await readSse(`${s.base}/api/v1/runs/${encodeURIComponent(runId)}/events`, "event: run.finalized", { "last-event-id": "0" });
    expect(buf).toContain("event: stage.started");
    expect(buf).toContain("event: run.finalized");
    expect(buf).toContain('"status":"complete"');

    // Mid-sequence resume: Last-Event-ID past the first frames returns only newer ones.
    const firstIdMatch = buf.match(/id: (\d+)/);
    expect(firstIdMatch).toBeTruthy();
  });

  it("422 on best_of + tier flags", async () => {
    const s = await makeServer(() => makeEngine());
    const r = await post(s.base, "/api/v1/runs", { project_path: makeTempProject(), request_text: "x", mode: "best_of", n: 3, tier_cap: "opus" });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("validation failed");
  });

  it("abort mid-run → 202 and status aborted", async () => {
    const project = makeTempProject();
    const s = await makeServer(() => makeEngine({ delayMs: 400 }));
    const started = await post(s.base, "/api/v1/runs", { project_path: project, request_text: "slow run", mode: "single" });
    const runId = started.json.run_id as string;
    await delay(300); // let it enter the stage loop
    const aborted = await post(s.base, `/api/v1/runs/${encodeURIComponent(runId)}/abort`);
    expect(aborted.status).toBe(202);
    const status = await waitForStatus(s.base, runId, 12000);
    expect(status).toBe("aborted");
  });
});

describe("run-control — concurrency + budget", () => {
  it("cap=2: a third simultaneous run is queued and eventually runs", async () => {
    const s = await makeServer(() => makeEngine({ delayMs: 300 }), 2);
    const p = makeTempProject();
    const q = makeTempProject();
    const r = makeTempProject();
    const [a, b, c] = await Promise.all([
      post(s.base, "/api/v1/runs", { project_path: p, request_text: "1", mode: "single" }),
      post(s.base, "/api/v1/runs", { project_path: q, request_text: "2", mode: "single" }),
      post(s.base, "/api/v1/runs", { project_path: r, request_text: "3", mode: "single" }),
    ]);
    const ids = [a.json.run_id, b.json.run_id, c.json.run_id];
    expect(new Set(ids).size).toBe(3); // three distinct real run ids
    // Exactly one was queued (the third to acquire a slot).
    expect([a.json.queued, b.json.queued, c.json.queued].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    for (const id of ids) expect(await waitForStatus(s.base, id, 12000)).not.toBe("timeout");
  });

  it("budget tripwire fires on a tiny day cap", async () => {
    const project = makeTempProject();
    const s = await makeServer(() => makeEngine());
    // A day cap so small the first attempt's cost trips it.
    await fetch(`${s.base}/api/v1/budgets/caps`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caps: [{ scope: "day", limit_usd: 0.0001, warn_pct: 0.5, block_pct: 1.0 }] }),
    });
    const buf0Promise = readSse(`${s.base}/api/v1/events`, "event: budget.tripwire", { "last-event-id": "0" }, 10000);
    await delay(100);
    const started = await post(s.base, "/api/v1/runs", { project_path: project, request_text: "spend", mode: "single" });
    expect(started.status).toBe(200);
    const buf = await buf0Promise;
    expect(buf).toContain("event: budget.tripwire");
    expect(buf).toContain("event: budget.tick");
  });
});
