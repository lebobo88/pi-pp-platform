// Unit test for the skill registry (orchestrator/skills.ts).
//
// Covers:
//  - builtin discovery: the 17 ported assets/skills load with parsed frontmatter
//  - frontmatter matrix: csv lists, "*", defaults (injection/priority/max_chars/version)
//  - resolution precedence: project → user → builtin, flat <id>.md AND <id>/SKILL.md
//    accepted at every level
//  - selectSkillsForStage: generator-only filter, applies_to_* matching,
//    explicit ids always included, priority-then-id sort
//  - path-traversal guard on getSkill ids
//  - PP_ASSETS_DIR override for the builtin layer

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-skills-lib-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
delete process.env.PP_DB_PATH; // isolate from any live dev server DB
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";
process.env.PP_SKIP_CLI_VERSIONS = "1";

// Isolate the user scope: the developer machine may have ~/.claude/skills
// installed, which would shadow the built-ins under test. homedir() is read
// per call, but set this BEFORE the dist imports to be safe (same pattern as
// agents-library.unit.mjs).
const FAKE_HOME = mkdtempSync(join(tmpdir(), "pp-skills-home-"));
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let passed = 0;
let failed = 0;
function record(name, fn) {
  return fn().then(
    () => { console.log(`✓ ${name}`); passed++; },
    (err) => { console.error(`✗ ${name}\n  ${err.message}`); failed++; },
  );
}

const { listSkills, getSkill, selectSkillsForStage } = await importDist("orchestrator/skills.js");

const PROJECT = mkdtempSync(join(tmpdir(), "pp-skills-proj-"));
process.on("exit", () => {
  rmSync(PROJECT, { recursive: true, force: true });
  rmSync(FAKE_HOME, { recursive: true, force: true });
});

function skillMd(fm, body = "Body.\n") {
  return `---\n${fm.trim()}\n---\n\n${body}`;
}

await record("builtin discovery: the 17 ported skills load with parsed frontmatter", async () => {
  const skills = listSkills({ project_path: PROJECT });
  assert.equal(skills.length, 17, `expected 17 built-in skills, got ${skills.length}: ${skills.map((s) => s.id).join(", ")}`);
  for (const s of skills) assert.equal(s.origin, "builtin", `${s.id}: expected builtin origin`);

  const byId = new Map(skills.map((s) => [s.id, s]));
  // pp reference skills are injection:none...
  for (const id of ["pair-programmer", "judge-policy", "rubric-application", "master-plan-patching", "profile-aware-gating", "game-design"]) {
    assert.equal(byId.get(id)?.injection, "none", `${id} should be injection:none`);
  }
  // ...except the two author-conventions skills, which inject into generators.
  // Scoped to team-only stages/agents (architecture/contracts) so the DEFAULT
  // single-mode pipeline (spec/code/tests/docs) never picks them up — the
  // conservative-default invariant: a plain run's prompts are skill-free.
  for (const id of ["artifact-conventions", "taxonomy-adherence"]) {
    const s = byId.get(id);
    assert.equal(s?.injection, "generator", `${id} should be injection:generator`);
    assert.deepEqual(s.applies_to_stages, ["architecture", "contracts"], `${id} stages`);
    assert.deepEqual(s.applies_to_agents, ["architect", "api-designer"], `${id} agents`);
  }
  // Executive domain skills inject on "*" stages, scoped to executive agents.
  const fin = byId.get("financial-frameworks");
  assert.equal(fin?.injection, "generator");
  assert.deepEqual(fin.applies_to_stages, ["*"]);
  assert.ok(fin.applies_to_agents.includes("cfo"), "financial-frameworks scoped to cfo");
  assert.equal(fin.priority, 50);
});

await record("getSkill returns the full spec (body, version, max_chars, defaults)", async () => {
  const s = getSkill({ id: "judge-policy", project_path: PROJECT });
  assert.ok(s, "judge-policy resolved");
  assert.equal(s.origin, "builtin");
  assert.equal(s.version, 1);
  assert.equal(s.max_chars, 6000);
  assert.deepEqual(s.applies_to_gate_types, [], "unset csv parses to empty list");
  assert.ok(!s.body.startsWith("---"), "body must be frontmatter-stripped");
  assert.ok(s.body.includes("Borda"), "domain knowledge preserved");
  assert.ok(!s.body.includes("mcp__"), "mcp tool procedure stripped from the ported body");

  assert.equal(getSkill({ id: "does-not-exist", project_path: PROJECT }), null);
});

