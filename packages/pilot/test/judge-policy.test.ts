import { describe, it, expect, afterEach } from "vitest";
import {
  recordProviderError,
  clearProviderCooldown,
  __resetProviderHealthForTests,
} from "@pp/engine";
import { JudgePolicy } from "../src/judge-policy.js";
import { JudgeUnavailableError } from "../src/errors.js";

const KILL = ["PP_DISABLE_OPENAI", "PP_DISABLE_GOOGLE", "PP_DISABLE_ANTHROPIC", "PP_DISABLE_GEMINI"];
afterEach(() => {
  for (const k of KILL) delete process.env[k];
  // The health registry is process-global — reset it so a cooldown set by one
  // test never leaks into another (availability is an always-on select() filter).
  __resetProviderHealthForTests();
});

const claudeGen = { generatorProducer: "claude", generatorModel: "claude-sonnet-4-6" };

describe("JudgePolicy — cross-vendor enforcement", () => {
  it("spec gate requires cross-vendor: judge is never the generator's vendor", () => {
    const jp = new JudgePolicy();
    const sel = jp.select("run1", { gateType: "spec", ...claudeGen });
    expect(sel.required_cross_vendor).toBe(true);
    expect(sel.provider).not.toBe("anthropic");
    expect(sel.cross_vendor).toBe(true);
    expect(["codex", "gemini"]).toContain(sel.judge_producer);
  });

  it("same-vendor gate (docs_polish) may pick a same-vendor Claude judge with a different model", () => {
    const jp = new JudgePolicy();
    // preferredProvider forces the anthropic same-vendor lane.
    const sel = jp.select("run1", { gateType: "docs_polish", ...claudeGen, preferredProvider: "anthropic" });
    expect(sel.provider).toBe("anthropic");
    expect(sel.judge_producer).toBe("claude");
    expect(sel.judge_model).not.toBe(claudeGen.generatorModel);
  });
});

describe("JudgePolicy — rotation", () => {
  it("rotates the judge provider across consecutive stages of a run", () => {
    const jp = new JudgePolicy();
    const a = jp.select("run1", { gateType: "code_style", ...claudeGen });
    const b = jp.select("run1", { gateType: "code_style", ...claudeGen });
    expect(a.provider).not.toBe(b.provider);
  });
});

describe("JudgePolicy — escalation", () => {
  it("escalates the OpenAI judge to gpt-5.5 on retry", () => {
    const jp = new JudgePolicy();
    const sel = jp.select("run1", { gateType: "code_style", ...claudeGen, retry: true, preferredProvider: "openai" });
    expect(sel.provider).toBe("openai");
    expect(sel.escalated).toBe(true);
    expect(sel.judge_model).toBe("gpt-5.5");
  });

  it("uses the default gpt-5.4 when not retrying", () => {
    const jp = new JudgePolicy();
    const sel = jp.select("run1", { gateType: "code_style", ...claudeGen, preferredProvider: "openai" });
    expect(sel.escalated).toBe(false);
    expect(sel.judge_model).toBe("gpt-5.4");
  });
});

describe("JudgePolicy — rubricIdFor (generator and judge share one rubric)", () => {
  it("returns exactly the rubric id select() later binds on the verdict", () => {
    const jp = new JudgePolicy();
    for (const gateType of ["spec", "design", "security", "contract", "code_style"] as const) {
      const input = { gateType, ...claudeGen, promptKeywords: "add a small feature" };
      // The id the generator is shown must equal the id the verdict records.
      expect(jp.rubricIdFor(input)).toBe(jp.select("run-rubric", input).rubric_id);
    }
  });

  it("has no provider-rotation side effect (safe to call before generation)", () => {
    const jp = new JudgePolicy();
    // A pre-generation rubric resolution must NOT consume a rotation slot.
    jp.rubricIdFor({ gateType: "code_style", ...claudeGen });
    const a = jp.select("run1", { gateType: "code_style", ...claudeGen });
    const b = jp.select("run1", { gateType: "code_style", ...claudeGen });
    expect(a.provider).not.toBe(b.provider);
  });
});

