import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import { ModelCatalog, critique, type LlmComplete } from "../src/index.js";

const catalog = new ModelCatalog(AuthStorage.inMemory());
const judgeModel = catalog.resolveTier("fable");

function msg(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

const VALID_VERDICT = JSON.stringify({
  outcome: "pass",
  critique_md: "Looks good.",
  score_entries: [{ dimension: "correctness", score: 0.9 }],
});

/** A stubbed LlmComplete that returns the canned responses in order. */
function scriptedComplete(responses: string[]): LlmComplete {
  let i = 0;
  return async () => msg(responses[Math.min(i++, responses.length - 1)]!);
}

describe("critique JSON extraction + retry", () => {
  it("returns immediately when the first response is valid", async () => {
    let calls = 0;
    const complete: LlmComplete = async () => {
      calls++;
      return msg(VALID_VERDICT);
    };
    const res = await critique({ judgeModel, rubricMd: "r", artifactText: "a", complete });
    expect(calls).toBe(1);
    expect(res.parsed).toBeDefined();
    expect(res.stop_reason).toBe("stop");
  });

  it("retries once on malformed output, then succeeds", async () => {
    const complete = scriptedComplete(["this is not json at all", VALID_VERDICT]);
    const res = await critique({ judgeModel, rubricMd: "r", artifactText: "a", complete });
    expect(res.parsed).toBeDefined();
    expect((res.parsed as { outcome: string }).outcome).toBe("pass");
  });

  it("extracts JSON embedded in prose / fences", async () => {
    const fenced = "Here is my verdict:\n```json\n" + VALID_VERDICT + "\n```\nThanks!";
    const complete = scriptedComplete([fenced]);
    const res = await critique({ judgeModel, rubricMd: "r", artifactText: "a", complete });
    expect(res.parsed).toBeDefined();
  });

  it("archives and returns invalid_output when both attempts are malformed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pp-critique-fail-"));
    let calls = 0;
    const complete: LlmComplete = async () => {
      calls++;
      return msg("still not json");
    };
    const res = await critique({ judgeModel, rubricMd: "r", artifactText: "a", complete, cwd });
    expect(calls).toBe(2); // 1 + CRITIQUE_RETRY_ATTEMPTS
    expect(res.parsed).toBeUndefined();
    expect(res.stop_reason).toBe("invalid_output");
    expect(res.session_file).toBeTruthy();
    expect(existsSync(res.session_file!)).toBe(true);
  });
});
