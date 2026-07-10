/**
 * Shared E2E test helpers: a temp git project, and a scripted engine that wraps
 * the deterministic fake so a fixture plan can drive verdict outcomes and
 * evidence-rich authoring content.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine, toGenProvider, type Engine, type GenResult } from "@pp/engine";
import type { VerdictOutcome } from "@pp/core";

function commit(cwd: string, message: string): void {
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@pp.local", "-c", "user.name=pp-test", ...args], { cwd, stdio: "ignore" });
  git(["add", "-A"]);
  git(["commit", "-q", "-m", message]);
}

/** A fresh git repo with one commit so HEAD exists. */
export function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-pilot-proj-"));
  const git = (args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@pp.local", "-c", "user.name=pp-test", ...args], {
      cwd: dir,
      stdio: "ignore",
    });
  git(["init", "-q"]);
  writeFileSync(join(dir, "README.md"), "# temp project\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  return dir;
}

/** Evidence-rich authoring content so missability's required checks pass. */
const RICH_CONTENT =
  "# Artifact\n\n" +
  "## Non-functional requirements\n" +
  "Targets: latency p95 < 200ms, throughput, availability/SLO 99.9%, RTO/RPO defined, cost budget capped.\n\n" +
  "## Test data management\n" +
  "Uses fixtures and seed data with masking / synthetic data for anonymization.\n\n" +
  "## Decisions\n" +
  "ADR: decision rationale recorded; tradeoff and alternative considered documented.\n\n" +
  "## Ownership\n" +
  "Docs owner / maintainer: @maintainer.\n";

function genResult(model: { id: string; provider: string }, text: string, parsed?: unknown): GenResult {
  return {
    text,
    parsed,
    tokens_in: 10,
    tokens_out: 20,
    cost_usd: 0.001,
    model: model.id,
    provider: toGenProvider(model.provider),
    wall_ms: 1,
    session_id: null,
    stop_reason: "stop",
  };
}

export type ScriptedEngine = Engine & {
  critiquesConsumed: () => number;
  /** Judge model id used on each critique call, in call order. */
  judgeModelsUsed: () => string[];
};

/** A GenResult that mimics pi resolving (never rejecting) a provider quota /
 * rate-limit failure: empty text, additive error_class/error_message set. Used
 * by tests to script an error-resolving completion or coding session. */
export function makeErrorGenResult(
  model: { id: string; provider: string },
  errorClass: "quota_exhausted" | "rate_limited" | "provider_error",
  errorMessage: string,
  extra: Partial<GenResult> = {},
): GenResult {
  return {
    text: "",
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    model: model.id,
    provider: toGenProvider(model.provider),
    wall_ms: 1,
    session_id: null,
    stop_reason: "error",
    error_class: errorClass,
    error_message: errorMessage,
    ...extra,
  };
}

/** Normalize invalidAt/critiqueErrorAt (number | number[]) to a membership test. */
function atSet(v: number | number[] | undefined): (i: number) => boolean {
  if (v === undefined) return () => false;
  const s = new Set(Array.isArray(v) ? v : [v]);
  return (i) => s.has(i);
}

/**
 * Wrap the fake engine: authoring completions return evidence-rich content, and
 * critiques dequeue outcomes from `verdictPlan` in call order. `invalidAt`
 * critique calls return an invalid_output result (judge-halt path);
 * `critiqueErrorAt` calls return a provider_error result (judge-failover path).
 * Each accepts a single index or a list. The judge model used on every critique
 * call is recorded so tests can assert the failover ORDER.
 */