await record("path traversal ids must not resolve", async () => {
  assert.equal(getSkill({ id: "../teams/feature-team", project_path: PROJECT }), null);
  assert.equal(getSkill({ id: "..", project_path: PROJECT }), null);
  assert.equal(getSkill({ id: "...", project_path: PROJECT }), null, "pure-dot ids never resolve (dir form would escape)");
  assert.equal(getSkill({ id: ".", project_path: PROJECT }), null);
  assert.equal(getSkill({ id: "a/b", project_path: PROJECT }), null);
});

await record("frontmatter matrix: csv lists, numbers, unknown injection → none", async () => {
  const dir = join(PROJECT, ".claude", "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fm-matrix.md"), skillMd(`
name: fm-matrix
description: fixture
version: 3
injection: generator
applies_to_stages: code, tests
applies_to_agents: engineer
applies_to_profiles: web-ui, enterprise
applies_to_gate_types: security
priority: 10
max_chars: 1234
`), "utf8");
  writeFileSync(join(dir, "fm-defaults.md"), skillMd(`
name: fm-defaults
description: fixture with everything defaulted
injection: bogus-value
`), "utf8");
  try {
    const m = getSkill({ id: "fm-matrix", project_path: PROJECT });
    assert.equal(m.origin, "project");
    assert.equal(m.version, 3);
    assert.equal(m.priority, 10);
    assert.equal(m.max_chars, 1234);
    assert.deepEqual(m.applies_to_stages, ["code", "tests"]);
    assert.deepEqual(m.applies_to_agents, ["engineer"]);
    assert.deepEqual(m.applies_to_profiles, ["web-ui", "enterprise"]);
    assert.deepEqual(m.applies_to_gate_types, ["security"]);

    const d = getSkill({ id: "fm-defaults", project_path: PROJECT });
    assert.equal(d.injection, "none", "unknown injection value falls back to none");
    assert.equal(d.version, 1);
    assert.equal(d.priority, 50);
    assert.equal(d.max_chars, 6000);
    assert.deepEqual(d.applies_to_stages, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await record("precedence: project (dir-form) overrides user (flat) overrides builtin", async () => {
  const projectDir = join(PROJECT, ".claude", "skills");
  const userDir = join(FAKE_HOME, ".claude", "skills");
  // Project ships the DIRECTORY form; user ships flat files.
  mkdirSync(join(projectDir, "judge-policy"), { recursive: true });
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(projectDir, "judge-policy", "SKILL.md"), skillMd(`
name: judge-policy
description: project-scope override (dir form)
injection: generator
priority: 5
`, "Project override body.\n"), "utf8");
  writeFileSync(join(userDir, "judge-policy.md"), skillMd(`
name: judge-policy
description: user-scope override
priority: 7
`), "utf8");
  // User-only skill in the DIRECTORY form must be discovered by listSkills too.
  mkdirSync(join(userDir, "zz-user-only"), { recursive: true });
  writeFileSync(join(userDir, "zz-user-only", "SKILL.md"), skillMd(`
name: zz-user-only
description: user-only dir-form skill
`), "utf8");
  try {
    const overridden = getSkill({ id: "judge-policy", project_path: PROJECT });
    assert.equal(overridden.origin, "project", "project dir-form copy wins");
    assert.equal(overridden.priority, 5);
    assert.equal(overridden.body.trim(), "Project override body.");

    const userScope = getSkill({ id: "judge-policy" });   // no project → user wins
    assert.equal(userScope.origin, "user");
    assert.equal(userScope.description, "user-scope override");

    const skills = listSkills({ project_path: PROJECT });
    assert.equal(skills.find((s) => s.id === "judge-policy").origin, "project");
    assert.equal(skills.find((s) => s.id === "zz-user-only").origin, "user");
    assert.equal(skills.find((s) => s.id === "pair-programmer").origin, "builtin");
    assert.equal(skills.length, 18, "16 builtin (one shadowed) + 1 project override + 1 user-only");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".claude"), { recursive: true, force: true });
  }
});

await record("no-shadow rule: a frontmatter-less user copy never demotes a curated builtin", async () => {
  const userDir = join(FAKE_HOME, ".claude", "skills");
  // Plain Claude Code skill (no pp frontmatter) sharing a curated builtin's id —
  // e.g. the dev machine's ~/.claude/skills/financial-frameworks. The builtin's
  // injection metadata must survive.
  mkdirSync(join(userDir, "financial-frameworks"), { recursive: true });
  writeFileSync(join(userDir, "financial-frameworks", "SKILL.md"), skillMd(`
name: financial-frameworks
description: plain claude-code copy without pp keys
`), "utf8");
  try {
    const resolved = getSkill({ id: "financial-frameworks", project_path: PROJECT });
    assert.equal(resolved.origin, "builtin", "builtin wins over the frontmatter-less user copy");
    assert.equal(resolved.injection, "generator", "curated injection metadata preserved");

    const listed = listSkills({ project_path: PROJECT }).find((s) => s.id === "financial-frameworks");
    assert.equal(listed.origin, "builtin");
    assert.equal(listed.injection, "generator");

    // A frontmatter-less copy with NO builtin counterpart still resolves normally.
    writeFileSync(join(userDir, "zz-no-builtin.md"), skillMd(`
name: zz-no-builtin
description: user-only, no pp keys, no builtin twin
`), "utf8");
    const solo = getSkill({ id: "zz-no-builtin", project_path: PROJECT });
    assert.equal(solo.origin, "user");
    assert.equal(solo.injection, "none");
  } finally {
    rmSync(join(FAKE_HOME, ".claude"), { recursive: true, force: true });
  }
});

