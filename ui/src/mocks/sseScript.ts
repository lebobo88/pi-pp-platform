/**
 * Scripted SSE sequences for the mock daemon. Each entry carries a delay
 * (ms after stream open) and a fully-typed envelope. The mock EventSource
 * replays these so feature screens can be built and demoed without the server.
 */
import type { GlobalSseEvent, RunSseEvent, SseEvent } from "@shared/api-types";
import { MOCK_RUN_ID } from "./fixtures/runTree";
import { mockProviders } from "./fixtures/catalog";

export interface ScriptedFrame {
  delayMs: number;
  event: SseEvent;
}

let seq = 1;
function nowIso(offsetMs: number): string {
  return new Date(Date.parse("2026-07-01T14:14:00.000Z") + offsetMs).toISOString();
}

/** Per-run stream: a compact live replay of a best-of-3 implementation stage. */
export function runStreamScript(runId: string): ScriptedFrame[] {
  const frames: ScriptedFrame[] = [];
  const push = (delayMs: number, event: RunSseEvent) => {
    frames.push({ delayMs, event: { ...event, run_id: runId, ts: nowIso(delayMs), seq: seq++ } as RunSseEvent });
  };

  push(400, {
    type: "stage.started",
    data: {
      id: "stg_live_impl",
      run_id: runId,
      kind: "implementation",
      gate_type: "code_style",
      status: "open",
      winner_attempt_id: null,
      started_at: nowIso(400),
      finished_at: null,
      notes_json: null,
    },
  } as RunSseEvent);

  const cand = [
    { id: "att_live_a", model: "claude-sonnet-4-6", producer: "claude" },
    { id: "att_live_b", model: "claude-opus-4-7", producer: "claude" },
    { id: "att_live_c", model: "gemini-2.5-pro", producer: "gemini" },
  ];

  cand.forEach((c, i) => {
    push(700 + i * 120, {
      type: "attempt.started",
      data: {
        id: c.id,
        stage_id: "stg_live_impl",
        producer: c.producer,
        model_id: c.model,
        prompt_hash: null,
        artifact_path: null,
        tokens_in: null,
        tokens_out: null,
        cost_usd: null,
        wall_ms: null,
        retry_index: 0,
        parent_attempt_id: null,
        status: "ok",
        attempted_tier: c.producer === "claude" ? (i === 1 ? "opus" : "sonnet") : null,
        created_at: nowIso(700 + i * 120),
      },
    } as RunSseEvent);
  });

  // Streaming output on the winning candidate.
  const outputLines = [
    "\x1b[34m[engineer]\x1b[0m reading src/checkout/order.ts",
    "\x1b[33mplan:\x1b[0m add discount field + resolveDiscount()",
    "writing src/checkout/order.ts",
    "writing src/checkout/order.test.ts",
    "\x1b[36m$ pnpm vitest run order.test.ts\x1b[0m",
    "\x1b[32m✓\x1b[0m 6 tests passed (812ms)",
    "\x1b[32mself-verify passed\x1b[0m",
  ];
  outputLines.forEach((line, i) => {
    push(1400 + i * 500, {
      type: "attempt.output",
      data: { attempt_id: "att_live_b", stage_id: "stg_live_impl", chunk: line + "\n" },
    } as RunSseEvent);
  });

  push(5200, { type: "budget.tick", data: { scope: `run:${runId}`, tokens_in: 58120, tokens_out: 24230, cost_usd: 1.29 } } as RunSseEvent);

  cand.forEach((c, i) => {
    push(5400 + i * 150, {
      type: "attempt.completed",
      data: {
        id: c.id,
        stage_id: "stg_live_impl",
        producer: c.producer,
        model_id: c.model,
        prompt_hash: `ph_${c.id}`,
        artifact_path: `.harness/live/${c.id}.diff`,
        tokens_in: 8000 + i * 100,
        tokens_out: 3800 + i * 120,
        cost_usd: c.producer === "claude" ? (i === 1 ? 0.379 : 0.083) : 0.066,
        wall_ms: 70000 + i * 4000,
        retry_index: 0,
        parent_attempt_id: null,
        status: c.id === "att_live_c" ? "needs_review" : "ok",
        attempted_tier: c.producer === "claude" ? (i === 1 ? "opus" : "sonnet") : null,
        created_at: nowIso(5400 + i * 150),
      },
    } as RunSseEvent);
  });

  push(6200, {
    type: "borda.updated",
    data: {
      stage_id: "stg_live_impl",
      leader_attempt_id: "att_live_b",
      ranking: [
        { attempt_id: "att_live_b", points: 6, rank: 1 },
        { attempt_id: "att_live_a", points: 4, rank: 2 },
        { attempt_id: "att_live_c", points: 2, rank: 3 },
      ],
    },
  } as RunSseEvent);

  cand.forEach((c, i) => {
    push(6400 + i * 120, {
      type: "verdict.recorded",
      data: {
        id: `vd_${c.id}`,
        attempt_id: c.id,
        judge_producer: "codex",
        judge_model_id: "gpt-5.4",
        rubric_id: "code-quality@3",
        outcome: c.id === "att_live_b" ? "pass" : c.id === "att_live_c" ? "revise" : "pass",
        critique_md: c.id === "att_live_b" ? "Borda winner — complete tests, clean error path." : "Solid but not selected.",
        score_json: null,
        cross_vendor: 1,
        eights_memory_id: null,
        created_at: nowIso(6400 + i * 120),
      },
    } as RunSseEvent);
  });

  push(7000, {
    type: "stage.finalized",
    data: { stage_id: "stg_live_impl", status: "passed", winner_attempt_id: "att_live_b" },
  } as RunSseEvent);

  push(7600, {
    type: "missability.result",
    data: { check_id: "changelog-present", status: "fail", evidence_path: ".harness/live/missability/changelog.json" },
  } as RunSseEvent);

  push(8200, {
    type: "run.finalized",
    data: { run_id: runId, status: "surfaced", finished_at: nowIso(8200) },
  } as RunSseEvent);

  return frames;
}

/** Global stream: health/provider/budget/evolution chatter. */
export function globalStreamScript(): ScriptedFrame[] {
  const frames: ScriptedFrame[] = [];
  const push = (delayMs: number, event: GlobalSseEvent) => {
    frames.push({ delayMs, event: { ...event, ts: nowIso(delayMs), seq: seq++ } as GlobalSseEvent });
  };

  push(1000, {
    type: "provider.status",
    data: mockProviders[0]!,
  } as GlobalSseEvent);

  push(3000, {
    type: "budget.tripwire",
    data: { scope: "day:2026-07-01", pct: 0.82, limit_usd: 8, cost_usd: 6.56, action: "warn" },
  } as GlobalSseEvent);

  push(5000, {
    type: "run.status",
    data: { run_id: MOCK_RUN_ID, status: "surfaced" },
  } as GlobalSseEvent);

  return frames;
}
