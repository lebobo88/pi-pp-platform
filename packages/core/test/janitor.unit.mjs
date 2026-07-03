// Janitor two-phase sweep (A6). Runs against compiled dist/.
//
// (1) dirSizeBytes: >0 for a non-empty dir, 0 for an empty one, cap respected.
// (2) Fixture project (git repo + stale pp/ worktree + stale lock + stale
//     `running` run): dry_run returns the full plan WITHOUT mutating anything,
//     and its entries match the subsequent real run's entries.
// (3) Real run sweeps worktree/branch/lock, marks the run crashed, reports
//     reclaimed_bytes>0, and persists the report (getJanitorReport survives a
//     db close/reopen).

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

process.env.PP_SKIP_CLI_VERSIONS = "1";
process.env.PP_HOME = mkdtempSync(join(tmpdir(), "pp-janitor-home-"));

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (rel) => import(pathToFileURL(join(DIST, rel)).href);

const HOURS = 60 * 60 * 1000;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function backdate(path, ms) {
  const t = new Date(Date.now() - ms);
  utimesSync(path, t, t);
}

async function testDirSizeBytes() {
  const { dirSizeBytes } = await importDist("orchestrator/janitor.js");

  const empty = mkdtempSync(join(tmpdir(), "pp-jan-empty-"));
  assert.equal(dirSizeBytes(empty), 0, "empty dir sizes to 0");

  const full = mkdtempSync(join(tmpdir(), "pp-jan-full-"));
  mkdirSync(join(full, "nested"), { recursive: true });
  writeFileSync(join(full, "a.txt"), "x".repeat(1000));
  writeFileSync(join(full, "nested", "b.txt"), "y".repeat(500));
  assert.equal(dirSizeBytes(full), 1500, "recursive size sums nested files");
  assert.ok(dirSizeBytes(full, 2) < 1500, "maxEntries cap bails out early");
  assert.equal(dirSizeBytes(join(full, "does-not-exist")), 0, "missing path sizes to 0");

  console.log("✓ dirSizeBytes: recursive walk with bail-out cap");
}

async function testDryRunThenRealRun() {
  const { setDbPath, db, closeDb } = await importDist("db/database.js");
  const janitor = await importDist("orchestrator/janitor.js");

  const dbPath = join(mkdtempSync(join(tmpdir(), "pp-jan-db-")), "state.db");
  setDbPath(dbPath);

  // Fixture git project with a stale pp/ candidate worktree.
  const proj = mkdtempSync(join(tmpdir(), "pp-jan-proj-"));
  git(["init", "-q"], proj);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], proj);
  const wtPath = join(mkdtempSync(join(tmpdir(), "pp-jan-wt-")), "cand");
  git(["worktree", "add", "-q", "-b", "pp/test-sweep", wtPath], proj);
  writeFileSync(join(wtPath, "artifact.txt"), "z".repeat(2048));
  backdate(wtPath, 10 * HOURS);

  // Stale project lock (dead-pid metadata + old mtime).
  const lockPath = join(proj, ".harness", ".lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: 999999999, started_at: new Date(Date.now() - 10 * HOURS).toISOString() }));
  backdate(lockPath, 10 * HOURS);

  // Stale `running` run row (registers the project for the sweep loop).
  const startedAt = new Date(Date.now() - 10 * HOURS).toISOString();
  db().prepare("INSERT INTO runs (id, project_path, request_text, mode, status, started_at) VALUES (?,?,?,?,?,?)")
    .run("run_stale", proj, "stale run", "single", "running", startedAt);

  // ── dry_run: full plan, nothing mutated. ──
  const dry = janitor.runJanitor({ dry_run: true });
  assert.equal(dry.dry_run, true);
  assert.equal(dry.swept, 0, "dry_run sweeps nothing");
  assert.equal(dry.reclaimed_bytes, 0, "dry_run reclaims nothing");
  assert.deepEqual(dry.crashed_runs, ["run_stale"], "dry_run plans the stale run");

  const kinds = dry.entries.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ["branch", "lock", "run", "worktree"], "plan covers all four kinds");
  const wtEntry = dry.entries.find((e) => e.kind === "worktree");
  assert.ok(wtEntry.bytes >= 2048, "worktree entry carries bytes>0 for a non-empty dir");
  assert.ok(wtEntry.age_days > 0.3, "worktree entry carries age_days");
  const branchEntry = dry.entries.find((e) => e.kind === "branch");
  assert.equal(branchEntry.path, "pp/test-sweep");

  assert.ok(existsSync(wtPath), "dry_run leaves the worktree intact");
  assert.ok(existsSync(lockPath), "dry_run leaves the lock intact");
  assert.equal(db().prepare("SELECT status FROM runs WHERE id='run_stale'").get().status, "running",
    "dry_run leaves the run status intact");
  assert.equal(janitor.getJanitorReport(), null, "dry_run does not persist a report");

  // ── real run: executes the same plan. ──
  const real = janitor.runJanitor();
  assert.equal(real.dry_run, false);
  assert.deepEqual(real.entries, dry.entries, "real run entries match the dry_run plan");
  assert.deepEqual(real.crashed_runs, ["run_stale"]);
  assert.equal(real.swept, real.entries.length, "every planned entry swept");
  assert.ok(real.reclaimed_bytes >= 2048, "reclaimed_bytes counts the swept worktree");

  assert.ok(!existsSync(wtPath), "worktree removed");
  assert.ok(!existsSync(lockPath), "lock removed");
  assert.equal(git(["branch", "--list", "pp/test-sweep"], proj).trim(), "", "branch deleted");
  assert.equal(db().prepare("SELECT status FROM runs WHERE id='run_stale'").get().status, "crashed",
    "stale run marked crashed");

  // ── report persisted and re-readable across a db reopen. ──
  assert.deepEqual(janitor.getJanitorReport(), real, "getJanitorReport returns the persisted report");
  closeDb();
  setDbPath(dbPath);
  assert.deepEqual(janitor.getJanitorReport(), real, "report survives close/reopen");

  // A second real run finds nothing left to sweep.
  const idle = janitor.runJanitor();
  assert.deepEqual(idle.entries, [], "second pass has an empty plan");
  assert.equal(idle.swept, 0);
  closeDb();

  console.log("✓ janitor: dry_run plan matches real run; sweep + persistence verified");
}

async function main() {
  await testDirSizeBytes();
  await testDryRunThenRealRun();
  console.log("✓ janitor.unit.mjs: all assertions passed");
}

main().catch((err) => {
  console.error("✗ janitor.unit.mjs failed:", err);
  process.exit(1);
});
