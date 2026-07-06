/**
 * Fleet store — vanilla (framework-agnostic) store for the global run fleet.
 *
 * Fed exclusively from the GLOBAL SSE stream events:
 *   run.created, run.status, run.finalized, budget.tripwire
 *
 * Each entry tracks a run_id → FleetEntry. Reference-equality snapshotting
 * via a top-level version counter means useSyncExternalStore won't re-render
 * when the snapshot object hasn't changed structurally.
 *
 * Replay-idempotent: ingestRunCreated / ingestRunStatus / ingestRunFinalized
 * may be called multiple times for the same run without corrupting state.
 */
import type { RunStatus } from "@shared/api-types";

export interface FleetEntry {
  runId: string;
  status: RunStatus;
  /** Latest absolute cost from budget.tripwire or run.finalized context (if present). */
  costUsd?: number;
  /** ISO timestamp of the most recent event ingested for this run. */
  lastTs?: string;
  /** Reason text when the run was surfaced (from run.finalized surfaced_reason). */
  surfacedReason?: string;
  /** Abort reason (from run.finalized abort_reason). */
  abortReason?: string;
}

export interface FleetSnapshot {
  /** Monotonic version — identity signal for useSyncExternalStore. */
  version: number;
  /** Immutable map copy — keyed by run_id. */
  entries: ReadonlyMap<string, FleetEntry>;
}

/* ── Store class ─────────────────────────────────────────────────────── */

class FleetStore {
  private entries = new Map<string, FleetEntry>();
  private _version = 0;
  private listeners = new Set<() => void>();
  private _snapshot: FleetSnapshot = { version: 0, entries: new Map() };

  /** Subscribe to any change. Returns an unsubscribe function. */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Stable snapshot for useSyncExternalStore. Only changes identity on mutation. */
  getSnapshot(): FleetSnapshot {
    return this._snapshot;
  }

  /* ── Ingest methods ─────────────────────────────────────────────────── */

  /** Ingest run.created (RunSummary data from global stream). */
  ingestRunCreated(runId: string, status: RunStatus, ts?: string): void {
    // Idempotent: don't overwrite a richer entry that arrived via run.status/finalized
    const existing = this.entries.get(runId);
    if (existing) {
      // Already know about this run — only update ts if newer
      if (ts && (!existing.lastTs || ts > existing.lastTs)) {
        this.entries.set(runId, { ...existing, lastTs: ts });
        this._bump();
      }
      return;
    }
    this.entries.set(runId, {
      runId,
      status,
      lastTs: ts,
    });
    this._bump();
  }

  /** Ingest run.status from global stream. */
  ingestRunStatus(runId: string, status: RunStatus, ts?: string): void {
    const existing = this.entries.get(runId);
    const entry: FleetEntry = {
      ...(existing ?? { runId }),
      runId,
      status,
      ...(ts ? { lastTs: ts } : {}),
    };
    // Keep existing lastTs if no new ts provided
    if (!ts && existing?.lastTs) entry.lastTs = existing.lastTs;
    this.entries.set(runId, entry);
    this._bump();
  }

  /**
   * Ingest run.finalized from global stream.
   * abort_reason and surfaced_reason are optional on the global finalized event.
   */
  ingestRunFinalized(
    runId: string,
    status: RunStatus,
    ts?: string,
    opts?: { abortReason?: string; surfacedReason?: string },
  ): void {
    const existing = this.entries.get(runId);
    const entry: FleetEntry = {
      ...(existing ?? { runId }),
      runId,
      status,
    };
    if (ts) entry.lastTs = ts;
    if (opts?.abortReason) entry.abortReason = opts.abortReason;
    if (opts?.surfacedReason) entry.surfacedReason = opts.surfacedReason;
    this.entries.set(runId, entry);
    this._bump();
  }

  /**
   * Ingest budget.tripwire. Scope is e.g. "run:<id>" — parse the run_id from
   * the scope prefix. Ignores non-run-scoped tripwires.
   */
  ingestBudgetTripwire(scope: string, costUsd: number, ts?: string): void {
    if (!scope.startsWith("run:")) return;
    const runId = scope.slice("run:".length);
    if (!runId) return;
    const existing = this.entries.get(runId);
    if (!existing) return; // Only enrich existing entries; don't create ghost entries
    this.entries.set(runId, {
      ...existing,
      costUsd,
      ...(ts ? { lastTs: ts } : {}),
    });
    this._bump();
  }

  /* ── Private ─────────────────────────────────────────────────────────── */

  private _bump(): void {
    this._version += 1;
    // Swap snapshot — new Map from current entries (immutable view)
    this._snapshot = { version: this._version, entries: new Map(this.entries) };
    for (const cb of this.listeners) cb();
  }

  /** Test / teardown helper. */
  reset(): void {
    this.entries.clear();
    this._version = 0;
    this._snapshot = { version: 0, entries: new Map() };
    for (const cb of this.listeners) cb();
  }
}

export const fleetStore = new FleetStore();
