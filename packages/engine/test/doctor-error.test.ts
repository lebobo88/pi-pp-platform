/**
 * WS1: doctorProbe must report a provider that resolves with stopReason:"error"
 * (quota/credit exhaustion) as ok:false with the real cause — pi never rejects
 * such a completion, so a naive probe used to call an exhausted provider healthy.
 */
import { describe, it, expect } from "vitest";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { ModelCatalog, doctorProbe, makeErroredAssistant, type LlmComplete } from "../src/index.js";

const authStorage = AuthStorage.inMemory();
const catalog = new ModelCatalog(authStorage);

describe("doctorProbe — resolve-with-error", () => {
  it("reports ok:false with the classified cause when the probe resolves stopReason:error", async () => {
    const complete: LlmComplete = async () =>
      makeErroredAssistant('OpenAI API error (429): {"error":{"code":"insufficient_quota"}}');
    const res = await doctorProbe("openai", { catalog, authStorage, complete });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("quota_exhausted");
    expect(res.error).toContain("insufficient_quota");
  });

  it("reports ok:true when the probe returns a normal completion", async () => {
    const complete: LlmComplete = async () => ({
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
      api: "anthropic-messages",
      provider: "openai",
      model: "test",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const res = await doctorProbe("openai", { catalog, authStorage, complete });
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });
});
