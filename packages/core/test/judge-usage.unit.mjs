// v9 judge-usage cost attribution (CORE).
//
// Covers:
//  - recordVerdict WITH usage credits the run:/day:/model:<judge_model_id>
//    budget scopes and persists tokens_in/tokens_out/cost_usd on the row.
//  - recordVerdict WITHOUT usage fields creates NO budget rows (byte-for-byte
//    legacy behavior) and stores NULL usage columns.
//  - recordVerdict with explicit ZERO usage creates NO budget rows.
//  - tallyJudgeUsage credits scopes without a verdict row; no-usage is a no-op.
//  - v8→v9 migration adds tokens_in/tokens_out/cost_usd to an existing verdicts
//    table idempotently, AND a fresh DB gets them from CREATE TABLE.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-judge-usage-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
delete process.env.PP_DB_PATH; // isolate from any live dev server DB
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";
process.env.PP_SKIP_CLI_VERSIONS = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (rel) => import(pathToFileURL(join(DIST, rel)).href);
const require = createRequire(import.meta.url);

function setupProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-judge-usage-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
  return dir;
}

// A verdict on a fresh Claude attempt, judged cross-vendor by Codex (gpt-5.4).
// The attempt itself is recorded WITHOUT usage so only the judge tally can
// create budget rows — isolating the behavior under test.
async function seedVerdict(runs, project, extra = {}) {
  const run = await runs.ensureRun({ request_text: "judge usage", project_path: project, mode: "single" });
  const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
  const att = runs.recordAttempt({ stage_id: stage.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok" });
  const verdict = runs.recordVerdict({
    attempt_id: att.attempt_id,
    judge_producer: "codex",
    judge_model_id: "gpt-5.4",
    rubric_id: "code-quality@1",
    outcome: "pass",
    ...extra,
  });
  return { run_id: run.run_id, verdict_id: verdict.verdict_id };
}

test("recordVerdict with usage credits run/day/model scopes and persists row", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const { db } = await importDist("db/database.js");
    const { run_id, verdict_id } = await seedVerdict(runs, project, {
      tokens_in: 120,
      tokens_out: 30,
      cost_usd: 0.0042,
    });

    const day = runs.localDayKey();
    const runScope = runs.budgetStatus(`run:${run_id}`);
    const dayScope = runs.budgetStatus(`day:${day}`);
    const modelScope = runs.budgetStatus(`model:gpt-5.4`);

    for (const [label, row] of [["run", runScope], ["day", dayScope], ["model", modelScope]]) {
      assert.ok(row, `${label} scope row exists`);
      assert.equal(row.tokens_in, 120, `${label} tokens_in`);
      assert.equal(row.tokens_out, 30, `${label} tokens_out`);
      assert.ok(Math.abs(row.cost_usd - 0.0042) < 1e-9, `${label} cost_usd`);
    }

    const vd = db().prepare("SELECT tokens_in, tokens_out, cost_usd FROM verdicts WHERE id=?").get(verdict_id);
    assert.equal(vd.tokens_in, 120, "verdict.tokens_in persisted");
    assert.equal(vd.tokens_out, 30, "verdict.tokens_out persisted");
    assert.ok(Math.abs(vd.cost_usd - 0.0042) < 1e-9, "verdict.cost_usd persisted");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("recordVerdict without usage creates no budget rows and stores NULL usage", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const { db } = await importDist("db/database.js");
    const { run_id, verdict_id } = await seedVerdict(runs, project);

    // Assert on the per-run scope (unique to this test) — the model: scope is
    // shared across tests, so it can't prove "no rows" on its own.
    assert.equal(runs.budgetStatus(`run:${run_id}`), null, "no run scope row");

    const vd = db().prepare("SELECT tokens_in, tokens_out, cost_usd FROM verdicts WHERE id=?").get(verdict_id);
    assert.equal(vd.tokens_in, null, "verdict.tokens_in NULL");
    assert.equal(vd.tokens_out, null, "verdict.tokens_out NULL");
    assert.equal(vd.cost_usd, null, "verdict.cost_usd NULL");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("recordVerdict with zero usage creates no budget rows", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const { run_id } = await seedVerdict(runs, project, { tokens_in: 0, tokens_out: 0, cost_usd: 0 });
    assert.equal(runs.budgetStatus(`run:${run_id}`), null, "zero usage → no run scope row");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("tallyJudgeUsage credits scopes without a verdict row; no-usage is a no-op", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const run = await runs.ensureRun({ request_text: "loser tally", project_path: project, mode: "best_of" });

    // No-op: undefined / zero usage creates nothing.
    runs.tallyJudgeUsage(run.run_id, "gpt-5.4-loser", {});
    runs.tallyJudgeUsage(run.run_id, "gpt-5.4-loser", { tokens_in: 0, cost_usd: 0 });
    assert.equal(runs.budgetStatus(`model:gpt-5.4-loser`), null, "no-op leaves no model row");
    assert.equal(runs.budgetStatus(`run:${run.run_id}`), null, "no-op leaves no run row");

    // Positive usage credits run/day/model scopes.
    runs.tallyJudgeUsage(run.run_id, "gpt-5.4-loser", { tokens_in: 5, tokens_out: 7 });
    const modelScope = runs.budgetStatus(`model:gpt-5.4-loser`);
    assert.ok(modelScope, "model scope credited");
    assert.equal(modelScope.tokens_in, 5, "loser tokens_in");
    assert.equal(modelScope.tokens_out, 7, "loser tokens_out");
    assert.equal(modelScope.cost_usd, 0, "loser cost_usd defaults to 0");
    assert.ok(runs.budgetStatus(`run:${run.run_id}`), "run scope credited");
    assert.ok(runs.budgetStatus(`day:${runs.localDayKey()}`), "day scope credited");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("v8→v9 migration adds verdict usage columns idempotently; fresh DB has them", async () => {
  const { setDbPath, db, closeDb } = await importDist("db/database.js");
  const Database = require("better-sqlite3");

  const cols = (conn, table) =>
    conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).sort();

  // Seed a pre-v9 DB: a verdicts table WITHOUT tokens_in/tokens_out/cost_usd.
  const dbPath = join(mkdtempSync(join(tmpdir(), "pp-judge-usage-mig-")), "state.db");
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, request_text TEXT NOT NULL,
      team TEXT, mode TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT);
    CREATE TABLE stages (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT, gate_type TEXT, status TEXT, started_at TEXT);
    CREATE TABLE attempts (id TEXT PRIMARY KEY, stage_id TEXT NOT NULL, producer TEXT, model_id TEXT,
      retry_index INTEGER NOT NULL DEFAULT 0, parent_attempt_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE verdicts (id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, judge_producer TEXT,
      judge_model_id TEXT, rubric_id TEXT, outcome TEXT NOT NULL, critique_md TEXT, score_json TEXT,
      cross_vendor INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  `);
  seed.prepare("INSERT INTO verdicts (id,attempt_id,judge_producer,judge_model_id,outcome,cross_vendor,created_at) VALUES (?,?,?,?,?,?,?)")
    .run("vd_legacy", "att_legacy", "openai", "gpt-4o", "pass", 1, new Date().toISOString());
  assert.ok(!cols(seed, "verdicts").includes("tokens_in"), "seed: verdicts.tokens_in absent");
  assert.ok(!cols(seed, "verdicts").includes("cost_usd"), "seed: verdicts.cost_usd absent");
  seed.close();

  try {
    // First open — migration runs.
    setDbPath(dbPath);
    let conn = db();
    const post1 = cols(conn, "verdicts");
    for (const c of ["tokens_in", "tokens_out", "cost_usd"]) {
      assert.ok(post1.includes(c), `post-migrate: verdicts.${c} present`);
    }
    // Legacy row preserved with NULL usage.
    const legacy = conn.prepare("SELECT tokens_in, tokens_out, cost_usd FROM verdicts WHERE id=?").get("vd_legacy");
    assert.equal(legacy.tokens_in, null, "legacy verdict.tokens_in NULL");
    assert.equal(legacy.cost_usd, null, "legacy verdict.cost_usd NULL");
    closeDb();

    // Second open — idempotent (identical table_info).
    setDbPath(dbPath);
    conn = db();
    assert.deepEqual(cols(conn, "verdicts"), post1, "verdicts table_info unchanged on re-migrate");
    closeDb();

    // Fresh DB — columns come from CREATE TABLE, not ALTER.
    const freshPath = join(mkdtempSync(join(tmpdir(), "pp-judge-usage-fresh-")), "state.db");
    setDbPath(freshPath);
    conn = db();
    const fresh = cols(conn, "verdicts");
    for (const c of ["tokens_in", "tokens_out", "cost_usd"]) {
      assert.ok(fresh.includes(c), `fresh DB: verdicts.${c} present from CREATE TABLE`);
    }
    closeDb();
  } finally {
    // Restore suite DB path so this test doesn't leak the override.
    setDbPath(join(SUITE_DIR, ".pair-programmer", "state.db"));
  }
});
