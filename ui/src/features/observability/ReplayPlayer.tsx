/**
 * ReplayPlayer — time-travel debugging control bar for finished runs.
 *
 * Shown only when `run.finished_at` is set. When replay mode is engaged:
 *   1. The run's liveRunStore overlay is reset to a clean slate.
 *   2. Events are re-ingested one by one, paced by their original inter-event
 *      deltas (scaled by speed, capped at 2 s at 1×).
 *   3. Clicking the timeline scrubber re-ingests synchronously from event 0 to
 *      the target seq (deterministic time-travel).
 *   4. When an attempt.completed event is crossed, the attempt is surfaced in a
 *      side panel (Drawer + DiffView) when artifact content is available.
 *   5. Exiting replay re-ingests the full event log to restore end-state.
 *
 * Keyboard: Space (play/pause), ArrowLeft/Right (step), Home/End (jump).
 * Keys are ignored while focus is in an input, textarea, or select.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunTree, EventLogEntry } from "@shared/api-types";
import { liveRunStore } from "@/stores/liveRunStore";
import { useContent } from "@/api/queries/content.js";
import { DiffView } from "@/components/DiffView.js";
import { Drawer } from "@/components/Drawer.js";
import { cn } from "@/lib/cn.js";
import {
  computeDelay,
  computeEventDensity,
  extractAttemptIds,
  indexToPos,
  latestAttemptCompletedBefore,
  SPEED_OPTIONS,
  type ReplaySpeed,
} from "./replayMachine.js";

/* ── Types ───────────────────────────────────────────────────────────── */

export interface ReplayPlayerProps {
  runId: string;
  /** Full persisted event log (paginated by useRunEventLogFull). May be empty
   *  while still loading — the enter-replay button is disabled in that case. */
  events: EventLogEntry[];
  /** Whether events are still loading. */
  loading: boolean;
  /** The full run tree, used to look up artifacts for the diff panel. */
  tree: RunTree;
  /** Called when replay mode is entered (true) or exited (false). The parent
   *  must gate its own hydration effect on !isReplayActive to avoid races. */
  onActiveChange: (active: boolean) => void;
}

/* ── Density strip ───────────────────────────────────────────────────── */

const DENSITY_BUCKETS = 80;

function DensityStrip({
  events,
  cursorPos,
}: {
  events: EventLogEntry[];
  cursorPos: number;
}) {
  const density = useMemo(
    () => computeEventDensity(events as Array<{ ts: string }>, DENSITY_BUCKETS),
    [events],
  );
  const max = useMemo(() => Math.max(1, ...density), [density]);

  return (
    <div
      className="relative flex h-4 w-full items-end gap-px overflow-hidden rounded-sm bg-bg-2"
      aria-hidden
    >
      {density.map((count, i) => {
        const frac = count / max;
        const bucketPos = i / DENSITY_BUCKETS;
        const isPlayed = bucketPos < cursorPos;
        return (
          <div
            key={i}
            className={cn(
              "w-full flex-1 rounded-t-[1px] transition-none",
              isPlayed ? "bg-accent" : "bg-line-2",
            )}
            style={{ height: `${Math.max(frac * 100, 4)}%` }}
          />
        );
      })}
    </div>
  );
}

/* ── Attempt diff side panel ─────────────────────────────────────────── */

interface DiffPanelProps {
  open: boolean;
  onClose: () => void;
  attemptId: string | null;
  stageId: string | null;
  tree: RunTree;
}

function DiffPanel({ open, onClose, attemptId, stageId, tree }: DiffPanelProps) {
  // Find the first artifact for this stage that is likely code/diff.
  const artifact = useMemo(() => {
    if (!stageId) return undefined;
    return tree.artifacts.find(
      (a) =>
        a.stage_id === stageId &&
        (a.kind === "diff" || a.kind === "code" || a.path.endsWith(".diff") || a.path.endsWith(".patch")),
    );
  }, [stageId, tree.artifacts]);

  const { data: content } = useContent(
    artifact?.path,
    artifact ? { runId: tree.run.id } : undefined,
  );

  const isDiff =
    content?.kind === "diff" ||
    content?.path.endsWith(".diff") ||
    content?.path.endsWith(".patch");

  const title = attemptId
    ? `Attempt diff · ${attemptId.slice(0, 12)}`
    : "Attempt diff";

  if (!open) return null;

  return (
    <Drawer open={open} onClose={onClose} title={title} width={560}>
      {!artifact ? (
        <p className="text-[12px] text-ink-3">No diff artifact found for this attempt.</p>
      ) : !content ? (
        <p className="text-[12px] text-ink-3">Loading artifact…</p>
      ) : isDiff ? (
        <DiffView patch={content.content} />
      ) : (
        <pre className="mono overflow-auto whitespace-pre-wrap text-[11px] text-ink-2">
          {content.content}
        </pre>
      )}
    </Drawer>
  );
}

