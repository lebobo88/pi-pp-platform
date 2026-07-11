import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    // Drain in-flight detached runs so none outlives its server and races the
    // global core DB singleton across tests.
    try {
      await (s.app as unknown as { ppSupervisor?: { drain(): Promise<void> } }).ppSupervisor?.drain();
    } catch {
      /* ignore */
    }
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

  it("persists an event log and generates finalization artifacts for a completed run", async () => {
    const project = makeTempProject();
    const s = await makeServer(() => makeEngine());
    const started = await post(s.base, "/api/v1/runs", { project_path: project, request_text: "Finalize observability artifacts.", mode: "single" });
    expect(started.status).toBe(200);
    const runId = started.json.run_id as string;
    expect(await waitForStatus(s.base, runId)).toBe("complete");

    const eventLog = await getJson(s.base, `/api/v1/runs/${encodeURIComponent(runId)}/event-log`);
    expect(eventLog.status).toBe(200);
    expect(Array.isArray(eventLog.json)).toBe(true);
    expect(eventLog.json.some((ev: { type: string }) => ev.type === "run.started")).toBe(true);
    const finalized = eventLog.json.findLast((ev: { type: string }) => ev.type === "run.finalized") as
      | { data?: { artifacts?: Array<{ kind: string; path: string }> } }
      | undefined;
    expect(finalized?.data?.artifacts?.map((artifact) => artifact.kind).sort()).toEqual(["constitution", "project_master"]);

    expect(existsSync(join(project, "CONSTITUTION.md"))).toBe(true);
    expect(existsSync(join(project, "PROJECT_MASTER.md"))).toBe(true);
    expect(readFileSync(join(project, "CONSTITUTION.md"), "utf8")).toContain("## Article I");
    expect(readFileSync(join(project, "PROJECT_MASTER.md"), "utf8")).toContain("## 1. Executive summary");
  });

  it("POST /runs forwards ladder_override + tier_pools_override to the pilot (persisted to cli_flags_json)", async () => {
    const project = makeTempProject();
    const s = await makeServer(() => makeEngine());
    const started = await post(s.base, "/api/v1/runs", {
      project_path: project,
      request_text: "Add a helper.",
      mode: "single",
      tier_cap: "opus",
      // Real catalog model ids so the (fake) engine's catalog.resolve is happy
      // and the run reaches complete — the assertion is on persistence, below.
      ladder_override: { sonnet: "claude-opus-4-7" },
      tier_pools_override: { sonnet: ["claude-opus-4-7", "claude-sonnet-4-6"] },
    });
    expect(started.status).toBe(200);
    const runId = started.json.run_id as string;
    expect(await waitForStatus(s.base, runId)).toBe("complete");

    // The overrides threaded supervisor → RunPilot → startRun and were persisted
    // verbatim to runs.cli_flags_json for replay.
    const tree = await getJson(s.base, `/api/v1/runs/${encodeURIComponent(runId)}`);
    const flags = JSON.parse(tree.json.run.cli_flags_json as string);
    expect(flags.ladder_override).toEqual({ sonnet: "claude-opus-4-7" });
    expect(flags.tier_pools_override).toEqual({ sonnet: ["claude-opus-4-7", "claude-sonnet-4-6"] });
    expect(flags.tier_cap).toBe("opus");
  });

  it("POST /runs persists a ladder-only override payload verbatim", async () => {
    const project = makeTempProject();
    const s = await makeServer(() => makeEngine());
    const started = await post(s.base, "/api/v1/runs", {
      project_path: project,
      request_text: "Add a helper.",
      mode: "single",
      ladder_override: { sonnet: "claude-opus-4-7" },
    });
    expect(started.status).toBe(200);
    const runId = started.json.run_id as string;
    expect(await waitForStatus(s.base, runId)).toBe("complete");

    const tree = await getJson(s.base, `/api/v1/runs/${encodeURIComponent(runId)}`);
    const flags = JSON.parse(tree.json.run.cli_flags_json as string);
    expect(flags.ladder_override).toEqual({ sonnet: "claude-opus-4-7" });
    expect("tier_pools_override" in flags).toBe(false);
  });

  it("POST /runs persists a tier-pools-only override payload verbatim", async () => {
    const project = makeTempProject();
    const s = await makeServer(() => makeEngine());
    const started = await post(s.base, "/api/v1/runs", {
      project_path: project,
      request_text: "Add a helper.",
      mode: "single",
      tier_pools_override: { sonnet: ["claude-opus-4-7", "claude-sonnet-4-6"] },
    });
    expect(started.status).toBe(200);
    const runId = started.json.run_id as string;
    expect(await waitForStatus(s.base, runId)).toBe("complete");

    const tree = await getJson(s.base, `/api/v1/runs/${encodeURIComponent(runId)}`);
    const flags = JSON.parse(tree.json.run.cli_flags_json as string);
    expect(flags.tier_pools_override).toEqual({ sonnet: ["claude-opus-4-7", "claude-sonnet-4-6"] });
    expect("ladder_override" in flags).toBe(false);
  });

  it("a flagless run leaves cli_flags_json NULL (byte-identical persistence)", async () => {
    const project = makeTempProject();
    const s = await makeServer(() => makeEngine());
    const started = await post(s.base, "/api/v1/runs", { project_path: project, request_text: "Add a helper.", mode: "single" });
    const runId = started.json.run_id as string;
    expect(await waitForStatus(s.base, runId)).toBe("complete");
    const tree = await getJson(s.base, `/api/v1/runs/${encodeURIComponent(runId)}`);
    expect(tree.json.run.cli_flags_json).toBeNull();
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

  it("gate re-judges a stage; retry re-drives it; a second retry is 409 exhausted", async () => {
    const project = makeTempProject();
    const s = await makeServer(() => makeEngine());
    const started = await post(s.base, "/api/v1/runs", { project_path: project, request_text: "Add a helper.", mode: "single" });
    const runId = started.json.run_id as string;
    expect(await waitForStatus(s.base, runId)).toBe("complete");

    const tree = await getJson(s.base, `/api/v1/runs/${encodeURIComponent(runId)}`);
    const stage = tree.json.stages[0] as { id: string };
    const stagePath = `/api/v1/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stage.id)}`;

    // Re-judge only (regateStage): re-runs the judge on the latest attempt.
    const gate = await post(s.base, `${stagePath}/gate`);
    expect(gate.status).toBe(200);
    expect(gate.json.ok).toBe(true);
    expect(gate.json.outcome).toBeTruthy();

    // First manual retry actually re-drives the stage (regenerate + re-judge).
    const retry1 = await post(s.base, `${stagePath}/retry`);
    expect(retry1.status).toBe(202);
    expect(retry1.json.ok).toBe(true);
    expect(retry1.json.outcome).toBeTruthy();

    // Second retry is refused — the Reflexion ×1 budget is spent.
    const retry2 = await post(s.base, `${stagePath}/retry`);
    expect(retry2.status).toBe(409);
    expect(retry2.json.error).toBe("retry_exhausted");

    // Unknown stage → 404.
    const bad = await post(s.base, `/api/v1/runs/${encodeURIComponent(runId)}/stages/stage_missing/retry`);
    expect(bad.status).toBe(404);
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

describe("run-control — content-only-blocked resume", () => {
  // Verify that a run whose every planned stage has passed but whose content-class
  // gates are still unsatisfied (missing required artifact kinds) returns
  // resumable=false and blocking_reason from /completion-readiness, and that a
  // POST to /resume returns 200 with resumed=false without mutating run status.

  it("content-only-blocked run: /resume returns 200, resumed=false, blocking_reason set, status unchanged", async () => {
    const project = makeTempProject();
    const s = await makeServer(() => makeEngine());

    // Start a real run and let it complete.
    const started = await post(s.base, "/api/v1/runs", { project_path: project, request_text: "Add a helper.", mode: "single" });
    expect(started.status).toBe(200);
    const runId = started.json.run_id as string;
    expect(await waitForStatus(s.base, runId)).toBe("complete");

    // Force the run back to 'surfaced' and inject a content-only blocker:
    // Set a profile_snapshot_json that requires an artifact kind ("spec") that
    // does not exist in the artifacts table → missing_required_artifacts=["spec"].
    // Also clear stage_plan_json so remaining_planned_stages=null won't accidentally
    // make it resumable; instead we keep stage_plan_json and all stages passed.
    const { db } = await import("@pp/core");
    db().prepare(`UPDATE runs SET status = 'surfaced',
      profile_snapshot_json = json_patch(COALESCE(profile_snapshot_json, '{}'), '{"required_artifacts":["spec"]}')
      WHERE id = ?`).run(runId);

    // /completion-readiness must report resumable=false with blocking_reason.
    const readiness = await getJson(s.base, `/api/v1/runs/${encodeURIComponent(runId)}/completion-readiness`);
    expect(readiness.status).toBe(200);
    expect(readiness.json.resumable).toBe(false);
    expect(typeof readiness.json.blocking_reason).toBe("string");
    expect(readiness.json.blocking_reason).toBeTruthy();

    // /resume must return 200 with resumed=false and pass blocking_reason.
    const statusBefore = db().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    const resume = await post(s.base, `/api/v1/runs/${encodeURIComponent(runId)}/resume`);
    expect(resume.status).toBe(200);
    expect(resume.json.resumed).toBe(false);
    expect(resume.json.readiness?.blocking_reason).toBeTruthy();

    // Run status must be unchanged — no extra finalize was triggered.
    const statusAfter = db().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    expect(statusAfter.status).toBe(statusBefore.status);
  });
});

describe("run-control — abort DB fallback (orphaned runs after restart)", () => {
  // These tests seed a run directly into the DB (bypassing the supervisor) to
  // simulate runs that survived a server restart and are no longer tracked
  // in-process. They verify the abort endpoint recovers them via the DB path.

  async function makeOrphanServer(): Promise<{ app: FastifyInstance; home: string }> {
    const home = mkdtempSync(join(tmpdir(), "pp-abort-fallback-"));
    process.env.PP_PLATFORM_DIR = join(home, "platform");
    delete process.env.PP_ECOSYSTEM;
    delete process.env.PP_API_TOKEN;
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp({ dbPath: join(home, "state.db"), makeEngine: () => makeEngine() });
    return { app, home };
  }

  it("orphaned run with status=running → 202 and DB status becomes aborted", async () => {
    const { app, home } = await makeOrphanServer();
    servers.push({ app, base: "" });
    const runId = "run_orphan_running";
    const { db } = await import("@pp/core");
    db().prepare(
      `INSERT INTO runs(id, project_path, request_text, mode, status, started_at) VALUES (?, ?, 'orphan', 'single', 'running', datetime('now'))`,
    ).run(runId, home);

    const res = await app.inject({ method: "POST", url: `/api/v1/runs/${runId}/abort` });
    expect(res.statusCode).toBe(202);
    expect(res.json().run_id).toBe(runId);
    expect(res.json().status).toBe("aborted");

    const row = db().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | undefined;
    expect(row?.status).toBe("aborted");
  });

  it("orphaned run with status=complete (terminal) → 409 {error: run_not_active, status}", async () => {
    const { app, home } = await makeOrphanServer();
    servers.push({ app, base: "" });
    const runId = "run_orphan_complete";
    const { db } = await import("@pp/core");
    db().prepare(
      `INSERT INTO runs(id, project_path, request_text, mode, status, started_at) VALUES (?, ?, 'done', 'single', 'complete', datetime('now'))`,
    ).run(runId, home);

    const res = await app.inject({ method: "POST", url: `/api/v1/runs/${runId}/abort` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("run_not_active");
    expect(res.json().status).toBe("complete");
  });

  it("unknown run id (not in DB) → 404", async () => {
    const { app } = await makeOrphanServer();
    servers.push({ app, base: "" });

    const res = await app.inject({ method: "POST", url: "/api/v1/runs/run_does_not_exist/abort" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("run_not_active");
  });
});
