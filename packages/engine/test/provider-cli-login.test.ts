import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Isolate the platform auth dir AND point HOME at a temp tree seeded with a
// vendor-CLI credential, BEFORE the engine loads. getProviderStatus should then
// report `loggedIn` for that provider while keeping `configured` false (no key
// is stored in the platform auth.json).
const home = mkdtempSync(join(tmpdir(), "pp-eng-cli-login-"));
process.env.PP_PLATFORM_DIR = join(home, "platform");
process.env.PP_SKIP_CLI_VERSIONS = "1";
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.XDG_CONFIG_HOME;
delete process.env.XDG_DATA_HOME;
delete process.env.APPDATA;
delete process.env.LOCALAPPDATA;

function seed(...segments: string[]): string {
  const p = join(home, ...segments);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ token: "x" }));
  return p;
}

let engine: typeof import("../src/index.js");
let storage: ReturnType<typeof import("../src/index.js").createPlatformAuthStorage>;

beforeAll(async () => {
  seed(".codex", "auth.json"); // a logged-in openai-codex CLI session
  engine = await import("../src/index.js");
  storage = engine.createPlatformAuthStorage();
}, 120_000);

describe("CLI subscription login detection in provider status", () => {
  it("reports loggedIn (but not configured) for a CLI-logged-in provider", () => {
    const s = engine.getProviderStatus(storage, "openai-codex");
    expect(s.loggedIn).toBe(true);
    expect(s.loginSource).toContain("auth.json");
    // A detected CLI session is NOT a resolvable platform credential.
    expect(s.configured).toBe(false);
  });

  it("does not report loggedIn for an API-key-only provider with no CLI session", () => {
    const s = engine.getProviderStatus(storage, "openai");
    expect(s.loggedIn).toBe(false);
  });

  it("providersWithCliLogin surfaces the logged-in provider for visibility", () => {
    expect(engine.providersWithCliLogin()).toContain("openai-codex");
  });

  it("providersWithCredential (generation-gating set) excludes CLI-only logins", () => {
    // The pi-usable set must not include a provider that only has a CLI session
    // pi cannot obtain a token from — that would break generation preflight.
    expect(engine.providersWithCredential(storage)).not.toContain("openai-codex");
  });
});
