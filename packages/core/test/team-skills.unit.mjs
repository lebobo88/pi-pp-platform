// Unit test for A1b: TeamStage.skills — explicit per-stage skill injections.
//
// Covers:
//  - stage.skills parses through getTeam (yaml list of ids)
//  - getTeam does NOT resolve skill ids: no console.warn and no hard-fail even
//    for an unresolvable id. Resolution moved off the read path entirely
//    (getSkill writes the SQLite cache — a per-call write on every team_get
//    risked SQLITE_BUSY under a live run); stale ids surface at injection
//    time via the stage loop's run.context {phase:"skills"} skipped list.

import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-team-skills-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
delete process.env.PP_DB_PATH; // isolate from any live dev server DB
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";
process.env.PP_SKIP_CLI_VERSIONS = "1";

// Isolate the user scope so a dev machine's ~/.claude/skills can't shadow the
// fixture resolution (same pattern as skills-loader.unit.mjs).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "pp-team-skills-home-"));
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { getTeam } = await importDist("orchestrator/teams.js");

function makeProject() {
  const project = mkdtempSync(join(tmpdir(), "pp-team-skills-proj-"));
  mkdirSync(join(project, ".claude", "teams"), { recursive: true });
  mkdirSync(join(project, ".claude", "skills"), { recursive: true });
  return project;
}

/** Capture console.warn calls for the duration of fn. */
function withWarnCapture(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = orig;
  }
}

test("stage.skills parses and a resolvable project-scope id does not warn", () => {
  const project = makeProject();
  try {
    writeFileSync(
      join(project, ".claude", "skills", "my-skill.md"),
      "---\nname: my-skill\ndescription: fixture\ninjection: none\n---\n\nBody.\n",
      "utf8",
    );
    writeFileSync(
      join(project, ".claude", "teams", "skilled-team.yaml"),
      `name: skilled-team
description: team with explicit stage skills
stages:
  - kind: spec
    gate_type: spec
    generator: { agent: spec-author }
    judge:     { tier: cross_vendor }
    skills:
      - my-skill
`,
      "utf8",
    );
    const { result, warnings } = withWarnCapture(() => getTeam({ name: "skilled-team", project_path: project }));
    assert.ok(result, "skilled-team resolved");
    assert.deepEqual(result.team.stages[0].skills, ["my-skill"]);
    assert.deepEqual(warnings, [], `no warning expected, got: ${warnings.join(" | ")}`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("an unresolvable skill id neither warns nor fails — validation is off the read path", () => {
  const project = makeProject();
  try {
    writeFileSync(
      join(project, ".claude", "teams", "stale-team.yaml"),
      `name: stale-team
description: references a skill that does not exist
stages:
  - kind: code
    gate_type: code_style
    generator: { agent: engineer }
    judge:     { tier: cross_vendor }
    skills:
      - no-such-skill
`,
      "utf8",
    );
    const { result, warnings } = withWarnCapture(() => getTeam({ name: "stale-team", project_path: project }));
    assert.ok(result, "team loads despite the stale skill reference");
    assert.deepEqual(result.team.stages[0].skills, ["no-such-skill"], "field passes through untouched");
    assert.deepEqual(warnings, [], `no warning on the getTeam read path, got: ${warnings.join(" | ")}`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
