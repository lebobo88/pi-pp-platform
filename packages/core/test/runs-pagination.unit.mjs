// Unit test for listRuns cursor (keyset) pagination.
//
// Covers:
//  - Envelope shape: {items, next_cursor} with next_cursor null on the
//    last page / short listings.
//  - Page-2 continuity: following next_cursor yields the next rows with
//    no duplicates and no gaps, in the same order as one big listing.
//  - Tie on started_at: rows sharing a timestamp are ordered by id DESC
//    and a page boundary inside the tie loses/repeats nothing.
//  - Filters (project_path) compose with the cursor.
//  - A malformed cursor is ignored (first page) instead of throwing.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-runs-page-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
// Prevent a live PP_DB_PATH from overriding the isolated test database.
delete process.env.PP_DB_PATH;
process.env.PP_SKIP_CLI_VERSIONS = "1";
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

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

const { db } = await importDist("db/database.js");
const runs = await importDist("orchestrator/runs.js");

let seq = 0;
function insertRun({ id, project_path, started_at, status = "complete" }) {
  db()
    .prepare(
      `INSERT INTO runs(id, project_path, request_text, mode, status, started_at)
       VALUES (?, ?, ?, 'single', ?, ?)`
    )
    .run(id ?? `run_seed_${String(++seq).padStart(3, "0")}`, project_path, "pagination seed", status, started_at);
}

const PROJ_A = join(SUITE_DIR, "proj-a");
const PROJ_B = join(SUITE_DIR, "proj-b");

// 7 runs with strictly distinct started_at (newest = t07).
for (let i = 1; i <= 7; i++) {
  insertRun({
    id: `run_distinct_${String(i).padStart(2, "0")}`,
    project_path: PROJ_A,
    started_at: `2026-07-01T00:00:${String(i).padStart(2, "0")}.000Z`,
  });
}
// 4 runs tied on the same started_at, newer than everything above.
for (const suffix of ["aa", "bb", "cc", "dd"]) {
  insertRun({
    id: `run_tie_${suffix}`,
    project_path: PROJ_A,
    started_at: "2026-07-02T12:00:00.000Z",
  });
}
// A different project, newest of all — must never appear under the PROJ_A filter.
insertRun({ id: "run_other_project", project_path: PROJ_B, started_at: "2026-07-03T00:00:00.000Z" });

await record("envelope shape and full ordering (started_at DESC, id DESC)", async () => {
  const page = runs.listRuns({ project_path: PROJ_A });
  assert.ok(Array.isArray(page.items), "items is an array");
  assert.equal(page.next_cursor, null, "single short page has no next_cursor");
  assert.equal(page.items.length, 11);
  const ids = page.items.map((r) => r.id);
  assert.deepEqual(ids.slice(0, 4), ["run_tie_dd", "run_tie_cc", "run_tie_bb", "run_tie_aa"], "ties order by id DESC");
  assert.equal(ids[4], "run_distinct_07", "distinct timestamps order newest-first");
  assert.equal(ids[10], "run_distinct_01");
});

await record("page-2 continuity: no duplicates, no gaps", async () => {
  const full = runs.listRuns({ project_path: PROJ_A }).items.map((r) => r.id);
  const seen = [];
  let cursor;
  let pages = 0;
  for (;;) {
    const page = runs.listRuns({ project_path: PROJ_A, limit: 3, cursor });
    pages++;
    assert.ok(page.items.length <= 3, "page never exceeds limit");
    seen.push(...page.items.map((r) => r.id));
    if (!page.next_cursor) break;
    assert.equal(page.items.length, 3, "a page with a next_cursor is full");
    cursor = page.next_cursor;
    assert.ok(pages < 20, "pagination terminates");
  }
  assert.equal(pages, 4, "11 rows at limit 3 → 4 pages");
  assert.deepEqual(seen, full, "concatenated pages equal the one-shot listing (no dup, no gap)");
  assert.equal(new Set(seen).size, seen.length, "no id repeats across pages");
});

await record("page boundary inside a started_at tie", async () => {
  // limit=2 puts the boundary between run_tie_cc and run_tie_bb.
  const p1 = runs.listRuns({ project_path: PROJ_A, limit: 2 });
  assert.deepEqual(p1.items.map((r) => r.id), ["run_tie_dd", "run_tie_cc"]);
  assert.ok(p1.next_cursor, "more rows remain");
  const p2 = runs.listRuns({ project_path: PROJ_A, limit: 2, cursor: p1.next_cursor });
  assert.deepEqual(p2.items.map((r) => r.id), ["run_tie_bb", "run_tie_aa"], "tie continues by id DESC");
  const p3 = runs.listRuns({ project_path: PROJ_A, limit: 2, cursor: p2.next_cursor });
  assert.deepEqual(p3.items.map((r) => r.id), ["run_distinct_07", "run_distinct_06"], "crosses out of the tie");
});

await record("cursor is opaque base64url of \"<started_at>|<id>\"", async () => {
  const p1 = runs.listRuns({ project_path: PROJ_A, limit: 1 });
  const decoded = Buffer.from(p1.next_cursor, "base64url").toString("utf8");
  assert.equal(decoded, "2026-07-02T12:00:00.000Z|run_tie_dd");
});

await record("filters compose with the cursor; other projects never bleed in", async () => {
  const seen = [];
  let cursor;
  for (;;) {
    const page = runs.listRuns({ project_path: PROJ_A, limit: 4, cursor });
    seen.push(...page.items.map((r) => r.project_path));
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  assert.equal(seen.length, 11);
  assert.ok(seen.every((p) => p === PROJ_A), "project filter holds on every page");
});

await record("malformed cursor is ignored (first page, no throw)", async () => {
  const bad = runs.listRuns({ project_path: PROJ_A, limit: 2, cursor: "not-a-cursor" });
  assert.deepEqual(bad.items.map((r) => r.id), ["run_tie_dd", "run_tie_cc"]);
  const empty = runs.listRuns({ project_path: PROJ_A, limit: 2, cursor: "" });
  assert.equal(empty.items.length, 2, "empty cursor treated as absent");
});

await record("default limit 50 / max 500 preserved", async () => {
  const def = runs.listRuns({});
  assert.equal(def.items.length, 12, "all rows fit under the default 50");
  assert.equal(def.next_cursor, null);
  const clamped = runs.listRuns({ limit: 100000 });
  assert.equal(clamped.items.length, 12, "oversized limit clamps instead of erroring");
});

await record("non-finite limit falls back to the default (GET /runs?limit=abc must not 500)", async () => {
  // Number("abc") → NaN used to reach the SQL LIMIT bind as NULL → SQLite
  // datatype mismatch. Non-finite values now take the default instead.
  const nan = runs.listRuns({ limit: Number("abc") });
  assert.equal(nan.items.length, 12, "NaN limit behaves like the default");
  assert.equal(nan.next_cursor, null);
  const inf = runs.listRuns({ limit: Infinity });
  assert.equal(inf.items.length, 12, "Infinity limit behaves like the default");
  const frac = runs.listRuns({ limit: 2.5 });
  assert.equal(frac.items.length, 2, "fractional limit truncates to an integer");
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
