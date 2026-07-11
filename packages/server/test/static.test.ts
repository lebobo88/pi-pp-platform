import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "pp-static-home-"));
process.env.PP_PLATFORM_DIR = join(home, "platform");
delete process.env.PP_ECOSYSTEM;
delete process.env.PP_API_TOKEN;

let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  // Synthetic ui/dist so the static + SPA behavior is deterministic without the
  // real UI build.
  const dist = mkdtempSync(join(tmpdir(), "pp-uidist-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>pp</title><div id=root>PP_SPA_MARKER</div>");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "assets", "app.js"), "console.log('app')");

  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ dbPath: join(home, "state.db"), uiDistPath: dist });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
});

describe("static UI + SPA fallback", () => {
  it("serves index.html at /", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("PP_SPA_MARKER");
  });

  it("serves static assets", async () => {
    const r = await fetch(`${base}/assets/app.js`);
    expect(r.status).toBe(200);
  });

  it("SPA fallback for a client route (no extension) → index.html, no-store", async () => {
    const r = await fetch(`${base}/projects/some/deep/route`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("PP_SPA_MARKER");
    expect(r.headers.get("cache-control")).toContain("no-store");
  });

  it("API routes coexist; unknown /api path → 404 JSON (not the SPA)", async () => {
    const teams = await fetch(`${base}/api/v1/teams`);
    expect(teams.status).toBe(200);
    const bad = await fetch(`${base}/api/v1/does-not-exist`);
    expect(bad.status).toBe(404);
    expect(bad.headers.get("content-type")).toContain("application/json");
  });
});

describe("legacy /runs/* routes: SPA fallback for browser hard-navigation", () => {
  it("GET /runs with Accept: text/html → 200 text/html SPA shell", async () => {
    const r = await fetch(`${base}/runs`, { headers: { accept: "text/html,application/xhtml+xml,*/*" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("PP_SPA_MARKER");
  });

  it("GET /runs/new with Accept: text/html → 200 text/html SPA shell", async () => {
    const r = await fetch(`${base}/runs/new`, { headers: { accept: "text/html,application/xhtml+xml,*/*" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("PP_SPA_MARKER");
  });

  it("GET /runs/run_someid with Accept: text/html → 200 text/html SPA shell", async () => {
    const r = await fetch(`${base}/runs/run_someid`, { headers: { accept: "text/html,application/xhtml+xml,*/*" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("PP_SPA_MARKER");
  });

  it("GET /runs/run_someid/replay with Accept: text/html → 200 text/html SPA shell", async () => {
    const r = await fetch(`${base}/runs/run_someid/replay`, { headers: { accept: "text/html,application/xhtml+xml,*/*" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("PP_SPA_MARKER");
  });

  it("GET /api/v1/runs (paginated) is unaffected by the legacy Accept guard", async () => {
    const r = await fetch(`${base}/api/v1/runs`, { headers: { accept: "text/html,*/*" } });
    expect(r.status).toBe(200);
    // /api/v1/runs always returns JSON
    expect(r.headers.get("content-type")).toContain("application/json");
  });
});
