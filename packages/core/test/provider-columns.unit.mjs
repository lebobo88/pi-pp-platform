// Provider-visibility migration tests (spec §5.3, AC-P-2, AC-P-7).
//
//   1. Seed a DB that pre-dates provider columns (no attempts.provider,
//      no verdicts.judge_provider); open with @pp/core; assert both
//      columns exist and prior rows are preserved with NULL provider.
//   2. Re-open the same DB a second time; PRAGMA table_info is unchanged
//      (idempotent migration).

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

function cols(conn, table) {
  return conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).sort();
}

async function main() {
  const Database = require("better-sqlite3");
  const dbPath = join(mkdtempSync(join(tmpdir(), "pp-prov-")), "state.db");

  // Seed a pre-provider-columns DB: minimal schema with attempts + verdicts
  // that lack `provider` and `judge_provider`. Includes one row in each so we
  // can verify preservation.
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, request_text TEXT NOT NULL,
      team TEXT, mode TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT);
    CREATE TABLE stages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT, gate_type TEXT, status TEXT, started_at TEXT);
    CREATE TABLE attempts (id TEXT PRIMARY KEY, stage_id TEXT NOT NULL, producer TEXT, model_id TEXT,
      prompt_hash TEXT, artifact_path TEXT, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, wall_ms INTEGER,
      retry_index INTEGER NOT NULL DEFAULT 0, parent_attempt_id TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL);
    CREATE TABLE verdicts (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, judge_producer TEXT,
      judge_model_id TEXT, rubric_id TEXT, outcome TEXT NOT NULL, critique_md TEXT, score_json TEXT,
      cross_vendor INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  `);
  seed.prepare("INSERT INTO runs (id,project_path,request_text,mode,status,started_at) VALUES (?,?,?,?,?,?)")
    .run("run_legacy", "/tmp", "legacy", "single", "complete", new Date().toISOString());
  seed.prepare("INSERT INTO stages (id,run_id,kind,gate_type,status,started_at) VALUES (?,?,?,?,?,?)")
    .run("stg_legacy", "run_legacy", "code", "code", "passed", new Date().toISOString());
  seed.prepare("INSERT INTO attempts (id,stage_id,producer,model_id,retry_index,status,created_at) VALUES (?,?,?,?,?,?,?)")
    .run("att_legacy", "stg_legacy", "claude", "gpt-5.4", 0, "ok", new Date().toISOString());
  seed.prepare("INSERT INTO verdicts (id,attempt_id,judge_producer,judge_model_id,outcome,cross_vendor,created_at) VALUES (?,?,?,?,?,?,?)")
    .run("vd_legacy", "att_legacy", "openai", "gpt-4o", "pass", 1, new Date().toISOString());

  // Pre-migration state
  assert.ok(!cols(seed, "attempts").includes("provider"), "seed: attempts.provider absent");
  assert.ok(!cols(seed, "verdicts").includes("judge_provider"), "seed: verdicts.judge_provider absent");
  seed.close();

  // First open — migration runs.
  const { setDbPath, db, closeDb } = await importDist("db/database.js");
  setDbPath(dbPath);
  let conn = db();

  const attemptCols1 = cols(conn, "attempts");
  const verdictCols1 = cols(conn, "verdicts");
  assert.ok(attemptCols1.includes("provider"), "post-migrate: attempts.provider present");
  assert.ok(verdictCols1.includes("judge_provider"), "post-migrate: verdicts.judge_provider present");

  // Legacy rows preserved; provider is NULL.
  const legacyAtt = conn.prepare("SELECT provider FROM attempts WHERE id=?").get("att_legacy");
  assert.equal(legacyAtt.provider, null, "legacy attempt.provider is NULL");
  const legacyVd = conn.prepare("SELECT judge_provider FROM verdicts WHERE id=?").get("vd_legacy");
  assert.equal(legacyVd.judge_provider, null, "legacy verdict.judge_provider is NULL");

  closeDb();

  // Second open — must be idempotent (same table_info, no error).
  setDbPath(dbPath);
  conn = db();
  const attemptCols2 = cols(conn, "attempts");
  const verdictCols2 = cols(conn, "verdicts");
  assert.deepEqual(attemptCols2, attemptCols1, "attempts table_info unchanged on re-migrate (idempotent)");
  assert.deepEqual(verdictCols2, verdictCols1, "verdicts table_info unchanged on re-migrate (idempotent)");
  closeDb();

  console.log("✓ provider-columns.unit.mjs: additive migration + idempotency verified");
}

main().catch((err) => {
  console.error("✗ provider-columns.unit.mjs failed:", err);
  process.exit(1);
});
