/**
 * browser-validation-scoping.unit.mjs
 *
 * TDD pre-check tests for BUG-2: stale-artifact false-fail in the
 * browser-validation-evidence missability check.
 * (packages/core/src/orchestrator/missability.ts — runMissabilityChecks)
 *
 * Repro: .harness/run_EGv8C26e660h/repro/attempt-1.md
 *
 * Coverage (all MUST-level from the repro spec):
 *   AC-2a [pre-fail]: stage S with report A (severity: errors, old created_at)
 *         and report B (severity: clean, new created_at); check MUST return
 *         pass — it evaluates only the winner/latest report. Pre-fix: the
 *         check scans all reports, finds the errors one, returns fail.
 *         FAILS pre-fix, PASSES post-fix.
 *   AC-2b [regression]: stage S where the SELECTED (winner/latest) report has
 *         severity: errors, and an older clean report also exists; check MUST
 *         return fail citing the selected report. PASSES pre-fix.
 *   AC-2c [regression]: stage S where the only report has severity: unavailable;
 *         check MUST return fail (PP-BV-ISO evidence gap). PASSES pre-fix.
 *   AC-4a [regression]: stage with no browser_validation_report artifact; check
 *         returns fail with the existing "no report" evidence and does not throw.
 *         PASSES pre-fix.
 *
 * Note on AC-4b (winner_attempt_id set, only non-winner reports present):
 *   This AC requires the artifacts table to carry an attempt_id column (linking
 *   the archived artifact back to the attempt that produced it), which is an
 *   ADDITIVE schema migration not yet applied pre-fix. The test is deferred to
 *   the post-fix regression suite once the migration lands. The engineer's fix
 *   must add attempt_id to artifacts (per R2-1 and R2-2 of the repro spec).
 *
 * Anti-stall contract:
 *   - Isolated PP_HOME (temp dir); direct dist function calls + SQL inserts.
 *   - No MCP server, no daemon socket.
 *   - Run: node --test packages/core/test/browser-validation-scoping.unit.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ── DB isolation ──────────────────────────────────────────────────────────────
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-bvscope-suite-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
delete process.env.PP_DB_PATH;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";
process.env.PP_SKIP_CLI_VERSIONS = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

// ── Lazy-loaded dist modules ──────────────────────────────────────────────────
let _db = null;
let _miss = null;

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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Shared scratch project directory — all tests share it; each test gets its
 * own run_id so rows never collide. */
const SHARED_PROJECT = mkdtempSync(join(tmpdir(), "pp-bvscope-proj-"));
mkdirSync(join(SHARED_PROJECT, ".harness"), { recursive: true });
writeFileSync(join(SHARED_PROJECT, "AGENTS.md"), "# AGENTS\n", "utf8");

let _seq = 0;
function nextId(prefix) {
  return `${prefix}_${(++_seq).toString(36).padStart(4, "0")}`;
}

