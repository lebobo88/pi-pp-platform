/**
 * Provider health registry (WS2) — an in-memory, per-provider record of the
 * LAST observed generation/critique/probe outcome, plus a cooldown that keeps
 * the harness from routing to a provider we already know is rate-limited or out
 * of credit.
 *
 * The registry is updated from the {@link GenResult} error classification the
 * envelope already produces (`error_class` / `error_message`), so no new
 * provider-specific parsing lives here. It is deliberately process-global (not
 * persisted): it reflects live reachability for the current daemon and resets
 * on restart — a stale cooldown must never outlive the process.
 *
 * `isProviderAvailable` is the single predicate the judge-policy and generation
 * pool rotation layer on top of their existing eligibility: it can only SHRINK
 * an already-eligible set (an empty result still halts — cross-vendor judging is
 * never fabricated), and it composes with the per-provider kill switch.
 */
import type { ProviderErrorClass } from "./envelope.js";
import { isProviderDisabled } from "./catalog.js";

/** Live health of a provider, coarsened for display + routing decisions. */
export type ProviderHealth = "ok" | "rate_limited" | "quota_exhausted" | "error" | "unknown";

/** Last-known account balance (currently DeepSeek only). Timestamps are epoch ms. */
export interface ProviderBalanceEntry {
  amount: number;
  currency: string;
  /** Epoch ms the balance was probed. */
  as_of: number;
}

/** One registry entry. All timestamps are epoch ms; the wire mapper renders ISO. */
export interface ProviderHealthEntry {
  provider: string;
  health: ProviderHealth;
  /** Classified last error message (verbatim tail), for a UI tooltip. */
  last_error?: string;
  /** Epoch ms of {@link last_error}. */
  last_error_at?: number;
  /**
   * Epoch ms until which a RATE-LIMIT cooldown holds. Absent for a
   * quota_exhausted hold (which is indefinite until a successful probe) and for
   * a healthy provider.
   */
  cooldown_until?: number;
  /** Last-known balance, populated by a balance probe. */
  balance?: ProviderBalanceEntry;
}

/** Default rate-limit cooldown when the error carries no retry-after hint. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000;

/** Process-global registry. Keyed by catalog provider id (e.g. "openai"). */
const registry = new Map<string, ProviderHealthEntry>();

/**
 * Best-effort parse of a retry-after hint from a provider error string. Handles
 * the common shapes providers emit — an explicit `retry-after` header value, an
 * OpenAI-style "try again in 1.5s", and minute/second phrasings. Returns the
 * delay in ms, or null when no hint is present (caller falls back to the
 * default cooldown).
 */
export function parseRetryAfterMs(text: string | null | undefined): number | null {
  const s = (text ?? "").toLowerCase();
  if (!s) return null;
  // "retry-after: 30" / "retry after 30" (header value, seconds)
  let m = /retry[-\s]?after[:\s]+(\d+(?:\.\d+)?)/.exec(s);
  if (m) return Math.round(Number(m[1]) * 1000);
  // "try again in 1m30s" / "try again in 90s" / "try again in 2 minutes"
  m = /try again in\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?)?/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2] ?? "s";
    if (unit === "ms") return Math.round(n);
    if (unit.startsWith("m") && unit !== "ms") return Math.round(n * 60_000);
    return Math.round(n * 1000);
  }
  // generic "in 45 seconds" / "in 3 minutes"
  m = /\bin\s+(\d+(?:\.\d+)?)\s*(seconds?|minutes?)\b/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return (m[2] ?? "").startsWith("min") ? Math.round(n * 60_000) : Math.round(n * 1000);
  }
  return null;
}

/**
 * Record a provider ERROR against the registry from an engine result's
 * classification. `rate_limited` sets a bounded cooldown (retry-after hint when
 * present, else {@link DEFAULT_RATE_LIMIT_COOLDOWN_MS}); `quota_exhausted` sets
 * an indefinite hold (cleared only by a successful probe/result); other errors
 * mark the provider `error` without a cooldown (a transient blip retries in
 * place). `now` is injectable for deterministic tests.
 */