await record("list/detail agreement: a curated user copy replaces a frontmatter-less project copy in BOTH", async () => {
  // Project ships a plain Claude Code copy (no pp keys); user ships the
  // curated copy. The single resolver must give the same answer to listSkills,
  // getSkill AND selectSkillsForStage: user origin, injection:generator.
  const projectDir = join(PROJECT, ".claude", "skills");
  const userDir = join(FAKE_HOME, ".claude", "skills");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(projectDir, "zz-shared.md"), skillMd(`
name: zz-shared
description: plain project copy without pp keys
`), "utf8");
  writeFileSync(join(userDir, "zz-shared.md"), skillMd(`
name: zz-shared
description: curated user copy
injection: generator
applies_to_stages: code
applies_to_agents: engineer
`), "utf8");
  try {
    const detail = getSkill({ id: "zz-shared", project_path: PROJECT });
    assert.equal(detail.origin, "user", "detail: curated user copy wins over the provisional project copy");
    assert.equal(detail.injection, "generator");

    const listed = listSkills({ project_path: PROJECT }).find((s) => s.id === "zz-shared");
    assert.equal(listed.origin, "user", "list agrees with detail");
    assert.equal(listed.injection, "generator");

    const selected = selectSkillsForStage({ stage_kind: "code", agent: "engineer", project_path: PROJECT });
    assert.ok(selected.some((s) => s.id === "zz-shared"), "selection uses the curated copy's metadata");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(join(FAKE_HOME, ".claude"), { recursive: true, force: true });
  }
});

