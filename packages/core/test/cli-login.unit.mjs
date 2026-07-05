// Unit tests for providers/cli-login.ts — best-effort detection of a locally
// logged-in vendor CLI / subscription session.
//
// The detector is pure fs + env: it resolves candidate credential-file paths
// against HOME/USERPROFILE (+ XDG/APPDATA) and reports the first non-empty file.
// We point HOME at a temp dir and neutralize the XDG/APPDATA vars so the probe
// is fully hermetic, then seed files per provider. Runs against compiled dist/.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const HOME = mkdtempSync(join(tmpdir(), "pp-cli-login-"));
process.env.PP_HOME = HOME;
delete process.env.PP_DB_PATH; // isolate from any live dev server DB
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
// Neutralize alternate roots so config/data paths resolve under HOME only.
delete process.env.XDG_CONFIG_HOME;
delete process.env.XDG_DATA_HOME;
delete process.env.APPDATA;
delete process.env.LOCALAPPDATA;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const { detectCliLogin, isCliLoggedIn, CLI_LOGIN_PROVIDERS } = await import(
  pathToFileURL(join(DIST, "providers/cli-login.js")).href
);

/** Write a non-empty credential file at HOME/<segments...>. */
function seed(...segments) {
  const p = join(HOME, ...segments);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ token: "x" }));
  return p;
}

test("no credentials → nothing is logged in", () => {
  for (const id of CLI_LOGIN_PROVIDERS) {
    assert.equal(isCliLoggedIn(id), false, `${id} should not be logged in yet`);
  }
});

test("anthropic (claude CLI) detected via ~/.claude/.credentials.json", () => {
  const p = seed(".claude", ".credentials.json");
  const r = detectCliLogin("anthropic");
  assert.equal(r.loggedIn, true);
  assert.equal(r.source, p);
  // The `claude` producer alias folds onto the same catalog id.
  assert.equal(isCliLoggedIn("claude"), true);
});

test("google (gemini CLI) detected via ~/.gemini/oauth_creds.json", () => {
  seed(".gemini", "oauth_creds.json");
  assert.equal(isCliLoggedIn("google"), true);
  assert.equal(isCliLoggedIn("gemini"), true);
});

test("openai-codex detected via ~/.codex/auth.json (+ codex alias)", () => {
  seed(".codex", "auth.json");
  assert.equal(isCliLoggedIn("openai-codex"), true);
  assert.equal(isCliLoggedIn("codex"), true);
});

test("github-copilot detected via ~/.config/github-copilot/apps.json", () => {
  seed(".config", "github-copilot", "apps.json");
  assert.equal(isCliLoggedIn("github-copilot"), true);
});

test("opencode detected via ~/.local/share/opencode/auth.json", () => {
  seed(".local", "share", "opencode", "auth.json");
  assert.equal(isCliLoggedIn("opencode"), true);
  // opencode-go shares opencode's credential locations.
  assert.equal(isCliLoggedIn("opencode-go"), true);
});

test("empty credential file does not count as logged in", () => {
  const home2 = mkdtempSync(join(tmpdir(), "pp-cli-login-empty-"));
  process.env.HOME = home2;
  process.env.USERPROFILE = home2;
  try {
    const p = join(home2, ".codex", "auth.json");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, ""); // zero bytes
    assert.equal(isCliLoggedIn("openai-codex"), false);
  } finally {
    process.env.HOME = HOME;
    process.env.USERPROFILE = HOME;
  }
});

test("unknown / API-key provider is never CLI-logged-in", () => {
  assert.equal(isCliLoggedIn("openai"), false);
  assert.equal(isCliLoggedIn("deepseek"), false);
  assert.equal(detectCliLogin("totally-unknown").loggedIn, false);
});
