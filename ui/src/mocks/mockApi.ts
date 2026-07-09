/**
 * In-browser mock daemon. Enabled with VITE_MOCK=1. Patches `fetch` to serve
 * fixtures for the REST surface and replaces `EventSource` with a scripted
 * replay, so every feature screen can be built and demoed before the real
 * daemon exists.
 *
 *   VITE_MOCK=1 pnpm -F ui dev
 */
import { apiPaths, type ApiError, type RunListResponse, type CompletionReadinessResponse } from "@shared/api-types";
import {
  mockProjects,
  mockRunSummaries,
  mockProviders,
  mockAvailableProviders,
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
  mockJanitorEmpty,
  mockForums,
  mockTaxonomy,
  mockMissabilityChecks,
  mockReplayBundle,
  mockProjectDetails,
  mockProjectProfiles,
  mockMasterPlan,
  mockAgentsMd,
  mockConstitution,
  mockAgents,
  mockAgentDetail,
  mockSkills,
  mockSkillDetail,
  mockRecommendTeams,
} from "./fixtures";
import type { TeamRecommendRequest } from "@shared/api-types";
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
const settingsState = structuredClone(mockSettings);
const projectProfilesState = structuredClone(mockProjectProfiles);

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

function profileNameFromYaml(yaml: string): string | null {
  const m = yaml.match(/^\s*name\s*:\s*([^\r\n#]+?)\s*$/m);
  return m?.[1]?.trim() ?? null;
}

/** Opaque keyset run cursor: base64url of `"<started_at>|<id>"` — mirrors the server. */
function encodeRunCursor(started_at: string, id: string): string {
  return btoa(`${started_at}|${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeRunCursor(cursor: string): { started_at: string; id: string } | null {
  try {
    const raw = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const sep = raw.lastIndexOf("|");
    if (sep <= 0 || sep === raw.length - 1) return null;
    return { started_at: raw.slice(0, sep), id: raw.slice(sep + 1) };
  } catch {
    return null;
  }
}

/** Mask an API key for display: first 3 + last 4, never the raw value.
 * Provider-agnostic (mirrors the engine's maskKey), so it works for any provider. */
function maskKey(_vendor: string, raw: string): string {
  const k = raw.replace(/\s/g, "");
  if (k.length <= 8) return "*".repeat(k.length);
  return `${k.slice(0, 3)}…${k.slice(-4)}`;
}

/**
 * Where an evolution commit writes its project-scoped override — mirrors the
 * server's target derivation (rubric → .claude/rubrics/<id>.md, stage-prompt →
 * .claude/agents/<role>.md, missability → .harness/missability-overrides.json).
 */
function evolutionTargetPath(resourceRid: string): string {
  const [kind, ...rest] = resourceRid.split(":");
  const id = rest.join(":") || resourceRid;
  const base = "C:/AiAppDeployments/orbit-api";
  if (kind === "rubric") return `${base}/.claude/rubrics/${id}.md`;
  if (kind === "stage-prompt") return `${base}/.claude/agents/${id}.md`;
  if (kind === "missability") return `${base}/.harness/missability-overrides.json`;
  return `${base}/.claude/${kind}s/${id}.md`;
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
  const resume = p.match(/^\/api\/v1\/runs\/([^/]+)\/resume$/);
  if (method === "POST" && resume) {
    // Demo fixture always reports full completion — the mock run tree has no
    // real surfaced/blocked state to recover from.
    return json({ run_id: decode(resume[1]!), status: "complete", resumed: true });
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
  // Re-fetch a provider's live model list; unknown vendors 404 like the server.
  const refreshMatch = p.match(/^\/api\/v1\/providers\/([^/]+)\/models\/refresh$/);
  if (method === "POST" && refreshMatch) {
    const vendor = decode(refreshMatch[1]!);
    const known =
      mockAvailableProviders.some((a) => a.id === vendor) || mockProviders.some((x) => x.vendor === vendor);
    if (!known) return errorResponse(404, "unknown provider");
    const catalogModels = mockModels.filter((m) => m.vendor === vendor).map((m) => m.id);
    // Catalog vendors "refresh" to their catalog list; curated pi vendors fall
    // back to a static pair, mirroring the server's static-fallback path.
    return json({
      provider: vendor,
      refreshed: catalogModels.length > 0,
      models: catalogModels.length ? catalogModels : [`${vendor}-latest`, `${vendor}-mini`],
    });
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

  // Projects: register (POST) / remove (DELETE).
  if (method === "POST" && p === apiPaths.projects) {
    const b = (body as { path?: string; project_path?: string; name?: string } | null) ?? {};
    const path = b.path ?? b.project_path;
    if (!path) return errorResponse(422, "validation failed", { path: "required" });
    const name = b.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    // 201 Created with a ProjectDetail-ish body.
    return json(
      {
        path,
        name,
        profile: null,
        run_count: 0,
        last_run_at: null,
        active_profile: null,
        constitution: { present: false, sha: null, updated_at: null, sections: null },
        agents_md: { present: false, sha: null, updated_at: null, sections: null },
        master_plan: { present: false, sha: null, updated_at: null, sections: null },
        recent_runs: [],
      },
      201,
    );
  }
  const projDelete = p.match(/^\/api\/v1\/projects\/([^/]+)$/);
  if (method === "DELETE" && projDelete) {
    return json({ removed: true, path: decode(projDelete[1]!) });
  }

  // Profile detect (POST /profiles/detect, body {project_path}) — ProfileDetection.
  if (method === "POST" && p === apiPaths.profilesDetect) {
    const b = (body as { project_path?: string } | null) ?? {};
    if (!b.project_path) return errorResponse(422, "validation failed", { project_path: "required" });
    const current = mockProjectDetails[b.project_path]?.active_profile ?? null;
    return json({
      recommendation: current ?? "web-ui",
      confidence: current ? "high" : "medium",
      signals: ["package.json has react + vite", "tailwind config present", "no server entrypoint found"],
      alternatives: ["internal-tool", "sdk"],
    });
  }
  // Profile write (PUT /projects/:path/profile, body {name} | {yaml}).
  const writeProfile = p.match(/^\/api\/v1\/projects\/([^/]+)\/profile$/);
  if (method === "PUT" && writeProfile) {
    const projectPath = decode(writeProfile[1]!);
    const b = (body as { yaml?: string; name?: string } | null) ?? {};
    if (b.name) {
      const prev = projectProfilesState[projectPath];
      projectProfilesState[projectPath] = {
        path: `${projectPath}/.harness/profile.yaml`,
        yaml: `name: ${b.name}\n`,
        resolved: {
          ...(prev?.resolved ?? { name: b.name, description: "Mock profile" }),
          name: b.name,
        },
      };
      if (mockProjectDetails[projectPath]) mockProjectDetails[projectPath]!.active_profile = b.name;
      return json({ path: `${projectPath}/.harness/profile.yaml`, name: b.name });
    }
    if (typeof b.yaml === "string") {
      if (/INVALID|!!bad/.test(b.yaml) || !/name\s*:/.test(b.yaml)) {
        return errorResponse(422, "validation failed", { yaml: "profile must be a mapping with a string `name`" });
      }
      const name = profileNameFromYaml(b.yaml);
      projectProfilesState[projectPath] = {
        path: `${projectPath}/.harness/profile.yaml`,
        yaml: b.yaml,
        resolved: {
          ...(projectProfilesState[projectPath]?.resolved ?? { name: name ?? "mock-profile", description: "Mock profile" }),
          name: name ?? projectProfilesState[projectPath]?.resolved.name ?? "mock-profile",
        },
      };
      if (name && mockProjectDetails[projectPath]) mockProjectDetails[projectPath]!.active_profile = name;
      return json({ path: `${projectPath}/.harness/profile.yaml`, yaml: b.yaml });
    }
    return errorResponse(422, "validation failed", { body: "provide `name` (built-in) or `yaml` (raw profile)" });
  }

  // Doctor re-run: async ack (result would arrive via SSE).
  if (method === "POST" && p === apiPaths.doctor) {
    return json({ ok: true, started: true }, 202);
  }
  // Janitor: {dry_run:true} previews empty; otherwise "executes" the fixture.
  if (method === "POST" && p === apiPaths.janitor) {
    const b = (body as { dry_run?: boolean } | null) ?? {};
    if (b.dry_run) return json({ ...mockJanitorEmpty, ran_at: new Date().toISOString(), dry_run: true });
    return json(mockJanitor);
  }

  // Settings (generation ladders + judge pool) — echoes the persisted body.
  if (method === "PUT" && p === apiPaths.settings) {
    Object.assign(settingsState, structuredClone(body ?? mockSettings));
    return json(settingsState);
  }

  // Evolution review lifecycle — mirrors the real server: approve/reject from
  // pending; commit (from approved) REQUIRES reviewer-authored content and
  // writes the project override (422 content_required without it); rollback
  // (from committed) restores the snapshot. Wrong-status transitions 409.
  // Statuses mutate in-memory so the VITE_MOCK flow works end-to-end.
  const review = p.match(/^\/api\/v1\/evolution\/proposals\/([^/]+)\/review$/);
  if (method === "POST" && review) {
    const id = decode(review[1]!);
    const proposal = mockEvolutionProposals.find((x) => x.id === id);
    if (!proposal) return errorResponse(404, `proposal ${id} not found`);
    const b = (body as { decision?: string; content?: string } | null) ?? {};
    const decision = b.decision ?? "approve";
    const expect = (allowed: string): Response | null =>
      proposal.status === allowed
        ? null
        : errorResponse(409, `proposal ${id} is ${proposal.status}, expected ${allowed}`);

    if (decision === "approve" || decision === "reject") {
      const guard = expect("pending");
      if (guard) return guard;
      proposal.status = decision === "approve" ? "approved" : "rejected";
      return json({ id, decision, status: proposal.status, updated: true });
    }
    if (decision === "commit") {
      const guard = expect("approved");
      if (guard) return guard;
      if (typeof b.content !== "string" || !b.content.trim()) {
        return errorResponse(422, "content_required", {
          content: "reviewer-authored replacement content is required to commit",
        });
      }
      proposal.status = "committed";
      return json({
        id,
        decision,
        status: "committed",
        updated: true,
        target_path: evolutionTargetPath(proposal.resource_rid),
        snapshot_path: null,
      });
    }
    if (decision === "rollback") {
      const guard = expect("committed");
      if (guard) return guard;
      proposal.status = "rolled_back";
      return json({
        id,
        decision,
        status: "rolled_back",
        updated: true,
        target_path: evolutionTargetPath(proposal.resource_rid),
        snapshot_path: null,
      });
    }
    return errorResponse(422, "validation failed", { decision: "unknown decision" });
  }

  // Team recommendation — deterministic heuristics, no model calls.
  if (method === "POST" && p === apiPaths.teamsRecommend) {
    const b = (body as TeamRecommendRequest | null) ?? { request_text: "" };
    if (!b.request_text) return errorResponse(422, "validation failed", { request_text: "required" });
    return json(mockRecommendTeams(b));
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
  const projProfile = p.match(/^\/api\/v1\/projects\/([^/]+)\/profile$/);
  if (projProfile) {
    const path = decode(projProfile[1]!);
    return json(projectProfilesState[path] ?? null);
  }
  const projMatch = p.match(/^\/api\/v1\/projects\/([^/]+)$/);
  if (projMatch) {
    const path = decode(projMatch[1]!);
    const detail = mockProjectDetails[path];
    return detail ? json(detail) : errorResponse(404, `project ${path} not found`);
  }

  if (p === apiPaths.runs) {
    const projectPath = url.searchParams.get("project_path");
    const status = url.searchParams.get("status");
    const limitRaw = Number(url.searchParams.get("limit") ?? "");
    const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 50, 500));
    // Keyset order (started_at, id) DESC — mirrors the server's listRuns.
    let rows = [...mockRunSummaries].sort((a, b) =>
      a.started_at === b.started_at ? (a.id < b.id ? 1 : -1) : a.started_at < b.started_at ? 1 : -1,
    );
    if (projectPath) rows = rows.filter((r) => r.project_path === projectPath);
    if (status) rows = rows.filter((r) => r.status === status);
    const cursorParam = url.searchParams.get("cursor");
    const c = cursorParam ? decodeRunCursor(cursorParam) : null;
    // A malformed cursor is ignored (first page), matching the server.
    if (c) rows = rows.filter((r) => r.started_at < c.started_at || (r.started_at === c.started_at && r.id < c.id));
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const next_cursor = rows.length > limit && last ? encodeRunCursor(last.started_at, last.id) : null;
    return json({ items, next_cursor } satisfies RunListResponse);
  }
  // Run sub-resources before the bare run match.
  const runReplay = p.match(/^\/api\/v1\/runs\/([^/]+)\/replay$/);
  if (runReplay) return json(mockReplayBundle);
  const runMiss = p.match(/^\/api\/v1\/runs\/([^/]+)\/missability$/);
  if (runMiss) return json(mockMissabilityChecks);
  const runReadiness = p.match(/^\/api\/v1\/runs\/([^/]+)\/completion-readiness$/);
  if (runReadiness) {
    const id = decode(runReadiness[1]!);
    return json({
      run_id: id,
      resumable: true,
      blocking_reason: null,
      surfaced_stages: [],
      incomplete_stages: [],
      remaining_planned_stages: [],
      missing_required_artifacts: [],
      failed_required_missability_checks: [],
      unpopulated_master_plan_sections: [],
    } satisfies CompletionReadinessResponse);
  }
  const runBorda = p.match(/^\/api\/v1\/runs\/([^/]+)\/borda$/);
  if (runBorda) {
    return json([
      { stage_id: "stg_impl", borda: { leader_attempt_id: "att_impl_b", ranking: [
        { attempt_id: "att_impl_b", points: 6, rank: 1 },
        { attempt_id: "att_impl_a", points: 4, rank: 2 },
        { attempt_id: "att_impl_c", points: 2, rank: 3 },
      ] } },
    ]);
  }
  const runMatch = p.match(/^\/api\/v1\/runs\/([^/]+)$/);
  if (runMatch) {
    const id = decode(runMatch[1]!);
    if (id === MOCK_RUN_ID) return json(mockRunTree);
    return errorResponse(404, `run ${id} not found`);
  }

  if (p === apiPaths.providers) return json(mockProviders);
  if (p === apiPaths.providersOauth) return json({ providers: [] });
  if (p === apiPaths.providersAvailable) return json(mockAvailableProviders);
  const provModelsMatch = p.match(/^\/api\/v1\/providers\/([^/]+)\/models$/);
  if (provModelsMatch) {
    const vendor = decode(provModelsMatch[1]!);
    return json({ provider: vendor, models: mockModels.filter((m) => m.vendor === vendor).map((m) => m.id) });
  }
  if (p === apiPaths.models) return json(mockModels);
  if (p === apiPaths.budgetCaps) return json(mockCaps);
  const budgetScope = p.match(/^\/api\/v1\/budgets\/([^/]+)$/);
  if (budgetScope) {
    const scope = decode(budgetScope[1]!);
    return json(mockBudgets.find((b) => b.scope === scope) ?? null);
  }
  if (p === apiPaths.budgets) return json(mockBudgets);
  if (p === apiPaths.janitor) return json(mockJanitorEmpty);
  if (p === apiPaths.settings) return json(settingsState);
  if (p === apiPaths.taxonomy) return json(mockTaxonomy);
  if (p === apiPaths.forums) return json(mockForums);
  const forumMatch = p.match(/^\/api\/v1\/forums\/([^/]+)$/);
  if (forumMatch) {
    const id = decode(forumMatch[1]!);
    const f = mockForums.find((x) => x.id === id);
    return f ? json(f) : errorResponse(404, `forum ${id} not found`);
  }

  // Agents library: list is the summary; detail adds the prompt body.
  if (p === apiPaths.agents) return json(mockAgents);
  const agentMatch = p.match(/^\/api\/v1\/agents\/([^/]+)$/);
  if (agentMatch) {
    const id = decode(agentMatch[1]!);
    const a = mockAgents.find((x) => x.id === id);
    return a ? json(mockAgentDetail(a)) : errorResponse(404, `agent ${id} not found`);
  }

  // Skill registry: list is the summary; detail adds body + injection budget.
  if (p === apiPaths.skills) return json(mockSkills);
  const skillMatch = p.match(/^\/api\/v1\/skills\/([^/]+)$/);
  if (skillMatch) {
    const id = decode(skillMatch[1]!);
    const s = mockSkills.find((x) => x.id === id);
    return s ? json(mockSkillDetail(s)) : errorResponse(404, `skill ${id} not found`);
  }

  // Faithful to the server: the list is a SUMMARY without stages.
  if (p === apiPaths.teams) {
    return json(mockTeams.map(({ stages: _stages, missability_required: _m, ...summary }) => summary));
  }
  const teamMatch = p.match(/^\/api\/v1\/teams\/([^/]+)$/);
  if (teamMatch) {
    const name = decode(teamMatch[1]!);
    const t = mockTeams.find((x) => x.name === name);
    // Faithful to the server: detail is wrapped as { team, origin }.
    return t ? json({ team: t, origin: t.origin ?? "builtin" }) : errorResponse(404, `team ${name} not found`);
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
