// Unit test for the agents library (orchestrator/agents-library.ts) and the
// flat frontmatter util (util/frontmatter.ts).
//
// Covers:
//  - parseFrontmatter: fence parsing, BOM/CRLF tolerance, quote stripping
//  - category coverage: EVERY built-in prompt in assets/agents-src lands in a
//    real bucket (zero fall into "other")
//  - agentTeamIndex correctness for feature-team's stage generators
//  - getAgent detail (frontmatter-stripped body, tier derivation, teams)
//  - precedence: project override → built-in; the user layer (~/.claude/agents)
//    is deliberately IGNORED (role prompts have no discriminating frontmatter,
//    so a Claude Code user agent must never shadow a vetted prompt)

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-agents-lib-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
delete process.env.PP_DB_PATH; // isolate from any live dev server DB
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";
process.env.PP_SKIP_CLI_VERSIONS = "1";

// Isolate the user scope: teams.ts (USER_TEAMS_DIR, bound at import) still
// reads the home dir, and the no-user-layer test below needs a home dir it
// owns, so this must happen BEFORE the dist imports.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "pp-agents-home-"));
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const REPO_ROOT = join(__dirname, "..", "..", "..");
const BUILTIN_AGENTS_DIR = join(REPO_ROOT, "assets", "agents-src");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let passed = 0;
let failed = 0;
function record(name, fn) {
  return fn().then(
    () => { console.log(`✓ ${name}`); passed++; },
    (err) => { console.error(`✗ ${name}\n  ${err.message}`); failed++; },
  );
}

await record("parseFrontmatter handles fences, BOM/CRLF, and quoted values", async () => {
  const { parseFrontmatter } = await importDist("util/frontmatter.js");

  const plain = parseFrontmatter("no frontmatter here\nbody line 2\n");
  assert.deepEqual(plain.frontmatter, {});
  assert.ok(plain.body.startsWith("no frontmatter here"));

  const md = '﻿---\r\nname: ceo\r\ndescription: "Chief Executive Officer — sets vision."\r\nmodel: opus\r\nmaxTurns: 25\r\nskills:\r\n  - executive-protocol\r\n---\r\n\r\n# Chief Executive Officer\r\nBody text.\r\n';
  const { frontmatter, body } = parseFrontmatter(md);
  assert.equal(frontmatter.name, "ceo");
  assert.equal(frontmatter.description, "Chief Executive Officer — sets vision.", "quotes stripped");
  assert.equal(frontmatter.model, "opus");
  assert.equal(frontmatter.maxTurns, "25");
  assert.ok(!body.includes("---"), "body must be frontmatter-stripped");
  assert.ok(body.includes("# Chief Executive Officer"));

  const noClose = parseFrontmatter("---\nname: broken\nno closing fence\n");
  assert.deepEqual(noClose.frontmatter, {}, "unclosed fence → no frontmatter");
});

