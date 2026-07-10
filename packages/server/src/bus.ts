/**
 * Event bus seam for SSE.
 *
 * The server defines a minimal {@link BusPort} interface so the run pilot's real
 * event bus can plug in later (M5d) WITHOUT the server importing @pp/pilot now.
 * A default in-memory bus is provided so server-originated events (doctor.result,
 * janitor.result) and Last-Event-ID replay work out of the box; the pilot will
 * inject its own bus that also carries run/stage/attempt frames.
 */

import { db } from "@pp/core";
import { ppEventsPublished } from "./metrics.js";

/** One SSE frame. `seq` is monotonic per bus; `run_id` present on run-scoped frames. */
export interface SseFrame<TData = unknown> {
  type: string;
  run_id?: string;
  ts: string;
  seq: number;
  data: TData;
}

/** Input to publish — seq/ts are assigned by the bus. */
export interface SsePublish<TData = unknown> {
  type: string;
  run_id?: string;
  data: TData;
  ts?: string;
}

export interface BusPort {
  /** Subscribe to live frames. Returns an unsubscribe fn. */
  subscribe(fn: (frame: SseFrame) => void): () => void;
  /**
   * Recent frames for replay. `afterSeq` filters to seq > afterSeq (Last-Event-ID
   * resume); `runId` filters to that run's frames.
   */
  ringBuffer(opts?: { runId?: string; afterSeq?: number }): SseFrame[];
  /** Publish a frame; returns the stamped frame. */
  publish(input: SsePublish): SseFrame;
}

// Raised from 512 to hold late-joiner backfill through a live attempt.output
// stream: high-frequency output frames can otherwise evict run/stage frames
// from the replay ring before a client reconnects.
const DEFAULT_RING = 2048;

function scrubEventValue(value: unknown, key?: string): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (key && /(?:api[_-]?key|api_?token|access_?token|refresh_?token|bearer_?token|authorization|secret)/i.test(key)) {
      return "[REDACTED]";
    }
    return value
      .replace(/\b(?:sk|pk|ghp|ghs|xoxb|AIza)[-_A-Za-z0-9]{10,}\b/g, "[REDACTED]")
      .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) return value.map((entry) => scrubEventValue(entry));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubEventValue(v, k);
    return out;
  }
  return value;
}

function persistFrame(frame: SseFrame): void {
  try {
    db()
      .prepare(`INSERT INTO events(run_id, event_type, payload, seq, ts) VALUES (?, ?, ?, ?, ?)`)
      .run(frame.run_id ?? null, frame.type, JSON.stringify(frame.data), frame.seq, frame.ts);
  } catch {
    /* observability persistence must never break live delivery */
  }
}

export function createInMemoryBus(ringSize = DEFAULT_RING): BusPort {
  let seq = 0;
  const ring: SseFrame[] = [];
  const subscribers = new Set<(frame: SseFrame) => void>();

  return {
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    ringBuffer(opts) {
      const afterSeq = opts?.afterSeq ?? 0;
      const runId = opts?.runId;
      return ring.filter((f) => f.seq > afterSeq && (runId === undefined || f.run_id === runId));
    },
    publish(input) {
      const frame: SseFrame = {
        type: input.type,
        run_id: input.run_id,
        ts: input.ts ?? new Date().toISOString(),
        seq: ++seq,
        data: scrubEventValue(input.data),
      };
      persistFrame(frame);
      try { ppEventsPublished.inc(); } catch { /* metrics must not break the bus */ }
      ring.push(frame);
      if (ring.length > ringSize) ring.shift();
      for (const fn of subscribers) {
        try {
          fn(frame);
        } catch {
          /* a bad subscriber must not break the bus */
        }
      }
      return frame;
    },
  };
}

/** A bus that drops everything — used when no eventing is desired. */
export const noopBus: BusPort = {
  subscribe() {
    return () => {};
  },
  ringBuffer() {
    return [];
  },
  publish(input) {
    return { type: input.type, run_id: input.run_id, ts: input.ts ?? new Date().toISOString(), seq: 0, data: input.data };
  },
};

/** Test helper: an in-memory bus pre-seeded with frames (seq assigned in order). */
export function seededBus(frames: SsePublish[]): BusPort {
  const bus = createInMemoryBus();
  for (const f of frames) bus.publish(f);
  return bus;
}
