/**
 * A1b — pilot skill injection.
 *
 * Covers:
 *  - explicit team-yaml stage `skills` are injected into the generator prompt
 *    (even injection:none reference skills — explicit always wins) and the
 *    run.context {phase:"skills"} event reports injected/skipped ids
 *  - budget enforcement: per-skill max_chars truncation + the total
 *    PP_SKILLS_BUDGET_CHARS budget (priority order, deterministic)
 *  - the conservative-default regression pin: a plain single-mode run's
 *    prompts contain NO "## Applicable skills" section (identical to before
 *    skills existed)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "@pp/engine";
import type { VerdictOutcome } from "@pp/core";
import { RunPilot, EventBus, type PilotEvent } from "../src/index.js";
import { makeTempProject, makeScriptedEngine, makeBestOfEngine } from "./helpers.js";

// Isolate the user skill scope: dev machines have ~/.claude/skills installed
// (AgentSmith), which shadows the builtins and could leak injection:generator
// skills into these runs. homedir() reads USERPROFILE/HOME per call, so
// swapping the env before any run executes is sufficient (same pattern as
// core's skills-loader.unit.mjs).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "pp-pilot-skills-home-"));
const SAVED_ENV = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };

beforeAll(() => {
  process.env.USERPROFILE = FAKE_HOME;
  process.env.HOME = FAKE_HOME;
});

afterAll(() => {
  process.env.USERPROFILE = SAVED_ENV.USERPROFILE;
  process.env.HOME = SAVED_ENV.HOME;
});

afterEach(() => {
  delete process.env.PP_SKILLS_BUDGET_CHARS;
  delete process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE;
});

const REQUEST = "Add a greeting utility function to the project.";

/** Scripted engine that also captures every generator system prompt. */
function makeCapturingEngine(verdictPlan: VerdictOutcome[], prompts: string[]): Engine {
  const base = makeScriptedEngine({ verdictPlan });
  return {
    ...base,
    runAuthoringCompletion: async (o) => {
      prompts.push(o.systemPrompt);
      return base.runAuthoringCompletion(o);
    },
    runCodingSession: async (o) => {
      prompts.push(o.systemPrompt);
      return base.runCodingSession(o);
    },
  };
}

function skillsEvents(events: PilotEvent[]): PilotEvent[] {
  return events.filter((e) => e.type === "run.context" && e.data?.phase === "skills");
}

