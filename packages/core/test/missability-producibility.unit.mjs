/**
 * missability-producibility.unit.mjs
 *
 * R1 — producibility audit for the PP-VG-4 missability gate.
 *
 * finalizeRun(complete) demotes a REQUIRED missability check to ADVISORY when
 * NO planned artifact kind / taxonomy section of the run can produce its
 * evidence (empty intersection with the check's producing surface). Such a
 * check still ran and its row is recorded, but it no longer blocks completion.
 * Producible required checks keep full standard/major governance. Trivial-scope
 * behaviour from e8662ab is unchanged (the whole gate is skipped there).
 *
 * Coverage:
 *   1. required-but-UNPRODUCIBLE failing check -> does NOT block; the demotion
 *      is annotated on the persisted check row (advisory_unproducible marker).
 *   2a. required-and-PRODUCIBLE (always-on) failing check -> still blocks.
 *   2b. required-and-PRODUCIBLE (kind planned/archived) failing check -> still blocks.
 *   3. trivial-scope run with a failing required check -> gate skipped (e8662ab).
 *   4. mixed set: unproducible fail demoted, producible fail still blocks.
 *
 * Anti-stall contract:
 *   - Temp sqlite DB (PP_HOME override), direct dist function calls.
 *   - No MCP server, no daemon socket, no smoke files.
 *   - Run: timeout 90 node --test test/missability-producibility.unit.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Set PP_HOME BEFORE any dist import so the DB is isolated.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-missability-producibility-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
delete process.env.PP_DB_PATH; // isolate from any live dev server DB
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let _runs = null;
let _db = null;
let _miss = null;
async function getRuns() {
  if (!_runs) _runs = await importDist("orchestrator/runs.js");
  return _runs;
}
async function getDb() {
  if (!_db) {
    const m = await importDist("db/database.js");
    _db = m.db;
  }
  return _db;
}
async function getMiss() {
  if (!_miss) _miss = await importDist("orchestrator/missability.js");
  return _miss;
}

const SHARED_PROJECT = mkdtempSync(join(tmpdir(), "pp-mp-shared-"));
mkdirSync(join(SHARED_PROJECT, ".harness"), { recursive: true });
writeFileSync(join(SHARED_PROJECT, "AGENTS.md"), "# AGENTS\n", "utf8");

async function insertRun(overrides = {}) {
  const db = await getDb();
  const id = `run_mp_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO runs(id, project_path, request_text, mode, team, forum, status,
        profile_snapshot_json, taxonomy_mapping_json, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    overrides.project_path ?? SHARED_PROJECT,
    "missability-producibility test",
    "single",
    overrides.team ?? null,
    overrides.forum ?? null,
    "running",
    overrides.profile_snapshot_json ?? null,
    overrides.taxonomy_mapping_json ?? null,
    now,
  );
  return id;
}

async function insertMissabilityCheck(run_id, check_id, status, evidence_path = null, offsetMs = 0) {
  const db = await getDb();
  const id = `mc_mp_${Math.random().toString(36).slice(2, 10)}`;
  const ts = new Date(Date.now() + offsetMs).toISOString();
  db().prepare(
    `INSERT INTO missability_checks(id, run_id, check_id, status, evidence_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, run_id, check_id, status, evidence_path, ts);
  return id;
}

async function insertArtifact(run_id, kind) {
  const db = await getDb();
  const id = `art_mp_${Math.random().toString(36).slice(2, 10)}`;
  const stage_id = `stage_mp_${Math.random().toString(36).slice(2, 10)}`;
  db().prepare(
    `INSERT INTO stages(id, run_id, kind, gate_type, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(stage_id, run_id, "code", "code", "running", new Date().toISOString());
  db().prepare(
    `INSERT INTO artifacts(id, run_id, stage_id, kind, path, sha256, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, run_id, stage_id, kind, `${kind}.md`, "abc123", 10, new Date().toISOString());
  return id;
}

async function latestCheckRow(run_id, check_id) {
  const db = await getDb();
  return db()
    .prepare(
      `SELECT status, evidence_path FROM missability_checks
        WHERE run_id = ? AND check_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(run_id, check_id);
}

// ─── isCheckProducible unit ────────────────────────────────────────────────
describe("R1: isCheckProducible map", () => {
  it("always-on checks are producible with an empty planned surface", async () => {
    const { isCheckProducible } = await getMiss();
    const empty = new Set();
    assert.equal(isCheckProducible("nfrs-declared", empty, empty), true);
    assert.equal(isCheckProducible("decision-logging", empty, empty), true);
    assert.equal(isCheckProducible("agents-md-present", empty, empty), true);
    assert.equal(isCheckProducible("constitution-attestation", empty, empty), true);
  });

  it("unknown check ids default to producible (fail-safe for governance)", async () => {
    const { isCheckProducible } = await getMiss();
    const empty = new Set();
    assert.equal(isCheckProducible("some-future-check-id", empty, empty), true);
  });

  it("kind/section-gated checks are unproducible with empty surface, producible when planned", async () => {
    const { isCheckProducible } = await getMiss();
    const empty = new Set();
    // deprecation-sunset: producing surface = {sections:[4.16], kinds:[eol_plan]}
    assert.equal(isCheckProducible("deprecation-sunset", empty, empty), false);
    assert.equal(isCheckProducible("deprecation-sunset", new Set(["eol_plan"]), empty), true);
    assert.equal(isCheckProducible("deprecation-sunset", empty, new Set(["4.16"])), true);
    // a game-cert check: only kind-gated
    assert.equal(isCheckProducible("lootbox-drop-rates-published", empty, empty), false);
    assert.equal(
      isCheckProducible("lootbox-drop-rates-published", new Set(["loot_table"]), empty),
      true,
    );
  });
});

// ─── PP-VG-4 producibility demotion ────────────────────────────────────────
describe("R1: PP-VG-4 producibility demotion", () => {
  it("required-but-UNPRODUCIBLE failing check does NOT block completion", async () => {
    const runs = await getRuns();
    // deprecation-sunset needs section 4.16 or an eol_plan artifact; this run
    // plans neither (NULL taxonomy, no artifacts) -> structurally impossible.
    const run_id = await insertRun({
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_missability_checks: ["deprecation-sunset"],
      }),
    });
    await insertMissabilityCheck(run_id, "deprecation-sunset", "fail");

    const result = runs.finalizeRun({ run_id, status: "complete" });
    assert.equal(
      result.effective_status,
      "complete",
      "structurally-impossible required check must be demoted to advisory and not block",
    );
  });

  it("demotion is visible in the check record (advisory_unproducible marker)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_missability_checks: ["deprecation-sunset"],
      }),
    });
    await insertMissabilityCheck(run_id, "deprecation-sunset", "fail", "orig-evidence.md");

    runs.finalizeRun({ run_id, status: "complete" });

    const row = await latestCheckRow(run_id, "deprecation-sunset");
    assert.ok(row, "check row must still exist");
    assert.match(
      row.evidence_path ?? "",
      /advisory_unproducible/,
      "demoted check row must be annotated with advisory_unproducible",
    );
    assert.match(
      row.evidence_path ?? "",
      /orig-evidence\.md/,
      "original evidence_path must be preserved alongside the marker",
    );
  });

  it("required-and-PRODUCIBLE (always-on) failing check STILL blocks", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_missability_checks: ["nfrs-declared"],
      }),
    });
    await insertMissabilityCheck(run_id, "nfrs-declared", "fail");

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "MissabilityGateViolation", `got ${err.name}: ${err.message}`);
      assert.match(err.message, /PP-VG-4/);
      assert.ok(err.failed_required_check_ids.includes("nfrs-declared"));
    }
    assert.ok(threw, "always-producible failing required check must still block");
  });

  it("required-and-PRODUCIBLE (kind archived) failing check STILL blocks", async () => {
    const runs = await getRuns();
    // deprecation-sunset becomes producible because the run archived an eol_plan
    // artifact — its evidence CAN be produced, so a failing result must block.
    const run_id = await insertRun({
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_missability_checks: ["deprecation-sunset"],
      }),
    });
    await insertArtifact(run_id, "eol_plan");
    await insertMissabilityCheck(run_id, "deprecation-sunset", "fail");

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "MissabilityGateViolation", `got ${err.name}: ${err.message}`);
      assert.match(err.message, /deprecation-sunset/);
    }
    assert.ok(threw, "producible-because-planned failing required check must still block");
  });

  it("mixed set: unproducible fail demoted, producible fail still blocks", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_missability_checks: ["deprecation-sunset", "nfrs-declared"],
      }),
    });
    await insertMissabilityCheck(run_id, "deprecation-sunset", "fail"); // unproducible -> demoted
    await insertMissabilityCheck(run_id, "nfrs-declared", "fail"); // always -> blocks

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "MissabilityGateViolation");
      assert.ok(
        err.failed_required_check_ids.includes("nfrs-declared"),
        "producible fail must be reported",
      );
      assert.ok(
        !err.failed_required_check_ids.includes("deprecation-sunset"),
        "demoted unproducible fail must NOT be in the blocking set",
      );
    }
    assert.ok(threw, "producible fail in a mixed set must still block");
  });

  it("trivial-scope run with a failing required check -> gate skipped (e8662ab unchanged)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_missability_checks: ["nfrs-declared"], // producible, but trivial skips whole gate
      }),
      taxonomy_mapping_json: JSON.stringify({ scope: "trivial", signals: [], sections: [] }),
    });
    await insertMissabilityCheck(run_id, "nfrs-declared", "fail");

    const result = runs.finalizeRun({ run_id, status: "complete" });
    assert.equal(
      result.effective_status,
      "complete",
      "trivial-scope run must skip PP-VG-4 entirely (unchanged from e8662ab)",
    );
  });
});
