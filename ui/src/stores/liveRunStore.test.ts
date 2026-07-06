/**
 * Unit tests for liveRunStore observability overlay extension.
 * SPEC-LRSTORE-OBS-002
 */
import { describe, it, expect, beforeEach } from "vitest";
import { liveRunStore } from "./liveRunStore";
import type { RunSseEvent } from "@shared/api-types";

/* ── Helpers ─────────────────────────────────────────────────────────── */

/** Build a minimal SseEnvelope-compatible RunSseEvent. */
function mkEv<T extends RunSseEvent["type"]>(
  type: T,
  data: Extract<RunSseEvent, { type: T }>["data"],
  seq: number,
  ts = `2024-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
): RunSseEvent {
  return { type, data, seq, ts, run_id: "run1" } as unknown as RunSseEvent;
}

/** Drain rAF-scheduled notifications synchronously. */
function flush(): void {
  vi.runAllTimers();
}

const RUN_ID = "run1";

/**
 * Build the canonical 13-frame realistic test sequence used for replay tests.
 * seq values are 0-based and gap-free.
 */
function buildSequence(): RunSseEvent[] {
  return [
    // 0: run started
    mkEv("run.started", { mode: "best_of", project_path: "/p", request: "req" }, 0),
    // 1: phase triage
    mkEv("run.context", { phase: "triage", note: "scanning request" }, 1),
    // 2: phase taxonomy
    mkEv("run.context", { phase: "taxonomy", summary: "three stages identified" }, 2),
    // 3: attempt.started (no attempt_id — pending)
    mkEv(
      "attempt.started",
      { stage_id: "s1", model: "claude-sonnet", tier: "sonnet" },
      3,
    ),
    // 4: attempt.output (seq-guarded log line)
    mkEv("attempt.output", { attempt_id: "a1", stage_id: "s1", chunk: "hello\nworld\n" }, 4),
    // 5: budget.tick run-scoped cumulative 1.00
    mkEv("budget.tick", { scope: "run:run1", tokens_in: 100, tokens_out: 50, cost_usd: 1.0 }, 5),
    // 6: budget.tick run-scoped cumulative 2.50
    mkEv("budget.tick", { scope: "run:run1", tokens_in: 200, tokens_out: 100, cost_usd: 2.5 }, 6),
    // 7: budget.tick run-scoped cumulative 4.00
    mkEv("budget.tick", { scope: "run:run1", tokens_in: 300, tokens_out: 150, cost_usd: 4.0 }, 7),
    // 8: verdict.recorded
    mkEv(
      "verdict.recorded",
      {
        attempt_id: "a1",
        outcome: "pass",
        stage_id: "s1",
        judge_model: "gpt-4o",
        cross_vendor: true,
      },
      8,
    ),
    // 9: reflexion.retry
    mkEv(
      "reflexion.retry",
      {
        stage_id: "s1",
        initial_tier: "sonnet",
        retry_tier: "opus",
        critique_excerpt: "The implementation is incomplete",
      },
      9,
    ),
    // 10: attempt.completed (reconciles pending started-meta for s1)
    mkEv(
      "attempt.completed",
      {
        stage_id: "s1",
        attempt_id: "a1",
        tokens_in: 300,
        tokens_out: 150,
        cost_usd: 4.0,
        stop_reason: "end_turn",
        tool_call_count: 5,
        files_changed: 2,
        materialized_files: ["src/a.ts", "src/b.ts"],
        zero_change: false,
      },
      10,
    ),
    // 11: stage.surfaced
    mkEv("stage.surfaced", { stage_id: "s1", reason: "winner selected" }, 11),
    // 12: run.finalized
    mkEv("run.finalized", { run_id: RUN_ID, status: "complete", finished_at: "2024-01-01T00:01:00Z" }, 12),
  ];
}

/* ── Setup ───────────────────────────────────────────────────────────── */

beforeEach(() => {
  liveRunStore.reset();
  vi.useFakeTimers();
});

/* ── §4 Replay idempotency ───────────────────────────────────────────── */

describe("replay idempotency (§4)", () => {
  it("ingesting the same sequence twice produces identical structural overlay", () => {
    const seq = buildSequence();

    // First pass
    for (const ev of seq) liveRunStore.ingest(RUN_ID, ev);
    flush();

    const snap1 = liveRunStore.getOverlay(RUN_ID);
    const costUsd1 = snap1.costUsd;
    const costSeriesLen1 = (snap1.costSeries ?? []).length;
    const gateEventsLen1 = (snap1.gateEvents ?? []).length;
    const attempts1 = JSON.stringify(snap1.attempts ?? {});
    const lastSeq1 = snap1.lastAppliedSeq ?? -1;

    // Second pass (full replay)
    for (const ev of seq) liveRunStore.ingest(RUN_ID, ev);
    flush();

    const snap2 = liveRunStore.getOverlay(RUN_ID);

    expect(snap2.costUsd).toBe(costUsd1);
    expect((snap2.costSeries ?? []).length).toBe(costSeriesLen1);
    expect((snap2.gateEvents ?? []).length).toBe(gateEventsLen1);
    expect(JSON.stringify(snap2.attempts ?? {})).toBe(attempts1);
    expect(snap2.lastAppliedSeq ?? -1).toBe(lastSeq1);
  });

  it("log lines are not duplicated after replay", () => {
    const seq = buildSequence();

    for (const ev of seq) liveRunStore.ingest(RUN_ID, ev);
    flush();
    const logAfterFirst = liveRunStore.getLog("a1").lines.slice();
    const logLinesCount1 = logAfterFirst.length;

    // Replay
    for (const ev of seq) liveRunStore.ingest(RUN_ID, ev);
    flush();
    const logAfterSecond = liveRunStore.getLog("a1").lines;

    expect(logAfterSecond.length).toBe(logLinesCount1);
  });

  it("lastAppliedSeq is set to the highest seq after first pass", () => {
    const seq = buildSequence();
    for (const ev of seq) liveRunStore.ingest(RUN_ID, ev);
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).lastAppliedSeq).toBe(12);
  });

  it("initialises lastAppliedSeq to -1 on fresh overlay", () => {
    expect(liveRunStore.getOverlay("brand-new-run").lastAppliedSeq).toBe(-1);
  });

  it("ignores frames with seq <= lastAppliedSeq", () => {
    liveRunStore.ingest(RUN_ID, mkEv("run.started", { mode: "single", project_path: "/p", request: "r" }, 5));
    const v1 = liveRunStore.getOverlay(RUN_ID).version;

    // seq 5 again — must be ignored
    liveRunStore.ingest(RUN_ID, mkEv("run.started", { mode: "single", project_path: "/p", request: "r" }, 5));
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).version).toBe(v1);

    // seq 3 (older) — must also be ignored
    liveRunStore.ingest(RUN_ID, mkEv("run.started", { mode: "single", project_path: "/p", request: "r" }, 3));
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).version).toBe(v1);
  });

  it("applies frames with seq > lastAppliedSeq", () => {
    liveRunStore.ingest(RUN_ID, mkEv("run.started", { mode: "single", project_path: "/p", request: "r" }, 5));
    flush();
    const v1 = liveRunStore.getOverlay(RUN_ID).version;

    liveRunStore.ingest(RUN_ID, mkEv("run.started", { mode: "single", project_path: "/p", request: "r" }, 6));
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).version).toBeGreaterThan(v1);
  });

  it("frames without a valid seq are always applied (defensive)", () => {
    // Simulate a frame from a test double that lacks seq
    const frame = { type: "run.started", data: { mode: "single", project_path: "/p", request: "r" }, ts: "2024-01-01T00:00:00Z", run_id: RUN_ID } as unknown as RunSseEvent;
    liveRunStore.ingest(RUN_ID, frame);
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).status).toBe("running");
    const v1 = liveRunStore.getOverlay(RUN_ID).version;

    // Apply again — should still apply (no lastAppliedSeq guard without seq)
    liveRunStore.ingest(RUN_ID, frame);
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).version).toBeGreaterThan(v1);
  });

  it("absolute cost assignment: a lower replayed budget.tick after higher one does not corrupt when seq-guarded", () => {
    liveRunStore.ingest(RUN_ID, mkEv("budget.tick", { scope: "run:run1", tokens_in: 100, tokens_out: 50, cost_usd: 10.0 }, 5));
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).costUsd).toBe(10.0);

    // Replay seq=5 with lower value — must be ignored
    liveRunStore.ingest(RUN_ID, mkEv("budget.tick", { scope: "run:run1", tokens_in: 100, tokens_out: 50, cost_usd: 1.0 }, 5));
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).costUsd).toBe(10.0);
  });
});

/* ── §5.1 Phase timeline ─────────────────────────────────────────────── */

describe("phaseTimeline (§5.1)", () => {
  it("starts empty", () => {
    expect(liveRunStore.getOverlay(RUN_ID).phaseTimeline).toEqual([]);
  });

  it("appends first phase as active", () => {
    liveRunStore.ingest(RUN_ID, mkEv("run.context", { phase: "triage" }, 0));
    flush();
    const tl = liveRunStore.getOverlay(RUN_ID).phaseTimeline ?? [];
    expect(tl).toHaveLength(1);
    expect(tl[0]).toMatchObject({ phase: "triage", status: "active" });
  });

  it("repeat frame for same phase bumps lastAt", () => {
    liveRunStore.ingest(RUN_ID, mkEv("run.context", { phase: "triage" }, 0, "2024-01-01T00:00:00Z"));
    liveRunStore.ingest(RUN_ID, mkEv("run.context", { phase: "triage" }, 1, "2024-01-01T00:00:10Z"));
    flush();
    const tl = liveRunStore.getOverlay(RUN_ID).phaseTimeline ?? [];
    expect(tl).toHaveLength(1);
    expect(tl[0]!.lastAt).toBe("2024-01-01T00:00:10Z");
    expect(tl[0]!.startedAt).toBe("2024-01-01T00:00:00Z");
    expect(tl[0]!.status).toBe("active");
  });

  it("phase transition marks previous phase done and appends new active", () => {
    liveRunStore.ingest(RUN_ID, mkEv("run.context", { phase: "triage" }, 0, "2024-01-01T00:00:00Z"));
    liveRunStore.ingest(RUN_ID, mkEv("run.context", { phase: "taxonomy" }, 1, "2024-01-01T00:00:10Z"));
    flush();
    const tl = liveRunStore.getOverlay(RUN_ID).phaseTimeline ?? [];
    expect(tl).toHaveLength(2);
    expect(tl[0]).toMatchObject({ phase: "triage", status: "done" });
    expect(tl[1]).toMatchObject({ phase: "taxonomy", status: "active" });
  });

  it("at most one entry has status active at any time", () => {
    liveRunStore.ingest(RUN_ID, mkEv("run.context", { phase: "triage" }, 0));
    liveRunStore.ingest(RUN_ID, mkEv("run.context", { phase: "taxonomy" }, 1));
    liveRunStore.ingest(RUN_ID, mkEv("run.context", { phase: "skills" }, 2));
    flush();
    const tl = liveRunStore.getOverlay(RUN_ID).phaseTimeline ?? [];
    const activeCount = tl.filter((e) => e.status === "active").length;
    expect(activeCount).toBe(1);
    expect(tl[tl.length - 1]!.status).toBe("active");
  });

  it("terminal run.finalized marks all phases done", () => {
    liveRunStore.ingest(RUN_ID, mkEv("run.context", { phase: "triage" }, 0, "T0"));
    liveRunStore.ingest(RUN_ID, mkEv("run.context", { phase: "taxonomy" }, 1, "T1"));
    liveRunStore.ingest(
      RUN_ID,
      mkEv("run.finalized", { run_id: RUN_ID, status: "complete", finished_at: "T2" }, 2, "T2"),
    );
    flush();
    const tl = liveRunStore.getOverlay(RUN_ID).phaseTimeline ?? [];
    expect(tl.every((e) => e.status === "done")).toBe(true);
  });

  it("distill populates detail from note", () => {
    liveRunStore.ingest(RUN_ID, mkEv("run.context", { phase: "triage", note: "scanning request" }, 0));
    flush();
    const tl = liveRunStore.getOverlay(RUN_ID).phaseTimeline ?? [];
    expect(tl[0]!.detail).toBe("scanning request");
  });

  it("distill truncates detail to 120 chars", () => {
    const longNote = "x".repeat(200);
    liveRunStore.ingest(RUN_ID, mkEv("run.context", { phase: "triage", note: longNote }, 0));
    flush();
    const tl = liveRunStore.getOverlay(RUN_ID).phaseTimeline ?? [];
    expect(tl[0]!.detail!.length).toBeLessThanOrEqual(120);
  });

  it("distill does not expose secret fields", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("run.context", { phase: "triage", key_api: "SUPER_SECRET", note: "ok" }, 0),
    );
    flush();
    const tl = liveRunStore.getOverlay(RUN_ID).phaseTimeline ?? [];
    expect(tl[0]!.detail).not.toContain("SUPER_SECRET");
    expect(tl[0]!.detail).toBe("ok");
  });
});

/* ── §5.2 attempts / pending reconciliation ─────────────────────────── */

describe("attempts + pending reconciliation (§5.2)", () => {
  it("attempt.started with attempt_id upserts immediately", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("attempt.started", { stage_id: "s1", attempt_id: "a1", model: "gpt-4o", tier: "flagship" }, 0),
    );
    flush();
    const ov = liveRunStore.getOverlay(RUN_ID);
    expect((ov.attempts ?? {})["a1"]).toMatchObject({
      attemptId: "a1",
      stageId: "s1",
      model: "gpt-4o",
      tier: "flagship",
      status: "running",
    });
  });

  it("attempt.started without attempt_id stores pending meta (not visible in attempts)", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("attempt.started", { stage_id: "s1", model: "claude-sonnet", tier: "sonnet" }, 0),
    );
    flush();
    const ov = liveRunStore.getOverlay(RUN_ID);
    // pending must NOT appear in attempts
    expect(Object.keys(ov.attempts ?? {})).toHaveLength(0);
  });

  it("attempt.completed reconciles pending started-meta", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("attempt.started", { stage_id: "s1", model: "claude-sonnet", tier: "sonnet" }, 0),
    );
    liveRunStore.ingest(
      RUN_ID,
      mkEv(
        "attempt.completed",
        { stage_id: "s1", attempt_id: "a1", tokens_in: 100, tokens_out: 50, cost_usd: 0.5, stop_reason: "end_turn" },
        1,
      ),
    );
    flush();
    const ov = liveRunStore.getOverlay(RUN_ID);
    const meta = (ov.attempts ?? {})["a1"]!;
    expect(meta.stageId).toBe("s1");
    expect(meta.model).toBe("claude-sonnet");
    expect(meta.tier).toBe("sonnet");
    expect(meta.tokensIn).toBe(100);
    expect(meta.tokensOut).toBe(50);
    expect(meta.costUsd).toBe(0.5);
    expect(meta.stopReason).toBe("end_turn");
    expect(meta.status).toBe("ok");
  });

  it("pending slot is cleared after reconciliation", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("attempt.started", { stage_id: "s1", model: "m1" }, 0),
    );
    liveRunStore.ingest(
      RUN_ID,
      mkEv("attempt.completed", { stage_id: "s1", attempt_id: "a1", tokens_in: 1, tokens_out: 1, cost_usd: 0.01 }, 1),
    );
    // Second completion for same stage — no pending slot remaining
    liveRunStore.ingest(
      RUN_ID,
      mkEv("attempt.completed", { stage_id: "s1", attempt_id: "a2", tokens_in: 2, tokens_out: 2, cost_usd: 0.02 }, 2),
    );
    flush();
    const ov = liveRunStore.getOverlay(RUN_ID);
    // a1 has model from pending; a2 should not have it
    expect((ov.attempts ?? {})["a1"]!.model).toBe("m1");
    expect((ov.attempts ?? {})["a2"]!.model).toBeUndefined();
  });

  it("per-attempt costUsd is an absolute overwrite, never +=", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("attempt.started", { stage_id: "s1", attempt_id: "a1" }, 0),
    );
    liveRunStore.ingest(
      RUN_ID,
      mkEv("attempt.completed", { stage_id: "s1", attempt_id: "a1", tokens_in: 10, tokens_out: 5, cost_usd: 3.0 }, 1),
    );
    flush();
    expect((liveRunStore.getOverlay(RUN_ID).attempts ?? {})["a1"]!.costUsd).toBe(3.0);

    // A second completed frame (higher seq) sets a new absolute value
    liveRunStore.ingest(
      RUN_ID,
      mkEv("attempt.completed", { stage_id: "s1", attempt_id: "a1", tokens_in: 10, tokens_out: 5, cost_usd: 2.0 }, 2),
    );
    flush();
    // Must be 2.0, not 3.0 + 2.0 = 5.0
    expect((liveRunStore.getOverlay(RUN_ID).attempts ?? {})["a1"]!.costUsd).toBe(2.0);
  });

  it("second pending for same stage replaces first (last-writer-wins)", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("attempt.started", { stage_id: "s1", model: "old-model" }, 0),
    );
    liveRunStore.ingest(
      RUN_ID,
      mkEv("attempt.started", { stage_id: "s1", model: "new-model" }, 1),
    );
    liveRunStore.ingest(
      RUN_ID,
      mkEv("attempt.completed", { stage_id: "s1", attempt_id: "a1", tokens_in: 1, tokens_out: 1, cost_usd: 0.01 }, 2),
    );
    flush();
    // Should have new-model, not old-model
    expect((liveRunStore.getOverlay(RUN_ID).attempts ?? {})["a1"]!.model).toBe("new-model");
  });

  it("materializedFiles is stored as count, not array", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv(
        "attempt.completed",
        {
          stage_id: "s1",
          attempt_id: "a1",
          tokens_in: 1,
          tokens_out: 1,
          cost_usd: 0,
          materialized_files: ["a.ts", "b.ts", "c.ts"],
        },
        0,
      ),
    );
    flush();
    expect((liveRunStore.getOverlay(RUN_ID).attempts ?? {})["a1"]!.materializedFiles).toBe(3);
  });
});

/* ── §5.3 Gate events ring ───────────────────────────────────────────── */

describe("gateEvents ring (§5.3)", () => {
  it("starts empty", () => {
    expect(liveRunStore.getOverlay(RUN_ID).gateEvents).toHaveLength(0);
  });

  it("attempt.started emits gen/started gate event", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("attempt.started", { stage_id: "s1", attempt_id: "a1", model: "gpt-4o", tier: "flagship" }, 0),
    );
    flush();
    const events = liveRunStore.getOverlay(RUN_ID).gateEvents ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "gen", outcome: "started", stageId: "s1", attemptId: "a1" });
    expect(events[0]!.detail).toContain("gpt-4o");
    expect(events[0]!.detail).toContain("flagship");
  });

  it("attempt.completed emits gen/ok gate event", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("attempt.completed", { stage_id: "s1", attempt_id: "a1", tokens_in: 100, tokens_out: 50, stop_reason: "end_turn" }, 0),
    );
    flush();
    const events = liveRunStore.getOverlay(RUN_ID).gateEvents ?? [];
    const completed = events.find((e) => e.outcome === "ok");
    expect(completed).toBeDefined();
    expect(completed!.detail).toContain("in=100");
    expect(completed!.detail).toContain("out=50");
    expect(completed!.detail).toContain("stop=end_turn");
  });

  it("verdict.recorded emits verdict gate event", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("verdict.recorded", { attempt_id: "a1", outcome: "pass", stage_id: "s1", judge_model: "gpt-4o", cross_vendor: true }, 0),
    );
    flush();
    const events = liveRunStore.getOverlay(RUN_ID).gateEvents ?? [];
    expect(events[0]).toMatchObject({ kind: "verdict", outcome: "pass", stageId: "s1", attemptId: "a1" });
    expect(events[0]!.detail).toContain("judge=gpt-4o");
    expect(events[0]!.detail).toContain("cross=true");
  });

  it("reflexion.retry emits reflexion gate event with tier escalation in detail", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv(
        "reflexion.retry",
        { stage_id: "s1", initial_tier: "sonnet", retry_tier: "opus", critique_excerpt: "code incomplete" },
        0,
      ),
    );
    flush();
    const events = liveRunStore.getOverlay(RUN_ID).gateEvents ?? [];
    expect(events[0]).toMatchObject({ kind: "reflexion", outcome: "retry", stageId: "s1" });
    expect(events[0]!.detail).toContain("sonnet→opus");
    expect(events[0]!.detail).toContain("code incomplete");
  });

  it("reflexion critique excerpt is truncated to ≤160 chars with U+2026", () => {
    const longCritique = "x".repeat(200);
    liveRunStore.ingest(
      RUN_ID,
      mkEv("reflexion.retry", { stage_id: "s1", critique_excerpt: longCritique }, 0),
    );
    flush();
    const ev = (liveRunStore.getOverlay(RUN_ID).gateEvents ?? [])[0]!;
    // detail contains just the critique (no tier parts in this case)
    expect([...ev.detail!].length).toBeLessThanOrEqual(160);
    expect(ev.detail!.endsWith("…")).toBe(true);
  });

  it("smoke.status emits smoke gate event", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("smoke.status", { stage_id: "s1", attempt_id: "a1", status: "fail", detail: "crashed" }, 0),
    );
    flush();
    const events = liveRunStore.getOverlay(RUN_ID).gateEvents ?? [];
    expect(events[0]).toMatchObject({ kind: "smoke", outcome: "fail", stageId: "s1", attemptId: "a1" });
    expect(events[0]!.detail).toBe("crashed");
  });

  it("validation.result emits validation gate event", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("validation.result", { stage_id: "s1", status: "pass", reason: "all checks ok" }, 0),
    );
    flush();
    const events = liveRunStore.getOverlay(RUN_ID).gateEvents ?? [];
    expect(events[0]).toMatchObject({ kind: "validation", outcome: "pass" });
    expect(events[0]!.detail).toBe("all checks ok");
  });

  it("missability.result emits missability gate event", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("missability.result", { check_id: "c1", status: "warn" }, 0),
    );
    flush();
    const events = liveRunStore.getOverlay(RUN_ID).gateEvents ?? [];
    expect(events[0]).toMatchObject({ kind: "missability", outcome: "warn" });
  });

  it("borda.updated emits borda gate event", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv(
        "borda.updated",
        {
          stage_id: "s1",
          ranking: [{ attempt_id: "a1", points: 10, rank: 1 }],
          leader_attempt_id: "a1",
        },
        0,
      ),
    );
    flush();
    const events = liveRunStore.getOverlay(RUN_ID).gateEvents ?? [];
    expect(events[0]).toMatchObject({ kind: "borda", outcome: "updated" });
    expect(events[0]!.detail).toContain("winner=a1");
  });

  it("stage.surfaced emits surfaced gate event", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("stage.surfaced", { stage_id: "s1", reason: "winner selected" }, 0),
    );
    flush();
    const events = liveRunStore.getOverlay(RUN_ID).gateEvents ?? [];
    expect(events[0]).toMatchObject({ kind: "surfaced", outcome: "surfaced", stageId: "s1" });
    expect(events[0]!.detail).toBe("winner selected");
  });

  it("ring cap: after 201 events, only the last 200 are kept", () => {
    for (let i = 0; i < 201; i++) {
      liveRunStore.ingest(
        RUN_ID,
        mkEv("stage.surfaced", { stage_id: `s${i}`, reason: `r${i}` }, i),
      );
    }
    flush();
    const events = liveRunStore.getOverlay(RUN_ID).gateEvents ?? [];
    expect((events ?? []).length).toBe(200);
    // Oldest (s0) should be gone; newest (s200) should be last
    expect(events[0]!.stageId).toBe("s1");
    expect(events[199]!.stageId).toBe("s200");
  });

  it("gate events carry seq and at from envelope", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("stage.surfaced", { stage_id: "s1", reason: "x" }, 42, "2024-06-15T12:00:00Z"),
    );
    flush();
    const ev = (liveRunStore.getOverlay(RUN_ID).gateEvents ?? [])[0]!;
    expect(ev.seq).toBe(42);
    expect(ev.at).toBe("2024-06-15T12:00:00Z");
  });
});

/* ── §5.4 costSeries + costUsd ───────────────────────────────────────── */

describe("costSeries and costUsd (§5.4)", () => {
  it("run-scoped budget.tick updates costUsd and pushes to costSeries", () => {
    liveRunStore.ingest(RUN_ID, mkEv("budget.tick", { scope: "run:run1", tokens_in: 100, tokens_out: 50, cost_usd: 1.0 }, 0));
    liveRunStore.ingest(RUN_ID, mkEv("budget.tick", { scope: "run:run1", tokens_in: 200, tokens_out: 100, cost_usd: 2.5 }, 1));
    flush();
    const ov = liveRunStore.getOverlay(RUN_ID);
    expect(ov.costUsd).toBe(2.5);
    expect(ov.costSeries ?? []).toEqual([1.0, 2.5]);
  });

  it("stage-scoped budget.tick (with stage_id) does not update costUsd or costSeries", () => {
    // Inject a run-scoped tick first
    liveRunStore.ingest(RUN_ID, mkEv("budget.tick", { scope: "run:run1", tokens_in: 100, tokens_out: 50, cost_usd: 5.0 }, 0));
    // Now a frame that has stage_id — stage-scoped even if scope says run
    const stageFrame = {
      type: "budget.tick",
      data: { scope: "run:run1", tokens_in: 100, tokens_out: 50, cost_usd: 99.0, stage_id: "s1" },
      seq: 1,
      ts: "2024-01-01T00:00:01Z",
      run_id: RUN_ID,
    } as unknown as RunSseEvent;
    liveRunStore.ingest(RUN_ID, stageFrame);
    flush();
    const ov = liveRunStore.getOverlay(RUN_ID);
    expect(ov.costUsd).toBe(5.0);
    expect(ov.costSeries ?? []).toHaveLength(1);
  });

  it("budget.tick for a different run scope is ignored", () => {
    liveRunStore.ingest(RUN_ID, mkEv("budget.tick", { scope: "run:other-run", tokens_in: 100, tokens_out: 50, cost_usd: 99.0 }, 0));
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).costUsd).toBe(0);
    expect(liveRunStore.getOverlay(RUN_ID).costSeries).toHaveLength(0);
  });

  it("costSeries cap: after 121 ticks, only the last 120 are kept", () => {
    for (let i = 0; i < 121; i++) {
      liveRunStore.ingest(
        RUN_ID,
        mkEv("budget.tick", { scope: "run:run1", tokens_in: i, tokens_out: i, cost_usd: i * 0.1 }, i),
      );
    }
    flush();
    const ov = liveRunStore.getOverlay(RUN_ID);
    expect(ov.costSeries ?? []).toHaveLength(120);
    // First element should be index 1 (index 0 was dropped)
    expect((ov.costSeries ?? [])[0]).toBeCloseTo(0.1, 5);
    expect((ov.costSeries ?? [])[119]).toBeCloseTo(12.0, 5);
  });

  it("costUsd is an absolute assignment — later higher tick does not add to previous", () => {
    liveRunStore.ingest(RUN_ID, mkEv("budget.tick", { scope: "run:run1", tokens_in: 100, tokens_out: 50, cost_usd: 5.0 }, 0));
    liveRunStore.ingest(RUN_ID, mkEv("budget.tick", { scope: "run:run1", tokens_in: 200, tokens_out: 100, cost_usd: 3.0 }, 1));
    flush();
    // Absolute: latest value wins, not 5.0 + 3.0
    expect(liveRunStore.getOverlay(RUN_ID).costUsd).toBe(3.0);
  });
});

/* ── lastEventTs ─────────────────────────────────────────────────────── */

describe("lastEventTs", () => {
  it("is null on fresh overlay", () => {
    expect(liveRunStore.getOverlay(RUN_ID).lastEventTs).toBeNull();
  });

  it("is updated from every applied frame ts", () => {
    liveRunStore.ingest(RUN_ID, mkEv("run.started", { mode: "single", project_path: "/p", request: "r" }, 0, "2024-01-01T00:00:00Z"));
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).lastEventTs).toBe("2024-01-01T00:00:00Z");

    liveRunStore.ingest(RUN_ID, mkEv("run.context", { phase: "triage" }, 1, "2024-01-01T00:00:10Z"));
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).lastEventTs).toBe("2024-01-01T00:00:10Z");
  });

  it("is NOT updated for replayed (seq-duped) frames", () => {
    liveRunStore.ingest(RUN_ID, mkEv("run.started", { mode: "single", project_path: "/p", request: "r" }, 5, "2024-01-01T00:00:05Z"));
    flush();
    liveRunStore.ingest(RUN_ID, mkEv("run.started", { mode: "single", project_path: "/p", request: "r" }, 5, "2024-01-01T99:99:99Z"));
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).lastEventTs).toBe("2024-01-01T00:00:05Z");
  });
});

/* ── Existing behaviour preservation ────────────────────────────────── */

describe("existing behaviour (unchanged)", () => {
  it("status transitions via run.started and run.finalized", () => {
    liveRunStore.ingest(RUN_ID, mkEv("run.started", { mode: "single", project_path: "/p", request: "r" }, 0));
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).status).toBe("running");

    liveRunStore.ingest(RUN_ID, mkEv("run.finalized", { run_id: RUN_ID, status: "complete", finished_at: "t" }, 1));
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).status).toBe("complete");
  });

  it("stageStatus and stageWinner updated by stage events", () => {
    liveRunStore.ingest(RUN_ID, mkEv("stage.started", { stage_id: "s1", kind: "code", gate_type: "spec" }, 0));
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).stageStatus["s1"]).toBe("open");

    liveRunStore.ingest(RUN_ID, mkEv("stage.finalized", { stage_id: "s1", status: "passed", winner_attempt_id: "a1" }, 1));
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).stageStatus["s1"]).toBe("passed");
    expect(liveRunStore.getOverlay(RUN_ID).stageWinner["s1"]).toBe("a1");
  });

  it("verdicts record and retract", () => {
    liveRunStore.ingest(RUN_ID, mkEv("verdict.recorded", { attempt_id: "a1", outcome: "pass", stage_id: "s1" }, 0));
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).verdicts["a1"]).toBe("pass");

    liveRunStore.ingest(RUN_ID, mkEv("verdict.retracted", { attempt_id: "a1", stage_id: "s1" }, 1));
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).verdicts["a1"]).toBeUndefined();
  });

  it("borda ranking stored by stage_id", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv("borda.updated", { stage_id: "s1", ranking: [{ attempt_id: "a1", points: 10, rank: 1 }] }, 0),
    );
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).borda["s1"]).toEqual([
      { attempt_id: "a1", points: 10, rank: 1 },
    ]);
  });

  it("version is bumped on each structural event", () => {
    const v0 = liveRunStore.getOverlay(RUN_ID).version;
    liveRunStore.ingest(RUN_ID, mkEv("run.started", { mode: "single", project_path: "/p", request: "r" }, 0));
    flush();
    const v1 = liveRunStore.getOverlay(RUN_ID).version;
    expect(v1).toBeGreaterThan(v0);

    liveRunStore.ingest(RUN_ID, mkEv("run.context", { phase: "triage" }, 1));
    flush();
    const v2 = liveRunStore.getOverlay(RUN_ID).version;
    expect(v2).toBeGreaterThan(v1);
  });

  it("log buffers still work via getLog/subscribeLog", () => {
    liveRunStore.ingest(RUN_ID, mkEv("attempt.output", { attempt_id: "a1", stage_id: "s1", chunk: "line1\nline2\n" }, 0));
    flush();
    const buf = liveRunStore.getLog("a1");
    expect(buf.lines).toContain("line1");
    expect(buf.lines).toContain("line2");
  });

  it("setStatus works independently of ingest", () => {
    liveRunStore.setStatus(RUN_ID, "surfaced");
    flush();
    expect(liveRunStore.getOverlay(RUN_ID).status).toBe("surfaced");
  });

  it("reset clears all state", () => {
    liveRunStore.ingest(RUN_ID, mkEv("run.started", { mode: "single", project_path: "/p", request: "r" }, 0));
    flush();
    liveRunStore.reset();
    expect(liveRunStore.getOverlay(RUN_ID).status).toBeNull();
    expect(liveRunStore.getOverlay(RUN_ID).version).toBe(0);
  });

  it("tokensIn and tokensOut updated by run-scoped budget.tick", () => {
    liveRunStore.ingest(RUN_ID, mkEv("budget.tick", { scope: "run:run1", tokens_in: 123, tokens_out: 456, cost_usd: 1.0 }, 0));
    flush();
    const ov = liveRunStore.getOverlay(RUN_ID);
    expect(ov.tokensIn).toBe(123);
    expect(ov.tokensOut).toBe(456);
  });
});

/* ── Provider visibility (spec-provider-visibility-live-view-discoverability) ── */

describe("provider capture from SSE frames", () => {
  beforeEach(() => {
    liveRunStore.reset();
    vi.useFakeTimers();
  });

  it("attempt.started with provider stores it on AttemptMeta", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv(
        "attempt.started",
        { stage_id: "s1", attempt_id: "a1", model: "claude-sonnet-4-6", tier: "sonnet", provider: "github-copilot" },
        1,
      ),
    );
    flush();
    const meta = liveRunStore.getOverlay(RUN_ID).attempts?.["a1"];
    expect(meta?.provider).toBe("github-copilot");
  });

  it("attempt.started without provider does not set provider on AttemptMeta", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv(
        "attempt.started",
        { stage_id: "s1", attempt_id: "a1", model: "claude-sonnet-4-6", tier: "sonnet" },
        1,
      ),
    );
    flush();
    const meta = liveRunStore.getOverlay(RUN_ID).attempts?.["a1"];
    expect(meta?.provider).toBeUndefined();
  });

  it("attempt.completed with provider updates AttemptMeta.provider", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv(
        "attempt.started",
        { stage_id: "s1", attempt_id: "a1", model: "gpt-5.4", tier: "sonnet", provider: "azure-openai-responses" },
        1,
      ),
    );
    liveRunStore.ingest(
      RUN_ID,
      mkEv(
        "attempt.completed",
        { stage_id: "s1", attempt_id: "a1", model: "gpt-5.4", tokens_in: 100, tokens_out: 50, cost_usd: 0.5, provider: "azure-openai-responses" },
        2,
      ),
    );
    flush();
    const meta = liveRunStore.getOverlay(RUN_ID).attempts?.["a1"];
    expect(meta?.provider).toBe("azure-openai-responses");
  });

  it("started and completed provider must agree (REQ-W-5): completed overwrites with same value", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv(
        "attempt.started",
        { stage_id: "s1", attempt_id: "a1", model: "gpt-5.4", provider: "github-copilot" },
        1,
      ),
    );
    liveRunStore.ingest(
      RUN_ID,
      mkEv(
        "attempt.completed",
        { stage_id: "s1", attempt_id: "a1", model: "gpt-5.4", provider: "github-copilot" },
        2,
      ),
    );
    flush();
    const meta = liveRunStore.getOverlay(RUN_ID).attempts?.["a1"];
    // Both frames agree — stored value is the common provider.
    expect(meta?.provider).toBe("github-copilot");
  });

  it("verdict.recorded with judge_provider appears in gate event detail", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv(
        "verdict.recorded",
        { attempt_id: "a1", outcome: "pass", stage_id: "s1", judge_model: "claude-opus-4-7", judge_provider: "anthropic-messages", cross_vendor: true },
        3,
      ),
    );
    flush();
    const ov = liveRunStore.getOverlay(RUN_ID);
    const verdictEv = (ov.gateEvents ?? []).find((e) => e.kind === "verdict" && e.attemptId === "a1");
    expect(verdictEv).toBeDefined();
    expect(verdictEv?.detail).toContain("judge_provider=anthropic-messages");
  });

  it("verdict.recorded without judge_provider omits it from gate event detail", () => {
    liveRunStore.ingest(
      RUN_ID,
      mkEv(
        "verdict.recorded",
        { attempt_id: "a1", outcome: "fail", stage_id: "s1", judge_model: "gpt-4o" },
        3,
      ),
    );
    flush();
    const ov = liveRunStore.getOverlay(RUN_ID);
    const verdictEv = (ov.gateEvents ?? []).find((e) => e.kind === "verdict" && e.attemptId === "a1");
    expect(verdictEv?.detail).not.toContain("judge_provider=");
  });

  it("replay idempotency: re-ingesting same attempt.started frames does not duplicate provider", () => {
    const startEv = mkEv(
      "attempt.started",
      { stage_id: "s1", attempt_id: "a1", model: "claude-sonnet-4-6", provider: "github-copilot" },
      1,
    );
    liveRunStore.ingest(RUN_ID, startEv);
    flush();
    // Replay same frame (seq dedup)
    liveRunStore.ingest(RUN_ID, startEv);
    flush();
    const meta = liveRunStore.getOverlay(RUN_ID).attempts?.["a1"];
    // Still exactly "github-copilot", not doubled
    expect(meta?.provider).toBe("github-copilot");
  });
});