await record("within one dir the flat <id>.md beats <id>/SKILL.md regardless of readdir order", async () => {
  const projectDir = join(PROJECT, ".claude", "skills");
  // "aa-both" sorts the DIRECTORY entry first in readdir; the flat file must
  // still win (skillPathIn's preference, now honored by listSkills too).
  mkdirSync(join(projectDir, "aa-both"), { recursive: true });
  writeFileSync(join(projectDir, "aa-both", "SKILL.md"), skillMd(`
name: aa-both
description: dir form
injection: generator
priority: 20
`, "DIR BODY.\n"), "utf8");
  writeFileSync(join(projectDir, "aa-both.md"), skillMd(`
name: aa-both
description: flat form
injection: generator
priority: 10
`, "FLAT BODY.\n"), "utf8");
  try {
    const detail = getSkill({ id: "aa-both", project_path: PROJECT });
    assert.equal(detail.priority, 10, "flat copy resolved");
    assert.equal(detail.body.trim(), "FLAT BODY.");
    const listed = listSkills({ project_path: PROJECT }).find((s) => s.id === "aa-both");
    assert.equal(listed.description, "flat form", "list prefers the flat copy too");
    assert.equal(listed.priority, 10);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

await record("selectSkillsForStage: generator filter + applies_to_* matching", async () => {
  // The architect on an architecture stage picks up the two author-conventions
  // skills (they are scoped away from the default single-mode stage kinds).
  const archSkills = selectSkillsForStage({ stage_kind: "architecture", agent: "architect", project_path: PROJECT });
  const archIds = archSkills.map((s) => s.id);
  assert.ok(archIds.includes("artifact-conventions"), `artifact-conventions selected, got ${archIds.join(", ")}`);
  assert.ok(archIds.includes("taxonomy-adherence"), "taxonomy-adherence selected");
  assert.ok(!archIds.includes("pair-programmer"), "injection:none is never auto-selected");
  assert.ok(!archIds.includes("financial-frameworks"), "agent-scoped executive skill excluded");

  // The DEFAULT single-mode stages match no builtin generator skill
  // (conservative-default invariant: plain runs get skill-free prompts).
  for (const [stage_kind, agent] of [["spec", "spec-author"], ["code", "engineer"], ["tests", "test-strategist"], ["docs", "docs-author"]]) {
    assert.deepEqual(
      selectSkillsForStage({ stage_kind, agent, project_path: PROJECT }).map((s) => s.id),
      [],
      `${agent} on ${stage_kind} must select nothing by default`,
    );
  }

  // cfo matches the "*"-staged executive skills on any stage kind.
  const cfoIds = selectSkillsForStage({ stage_kind: "strategy", agent: "cfo", project_path: PROJECT }).map((s) => s.id);
  assert.ok(cfoIds.includes("financial-frameworks"), "financial-frameworks applies to cfo on any stage");
  assert.ok(cfoIds.includes("executive-protocol"), "executive-protocol applies to cfo");
  assert.ok(!cfoIds.includes("taxonomy-adherence"), "stage/agent-scoped author skill excluded for cfo");
});

await record("selectSkillsForStage: explicit ids always included; priority-then-id sort", async () => {
  const dir = join(PROJECT, ".claude", "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "zz-early.md"), skillMd(`
name: zz-early
description: low priority number sorts first
injection: generator
applies_to_stages: code
applies_to_agents: engineer
priority: 10
`), "utf8");
  writeFileSync(join(dir, "aa-late.md"), skillMd(`
name: aa-late
description: high priority number sorts last
injection: generator
applies_to_stages: code
applies_to_agents: engineer
priority: 90
`), "utf8");
  writeFileSync(join(dir, "gate-scoped.md"), skillMd(`
name: gate-scoped
description: only on security gates
injection: generator
applies_to_gate_types: security
priority: 10
`), "utf8");
  try {
    // Explicit inclusion wins even for injection:none reference skills.
    const withExplicit = selectSkillsForStage({
      stage_kind: "code", agent: "engineer", project_path: PROJECT, explicit: ["judge-policy"],
    });
    const ids = withExplicit.map((s) => s.id);
    assert.ok(ids.includes("judge-policy"), "explicit id included despite injection:none");
    assert.deepEqual(ids.filter((id) => id !== "judge-policy"), ["zz-early", "aa-late"],
      "priority asc beats id order (zz-early p10 before aa-late p90)");
    assert.ok(!ids.includes("gate-scoped"), "gate-scoped skill excluded without gate_type");

    // gate_type unlocks the gate-scoped skill; equal priority ties break by id.
    const secIds = selectSkillsForStage({
      stage_kind: "code", agent: "engineer", gate_type: "security", project_path: PROJECT,
    }).map((s) => s.id);
    assert.deepEqual(secIds, ["gate-scoped", "zz-early", "aa-late"],
      "p10 tie breaks by id (gate-scoped < zz-early), then p90");

    // Duplicate explicit + filtered id is deduped.
    const dedup = selectSkillsForStage({
      stage_kind: "code", agent: "engineer", project_path: PROJECT, explicit: ["zz-early"],
    }).map((s) => s.id);
    assert.deepEqual(dedup, ["zz-early", "aa-late"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await record("selectSkillsForStage: applies_to_profiles constrains on profile", async () => {
  const dir = join(PROJECT, ".claude", "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "web-only.md"), skillMd(`
name: web-only
description: web-ui profile only
injection: generator
applies_to_profiles: web-ui
`), "utf8");
  try {
    const noProfile = selectSkillsForStage({ stage_kind: "code", agent: "engineer", project_path: PROJECT });
    assert.ok(!noProfile.some((s) => s.id === "web-only"), "profile-scoped skill excluded without a profile");
    const webUi = selectSkillsForStage({ stage_kind: "code", agent: "engineer", profile: "web-ui", project_path: PROJECT });
    assert.ok(webUi.some((s) => s.id === "web-only"), "profile-scoped skill included for web-ui");
    const other = selectSkillsForStage({ stage_kind: "code", agent: "engineer", profile: "enterprise", project_path: PROJECT });
    assert.ok(!other.some((s) => s.id === "web-only"), "profile-scoped skill excluded for enterprise");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await record("PP_ASSETS_DIR overrides the builtin skills layer", async () => {
  const assets = mkdtempSync(join(tmpdir(), "pp-skills-assets-"));
  mkdirSync(join(assets, "skills"), { recursive: true });
  writeFileSync(join(assets, "skills", "only-here.md"), skillMd(`
name: only-here
description: from the PP_ASSETS_DIR override
`), "utf8");
  process.env.PP_ASSETS_DIR = assets;
  try {
    const skills = listSkills({ project_path: PROJECT });
    assert.deepEqual(skills.map((s) => s.id), ["only-here"], "override replaces the repo builtins");
    assert.equal(skills[0].origin, "builtin");
  } finally {
    delete process.env.PP_ASSETS_DIR;
    rmSync(assets, { recursive: true, force: true });
  }
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
