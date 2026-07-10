/**
 * replayMachine — pure, framework-agnostic functions for replay cursor, pacing,
 * and event-density logic. All functions are unit-testable without React or the
 * store.
 */

/** Maximum wall-clock delay at 1× speed (ms). Prevents idle gaps longer than
 *  2 s from stalling replay at real-time pace. */
export const MAX_INTER_EVENT_DELAY_MS = 2000;

/** Supported speed multipliers. `null` means "max" (no delay between events). */
export type ReplaySpeed = 1 | 2 | 5 | 10 | null;

export const SPEED_OPTIONS: Array<{ label: string; value: ReplaySpeed }> = [
  { label: "1×", value: 1 },
  { label: "2×", value: 2 },
  { label: "5×", value: 5 },
  { label: "10×", value: 10 },
  { label: "max", value: null },
];

/**
 * Compute the delay (ms) to wait before ingesting the event at `nextIdx`.
 *
 * Rules:
 * - First event (nextIdx === 0): 0 — start immediately.
 * - speed === null (max): 0 — no delay.
 * - Otherwise: clamp the inter-event timestamp delta to MAX_INTER_EVENT_DELAY_MS,
 *   then divide by the speed multiplier.
 */
export function computeDelay(
  events: ReadonlyArray<{ ts: string }>,
  nextIdx: number,
  speed: ReplaySpeed,
): number {
  if (speed === null || nextIdx === 0 || nextIdx >= events.length) return 0;
  const prev = events[nextIdx - 1];
  const next = events[nextIdx];
  if (!prev || !next) return 0;
  const deltaMs = Date.parse(next.ts) - Date.parse(prev.ts);
  const cappedMs = Math.min(Math.max(deltaMs, 0), MAX_INTER_EVENT_DELAY_MS);
  return cappedMs / speed;
}

/**
 * Compute an event-density histogram for the scrubber strip.
 *
 * Returns `bucketCount` non-negative integers, each counting the events whose
 * timestamp falls in that fractional time bucket.
 */
export function computeEventDensity(
  events: ReadonlyArray<{ ts: string }>,
  bucketCount: number,
): number[] {
  if (events.length === 0 || bucketCount <= 0) return [];
  const buckets = new Array<number>(bucketCount).fill(0);
  const firstMs = Date.parse(events[0]!.ts);
  const lastMs = Date.parse(events[events.length - 1]!.ts);
  const rangeMs = lastMs - firstMs || 1;
  for (const ev of events) {
    const t = Date.parse(ev.ts);
    const b = Math.min(
      Math.floor(((t - firstMs) / rangeMs) * bucketCount),
      bucketCount - 1,
    );
    (buckets[b] as number)++;
  }
  return buckets;
}

/**
 * Convert a fractional scrubber position [0, 1] to an event index [0, totalEvents].
 * Clamped to stay in range.
 */
export function posToIndex(totalEvents: number, pos: number): number {
  return Math.max(0, Math.min(totalEvents, Math.round(pos * totalEvents)));
}

/**
 * Convert an event index [0, totalEvents] to a fractional scrubber position [0, 1].
 */
export function indexToPos(totalEvents: number, idx: number): number {
  if (totalEvents === 0) return 0;
  return Math.max(0, Math.min(1, idx / totalEvents));
}

/**
 * Collect every unique attempt ID found in `attempt.output`, `attempt.started`,
 * and `attempt.completed` events. Used to identify log buffers to clear before a
 * replay re-ingest.
 */
export function extractAttemptIds(
  events: ReadonlyArray<{ type: string; data: unknown }>,
): string[] {
  const ids = new Set<string>();
  for (const ev of events) {
    if (
      ev.type === "attempt.output" ||
      ev.type === "attempt.started" ||
      ev.type === "attempt.completed"
    ) {
      const d = ev.data as { attempt_id?: string };
      if (d.attempt_id) ids.add(d.attempt_id);
    }
  }
  return [...ids];
}

/**
 * Find the index of the most recent `attempt.completed` event at or before
 * `cursorIdx - 1` (i.e., among already-ingested events).
 * Returns -1 when none found.
 */
export function latestAttemptCompletedBefore(
  events: ReadonlyArray<{ type: string; data: unknown }>,
  cursorIdx: number,
): number {
  for (let i = cursorIdx - 1; i >= 0; i--) {
    if (events[i]?.type === "attempt.completed") return i;
  }
  return -1;
}
