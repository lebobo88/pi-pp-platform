/**
 * Prometheus metrics endpoint tests.
 *
 * Verifies:
 *  - GET /metrics → 200 with prom-client exposition content-type
 *  - All five pp_* metric families appear in the body
 *  - Opening and closing an SSE connection moves pp_sse_connections
 *  - Publishing an event moves pp_events_published_total
 *
 * Registry state can bleed between tests in the same module because prom-client
 * uses a module-level singleton by default; here we use a local Registry and
 * assert deltas (before/after) rather than absolute values to stay resilient.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";

// Isolate DB + platform dir.
const home = mkdtempSync(join(tmpdir(), "pp-metrics-home-"));
process.env.PP_PLATFORM_DIR = join(home, "platform");
delete process.env.PP_ECOSYSTEM;
delete process.env.PP_API_TOKEN;

let app: FastifyInstance;
let base: string;
let bus: import("../src/bus.js").BusPort;

beforeAll(async () => {
  const { buildApp } = await import("../src/app.js");
  const { createInMemoryBus } = await import("../src/bus.js");
  bus = createInMemoryBus();
  app = await buildApp({ dbPath: join(home, "state.db"), bus });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app?.close();
});

/** Extract a numeric metric value from Prometheus text exposition. */
function extractMetric(body: string, name: string, labels?: Record<string, string>): number | undefined {
  const lines = body.split("\n").filter((l) => l.startsWith(name) && !l.startsWith("#"));
  if (lines.length === 0) return undefined;
  for (const line of lines) {
    if (!labels) {
      const m = line.match(/\S+(?:\{[^}]*\})?\s+([\d.e+\-]+)/);
      return m ? Number(m[1]) : undefined;
    }
    // Check that all requested labels appear in this line.
    const allMatch = Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`));
    if (allMatch) {
      const m = line.match(/\S+\{[^}]*\}\s+([\d.e+\-]+)/);
      return m ? Number(m[1]) : undefined;
    }
  }
  return undefined;
}

describe("GET /metrics", () => {
  it("returns 200 with prom-client content-type", async () => {
    const r = await app.inject({ method: "GET", url: "/metrics" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/plain");
    expect(r.headers["content-type"]).toContain("version=0.0.4");
  });

  it("body contains all five pp_* metric families", async () => {
    const r = await app.inject({ method: "GET", url: "/metrics" });
    const body = r.body;
    expect(body).toContain("pp_active_runs");
    expect(body).toContain("pp_sse_connections");
    expect(body).toContain("pp_request_duration_seconds");
    expect(body).toContain("pp_events_published_total");
    expect(body).toContain("pp_budget_tripwires_total");
  });

  it("pp_request_duration_seconds records after requests (skips /metrics itself)", async () => {
    // Make a normal request to record duration.
    await app.inject({ method: "GET", url: "/healthz" });

    const r = await app.inject({ method: "GET", url: "/metrics" });
    const body = r.body;
    // The histogram should have _count and _sum lines.
    expect(body).toContain("pp_request_duration_seconds_count");
    expect(body).toContain("pp_request_duration_seconds_sum");
    // A count > 0 means the healthz call was recorded.
    const count = extractMetric(body, "pp_request_duration_seconds_count");
    expect(count).toBeGreaterThan(0);
  });
});

describe("pp_events_published_total counter", () => {
  it("increments when the bus publishes a frame", async () => {
    const before = await app.inject({ method: "GET", url: "/metrics" });
    const countBefore = extractMetric(before.body, "pp_events_published_total") ?? 0;

    // Publish three events directly through the injected bus.
    bus.publish({ type: "test.metric1", data: {} });
    bus.publish({ type: "test.metric2", data: {} });
    bus.publish({ type: "test.metric3", data: {} });

    const after = await app.inject({ method: "GET", url: "/metrics" });
    const countAfter = extractMetric(after.body, "pp_events_published_total") ?? 0;

    expect(countAfter - countBefore).toBe(3);
  });
});

describe("pp_sse_connections gauge", () => {
  /** Read the SSE stream body until `needle` appears or timeout, then abort. */
  async function openSse(url: string, needle: string, ms = 800): Promise<{ close: () => void; found: boolean }> {
    const ac = new AbortController();
    let found = false;
    const closeHandle = () => ac.abort();

    const res = await fetch(url, { signal: ac.signal }).catch(() => null);
    if (!res?.body) return { close: closeHandle, found };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + ms;
    const readLoop = async () => {
      try {
        while (Date.now() < deadline && !found) {
          const { value, done } = await Promise.race([
            reader.read(),
            new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 100)),
          ]);
          if (value) {
            const chunk = decoder.decode(value);
            if (chunk.includes(needle)) found = true;
          }
          if (done) break;
        }
      } catch { /* aborted */ }
    };
    void readLoop();
    return { close: closeHandle, found };
  }

  it("increments on connect and decrements on disconnect", async () => {
    const before = await app.inject({ method: "GET", url: "/metrics" });
    const globalBefore = extractMetric(before.body, "pp_sse_connections", { stream: "global" }) ?? 0;

    // Open a global SSE stream and wait for the ping heartbeat or initial data.
    const { close } = await openSse(`${base}/api/v1/events`, ": ping", 400);

    // Give the server a moment to register the connection.
    await new Promise((r) => setTimeout(r, 150));

    const during = await app.inject({ method: "GET", url: "/metrics" });
    const globalDuring = extractMetric(during.body, "pp_sse_connections", { stream: "global" }) ?? 0;

    // Close the connection.
    close();
    await new Promise((r) => setTimeout(r, 150));

    const after = await app.inject({ method: "GET", url: "/metrics" });
    const globalAfter = extractMetric(after.body, "pp_sse_connections", { stream: "global" }) ?? 0;

    // During connection: gauge should be higher than before.
    expect(globalDuring).toBeGreaterThan(globalBefore);
    // After disconnect: gauge should return to the pre-connect value.
    expect(globalAfter).toBe(globalBefore);
  });
});
