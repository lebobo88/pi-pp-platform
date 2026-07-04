import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ProviderStatus, OAuthProvidersResponse } from "@shared/api-types";

// Seed a logged-in vendor-CLI session (openai-codex) under a temp HOME, and
// isolate the DB + platform auth dir, BEFORE buildApp. Then assert the CLI
// login surfaces on the wire as `logged_in` and that OAuth-login routing gates
// correctly — WITHOUT starting a real device-code flow.
const home = mkdtempSync(join(tmpdir(), "pp-srv-cli-login-"));
process.env.PP_PLATFORM_DIR = join(home, "platform");
process.env.PP_SKIP_CLI_VERSIONS = "1";
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.XDG_CONFIG_HOME;
delete process.env.XDG_DATA_HOME;
delete process.env.APPDATA;
delete process.env.LOCALAPPDATA;
delete process.env.PP_ECOSYSTEM;
delete process.env.PP_API_TOKEN;

function seed(...segments: string[]): string {
  const p = join(home, ...segments);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ token: "x" }));
  return p;
}

let app: FastifyInstance;

beforeAll(async () => {
  seed(".codex", "auth.json");
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ dbPath: join(home, "state.db") });
});

afterAll(async () => {
  await app?.close();
});

describe("CLI subscription login on the provider wire", () => {
  it("GET /providers reports logged_in for a CLI-logged-in provider", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/providers" });
    expect(r.statusCode).toBe(200);
    const providers = r.json() as ProviderStatus[];
    const codex = providers.find((p) => p.vendor === "openai-codex");
    expect(codex, "openai-codex should be visible").toBeTruthy();
    expect(codex!.logged_in).toBe(true);
    // Detected login is not a resolvable key.
    expect(codex!.configured).toBe(false);
    expect(codex!.has_api_key).toBe(false);
  });

  it("an API-key-only provider without a CLI session is not logged_in", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/providers" });
    const openai = (r.json() as ProviderStatus[]).find((p) => p.vendor === "openai");
    expect(openai!.logged_in).toBe(false);
  });

  it("GET /providers/oauth lists only pi-OAuth providers (never deepseek)", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/providers/oauth" });
    expect(r.statusCode).toBe(200);
    const body = r.json() as OAuthProvidersResponse;
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers.map((p) => p.id)).not.toContain("deepseek");
  });

  it("POST /providers/:vendor/login 404s for a non-OAuth provider", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/providers/deepseek/login" });
    expect(r.statusCode).toBe(404);
  });

  it("GET /providers/login/:id 404s for an unknown login id", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/providers/login/does-not-exist" });
    expect(r.statusCode).toBe(404);
  });
});
