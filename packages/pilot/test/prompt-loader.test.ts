import { describe, it, expect } from "vitest";
import {
  loadRolePrompt,
  parseFrontmatter,
  cleanClaudeCodeProcedure,
  classifyExecution,
  tierForModel,
  renderSystemPrompt,
} from "../src/prompts/loader.js";

describe("parseFrontmatter", () => {
  it("splits frontmatter and body", () => {
    const { frontmatter, body } = parseFrontmatter(
      "---\nname: engineer\nmodel: claude-sonnet-4-6\ntools: Read, Write\n---\nBody text here.\n",
    );
    expect(frontmatter.name).toBe("engineer");
    expect(frontmatter.model).toBe("claude-sonnet-4-6");
    expect(body.trim()).toBe("Body text here.");
  });
});

describe("tierForModel", () => {
  it("reverse-maps pinned model ids to tiers", () => {
    expect(tierForModel("claude-opus-4-7")).toBe("opus");
    expect(tierForModel("claude-sonnet-4-6")).toBe("sonnet");
    expect(tierForModel("claude-fable-5")).toBe("fable");
    expect(tierForModel("unknown")).toBeUndefined();
  });
});

describe("classifyExecution", () => {
  it("classifies coding / readonly / completion roles", () => {
    expect(classifyExecution("engineer")).toBe("session-coding");
    expect(classifyExecution("architect")).toBe("session-readonly");
    expect(classifyExecution("docs-author")).toBe("completion");
    expect(classifyExecution("spec-author")).toBe("completion");
  });
});

describe("cleanClaudeCodeProcedure", () => {
  it("drops mcp tool-call lines and Path B/C sections", () => {
    const body = [
      "Intro line.",
      "Call mcp__pp_harness__record_attempt to record.",
      "Use the Task tool to dispatch.",
      "## Path B / C — DEPRECATED",
      "Dispatch to mcp__pp_codex__generate here.",
      "## Constraints",
      "Keep line.",
    ].join("\n");
    const cleaned = cleanClaudeCodeProcedure(body);
    expect(cleaned).toContain("Intro line.");
    expect(cleaned).toContain("Keep line.");
    expect(cleaned).not.toContain("mcp__pp_harness__");
    expect(cleaned).not.toContain("mcp__pp_codex__");
    expect(cleaned).not.toContain("Task tool");
    expect(cleaned).not.toContain("DEPRECATED");
  });
});

describe("loadRolePrompt", () => {
  it("loads the engineer prompt with frontmatter, tier, and coding execution", () => {
    const role = loadRolePrompt("engineer");
    expect(role.name).toBe("engineer");
    expect(role.model).toBe("claude-sonnet-4-6");
    expect(role.tier).toBe("sonnet");
    expect(role.execution).toBe("session-coding");
    expect(role.tools).toContain("mcp__pp_harness__archive_artifact");
    // Body was cleaned of Claude-Code procedure.
    expect(role.cleanedBody).not.toContain("mcp__pp_harness__");
  });

  it("loads spec-author as an opus completion role", () => {
    const role = loadRolePrompt("spec-author");
    expect(role.tier).toBe("opus");
    expect(role.execution).toBe("completion");
  });

  it("renders a system prompt with injected context blocks", () => {
    const role = loadRolePrompt("engineer");
    const rendered = renderSystemPrompt(role, {
      profileSummary: "name: web-ui",
      priorCritiques: ["fix the null check"],
    });
    expect(rendered).toContain("Active project profile");
    expect(rendered).toContain("Prior critiques");
    expect(rendered).toContain("fix the null check");
  });
});
