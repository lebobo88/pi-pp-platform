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

/**
 * Per-run stream. Drives the REAL fixture stage/attempt ids so a fetched
 * RunTree animates in place: the pipeline rail walks spec → design → contracts
 * → implementation → docs, the implementation stage runs a best-of-3 race with
 * streaming logs on the winner and a Borda update, and the run finalizes to
 * `surfaced` (one missability check fails).
 */
export function runStreamScript(runId: string): ScriptedFrame[] {
  const frames: ScriptedFrame[] = [];
  const push = (delayMs: number, event: RunSseEvent) => {
    frames.push({ delayMs, event: { ...event, run_id: runId, ts: nowIso(delayMs), seq: seq++ } as RunSseEvent });
  };

  // stage.started data shape mirrors the real pilot frame: { stage_id, kind, gate_type }.
  const stageMeta = (id: string, kind: string, gate: string) => ({
    stage_id: id,
    kind,
    gate_type: gate,
  });

  push(200, {
    type: "run.started",
    data: { mode: "team", project_path: "C:/AiAppDeployments/acme-checkout", request: "coupon-code field" },
  } as RunSseEvent);

  // Sequential single-attempt stages: spec → design → contracts.
  const linear: Array<[stage: string, kind: string, gate: string, attempt: string]> = [
    ["stg_spec", "spec", "spec", "att_spec_1"],
    ["stg_design", "design", "design", "att_design_2"],
    ["stg_contracts", "contracts", "contract", "att_contract_1"],
  ];
  let t = 400;
  for (const [stage, kind, gate, attempt] of linear) {
    push(t, { type: "stage.started", data: stageMeta(stage, kind, gate) } as RunSseEvent);
    push(t + 300, { type: "attempt.output", data: { attempt_id: attempt, stage_id: stage, chunk: `\x1b[34m[${kind}]\x1b[0m generating…\n` } } as RunSseEvent);
    push(t + 900, { type: "stage.finalized", data: { stage_id: stage, status: "passed", winner_attempt_id: attempt } } as RunSseEvent);
    t += 1200;
  }

  // Implementation: best-of-3 race on the real fixture ids.
  const IMPL = "stg_impl";
  push(t, { type: "stage.started", data: stageMeta(IMPL, "implementation", "code_style") } as RunSseEvent);
  const cand = ["att_impl_a", "att_impl_b", "att_impl_c"];
  cand.forEach((id, i) => {
    push(t + 200 + i * 120, {
      type: "attempt.output",
      data: { attempt_id: id, stage_id: IMPL, chunk: `\x1b[2m[candidate ${i + 1}]\x1b[0m started\n` },
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
    push(t + 700 + i * 420, {
      type: "attempt.output",
      data: { attempt_id: "att_impl_b", stage_id: IMPL, chunk: line + "\n" },
    } as RunSseEvent);
  });

  const bordaAt = t + 700 + outputLines.length * 420 + 200;
  push(bordaAt, { type: "budget.tick", data: { scope: `run:${runId}`, tokens_in: 58120, tokens_out: 24230, cost_usd: 1.29 } } as RunSseEvent);
  push(bordaAt + 200, {
    type: "borda.updated",
    data: {
      stage_id: IMPL,
      leader_attempt_id: "att_impl_b",
      ranking: [
        { attempt_id: "att_impl_b", points: 6, rank: 1 },
        { attempt_id: "att_impl_a", points: 4, rank: 2 },
        { attempt_id: "att_impl_c", points: 2, rank: 3 },
      ],
    },
  } as RunSseEvent);
  push(bordaAt + 700, {
    type: "stage.finalized",
    data: { stage_id: IMPL, status: "passed", winner_attempt_id: "att_impl_b" },
  } as RunSseEvent);

  // Docs stage surfaces on a failing missability check.
  const docsAt = bordaAt + 1000;
  push(docsAt, { type: "stage.started", data: stageMeta("stg_docs", "docs", "docs_polish") } as RunSseEvent);
  push(docsAt + 300, { type: "attempt.output", data: { attempt_id: "att_docs_1", stage_id: "stg_docs", chunk: "\x1b[34m[docs]\x1b[0m drafting release notes…\n" } } as RunSseEvent);
  push(docsAt + 800, {
    type: "missability.result",
    data: { check_id: "changelog-present", status: "fail", evidence_path: ".harness/runs/run_9fK2aLpQ7vX3/missability/changelog.json" },
  } as RunSseEvent);
  push(docsAt + 1100, { type: "stage.finalized", data: { stage_id: "stg_docs", status: "surfaced", winner_attempt_id: null } } as RunSseEvent);
  push(docsAt + 1500, {
    type: "run.finalized",
    data: { run_id: runId, status: "surfaced", finished_at: nowIso(docsAt + 1500) },
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
