/**
 * context.warning SSE event tests.
 *
 * Verifies that the supervisor publishes a `context.warning` frame when an
 * attempt.completed event carries context_pct > 0.75, and that it does NOT
 * fire for lower fill or when context fields are absent.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { createEngine, toGenProvider, type Engine, type GenResult } from "@pp/engine";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-ctx-warn-"));
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@pp.local", "-c", "user.name=pp-test", ...args], {
      cwd: dir,
      stdio: "ignore",
    });
  git(["init", "-q"]);
  writeFileSync(join(dir, "README.md"), "# temp\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  return dir;
}

// Rich enough to satisfy the grader gate in single mode.
const RICH =
  "# Artifact\n\n## Non-functional requirements\n" +
  "latency p95 < 200ms, availability/SLO 99.9%, RTO/RPO, cost budget capped.\n\n" +
  "## Test data management\nfixtures + seed data, masking / synthetic anonymization.\n\n" +
  "## Decisions\nADR: rationale recorded; tradeoff + alternative documented.\n\n" +
  "## Ownership\nowner/maintainer: @maintainer.\n";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build a GenResult, optionally including context-window fill fields. */
function gr(
  model: { id: string; provider: string },
  text: string,
  parsed?: unknown,
  ctx?: { context_used_tokens: number; context_max_tokens: number },
): GenResult {
  return {
    text,
    parsed,
    tokens_in: 10,
    tokens_out: 20,
    cost_usd: 0.002,
    model: model.id,
    provider: toGenProvider(model.provider),
    wall_ms: 1,
    session_id: null,
    stop_reason: "stop",
    ...(ctx ?? {}),
  };
}

/**
 * Fake engine that returns the given context fill values on every authoring
 * attempt. Critique always passes with no context data (judges don't fill
 * the context window). When ctx is undefined the engine behaves like the
 * standard fake (no context fields → graceful degradation).
 */
function makeEngine(ctx?: { context_used_tokens: number; context_max_tokens: number }): Engine {
  const fake = createEngine({ mode: "fake" });
  return {
    ...fake,
    runAuthoringCompletion: async (o) => gr(o.model, RICH, undefined, ctx),
    runCodingSession: async (o) => {
      const base = await fake.runCodingSession(o);
      return ctx ? { ...base, ...ctx } : base;
    },
    critique: async (o) => {
      const verdict = {
        outcome: "pass",
        critique_md: "scripted pass; correctness and minimality both satisfied for this deterministic fake artifact.",
        score: { correctness: 0.9, minimality: 0.8 },
      };
      return gr(o.judgeModel, JSON.stringify(verdict), verdict);
    },
  };
}

// ── server lifecycle ──────────────────────────────────────────────────────────

interface Server { app: FastifyInstance; base: string }
const servers: Server[] = [];

async function makeServer(makeEngineFn: () => Engine): Promise<Server> {
  const home = mkdtempSync(join(tmpdir(), "pp-ctx-srv-"));
  process.env.PP_PLATFORM_DIR = join(home, "platform");
  delete process.env.PP_ECOSYSTEM;
  delete process.env.PP_API_TOKEN;
  delete process.env.PP_MAX_CONCURRENT_RUNS;
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
    try {
      await (s.app as unknown as { ppSupervisor?: { drain(): Promise<void> } }).ppSupervisor?.drain();
    } catch { /* ignore */ }
    await s.app.close();
  }
});

// ── request helpers ───────────────────────────────────────────────────────────

async function post(base: string, path: string, body?: unknown) {
  const init: RequestInit =
    body !== undefined
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : { method: "POST" };
  const res = await fetch(base + path, init);
  // ANTI-PATTERN-OK: standard test JSON helper for unknown response shapes; mirrors run-control.test.ts:92
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

async function getJson(base: string, path: string) {
  const res = await fetch(base + path);
  // ANTI-PATTERN-OK: standard test JSON helper for unknown response shapes; mirrors run-control.test.ts:96
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

/** Read SSE frames until `needle` appears in the buffer or the deadline passes. */
async function readSse(
  url: string,
  needle: string,
  headers: Record<string, string> = {},
  ms = 8000,
): Promise<string> {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline && !buf.includes(needle)) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), 250),
        ),
      ]);
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

// ── tests ─────────────────────────────────────────────────────────────────────

describe("context.warning SSE event", () => {
  it("fires when context_pct > 0.75 (160 000/200 000 = 80% fill)", async () => {
    // 160 000 / 200 000 = 0.80 → above 0.75 → warning must be published
    const s = await makeServer(() =>
      makeEngine({ context_used_tokens: 160_000, context_max_tokens: 200_000 }),
    );
    const project = makeTempProject();
    // Subscribe before posting so we cannot race the event.
    const warnBufPromise = readSse(`${s.base}/api/v1/events`, "event: context.warning", {}, 12_000);
    await delay(50);
    const started = await post(s.base, "/api/v1/runs", {
      project_path: project,
      request_text: "Add a greeting helper.",
      mode: "single",
    });
    expect(started.status).toBe(200);
    const buf = await warnBufPromise;
    expect(buf).toContain("event: context.warning");
    expect(buf).toContain('"context_pct":0.8');
    expect(buf).toContain('"context_used_tokens":160000');
    expect(buf).toContain('"context_max_tokens":200000');
  });

  it("does NOT fire when context_pct <= 0.75 (100 000/200 000 = 50% fill)", async () => {
    // 100 000 / 200 000 = 0.50 → at or below 0.75 → no warning
    const s = await makeServer(() =>
      makeEngine({ context_used_tokens: 100_000, context_max_tokens: 200_000 }),
    );
    const project = makeTempProject();
    const started = await post(s.base, "/api/v1/runs", {
      project_path: project,
      request_text: "Add a greeting helper.",
      mode: "single",
    });
    expect(started.status).toBe(200);
    const runId = started.json.run_id as string;
    await waitForStatus(s.base, runId);
    // Replay the full ring buffer after completion and check absence.
    const buf = await readSse(
      `${s.base}/api/v1/runs/${encodeURIComponent(runId)}/events`,
      "event: run.finalized",
      { "last-event-id": "0" },
      4000,
    );
    expect(buf).toContain("event: run.finalized");
    expect(buf).not.toContain("event: context.warning");
  });

  it("does NOT fire when context fields are absent (model window unknown)", async () => {
    // No context_used_tokens / context_max_tokens → graceful degradation, no warning
    const s = await makeServer(() => makeEngine());
    const project = makeTempProject();
    const started = await post(s.base, "/api/v1/runs", {
      project_path: project,
      request_text: "Add a greeting helper.",
      mode: "single",
    });
    expect(started.status).toBe(200);
    const runId = started.json.run_id as string;
    await waitForStatus(s.base, runId);
    const buf = await readSse(
      `${s.base}/api/v1/runs/${encodeURIComponent(runId)}/events`,
      "event: run.finalized",
      { "last-event-id": "0" },
      4000,
    );
    expect(buf).toContain("event: run.finalized");
    expect(buf).not.toContain("event: context.warning");
  });
});
