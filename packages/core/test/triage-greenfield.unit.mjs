// Unit tests for R5 triage: the greenfield scope floor and the bounded (±1,
// never-below-floor) LLM-refinement helpers.
//
// Covers:
//   - greenfield "create … app" + near-empty dir → floored to `standard`,
//     signal recorded; established repos (non-empty dir) left unchanged
//   - boundRefinedScope clamps a suggestion to ±1 of the heuristic anchor and
//     never below the floor
//   - parseScopeSuggestion extracts a scope word or returns null
//
// Self-contained: pure functions, no daemon, no DB, no LLM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { heuristicTriage, boundRefinedScope, parseScopeSuggestion } =
  await importDist("orchestrator/taxonomy.js");

// ─── GREENFIELD FLOOR ────────────────────────────────────────────────────────

test("greenfield: 'create … app' + near-empty dir floors a trivial score to standard", () => {
  // diff_loc<=20 (-1) + files<=1 (-1) => score -2 => would be trivial…
  const r = heuristicTriage({
    request_text: "create a snake game app",
    diff_loc: 5,
    files_touched: 1,
    near_empty_dir: true,
  });
  assert.equal(r.scope, "standard", "greenfield build must never be trivial");
  assert.equal(r.floor, "standard");
  assert.ok(r.signals.includes("greenfield-build"));
  assert.ok(r.signals.some((s) => s.includes("greenfield-floor:trivial->standard")));
});

test("greenfield: an established (non-empty) repo is left unchanged — no floor", () => {
  const r = heuristicTriage({
    request_text: "create a snake game app",
    diff_loc: 5,
    files_touched: 1,
    near_empty_dir: false,
  });
  assert.equal(r.scope, "trivial", "established repo keeps the heuristic trivial score");
  assert.equal(r.floor, "trivial");
  assert.ok(!r.signals.includes("greenfield-build"));
});

test("greenfield: a non-greenfield request on an empty dir does not floor", () => {
  const r = heuristicTriage({
    request_text: "fix a typo in the readme",
    diff_loc: 5,
    files_touched: 1,
    near_empty_dir: true,
  });
  assert.equal(r.scope, "trivial");
  assert.equal(r.floor, "trivial");
});

// ─── BOUNDED ±1 REFINEMENT ───────────────────────────────────────────────────

test("boundRefinedScope: one step up/down from the anchor is allowed", () => {
  assert.equal(boundRefinedScope("standard", "major"), "major");
  assert.equal(boundRefinedScope("standard", "trivial"), "trivial");
});

test("boundRefinedScope: a two-step jump is clamped to ±1 of the anchor", () => {
  assert.equal(boundRefinedScope("trivial", "major"), "standard", "trivial→major clamps to +1");
  assert.equal(boundRefinedScope("major", "trivial"), "standard", "major→trivial clamps to -1");
});

test("boundRefinedScope: never drops below the floor", () => {
  assert.equal(boundRefinedScope("standard", "trivial", "standard"), "standard",
    "floor=standard blocks the downgrade");
  assert.equal(boundRefinedScope("major", "trivial", "standard"), "standard",
    "clamp lands at standard, floor also standard");
});

test("parseScopeSuggestion: extracts a scope word, else null", () => {
  assert.equal(parseScopeSuggestion("I judge this a MAJOR change"), "major");
  assert.equal(parseScopeSuggestion("this is standard work"), "standard");
  assert.equal(parseScopeSuggestion("no clear verdict here"), null);
});
