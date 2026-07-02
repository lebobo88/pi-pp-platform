import { describe, it, expect } from "vitest";
import { listRolePrompts, loadRolePrompt } from "../src/index.js";

/**
 * AG2 parity: every agent prompt in assets/agents-src is loadable through the
 * pilot's role-prompt loader and rendered free of Claude-Code procedure — i.e.
 * ported to in-process platform dispatch.
 */
describe("agent prompt port — all sources load + clean through the pilot loader", () => {
  it("loads all 75 agent prompts without throwing", () => {
    const roles = listRolePrompts();
    expect(roles.length).toBe(75);
    for (const role of roles) {
      expect(() => loadRolePrompt(role)).not.toThrow();
    }
  });

  it("strips Claude-Code tool/procedure fragments from every rendered body", () => {
    for (const role of listRolePrompts()) {
      const p = loadRolePrompt(role);
      // The pilot performs harness bookkeeping itself, so no rendered body may
      // still instruct mcp__pp_* tool calls.
      expect(p.cleanedBody).not.toMatch(/mcp__pp_harness__|mcp__pp_codex__|mcp__pp_gemini__/);
      expect(p.name).toBeTruthy();
      expect(["session-coding", "session-readonly", "completion"]).toContain(p.execution);
    }
  });

  it("derives tiers for the pipeline generator roles", () => {
    for (const role of ["engineer", "spec-author", "architect", "docs-author", "test-strategist"]) {
      const p = loadRolePrompt(role);
      expect(p.tier).toBeDefined();
      expect(["opus", "sonnet", "haiku", "fable"]).toContain(p.tier);
    }
  });
});