export function makeScriptedEngine(opts: {
  verdictPlan: VerdictOutcome[];
  invalidAt?: number | number[];
  critiqueErrorAt?: number | number[];
}): ScriptedEngine {
  const fake = createEngine({ mode: "fake" });
  let critiqueIdx = 0;
  const judgeModels: string[] = [];
  const isInvalid = atSet(opts.invalidAt);
  const isError = atSet(opts.critiqueErrorAt);

  return {
    ...fake,
    critiquesConsumed: () => critiqueIdx,
    judgeModelsUsed: () => judgeModels.slice(),
    runAuthoringCompletion: async (o) => genResult(o.model, RICH_CONTENT),
    critique: async (o) => {
      const idx = critiqueIdx++;
      judgeModels.push(o.judgeModel.id);
      if (isError(idx)) {
        return {
          ...genResult(o.judgeModel, "", undefined),
          stop_reason: "provider_error",
          error_class: "quota_exhausted",
          error_message: `OpenAI API error (429): {"error":{"code":"insufficient_quota"}} #${idx}`,
          session_file: "/tmp/fake-critique-provider-error.txt",
        };
      }
      if (isInvalid(idx)) {
        return {
          ...genResult(o.judgeModel, "not json", undefined),
          stop_reason: "invalid_output",
          session_file: "/tmp/fake-critique-failure.txt",
        };
      }
      const outcome = opts.verdictPlan[idx] ?? "pass";
      const verdict = {
        outcome,
        critique_md: `scripted ${outcome} for critique #${idx}`,
        score: { correctness: outcome === "pass" ? 0.9 : 0.4, minimality: 0.8 },
      };
      return genResult(o.judgeModel, JSON.stringify(verdict), verdict);
    },
  };
}

/**
 * Best-of engine: real fake coding sessions (one committed FAKE_ARTIFACT per
 * candidate worktree) + a critique that scores candidates in descending order
 * of call, so candidate-1 deterministically wins the Borda count.
 */
export function makeBestOfEngine(): Engine {
  const fake = createEngine({ mode: "fake" });
  return {
    ...fake,
    critique: async (o) => {
      // Score by the candidate index embedded in the fake artifact text
      // (FAKE_ARTIFACT_engineer-<index>.md), so candidate-1 deterministically
      // wins regardless of the judge's shuffled evaluation order.
      const m = /engineer-(\d+)/.exec(o.artifactText);
      const idx = m ? Number(m[1]) : 99;
      const score = 1 / idx;
      const verdict = { outcome: "pass", critique_md: `candidate ${idx} score ${score}`, score: { quality: score } };
      return genResult(o.judgeModel, JSON.stringify(verdict), verdict);
    },
  };
}

const TDD_MANIFEST_YAML =
  "tdd_mode: bug-fix\n" +
  "test_runner: vitest\n" +
  "test_command: node run-tests.js\n" +
  "test_files:\n" +
  "  - run-tests.js\n" +
  "expected_pre_outcome: all_fail\n" +
  "expected_post_outcome: all_pass\n" +
  "cited_artifacts:\n" +
  "  - kind: test\n" +
  "    path: run-tests.js\n";

/**
 * TDD engine: the tests_pre completion returns a manifest whose test command
 * (node run-tests.js) is red until an `impl.js` exists; the code coding session
 * writes impl.js and commits, flipping the check green.
 */
export function makeTddEngine(): Engine {
  const fake = createEngine({ mode: "fake" });
  return {
    ...fake,
    runAuthoringCompletion: async (o) => genResult(o.model, TDD_MANIFEST_YAML),
    runCodingSession: async (o) => {
      writeFileSync(join(o.cwd, "impl.js"), "module.exports = () => 'green';\n", "utf8");
      commit(o.cwd, "impl: make the failing test pass");
      return genResult(o.model, "wrote impl.js");
    },
    critique: async (o) => {
      const verdict = { outcome: "pass", critique_md: "ok", score: { correctness: 0.9 } };
      return genResult(o.judgeModel, JSON.stringify(verdict), verdict);
    },
  };
}

/** A temp project seeded with a run-tests.js gate that is red until impl.js exists. */
export function makeTddProject(): string {
  const dir = makeTempProject();
  writeFileSync(
    join(dir, "run-tests.js"),
    "const fs = require('fs');\n" +
      "const ok = fs.existsSync('impl.js');\n" +
      "console.log('Tests  ' + (ok ? '1 passed (1)' : '1 failed (1)'));\n" +
      "process.exit(ok ? 0 : 1);\n",
    "utf8",
  );
  commit(dir, "add failing test gate");
  return dir;
}