function writeSkill(projectPath: string, id: string, frontmatter: string, body: string): void {
  const dir = join(projectPath, ".claude", "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), `---\n${frontmatter.trim()}\n---\n\n${body}`, "utf8");
}

describe("Skill injection — explicit team-stage skills", () => {
  it("injects a team yaml stage's skills into the generator prompt (even injection:none)", async () => {
    const projectPath = makeTempProject();
    writeSkill(
      projectPath,
      "team-skill",
      "name: Team Skill\ndescription: explicit injection fixture\ninjection: none",
      "TEAM-SKILL-BODY-MARKER: always prefer the boring solution.\n",
    );
    const teamsDir = join(projectPath, ".claude", "teams");
    mkdirSync(teamsDir, { recursive: true });
    writeFileSync(
      join(teamsDir, "skill-team.yaml"),
      `name: skill-team
description: explicit stage skills fixture
stages:
  - kind: spec
    gate_type: spec
    generator: { agent: spec-author }
    judge:     { tier: cross_vendor }
    skills:
      - team-skill
`,
      "utf8",
    );

    const prompts: string[] = [];
    const engine = makeCapturingEngine(["pass"], prompts);
    const bus = new EventBus();
    const events: PilotEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const pilot = new RunPilot({ projectPath, requestText: REQUEST, mode: "team", team: "skill-team", engine, bus });
    await pilot.execute();

    // The capture includes triage/taxonomy phase completions too — find the
    // stage prompt that carries the skills section.
    const prompt = prompts.find((p) => p.includes("## Applicable skills"));
    expect(prompt).toBeDefined();
    expect(prompt!).toContain("### Skill: Team Skill");
    expect(prompt!).toContain("TEAM-SKILL-BODY-MARKER");
    // The skills block renders after the agent body; when a profile summary is
    // present it must come after that too, and always before prior critiques.
    const profileIdx = prompt!.indexOf("## Active project profile");
    if (profileIdx >= 0) expect(prompt!.indexOf("## Applicable skills")).toBeGreaterThan(profileIdx);

    const skillEvts = skillsEvents(events);
    expect(skillEvts.length).toBeGreaterThanOrEqual(1);
    expect(skillEvts[0]!.data).toMatchObject({
      phase: "skills",
      stage_kind: "spec",
      injected: ["team-skill"],
      skipped: [],
    });
  });
});

describe("Skill injection — budget enforcement", () => {
  it("truncates each skill to max_chars and skips skills past PP_SKILLS_BUDGET_CHARS", async () => {
    const projectPath = makeTempProject();
    // first: priority 10, 300+ char body capped at max_chars=120.
    writeSkill(
      projectPath,
      "first",
      "name: first\ndescription: fixture\ninjection: none\npriority: 10\nmax_chars: 120",
      `FIRST-HEAD ${"x".repeat(300)} FIRST-TAIL\n`,
    );
    // second: priority 20, ~120 char body — does not fit the remaining budget.
    writeSkill(
      projectPath,
      "second",
      "name: second\ndescription: fixture\ninjection: none\npriority: 20",
      `SECOND-BODY-MARKER ${"y".repeat(100)}\n`,
    );
    process.env.PP_SKILLS_BUDGET_CHARS = "150";

    const prompts: string[] = [];
    const engine = makeCapturingEngine(["pass"], prompts);
    const bus = new EventBus();
    const events: PilotEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const pilot = new RunPilot({
      projectPath,
      requestText: REQUEST,
      mode: "single",
      engine,
      bus,
      stagesOverride: [{ kind: "spec", gate_type: "spec", agent: "spec-author", skills: ["first", "second"] }],
    });
    await pilot.execute();

    // Triage/taxonomy phase completions are captured too — find the stage prompt.
    const prompt = prompts.find((p) => p.includes("## Applicable skills"));
    expect(prompt).toBeDefined();
    // first is injected but truncated to its max_chars (120 < tail offset).
    expect(prompt!).toContain("### Skill: first");
    expect(prompt!).toContain("FIRST-HEAD");
    expect(prompt!).not.toContain("FIRST-TAIL");
    // second exceeded the remaining budget (150 - 120 = 30 chars) → skipped.
    for (const p of prompts) {
      expect(p).not.toContain("### Skill: second");
      expect(p).not.toContain("SECOND-BODY-MARKER");
    }

    const skillEvts = skillsEvents(events);
    expect(skillEvts.length).toBeGreaterThanOrEqual(1);
    expect(skillEvts[0]!.data).toMatchObject({
      phase: "skills",
      stage_kind: "spec",
      injected: ["first"],
      skipped: ["second"],
    });
  });
});

describe("Skill injection — best-of candidates", () => {
  it("every candidate prompt carries the stage's skills; the event fires once per stage", async () => {
    process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE = "1";
    const projectPath = makeTempProject();
    writeSkill(
      projectPath,
      "best-of-skill",
      "name: Best Of Skill\ndescription: best-of injection fixture\ninjection: none",
      "BEST-OF-SKILL-BODY-MARKER: keep candidate diffs minimal.\n",
    );

    const prompts: string[] = [];
    const base = makeBestOfEngine();
    const engine: Engine = {
      ...base,
      runCodingSession: async (o) => {
        prompts.push(o.systemPrompt);
        return base.runCodingSession(o);
      },
    };
    const bus = new EventBus();
    const events: PilotEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const pilot = new RunPilot({
      projectPath,
      requestText: REQUEST,
      mode: "best_of",
      n: 3,
      engine,
      bus,
      stagesOverride: [
        { kind: "code", gate_type: "code_style", agent: "engineer", bestOf: 3, skills: ["best-of-skill"] },
      ],
    });
    await pilot.execute();
    // The code stage itself passed (run-level gates may still surface the
    // run, same as the e2e best-of suite — irrelevant to injection).
    expect(
      events.some((e) => e.type === "stage.finalized" && e.data?.status === "passed"),
    ).toBe(true);

    // All 3 candidate coding sessions rendered with the skills block —
    // best-of must not silently drop a promoted stage's skills.
    expect(prompts.length).toBe(3);
    for (const prompt of prompts) {
      expect(prompt).toContain("## Applicable skills");
      expect(prompt).toContain("### Skill: Best Of Skill");
      expect(prompt).toContain("BEST-OF-SKILL-BODY-MARKER");
    }

    // Exactly ONE observability event for the stage, not one per candidate.
    const skillEvts = skillsEvents(events);
    expect(skillEvts.length).toBe(1);
    expect(skillEvts[0]!.data).toMatchObject({
      phase: "skills",
      stage_kind: "code",
      injected: ["best-of-skill"],
      skipped: [],
    });
  });
});

describe("Skill injection — conservative default (regression pin)", () => {
  it("a plain single-mode standard run injects NO skills into any prompt", async () => {
    const projectPath = makeTempProject();
    const prompts: string[] = [];
    const engine = makeCapturingEngine(["pass", "pass", "pass", "pass"], prompts);
    const bus = new EventBus();
    const events: PilotEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const pilot = new RunPilot({ projectPath, requestText: REQUEST, mode: "single", engine, bus });
    const result = await pilot.execute();

    expect(result.status).toBe("complete");
    // At least spec + code + tests + docs (plus triage/taxonomy phase
    // completions) — every captured prompt must be skill-free.
    expect(prompts.length).toBeGreaterThanOrEqual(4);
    for (const prompt of prompts) {
      expect(prompt).not.toContain("## Applicable skills");
      expect(prompt).not.toContain("### Skill:");
    }
    // And no skills observability event fired (nothing selected, nothing skipped).
    expect(skillsEvents(events)).toEqual([]);
  });
});
