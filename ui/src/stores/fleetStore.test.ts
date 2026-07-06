/**
 * Unit tests for fleetStore.
 * Covers: run.created / run.status / run.finalized / budget.tripwire ingest
 * plus idempotent re-ingest and snapshot reference equality.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { fleetStore } from "./fleetStore";

const RUN_A = "run-aaaa-1111";
const RUN_B = "run-bbbb-2222";
const TS1 = "2026-07-01T10:00:00Z";
const TS2 = "2026-07-01T10:00:10Z";

beforeEach(() => {
  fleetStore.reset();
});

/* ── run.created ─────────────────────────────────────────────────────── */

describe("ingestRunCreated", () => {
  it("creates a new fleet entry with status and ts", () => {
    fleetStore.ingestRunCreated(RUN_A, "pending", TS1);
    const snap = fleetStore.getSnapshot();
    const entry = snap.entries.get(RUN_A);
    expect(entry).toBeDefined();
    expect(entry!.status).toBe("pending");
    expect(entry!.lastTs).toBe(TS1);
  });

  it("bumps snapshot version on new entry", () => {
    const v0 = fleetStore.getSnapshot().version;
    fleetStore.ingestRunCreated(RUN_A, "pending", TS1);
    expect(fleetStore.getSnapshot().version).toBeGreaterThan(v0);
  });

  it("idempotent: second call with same run_id does not overwrite richer status", () => {
    fleetStore.ingestRunCreated(RUN_A, "pending", TS1);
    // Simulate run.status arriving (richer)
    fleetStore.ingestRunStatus(RUN_A, "running", TS2);
    const v1 = fleetStore.getSnapshot().version;

    // Replay run.created with old data — should NOT downgrade status
    fleetStore.ingestRunCreated(RUN_A, "pending", TS1);
    const entry = fleetStore.getSnapshot().entries.get(RUN_A);
    expect(entry!.status).toBe("running");
    // Version only bumps if ts is newer, which TS1 is not vs TS2
    // (in this case TS1 < TS2, so no bump expected)
    expect(fleetStore.getSnapshot().version).toBe(v1);
  });

  it("updates lastTs if the new ts is strictly newer", () => {
    fleetStore.ingestRunCreated(RUN_A, "pending", TS1);
    fleetStore.ingestRunStatus(RUN_A, "running", TS2);
    const v1 = fleetStore.getSnapshot().version;
    // Re-ingest run.created with a NEWER ts
    const TS3 = "2026-07-01T10:00:20Z";
    fleetStore.ingestRunCreated(RUN_A, "pending", TS3);
    expect(fleetStore.getSnapshot().entries.get(RUN_A)!.lastTs).toBe(TS3);
    expect(fleetStore.getSnapshot().version).toBeGreaterThan(v1);
  });

  it("multiple runs tracked independently", () => {
    fleetStore.ingestRunCreated(RUN_A, "pending", TS1);
    fleetStore.ingestRunCreated(RUN_B, "running", TS2);
    const snap = fleetStore.getSnapshot();
    expect(snap.entries.size).toBe(2);
    expect(snap.entries.get(RUN_A)!.status).toBe("pending");
    expect(snap.entries.get(RUN_B)!.status).toBe("running");
  });
});

/* ── run.status ─────────────────────────────────────────────────────── */

describe("ingestRunStatus", () => {
  it("creates entry when run not seen before", () => {
    fleetStore.ingestRunStatus(RUN_A, "running", TS1);
    expect(fleetStore.getSnapshot().entries.get(RUN_A)!.status).toBe("running");
  });

  it("updates status on existing entry", () => {
    fleetStore.ingestRunCreated(RUN_A, "pending", TS1);
    fleetStore.ingestRunStatus(RUN_A, "running", TS2);
    expect(fleetStore.getSnapshot().entries.get(RUN_A)!.status).toBe("running");
  });

  it("preserves costUsd when updating status", () => {
    fleetStore.ingestRunCreated(RUN_A, "pending", TS1);
    // Simulate a tripwire that sets costUsd
    fleetStore.ingestBudgetTripwire(`run:${RUN_A}`, 3.5, TS2);
    fleetStore.ingestRunStatus(RUN_A, "running", TS2);
    expect(fleetStore.getSnapshot().entries.get(RUN_A)!.costUsd).toBe(3.5);
  });

  it("idempotent: same status ingested twice does not corrupt", () => {
    fleetStore.ingestRunStatus(RUN_A, "running", TS1);
    fleetStore.ingestRunStatus(RUN_A, "running", TS1);
    expect(fleetStore.getSnapshot().entries.get(RUN_A)!.status).toBe("running");
  });
});

/* ── run.finalized ───────────────────────────────────────────────────── */

