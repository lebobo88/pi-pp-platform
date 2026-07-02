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

export type ScriptedEngine = Engine & { critiquesConsumed: () => number };

/**
 * Wrap the fake engine: authoring completions return evidence-rich content, and
 * critiques dequeue outcomes from `verdictPlan` in call order. When
 * `invalidAt` is set, that critique call (0-based) returns an invalid_output
 * result to exercise the judge-halt path.
 */
export function makeScriptedEngine(opts: {
  verdictPlan: VerdictOutcome[];
  invalidAt?: number;
}): ScriptedEngine {
  const fake = createEngine({ mode: "fake" });
  let critiqueIdx = 0;

  return {
    ...fake,
    critiquesConsumed: () => critiqueIdx,
    runAuthoringCompletion: async (o) => genResult(o.model, RICH_CONTENT),
    critique: async (o) => {
      const idx = critiqueIdx++;
      if (opts.invalidAt === idx) {
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
