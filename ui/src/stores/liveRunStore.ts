/**
 * Live-run store. Vanilla (framework-agnostic) so it can ingest SSE frames
 * outside React, exposed to components through useSyncExternalStore.
 *
 * Two concerns live here:
 *
 *   1. Per-attempt append-only LOG BUFFERS. High-frequency `attempt.output`
 *      chunks are folded into a Map<attemptId, LogBuffer>, capped at 5000
 *      lines (oldest dropped), and subscriber notifications are batched to one
 *      requestAnimationFrame so a burst of chunks causes at most one render.
 *
 *   2. A lightweight LIVE OVERLAY keyed by run_id: the most recent status,
 *      stage/attempt/verdict deltas, Borda rankings, and rolling budget — the
 *      things a screen wants to reflect immediately without refetching.
 *
 * The buffer object identity is swapped on every mutation so
 * useSyncExternalStore's getSnapshot can rely on reference equality.
 */
import type {
  RunSseEvent,
  RunStatus,
  StageStatus,
  VerdictOutcome,
} from "@shared/api-types";

export const LOG_CAP = 5000;

export interface LogBuffer {
  lines: string[];
  /** Bumped on every mutation — also the getSnapshot identity signal. */
  seq: number;
  /** Count of lines dropped off the front due to the cap. */
  dropped: number;
}

export interface BordaRanking {
  attempt_id: string;
  points: number;
  rank: number;
}

export interface LiveRunOverlay {
  runId: string;
  status: RunStatus | null;
  /** stage_id → latest status. */
  stageStatus: Record<string, StageStatus>;
  stageWinner: Record<string, string | null>;
  /** attempt_id → latest status string. */
  attemptStatus: Record<string, string>;
  /** attempt_id → latest verdict outcome. */
  verdicts: Record<string, VerdictOutcome>;
  /** stage_id → Borda ranking. */
  borda: Record<string, BordaRanking[]>;
  /** Rolling run cost from budget.tick (scope run:<id>). */
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** Monotonic overlay version for getSnapshot identity. */
  version: number;
}

const EMPTY_BUFFER: LogBuffer = { lines: [], seq: 0, dropped: 0 };

function freshOverlay(runId: string): LiveRunOverlay {
  return {
    runId,
    status: null,
    stageStatus: {},
    stageWinner: {},
    attemptStatus: {},
    verdicts: {},
    borda: {},
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    version: 0,
  };
}

class LiveRunStore {
  private logs = new Map<string, LogBuffer>();
  private logListeners = new Map<string, Set<() => void>>();

  private overlays = new Map<string, LiveRunOverlay>();
  private overlayListeners = new Map<string, Set<() => void>>();

  private dirtyLogs = new Set<string>();
  private dirtyOverlays = new Set<string>();
  private raf: number | null = null;

  /* ── logs ──────────────────────────────────────────────────────────── */

  getLog(attemptId: string): LogBuffer {
    return this.logs.get(attemptId) ?? EMPTY_BUFFER;
  }

