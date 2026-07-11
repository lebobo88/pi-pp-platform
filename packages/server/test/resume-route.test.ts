import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { createEngine, toGenProvider, type Engine, type GenResult } from "@pp/engine";
import { db } from "@pp/core";

// ── minimal replica of pilot/test/helpers.ts (don't import pilot test files) ──
function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-srv-resume-"));
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

async function makeServer(makeEngineFn: () => Engine): Promise<Server> {
  const home = mkdtempSync(join(tmpdir(), "pp-resume-home-"));
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

async function readSse(url: string, needle: string, headers: Record<string, string> = {}, ms = 8000) {
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
        new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 250)),
      ]);
      if (chunk.value) buf += dec.decode(chunk.value);
      if (chunk.done && !chunk.value) {
        if (Date.now() >= deadline) break;
      }
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

describe("resume routes — GET completion-readiness / POST resume", () => {
  it("404s both routes for an unknown run_id", async () => {
    const s = await makeServer(() => makeEngine());
    const readiness = await getJson(s.base, `/api/v1/runs/run_does_not_exist/completion-readiness`);
    expect(readiness.status).toBe(404);
    const resume = await post(s.base, `/api/v1/runs/run_does_not_exist/resume`);
    expect(resume.status).toBe(404);
  });

  it("reports resumable:false and refuses resume while a run is genuinely 'running'", async () => {
    const project = makeTempProject();
    const s = await makeServer(() => makeEngine());
    const started = await post(s.base, "/api/v1/runs", { project_path: project, request_text: "Add a helper.", mode: "single" });
    const runId = started.json.run_id as string;
    expect(await waitForStatus(s.base, runId)).toBe("complete");

    // Force the run back to 'running' (simulating an in-flight/crash-recovered
    // state that never actually surfaced) — resume must reject rather than guess.
    db().prepare(`UPDATE runs SET status = 'running' WHERE id = ?`).run(runId);

    const resume = await post(s.base, `/api/v1/runs/${encodeURIComponent(runId)}/resume`);
    expect(resume.status).toBe(200);
    expect(resume.json.resumed).toBe(false);
  });

  it("all planned stages passed with no remaining stages → resumable=false (nothing left to re-run)", async () => {
    const project = makeTempProject();
    const s = await makeServer(() => makeEngine());
    const started = await post(s.base, "/api/v1/runs", { project_path: project, request_text: "Add a helper.", mode: "single" });
    const runId = started.json.run_id as string;
    expect(await waitForStatus(s.base, runId)).toBe("complete");

    // Force status back to 'surfaced'. All stage rows are already 'passed' and
    // stage_plan_json is persisted, so remaining_planned_stages=[] — resume
    // has no stage work to perform and must report resumable=false.
    db().prepare(`UPDATE runs SET status = 'surfaced' WHERE id = ?`).run(runId);

    const readiness = await getJson(s.base, `/api/v1/runs/${encodeURIComponent(runId)}/completion-readiness`);
    expect(readiness.status).toBe(200);
    // Fix 2a: resumable=false because all planned stages are covered and there is
    // no re-runnable stage work left. Content-only blockers (if any) must be
    // cleared via artifact/evidence/master-plan actions, not resume.
    expect(readiness.json.resumable).toBe(false);
    expect(readiness.json.blocking_reason).toBeTruthy();
    expect(readiness.json.surfaced_stages).toEqual([]);

    // /resume must return 200 with resumed=false — no extra finalize dispatched.
    const resume = await post(s.base, `/api/v1/runs/${encodeURIComponent(runId)}/resume`);
    expect(resume.status).toBe(200);
    expect(resume.json.resumed).toBe(false);
    expect(resume.json.readiness?.blocking_reason).toBeTruthy();
  });

  it("resumes a run that has a remaining planned stage and reaches 'complete'", async () => {
    const project = makeTempProject();
    const s = await makeServer(() => makeEngine({ delayMs: 0 }));
    const started = await post(s.base, "/api/v1/runs", { project_path: project, request_text: "Add a helper.", mode: "single" });
    const runId = started.json.run_id as string;
    expect(await waitForStatus(s.base, runId, 15000)).toBe("complete");

    // Simulate a remaining planned stage by dropping the last stage's rows (same
    // technique as the concurrent-resume test), then force to 'surfaced'.
    const lastStage = db()
      .prepare(`SELECT id FROM stages WHERE run_id = ? ORDER BY plan_index DESC LIMIT 1`)
      .get(runId) as { id: string };
    db().prepare(`DELETE FROM verdicts WHERE attempt_id IN (SELECT id FROM attempts WHERE stage_id = ?)`).run(lastStage.id);
    db().prepare(`DELETE FROM artifacts WHERE stage_id = ?`).run(lastStage.id);
    db().prepare(`DELETE FROM attempts WHERE stage_id = ?`).run(lastStage.id);
    db().prepare(`DELETE FROM stages WHERE id = ?`).run(lastStage.id);
    db().prepare(`UPDATE runs SET status = 'surfaced' WHERE id = ?`).run(runId);

    const readiness = await getJson(s.base, `/api/v1/runs/${encodeURIComponent(runId)}/completion-readiness`);
    expect(readiness.status).toBe(200);
    expect(readiness.json.resumable).toBe(true);
    expect(readiness.json.surfaced_stages).toEqual([]);

    const eventsPromise = readSse(
      `${s.base}/api/v1/runs/${encodeURIComponent(runId)}/events`,
      "event: run.finalized",
      { "last-event-id": "999999" },
    );

    const resume = await post(s.base, `/api/v1/runs/${encodeURIComponent(runId)}/resume`);
    expect(resume.status).toBe(200);
    expect(resume.json.resumed).toBe(true);
    expect(resume.json.status).toBe("complete");

    const events = await eventsPromise;
    expect(events).toContain("event: run.status");
    expect(events).toContain('"status":"running"');
    expect(events.indexOf("event: run.status")).toBeLessThan(events.indexOf("event: run.finalized"));

    const tree = await getJson(s.base, `/api/v1/runs/${encodeURIComponent(runId)}`);
    expect(tree.json.run.status).toBe("complete");
  });

  it("rejects a concurrent resume with 409 already_active", async () => {
    const project = makeTempProject();
    const s = await makeServer(() => makeEngine({ delayMs: 500 }));
    const started = await post(s.base, "/api/v1/runs", { project_path: project, request_text: "Add a helper.", mode: "single" });
    const runId = started.json.run_id as string;
    expect(await waitForStatus(s.base, runId, 15000)).toBe("complete");

    // Simulate a remaining (unexecuted) planned stage by dropping the last
    // stage's rows entirely, then forcing the run back to 'surfaced' — resume
    // must actually re-dispatch that stage (a real, slow engine call), giving
    // a genuine concurrency window for the second resume call to race into.
    const lastStage = db()
      .prepare(`SELECT id FROM stages WHERE run_id = ? ORDER BY plan_index DESC LIMIT 1`)
      .get(runId) as { id: string };
    db().prepare(`DELETE FROM verdicts WHERE attempt_id IN (SELECT id FROM attempts WHERE stage_id = ?)`).run(lastStage.id);
    db().prepare(`DELETE FROM artifacts WHERE stage_id = ?`).run(lastStage.id);
    db().prepare(`DELETE FROM attempts WHERE stage_id = ?`).run(lastStage.id);
    db().prepare(`DELETE FROM stages WHERE id = ?`).run(lastStage.id);
    db().prepare(`UPDATE runs SET status = 'surfaced' WHERE id = ?`).run(runId);

    // Fire two resume calls back-to-back without awaiting the first — the
    // in-process active-map guard in the supervisor should reject the second
    // while the first is still mid-flight re-dispatching the dropped stage.
    const [first, second] = await Promise.all([
      post(s.base, `/api/v1/runs/${encodeURIComponent(runId)}/resume`),
      post(s.base, `/api/v1/runs/${encodeURIComponent(runId)}/resume`),
    ]);
    const statuses = [first.status, second.status].sort();
    // One succeeds (200, resumed:true) and the other is refused (409).
    expect(statuses).toEqual([200, 409]);
    expect(await waitForStatus(s.base, runId, 15000)).toBe("complete");
  });
});