export function recordProviderError(
  provider: string,
  errorClass: ProviderErrorClass,
  errorMessage?: string,
  now: number = Date.now(),
): void {
  const prev = registry.get(provider);
  // The classifier's generic bucket is "provider_error"; the health vocabulary
  // coarsens that to "error" (rate_limited / quota_exhausted map 1:1).
  const health: ProviderHealth = errorClass === "provider_error" ? "error" : errorClass;
  const entry: ProviderHealthEntry = {
    provider,
    health,
    last_error: errorMessage,
    last_error_at: now,
    ...(prev?.balance ? { balance: prev.balance } : {}),
  };
  if (errorClass === "rate_limited") {
    entry.cooldown_until = now + (parseRetryAfterMs(errorMessage) ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS);
  }
  // quota_exhausted: no finite cooldown_until — held until a success clears it.
  registry.set(provider, entry);
}

/**
 * Record a provider SUCCESS (a healthy generation/critique/probe). Clears any
 * cooldown and marks the provider ok, preserving the last-known balance.
 */
export function recordProviderSuccess(provider: string, _now: number = Date.now()): void {
  const prev = registry.get(provider);
  registry.set(provider, {
    provider,
    health: "ok",
    // last_error / cooldown_until are intentionally dropped once recovered.
    ...(prev?.balance ? { balance: prev.balance } : {}),
  });
}

/**
 * Update the registry from an engine result. A result with an `error_class` is
 * an error; anything else is a success. This is the single call the engine
 * factory wraps around every completion/critique/coding-session result.
 */
export function recordProviderResult(
  result: { provider?: string; error_class?: ProviderErrorClass | string; error_message?: string },
  now: number = Date.now(),
): void {
  const provider = result.provider;
  if (!provider) return;
  if (result.error_class) {
    recordProviderError(provider, result.error_class as ProviderErrorClass, result.error_message, now);
  } else {
    recordProviderSuccess(provider, now);
  }
}

/** Record a freshly probed balance for a provider (does not alter health). */
export function recordProviderBalance(
  provider: string,
  balance: { amount: number; currency: string; as_of?: number },
  now: number = Date.now(),
): void {
  const prev = registry.get(provider) ?? { provider, health: "unknown" as ProviderHealth };
  registry.set(provider, {
    ...prev,
    balance: { amount: balance.amount, currency: balance.currency, as_of: balance.as_of ?? now },
  });
}

/**
 * Clear a provider's cooldown (a successful manual probe). Resets health to ok
 * and drops the last-error/cooldown, preserving any known balance. A no-op when
 * the provider was never recorded.
 */
export function clearProviderCooldown(provider: string, now: number = Date.now()): void {
  recordProviderSuccess(provider, now);
}

/**
 * The current health view for a provider, normalizing an EXPIRED rate-limit
 * cooldown back to `ok` (the bounded window has passed, so the provider is
 * routable again). A quota hold and an unexpired rate-limit cooldown are
 * returned as-is. Providers never observed report `unknown`.
 */
export function getProviderHealth(provider: string, now: number = Date.now()): ProviderHealthEntry {
  const e = registry.get(provider);
  if (!e) return { provider, health: "unknown" };
  if (e.health === "rate_limited" && e.cooldown_until != null && now >= e.cooldown_until) {
    // Cooldown elapsed → recovered. Retain last_error for context but drop the
    // stale cooldown_until so no countdown renders.
    return {
      provider: e.provider,
      health: "ok",
      ...(e.last_error ? { last_error: e.last_error } : {}),
      ...(e.last_error_at != null ? { last_error_at: e.last_error_at } : {}),
      ...(e.balance ? { balance: e.balance } : {}),
    };
  }
  return { ...e };
}

/** Snapshot of every provider the registry has observed (for diagnostics). */
export function allProviderHealth(now: number = Date.now()): ProviderHealthEntry[] {
  return [...registry.keys()].map((p) => getProviderHealth(p, now));
}

/**
 * Whether a provider may be routed to right now: NOT disabled via its
 * per-provider kill switch (PP_DISABLE_<P>) AND NOT in an active cooldown
 * (a quota hold, or an unexpired rate-limit window). Providers never observed
 * — or recovered — are available. This predicate only ever SHRINKS an
 * already-eligible pool; callers still halt on an empty result.
 */
export function isProviderAvailable(provider: string, now: number = Date.now()): boolean {
  if (isProviderDisabled(provider)) return false;
  const e = registry.get(provider);
  if (!e) return true;
  if (e.health === "quota_exhausted") return false;
  if (e.cooldown_until != null && now < e.cooldown_until) return false;
  return true;
}

/** Reset the registry. Test-only helper (never used in the production paths). */
export function __resetProviderHealthForTests(): void {
  registry.clear();
}