/** Insert a bare run row (avoids startRun overhead). */
async function insertRun() {
  const db = await getDb();
  const id = nextId("run_bvs");
  db()
    .prepare(
      `INSERT INTO runs(id, project_path, request_text, mode, team, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      SHARED_PROJECT,
      "browser-validation-scoping test",
      "single",
      "ad-hoc",
      "running",
      new Date().toISOString(),
    );
  mkdirSync(join(SHARED_PROJECT, ".harness", id), { recursive: true });
  return id;
}

/** Insert a stage row with optional winner_attempt_id. */
async function insertStage(run_id, { winner_attempt_id = null } = {}) {
  const db = await getDb();
  const id = nextId("stage_bvs");
  db()
    .prepare(
      `INSERT INTO stages(id, run_id, kind, gate_type, status, winner_attempt_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, run_id, "browser_validation", "contract", "passed", winner_attempt_id, new Date().toISOString());
  return id;
}

/**
 * Write a browser validation report file to disk and insert an artifact row.
 *
 * The path stored in artifacts.path is the project-relative canonical form
 * `.harness/<run_id>/browser-validation/<filename>` so that the
 * runMissabilityChecks text-load cascade (step 2: join(project, path)) finds
 * the file at <project>/.harness/<run_id>/browser-validation/<filename>.
 *
 * @param {string} run_id
 * @param {string} stage_id
 * @param {object} opts
 * @param {string} opts.filename   - e.g. "report-old.md"
 * @param {string} opts.severity   - e.g. "errors" | "clean" | "unavailable"
 * @param {string} opts.created_at - ISO-8601 timestamp (controls sort order)
 */
async function insertReport(run_id, stage_id, { filename, severity, created_at }) {
  const db = await getDb();

  // Write the report file to disk so the text-load cascade can read it.
  const reportDir = join(SHARED_PROJECT, ".harness", run_id, "browser-validation");
  mkdirSync(reportDir, { recursive: true });
  const content = `# Browser validation report\n\nseverity: ${severity}\nengine: playwright\n`;
  writeFileSync(join(reportDir, filename), content, "utf8");

  // The path column uses the project-relative form (matching what archiveArtifact stores).
  const relPath = `.harness/${run_id}/browser-validation/${filename}`;
  const id = nextId("art_bvs");

  db()
    .prepare(
      `INSERT INTO artifacts(id, run_id, stage_id, kind, path, sha256, bytes, evidence_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, run_id, stage_id, "browser_validation_report", relPath, "fakeshafake", content.length, null, created_at);

  return { id, relPath };
}

// ── AC-2a: stale errors report must not cause false-fail when latest is clean ─
//
// Pre-fix behavior:
//   The query fetches ALL browser_validation_report artifacts for the run
//   with no ordering. reports.find(r => /errors/) finds report A and the
//   check returns fail — a false negative because report B (the winner/latest)
//   is clean.
//
// This test asserts the check returns PASS. Pre-fix: fails. Post-fix: passes.
describe("[TDD-GATE] AC-2a: stale errors report must not determine outcome when latest/winner report is clean [pre-fail]", () => {
  it("[TDD-GATE] runMissabilityChecks returns browser-validation-evidence=pass when winner/latest report is clean", async () => {
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id, { winner_attempt_id: "attempt_winner_W" });
    const miss = await getMiss();

    // Report A: severity=errors, archived earlier (superseded Reflexion attempt).
    await insertReport(run_id, stage_id, {
      filename: "report-old.md",
      severity: "errors",
      created_at: "2025-01-01T00:00:00.000Z",
    });

    // Report B: severity=clean, archived later (the winning / latest attempt).
    await insertReport(run_id, stage_id, {
      filename: "report-new.md",
      severity: "clean",
      created_at: "2025-01-02T00:00:00.000Z",
    });

    const result = miss.runMissabilityChecks({
      run_id,
      required_check_ids: ["browser-validation-evidence"],
    });

    const bv = result.results.find((r) => r.check_id === "browser-validation-evidence");
    assert.ok(bv, "browser-validation-evidence result must be present");
    assert.equal(
      bv.status,
      "pass",
      `AC-2a: check must pass when winner/latest report is clean; got ${bv.status} (evidence: ${bv.evidence})`,
    );
    // The evidence must not name the superseded errors report.
    assert.ok(
      !(bv.evidence ?? "").includes("report-old"),
      `AC-2a: evidence must not cite the superseded report; got: ${bv.evidence}`,
    );
  });
});

// ── AC-2b: selected (latest) report with severity=errors still fails ──────────
// When the NEWEST report for a stage has severity=errors, the check must fail
// regardless of any older clean report. PASSES pre-fix (find catches errors).
describe("AC-2b: selected (latest) report with severity=errors causes fail (regression)", () => {
  it("runMissabilityChecks returns fail when latest report has severity=errors", async () => {
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    const miss = await getMiss();

    // Report A: clean, older.
    await insertReport(run_id, stage_id, {
      filename: "report-old-clean.md",
      severity: "clean",
      created_at: "2025-02-01T00:00:00.000Z",
    });

    // Report B: errors, newer — this is the selected report post-fix.
    await insertReport(run_id, stage_id, {
      filename: "report-new-errors.md",
      severity: "errors",
      created_at: "2025-02-02T00:00:00.000Z",
    });

    const result = miss.runMissabilityChecks({
      run_id,
      required_check_ids: ["browser-validation-evidence"],
    });

    const bv = result.results.find((r) => r.check_id === "browser-validation-evidence");
    assert.ok(bv, "browser-validation-evidence result must be present");
    assert.equal(
      bv.status,
      "fail",
      `AC-2b: check must fail when selected (latest) report has severity=errors; got ${bv.status}`,
    );
  });
});

// ── AC-2c: severity=unavailable surfaces as evidence gap (PP-BV-ISO) ──────────
// A report with severity=unavailable means the browser could not run.
// The check must surface this as a fail (evidence gap), not a pass.
// PASSES pre-fix (find-unavailable guard already exists).
describe("AC-2c: severity=unavailable surfaces as evidence gap — not a pass (PP-BV-ISO regression)", () => {
  it("runMissabilityChecks returns fail when selected report has severity=unavailable", async () => {
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    const miss = await getMiss();

    await insertReport(run_id, stage_id, {
      filename: "report-unavail.md",
      severity: "unavailable",
      created_at: "2025-03-01T00:00:00.000Z",
    });

    const result = miss.runMissabilityChecks({
      run_id,
      required_check_ids: ["browser-validation-evidence"],
    });

    const bv = result.results.find((r) => r.check_id === "browser-validation-evidence");
    assert.ok(bv, "browser-validation-evidence result must be present");
    assert.equal(
      bv.status,
      "fail",
      `AC-2c: unavailable severity must surface as fail; got ${bv.status}`,
    );
    assert.ok(
      (bv.evidence ?? "").includes("unavailable"),
      `AC-2c: evidence must name the unavailable gap; got: ${bv.evidence}`,
    );
  });
});

// ── AC-4a: no report → fail with "no report" evidence, no throw ──────────────
// When no browser_validation_report artifact exists for the run, the check
// must return fail with the existing "no browser_validation_report artifact
// in run" evidence. PASSES pre-fix (existing early-return guard).
describe("AC-4a: no report → fail with existing 'no report' evidence (fallback regression)", () => {
  it("runMissabilityChecks returns fail without throwing when no report artifact exists", async () => {
    const run_id = await insertRun();
    // Insert a stage row but NO artifact for it.
    await insertStage(run_id);
    const miss = await getMiss();

    let threw = false;
    let result;
    try {
      result = miss.runMissabilityChecks({
        run_id,
        required_check_ids: ["browser-validation-evidence"],
      });
    } catch (err) {
      threw = true;
      assert.fail(`AC-4a: check MUST NOT throw; got ${err.message}`);
    }

    assert.equal(threw, false, "AC-4a: check must not throw");
    const bv = result.results.find((r) => r.check_id === "browser-validation-evidence");
    assert.ok(bv, "browser-validation-evidence result must be present");
    assert.equal(
      bv.status,
      "fail",
      `AC-4a: no-report stage must return fail; got ${bv.status}`,
    );
    assert.ok(
      (bv.evidence ?? "").includes("no browser_validation_report"),
      `AC-4a: evidence must name the missing report; got: ${bv.evidence}`,
    );
  });
});
