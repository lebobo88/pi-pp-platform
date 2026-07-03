import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Isolate the DB + platform auth dir + keep the ecosystem off BEFORE buildApp.
const home = mkdtempSync(join(tmpdir(), "pp-srv-prov-"));
process.env.PP_PLATFORM_DIR = join(home, "platform");
process.env.PP_SKIP_CLI_VERSIONS = "1";
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

describe("dynamic provider catalog", () => {
  it("GET /providers surfaces all 35 enabled catalog providers", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/providers" });
    expect(r.statusCode).toBe(200);
    const providers = r.json() as Array<{ vendor: string; has_api_key: boolean }>;
    expect(providers).toHaveLength(35);
    const vendors = providers.map((p) => p.vendor);
    for (const v of ["openai", "google", "anthropic", "mistral", "openrouter", "deepseek"]) {
      expect(vendors).toContain(v);
    }
  });

  it("POST /providers/:vendor/models/refresh returns the refreshed model ids", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/providers/anthropic/models/refresh" });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { provider: string; refreshed: boolean; models: string[] };
    expect(body.provider).toBe("anthropic");
    expect(body.refreshed).toBe(true);
    expect(body.models).toContain("claude-opus-4-7");
  });

  it("POST refresh for an unknown provider → 404", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/providers/not-a-provider/models/refresh" });
    expect(r.statusCode).toBe(404);
    expect((r.json() as { error: string }).error).toBe("unknown provider");
  });
});
