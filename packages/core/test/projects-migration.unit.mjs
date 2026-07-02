// v8 schema migration + project/settings CRUD (M5c). Runs against compiled dist/.
//
// (1) Simulate a pre-v8 DB (attempts table WITHOUT session_file; no projects /
//     platform_settings tables), then let core open it and assert the additive
//     migration ran: attempts.session_file added, new tables created.
// (2) Project registry CRUD roundtrip + budget-caps kv roundtrip on a fresh db.

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
function tableExists(conn, table) {
  return !!conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

async function testMigrationOnPreV8Db() {
  const Database = require("better-sqlite3");
  const dbPath = join(mkdtempSync(join(tmpdir(), "pp-mig-")), "state.db");

  // Build a minimal pre-v8 DB: runs + an attempts table missing session_file,
  // and deliberately NO projects / platform_settings tables.
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, request_text TEXT NOT NULL,
      team TEXT, mode TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT);
    CREATE TABLE stages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT, gate_type TEXT, status TEXT, started_at TEXT);
    CREATE TABLE attempts (id TEXT PRIMARY KEY, stage_id TEXT NOT NULL, producer TEXT, model_id TEXT,
      prompt_hash TEXT, artifact_path TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, wall_ms INTEGER,
      retry_index INTEGER NOT NULL DEFAULT 0, parent_attempt_id TEXT, status TEXT NOT NULL,
      attempted_tier TEXT, notes_json TEXT, agent_type TEXT, created_at TEXT NOT NULL);
  `);
  seed.prepare("INSERT INTO runs (id, project_path, request_text, mode, status, started_at) VALUES (?,?,?,?,?,?)")
    .run("run_pre8", "C:/tmp/proj", "legacy run", "single", "complete", new Date().toISOString());
  assert.ok(!colNames(seed, "attempts").includes("session_file"), "seed: attempts has no session_file yet");
  assert.ok(!tableExists(seed, "projects"), "seed: no projects table yet");
  seed.close();

  // Point core at the seed DB and open it — triggers SCHEMA_SQL + applyMigrations.
  const { setDbPath, db, closeDb } = await importDist("db/database.js");
  setDbPath(dbPath);
  const conn = db();

  assert.ok(colNames(conn, "attempts").includes("session_file"), "migration added attempts.session_file");
  assert.ok(tableExists(conn, "projects"), "migration created projects table");
  assert.ok(tableExists(conn, "agent_sessions"), "migration created agent_sessions table");
  assert.ok(tableExists(conn, "platform_settings"), "migration created platform_settings table");
  // Legacy row survived.
  const run = conn.prepare("SELECT * FROM runs WHERE id=?").get("run_pre8");
  assert.equal(run.request_text, "legacy run", "legacy run row preserved through migration");
  closeDb();

  console.log("✓ v8 migration applies additively on a pre-v8 DB");
}

async function testProjectAndSettingsCrud() {
  const { setDbPath, closeDb } = await importDist("db/database.js");
  const projects = await importDist("orchestrator/projects.js");
  const settings = await importDist("orchestrator/settings.js");

  const dbPath = join(mkdtempSync(join(tmpdir(), "pp-crud-")), "state.db");
  setDbPath(dbPath);

  // registerProject validates the dir exists.
  const projDir = mkdtempSync(join(tmpdir(), "pp-project-"));
  const row = projects.registerProject({ path: projDir });
  assert.ok(row.id.startsWith("proj_"), "registerProject returns an id");
  assert.equal(row.path, projDir);

  // Idempotent re-register; name upsert.
  const again = projects.registerProject({ path: projDir, name: "My Project" });
  assert.equal(again.id, row.id, "re-register reuses the same id");
  assert.equal(again.name, "My Project", "name upserts");

  // registerProject rejects a non-existent dir.
  assert.throws(
    () => projects.registerProject({ path: join(projDir, "does-not-exist") }),
    /project path does not exist/,
    "registerProject rejects a missing dir",
  );

  // list + get DTO shape.
  const list = projects.listProjects();
  assert.equal(list.length, 1, "listProjects returns the one project");
  const dto = projects.getProject(projDir);
  assert.equal(dto.name, "My Project");
  assert.equal(dto.run_count, 0, "run_count derived (0 with no runs)");
  assert.ok("profile" in dto && "last_run_at" in dto, "DTO carries profile + last_run_at");

  // touchLastRun.
  projects.touchLastRun(projDir, "2026-07-02T00:00:00.000Z");
  assert.equal(projects.getProject(projDir).last_run_at, "2026-07-02T00:00:00.000Z");

  // Budget caps kv roundtrip.
  assert.deepEqual(settings.getBudgetCaps(), [], "no caps initially");
  const caps = [{ scope: "day", limit_usd: 8, warn_pct: 0.8, block_pct: 1.0 }];
  settings.setBudgetCaps(caps);
  assert.deepEqual(settings.getBudgetCaps(), caps, "caps roundtrip");
  settings.setPlatformSetting("k", { a: 1 });
  assert.deepEqual(settings.getPlatformSetting("k"), { a: 1 }, "generic setting roundtrip");

  // removeProject.
  assert.equal(projects.removeProject(projDir), true, "removeProject deletes");
  assert.equal(projects.listProjects().length, 0, "project gone after remove");
  closeDb();

  console.log("✓ project registry + settings kv CRUD roundtrip");
}

async function main() {
  await testMigrationOnPreV8Db();
  await testProjectAndSettingsCrud();
  console.log("✓ projects-migration.unit.mjs: all assertions passed");
}

main().catch((err) => {
  console.error("✗ projects-migration.unit.mjs failed:", err);
  process.exit(1);
});
