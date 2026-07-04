/**
 * Platform credential storage.
 *
 * Keys live in `%USERPROFILE%\.pi-pp-platform\auth.json` (override the dir with
 * `PP_PLATFORM_DIR`). We reuse pi-coding-agent's {@link AuthStorage}, which
 * already implements file locking + the runtime/stored/OAuth/env resolution
 * ladder — so per-request auth is a single `getApiKey(provider, { includeFallback })`.
 *
 * Status output NEVER returns full keys — only a masked fingerprint.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { detectCliLogin } from "@pp/core";

/** Resolved platform directory, honoring the PP_PLATFORM_DIR override. */
export function platformDir(): string {
  const override = process.env.PP_PLATFORM_DIR;
  if (override && override.trim()) return override;
  return join(homedir(), ".pi-pp-platform");
}

export function platformAuthPath(): string {
  return join(platformDir(), "auth.json");
}

/** Create (and ensure the directory of) the platform's file-backed AuthStorage. */
export function createPlatformAuthStorage(): AuthStorage {
  const dir = platformDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort; AuthStorage.create also ensures the parent dir */
  }
  return AuthStorage.create(platformAuthPath());
}

/** Persist an API key for a provider. */
export function setProviderKey(storage: AuthStorage, provider: string, apiKey: string): void {
  storage.set(provider, { type: "api_key", key: apiKey });
}

/** Remove a provider's stored credential. */
export function clearProviderKey(storage: AuthStorage, provider: string): void {
  storage.remove(provider);
}

export interface ProviderStatus {
  provider: string;
  configured: boolean;
  /** "stored" | "environment" | ... — pi's AuthStatus source, when known. */
  source?: string;
  label?: string;
  /** Masked fingerprint of a stored api_key credential — never the full key. */
  fingerprint?: string;
  /**
   * A local vendor-CLI / subscription session was detected on disk (e.g. the
   * user ran `claude` / `codex` / `gh copilot` / `opencode` login). This is a
   * PRESENCE signal only — distinct from `configured`, which means pi can
   * actually resolve a usable key. A provider can be logged-in but not yet
   * configured (pi does not read an external CLI's credential files).
   */
  loggedIn: boolean;
  /** Path of the detected CLI credential file, for display/audit; else undefined. */
  loginSource?: string;
}

/**
 * Report whether a provider is configured, with a MASKED fingerprint only.
 * Uses AuthStorage.getAuthStatus (which does not refresh OAuth or expose the
 * key) and derives a fingerprint from the stored api_key when present. Also
 * detects a locally logged-in vendor CLI / subscription session (presence only).
 */
export function getProviderStatus(storage: AuthStorage, provider: string): ProviderStatus {
  const status = storage.getAuthStatus(provider);
  const cred = storage.get(provider);
  let fingerprint: string | undefined;
  if (cred && cred.type === "api_key" && cred.key) {
    fingerprint = maskKey(cred.key);
  }
  const cli = detectCliLogin(provider);
  return {
    provider,
    configured: status.configured,
    source: status.source,
    label: status.label,
    fingerprint,
    loggedIn: cli.loggedIn,
    loginSource: cli.source ?? undefined,
  };
}

/**
 * Resolve the API key to use for a provider request. Follows AuthStorage's
 * ladder: runtime override → stored api_key → OAuth (refreshed) → env var.
 */
export function resolveProviderApiKey(storage: AuthStorage, provider: string): Promise<string | undefined> {
  return storage.getApiKey(provider, { includeFallback: true });
}

/** Redact a secret to a short, non-reversible fingerprint (first 3 + last 4). */
export function maskKey(key: string): string {
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