  subscribeLog(attemptId: string, cb: () => void): () => void {
    let set = this.logListeners.get(attemptId);
    if (!set) {
      set = new Set();
      this.logListeners.set(attemptId, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
    };
  }

  /** Append a raw output chunk (may contain 0+ newlines, may be partial). */
  appendLog(attemptId: string, chunk: string): void {
    if (!chunk) return;
    const prev = this.logs.get(attemptId) ?? EMPTY_BUFFER;
    const lines = prev.lines.slice();

    const parts = chunk.split("\n");
    // First part continues the current (partial) last line.
    if (lines.length === 0) {
      lines.push(parts[0] ?? "");
    } else {
      lines[lines.length - 1] = (lines[lines.length - 1] ?? "") + (parts[0] ?? "");
    }
    for (let i = 1; i < parts.length; i++) {
      lines.push(parts[i] ?? "");
    }

    let dropped = prev.dropped;
    if (lines.length > LOG_CAP) {
      const overflow = lines.length - LOG_CAP;
      lines.splice(0, overflow);
      dropped += overflow;
    }

    this.logs.set(attemptId, { lines, seq: prev.seq + 1, dropped });
    this.dirtyLogs.add(attemptId);
    this.schedule();
  }

  clearLog(attemptId: string): void {
    this.logs.delete(attemptId);
    this.dirtyLogs.add(attemptId);
    this.schedule();
  }

  /* ── overlay ───────────────────────────────────────────────────────── */

  getOverlay(runId: string): LiveRunOverlay {
    let o = this.overlays.get(runId);
    if (!o) {
      o = freshOverlay(runId);
      this.overlays.set(runId, o);
    }
    return o;
  }

  subscribeOverlay(runId: string, cb: () => void): () => void {
    let set = this.overlayListeners.get(runId);
    if (!set) {
      set = new Set();
      this.overlayListeners.set(runId, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
    };
  }

  /** Fold a run-scoped SSE event into the overlay + log buffers. */
  ingest(runId: string, ev: RunSseEvent): void {
    const base = this.overlays.get(runId) ?? freshOverlay(runId);
    const next: LiveRunOverlay = { ...base, version: base.version + 1 };

    switch (ev.type) {
      case "stage.started":
        next.stageStatus = { ...next.stageStatus, [ev.data.id]: ev.data.status };
        break;
      case "stage.finalized":
        next.stageStatus = { ...next.stageStatus, [ev.data.stage_id]: ev.data.status };
        next.stageWinner = { ...next.stageWinner, [ev.data.stage_id]: ev.data.winner_attempt_id };
        break;
      case "attempt.started":
        next.attemptStatus = { ...next.attemptStatus, [ev.data.id]: ev.data.status };
        break;
      case "attempt.completed":
        next.attemptStatus = { ...next.attemptStatus, [ev.data.id]: ev.data.status };
        break;
      case "attempt.output":
        this.appendLog(ev.data.attempt_id, ev.data.chunk);
        return; // no overlay change
      case "verdict.recorded":
        next.verdicts = { ...next.verdicts, [ev.data.attempt_id]: ev.data.outcome };
        break;
      case "verdict.retracted": {
        const v = { ...next.verdicts };
        delete v[ev.data.attempt_id];
        next.verdicts = v;
        break;
      }
      case "borda.updated":
        next.borda = { ...next.borda, [ev.data.stage_id]: ev.data.ranking };
        break;
      case "budget.tick":
        if (ev.data.scope === `run:${runId}`) {
          next.costUsd = ev.data.cost_usd;
          next.tokensIn = ev.data.tokens_in;
          next.tokensOut = ev.data.tokens_out;
        }
        break;
      case "run.finalized":
        next.status = ev.data.status;
        break;
      case "reflexion.retry":
      case "smoke.status":
      case "validation.result":
      case "missability.result":
        // Recorded via version bump so subscribers can refetch detail.
        break;
    }

    this.overlays.set(runId, next);
    this.dirtyOverlays.add(runId);
    this.schedule();
  }

  setStatus(runId: string, status: RunStatus): void {
    const base = this.overlays.get(runId) ?? freshOverlay(runId);
    this.overlays.set(runId, { ...base, status, version: base.version + 1 });
    this.dirtyOverlays.add(runId);
    this.schedule();
  }

  /* ── rAF-batched notify ────────────────────────────────────────────── */

  private schedule(): void {
    if (this.raf != null) return;
    const run = () => {
      this.raf = null;
      const logs = this.dirtyLogs;
      const overlays = this.dirtyOverlays;
      this.dirtyLogs = new Set();
      this.dirtyOverlays = new Set();
      for (const id of logs) this.logListeners.get(id)?.forEach((cb) => cb());
      for (const id of overlays) this.overlayListeners.get(id)?.forEach((cb) => cb());
    };
    if (typeof requestAnimationFrame === "function") {
      this.raf = requestAnimationFrame(run);
    } else {
      this.raf = setTimeout(run, 16) as unknown as number;
    }
  }

  /** Test / teardown helper. */
  reset(): void {
    this.logs.clear();
    this.overlays.clear();
    this.dirtyLogs.clear();
    this.dirtyOverlays.clear();
  }
}

export const liveRunStore = new LiveRunStore();
