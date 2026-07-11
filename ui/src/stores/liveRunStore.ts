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
 *
 * OBSERVABILITY OVERLAY EXTENSION (SPEC-LRSTORE-OBS-002):
 *   Adds phaseTimeline, attempts, gateEvents, costSeries, lastEventTs, and
 *   lastAppliedSeq. Replay-idempotent via seq-gate on every ingested frame.
 */
import type {
  RunPhase,
  RunSseEvent,
  RunStatus,
  StageStatus,
  VerdictOutcome,
} from "@shared/api-types";

export const LOG_CAP = 5000;

/** Max entries in the gate-event ring. */
const GATE_EVENT_CAP = 200;
/** Max samples in the cost series. */
const COST_SERIES_CAP = 120;

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

/* ── Observability types (normative per SPEC-LRSTORE-OBS-002) ────────── */

export type PhaseTimelineEntry = {
  phase: RunPhase;
  /** ISO — the ev.ts of the first frame that observed this phase. */
  startedAt: string;
  /** ISO — the ev.ts of the most recent frame observed for this phase. */
  lastAt: string;
  status: "active" | "done";
  detail?: string;
};

export type AttemptMeta = {
  attemptId: string;
  stageId: string;
  agent?: string;
  model?: string;
  tier?: string;
  retryIndex?: number;
  candidateIndex?: number;
  seed?: number;
  startedAt?: string;
  completedAt?: string;
  tokensIn?: number;
  tokensOut?: number;
  /** ABSOLUTE per-attempt cost; overwrite on each observation, never accumulate. */
  costUsd?: number;
  stopReason?: string;
  toolCallCount?: number;
  filesChanged?: number;
  materializedFiles?: number;
  zeroChange?: boolean;
  /** Provider id resolved for this attempt's model (e.g. "github-copilot"). Absent on historical rows. */
  provider?: string;
  /** v13: prompt tokens consumed in this call (context fill numerator). */
  contextUsedTokens?: number;
  /** v13: catalog context_window for the model (context fill denominator). */
  contextMaxTokens?: number;
  /** v13: context fill fraction 0–1, rounded to 3 decimals. */
  contextPct?: number;
  status: "running" | "ok";
};

export type GateEventKind =
  | "gen"
  | "hook"
  | "artifact"
  | "judge"
  | "verdict"
  | "reflexion"
  | "smoke"
  | "validation"
  | "missability"
  | "borda"
  | "surfaced";

export type GateEvent = {
  /** The envelope ev.seq of the source frame; stable ordering key. */
  seq: number;
  /** envelope ev.ts (ISO). */
  at: string;
  kind: GateEventKind;
  stageId?: string;
  attemptId?: string;
  outcome?: string;
  detail?: string;
};

/* ── Main overlay type ───────────────────────────────────────────────── */

export interface LiveRunOverlay {
  runId: string;
  /** Monotonic overlay version for getSnapshot identity. */
  version: number;
  status: RunStatus | null;
  /** stage_id → latest status. */
  stageStatus: Record<string, StageStatus>;
  stageWinner: Record<string, string | null>;
  /** attempt_id → latest status string. */
  attemptStatus: Record<string, string>;
  /** attempt_id → log lines (snapshot; high-frequency updates via subscribeLog). */
  attemptLog?: Record<string, string[]>;
  /** attempt_id → latest verdict outcome. */
  verdicts: Record<string, VerdictOutcome>;
  /** stage_id → Borda ranking. */
  borda: Record<string, BordaRanking[]>;
  /** Cumulative run cost from run-scoped budget.tick (absolute, not a delta). */
  costUsd: number;
  tokensIn: number;
  tokensOut: number;

  // ── Observability fields (SPEC-LRSTORE-OBS-002) ──────────────────────
  //
  // NOTE: These are declared optional so pre-existing consumers that build
  // partial LiveRunOverlay literals (see ui/src/lib/runModel.test.ts) keep
  // compiling. `freshOverlay()` and `ingest()` guarantee they are ALWAYS
  // populated on any overlay this store produces — code that reads from the
  // store may treat them as present.

