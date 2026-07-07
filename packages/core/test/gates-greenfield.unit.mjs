// Unit tests for R7: greenfield-aware rubric selection in evaluateGate /
// pickDefaultRubric, plus the well-formedness of the compiled-in
// `code-greenfield@1` rubric registry entry.
//
// Covers:
//   - a code gate on a greenfield run binds code-greenfield@1 (instead of the
//     null → minimality-bearing fallback)
//   - a non-greenfield code gate still binds the existing default (null)
//   - an explicit rubric_hint still wins over the greenfield swap
//   - greenfield never perturbs a gate that already binds a specific rubric
//     (security/spec) — binding stays byte-identical
//   - the code-greenfield@1 entry is well-formed via listRubrics / getRubric
//
// Pure functions, no daemon, no DB, no LLM. Runs against the compiled dist/.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

// Defensive PP_HOME isolation, mirroring gemini-disable.unit.mjs.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-gates-greenfield-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
delete process.env.PP_DB_PATH;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { evaluateGate } = await importDist("orchestrator/gates.js");
const { getRubric, listRubrics } = await importDist("rubrics/registry.js");

// ─── GREENFIELD RUBRIC SELECTION ─────────────────────────────────────────────

test("greenfield: a code_style gate binds code-greenfield@1", () => {
  const d = evaluateGate({ gate_type: "code_style", greenfield: true });
  assert.equal(d.rubric_id, "code-greenfield@1");
});

test("greenfield: a lint_class gate also binds code-greenfield@1", () => {
  const d = evaluateGate({ gate_type: "lint_class", greenfield: true });
  assert.equal(d.rubric_id, "code-greenfield@1");
});

test("non-greenfield: a code_style gate binds the existing default (null)", () => {
  const d = evaluateGate({ gate_type: "code_style", greenfield: false });
  assert.equal(d.rubric_id, null);
  // …and byte-identical to omitting the flag entirely.
  assert.equal(evaluateGate({ gate_type: "code_style" }).rubric_id, null);
});

test("greenfield: an explicit rubric_hint still wins over the swap", () => {
  const d = evaluateGate({
    gate_type: "code_style",
    greenfield: true,
    rubric_hint: "game-perf-budget@1",
  });
  assert.equal(d.rubric_id, "game-perf-budget@1", "explicit hint must win");
});

test("greenfield: a gate that already binds a specific rubric is unchanged", () => {
  // security always binds owasp; spec always binds rfc-2119. The greenfield
  // swap only touches the null (code) default, so these stay byte-identical.
  assert.equal(evaluateGate({ gate_type: "security", greenfield: true }).rubric_id, "owasp-asvs-l1@1");
  assert.equal(evaluateGate({ gate_type: "security", greenfield: false }).rubric_id, "owasp-asvs-l1@1");
  assert.equal(evaluateGate({ gate_type: "spec", greenfield: true }).rubric_id, "rfc-2119-normative@1");
});

// ─── RUBRIC REGISTRY WELL-FORMEDNESS ─────────────────────────────────────────

test("code-greenfield@1 is a well-formed registry entry", () => {
  const r = getRubric("code-greenfield@1");
  assert.ok(r, "getRubric must resolve code-greenfield@1");
  assert.equal(r.id, "code-greenfield@1");
  assert.equal(r.version, "1");
  assert.equal(r.kind, "code_style");
  assert.ok(typeof r.title === "string" && r.title.length > 0);
  assert.ok(typeof r.source_url === "string" && /^https?:\/\//.test(r.source_url));
  // The three greenfield dimensions are scored (each defined as a `- **dim**:`
  // bullet); minimality may appear in prose but must NOT be a scored dimension.
  for (const dim of ["correctness", "completeness", "scope_fidelity"]) {
    assert.ok(r.markdown.includes(`- **${dim}**`), `markdown must define the ${dim} scored dimension`);
  }
  assert.ok(!/-\s+\*\*minimality\*\*/.test(r.markdown), "greenfield rubric must not score minimality as a dimension");
  // The standard outcome envelope (>=0.7 pass; [0.5,0.7) revise; <0.5 fail).
  assert.ok(r.markdown.includes("0.7"));
  assert.ok(/0\.5/.test(r.markdown));
});

test("listRubrics surfaces code-greenfield@1 in its summary form", () => {
  const summary = listRubrics().find((x) => x.id === "code-greenfield@1");
  assert.ok(summary, "listRubrics must include code-greenfield@1");
  assert.equal(summary.kind, "code_style");
  assert.equal(summary.version, "1");
  // listRubrics is the summary projection — no markdown body leaks through.
  assert.equal(summary.markdown, undefined);
});
