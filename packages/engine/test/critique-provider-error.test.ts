/**
 * WS1: critique short-circuits on a provider error instead of burning its
 * JSON-validation retry, and archives the REAL provider cause (not "empty
 * output"). Also asserts the hardening: an explicit maxTokens + timeoutMs reach
 * the completion call (withTimeout previously never armed).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { ModelCatalog, critique, makeErroredAssistant, type LlmComplete, type LlmCallArgs } from "../src/index.js";

const catalog = new ModelCatalog(AuthStorage.inMemory());
const judgeModel = catalog.resolveTier("fable");

const QUOTA_ERR = 'OpenAI API error (429): {"error":{"type":"insufficient_quota"}}';

describe("critique — provider-error short-circuit", () => {
  it("resolves stopReason:error to a provider_error result WITHOUT a validation retry", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pp-critique-pe-"));
    let calls = 0;
    const complete: LlmComplete = async () => {
      calls++;
      return makeErroredAssistant(QUOTA_ERR);
    };
    const res = await critique({ judgeModel, rubricMd: "r", artifactText: "a", complete, cwd });

    // Exactly ONE call — no retry loop on a provider error.
    expect(calls).toBe(1);
    expect(res.parsed).toBeUndefined();
    expect(res.stop_reason).toBe("provider_error");
    expect(res.error_class).toBe("quota_exhausted");
    expect(res.error_message).toContain("insufficient_quota");

    // The failure archive records the real provider cause, not "empty output".
    expect(res.session_file).toBeTruthy();
    expect(existsSync(res.session_file!)).toBe(true);
    const body = readFileSync(res.session_file!, "utf8");
    expect(body).toContain("insufficient_quota");
    expect(body).toContain("quota_exhausted");
    expect(body).not.toContain("empty output");
  });

  it("arms an explicit maxTokens + timeoutMs on the completion call", async () => {
    let seen: LlmCallArgs | undefined;
    const complete: LlmComplete = async (args) => {
      seen = args;
      return makeErroredAssistant(QUOTA_ERR);
    };
    await critique({ judgeModel, rubricMd: "r", artifactText: "a", complete });
    expect(seen?.maxTokens).toBeGreaterThan(0);
    expect(seen?.timeoutMs).toBe(300_000);
  });

  it("honors PP_CRITIQUE_TIMEOUT_MS / PP_CRITIQUE_MAX_TOKENS overrides", async () => {
    process.env.PP_CRITIQUE_TIMEOUT_MS = "12345";
    process.env.PP_CRITIQUE_MAX_TOKENS = "4096";
    try {
      let seen: LlmCallArgs | undefined;
      const complete: LlmComplete = async (args) => {
        seen = args;
        return makeErroredAssistant(QUOTA_ERR);
      };
      await critique({ judgeModel, rubricMd: "r", artifactText: "a", complete });
      expect(seen?.timeoutMs).toBe(12345);
      // Capped by the model's own maxTokens, so assert the requested ceiling holds.
      expect(seen?.maxTokens).toBeGreaterThan(0);
      expect(seen?.maxTokens).toBeLessThanOrEqual(4096);
    } finally {
      delete process.env.PP_CRITIQUE_TIMEOUT_MS;
      delete process.env.PP_CRITIQUE_MAX_TOKENS;
    }
  });
});
