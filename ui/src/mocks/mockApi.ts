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
  mockCaps,
  mockSettings,
  mockJanitor,
  mockMissabilityChecks,
  mockReplayBundle,
  mockProjectDetails,
  mockMasterPlan,
  mockAgentsMd,
  mockConstitution,
} from "./fixtures";
import { MOCK_RUN_ID, mockWinningDiff } from "./fixtures/runTree";
import { runStreamScript, globalStreamScript, type ScriptedFrame } from "./sseScript";
import type { ArtifactContent } from "@shared/api-types";

/** Resolve on-disk artifact/candidate content by path (mock). */
function mockContentFor(path: string): ArtifactContent {
  if (path.endsWith(".diff")) return { path, kind: "diff", content: mockWinningDiff };
  if (path.endsWith(".md")) {
    return {
      path,
      kind: "markdown",
      content: `# ${path.split(/[\\/]/).pop()}\n\n${mockMasterPlan.markdown}`,
    };
  }
  if (path.endsWith(".yaml") || path.endsWith(".json")) {
    return { path, kind: "text", content: `# ${path}\n(sample contract body served by the mock daemon)` };
  }
  return { path, kind: "text", content: `(no preview for ${path})` };
}

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

/** Mask an API key for display: keep a short suffix, never the raw value. */
function maskKey(vendor: string, raw: string): string {
  const prefix = vendor === "anthropic" ? "sk-ant-" : vendor === "openai" ? "sk-" : "";
  const tail = raw.replace(/\s/g, "").slice(-4);
  return `${prefix}…${tail}`;
}

/** Handle a control-plane mutation. Returns null when unmatched. */
function routeMutation(method: string, url: URL, body: unknown): Response | null {
  const p = url.pathname;

  // Start run → return the animated demo run so navigation shows it live.
  if (method === "POST" && p === apiPaths.runs) {
    return json({ run_id: MOCK_RUN_ID });
  }

  const abort = p.match(/^\/api\/v1\/runs\/([^/]+)\/abort$/);
  if (method === "POST" && abort) {
    return json({ run_id: decode(abort[1]!), status: "aborted" });
  }
  const retry = p.match(/^\/api\/v1\/runs\/([^/]+)\/stages\/([^/]+)\/retry$/);
  if (method === "POST" && retry) {
    return json({ run_id: decode(retry[1]!), stage_id: decode(retry[2]!), action: "retry", ok: true });
  }
  const gate = p.match(/^\/api\/v1\/runs\/([^/]+)\/stages\/([^/]+)\/gate$/);
  if (method === "POST" && gate) {
    return json({ run_id: decode(gate[1]!), stage_id: decode(gate[2]!), action: "gate", ok: true });
  }

  // Provider key: WRITE-ONLY. Never echo the raw key — respond with the masked
  // ProviderStatus only. This is the masked-key contract the gate enforces.
  const keyMatch = p.match(/^\/api\/v1\/providers\/([^/]+)\/key$/);
  if ((method === "PUT" || method === "POST") && keyMatch) {
    const vendor = decode(keyMatch[1]!);
    const raw = (body as { api_key?: string } | null)?.api_key ?? "";
    if (!raw || raw.length < 8) {
      return errorResponse(422, "validation failed", { api_key: "key looks too short" });
    }
    const existing = mockProviders.find((x) => x.vendor === vendor);
    const updated = {
      ...(existing ?? { vendor, cli_installed: true, cli_version: null, logged_in: false, degraded: false }),
      vendor,
      configured: true,
      has_api_key: true,
      masked_key: maskKey(vendor, raw),
    };
    return json(updated);
  }
  const testMatch = p.match(/^\/api\/v1\/providers\/([^/]+)\/test$/);
  if (method === "POST" && testMatch) {
    const vendor = decode(testMatch[1]!);
    return json({ vendor, ok: true, status: "ok", model: `${vendor}-probe`, wall_ms: 1800, detail: "model resolved" });
  }
  if (method === "DELETE" && keyMatch) {
    const vendor = decode(keyMatch[1]!);
    const existing = mockProviders.find((x) => x.vendor === vendor);
    return json({
      ...(existing ?? { vendor, cli_installed: true, cli_version: null, logged_in: false, degraded: false }),
      vendor,
      configured: false,
      has_api_key: false,
      masked_key: null,
    });
  }

  if (method === "POST" && p === apiPaths.profileBootstrap) {
    const b = (body as { project_path?: string; profile?: string } | null) ?? {};
    return json({ ok: true, project_path: b.project_path, profile: b.profile });
  }

  // Profile detect / write.
  const detect = p.match(/^\/api\/v1\/projects\/([^/]+)\/profile\/detect$/);
  if (method === "POST" && detect) {
    const path = decode(detect[1]!);
    const current = mockProjectDetails[path]?.active_profile ?? null;
    return json({
      detected: current ?? "web-ui",
      current,
      reasons: ["package.json has react + vite", "tailwind config present", "no server entrypoint found"],
      diff: `--- a/.harness/profile.yaml\n+++ b/.harness/profile.yaml\n@@\n+name: ${current ?? "web-ui"}\n+required_taxonomy_sections: ["4.4","4.8","4.10"]\n`,
    });
  }
  const writeProfile = p.match(/^\/api\/v1\/projects\/([^/]+)\/profile$/);
  if (method === "PUT" && writeProfile) {
    const b = (body as { yaml?: string; profile?: string } | null) ?? {};
    if (b.yaml && /INVALID|!!bad/.test(b.yaml)) {
      return errorResponse(422, "profile validation failed", { yaml: "unknown key or malformed yaml near line 1" });
    }
    return json({ ok: true, profile: b.profile ?? "custom" });
  }

  // Doctor re-run + janitor run.
  if (method === "POST" && p === apiPaths.doctor) {
    return json(mockDoctor);
  }
  if (method === "POST" && p === apiPaths.janitor) {
    const b = (body as { execute?: boolean } | null) ?? {};
    return json({ ...mockJanitor, swept: b.execute ? mockJanitor.swept : 0, reclaimed_bytes: b.execute ? mockJanitor.reclaimed_bytes : 0 });
  }

  // Settings (tier ladder + judge pool).
  if (method === "PUT" && p === apiPaths.settings) {
    return json(body ?? mockSettings);
  }

  const review = p.match(/^\/api\/v1\/evolution\/proposals\/([^/]+)\/review$/);
  if (method === "POST" && review) {
    const id = decode(review[1]!);
    const decision = (body as { decision?: string } | null)?.decision ?? "approve";
    const statusMap: Record<string, string> = { approve: "approved", reject: "rejected", commit: "committed", rollback: "rolled_back" };
    const existing = mockEvolutionProposals.find((x) => x.id === id);
    if (!existing) return errorResponse(404, `proposal ${id} not found`);
    return json({ ...existing, status: statusMap[decision] ?? existing.status });
  }

  if (method === "PUT" && p === apiPaths.budgetCaps) {
    const b = (body as { caps?: unknown } | null)?.caps;
    return json(Array.isArray(b) ? b : mockCaps);
  }

  return null;
}