describe("JudgePolicy — failover exclusions + default_model", () => {
  it("excludeProviders drops the errored vendor so re-selection lands elsewhere", () => {
    const jp = new JudgePolicy();
    const first = jp.select("run1", { gateType: "spec", ...claudeGen });
    const next = jp.select("run1", { gateType: "spec", ...claudeGen, excludeProviders: [first.provider] });
    expect(next.provider).not.toBe(first.provider);
  });

  it("exposes the provider's non-escalated default_model (equals judge_model when not escalated)", () => {
    const jp = new JudgePolicy();
    const esc = jp.select("run1", { gateType: "code_style", ...claudeGen, retry: true, preferredProvider: "openai" });
    // Escalated lane: judge_model is the escalated model, default_model the base.
    expect(esc.judge_model).toBe("gpt-5.5");
    expect(esc.default_model).toBe("gpt-5.4");

    const plain = jp.select("run2", { gateType: "code_style", ...claudeGen, preferredProvider: "openai" });
    expect(plain.default_model).toBe(plain.judge_model);
  });

  it("an empty pool after exclusion still throws (never fabricate)", () => {
    const jp = new JudgePolicy();
    // Exclude both non-generator vendors on a cross-vendor spec gate → no judge.
    expect(() =>
      jp.select("run1", { gateType: "spec", ...claudeGen, excludeProviders: ["openai", "google"] }),
    ).toThrow(JudgeUnavailableError);
  });
});

describe("JudgePolicy — health-registry cooldown filter (WS2)", () => {
  it("drops a provider in cooldown so re-selection lands on a live vendor", () => {
    const jp = new JudgePolicy();
    // Force preference toward openai, but record it rate-limited → it must be
    // filtered out and the spec (cross-vendor) gate must pick google instead.
    recordProviderError("openai", "rate_limited", "429 rate limit — try again in 30s");
    const sel = jp.select("run1", { gateType: "spec", ...claudeGen, preferredProvider: "openai" });
    expect(sel.provider).not.toBe("openai");
    expect(sel.provider).toBe("google");
  });

  it("a quota-exhausted provider is held out until the cooldown is cleared", () => {
    const jp = new JudgePolicy();
    recordProviderError("google", "quota_exhausted", "insufficient_quota");
    const held = jp.select("run1", { gateType: "spec", ...claudeGen, preferredProvider: "google" });
    expect(held.provider).not.toBe("google");
    // A successful probe clears the hold → google becomes selectable again.
    clearProviderCooldown("google");
    const cleared = jp.select("run2", { gateType: "spec", ...claudeGen, preferredProvider: "google" });
    expect(cleared.provider).toBe("google");
  });

  it("filtering to empty still throws (never fabricate a verdict)", () => {
    const jp = new JudgePolicy();
    // Both non-generator vendors cooled down on a cross-vendor spec gate → halt.
    recordProviderError("openai", "quota_exhausted", "insufficient_quota");
    recordProviderError("google", "rate_limited", "429 too many requests");
    expect(() => jp.select("run1", { gateType: "spec", ...claudeGen })).toThrow(JudgeUnavailableError);
  });
});

describe("JudgePolicy — kill switches", () => {
  it("PP_DISABLE_GEMINI drops google from the pool", () => {
    process.env.PP_DISABLE_GEMINI = "1";
    const jp = new JudgePolicy();
    // Force the preference toward google; it must fall back to another vendor.
    const sel = jp.select("run1", { gateType: "spec", ...claudeGen, preferredProvider: "google" });
    expect(sel.provider).not.toBe("google");
  });

  it("throws JudgeUnavailableError when every vendor is disabled", () => {
    process.env.PP_DISABLE_OPENAI = "1";
    process.env.PP_DISABLE_GOOGLE = "1";
    process.env.PP_DISABLE_ANTHROPIC = "1";
    const jp = new JudgePolicy();
    expect(() => jp.select("run1", { gateType: "docs_polish", ...claudeGen })).toThrow(JudgeUnavailableError);
  });

  it("throws when cross-vendor is required but only the generator's vendor is left", () => {
    // Disable both non-anthropic vendors → a cross-vendor spec gate for a
    // claude generator has no eligible judge.
    process.env.PP_DISABLE_OPENAI = "1";
    process.env.PP_DISABLE_GOOGLE = "1";
    const jp = new JudgePolicy();
    expect(() => jp.select("run1", { gateType: "spec", ...claudeGen })).toThrow(JudgeUnavailableError);
  });
});