await record("every built-in prompt categorizes into a real bucket (zero 'other')", async () => {
  const { listAgents, AGENT_CATEGORIES } = await importDist("orchestrator/agents-library.js");
  const project = mkdtempSync(join(tmpdir(), "pp-agents-proj-"));
  try {
    const files = readdirSync(BUILTIN_AGENTS_DIR).filter((f) => f.endsWith(".md"));
    const agents = listAgents({ project_path: project });
    assert.equal(agents.length, files.length,
      `expected one summary per built-in prompt (${files.length}), got ${agents.length}`);
    const others = agents.filter((a) => a.category === "other").map((a) => a.id);
    assert.deepEqual(others, [], `agents fell into "other": ${others.join(", ")}`);
    for (const a of agents) {
      assert.equal(a.origin, "builtin", `${a.id}: expected builtin origin`);
      assert.ok(AGENT_CATEGORIES.includes(a.category), `${a.id}: bad category ${a.category}`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("categorizeAgent spot-checks across the six buckets", async () => {
  const { categorizeAgent } = await importDist("orchestrator/agents-library.js");
  const expect = {
    "engineer": "engineering",
    "api-designer": "engineering",
    "visual-regression-runner": "engineering",
    "judge-cross-vendor": "judge",
    "judge-same-vendor": "judge",
    "oracle-evaluator": "judge",
    "judge-router": "harness",          // explicit map wins over judge- prefix
    "triage": "harness",
    "pair-programmer-orchestrator": "harness",
    "ceo": "executive",
    "caio": "executive",
    "chief-risk-officer": "executive",
    "boardroom": "executive",
    "crisis-warroom": "executive",
    "game-security": "game",
    "economy-designer": "game",
    "netcode-programmer": "game",
    "smith-inspector": "governance",
    "sentinel-watcher": "governance",
    "governance-author": "governance",
    "totally-unknown-role": "other",
  };
  for (const [role, category] of Object.entries(expect)) {
    assert.equal(categorizeAgent(role), category, `categorizeAgent("${role}")`);
  }
});

await record("agentTeamIndex maps feature-team's stage generators", async () => {
  const { agentTeamIndex } = await importDist("orchestrator/agents-library.js");
  const project = mkdtempSync(join(tmpdir(), "pp-agents-proj-"));
  try {
    const index = agentTeamIndex(project);
    const featureAgents = ["spec-author", "architect", "api-designer", "engineer",
      "test-strategist", "browser-validator", "docs-author"];
    for (const agent of featureAgents) {
      assert.ok(index[agent]?.includes("feature-team"),
        `${agent} should be indexed under feature-team, got ${JSON.stringify(index[agent])}`);
    }
    assert.ok(index["engineer"].includes("bug-fix-team"), "engineer also serves bug-fix-team");
    assert.ok(!index["spec-author"].includes("ux-team"), "spec-author is not a ux-team generator");
    assert.ok(index["designer"]?.includes("ux-team"), "designer serves ux-team");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("getAgent returns a frontmatter-stripped body, tier, and teams", async () => {
  const { getAgent } = await importDist("orchestrator/agents-library.js");
  const project = mkdtempSync(join(tmpdir(), "pp-agents-proj-"));
  try {
    const engineer = getAgent({ id: "engineer", project_path: project });
    assert.ok(engineer, "engineer resolved");
    assert.equal(engineer.origin, "builtin");
    assert.equal(engineer.category, "engineering");
    assert.equal(engineer.model, "claude-sonnet-4-6");
    assert.equal(engineer.tier, "sonnet", "pinned model id reverse-maps to tier");
    assert.ok(engineer.teams.includes("feature-team"));
    assert.ok(!engineer.body.startsWith("---"), "body must not carry frontmatter");
    assert.ok(engineer.body.includes("You are the engineer sub-agent"));

    const ceo = getAgent({ id: "ceo", project_path: project });
    assert.ok(ceo, "ceo resolved");
    assert.equal(ceo.tier, "opus", "tier alias in frontmatter passes through");
    assert.ok(!ceo.description.startsWith('"'), "quoted description unwrapped");

    assert.equal(getAgent({ id: "does-not-exist", project_path: project }), null);
    assert.equal(getAgent({ id: "../teams/feature-team", project_path: project }), null,
      "path traversal ids must not resolve");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("resolution precedence: project overrides built-in; the user layer is ignored", async () => {
  const { getAgent, listAgents } = await importDist("orchestrator/agents-library.js");
  const project = mkdtempSync(join(tmpdir(), "pp-agents-proj-"));
  const projectAgentsDir = join(project, ".claude", "agents");
  const userAgentsDir = join(FAKE_HOME, ".claude", "agents");
  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(userAgentsDir, { recursive: true });
  try {
    writeFileSync(join(projectAgentsDir, "engineer.md"),
      "---\nname: engineer-custom\ndescription: project-scope override\nmodel: haiku\n---\n\nOverride body.\n", "utf8");
    // A ~/.claude/agents copy (what AgentSmith installs on real machines)
    // must NEVER shadow a vetted prompt — the user layer does not exist.
    writeFileSync(join(userAgentsDir, "architect.md"),
      "---\nname: architect-user\ndescription: user-scope impostor\n---\n\nUser body.\n", "utf8");
    writeFileSync(join(userAgentsDir, "zz-user-only.md"),
      "---\nname: zz-user-only\ndescription: user-only extra\n---\n\nUser-only body.\n", "utf8");

    const overridden = getAgent({ id: "engineer", project_path: project });
    assert.equal(overridden.origin, "project", "project copy wins");
    assert.equal(overridden.name, "engineer-custom");
    assert.equal(overridden.tier, "haiku");
    assert.equal(overridden.body.trim(), "Override body.");

    const architect = getAgent({ id: "architect", project_path: project });
    assert.equal(architect.origin, "builtin", "user copy never shadows the builtin");
    assert.notEqual(architect.name, "architect-user");
    const architectNoProject = getAgent({ id: "architect" });   // no project → builtin, still not user
    assert.equal(architectNoProject.origin, "builtin");

    const agents = listAgents({ project_path: project });
    assert.equal(agents.find((a) => a.id === "engineer").origin, "project");
    assert.equal(agents.find((a) => a.id === "zz-user-only"), undefined, "user-only agents are not listed");
    assert.equal(agents.find((a) => a.id === "ceo").origin, "builtin");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(userAgentsDir, { recursive: true, force: true });
  }
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
