/**
 * Typed event bus for the pilot lifecycle.
 *
 * The daemon-era harness surfaced run progress by polling the SQLite ledger.
 * The in-process pilot instead emits a structured event stream that the CLI
 * (bin/ppp.ts), the future SSE server (M5), and tests subscribe to. Every
 * event carries a per-run monotonic `seq` so a late joiner can replay from a
 * ring buffer and then follow live without gaps or duplicates.
 *
 * No external dependencies — this is a plain emitter plus a bounded backfill
 * buffer keyed by run_id.
 */

/** The closed set of event names the pilot emits. */
export type PilotEventType =
  | "run.started"
  | "run.context"
  | "run.finalized"
  | "stage.started"
  | "stage.finalized"
  | "stage.surfaced"
  | "attempt.started"
  | "attempt.output"
  | "attempt.completed"
  | "verdict.recorded"
  | "verdict.retracted"
  | "reflexion.retry"
  | "gate.blocked"
  | "borda.updated"
  | "smoke.status"
  | "validation.result"
  | "missability.result"
  | "budget.tick"
  | "budget.tripwire"
  | "janitor.swept"
  | "phase.completed";

export interface PilotEvent {
  type: PilotEventType;
  run_id: string;
  stage_id?: string;
  attempt_id?: string;
  /** ISO-8601 wall-clock timestamp. */
  ts: string;
  /** Per-run monotonic sequence number, starting at 1. */
  seq: number;
  /** Arbitrary event-specific payload. */
  data: Record<string, unknown>;
}

export type PilotEventListener = (event: PilotEvent) => void;

/** Fields the caller supplies; ts/seq are stamped by the bus. */
export type EmitInput = {
  type: PilotEventType;
  run_id: string;
  stage_id?: string;
  attempt_id?: string;
  data?: Record<string, unknown>;
};

const RING_CAPACITY = 1000;

/**
 * A per-run monotonic sequence + a bounded ring buffer of recent events for
 * late-join backfill. One EventBus instance can carry many runs; sequences
 * and ring buffers are namespaced by run_id.
 */
export class EventBus {
  private readonly listeners = new Set<PilotEventListener>();
  private readonly seqByRun = new Map<string, number>();
  private readonly ringByRun = new Map<string, PilotEvent[]>();

  /** Subscribe to all future events. Returns an unsubscribe function. */
  subscribe(listener: PilotEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Subscribe AND immediately replay the ring buffer for `run_id` (events with
   * seq > `afterSeq`). Ordering guarantee: backfilled events are delivered
   * before any live event, so a consumer never sees seq gaps.
   */
  subscribeWithBackfill(
    run_id: string,
    listener: PilotEventListener,
    afterSeq = 0,
  ): () => void {
    for (const ev of this.backfill(run_id, afterSeq)) listener(ev);
    return this.subscribe(listener);
  }

  /** Stamp ts + a per-run monotonic seq, buffer, and fan out to listeners. */
  emit(input: EmitInput): PilotEvent {
    const seq = (this.seqByRun.get(input.run_id) ?? 0) + 1;
    this.seqByRun.set(input.run_id, seq);
    const event: PilotEvent = {
      type: input.type,
      run_id: input.run_id,
      stage_id: input.stage_id,
      attempt_id: input.attempt_id,
      ts: new Date().toISOString(),
      seq,
      data: input.data ?? {},
    };
    this.pushRing(event);
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A misbehaving listener must never break the driver or other listeners.
      }
    }
    return event;
  }

  /** Events for `run_id` with seq strictly greater than `afterSeq`, in order. */
  backfill(run_id: string, afterSeq = 0): PilotEvent[] {
    const ring = this.ringByRun.get(run_id);
    if (!ring) return [];
    return ring.filter((e) => e.seq > afterSeq);
  }

  /** Current sequence number for a run (0 if none emitted yet). */
  currentSeq(run_id: string): number {
    return this.seqByRun.get(run_id) ?? 0;
  }

  private pushRing(event: PilotEvent): void {
    let ring = this.ringByRun.get(event.run_id);
    if (!ring) {
      ring = [];
      this.ringByRun.set(event.run_id, ring);
    }
    ring.push(event);
    if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
  }
}
