// Unit test for the deterministic team recommender (team-recommend.ts).
//
// Covers:
//  - table-driven fixtures: request text (+ optional profile/scope) → expected
//    top team(s), suggest_team_mode, and game-team gating
//  - result shape: top-5 cap, stable sort (score desc, name asc), reasons
//  - confidence banding (high needs score>=6 AND margin>=3 over #2)

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-team-recommend-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";
process.env.PP_SKIP_CLI_VERSIONS = "1";

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

const { recommendTeams } = await importDist("orchestrator/team-recommend.js");

// Empty project dir → detectProfile finds nothing → no active profile unless
// the fixture passes one explicitly.
const PROJECT = mkdtempSync(join(tmpdir(), "pp-team-recommend-proj-"));
process.on("exit", () => rmSync(PROJECT, { recursive: true, force: true }));

// ─── Table-driven fixtures ─────────────────────────────────────────────────
// `top` = the expected #1 team; `topOneOf` = any of these at #1;
// `topNotPrefix` = #1 must not start with this prefix.
const FIXTURES = [
  {
    name: "crash fix → bug-fix-team",
    request: "fix the crash in login",
    top: "bug-fix-team",
    scope: "standard",
    suggest: false,
  },
  {
    name: "deprecation → retirement-team (high confidence)",
    request: "deprecate the v1 api",
    top: "retirement-team",
    confidence: "high",
  },
  {
    name: "strategy artifacts → strategy-team or discovery-team",
    request: "draft the product strategy with okrs and a roadmap",
    topOneOf: ["strategy-team", "discovery-team"],
  },
  {
    name: "major checkout feature → feature-team + suggest_team_mode",
    request: "new checkout flow with payment integration",
    scopeOverride: "major",
    top: "feature-team",
    suggest: true,
  },
  {
    name: "game request with web-ui profile must NOT rank a game team top",
    request: "add a boss encounter and enemy npc to the game level",
    profile: "web-ui",
    topNotPrefix: "game-",
  },
  {
    name: "game request with game-dev-unity profile ranks game-feature-team top",
    request: "add a boss encounter and enemy npc to the game level",
    profile: "game-dev-unity",
    top: "game-feature-team",
  },
  {
    name: "security wording → security-review-team (major via security-keyword)",
    request: "review the auth flow for security vulnerabilities",
    top: "security-review-team",
    scope: "major",
    suggest: true,
  },
  {
    name: "docs-only → docs-team (trivial scope, no heavy-pipeline penalty on 3 stages)",
    request: "update the readme documentation",
    top: "docs-team",
    scope: "trivial",
    suggest: false,
  },
  {
    name: "refactor wording → refactor-team",
    request: "refactor the payment module to extract a shared client",
    top: "refactor-team",
  },
  {
    name: "tdd wording → feature-team-tdd over feature-team",
    request: "implement the login parser using tdd with failing tests first",
    top: "feature-team-tdd",
  },
  {
    name: "rollout/rollback → release-team",
    request: "plan the rollout and rollback for the next release",
    top: "release-team",
  },
  {
    name: "slo/alerting → ops-team",
    request: "set up slo dashboards and alerts for the checkout service",
    top: "ops-team",
  },
  {
    name: "erd/lineage → data-team",
    request: "design the erd and data retention schema migration",
    top: "data-team",
  },
  {
    name: "landing page copy → marketing-team",
    request: "write ad copy for the landing page campaign",
    top: "marketing-team",
  },
];

for (const fx of FIXTURES) {
  await record(fx.name, async () => {
    const result = recommendTeams({
      request_text: fx.request,
      project_path: PROJECT,
      profile: fx.profile,
      scope: fx.scopeOverride,
    });
    assert.ok(result.recommendations.length > 0, "expected at least one recommendation");
    assert.ok(result.recommendations.length <= 5, "expected at most five recommendations");
    const top = result.recommendations[0];
    if (fx.top) {
      assert.equal(top.team, fx.top,
        `expected top team ${fx.top}, got ${top.team} (score=${top.score}; reasons=${top.reasons.join("; ")})`);
    }
    if (fx.topOneOf) {
      assert.ok(fx.topOneOf.includes(top.team),
        `expected top team in [${fx.topOneOf.join(", ")}], got ${top.team} (reasons=${top.reasons.join("; ")})`);
    }
    if (fx.topNotPrefix) {
      assert.ok(!top.team.startsWith(fx.topNotPrefix),
        `expected top team not to start with "${fx.topNotPrefix}", got ${top.team}`);
    }
    if (fx.scope) assert.equal(result.scope, fx.scope);
    if (fx.suggest !== undefined) assert.equal(result.suggest_team_mode, fx.suggest);
    if (fx.confidence) {
      assert.equal(top.confidence, fx.confidence,
        `expected top confidence ${fx.confidence}, got ${top.confidence} (score=${top.score})`);
    }
    assert.ok(top.reasons.length > 0, "top recommendation must carry reasons");
  });
}

await record("stable sort: score desc, then name asc", async () => {
  const result = recommendTeams({ request_text: "fix the crash in login", project_path: PROJECT });
  const recs = result.recommendations;
  for (let i = 1; i < recs.length; i++) {
    const prev = recs[i - 1];
    const cur = recs[i];
    assert.ok(
      prev.score > cur.score || (prev.score === cur.score && prev.team.localeCompare(cur.team) < 0),
      `sort violated at index ${i}: ${prev.team}(${prev.score}) before ${cur.team}(${cur.score})`,
    );
  }
});

await record("trivial scope penalizes >=5-stage pipelines", async () => {
  const result = recommendTeams({
    request_text: "fix a typo in the checkout feature banner",
    project_path: PROJECT,
    scope: "trivial",
  });
  assert.equal(result.scope, "trivial");
  assert.equal(result.suggest_team_mode, false);
  // feature-team (7 stages) must carry the trivial-scope penalty reason when ranked.
  const all = result.recommendations;
  const penalized = all.flatMap((r) => r.reasons).some((r) => r.includes("trivial scope penalizes"));
  assert.ok(penalized, "expected at least one trivial-scope pipeline penalty among ranked teams");
});

await record("explicit profile beats detection and boosts compatible teams", async () => {
  const result = recommendTeams({
    request_text: "fix the crash in login",
    project_path: PROJECT,
    profile: "web-ui",
  });
  const bugFix = result.recommendations.find((r) => r.team === "bug-fix-team");
  assert.ok(bugFix, "bug-fix-team ranked");
  assert.ok(bugFix.reasons.some((r) => r === "profile web-ui compatible"),
    `expected "profile web-ui compatible" reason, got: ${bugFix.reasons.join("; ")}`);
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
