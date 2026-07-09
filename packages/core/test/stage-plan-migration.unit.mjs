// v10 schema migration idempotency (stage_plan_json / plan_index) — run-recovery
// support. Runs against compiled dist/.
//
// (1) Simulate a pre-v10 DB (runs/stages tables WITHOUT stage_plan_json /
//     plan_index), open it once and assert the additive migration ran.
// (2) Write a stage_plan_json + plan_index value, close the connection, then
//     re-open the SAME db file (a second `applyMigrations` pass against an
//     already-migrated file — exactly what happens every time an existing
//     project's DB is opened by a fresh process) and assert: no error is
//     thrown (ALTER TABLE ADD COLUMN is not re-attempted), the columns are
//     still present, and the previously-written values survived unchanged.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (rel) => import(pathToFileURL(join(DIST, rel)).href);
const require = createRequire(import.meta.url);

function colNames(conn, table) {
  return conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

async function testV10MigrationOnPreV10Db() {
  const Database = require("better-sqlite3");
  const dbPath = join(mkdtempSync(join(tmpdir(), "pp-v10-mig-")), "state.db");

  // Build a minimal pre-v10 DB: runs + stages WITHOUT stage_plan_json /
  // plan_index. SCHEMA_SQL's CREATE TABLE IF NOT EXISTS is a no-op for these
  // two (they already exist) but will create any other missing tables
  // (attempts, verdicts, etc.) fresh and current — mirroring how a real
  // pre-v10 DB looked (those other tables were already at their v9 shape).
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, request_text TEXT NOT NULL,
      team TEXT, mode TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT);
    CREATE TABLE stages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT, gate_type TEXT, status TEXT, started_at TEXT);
  `);
  seed.prepare("INSERT INTO runs (id, project_path, request_text, mode, status, started_at) VALUES (?,?,?,?,?,?)")
    .run("run_prev10", "C:/tmp/proj", "legacy run", "single", "complete", new Date().toISOString());
  seed.prepare("INSERT INTO stages (id, run_id, kind, gate_type, status, started_at) VALUES (?,?,?,?,?,?)")
    .run("stage_prev10", "run_prev10", "code", "code_style", "passed", new Date().toISOString());
  assert.ok(!colNames(seed, "runs").includes("stage_plan_json"), "seed: runs has no stage_plan_json yet");
  assert.ok(!colNames(seed, "stages").includes("plan_index"), "seed: stages has no plan_index yet");
  seed.close();

  // First open: point core at the seed DB — triggers SCHEMA_SQL + applyMigrations.
  const { setDbPath, db, closeDb } = await importDist("db/database.js");
  setDbPath(dbPath);
  const conn1 = db();

  assert.ok(colNames(conn1, "runs").includes("stage_plan_json"), "migration added runs.stage_plan_json");
  assert.ok(colNames(conn1, "stages").includes("plan_index"), "migration added stages.plan_index");
  // Legacy rows survived, with the new columns NULL by default.
  const run1 = conn1.prepare("SELECT * FROM runs WHERE id=?").get("run_prev10");
  assert.equal(run1.request_text, "legacy run", "legacy run row preserved through migration");
  assert.equal(run1.stage_plan_json, null, "new column defaults to NULL on a pre-existing row");
  const stage1 = conn1.prepare("SELECT * FROM stages WHERE id=?").get("stage_prev10");
  assert.equal(stage1.plan_index, null, "new column defaults to NULL on a pre-existing row");

  // Write a plan + plan_index so we can prove they survive a second
  // migration pass unchanged.
  const planJson = JSON.stringify([{ kind: "code", gate_type: "code_style", agent: "engineer" }]);
  conn1.prepare("UPDATE runs SET stage_plan_json = ? WHERE id = ?").run(planJson, "run_prev10");
  conn1.prepare("UPDATE stages SET plan_index = ? WHERE id = ?").run(0, "stage_prev10");
  closeDb();

  console.log("✓ v10 migration adds stage_plan_json/plan_index additively on a pre-v10 DB");

  // Second open of the SAME file: applyMigrations runs again against an
  // already-migrated DB (byte-identical to what happens every time an
  // existing project's DB is re-opened by a fresh process). Must not throw
  // ("duplicate column name" from a naive unconditional ALTER TABLE) and
  // must leave the written values untouched.
  setDbPath(dbPath);
  const conn2 = db();
  assert.ok(colNames(conn2, "runs").includes("stage_plan_json"), "column still present after 2nd migration pass");
  assert.ok(colNames(conn2, "stages").includes("plan_index"), "column still present after 2nd migration pass");
  const run2 = conn2.prepare("SELECT * FROM runs WHERE id=?").get("run_prev10");
  assert.equal(run2.stage_plan_json, planJson, "stage_plan_json survives a second migration pass unchanged");
  const stage2 = conn2.prepare("SELECT * FROM stages WHERE id=?").get("stage_prev10");
  assert.equal(stage2.plan_index, 0, "plan_index survives a second migration pass unchanged");
  closeDb();

  console.log("✓ v10 migration is idempotent: re-applying against an already-migrated DB is a safe no-op");
}

async function main() {
  await testV10MigrationOnPreV10Db();
  console.log("✓ stage-plan-migration.unit.mjs: all assertions passed");
}

main().catch((err) => {
  console.error("✗ stage-plan-migration.unit.mjs failed:", err);
  process.exit(1);
});
