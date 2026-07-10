/**
 * WS2: the in-memory provider-health registry — cooldown set/clear, the
 * availability filter (kill switch + cooldown), retry-after parsing, and the
 * classifier→registry integration via recordProviderResult.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  recordProviderResult,
  recordProviderError,
  recordProviderSuccess,
  recordProviderBalance,
  clearProviderCooldown,
  getProviderHealth,
  isProviderAvailable,
  parseRetryAfterMs,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  __resetProviderHealthForTests,
} from "../src/index.js";

const T0 = 1_000_000;

afterEach(() => {
  __resetProviderHealthForTests();
  delete process.env.PP_DISABLE_OPENAI;
  delete process.env.PP_DISABLE_DEEPSEEK;
});

describe("parseRetryAfterMs", () => {
  it("parses the common provider phrasings", () => {
    expect(parseRetryAfterMs("Please try again in 30s")).toBe(30_000);
    expect(parseRetryAfterMs("try again in 1.5s")).toBe(1_500);
    expect(parseRetryAfterMs("try again in 2 minutes")).toBe(120_000);
    expect(parseRetryAfterMs("retry-after: 45")).toBe(45_000);
    expect(parseRetryAfterMs("please wait, rate limited in 3 seconds")).toBe(3_000);
  });
  it("returns null when no hint is present", () => {
    expect(parseRetryAfterMs("insufficient_quota")).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
  });
});

describe("provider-health — rate-limit cooldown", () => {
  it("honors a retry-after hint and expires back to ok", () => {
    recordProviderError("openai", "rate_limited", "429 rate limit — try again in 30s", T0);
    expect(isProviderAvailable("openai", T0)).toBe(false);
    expect(isProviderAvailable("openai", T0 + 29_000)).toBe(false);
    // After the 30s window the provider is routable again and health normalizes.
    expect(isProviderAvailable("openai", T0 + 31_000)).toBe(true);
    expect(getProviderHealth("openai", T0 + 31_000).health).toBe("ok");
    expect(getProviderHealth("openai", T0 + 31_000).cooldown_until).toBeUndefined();
  });

  it("falls back to the 10-minute default with no hint", () => {
    recordProviderError("openai", "rate_limited", "429 too many requests", T0);
    const e = getProviderHealth("openai", T0);
    expect(e.health).toBe("rate_limited");
    expect(e.cooldown_until).toBe(T0 + DEFAULT_RATE_LIMIT_COOLDOWN_MS);
    expect(isProviderAvailable("openai", T0 + DEFAULT_RATE_LIMIT_COOLDOWN_MS - 1)).toBe(false);
  });
});

describe("provider-health — quota hold", () => {
  it("holds indefinitely until cleared by a successful probe", () => {
    recordProviderError("openai", "quota_exhausted", "insufficient_quota", T0);
    expect(isProviderAvailable("openai", T0)).toBe(false);
    // No finite cooldown — still unavailable arbitrarily far in the future.
    expect(isProviderAvailable("openai", T0 + 10 * 60 * 60 * 1000)).toBe(false);
    expect(getProviderHealth("openai", T0).cooldown_until).toBeUndefined();
    clearProviderCooldown("openai");
    expect(isProviderAvailable("openai", T0)).toBe(true);
    expect(getProviderHealth("openai", T0).health).toBe("ok");
  });
});

describe("provider-health — recordProviderResult (classifier integration)", () => {
  it("an errored GenResult sets the classified health + cooldown", () => {
    recordProviderResult(
      { provider: "openai", error_class: "quota_exhausted", error_message: "insufficient_quota" },
      T0,
    );
    expect(getProviderHealth("openai", T0).health).toBe("quota_exhausted");
    expect(isProviderAvailable("openai", T0)).toBe(false);
  });

  it("a healthy GenResult clears an existing cooldown", () => {
    recordProviderError("openai", "rate_limited", "429", T0);
    expect(isProviderAvailable("openai", T0)).toBe(false);
    recordProviderResult({ provider: "openai" }, T0);
    expect(isProviderAvailable("openai", T0)).toBe(true);
    expect(getProviderHealth("openai", T0).health).toBe("ok");
  });

  it("is a no-op when the result carries no provider", () => {
    expect(() => recordProviderResult({ error_class: "rate_limited" }, T0)).not.toThrow();
  });
});

describe("provider-health — availability filter composition", () => {
  it("an unobserved provider is available", () => {
    expect(isProviderAvailable("google", T0)).toBe(true);
    expect(getProviderHealth("google", T0).health).toBe("unknown");
  });

  it("the per-provider kill switch overrides everything", () => {
    recordProviderSuccess("openai", T0);
    expect(isProviderAvailable("openai", T0)).toBe(true);
    process.env.PP_DISABLE_OPENAI = "1";
    expect(isProviderAvailable("openai", T0)).toBe(false);
  });
});

describe("provider-health — balance persistence", () => {
  it("keeps the last-known balance across an error record", () => {
    recordProviderBalance("deepseek", { amount: 42.5, currency: "USD" }, T0);
    recordProviderError("deepseek", "rate_limited", "429", T0);
    const e = getProviderHealth("deepseek", T0);
    expect(e.health).toBe("rate_limited");
    expect(e.balance).toEqual({ amount: 42.5, currency: "USD", as_of: T0 });
  });
});
