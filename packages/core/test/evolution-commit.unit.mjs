// Unit test for A5 — local evolution commit/rollback (orchestrator/evolution-commit.ts)
// plus the missability project-override file it can write.
//
// Covers:
//  - status gate: commit refused on pending (typed ProposalStatusError)
//  - CommitContentRequiredError when commit lacks content (server maps to 422)
//  - full rubric cycle: approve → commit writes <project>/.claude/rubrics/<id>.md,
//    loadRubric resolves the project override, rollback deletes the created file
//  - snapshot/restore: a pre-existing target is snapshotted and restored on rollback
//  - path guard: rids that resolve outside .claude/ + .harness/ are rejected
//  - stage-prompt role resolution: most recent attempts.agent_type wins,
//    static map fallback otherwise
//  - missability overrides: disabled → skipped, pattern_override replaces the
//    check regex, malformed file → warn + ignore

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-evo-commit-"));
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
    (err) => { console.error(`✗ ${name}\n  ${err.stack ?? err.message}`); failed++; },
  );
}

const evo = await importDist("orchestrator/evolution-commit.js");
const runs = await importDist("orchestrator/runs.js");
const { db } = await importDist("db/database.js");
const { loadRubric } = await importDist("rubrics/loader.js");
const miss = await importDist("orchestrator/missability.js");

function setupProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-evo-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
  return dir;
}

async function withProject(project, fn) {
  try {
    return await fn();
  } finally {
    try { rmSync(project, { recursive: true, force: true }); } catch {}
  }
}

async function makeRun(project) {
  return runs.ensureRun({ request_text: "evolution commit fixture", project_path: project, mode: "single" });
}

