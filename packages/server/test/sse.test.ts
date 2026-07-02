import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "pp-sse-home-"));
process.env.PP_PLATFORM_DIR = join(home, "platform");
delete process.env.PP_ECOSYSTEM;
delete process.env.PP_API_TOKEN;

let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  const { buildApp } = await import("../src/app.js");
  const { seededBus } = await import("../src/bus.js");
  // Pre-seed the ring buffer with a global frame and a run-scoped frame.
  const bus = seededBus([
    { type: "run.created", data: { id: "run_seed" } },
    { type: "run.status", run_id: "run_seed", data: { run_id: "run_seed", status: "running" } },
  ]);
  app = await buildApp({ dbPath: join(home, "state.db"), bus });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app?.close();
});

/** Read from an SSE response until `needle` appears or the deadline passes. */
async function readUntil(url: string, needle: string, opts: { headers?: Record<string, string>; ms?: number } = {}) {
  const ac = new AbortController();
  const res = await fetch(url, { headers: opts.headers, signal: ac.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + (opts.ms ?? 1500);
  try {
    while (Date.now() < deadline && !buf.includes(needle)) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 250)),
      ]);
      if (chunk.value) buf += decoder.decode(chunk.value);
      if (chunk.done) break;
    }
  } finally {
    ac.abort();
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  return { res, buf };
}

describe("SSE /api/v1/events", () => {
  it("sets stream headers and replays the ring buffer on Last-Event-ID", async () => {
    const { res, buf } = await readUntil(`${base}/api/v1/events`, "event: run.created", {
      headers: { "last-event-id": "0" },
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    expect(buf).toContain("event: run.created");
    expect(buf).toContain("id: 1");
    // The full envelope is carried on the data line.
    expect(buf).toContain('"type":"run.created"');
  });

  it("per-run stream filters frames by run_id", async () => {
    const { buf } = await readUntil(`${base}/api/v1/runs/run_seed/events`, "event: run.status", {
      headers: { "last-event-id": "0" },
    });
    expect(buf).toContain("event: run.status");
    // The global-only frame (no run_id) must NOT appear on the run-scoped stream.
    expect(buf).not.toContain("event: run.created");
  });
});
