import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SseManager } from "./sse";
import type { SseEvent } from "@shared/api-types";

/** Minimal EventSource stand-in the manager can drive in tests. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string; lastEventId?: string }) => void) | null = null;
  closed = false;
  private named = new Map<string, Set<(e: { data: string; lastEventId?: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: { data: string; lastEventId?: string }) => void) {
    let set = this.named.get(type);
    if (!set) {
      set = new Set();
      this.named.set(type, set);
    }
    set.add(fn);
  }

  emitNamed(type: string, obj: unknown, id?: string) {
    this.named.get(type)?.forEach((fn) => fn({ data: JSON.stringify(obj), lastEventId: id }));
  }

  emitRaw(type: string, data: string, id?: string) {
    this.named.get(type)?.forEach((fn) => fn({ data, lastEventId: id }));
  }

  triggerOpen() {
    this.onopen?.();
  }
  triggerError() {
    this.onerror?.({});
  }
  close() {
    this.closed = true;
  }
}

function makeManager(onStatus?: (s: string) => void) {
  return new SseManager({
    url: "/api/v1/events",
    eventSourceFactory: (u) => new FakeEventSource(u) as unknown as EventSource,
    onStatus: onStatus as never,
    baseBackoffMs: 500,
    maxBackoffMs: 15000,
  });
}

const sample: SseEvent = {
  type: "stage.started",
  run_id: "run_1",
  ts: "2026-07-01T00:00:00.000Z",
  seq: 5,
  data: { stage_id: "stg_1", kind: "spec", gate_type: "spec", agent: "spec-author" },
} as SseEvent;

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SseManager", () => {
  it("connects and reports open status", () => {
    const statuses: string[] = [];
    const mgr = makeManager((s) => statuses.push(s));
    mgr.connect();
    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0]!.triggerOpen();
    expect(mgr.status).toBe("open");
    expect(statuses).toContain("connecting");
    expect(statuses).toContain("open");
    mgr.close();
  });

  it("dispatches typed events to the matching handler", () => {
    const mgr = makeManager();
    const seen: SseEvent[] = [];
    mgr.on("stage.started", (ev) => seen.push(ev));
    mgr.connect();
    FakeEventSource.instances[0]!.emitNamed("stage.started", sample);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe("stage.started");
    mgr.close();
  });

  it("delivers every event to onAny", () => {
    const mgr = makeManager();
    const seen: string[] = [];
    mgr.onAny((ev) => seen.push(ev.type));
    mgr.connect();
    FakeEventSource.instances[0]!.emitNamed("stage.started", sample);
    expect(seen).toEqual(["stage.started"]);
    mgr.close();
  });

  it("ignores malformed frames without throwing", () => {
    const mgr = makeManager();
    const seen: SseEvent[] = [];
    mgr.onAny((ev) => seen.push(ev));
    mgr.connect();
    expect(() => FakeEventSource.instances[0]!.emitRaw("stage.started", "{not json")).not.toThrow();
    expect(seen).toHaveLength(0);
    mgr.close();
  });

  it("reconnects with backoff and resumes from the last event id", () => {
    const mgr = makeManager();
    mgr.on("stage.started", () => {});
    mgr.connect();
    const first = FakeEventSource.instances[0]!;
    first.triggerOpen();

    // Receive a frame carrying seq=5 (used as the resume cursor).
    first.emitNamed("stage.started", sample, "5");

    // Connection drops.
    first.triggerError();
    expect(first.closed).toBe(true);

    // Backoff with random=0.5 → round(0.5 * 500) = 250ms.
    vi.advanceTimersByTime(250);

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toContain("lastEventId=5");
    mgr.close();
  });

  it("stops reconnecting after close()", () => {
    const mgr = makeManager();
    mgr.connect();
    const first = FakeEventSource.instances[0]!;
    mgr.close();
    first.triggerError();
    vi.advanceTimersByTime(5000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(mgr.status).toBe("closed");
  });

  it("nextBackoff is bounded by the ceiling and grows", () => {
    const mgr = makeManager();
    // random=0.5 makes each value exactly half the exponential ceiling.
    const a = mgr.nextBackoff(); // attempt 0 → 500 → 250
    const b = mgr.nextBackoff(); // attempt 1 → 1000 → 500
    const c = mgr.nextBackoff(); // attempt 2 → 2000 → 1000
    expect(a).toBe(250);
    expect(b).toBe(500);
    expect(c).toBe(1000);
    // Far enough out it clamps at maxBackoff/2.
    for (let i = 0; i < 20; i++) mgr.nextBackoff();
    expect(mgr.nextBackoff()).toBeLessThanOrEqual(15000);
  });
});
