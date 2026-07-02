/**
 * EventSource manager for the daemon's SSE streams (global + per-run).
 *
 * Adds three things over raw EventSource:
 *   - Auto-reconnect with exponential backoff + jitter.
 *   - Last-Event-ID resume: the last `seq` we saw is replayed on reconnect via
 *     a `?lastEventId=` query param (EventSource can't set request headers).
 *   - Typed dispatch over the shared SseEvent union: `.on("stage.started", fn)`
 *     receives a fully-narrowed event.
 *
 * The daemon may deliver frames either as named SSE events (`event: <type>`)
 * or as default `message` frames carrying the full envelope. Both are handled;
 * because a named event never also triggers `onmessage`, there's no double
 * dispatch.
 */
import {
  GLOBAL_SSE_EVENT_TYPES,
  RUN_SSE_EVENT_TYPES,
  type SseEvent,
  type SseEventType,
  type SseEventOf,
} from "@shared/api-types";

export type SseStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

type AnyHandler = (ev: SseEvent) => void;

/** Injectable for tests; defaults to the platform EventSource. */
export type EventSourceFactory = (url: string) => EventSource;

export interface SseManagerOptions {
  url: string;
  onStatus?: (status: SseStatus) => void;
  /** Backoff ceiling. Default 15s. */
  maxBackoffMs?: number;
  /** Base backoff. Default 500ms. */
  baseBackoffMs?: number;
  /**
   * Seed the Last-Event-ID for the FIRST connect (e.g. "0" to replay a run's
   * whole event history from the server ring buffer, then follow live). Without
   * it, the first connect only receives events emitted after it opened.
   */
  initialLastEventId?: string;
  eventSourceFactory?: EventSourceFactory;
}

const ALL_EVENT_TYPES: readonly SseEventType[] = [
  ...GLOBAL_SSE_EVENT_TYPES,
  ...RUN_SSE_EVENT_TYPES,
];

export class SseManager {
  private readonly url: string;
  private readonly maxBackoff: number;
  private readonly baseBackoff: number;
  private readonly factory: EventSourceFactory;
  private readonly onStatus?: (status: SseStatus) => void;

  private es: EventSource | null = null;
  private handlers = new Map<SseEventType | "*", Set<AnyHandler>>();
  private lastEventId: string | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private _status: SseStatus = "idle";

  constructor(opts: SseManagerOptions) {
    this.url = opts.url;
    this.maxBackoff = opts.maxBackoffMs ?? 15_000;
    this.baseBackoff = opts.baseBackoffMs ?? 500;
    this.onStatus = opts.onStatus;
    this.lastEventId = opts.initialLastEventId ?? null;
    this.factory =
      opts.eventSourceFactory ??
      ((u: string) => new EventSource(u));
  }

  get status(): SseStatus {
    return this._status;
  }

  private setStatus(s: SseStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.onStatus?.(s);
  }

  /** Register a typed listener. Returns an unsubscribe fn. */
  on<T extends SseEventType>(type: T, handler: (ev: SseEventOf<T>) => void): () => void {
    return this.addHandler(type, handler as AnyHandler);
  }

  /** Register a listener for every event on the stream. */
  onAny(handler: AnyHandler): () => void {
    return this.addHandler("*", handler);
  }

  private addHandler(key: SseEventType | "*", handler: AnyHandler): () => void {
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Open the stream. Idempotent. */
  connect(): void {
    this.closed = false;
    this.open();
  }

  private buildUrl(): string {
    if (this.lastEventId == null) return this.url;
    const sep = this.url.includes("?") ? "&" : "?";
    return `${this.url}${sep}lastEventId=${encodeURIComponent(this.lastEventId)}`;
  }

  private open(): void {
    if (this.closed) return;
    this.teardownEs();
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    const es = this.factory(this.buildUrl());
    this.es = es;

    es.onopen = () => {
      this.attempt = 0;
      this.setStatus("open");
    };

    es.onerror = () => {
      // EventSource fires error on transient drops AND on hard failures.
      // We take control: close and schedule our own backoff reconnect.
      if (this.closed) return;
      this.scheduleReconnect();
    };

    // Default (unnamed) message frames.
    es.onmessage = (e: MessageEvent) => this.handleFrame(e.data, e.lastEventId);

    // Named event frames (event: stage.started, …).
    for (const type of ALL_EVENT_TYPES) {
      es.addEventListener(type, (e) => {
        const me = e as MessageEvent;
        this.handleFrame(me.data, me.lastEventId);
      });
    }
  }

  private handleFrame(data: unknown, lastEventId?: string): void {
    if (typeof data !== "string" || data.length === 0) return;
    let ev: SseEvent;
    try {
      ev = JSON.parse(data) as SseEvent;
    } catch {
      return; // ignore malformed frames
    }
    if (!ev || typeof ev.type !== "string") return;

    // Track resume cursor: prefer the SSE id, else the envelope seq.
    if (lastEventId) this.lastEventId = lastEventId;
    else if (typeof ev.seq === "number") this.lastEventId = String(ev.seq);

    this.handlers.get(ev.type)?.forEach((h) => h(ev));
    this.handlers.get("*")?.forEach((h) => h(ev));
  }

  private scheduleReconnect(): void {
    this.teardownEs();
    if (this.closed || this.reconnectTimer != null) return;
    this.setStatus("reconnecting");
    const delay = this.nextBackoff();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  /** Exponential backoff with full jitter, capped. */
  nextBackoff(): number {
    const exp = Math.min(this.maxBackoff, this.baseBackoff * 2 ** this.attempt);
    this.attempt += 1;
    return Math.round(Math.random() * exp);
  }

  private teardownEs(): void {
    if (this.es) {
      this.es.onopen = null;
      this.es.onerror = null;
      this.es.onmessage = null;
      try {
        this.es.close();
      } catch {
        /* ignore */
      }
      this.es = null;
    }
  }

  /** Permanently close the stream and drop reconnect scheduling. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownEs();
    this.setStatus("closed");
  }
}
