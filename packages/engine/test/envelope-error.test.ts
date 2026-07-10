/**
 * WS1: envelope surfaces provider errors truthfully.
 *  - classifyProviderError buckets pi's error strings (quota / rate / other),
 *  - buildGenResult carries AssistantMessage.errorMessage into error_message +
 *    error_class ONLY when the completion resolved with stopReason:"error",
 *  - a healthy completion sets neither field (optional end-to-end).
 */
import { describe, it, expect } from "vitest";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
  ModelCatalog,
  buildGenResult,
  classifyProviderError,
  makeErroredAssistant,
} from "../src/index.js";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";

const catalog = new ModelCatalog(AuthStorage.inMemory());
const model = catalog.resolveTier("fable");

function okMsg(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("classifyProviderError", () => {
  it("maps quota / billing / budget / usage-limit text → quota_exhausted", () => {
    expect(classifyProviderError('OpenAI API error (429): {"code":"insufficient_quota"}')).toBe("quota_exhausted");
    expect(classifyProviderError("You have exceeded your current billing quota")).toBe("quota_exhausted");
    expect(classifyProviderError("out of budget for this org")).toBe("quota_exhausted");
    expect(classifyProviderError("usage limit reached for this plan")).toBe("quota_exhausted");
  });

  it("maps 429 / rate-limit / too-many-requests (without quota) → rate_limited", () => {
    expect(classifyProviderError("Error 429: too many requests, retry after 30s")).toBe("rate_limited");
    expect(classifyProviderError("rate limit exceeded")).toBe("rate_limited");
  });

  it("falls through to provider_error for anything else / empty", () => {
    expect(classifyProviderError("Internal server error (500)")).toBe("provider_error");
    expect(classifyProviderError(undefined)).toBe("provider_error");
    expect(classifyProviderError("")).toBe("provider_error");
  });
});

describe("buildGenResult — error propagation", () => {
  it("carries errorMessage + classifies when stopReason==='error'", () => {
    const msg = makeErroredAssistant('OpenAI API error (429): {"error":{"code":"insufficient_quota"}}');
    const res = buildGenResult(msg, model, { wall_ms: 1, session_id: null });
    expect(res.stop_reason).toBe("error");
    expect(res.error_message).toContain("insufficient_quota");
    expect(res.error_class).toBe("quota_exhausted");
  });

  it("leaves error fields undefined on a healthy completion", () => {
    const res = buildGenResult(okMsg("all good"), model, { wall_ms: 1, session_id: null });
    expect(res.error_message).toBeUndefined();
    expect(res.error_class).toBeUndefined();
    expect(res.text).toBe("all good");
  });
});
