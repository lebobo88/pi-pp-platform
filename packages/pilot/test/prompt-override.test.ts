/**
 * A5 — role-prompt override chain.
 *
 * loadRolePrompt resolves project `.claude/agents/<role>.md` → user
 * `~/.claude/agents/<role>.md` → builtin assets/agents-src, first hit wins,
 * and reports the layer via `origin`. The project layer is what an evolution
 * commit on a `resource:pp.stage-prompt.*` proposal writes.
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

// Isolate the user scope (dev machines have ~/.claude/agents installed via
// AgentSmith, which would shadow the builtins under test) — same pattern as
// skills-injection.test.ts. The vitest config already fakes the home dir for
// all workers; this per-file fake gives the user-layer test a dir it owns.
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

  it("the user layer is consulted after project, before builtin", () => {
    const projectPath = mkdtempSync(join(tmpdir(), "pp-agents-proj-"));
    writeAgent(FAKE_HOME, "docs-author", "USER-OVERRIDE-PROMPT-MARKER");
    const userScoped = loadRolePrompt("docs-author", { projectPath });
    expect(userScoped.origin).toBe("user");
    expect(userScoped.cleanedBody).toContain("USER-OVERRIDE-PROMPT-MARKER");

    // Project beats user when both exist.
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