/* ── Main component ──────────────────────────────────────────────────── */

export function ReplayPlayer({
  runId,
  events,
  loading,
  tree,
  onActiveChange,
}: ReplayPlayerProps) {
  const [isActive, setIsActive] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [cursorIdx, setCursorIdx] = useState(0);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const [diffAttemptId, setDiffAttemptId] = useState<string | null>(null);
  const [diffStageId, setDiffStageId] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);

  // Stable ref to current cursor for use in timer callbacks.
  const cursorRef = useRef(0);
  const isPlayingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const attemptIds = useMemo(() => extractAttemptIds(events as Array<{ type: string; data: unknown }>), [events]);

  /* ── Store helpers ───────────────────────────────────────────────── */

  const resetStoreForRun = useCallback(() => {
    liveRunStore.resetRun(runId);
    liveRunStore.clearLogs(attemptIds);
  }, [runId, attemptIds]);

  /** Synchronously ingest events[0..upTo] (exclusive). Returns the latest
   *  attempt.completed index found (for diff overlay). */
  const ingestUpTo = useCallback(
    (upTo: number): number => {
      let lastCompletedIdx = -1;
      for (let i = 0; i < upTo; i++) {
        const e = events[i];
        if (e) {
          liveRunStore.ingest(runId, e as EventLogEntry);
          if (e.type === "attempt.completed") lastCompletedIdx = i;
        }
      }
      return lastCompletedIdx;
    },
    [events, runId],
  );

  /** Update diff overlay based on the most recent attempt.completed in [0, cursorIdx). */
  const syncDiffState = useCallback(
    (idx: number) => {
      const completedEvIdx = latestAttemptCompletedBefore(
        events as Array<{ type: string; data: unknown }>,
        idx,
      );
      if (completedEvIdx >= 0) {
        const ev = events[completedEvIdx];
        const d = (ev as { data: { attempt_id?: string; stage_id?: string } }).data;
        setDiffAttemptId(d.attempt_id ?? null);
        setDiffStageId(d.stage_id ?? null);
      } else {
        setDiffAttemptId(null);
        setDiffStageId(null);
      }
    },
    [events],
  );

  /* ── Enter / exit replay ─────────────────────────────────────────── */

  const enterReplay = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    resetStoreForRun();
    setCursorIdx(0);
    cursorRef.current = 0;
    isPlayingRef.current = false;
    setIsPlaying(false);
    setDiffAttemptId(null);
    setDiffStageId(null);
    setDiffOpen(false);
    setIsActive(true);
    onActiveChange(true);
  }, [resetStoreForRun, onActiveChange]);

  const exitReplay = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    isPlayingRef.current = false;
    setIsPlaying(false);
    setIsActive(false);
    setDiffOpen(false);
    onActiveChange(false);
    // Restore full end-state: reset and re-ingest all events.
    resetStoreForRun();
    for (const e of events) {
      liveRunStore.ingest(runId, e as EventLogEntry);
    }
  }, [resetStoreForRun, events, runId, onActiveChange]);

  /* ── Scrubber jump (deterministic time-travel) ───────────────────── */

  const jumpTo = useCallback(
    (targetIdx: number) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      isPlayingRef.current = false;
      setIsPlaying(false);
      const clamped = Math.max(0, Math.min(events.length, targetIdx));
      resetStoreForRun();
      ingestUpTo(clamped);
      setCursorIdx(clamped);
      cursorRef.current = clamped;
      syncDiffState(clamped);
    },
    [events.length, resetStoreForRun, ingestUpTo, syncDiffState],
  );

  /* ── Timed playback ─────────────────────────────────────────────── */

  const scheduleNext = useCallback(
    (fromIdx: number) => {
      if (!isPlayingRef.current || fromIdx >= events.length) {
        isPlayingRef.current = false;
        setIsPlaying(false);
        return;
      }
      const ev = events[fromIdx];
      if (!ev) {
        isPlayingRef.current = false;
        setIsPlaying(false);
        return;
      }
      const delay = computeDelay(events as Array<{ ts: string }>, fromIdx, speed);
      timerRef.current = setTimeout(() => {
        if (!isPlayingRef.current) return;
        liveRunStore.ingest(runId, ev as EventLogEntry);
        const nextIdx = fromIdx + 1;
        cursorRef.current = nextIdx;
        setCursorIdx(nextIdx);
        // Track attempt.completed for diff overlay.
        if (ev.type === "attempt.completed") {
          const d = (ev as { data: { attempt_id?: string; stage_id?: string } }).data;
          setDiffAttemptId(d.attempt_id ?? null);
          setDiffStageId(d.stage_id ?? null);
          setDiffOpen(true);
        }
        scheduleNext(nextIdx);
      }, delay);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, runId, speed],
  );

  const play = useCallback(() => {
    if (cursorRef.current >= events.length) {
      // At the end — restart.
      resetStoreForRun();
      setCursorIdx(0);
      cursorRef.current = 0;
      setDiffAttemptId(null);
      setDiffStageId(null);
      setDiffOpen(false);
    }
    isPlayingRef.current = true;
    setIsPlaying(true);
    scheduleNext(cursorRef.current);
  }, [events.length, resetStoreForRun, scheduleNext]);

  const pause = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    isPlayingRef.current = false;
    setIsPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, pause, play]);

  // Stop and restart the timer when speed changes mid-play.
  const prevSpeedRef = useRef(speed);
  useEffect(() => {
    if (prevSpeedRef.current !== speed && isPlayingRef.current) {
      if (timerRef.current) clearTimeout(timerRef.current);
      scheduleNext(cursorRef.current);
    }
    prevSpeedRef.current = speed;
  }, [speed, scheduleNext]);

  // Cleanup timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  /* ── Step forward / backward one event ──────────────────────────── */

  const stepForward = useCallback(() => {
    const idx = cursorRef.current;
    if (idx >= events.length) return;
    pause();
    const ev = events[idx];
    if (ev) {
      liveRunStore.ingest(runId, ev as EventLogEntry);
      if (ev.type === "attempt.completed") {
        const d = (ev as { data: { attempt_id?: string; stage_id?: string } }).data;
        setDiffAttemptId(d.attempt_id ?? null);
        setDiffStageId(d.stage_id ?? null);
        setDiffOpen(true);
      }
    }
    const nextIdx = idx + 1;
    cursorRef.current = nextIdx;
    setCursorIdx(nextIdx);
  }, [events, runId, pause]);

  const stepBack = useCallback(() => {
    const idx = cursorRef.current;
    if (idx <= 0) return;
    pause();
    jumpTo(idx - 1);
  }, [pause, jumpTo]);

  /* ── Keyboard shortcuts ─────────────────────────────────────────── */

  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      switch (e.key) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          stepBack();
          break;
        case "ArrowRight":
          e.preventDefault();
          stepForward();
          break;
        case "Home":
          e.preventDefault();
          jumpTo(0);
          break;
        case "End":
          e.preventDefault();
          jumpTo(events.length);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, togglePlay, stepBack, stepForward, jumpTo, events.length]);

  /* ── Derived display values ─────────────────────────────────────── */

  const cursorPos = indexToPos(events.length, cursorIdx);
  const pct = events.length > 0 ? Math.round((cursorIdx / events.length) * 100) : 0;

  /* ── Render ─────────────────────────────────────────────────────── */

  if (!isActive) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-line-1 bg-bg-2 px-3 py-2">
        <span className="mono text-[11px] text-ink-3">replay</span>
        <button
          type="button"
          disabled={loading || events.length === 0}
          onClick={enterReplay}
          className={cn(
            "mono rounded border border-line-2 px-2 py-0.5 text-[11px] transition-colors",
            loading || events.length === 0
              ? "cursor-not-allowed text-ink-3 opacity-50"
              : "text-accent hover:border-accent",
          )}
          title={
            loading
              ? "Loading event log…"
              : events.length === 0
                ? "No events to replay"
                : `Replay ${events.length} events`
          }
        >
          {loading ? "loading…" : `enter replay (${events.length} events)`}
        </button>
      </div>
    );
  }

  return (
    <>
      <div
        className="rounded-md border border-accent/40 bg-bg-2 px-3 py-2 shadow-md"
        role="region"
        aria-label="Run replay player"
      >
        {/* Top row: label + exit */}
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="mono text-[10px] font-semibold uppercase tracking-wider text-accent">
            replay mode
          </span>
          <button
            type="button"
            onClick={exitReplay}
            className="mono text-[11px] text-ink-3 hover:text-ink-1"
          >
            exit replay
          </button>
        </div>

        {/* Density strip (event distribution over time) */}
        <div className="mb-2">
          <DensityStrip events={events} cursorPos={cursorPos} />
        </div>

        {/* Scrubber range input */}
        <div className="mb-2 flex items-center gap-2">
          <span className="mono tnum shrink-0 text-[10px] text-ink-3">0</span>
          <input
            type="range"
            min={0}
            max={events.length}
            value={cursorIdx}
            step={1}
            aria-label="Replay scrubber"
            className="h-1.5 w-full flex-1 cursor-pointer accent-accent"
            onChange={(e) => {
              jumpTo(Number(e.target.value));
            }}
          />
          <span className="mono tnum shrink-0 text-[10px] text-ink-3">{events.length}</span>
        </div>

        {/* Controls row: play/pause + speed + position */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Play / Pause */}
          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? "Pause replay" : "Play replay"}
            className="mono flex items-center gap-1 rounded border border-line-2 px-2 py-0.5 text-[12px] text-ink-1 transition-colors hover:border-accent"
          >
            {isPlaying ? "⏸" : "▶"}
          </button>

          {/* Step back */}
          <button
            type="button"
            onClick={stepBack}
            disabled={cursorIdx === 0}
            aria-label="Step back one event"
            className={cn(
              "mono rounded border border-line-2 px-2 py-0.5 text-[12px] transition-colors",
              cursorIdx === 0 ? "cursor-not-allowed opacity-40 text-ink-3" : "text-ink-1 hover:border-accent",
            )}
          >
            ←
          </button>

          {/* Step forward */}
          <button
            type="button"
            onClick={stepForward}
            disabled={cursorIdx >= events.length}
            aria-label="Step forward one event"
            className={cn(
              "mono rounded border border-line-2 px-2 py-0.5 text-[12px] transition-colors",
              cursorIdx >= events.length ? "cursor-not-allowed opacity-40 text-ink-3" : "text-ink-1 hover:border-accent",
            )}
          >
            →
          </button>

          {/* Speed selector */}
          <div className="flex items-center gap-1">
            <span className="mono text-[10px] text-ink-3">speed</span>
            {SPEED_OPTIONS.map((opt) => (
              <button
                key={String(opt.value)}
                type="button"
                onClick={() => setSpeed(opt.value)}
                aria-pressed={speed === opt.value}
                className={cn(
                  "mono rounded px-1.5 py-0.5 text-[10px] transition-colors",
                  speed === opt.value
                    ? "border border-accent bg-accent/10 text-accent"
                    : "border border-line-2 text-ink-3 hover:text-ink-1",
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Position counter */}
          <span className="mono tnum ml-auto text-[10px] text-ink-3">
            {cursorIdx} / {events.length} ({pct}%)
          </span>

          {/* Diff panel toggle when an attempt is in view */}
          {diffAttemptId && (
            <button
              type="button"
              onClick={() => setDiffOpen((o) => !o)}
              className="mono text-[10px] text-accent underline underline-offset-2 hover:text-accent/80"
            >
              {diffOpen ? "hide diff" : "show diff"}
            </button>
          )}
        </div>
      </div>

      {/* Attempt diff side panel */}
      <DiffPanel
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
        attemptId={diffAttemptId}
        stageId={diffStageId}
        tree={tree}
      />
    </>
  );
}
