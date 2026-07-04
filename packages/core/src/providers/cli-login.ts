/**
 * Best-effort detection of a locally logged-in vendor CLI / subscription account.
 *
 * A user who has already run `claude` / `codex` / `gh copilot` / `gemini` /
 * `opencode` login stores credentials in that CLI's own home directory. pi's
 * AuthStorage does NOT read those files, so such a session otherwise goes
 * unnoticed by the platform. This module detects the *presence* of such a
 * session (a non-empty credential file) — it does NOT validate the token, and a
 * detected login does NOT by itself mean pi can generate with it. Callers must
 * keep "detected login" and "resolvable credential" as distinct signals.
 *
 * Pure fs + env only (no pi import), so it lives in @pp/core and is shared by
 * both the legacy doctor probe (orchestrator/runs.ts) and @pp/engine's
 * getProviderStatus.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

/** Resolved home directory, cross-platform (Windows USERPROFILE, POSIX HOME). */
function home(): string {
  return (process.env.USERPROFILE ?? process.env.HOME ?? "").trim();
}

/** Config roots: $XDG_CONFIG_HOME, ~/.config, %APPDATA% (Windows). */
function configHomes(h: string): string[] {
  const out: string[] = [];
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) out.push(xdg);
  if (h) out.push(join(h, ".config"));
  const appdata = process.env.APPDATA?.trim();
  if (appdata) out.push(appdata);
  return out;
}

/** Data roots: $XDG_DATA_HOME, ~/.local/share, %LOCALAPPDATA% (Windows). */
function dataHomes(h: string): string[] {
  const out: string[] = [];
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) out.push(xdg);
  if (h) out.push(join(h, ".local", "share"));
  const local = process.env.LOCALAPPDATA?.trim();
  if (local) out.push(local);
  return out;
}

export interface CliLoginResult {
  /** A non-empty credential file for a local CLI session was found. */
  loggedIn: boolean;
  /** The path that matched, for display/audit; null when none matched. */
  source: string | null;
}

/**
 * Candidate credential files per provider id, resolved against the current
 * home/XDG env. Keyed by catalog provider id; the vendor "producer" aliases
 * (`codex`, `gemini`, `claude`, `copilot`) fold onto their catalog id.
 * Providers absent from the table simply never report a login.
 */
function candidatesFor(provider: string): string[] {
  const h = home();
  const cfg = configHomes(h);
  const data = dataHomes(h);
  if (!h && cfg.length === 0 && data.length === 0) return [];
  switch (provider) {
    case "anthropic":
    case "claude":
      return [join(h, ".claude", ".credentials.json"), join(h, ".claude", "credentials.json")];
    case "google":
    case "gemini":
      return [join(h, ".gemini", "oauth_creds.json"), join(h, ".gemini", "credentials.json")];
    case "openai-codex":
    case "codex":
      return [join(h, ".codex", "auth.json"), join(h, ".codex", "credentials.json")];
    case "github-copilot":
    case "copilot":
      return [
        ...cfg.map((c) => join(c, "github-copilot", "apps.json")),
        ...cfg.map((c) => join(c, "github-copilot", "hosts.json")),
        ...cfg.map((c) => join(c, "gh", "hosts.yml")),
      ];
    case "opencode":
    case "opencode-go":
      return [
        ...data.map((d) => join(d, "opencode", "auth.json")),
        join(h, ".opencode", "auth.json"),
        ...cfg.map((c) => join(c, "opencode", "auth.json")),
      ];
    default:
      return [];
  }
}

/** True when `p` exists and is a non-empty regular file. */
function nonEmptyFile(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Detect a locally logged-in CLI / subscription session for a provider. Best
 * effort and presence-only: returns the first non-empty credential file found.
 */
export function detectCliLogin(provider: string): CliLoginResult {
  for (const p of candidatesFor(provider)) {
    if (nonEmptyFile(p)) return { loggedIn: true, source: p };
  }
  return { loggedIn: false, source: null };
}

/** Convenience predicate. */
export function isCliLoggedIn(provider: string): boolean {
  return detectCliLogin(provider).loggedIn;
}

/** Provider ids this module knows how to detect a CLI login for. */
export const CLI_LOGIN_PROVIDERS = [
  "anthropic",
  "google",
  "openai-codex",
  "github-copilot",
  "opencode",
  "opencode-go",
] as const;
