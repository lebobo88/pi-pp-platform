/**
 * archive-path-normalize.unit.mjs
 *
 * TDD pre-check tests for BUG-1: doubled .harness/<run_id>/ path segment in
 * archiveArtifact (packages/core/src/orchestrator/runs.ts).
 *
 * Repro: .harness/run_EGv8C26e660h/repro/attempt-1.md
 *
 * Coverage (all MUST-level from the repro spec):
 *   AC-1a [pre-fail]: redundant .harness/<run_id>/ prefix in relative_path →
 *         archived at correct single-prefix path; DB artifacts.path also
 *         single-prefix. FAILS pre-fix, PASSES post-fix.
 *   AC-1b [pre-fail]: win32 backslash-separator variant of the redundant prefix
 *         is handled identically. FAILS pre-fix on win32. Skipped on POSIX
 *         (backslash is a literal filename char there; cross-platform
 *         separator handling is implicitly covered by AC-1a path normalisation
 *         in the fix).
 *   AC-1c [regression]: prefix-free relative_path is a no-op (passes pre-fix).
 *   AC-3a [regression]: .harness-notes/ substring (not followed by run_id)
 *         is preserved verbatim; NOT stripped.
 *   AC-3b [regression]: .harness/<OTHER_run_id>/x.md prefix for a DIFFERENT
 *         run is NOT treated as this run's redundant prefix.
 *
 * Anti-stall contract:
 *   - Isolated PP_HOME (temp dir); direct dist function calls.
 *   - No MCP server, no daemon socket.
 *   - Run: node --test packages/core/test/archive-path-normalize.unit.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ── DB isolation ──────────────────────────────────────────────────────────────
// PP_HOME MUST be set before the first dist import so the DB lives in a temp
// location and does not touch any live dev-server DB.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-anorm-suite-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
delete process.env.PP_DB_PATH;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";
process.env.PP_SKIP_CLI_VERSIONS = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

// ── Lazy-loaded dist modules ──────────────────────────────────────────────────
let _runs = null;
let _db = null;

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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalise path separators for cross-platform string comparisons. */
function norm(p) {
  return p.replaceAll("\\", "/");
}

/** Create a minimal scratch project directory. */
function setupProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-anorm-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
  return dir;
}

/**
 * Insert a bare run row via SQL (avoids startRun's git / eights overhead).
 * Also creates the artifact dir so archiveArtifact has a parent to write under.
 */
async function insertRun(projectPath) {
  const db = await getDb();
  const id = `run_anorm_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db()
    .prepare(
      `INSERT INTO runs(id, project_path, request_text, mode, team, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, projectPath, "archive-path-normalize test", "single", "ad-hoc", "running", now);
  mkdirSync(join(projectPath, ".harness", id), { recursive: true });
  return id;
}