describe("ingestRunFinalized", () => {
  it("sets terminal status on existing entry", () => {
    fleetStore.ingestRunCreated(RUN_A, "running", TS1);
    fleetStore.ingestRunFinalized(RUN_A, "complete", TS2);
    expect(fleetStore.getSnapshot().entries.get(RUN_A)!.status).toBe("complete");
  });

  it("creates entry when run was not previously seen", () => {
    fleetStore.ingestRunFinalized(RUN_A, "crashed", TS1);
    expect(fleetStore.getSnapshot().entries.get(RUN_A)!.status).toBe("crashed");
  });

  it("captures abortReason when provided", () => {
    fleetStore.ingestRunFinalized(RUN_A, "aborted", TS1, { abortReason: "budget exceeded" });
    expect(fleetStore.getSnapshot().entries.get(RUN_A)!.abortReason).toBe("budget exceeded");
  });

  it("captures surfacedReason when provided", () => {
    fleetStore.ingestRunFinalized(RUN_A, "surfaced", TS1, { surfacedReason: "gate threshold not met" });
    expect(fleetStore.getSnapshot().entries.get(RUN_A)!.surfacedReason).toBe("gate threshold not met");
  });

  it("idempotent: re-ingesting with same data produces same entry", () => {
    fleetStore.ingestRunFinalized(RUN_A, "complete", TS1);
    const entry1 = fleetStore.getSnapshot().entries.get(RUN_A);
    fleetStore.ingestRunFinalized(RUN_A, "complete", TS1);
    const entry2 = fleetStore.getSnapshot().entries.get(RUN_A);
    expect(entry2!.status).toBe(entry1!.status);
  });

  it("preserves existing fields when finalizing", () => {
    fleetStore.ingestRunCreated(RUN_A, "running", TS1);
    fleetStore.ingestBudgetTripwire(`run:${RUN_A}`, 9.99, TS1);
    fleetStore.ingestRunFinalized(RUN_A, "complete", TS2);
    const entry = fleetStore.getSnapshot().entries.get(RUN_A)!;
    expect(entry.costUsd).toBe(9.99);
    expect(entry.lastTs).toBe(TS2);
  });
});

/* ── budget.tripwire ─────────────────────────────────────────────────── */

describe("ingestBudgetTripwire", () => {
  it("ignores non-run scopes", () => {
    fleetStore.ingestRunCreated(RUN_A, "running", TS1);
    const v0 = fleetStore.getSnapshot().version;
    fleetStore.ingestBudgetTripwire("day:2026-07-01", 5.0, TS2);
    expect(fleetStore.getSnapshot().version).toBe(v0);
  });

  it("ignores run-scoped tripwire for unknown run_id (no ghost entries)", () => {
    fleetStore.ingestBudgetTripwire(`run:${RUN_A}`, 5.0, TS1);
    expect(fleetStore.getSnapshot().entries.size).toBe(0);
  });

  it("enriches existing entry with costUsd", () => {
    fleetStore.ingestRunCreated(RUN_A, "running", TS1);
    fleetStore.ingestBudgetTripwire(`run:${RUN_A}`, 7.77, TS2);
    expect(fleetStore.getSnapshot().entries.get(RUN_A)!.costUsd).toBe(7.77);
  });

  it("updates lastTs when tripwire ts is provided", () => {
    fleetStore.ingestRunCreated(RUN_A, "running", TS1);
    fleetStore.ingestBudgetTripwire(`run:${RUN_A}`, 1.23, TS2);
    expect(fleetStore.getSnapshot().entries.get(RUN_A)!.lastTs).toBe(TS2);
  });
});

/* ── Snapshot reference equality ─────────────────────────────────────── */

describe("snapshot reference equality", () => {
  it("getSnapshot returns identical object reference when no mutation occurs", () => {
    fleetStore.ingestRunCreated(RUN_A, "running", TS1);
    const s1 = fleetStore.getSnapshot();
    const s2 = fleetStore.getSnapshot();
    expect(s1).toBe(s2);
  });

  it("getSnapshot returns new object reference after mutation", () => {
    fleetStore.ingestRunCreated(RUN_A, "running", TS1);
    const s1 = fleetStore.getSnapshot();
    fleetStore.ingestRunStatus(RUN_A, "complete", TS2);
    const s2 = fleetStore.getSnapshot();
    expect(s1).not.toBe(s2);
  });
});

/* ── Subscriber notification ─────────────────────────────────────────── */

describe("subscribe / unsubscribe", () => {
  it("notifies subscriber on ingest", () => {
    let called = 0;
    const unsub = fleetStore.subscribe(() => called++);
    fleetStore.ingestRunCreated(RUN_A, "pending", TS1);
    expect(called).toBe(1);
    unsub();
  });

  it("does not notify after unsubscribe", () => {
    let called = 0;
    const unsub = fleetStore.subscribe(() => called++);
    unsub();
    fleetStore.ingestRunCreated(RUN_A, "pending", TS1);
    expect(called).toBe(0);
  });
});

/* ── reset ───────────────────────────────────────────────────────────── */

describe("reset", () => {
  it("clears all entries and resets version to 0", () => {
    fleetStore.ingestRunCreated(RUN_A, "running", TS1);
    fleetStore.reset();
    const snap = fleetStore.getSnapshot();
    expect(snap.version).toBe(0);
    expect(snap.entries.size).toBe(0);
  });
});
