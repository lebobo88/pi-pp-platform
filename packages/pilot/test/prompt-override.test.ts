/**
 * A5 — role-prompt override chain.
 *
 * loadRolePrompt resolves project `.claude/agents/<role>.md` → builtin
 * assets/agents-src, first hit wins, and reports the layer via `origin`. The
 * project layer is what an evolution commit on a `resource:pp.stage-prompt.*`
 * proposal writes. There is deliberately NO user (~/.claude/agents) layer:
 * role prompts carry no discriminating frontmatter, so a Claude Code user
 * agent sharing a role name (AgentSmith installs engineer.md etc. at user
 * scope) must never silently replace a vetted generator prompt.
 *
 * Also pins the caller wiring: a run's generator prompt is built from the
 * project override when one exists (stage-loop passes ctx.projectPath).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "@pp/engine";
import type { VerdictOutcome } from "@pp/core";
import { RunPilot, EventBus } from "../src/index.js";
import { loadRolePrompt } from "../src/prompts/loader.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

// Fake the home dir so the no-user-layer test below owns a ~/.claude/agents
// it can write impostor files into — same pattern as skills-injection.test.ts.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "pp-pilot-agents-home-"));
const SAVED_ENV = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };

beforeAll(() => {
  process.env.USERPROFILE = FAKE_HOME;
  process.env.HOME = FAKE_HOME;
});

afterAll(() => {
  process.env.USERPROFILE = SAVED_ENV.USERPROFILE;
  process.env.HOME = SAVED_ENV.HOME;
});

function writeAgent(baseDir: string, role: string, marker: string): void {
  const dir = join(baseDir, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${role}.md`),
    `---\nname: ${role}\ndescription: override fixture\nmodel: claude-opus-4-7\n---\n\n${marker}\n`,
    "utf8",
  );
}

describe("loadRolePrompt override chain", () => {
  it("resolves builtin (origin) when no override files exist", () => {
    const projectPath = mkdtempSync(join(tmpdir(), "pp-agents-proj-"));
    const role = loadRolePrompt("spec-author", { projectPath });
    expect(role.origin).toBe("builtin");
    expect(role.tier).toBe("opus");
    // Backward-compat: omitting opts entirely also resolves the builtin.
    expect(loadRolePrompt("spec-author").origin).toBe("builtin");
  });

  it("a project .claude/agents/<role>.md override wins over the builtin", () => {
    const projectPath = mkdtempSync(join(tmpdir(), "pp-agents-proj-"));
    writeAgent(projectPath, "spec-author", "PROJECT-OVERRIDE-PROMPT-MARKER");
    const role = loadRolePrompt("spec-author", { projectPath });
    expect(role.origin).toBe("project");
    expect(role.cleanedBody).toContain("PROJECT-OVERRIDE-PROMPT-MARKER");
    expect(role.model).toBe("claude-opus-4-7");
    // Execution mode still derives from the role name, not the file contents.
    expect(role.execution).toBe("completion");
  });

  it("a ~/.claude/agents copy is IGNORED — no user layer in the chain", () => {
    const projectPath = mkdtempSync(join(tmpdir(), "pp-agents-proj-"));
    // What AgentSmith installs at user scope on real machines: same role name,
    // arbitrary body. It must never replace the vetted builtin prompt.
    writeAgent(FAKE_HOME, "docs-author", "USER-OVERRIDE-PROMPT-MARKER");
    const role = loadRolePrompt("docs-author", { projectPath });
    expect(role.origin).toBe("builtin");
    expect(role.cleanedBody).not.toContain("USER-OVERRIDE-PROMPT-MARKER");

    // A project override still beats the builtin (the user copy stays inert).
    writeAgent(FAKE_HOME, "engineer", "USER-ENGINEER-MARKER");
    writeAgent(projectPath, "engineer", "PROJECT-ENGINEER-MARKER");
    const both = loadRolePrompt("engineer", { projectPath });
    expect(both.origin).toBe("project");
    expect(both.cleanedBody).toContain("PROJECT-ENGINEER-MARKER");
    expect(both.cleanedBody).not.toContain("USER-ENGINEER-MARKER");
  });
});

describe("run wiring — project agent override feeds the generator prompt", () => {
  it("a single-mode stage renders its system prompt from the project override", async () => {
    const projectPath = makeTempProject();
    writeAgent(projectPath, "spec-author", "RUN-LEVEL-OVERRIDE-MARKER: be exhaustive about NFRs.");

    const prompts: string[] = [];
    const base = makeScriptedEngine({ verdictPlan: ["pass"] as VerdictOutcome[] });
    const engine: Engine = {
      ...base,
      runAuthoringCompletion: async (o) => {
        prompts.push(o.systemPrompt);
        return base.runAuthoringCompletion(o);
      },
    };

    const pilot = new RunPilot({
      projectPath,
      requestText: "Write the spec for a tiny greeting module.",
      mode: "single",
      engine,
      bus: new EventBus(),
      stagesOverride: [{ kind: "spec", gate_type: "spec", agent: "spec-author" }],
    });
    await pilot.execute();

    // Triage/taxonomy completions are captured too — the stage prompt is the
    // one carrying the override body.
    const prompt = prompts.find((p) => p.includes("RUN-LEVEL-OVERRIDE-MARKER"));
    expect(prompt).toBeDefined();
  });
});
