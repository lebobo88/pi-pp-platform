// Unit tests for deterministic verdict derivation from judge scores.
//
// Covers (base requirements):
//  - band boundaries: every dim >= 0.7 -> pass; any dim < 0.5 -> fail; else revise
//  - clamping values into [0,1]
//  - pseudo-dimension stripping (underscore-prefixed keys, e.g. _cross_vendor)
//  - non-numeric / non-finite entries dropped
//  - null when no numeric dimensions survive sanitation
//  - disagreement recording via resolveVerdict (harness note appended)
//
// Covers (the two prior cross-vendor review findings):
//  (A) fallback branch (derivation returns null) STILL persists a sanitized map
//  (B) the sanitized flat per-dimension map is what resolveVerdict persists —
//      pseudo-dims/non-numeric stripped, real dims kept as a flat map
//
// Self-contained: pure functions, no daemon, no DB, no live LLM calls.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { deriveOutcomeFromScores, sanitizeDimensionScores, resolveVerdict } =
  await importDist("orchestrator/derive-outcome.js");

let passed = 0;
let failed = 0;

function record(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => { console.log(`✓ ${name}`); passed++; },
      (err) => { console.error(`✗ ${name}\n  ${err.message}`); failed++; },
    );
}

// ── bands ────────────────────────────────────────────────────────────────────
await record("every dim >= 0.7 -> pass", async () => {
  assert.equal(deriveOutcomeFromScores({ a: 0.7, b: 0.9, c: 1 }), "pass");
});

await record("boundary: exactly 0.7 is a pass signal (>=)", async () => {
  assert.equal(deriveOutcomeFromScores({ a: 0.7 }), "pass");
});

await record("any dim < 0.5 -> fail (even with a passing dim present)", async () => {
  assert.equal(deriveOutcomeFromScores({ a: 0.95, b: 0.49 }), "fail");
});

await record("boundary: exactly 0.5 is NOT a fail (>= 0.5), lands in revise band", async () => {
  assert.equal(deriveOutcomeFromScores({ a: 0.5 }), "revise");
});

await record("mid band [0.5,0.7) -> revise", async () => {
  assert.equal(deriveOutcomeFromScores({ a: 0.6, b: 0.8 }), "revise");
});

await record("pass-band vs revise: a 0.55 dim with an otherwise-passing map -> revise", async () => {
  assert.equal(deriveOutcomeFromScores({ correctness: 0.9, minimality: 0.55 }), "revise");
});

// ── clamping ──────────────────────────────────────────────────────────────────
await record("clamps out-of-range values into [0,1] before banding", async () => {
  // 1.5 -> 1 (pass signal), -0.2 -> 0 (fail signal) => fail wins.
  assert.equal(deriveOutcomeFromScores({ a: 1.5, b: -0.2 }), "fail");
  assert.deepEqual(sanitizeDimensionScores({ a: 1.5, b: -0.2, c: 0.4 }), { a: 1, b: 0, c: 0.4 });
});

await record("above-range only -> all clamp to 1 -> pass", async () => {
  assert.equal(deriveOutcomeFromScores({ a: 3, b: 2 }), "pass");
});

// ── pseudo-dimension + non-numeric stripping ─────────────────────────────────
await record("strips underscore-prefixed pseudo-dimensions (e.g. _cross_vendor)", async () => {
  assert.deepEqual(
    sanitizeDimensionScores({ correctness: 0.8, _cross_vendor: 1, _notes: 0.1 }),
    { correctness: 0.8 },
  );
  // _cross_vendor=1 must NOT count toward the pass math.
  assert.equal(deriveOutcomeFromScores({ correctness: 0.6, _cross_vendor: 1 }), "revise");
});

await record("drops non-numeric and non-finite entries", async () => {
  assert.deepEqual(
    sanitizeDimensionScores({ a: 0.8, b: "high", c: null, d: NaN, e: Infinity, f: {} }),
    { a: 0.8 },
  );
});

await record("non-object input yields an empty map (never throws)", async () => {
  assert.deepEqual(sanitizeDimensionScores(null), {});
  assert.deepEqual(sanitizeDimensionScores(undefined), {});
  assert.deepEqual(sanitizeDimensionScores([0.9, 0.8]), {});
  assert.deepEqual(sanitizeDimensionScores("nope"), {});
});

// ── null when empty ──────────────────────────────────────────────────────────
await record("null when no numeric dimensions survive sanitation", async () => {
  assert.equal(deriveOutcomeFromScores({}), null);
  assert.equal(deriveOutcomeFromScores({ _cross_vendor: 1, note: "x" }), null);
  assert.equal(deriveOutcomeFromScores(undefined), null);
});

// ── resolveVerdict: derivation drives the stored outcome ─────────────────────
await record("resolveVerdict uses the derived outcome when derivable", async () => {
  const r = resolveVerdict({ judge_outcome: "pass", scores: { a: 0.4 }, critique_md: "x" });
  assert.equal(r.outcome, "fail", "derived fail overrides the pass label");
  assert.equal(r.derived, true);
  assert.equal(r.disagreed, true);
});

await record("disagreement recording: harness note appended, judge label preserved", async () => {
  const r = resolveVerdict({ judge_outcome: "pass", scores: { correctness: 0.55 }, critique_md: "looks great" });
  assert.equal(r.outcome, "revise");
  assert.equal(r.judge_label, "pass");
  assert.match(r.critique_md, /looks great/);
  assert.match(r.critique_md, /\[harness\] outcome derived from scores; judge label was pass/);
});

await record("agreement: no harness note appended when derived == judge label", async () => {
  const r = resolveVerdict({ judge_outcome: "pass", scores: { a: 0.9, b: 0.8 }, critique_md: "ok" });
  assert.equal(r.outcome, "pass");
  assert.equal(r.disagreed, false);
  assert.equal(r.critique_md, "ok", "critique_md untouched on agreement");
});

// ── FINDING (A): fallback branch STILL persists a sanitized map ──────────────
await record("finding A — fallback (no numeric dims) persists sanitized map + uses judge label", async () => {
  const r = resolveVerdict({
    judge_outcome: "pass",
    // Only pseudo/non-numeric entries: derivation returns null.
    scores: { _cross_vendor: 1, note: "n/a", nested: { x: 1 } },
    critique_md: "advisory",
  });
  // Judge label is used because derivation returned null...
  assert.equal(r.outcome, "pass", "judge label used when derivation is null");
  assert.equal(r.derived, false);
  assert.equal(r.disagreed, false, "no disagreement when nothing was derived");
  // ...but the persisted map is STILL sanitized — no underscore/non-numeric junk.
  assert.deepEqual(r.score_json, {}, "unsanitized pseudo-dims must never reach the row");
  assert.ok(!("_cross_vendor" in r.score_json));
  assert.ok(!("note" in r.score_json));
});

// ── FINDING (B): winner verdict persists the sanitized flat dimension map ─────
await record("finding B — score_json is the sanitized flat dimension map (not metadata)", async () => {
  const r = resolveVerdict({
    judge_outcome: "pass",
    // Real dims mixed with a pseudo-dim and an out-of-range value.
    scores: { quality: 1.2, coverage: 0.8, _cross_vendor: 1 },
    critique_md: "Borda winner candidate-1 of 3 (score 1.000). [borda] {\"1\":2}",
  });
  // Flat map the UI iterates: real dims only, clamped, pseudo-dim stripped.
  assert.deepEqual(r.score_json, { quality: 1, coverage: 0.8 });
  // Borda metadata is preserved in critique_md, not at the expense of the map.
  assert.match(r.critique_md, /\[borda\]/);
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
