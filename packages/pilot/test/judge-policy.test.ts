import { describe, it, expect, afterEach } from "vitest";
import { JudgePolicy } from "../src/judge-policy.js";
import { JudgeUnavailableError } from "../src/errors.js";

const KILL = ["PP_DISABLE_OPENAI", "PP_DISABLE_GOOGLE", "PP_DISABLE_ANTHROPIC", "PP_DISABLE_GEMINI"];
afterEach(() => {
  for (const k of KILL) delete process.env[k];
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