let seq = 0;
function insertProposal(run_id, resource_rid, status = "pending") {
  const id = `prop_evotest_${++seq}`;
  db().prepare(
    `INSERT INTO evolution_proposals
       (id, run_id, resource_rid, proposed_change, justification, signal_count, risk_class, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, run_id, resource_rid, "{}", "test fixture", 3, "medium", status, new Date().toISOString());
  return id;
}

function proposalStatus(id) {
  return db().prepare(`SELECT status FROM evolution_proposals WHERE id = ?`).get(id)?.status;
}

await record("commit refused on a pending proposal (ProposalStatusError); unknown id → ProposalNotFoundError", async () => {
  const project = setupProject();
  await withProject(project, async () => {
    const run = await makeRun(project);
    const id = insertProposal(run.run_id, "resource:pp.rubric.some-rubric", "pending");
    assert.throws(() => evo.commitProposal({ id, content: "x" }), evo.ProposalStatusError);
    assert.equal(proposalStatus(id), "pending", "refused commit must not mutate status");
    assert.throws(() => evo.commitProposal({ id: "prop_nope", content: "x" }), evo.ProposalNotFoundError);
    // rollback on a non-committed proposal is refused too.
    assert.throws(() => evo.rollbackProposal({ id }), evo.ProposalStatusError);
  });
});

await record("commit without content → CommitContentRequiredError (422 path)", async () => {
  const project = setupProject();
  await withProject(project, async () => {
    const run = await makeRun(project);
    const id = insertProposal(run.run_id, "resource:pp.rubric.no-content", "approved");
    assert.throws(() => evo.commitProposal({ id }), evo.CommitContentRequiredError);
    assert.throws(() => evo.commitProposal({ id, content: "" }), evo.CommitContentRequiredError);
    assert.equal(proposalStatus(id), "approved");
  });
});

await record("full rubric cycle: commit → loadRubric project override → rollback deletes the created file", async () => {
  const project = setupProject();
  await withProject(project, async () => {
    const run = await makeRun(project);
    const id = insertProposal(run.run_id, "resource:pp.rubric.custom-team-style", "approved");

    const res = evo.commitProposal({ id, content: "# Custom rubric\n\nRUBRIC-BODY-MARKER\n", note: "reviewer note" });
    assert.equal(res.status, "committed");
    assert.equal(res.kind, "rubric");
    const target = join(project, ".claude", "rubrics", "custom-team-style.md");
    assert.equal(res.target_path, target);
    assert.ok(existsSync(target), "override file written");
    assert.equal(res.sha_before, null, "no pre-existing target");
    assert.equal(res.snapshot_path, null, "nothing to snapshot");
    assert.equal(proposalStatus(id), "committed");

    // audit row exists
    const row = db().prepare(`SELECT * FROM evolution_commits WHERE proposal_id = ?`).get(id);
    assert.ok(row, "evolution_commits row inserted");
    assert.equal(row.note, "reviewer note");
    assert.equal(row.rolled_back_at, null);
    assert.ok(row.sha_after, "sha_after recorded");

    // loadRubric resolves the project override (id not in the registry).
    const rubric = loadRubric("custom-team-style", project);
    assert.ok(rubric, "project override rubric resolves");
    assert.equal(rubric.source, "project-override");
    assert.ok(rubric.markdown.includes("RUBRIC-BODY-MARKER"));

    // Double-commit refused (status is now committed, not approved).
    assert.throws(() => evo.commitProposal({ id, content: "again" }), evo.ProposalStatusError);

    // Rollback: sha_before is null → the created file is deleted.
    const rb = evo.rollbackProposal({ id });
    assert.equal(rb.status, "rolled_back");
    assert.equal(rb.restored, false);
    assert.ok(!existsSync(target), "created override deleted on rollback");
    assert.equal(loadRubric("custom-team-style", project), null, "override no longer resolves");
    assert.equal(proposalStatus(id), "rolled_back");

    // Double-rollback refused.
    assert.throws(() => evo.rollbackProposal({ id }), evo.ProposalStatusError);
  });
});

await record("commit snapshots a pre-existing target and rollback restores it", async () => {
  const project = setupProject();
  await withProject(project, async () => {
    const run = await makeRun(project);
    const target = join(project, ".claude", "rubrics", "pre-existing.md");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "ORIGINAL-CONTENT\n", "utf8");

    const id = insertProposal(run.run_id, "resource:pp.rubric.pre-existing", "approved");
    const res = evo.commitProposal({ id, content: "NEW-CONTENT\n" });
    assert.equal(readFileSync(target, "utf8"), "NEW-CONTENT\n");
    assert.ok(res.sha_before, "sha_before recorded for the pre-existing file");
    assert.ok(res.snapshot_path, "snapshot path recorded");
    assert.ok(res.snapshot_path.includes(join(".harness", "evolution", id, "before")));
    assert.equal(readFileSync(res.snapshot_path, "utf8"), "ORIGINAL-CONTENT\n");

    const rb = evo.rollbackProposal({ id });
    assert.equal(rb.restored, true);
    assert.equal(readFileSync(target, "utf8"), "ORIGINAL-CONTENT\n", "snapshot restored");
  });
});

await record("path guard: rid escaping .claude/.harness and unknown rid kinds are rejected", async () => {
  const project = setupProject();
  await withProject(project, async () => {
    const run = await makeRun(project);
    // "../../evil" as the rubric bare-id resolves to <project>/evil.md → outside .claude/.
    const escId = insertProposal(run.run_id, "resource:pp.rubric.../../evil", "approved");
    assert.throws(() => evo.commitProposal({ id: escId, content: "pwn" }), evo.EvolutionTargetError);
    assert.ok(!existsSync(join(project, "evil.md")), "no file escapes the override roots");
    assert.equal(proposalStatus(escId), "approved", "failed commit must not mutate status");

    // Unrecognized rid kind is a typed target error too.
    const badId = insertProposal(run.run_id, "resource:pp.teams.feature-team", "approved");
    assert.throws(() => evo.commitProposal({ id: badId, content: "x" }), evo.EvolutionTargetError);
  });
});

await record("stage-prompt target: most recent attempts.agent_type wins; static map is the fallback", async () => {
  const project = setupProject();
  await withProject(project, async () => {
    const run = await makeRun(project);
    const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    runs.recordAttempt({
      stage_id: stage.stage_id,
      producer: "claude",
      model_id: "claude-sonnet-4-6",
      status: "ok",
      agent_type: "custom-coder",
    });

    // agent_type provenance wins for the 'code' stage kind.
    const fromAttempts = evo.resolveProposalTarget("resource:pp.stage-prompt.code", project);
    assert.equal(fromAttempts.kind, "stage-prompt");
    assert.equal(fromAttempts.target_path, join(project, ".claude", "agents", "custom-coder.md"));

    // No attempts for 'docs' in this project → static fallback map.
    const fallback = evo.resolveProposalTarget("resource:pp.stage-prompt.docs", project);
    assert.equal(fallback.target_path, join(project, ".claude", "agents", "docs-author.md"));

    // End-to-end: commit writes the agent override file.
    const id = insertProposal(run.run_id, "resource:pp.stage-prompt.code", "approved");
    const res = evo.commitProposal({ id, content: "---\nname: custom-coder\n---\n\nOVERRIDE PROMPT BODY\n" });
    assert.ok(existsSync(res.target_path));
    assert.ok(readFileSync(res.target_path, "utf8").includes("OVERRIDE PROMPT BODY"));
  });
});

await record("missability target + overrides: disabled → skipped, pattern_override replaces the regex", async () => {
  const project = setupProject();
  await withProject(project, async () => {
    const run = await makeRun(project);
    const stage = await runs.startStage({ run_id: run.run_id, kind: "spec", gate_type: "spec" });
    await runs.archiveArtifact({
      run_id: run.run_id,
      stage_id: stage.stage_id,
      kind: "spec",
      relative_path: "spec/notes.md",
      bytes: "Nothing standard here, but MAGIC-TOKEN-42 is present.\n",
    });

    // The missability rid resolves to the shared overrides JSON.
    const t = evo.resolveProposalTarget("resource:pp.missability.nfrs-declared", project);
    assert.equal(t.kind, "missability");
    assert.equal(t.target_path, join(project, ".harness", "missability-overrides.json"));

    // Commit the overrides file through the evolution flow.
    const id = insertProposal(run.run_id, "resource:pp.missability.nfrs-declared", "approved");
    evo.commitProposal({
      id,
      content: JSON.stringify({
        "nfrs-declared": { disabled: true },
        "doc-ownership": { pattern_override: "MAGIC-TOKEN-\\d+" },
      }, null, 2),
    });

    const result = miss.runMissabilityChecks({
      run_id: run.run_id,
      required_check_ids: ["nfrs-declared", "doc-ownership"],
    });
    const nfr = result.results.find((r) => r.check_id === "nfrs-declared");
    assert.equal(nfr.status, "skipped", `nfrs-declared should be skipped; got ${nfr.status}`);
    assert.ok(nfr.evidence.includes("disabled by project override"), nfr.evidence);
    assert.ok(nfr.evidence.includes("missability-overrides.json"), "evidence names the override file");

    const doc = result.results.find((r) => r.check_id === "doc-ownership");
    assert.equal(doc.status, "pass", `pattern_override should match MAGIC-TOKEN-42; got ${doc.status} (${doc.evidence})`);
    assert.ok(doc.evidence.includes("pattern_override via"), doc.evidence);
    assert.ok(result.skipped_count >= 1, "skipped_count reported");

    // Rollback deletes the overrides file (no pre-existing target) → defaults return.
    evo.rollbackProposal({ id });
    const after = miss.runMissabilityChecks({
      run_id: run.run_id,
      required_check_ids: ["nfrs-declared", "doc-ownership"],
    });
    assert.equal(after.results.find((r) => r.check_id === "nfrs-declared").status, "fail", "default heuristic back in force");
    assert.equal(after.results.find((r) => r.check_id === "doc-ownership").status, "fail");
  });
});

await record("malformed overrides file / malformed regex: warn + ignore, defaults apply", async () => {
  const project = setupProject();
  await withProject(project, async () => {
    const run = await makeRun(project);
    const stage = await runs.startStage({ run_id: run.run_id, kind: "spec", gate_type: "spec" });
    await runs.archiveArtifact({
      run_id: run.run_id,
      stage_id: stage.stage_id,
      kind: "spec",
      relative_path: "spec/notes.md",
      bytes: "latency p95 budget declared; SLO availability noted.\n",
    });

    // Malformed JSON → whole file ignored.
    writeFileSync(join(project, ".harness", "missability-overrides.json"), "{{{ not json", "utf8");
    const r1 = miss.runMissabilityChecks({ run_id: run.run_id, required_check_ids: ["nfrs-declared"] });
    assert.equal(r1.results.find((r) => r.check_id === "nfrs-declared").status, "pass", "default regex still evaluated");

    // Malformed regex in a pattern_override → that override ignored, default evaluate used.
    writeFileSync(
      join(project, ".harness", "missability-overrides.json"),
      JSON.stringify({ "nfrs-declared": { pattern_override: "([unclosed" } }),
      "utf8",
    );
    const r2 = miss.runMissabilityChecks({ run_id: run.run_id, required_check_ids: ["nfrs-declared"] });
    assert.equal(r2.results.find((r) => r.check_id === "nfrs-declared").status, "pass", "invalid regex falls back to the builtin check");
  });
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
