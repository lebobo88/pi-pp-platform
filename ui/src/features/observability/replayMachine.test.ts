/**
 * Unit tests for replayMachine pure functions.
 */
import { describe, it, expect } from "vitest";
import {
  computeDelay,
  computeEventDensity,
  posToIndex,
  indexToPos,
  extractAttemptIds,
  latestAttemptCompletedBefore,
  MAX_INTER_EVENT_DELAY_MS,
} from "./replayMachine.js";

function ev(ts: string, type = "run.context", data: unknown = {}): { ts: string; type: string; data: unknown } {
  return { ts, type, data };
}

/* ── computeDelay ─────────────────────────────────────────────────────── */

describe("computeDelay", () => {
  it("returns 0 for first event (nextIdx=0)", () => {
    const events = [ev("2024-01-01T00:00:00Z"), ev("2024-01-01T00:00:05Z")];
    expect(computeDelay(events, 0, 1)).toBe(0);
  });

  it("returns 0 for max speed (null)", () => {
    const events = [ev("2024-01-01T00:00:00Z"), ev("2024-01-01T00:00:05Z")];
    expect(computeDelay(events, 1, null)).toBe(0);
  });

  it("returns 0 when nextIdx is out of range", () => {
    const events = [ev("2024-01-01T00:00:00Z")];
    expect(computeDelay(events, 5, 1)).toBe(0);
  });

  it("caps large gap at MAX_INTER_EVENT_DELAY_MS at 1x", () => {
    const events = [ev("2024-01-01T00:00:00Z"), ev("2024-01-01T01:00:00Z")];
    expect(computeDelay(events, 1, 1)).toBe(MAX_INTER_EVENT_DELAY_MS);
  });

  it("divides delay by speed multiplier", () => {
    // 1 second gap
    const events = [ev("2024-01-01T00:00:00.000Z"), ev("2024-01-01T00:00:01.000Z")];
    expect(computeDelay(events, 1, 1)).toBe(1000);
    expect(computeDelay(events, 1, 2)).toBe(500);
    expect(computeDelay(events, 1, 5)).toBe(200);
    expect(computeDelay(events, 1, 10)).toBe(100);
  });

  it("clamps negative timestamp delta to 0", () => {
    // reversed timestamps
    const events = [ev("2024-01-01T00:00:01Z"), ev("2024-01-01T00:00:00Z")];
    expect(computeDelay(events, 1, 1)).toBe(0);
  });
});

/* ── computeEventDensity ─────────────────────────────────────────────── */

describe("computeEventDensity", () => {
  it("returns [] for empty events", () => {
    expect(computeEventDensity([], 10)).toEqual([]);
  });

  it("returns [] for zero bucket count", () => {
    expect(computeEventDensity([ev("2024-01-01T00:00:00Z")], 0)).toEqual([]);
  });

  it("total count equals events.length", () => {
    const events = [
      ev("2024-01-01T00:00:00Z"),
      ev("2024-01-01T00:00:00.500Z"),
      ev("2024-01-01T00:00:01Z"),
    ];
    const d = computeEventDensity(events, 4);
    const total = d.reduce((s, n) => s + n, 0);
    expect(total).toBe(3);
  });

  it("length equals bucketCount", () => {
    const events = [ev("2024-01-01T00:00:00Z"), ev("2024-01-01T00:00:01Z")];
    expect(computeEventDensity(events, 7)).toHaveLength(7);
  });

  it("all events go in bucket 0 when all share the same timestamp", () => {
    const ts = "2024-01-01T00:00:00Z";
    const events = [ev(ts), ev(ts), ev(ts)];
    const d = computeEventDensity(events, 5);
    expect(d[0]).toBe(3);
    expect(d.slice(1).every((v) => v === 0)).toBe(true);
  });
});

/* ── posToIndex / indexToPos ─────────────────────────────────────────── */

describe("posToIndex", () => {
  it("maps 0 → 0 and 1 → totalEvents", () => {
    expect(posToIndex(10, 0)).toBe(0);
    expect(posToIndex(10, 1)).toBe(10);
  });

  it("rounds to nearest integer", () => {
    expect(posToIndex(10, 0.45)).toBe(5); // 4.5 → 5
    expect(posToIndex(10, 0.44)).toBe(4); // 4.4 → 4
  });

  it("clamps below 0", () => {
    expect(posToIndex(10, -1)).toBe(0);
  });

  it("clamps above totalEvents", () => {
    expect(posToIndex(10, 2)).toBe(10);
  });
});

describe("indexToPos", () => {
  it("maps 0 → 0 and totalEvents → 1", () => {
    expect(indexToPos(10, 0)).toBe(0);
    expect(indexToPos(10, 10)).toBe(1);
  });

  it("returns 0 for totalEvents=0", () => {
    expect(indexToPos(0, 0)).toBe(0);
  });

  it("clamps out-of-range", () => {
    expect(indexToPos(10, -5)).toBe(0);
    expect(indexToPos(10, 20)).toBe(1);
  });
});

/* ── extractAttemptIds ───────────────────────────────────────────────── */

describe("extractAttemptIds", () => {
  it("collects from output, started, and completed events", () => {
    const events = [
      { type: "attempt.output", data: { attempt_id: "a1", chunk: "" } },
      { type: "attempt.started", data: { attempt_id: "a2", stage_id: "s1" } },
      { type: "attempt.completed", data: { attempt_id: "a3", stage_id: "s1" } },
      { type: "run.started", data: { mode: "single" } },
    ];
    const ids = extractAttemptIds(events);
    expect(ids).toContain("a1");
    expect(ids).toContain("a2");
    expect(ids).toContain("a3");
    expect(ids).toHaveLength(3);
  });

  it("deduplicates repeated attempt ids", () => {
    const events = [
      { type: "attempt.output", data: { attempt_id: "a1", chunk: "x" } },
      { type: "attempt.output", data: { attempt_id: "a1", chunk: "y" } },
    ];
    expect(extractAttemptIds(events)).toHaveLength(1);
  });

  it("returns [] when no attempt events present", () => {
    expect(extractAttemptIds([{ type: "run.started", data: {} }])).toHaveLength(0);
  });
});

/* ── latestAttemptCompletedBefore ────────────────────────────────────── */

describe("latestAttemptCompletedBefore", () => {
  const events = [
    { type: "run.started", data: {} },
    { type: "attempt.completed", data: { attempt_id: "a1", stage_id: "s1" } },
    { type: "run.context", data: {} },
    { type: "attempt.completed", data: { attempt_id: "a2", stage_id: "s2" } },
    { type: "run.finalized", data: {} },
  ];

  it("finds the most recent attempt.completed before the cursor", () => {
    expect(latestAttemptCompletedBefore(events, 5)).toBe(3);
    expect(latestAttemptCompletedBefore(events, 3)).toBe(1);
  });

  it("returns -1 when none found", () => {
    expect(latestAttemptCompletedBefore(events, 1)).toBe(-1);
    expect(latestAttemptCompletedBefore(events, 0)).toBe(-1);
  });

  it("returns -1 on empty events", () => {
    expect(latestAttemptCompletedBefore([], 5)).toBe(-1);
  });
});
