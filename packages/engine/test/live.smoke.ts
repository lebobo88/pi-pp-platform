/**
 * Live smoke — NOT run by default (excluded from vitest `include`; also gated
 * behind PP_LIVE=1). Runs a real 1-token probe + a real critique against any
 * provider whose key is present. Invoke with: `pnpm -F @pp/engine test:live`
 * (requires PP_LIVE=1 and the relevant *_API_KEY).
 */
import { describe, it, expect } from "vitest";
import { createEngine, setProviderKey, type ProbeProvider } from "../src/index.js";

const LIVE = process.env.PP_LIVE === "1";

const PROVIDER_ENV: Record<ProbeProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
};

describe.runIf(LIVE)("live provider probes (PP_LIVE=1)", () => {
  const engine = createEngine({ mode: "pi" });

  for (const provider of Object.keys(PROVIDER_ENV) as ProbeProvider[]) {
    const envKey = process.env[PROVIDER_ENV[provider]];
    it.runIf(!!envKey)(`doctorProbe(${provider}) reaches the model`, async () => {
      // Seed the platform store from the env key for this run.
      setProviderKey(engine.authStorage, provider, envKey!);
      const res = await engine.doctorProbe(provider);
      expect(res.ok).toBe(true);
      expect(res.latency_ms).toBeGreaterThan(0);
    });
  }

  it.runIf(!!process.env.ANTHROPIC_API_KEY)("critique returns a valid verdict", async () => {
    setProviderKey(engine.authStorage, "anthropic", process.env.ANTHROPIC_API_KEY!);
    const model = engine.catalog.resolveTier("haiku");
    const res = await engine.critique({
      judgeModel: model,
      rubricMd: "Score correctness 0..1. Return pass/fail/revise.",
      artifactText: "export const add = (a: number, b: number) => a + b;",
      timeoutMs: 60_000,
    });
    expect(res.parsed).toBeDefined();
  });
});
