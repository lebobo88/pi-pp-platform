/**
 * Prompt cohesion units: upstream-artifact injection, AGENTS.md loading with
 * placeholder stripping, prior-artifact block on retries, and the
 * buildSummary status fix ("completed cleanly" on a surfaced run).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRolePrompt, renderSystemPrompt, loadAgentsMdForPrompt } from "../src/prompts/loader.js";
import { buildSummary } from "../src/phases/finalize.js";
import type { RunContext } from "../src/types.js";

const role = loadRolePrompt("engineer");

describe("renderSystemPrompt — upstream artifacts", () => {
  afterEach(() => delete process.env.PP_UPSTREAM_BUDGET_CHARS);

  it("renders approved upstream artifacts before the role body", () => {
    const out = renderSystemPrompt(role, {
      execution: "session-coding",
      upstreamArtifacts: [{ kind: "spec", text: "FR-CALC-01: the calculator MUST add." }],
    });
    expect(out).toContain("## Approved upstream artifacts (implement THIS)");
    expect(out).toContain("### Approved spec artifact");
    expect(out).toContain("FR-CALC-01");
    expect(out.indexOf("Approved upstream artifacts")).toBeLessThan(out.indexOf(role.cleanedBody.slice(0, 40)));
  });

  it("budgets upstream bodies via PP_UPSTREAM_BUDGET_CHARS", () => {
    process.env.PP_UPSTREAM_BUDGET_CHARS = "50";
    const out = renderSystemPrompt(role, {
      execution: "session-coding",
      upstreamArtifacts: [{ kind: "spec", text: "x".repeat(500) }],
    });
    expect(out).toContain("[truncated]");
    expect(out).not.toContain("x".repeat(100));
  });

  it("renders the prior-artifact block on retries", () => {
    const out = renderSystemPrompt(role, {
      execution: "session-coding",
      priorArtifact: "diff --git a/app.js b/app.js",
      priorCritiques: ["the snake game is missing"],
    });
    expect(out).toContain("## Your previous attempt (rejected — revise, do not restart)");
    expect(out).toContain("diff --git a/app.js");
    expect(out).toContain("## Prior critiques (learn from these)");
  });

  it("renders AGENTS.md conventions when provided", () => {
    const out = renderSystemPrompt(role, {
      execution: "session-coding",
      agentsMd: "## Coding conventions\n\nUse tabs.",
    });
    expect(out).toContain("## Project conventions (AGENTS.md — these beat your priors)");
    expect(out).toContain("Use tabs.");
  });
});

describe("loadAgentsMdForPrompt", () => {
  it("returns null for a fully-placeholder scaffold and for missing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-agentsmd-"));
    try {
      expect(loadAgentsMdForPrompt(dir)).toBeNull();
      writeFileSync(
        join(dir, "AGENTS.md"),
        "# AGENTS.md\n\nContract file.\n\n## Build\n\n_To be populated_\n\n## Coding conventions\n\n_To be populated_\n",
        "utf8",
      );
      expect(loadAgentsMdForPrompt(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps filled sections and drops placeholder ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "pp-agentsmd-"));
    try {
      writeFileSync(
        join(dir, "AGENTS.md"),
        "# AGENTS.md\n\n## Build\n\n_To be populated_\n\n## Coding conventions\n\nEvery privileged action writes an audit-log entry.\n",
        "utf8",
      );
      const out = loadAgentsMdForPrompt(dir);
      expect(out).toContain("Coding conventions");
      expect(out).toContain("audit-log entry");
      expect(out).not.toContain("## Build");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildSummary — status-aware fallbacks", () => {
  const ctxFor = (finalStatus: RunContext["finalStatus"], abortReason?: string) =>
    ({ run_id: "run_test", requestText: "do the thing", finalStatus, abortReason }) as RunContext;

  it("an aborted run with zero stages no longer claims a clean completion", () => {
    const md = buildSummary(ctxFor("aborted", "judge tool failure"), []);
    expect(md).toContain("(no stages passed)");
    expect(md).not.toContain("completed cleanly");
    expect(md).toContain("Run aborted: judge tool failure");
  });

  it("a complete run keeps the clean-completion line", () => {
    const md = buildSummary(ctxFor("complete"), [{ kind: "spec", outcome: "passed" }]);
    expect(md).toContain("- spec: passed");
    expect(md).toContain("completed cleanly");
  });
});
