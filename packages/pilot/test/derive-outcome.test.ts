import { describe, it, expect } from "vitest";
import { db } from "@pp/core";
import { createEngine, toGenProvider, type Engine, type GenResult } from "@pp/engine";
import { RunPilot, EventBus, type PilotEvent } from "../src/index.js";
import { makeTempProject } from "./helpers.js";

const RICH_CONTENT =
  "# Artifact\n\n## Non-functional requirements\nTargets: latency p95 < 200ms, availability/SLO 99.9%, RTO/RPO defined, cost budget capped.\n\n" +
  "## Test data management\nUses fixtures and seed data with masking / synthetic data for anonymization.\n\n" +
  "## Decisions\nADR: decision rationale recorded; tradeoff and alternative considered documented.\n\n" +
  "## Ownership\nDocs owner / maintainer: @maintainer.\n";

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

/**
 * Scripted critiques by call index. Each entry supplies the judge's self-
 * reported (advisory) label AND its numeric per-dimension scores, so we can
 * inject a "pass label but a sub-0.7 dim" disagreement and prove the harness
 * derives the outcome deterministically from the scores.
 */
function makeScoreScriptedEngine(plan: Array<{ label: string; score: Record<string, number> }>): Engine {
  const fake = createEngine({ mode: "fake" });
  let idx = 0;
  return {
    ...fake,
    runAuthoringCompletion: async (o) => genResult(o.model, RICH_CONTENT),
    critique: async (o) => {
      const step = plan[idx++] ?? { label: "pass", score: { correctness: 0.9 } };
      const verdict = { outcome: step.label, critique_md: `scripted ${step.label}`, score: step.score };
      return genResult(o.judgeModel, JSON.stringify(verdict), verdict);
    },
  };
}

describe("deterministic outcome derivation — pilot stage loop", () => {
  it("pass-label with a 0.55 dim is recorded AND branched as revise (drives Reflexion)", async () => {
    const projectPath = makeTempProject();
    // critique order: spec, code(initial), code(retry), tests, docs.
    // code-initial: judge SAYS pass but a 0.55 dimension -> derived revise.
    const engine = makeScoreScriptedEngine([
      { label: "pass", score: { correctness: 0.9, minimality: 0.8 } }, // spec: real pass
      { label: "pass", score: { correctness: 0.9, minimality: 0.55 } }, // code-initial: disguised revise
      { label: "pass", score: { correctness: 0.9, minimality: 0.85 } }, // code-retry: real pass
      { label: "pass", score: { correctness: 0.9 } }, // tests
      { label: "pass", score: { correctness: 0.9 } }, // docs
    ]);
    const bus = new EventBus();
    const events: PilotEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const pilot = new RunPilot({
      projectPath,
      requestText: "Add a greeting utility function to the project.",
      mode: "single",
      engine,
      bus,
    });

    const result = await pilot.execute();
    expect(result.status).toBe("complete");

    // ── the disguised-pass code attempt was BRANCHED as revise → Reflexion fired.
    expect(events.filter((e) => e.type === "reflexion.retry").length).toBe(1);

    // ── the first code verdict was RECORDED as revise (derived from scores),
    //    even though the judge label said "pass".
    const codeStage = db()
      .prepare(`SELECT id FROM stages WHERE run_id = ? AND kind = 'code'`)
      .get(result.run_id) as { id: string };
    const codeVerdicts = db()
      .prepare(
        `SELECT v.outcome, v.critique_md, v.score_json FROM verdicts v
           JOIN attempts a ON a.id = v.attempt_id
          WHERE a.stage_id = ? ORDER BY v.created_at`,
      )
      .all(codeStage.id) as Array<{ outcome: string; critique_md: string | null; score_json: string | null }>;
    expect(codeVerdicts.length).toBe(2);
    expect(codeVerdicts[0]!.outcome).toBe("revise");
    // disagreement provenance note recorded.
    expect(codeVerdicts[0]!.critique_md).toMatch(/\[harness\] outcome derived from scores; judge label was pass/);
    // persisted score_json is the sanitized flat dimension map.
    expect(JSON.parse(codeVerdicts[0]!.score_json!)).toEqual({ correctness: 0.9, minimality: 0.55 });
    // the retry is a genuine pass.
    expect(codeVerdicts[1]!.outcome).toBe("pass");
  });
});