  /** Phase lifecycle timeline; at most one entry has status 'active'. */
  phaseTimeline?: PhaseTimelineEntry[];
  /** attempt_id → attempt metadata, populated from started + completed frames. */
  attempts?: Record<string, AttemptMeta>;
  /** Append-only gate-event ring, capped at 200. */
  gateEvents?: GateEvent[];
  /** Cumulative cost samples from run-scoped budget.tick, capped at 120. */
  costSeries?: number[];
  /** ev.ts of the most recently applied frame, or null. */
  lastEventTs?: string | null;
  /**
   * Highest ev.seq successfully applied; -1 sentinel means nothing seen.
   * Frames with ev.seq <= lastAppliedSeq are ignored (replay dedup).
   */
  lastAppliedSeq?: number;
  /**
   * Monotonically-increasing counter bumped by every stage.started and
   * stage.finalized frame. RunDetailPage uses this (alongside gateEvents.length)
   * to know when to refetch the REST run tree. Do NOT use overlay.version for
   * this — budget.tick bumps version on every tick causing a refetch storm.
   */
  stageLifecycleCount?: number;
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

const EMPTY_BUFFER: LogBuffer = { lines: [], seq: 0, dropped: 0 };

function freshOverlay(runId: string): LiveRunOverlay {
  return {
    runId,
    version: 0,
    status: null,
    stageStatus: {},
    stageWinner: {},
    attemptStatus: {},
    attemptLog: {},
    verdicts: {},
    borda: {},
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    phaseTimeline: [],
    attempts: {},
    gateEvents: [],
    costSeries: [],
    lastEventTs: null,
    lastAppliedSeq: -1,
    stageLifecycleCount: 0,
  };
}

/**
 * Scrub any token that looks like a secret / API key material or an absolute
 * filesystem path. Applied to every source string used by distill().
 */
function scrubSecrets(s: string): string {
  return s
    .split(/\s+/)
    .filter((tok) => {
      if (!tok) return false;
      // Drop tokens that look like KEY_* names, *_SECRET names, or bare secret-shaped
      // values (16+ chars of URL-safe base64 / hex). Also drop absolute paths.
      if (/^key_/i.test(tok)) return false;
      if (/_secret$/i.test(tok)) return false;
      if (/^[A-Z][A-Z0-9_]{6,}$/.test(tok)) return false; // SCREAMING_SNAKE constants (often env keys)
      if (/^(?:sk|pk|xoxb|ghp|ghs|glpat|AIza)[-_A-Za-z0-9]{10,}/.test(tok)) return false;
      if (/^(?:[A-Za-z]:[\\/])/.test(tok)) return false; // Windows abs path
      if (/^\//.test(tok) && tok.length > 1 && !/^\/[a-z]+$/i.test(tok)) return false; // POSIX abs path
      return true;
    })
    .join(" ")
    .trim();
}

/**
 * Produce a ≤120-char human detail string from run.context frame data.
 * MUST NOT include token counts, cost figures, paths, or key_* or *_secret fields.
 * Only reads stage_id / stage_title / note / summary; scrubs secrets from values.
 */
function distill(data: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const raw = (k: string): string | undefined => {
    const v = data[k];
    return typeof v === "string" && v ? v : undefined;
  };
  const title = raw("stage_title") ?? raw("stage_id");
  if (title) parts.push(scrubSecrets(title));
  const body = raw("note") ?? raw("summary");
  if (body) parts.push(scrubSecrets(body));
  const joined = parts.filter(Boolean).join(" — ").trim();
  if (!joined) return undefined;
  return joined.length > 120 ? joined.slice(0, 120) : joined;
}

/**
 * Truncate a critique excerpt to ≤max code-point characters, appending '…'
 * (U+2026) if truncated (combined length still ≤ max).
 */
function truncateExcerpt(text: string, max = 160): string {
  const codePoints = [...text];
  if (codePoints.length <= max) return text;
  return codePoints.slice(0, max - 1).join("") + "\u2026";
}

/** Append one GateEvent and trim the ring to GATE_EVENT_CAP. */
function appendGateEvent(events: GateEvent[], ev: GateEvent): GateEvent[] {
  const next = [...events, ev];
  if (next.length > GATE_EVENT_CAP) {
    return next.slice(next.length - GATE_EVENT_CAP);
  }
  return next;
}

/* ── Store class ─────────────────────────────────────────────────────── */

class LiveRunStore {
  private logs = new Map<string, LogBuffer>();
  private logListeners = new Map<string, Set<() => void>>();

  private overlays = new Map<string, LiveRunOverlay>();
  private overlayListeners = new Map<string, Set<() => void>>();

  private dirtyLogs = new Set<string>();
  private dirtyOverlays = new Set<string>();
  private raf: number | null = null;

  /**
   * Per-run, per-stage pending started-meta held when attempt.started arrives
   * without an attempt_id. Reconciled on the matching attempt.completed.
   * NOT visible in overlay.attempts.
   */
  private pendingStartedMeta = new Map<
    string, // runId
    Map<string, Partial<AttemptMeta>> // stageId → partial meta
  >();

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

  /**
   * Fold a run-scoped SSE event into the overlay + log buffers.
   *
   * Replay-idempotent: frames with ev.seq <= overlay.lastAppliedSeq are
   * silently dropped before any mutation. This handles SSE reconnects that
   * replay from Last-Event-ID: 0.
   */
  ingest(runId: string, ev: RunSseEvent): void {
    const base = this.overlays.get(runId) ?? freshOverlay(runId);

    /* ── §4.1 Dedupe gate ─────────────────────────────────────────────── */
    const evSeq: number = (ev as { seq?: number }).seq ?? NaN;
    const seqIsValid = Number.isFinite(evSeq) && evSeq >= 0;
    const baseLastSeq = base.lastAppliedSeq ?? -1;
    if (seqIsValid && evSeq <= baseLastSeq) {
      // Replayed frame — ignore entirely.
      return;
    }

    /* ── attempt.output is handled inline (log buffer + overlay.attemptLog) */
    if (ev.type === "attempt.output") {
      this.appendLog(ev.data.attempt_id, ev.data.chunk);
      // Update overlay: attemptLog snapshot + lastEventTs + lastAppliedSeq.
      // We do NOT bump `version` here to preserve existing behaviour that
      // overlay subscribers are not notified on every log chunk.
      const logBuf = this.logs.get(ev.data.attempt_id);
      const updatedLog: Record<string, string[]> = {
        ...(base.attemptLog ?? {}),
        [ev.data.attempt_id]: logBuf ? logBuf.lines : [],
      };
      const evTs: string = (ev as { ts?: string }).ts ?? "";
      const next: LiveRunOverlay = {
        ...base,
        attemptLog: updatedLog,
        lastEventTs: evTs || base.lastEventTs || null,
        lastAppliedSeq: seqIsValid ? Math.max(baseLastSeq, evSeq) : baseLastSeq,
        // version intentionally NOT bumped for log-only frames
      };
      this.overlays.set(runId, next);
      // NOTE: dirtyOverlays not marked here — overlay subscribers will not be
      // notified for attempt.output, preserving existing behaviour.
      return;
    }

    /* ── Common fields for structural frame processing ────────────────── */
    const evTs: string = (ev as { ts?: string }).ts ?? "";
    const next: LiveRunOverlay = { ...base, version: base.version + 1 };
    // Ensure optional observability fields are always present on `next`.
    if (!next.phaseTimeline) next.phaseTimeline = [];
    if (!next.attempts) next.attempts = {};
    if (!next.gateEvents) next.gateEvents = [];
    if (!next.costSeries) next.costSeries = [];
    if (next.lastAppliedSeq === undefined) next.lastAppliedSeq = -1;
    if (next.lastEventTs === undefined) next.lastEventTs = null;
    if (!next.attemptLog) next.attemptLog = {};

    // §4.1: update lastAppliedSeq and lastEventTs
    if (seqIsValid) {
      next.lastAppliedSeq = Math.max(next.lastAppliedSeq, evSeq);
    }
    if (evTs) {
      next.lastEventTs = evTs;
    }

    /* ── Per-type mutations ───────────────────────────────────────────── */
    switch (ev.type) {
      /* ── Existing handlers (preserved) ─────────────────────────────── */
      case "run.started":
        next.status = "running";
        break;

      case "stage.started":
        next.stageStatus = { ...next.stageStatus, [ev.data.stage_id]: "open" };
        next.stageLifecycleCount = (next.stageLifecycleCount ?? 0) + 1;
        break;

      case "stage.finalized":
        next.stageStatus = { ...next.stageStatus, [ev.data.stage_id]: ev.data.status };
        next.stageWinner = { ...next.stageWinner, [ev.data.stage_id]: ev.data.winner_attempt_id };
        next.stageLifecycleCount = (next.stageLifecycleCount ?? 0) + 1;
        break;

      case "stage.surfaced": {
        next.stageStatus = { ...next.stageStatus, [ev.data.stage_id]: "surfaced" };
        // Gate event
        next.gateEvents = appendGateEvent(next.gateEvents, {
          seq: seqIsValid ? evSeq : -1,
          at: evTs,
          kind: "surfaced",
          stageId: ev.data.stage_id,
          outcome: "surfaced",
          detail: ev.data.reason
            ? String(ev.data.reason).slice(0, 200)
            : undefined,
        });
        break;
      }

      case "attempt.completed": {
        const d = ev.data;
        next.attemptStatus = { ...next.attemptStatus, [d.attempt_id]: "ok" };

        // Reconcile pending started-meta for this stage, if any.
        const pendingByStage = this.pendingStartedMeta.get(runId);
        const pending = pendingByStage?.get(d.stage_id);

        const existingMeta = next.attempts[d.attempt_id];
        const merged: AttemptMeta = {
          attemptId: d.attempt_id,
          stageId: d.stage_id,
          // Merge pending started-meta first (lower priority than existing)
          ...(pending ?? {}),
          // Existing meta overrides pending
          ...(existingMeta ?? {}),
          // Completion fields (highest priority)
          completedAt: evTs,
          ...(d.tokens_in != null ? { tokensIn: d.tokens_in } : {}),
          ...(d.tokens_out != null ? { tokensOut: d.tokens_out } : {}),
          ...(d.cost_usd != null ? { costUsd: d.cost_usd } : {}), // absolute overwrite
          ...(d.stop_reason != null ? { stopReason: d.stop_reason } : {}),
          ...(d.tool_call_count != null ? { toolCallCount: d.tool_call_count } : {}),
          ...(d.files_changed != null ? { filesChanged: d.files_changed } : {}),
          ...(d.materialized_files != null
            ? { materializedFiles: d.materialized_files.length }
            : {}),
          ...(d.zero_change != null ? { zeroChange: d.zero_change } : {}),
          ...(d.context_used_tokens != null ? { contextUsedTokens: d.context_used_tokens } : {}),
          ...(d.context_max_tokens != null ? { contextMaxTokens: d.context_max_tokens } : {}),
          ...(d.context_pct != null ? { contextPct: d.context_pct } : {}),
          status: "ok",
        };
        // provider: never OVERWRITE an existing (started-frame) value; only
        // fill when absent OR when the completed frame carries the same value.
        // Guards against a mismatched completed-frame corrupting the meta.
        if (d.provider) {
          const prior = merged.provider ?? existingMeta?.provider ?? pending?.provider;
          if (!prior || prior === d.provider) {
            merged.provider = d.provider;
          }
          // else: keep prior; the mismatch is a wire-contract violation (REQ-W-5).
        }
        // If there was no model yet but the completion carries one, apply it.
        if (!merged.model && d.model) merged.model = d.model;

        next.attempts = { ...next.attempts, [d.attempt_id]: merged };

        // Clear the pending slot.
        if (pending && pendingByStage) {
          const newMap = new Map(pendingByStage);
          newMap.delete(d.stage_id);
          this.pendingStartedMeta.set(runId, newMap);
        }

        // Gate event
        const detailParts: string[] = [];
        if (d.tokens_in != null) detailParts.push(`in=${d.tokens_in}`);
        if (d.tokens_out != null) detailParts.push(`out=${d.tokens_out}`);
        if (d.stop_reason) detailParts.push(`stop=${d.stop_reason}`);
        next.gateEvents = appendGateEvent(next.gateEvents, {
          seq: seqIsValid ? evSeq : -1,
          at: evTs,
          kind: "gen",
          stageId: d.stage_id,
          attemptId: d.attempt_id,
          outcome: "ok",
          detail: detailParts.length ? detailParts.join(" ") : undefined,
        });
        break;
      }

      case "verdict.recorded": {
        const d = ev.data;
        next.verdicts = { ...next.verdicts, [d.attempt_id]: d.outcome };

        const detailParts: string[] = [];
        if (d.judge_model) detailParts.push(`judge=${d.judge_model}`);
        if (d.judge_provider) detailParts.push(`judge_provider=${d.judge_provider}`);
        if (d.cross_vendor != null) detailParts.push(`cross=${d.cross_vendor}`);
        next.gateEvents = appendGateEvent(next.gateEvents, {
          seq: seqIsValid ? evSeq : -1,
          at: evTs,
          kind: "verdict",
          stageId: d.stage_id,
          attemptId: d.attempt_id,
          outcome: d.outcome,
          detail: detailParts.length
            ? detailParts.join(" ").slice(0, 200)
            : undefined,
        });
        break;
      }

      case "verdict.retracted": {
        const v = { ...next.verdicts };
        delete v[ev.data.attempt_id];
        next.verdicts = v;
        break;
      }

      case "borda.updated": {
        const d = ev.data;
        if (d.ranking) {
          next.borda = { ...next.borda, [d.stage_id]: d.ranking };
        }
        const detailParts: string[] = [];
        if (d.leader_attempt_id) detailParts.push(`winner=${d.leader_attempt_id}`);
        next.gateEvents = appendGateEvent(next.gateEvents, {
          seq: seqIsValid ? evSeq : -1,
          at: evTs,
          kind: "borda",
          stageId: d.stage_id,
          outcome: "updated",
          detail: detailParts.length ? detailParts.join(" ").slice(0, 200) : undefined,
        });
        break;
      }

      case "budget.tick": {
        const d = ev.data;
        // Determine if this is run-scoped: matches the run scope string
        // AND does not carry a truthy stage_id.
        const dataAny = d as Record<string, unknown>;
        const isRunScoped =
          d.scope === `run:${runId}` && !dataAny["stage_id"];
        if (isRunScoped) {
          next.costUsd = d.cost_usd;
          next.tokensIn = d.tokens_in;
          next.tokensOut = d.tokens_out;
          // costSeries: append and cap at COST_SERIES_CAP
          const newSeries = [...next.costSeries, d.cost_usd];
          next.costSeries =
            newSeries.length > COST_SERIES_CAP
              ? newSeries.slice(newSeries.length - COST_SERIES_CAP)
              : newSeries;
        }
        break;
      }

      case "run.finalized":
        next.status = ev.data.status;
        // Mark all phase timeline entries done on terminal event.
        next.phaseTimeline = next.phaseTimeline.map((entry) =>
          entry.status === "done"
            ? entry
            : { ...entry, status: "done", lastAt: evTs || entry.lastAt }
        );
        break;

      /* ── New / extended handlers ────────────────────────────────────── */

      case "run.context": {
        const d = ev.data as { phase: RunPhase; [k: string]: unknown };
        const phase = d.phase;
        const detail = distill(d);
        const timeline = next.phaseTimeline;

        if (timeline.length === 0) {
          // First phase entry.
          next.phaseTimeline = [
            {
              phase,
              startedAt: evTs,
              lastAt: evTs,
              status: "active",
              ...(detail !== undefined ? { detail } : {}),
            },
          ];
        } else {
          const last = timeline[timeline.length - 1]!;
          if (last.phase === phase) {
            // Same phase — update lastAt and optionally detail.
            const updated: PhaseTimelineEntry = {
              ...last,
              lastAt: evTs,
            };
            if (detail !== undefined) updated.detail = detail;
            next.phaseTimeline = [...timeline.slice(0, -1), updated];
          } else {
            // Phase transition — mark all non-done entries as done.
            const closed = timeline.map((e) =>
              e.status === "done"
                ? e
                : { ...e, status: "done" as const, lastAt: evTs }
            );
            next.phaseTimeline = [
              ...closed,
              {
                phase,
                startedAt: evTs,
                lastAt: evTs,
                status: "active",
                ...(detail !== undefined ? { detail } : {}),
              },
            ];
          }
        }
        break;
      }

      case "attempt.started": {
        const d = ev.data;
        const partialMeta: Partial<AttemptMeta> = {
          stageId: d.stage_id,
          startedAt: evTs,
          ...(d.agent !== undefined ? { agent: d.agent } : {}),
          ...(d.model !== undefined ? { model: d.model } : {}),
          ...(d.tier !== undefined && d.tier !== null ? { tier: d.tier } : {}),
          ...(d.retry_index !== undefined ? { retryIndex: d.retry_index } : {}),
          ...(d.candidate_index !== undefined
            ? { candidateIndex: d.candidate_index }
            : {}),
          ...(d.seed !== undefined ? { seed: d.seed } : {}),
          ...(d.provider ? { provider: d.provider } : {}),
        };

        if (d.attempt_id) {
          // Known attempt_id — upsert immediately.
          const existing = next.attempts[d.attempt_id];
          next.attempts = {
            ...next.attempts,
            [d.attempt_id]: {
              ...(existing ?? {}),
              ...partialMeta,
              attemptId: d.attempt_id,
              stageId: d.stage_id,
              status: "running",
            } as AttemptMeta,
          };
        } else {
          // No attempt_id — stash as pending; last-writer-wins per stage.
          let byRun = this.pendingStartedMeta.get(runId);
          if (!byRun) {
            byRun = new Map();
            this.pendingStartedMeta.set(runId, byRun);
          }
          byRun.set(d.stage_id, partialMeta);
        }

        // Gate event
        const detailParts: string[] = [];
        if (d.model) detailParts.push(d.model);
        if (d.provider) detailParts.push(`via ${d.provider}`);
        if (d.tier) detailParts.push(d.tier);
        next.gateEvents = appendGateEvent(next.gateEvents, {
          seq: seqIsValid ? evSeq : -1,
          at: evTs,
          kind: "gen",
          stageId: d.stage_id,
          ...(d.attempt_id ? { attemptId: d.attempt_id } : {}),
          outcome: "started",
          detail: detailParts.length
            ? detailParts.join(" · ").slice(0, 200)
            : undefined,
        });
        break;
      }

      case "reflexion.retry": {
        const d = ev.data;
        const tierPart =
          d.initial_tier && d.retry_tier
            ? `${d.initial_tier}→${d.retry_tier}`
            : undefined;
        const critiquePart = d.critique_excerpt
          ? truncateExcerpt(d.critique_excerpt, 160)
          : undefined;
        const combinedRaw = [tierPart, critiquePart].filter(Boolean).join(" ");
        // Enforce combined ≤160 code points including any ellipsis.
        const combined = combinedRaw ? truncateExcerpt(combinedRaw, 160) : "";
        next.gateEvents = appendGateEvent(next.gateEvents, {
          seq: seqIsValid ? evSeq : -1,
          at: evTs,
          kind: "reflexion",
          stageId: d.stage_id,
          outcome: "retry",
          detail: combined || undefined,
        });
        break;
      }

      case "smoke.status": {
        const d = ev.data;
        next.gateEvents = appendGateEvent(next.gateEvents, {
          seq: seqIsValid ? evSeq : -1,
          at: evTs,
          kind: "smoke",
          ...(d.stage_id ? { stageId: d.stage_id } : {}),
          ...(d.attempt_id ? { attemptId: d.attempt_id } : {}),
          outcome: d.status,
          detail: d.detail ? String(d.detail).slice(0, 200) : undefined,
        });
        break;
      }

      case "validation.result": {
        const d = ev.data;
        next.gateEvents = appendGateEvent(next.gateEvents, {
          seq: seqIsValid ? evSeq : -1,
          at: evTs,
          kind: "validation",
          ...(d.stage_id ? { stageId: d.stage_id } : {}),
          outcome: d.status,
          detail: d.reason ? String(d.reason).slice(0, 200) : undefined,
        });
        break;
      }

      case "missability.result": {
        const d = ev.data as {
          check_id: string;
          status: string;
          stage_id?: string;
          attempt_id?: string;
          evidence_path?: string | null;
        };
        next.gateEvents = appendGateEvent(next.gateEvents, {
          seq: seqIsValid ? evSeq : -1,
          at: evTs,
          kind: "missability",
          ...(d.stage_id ? { stageId: d.stage_id } : {}),
          ...(d.attempt_id ? { attemptId: d.attempt_id } : {}),
          outcome: d.status,
        });
        break;
      }

      default:
        // Unknown types — version bump only (forward-compat).
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

  /**
   * Reset a single run's overlay to its fresh state. Does NOT touch log
   * buffers — call clearLogs() separately with the attempt ids to clear.
   * Used by ReplayPlayer before re-ingesting from the beginning.
   */
  resetRun(runId: string): void {
    this.overlays.delete(runId);
    this.pendingStartedMeta.delete(runId);
    this.dirtyOverlays.add(runId);
    this.schedule();
  }

  /**
   * Clear the log buffers for the given attempt ids.
   * Used by ReplayPlayer before re-ingesting from the beginning so that
   * attempt.output chunks are not double-appended.
   */
  clearLogs(attemptIds: string[]): void {
    for (const id of attemptIds) {
      this.logs.delete(id);
      this.dirtyLogs.add(id);
    }
    if (attemptIds.length > 0) this.schedule();
  }

  /** Test / teardown helper. */
  reset(): void {
    this.logs.clear();
    this.overlays.clear();
    this.pendingStartedMeta.clear();
    this.dirtyLogs.clear();
    this.dirtyOverlays.clear();
  }
}

export const liveRunStore = new LiveRunStore();