// ── AC-1a: doubled .harness/<run_id>/ prefix stripped ────────────────────────
// Pre-fix: join(dir, ".harness/<run_id>/...") produces the doubled path.
// The returned absolute_path and the persisted artifacts.path both carry
// the doubled segment. This test asserts the single-prefix form, so it
// FAILS pre-fix and PASSES post-fix.
describe("[TDD-GATE] AC-1a: doubled .harness/<run_id>/ prefix is stripped (BUG-1 primary)", () => {
  it("[TDD-GATE] returns single-prefix absolute_path when relative_path already carries .harness/<run_id>/", async () => {
    const project = setupProject();
    try {
      const run_id = await insertRun(project);
      const { archiveArtifact } = await getRuns();

      // The agent mistakenly passes .harness/<run_id>/... as relative_path,
      // having stripped only cwd from the absolute artifact_dir.
      const redundantPath = `.harness/${run_id}/browser-validation/report.md`;
      const result = archiveArtifact({
        run_id,
        kind: "browser_validation_report",
        relative_path: redundantPath,
        bytes: "severity: clean\nengine: playwright\n",
      });

      assert.equal(result.status, "ok", "archiveArtifact must succeed without throwing");

      // The file must land at <project>/.harness/<run_id>/browser-validation/report.md
      // (single prefix), NOT at the doubled .harness/<run_id>/.harness/<run_id>/... path.
      const expectedAbsolute = norm(
        join(project, ".harness", run_id, "browser-validation", "report.md"),
      );
      assert.equal(
        norm(result.absolute_path),
        expectedAbsolute,
        `AC-1a: absolute_path must be single-prefix; got: ${result.absolute_path}`,
      );

      // The persisted artifacts.path must also be the single-prefix canonical form.
      const db = await getDb();
      const row = db()
        .prepare(
          `SELECT path FROM artifacts
            WHERE run_id = ? AND kind = 'browser_validation_report'
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(run_id);
      assert.ok(row, "artifact row must be inserted into the DB");
      assert.equal(
        row.path,
        `.harness/${run_id}/browser-validation/report.md`,
        `AC-1a: DB artifacts.path must be single-prefix; got: ${row.path}`,
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

// ── AC-1b: win32 backslash-separator variant ──────────────────────────────────
// On Windows, the agent may produce a path with native backslash separators.
// Pre-fix: the doubled path is produced. FAILS pre-fix on win32.
// On POSIX, backslash is a legal filename character (not a separator), so
// the doubled-path bug does not manifest the same way; the test is skipped.
describe("[TDD-GATE] AC-1b: win32 backslash separator variant of redundant prefix is normalised", () => {
  it("[TDD-GATE] backslash-delimited redundant prefix resolves to single-prefix result", async () => {
    if (process.platform !== "win32") {
      // On POSIX, backslash is a filename char, not a path separator.
      // The cross-platform normalization guaranteed by AC-1a is sufficient.
      return;
    }

    const project = setupProject();
    try {
      const run_id = await insertRun(project);
      const { archiveArtifact } = await getRuns();

      // Native win32 path produced by path.join when the agent strips cwd
      // from an absolute artifact_dir using Windows-native separators.
      const backslashPath = `.harness\\${run_id}\\browser-validation\\report-b.md`;
      const result = archiveArtifact({
        run_id,
        kind: "browser_validation_report",
        relative_path: backslashPath,
        bytes: "severity: clean\n",
      });

      assert.equal(result.status, "ok", "archiveArtifact must not throw on backslash variant");

      const expectedAbsolute = norm(
        join(project, ".harness", run_id, "browser-validation", "report-b.md"),
      );
      assert.equal(
        norm(result.absolute_path),
        expectedAbsolute,
        `AC-1b: absolute_path must be single-prefix for backslash variant; got: ${result.absolute_path}`,
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

// ── AC-1c: prefix-free relative_path is a no-op (regression guard) ───────────
// An already-correct relative_path (no redundant prefix) must continue to
// resolve to <project>/.harness/<run_id>/<tail> unchanged.
// PASSES pre-fix (the bug only triggers for redundant-prefix inputs).
describe("AC-1c: prefix-free relative_path is unchanged — no-op on correct input (regression)", () => {
  it("relative_path without redundant prefix resolves to correct single-prefix location", async () => {
    const project = setupProject();
    try {
      const run_id = await insertRun(project);
      const { archiveArtifact } = await getRuns();

      const cleanPath = "browser-validation/report-c.md";
      const result = archiveArtifact({
        run_id,
        kind: "browser_validation_report",
        relative_path: cleanPath,
        bytes: "severity: clean\n",
      });

      assert.equal(result.status, "ok");

      const expectedAbsolute = norm(
        join(project, ".harness", run_id, "browser-validation", "report-c.md"),
      );
      assert.equal(
        norm(result.absolute_path),
        expectedAbsolute,
        "AC-1c: already-correct relative_path must resolve to <project>/.harness/<run_id>/<tail>",
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

// ── AC-3a: .harness-notes/ substring not falsely stripped ────────────────────
// A relative_path containing ".harness" NOT immediately followed by this
// run's run_id MUST NOT be stripped. The ".harness-notes" directory name is
// a legitimate subdirectory inside the artifact tree.
// PASSES pre-fix (no normalization exists pre-fix to strip anything).
describe("AC-3a: .harness-notes/ substring is preserved — not a false-positive strip", () => {
  it("docs/.harness-notes/summary.md is preserved verbatim inside the artifact dir", async () => {
    const project = setupProject();
    try {
      const run_id = await insertRun(project);
      const { archiveArtifact } = await getRuns();

      const result = archiveArtifact({
        run_id,
        relative_path: "docs/.harness-notes/summary.md",
        bytes: "# notes\n",
      });

      assert.equal(result.status, "ok");

      // Must resolve to <project>/.harness/<run_id>/docs/.harness-notes/summary.md
      // (.harness-notes is a directory inside the run artifact tree, not a strip target).
      const expectedAbsolute = norm(
        join(project, ".harness", run_id, "docs", ".harness-notes", "summary.md"),
      );
      assert.equal(
        norm(result.absolute_path),
        expectedAbsolute,
        "AC-3a: .harness-notes/ segment must be preserved; must not be confused with the run prefix",
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

// ── AC-3b: different run_id prefix not treated as this run's prefix ───────────
// A relative_path carrying ANOTHER run's prefix (.harness/<OTHER>/) must NOT
// be stripped. It is a legitimately nested file inside the current run's dir.
// Pre-fix: resolve(join(dir, ".harness/run_OTHER/x.md")) =
//   <project>/.harness/<run_id>/.harness/run_OTHER/x.md — which is inside dir,
//   passes the containment guard, and is accepted as-is. Post-fix: the same.
// PASSES both pre-fix and post-fix (regression guard against over-stripping).
describe("AC-3b: different run_id prefix is NOT treated as this run's redundant prefix", () => {
  it(".harness/run_OTHER/x.md resolves to a nested file inside this run's artifact dir", async () => {
    const project = setupProject();
    try {
      const run_id = await insertRun(project);
      const { archiveArtifact } = await getRuns();

      // run_OTHER's prefix must NOT be stripped; it should be nested inside
      // this run's artifact dir as an ordinary directory entry.
      const result = archiveArtifact({
        run_id,
        relative_path: ".harness/run_OTHER/x.md",
        bytes: "# other run reference data\n",
      });

      assert.equal(result.status, "ok");

      // Correct resolution: <project>/.harness/<run_id>/.harness/run_OTHER/x.md
      const expectedAbsolute = norm(
        join(project, ".harness", run_id, ".harness", "run_OTHER", "x.md"),
      );
      assert.equal(
        norm(result.absolute_path),
        expectedAbsolute,
        "AC-3b: run_OTHER prefix must NOT be stripped — must nest inside this run's artifact dir",
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