/** Route a REST request to a fixture. Returns null when unmatched. */
function route(method: string, url: URL, body: unknown): Response | null {
  const p = url.pathname;

  if (method !== "GET") {
    const mut = routeMutation(method, url, body);
    if (mut) return mut;
  }

  if (p === apiPaths.health) return json({ ok: true, version: "mock-0.1.0" });
  if (p === apiPaths.doctor) return json(mockDoctor);

  if (p === apiPaths.projects) return json(mockProjects);
  // Project sub-resources (master-plan / agents-md / constitution) before the
  // bare project match.
  const projMaster = p.match(/^\/api\/v1\/projects\/([^/]+)\/master-plan$/);
  if (projMaster) return json(mockMasterPlan);
  const projAgents = p.match(/^\/api\/v1\/projects\/([^/]+)\/agents-md$/);
  if (projAgents) return json(mockAgentsMd);
  const projConst = p.match(/^\/api\/v1\/projects\/([^/]+)\/constitution$/);
  if (projConst) return json(mockConstitution);
  const projMatch = p.match(/^\/api\/v1\/projects\/([^/]+)$/);
  if (projMatch) {
    const path = decode(projMatch[1]!);
    const detail = mockProjectDetails[path];
    return detail ? json(detail) : errorResponse(404, `project ${path} not found`);
  }

  if (p === apiPaths.runs) {
    const projectPath = url.searchParams.get("project_path");
    const status = url.searchParams.get("status");
    let rows = mockRunSummaries;
    if (projectPath) rows = rows.filter((r) => r.project_path === projectPath);
    if (status) rows = rows.filter((r) => r.status === status);
    return json(rows);
  }
  // Run sub-resources before the bare run match.
  const runReplay = p.match(/^\/api\/v1\/runs\/([^/]+)\/replay$/);
  if (runReplay) return json(mockReplayBundle);
  const runMiss = p.match(/^\/api\/v1\/runs\/([^/]+)\/missability$/);
  if (runMiss) return json(mockMissabilityChecks);
  const runMatch = p.match(/^\/api\/v1\/runs\/([^/]+)$/);
  if (runMatch) {
    const id = decode(runMatch[1]!);
    if (id === MOCK_RUN_ID) return json(mockRunTree);
    return errorResponse(404, `run ${id} not found`);
  }

  if (p === apiPaths.providers) return json(mockProviders);
  if (p === apiPaths.models) return json(mockModels);
  if (p === apiPaths.budgetCaps) return json(mockCaps);
  if (p === apiPaths.budgets) return json(mockBudgets);
  if (p === apiPaths.janitor) return json(mockJanitor);
  if (p === apiPaths.settings) return json(mockSettings);

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

  if (p === "/api/v1/content") {
    const path = url.searchParams.get("path") ?? "";
    return json(mockContentFor(path));
  }

  // Unmatched non-GET under the API base: accept and echo.
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
      let body: unknown = undefined;
      if (init?.body && typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = undefined;
        }
      }
      const res = route(method, url, body);
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
