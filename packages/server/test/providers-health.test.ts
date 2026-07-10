/**
 * WS2: GET /providers enriches each provider with live health-registry state —
 * health, last_error, last_error_at (ISO), cooldown_until (ISO, rate-limit only),
 * and a last-known balance. All fields are additive/optional: a never-observed
 * provider carries none of them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  recordProviderError,
  recordProviderBalance,
  __resetProviderHealthForTests,
} from "@pp/engine";
import type { ProviderStatus } from "@shared/api-types";

const home = mkdtempSync(join(tmpdir(), "pp-srv-health-"));
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

beforeEach(() => __resetProviderHealthForTests());

async function providers(): Promise<ProviderStatus[]> {
  const r = await app.inject({ method: "GET", url: "/api/v1/providers" });
  expect(r.statusCode).toBe(200);
  return r.json() as ProviderStatus[];
}

describe("GET /providers — health enrichment", () => {
  it("carries a quota hold with last_error + no cooldown timestamp", async () => {
    recordProviderError("openai", "quota_exhausted", "OpenAI API error (429): insufficient_quota");
    const p = (await providers()).find((x) => x.vendor === "openai")!;
    expect(p.health).toBe("quota_exhausted");
    expect(p.last_error).toContain("insufficient_quota");
    expect(typeof p.last_error_at).toBe("string");
    expect(Number.isNaN(Date.parse(p.last_error_at!))).toBe(false);
    // A quota hold is indefinite — no cooldown countdown timestamp.
    expect(p.cooldown_until).toBeUndefined();
  });

  it("carries a rate-limit cooldown as a future ISO timestamp", async () => {
    recordProviderError("google", "rate_limited", "429 rate limit — try again in 60s");
    const p = (await providers()).find((x) => x.vendor === "google")!;
    expect(p.health).toBe("rate_limited");
    expect(typeof p.cooldown_until).toBe("string");
    expect(Date.parse(p.cooldown_until!)).toBeGreaterThan(Date.now());
  });

  it("carries a last-known balance as {amount, currency, as_of ISO}", async () => {
    recordProviderBalance("deepseek", { amount: 42.5, currency: "USD" });
    const p = (await providers()).find((x) => x.vendor === "deepseek")!;
    expect(p.balance).toBeDefined();
    expect(p.balance!.amount).toBe(42.5);
    expect(p.balance!.currency).toBe("USD");
    expect(Number.isNaN(Date.parse(p.balance!.as_of))).toBe(false);
  });

  it("omits health fields for a never-observed provider", async () => {
    const p = (await providers()).find((x) => x.vendor === "mistral")!;
    expect(p.health).toBeUndefined();
    expect(p.last_error).toBeUndefined();
    expect(p.cooldown_until).toBeUndefined();
    expect(p.balance).toBeUndefined();
  });
});
