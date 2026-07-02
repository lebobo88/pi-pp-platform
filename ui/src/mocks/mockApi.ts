/**
 * In-browser mock daemon. Enabled with VITE_MOCK=1. Patches `fetch` to serve
 * fixtures for the REST surface and replaces `EventSource` with a scripted
 * replay, so every feature screen can be built and demoed before the real
 * daemon exists.
 *
 *   VITE_MOCK=1 pnpm -F ui dev
 */
import { apiPaths, type ApiError } from "@shared/api-types";
import {
  mockProjects,
  mockRunSummaries,
  mockProviders,
  mockModels,
  mockBudgets,
  mockTeams,
  mockProfiles,
  mockRubrics,
  mockRubricBody,
  mockEvolutionProposals,
  mockDoctor,
  mockRunTree,
} from "./fixtures";
import { MOCK_RUN_ID } from "./fixtures/runTree";
import { runStreamScript, globalStreamScript, type ScriptedFrame } from "./sseScript";

const LATENCY_MS = 140;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, error: string, details?: ApiError["details"]): Response {
  return json({ error, details } satisfies ApiError, status);
}

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** Route a REST request to a fixture. Returns null when unmatched. */
function route(method: string, url: URL): Response | null {
  const p = url.pathname;

  if (p === apiPaths.health) return json({ ok: true, version: "mock-0.1.0" });
  if (p === apiPaths.doctor) return json(mockDoctor);

  if (p === apiPaths.projects) return json(mockProjects);

  if (p === apiPaths.runs) {
    const projectPath = url.searchParams.get("project_path");
    const status = url.searchParams.get("status");
    let rows = mockRunSummaries;
    if (projectPath) rows = rows.filter((r) => r.project_path === projectPath);
    if (status) rows = rows.filter((r) => r.status === status);
    return json(rows);
  }
  const runMatch = p.match(/^\/api\/v1\/runs\/([^/]+)$/);
  if (runMatch) {
    const id = decode(runMatch[1]!);
    if (id === MOCK_RUN_ID) return json(mockRunTree);
    return errorResponse(404, `run ${id} not found`);
  }

  if (p === apiPaths.providers) return json(mockProviders);
  if (p === apiPaths.models) return json(mockModels);
  if (p === apiPaths.budgets) return json(mockBudgets);

  if (p === apiPaths.teams) return json(mockTeams);
  const teamMatch = p.match(/^\/api\/v1\/teams\/([^/]+)$/);
  if (teamMatch) {
    const name = decode(teamMatch[1]!);
    const t = mockTeams.find((x) => x.name === name);
    return t ? json(t) : errorResponse(404, `team ${name} not found`);
  }

  if (p === apiPaths.profiles) return json(mockProfiles);
  const profileMatch = p.match(/^\/api\/v1\/profiles\/([^/]+)$/);
  if (profileMatch) {
    const name = decode(profileMatch[1]!);
    const pf = mockProfiles.find((x) => x.name === name);
    return pf ? json(pf) : errorResponse(404, `profile ${name} not found`);
  }

  if (p === apiPaths.rubrics) return json(mockRubrics);
  const rubricMatch = p.match(/^\/api\/v1\/rubrics\/([^/]+)$/);
  if (rubricMatch) {
    const id = decode(rubricMatch[1]!);
    const r = mockRubrics.find((x) => x.id === id);
    return r ? json({ ...r, markdown: mockRubricBody }) : errorResponse(404, `rubric ${id} not found`);
  }

  if (p === apiPaths.evolution) return json(mockEvolutionProposals);

  // Mutations: accept and echo. Later agents replace these with real behavior.
  if (method !== "GET" && p.startsWith(apiPaths.base)) {
    return json({ ok: true, mock: true });
  }

  return null;
}

let installed = false;

export function installMockApi(): void {
  if (installed) return;
  installed = true;

  const realFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

    let url: URL;
    try {
      url = new URL(rawUrl, globalThis.location?.origin ?? "http://localhost");
    } catch {
      return realFetch(input as RequestInfo, init);
    }

    if (url.pathname.startsWith(apiPaths.base) || url.pathname === apiPaths.health) {
      const res = route(method, url);
      if (res) {
        await new Promise((r) => setTimeout(r, LATENCY_MS));
        return res;
      }
      return errorResponse(404, `mock: no route for ${method} ${url.pathname}`);
    }

    return realFetch(input as RequestInfo, init);
  };

  installMockEventSource();

  // eslint-disable-next-line no-console
  console.info("[mock] daemon interceptor installed (VITE_MOCK=1)");
}

/* ── Mock EventSource ─────────────────────────────────────────────────── */

class MockEventSource {
  static readonly CONNECTING = 0 as const;
  static readonly OPEN = 1 as const;
  static readonly CLOSED = 2 as const;
  readonly CONNECTING = 0 as const;
  readonly OPEN = 1 as const;
  readonly CLOSED = 2 as const;

  readonly url: string;
  readonly withCredentials = false;
  readyState: number = MockEventSource.CONNECTING;

  onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;

  private listeners = new Map<string, Set<EventListener>>();
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(url: string) {
    this.url = url;
    this.timers.push(
      setTimeout(() => {
        this.readyState = MockEventSource.OPEN;
        this.onopen?.call(this as unknown as EventSource, new Event("open"));
        this.play(this.scriptFor(url));
      }, 60),
    );
  }

  private scriptFor(url: string): ScriptedFrame[] {
    const runMatch = url.match(/\/runs\/([^/?]+)\/events/);
    if (runMatch) return runStreamScript(decode(runMatch[1]!));
    return globalStreamScript();
  }

  private play(frames: ScriptedFrame[]): void {
    for (const frame of frames) {
      this.timers.push(
        setTimeout(() => {
          if (this.readyState !== MockEventSource.OPEN) return;
          const data = JSON.stringify(frame.event);
          const ev = new MessageEvent(frame.event.type, { data, lastEventId: String(frame.event.seq) });
          // Named listeners (SseManager registers per type) + onmessage.
          this.listeners.get(frame.event.type)?.forEach((l) => l(ev));
          this.onmessage?.call(this as unknown as EventSource, ev);
        }, frame.delayMs),
      );
    }
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const fn = typeof listener === "function" ? listener : (e: Event) => listener.handleEvent(e);
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn as EventListener);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const fn = listener as EventListener;
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(_event: Event): boolean {
    return true;
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

function installMockEventSource(): void {
  (globalThis as unknown as { EventSource: typeof EventSource }).EventSource =
    MockEventSource as unknown as typeof EventSource;
}
