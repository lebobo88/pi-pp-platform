"use strict";
/**
 * pi-pp-platform wire contract — hand-maintained, no codegen.
 *
 * This is the single source of truth for the shape of every value that crosses
 * the boundary between the pp-daemon (REST /api/v1 + two SSE streams on
 * 127.0.0.1:7878) and the React SPA. Row-shaped types (RunRow, StageRow, …)
 * mirror the SQLite schema in packages/core/src/db/schema.ts field-for-field
 * (snake_case, nullable columns typed `T | null`) so the daemon can return raw
 * rows and the UI can consume them without a translation layer.
 *
 * Keep in sync with:
 *   - packages/core/src/db/schema.ts   (row shapes)
 *   - the daemon's config.ts           (status / mode / vendor enums)
 *   - packages/core/catalog.json       (providers/models/pricing; both prices.json
 *     files are generated from it by scripts/generate-catalog-providers.mjs)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiPaths = exports.API_BASE = exports.RUN_SSE_EVENT_TYPES = exports.GLOBAL_SSE_EVENT_TYPES = exports.CLAUDE_TIERS = exports.VENDORS = exports.RUN_MODE = exports.VERDICT_OUTCOME = exports.ATTEMPT_STATUS = exports.STAGE_STATUS = exports.RUN_STATUS = void 0;
/* ────────────────────────────────────────────────────────────────────────
 * Enums — mirror daemon/src/config.ts
 * ──────────────────────────────────────────────────────────────────────── */
exports.RUN_STATUS = ["pending", "running", "surfaced", "complete", "crashed", "aborted"];
exports.STAGE_STATUS = ["open", "passed", "surfaced", "skipped"];
exports.ATTEMPT_STATUS = ["ok", "error", "timeout", "needs_review"];
exports.VERDICT_OUTCOME = ["pass", "fail", "revise"];
exports.RUN_MODE = ["single", "best_of", "team", "review"];
/**
 * Historical built-in providers, kept as a display hint. The real provider set
 * is DYNAMIC (catalog-driven, exposed via GET /providers and /providers/available),
 * so `Vendor` is an open provider id — any of pi's providers may appear.
 */
exports.VENDORS = ["openai", "google", "anthropic"];
exports.CLAUDE_TIERS = ["haiku", "sonnet", "opus", "fable"];
exports.GLOBAL_SSE_EVENT_TYPES = [
    "run.created",
    "run.status",
    "run.finalized",
    "budget.tripwire",
    "provider.status",
    "doctor.result",
    "evolution.proposal.created",
    "janitor.result",
    "run.queued",
];
exports.RUN_SSE_EVENT_TYPES = [
    "run.started",
    "run.context",
    "stage.started",
    "stage.finalized",
    "stage.surfaced",
    "attempt.started",
    "attempt.output",
    "attempt.completed",
    "verdict.recorded",
    "verdict.retracted",
    "reflexion.retry",
    "borda.updated",
    "smoke.status",
    "validation.result",
    "missability.result",
    "budget.tick",
    "run.finalized",
    "phase.completed",
    "context.warning",
];
/* ────────────────────────────────────────────────────────────────────────
 * REST path builder
 *
 * Single source of truth for every REST route the client hits. Values are
 * functions where the path is parameterized, strings otherwise. All paths are
 * relative to the daemon origin (the dev server proxies /api → :7878).
 * ──────────────────────────────────────────────────────────────────────── */
exports.API_BASE = "/api/v1";
exports.apiPaths = {
    base: exports.API_BASE,
    health: "/healthz",
    doctor: `${exports.API_BASE}/doctor`,
    projects: `${exports.API_BASE}/projects`,
    project: (path) => `${exports.API_BASE}/projects/${encodeURIComponent(path)}`,
    /** GET reads / PUT writes `.harness/profile.yaml` (body: {name} | {yaml}). */
    projectProfile: (path) => `${exports.API_BASE}/projects/${encodeURIComponent(path)}/profile`,
    /** POST — body {project_path}; returns a ProfileDetection. */
    profilesDetect: `${exports.API_BASE}/profiles/detect`,
    projectMasterPlan: (path) => `${exports.API_BASE}/projects/${encodeURIComponent(path)}/master-plan`,
    projectAgentsMd: (path) => `${exports.API_BASE}/projects/${encodeURIComponent(path)}/agents-md`,
    projectConstitution: (path) => `${exports.API_BASE}/projects/${encodeURIComponent(path)}/constitution`,
    runs: `${exports.API_BASE}/runs`,
    run: (runId) => `${exports.API_BASE}/runs/${encodeURIComponent(runId)}`,
    /** Per-run SSE stream. When PP_API_TOKEN is set this endpoint ALSO accepts
     *  the bearer as `?token=` — EventSource cannot send headers. */
    runEvents: (runId) => `${exports.API_BASE}/runs/${encodeURIComponent(runId)}/events`,
    runEventLog: (runId) => `${exports.API_BASE}/runs/${encodeURIComponent(runId)}/event-log`,
    runReplay: (runId) => `${exports.API_BASE}/runs/${encodeURIComponent(runId)}/replay`,
    runMissability: (runId) => `${exports.API_BASE}/runs/${encodeURIComponent(runId)}/missability`,
    runBorda: (runId) => `${exports.API_BASE}/runs/${encodeURIComponent(runId)}/borda`,
    runAbort: (runId) => `${exports.API_BASE}/runs/${encodeURIComponent(runId)}/abort`,
    /** GET — read-only completion-readiness blockers (see CompletionReadinessResponse). */
    runCompletionReadiness: (runId) => `${exports.API_BASE}/runs/${encodeURIComponent(runId)}/completion-readiness`,
    /** POST — resume a surfaced/blocked run on the same run_id (see RunResumeResponse). */
    runResume: (runId) => `${exports.API_BASE}/runs/${encodeURIComponent(runId)}/resume`,
    runStageRetry: (runId, stageId) => `${exports.API_BASE}/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/retry`,
    runStageGate: (runId, stageId) => `${exports.API_BASE}/runs/${encodeURIComponent(runId)}/stages/${encodeURIComponent(stageId)}/gate`,
    providers: `${exports.API_BASE}/providers`,
    providersAvailable: `${exports.API_BASE}/providers/available`,
    providerKey: (vendor) => `${exports.API_BASE}/providers/${encodeURIComponent(vendor)}/key`,
    providerTest: (vendor) => `${exports.API_BASE}/providers/${encodeURIComponent(vendor)}/test`,
    providerModels: (vendor) => `${exports.API_BASE}/providers/${encodeURIComponent(vendor)}/models`,
    /** POST — re-fetch a dynamic provider's live model list (no body). */
    providerModelsRefresh: (vendor) => `${exports.API_BASE}/providers/${encodeURIComponent(vendor)}/models/refresh`,
    /** GET — vendors that support subscription (OAuth) login. */
    providersOauth: `${exports.API_BASE}/providers/oauth`,
    /** POST — start a subscription (OAuth) login; returns an OAuthLoginState. */
    providerLogin: (vendor) => `${exports.API_BASE}/providers/${encodeURIComponent(vendor)}/login`,
    /** GET — poll a login's state. */
    providerLoginState: (loginId) => `${exports.API_BASE}/providers/login/${encodeURIComponent(loginId)}`,
    /** POST — supply a pending paste-a-code input (body OAuthLoginInputRequest). */
    providerLoginInput: (loginId) => `${exports.API_BASE}/providers/login/${encodeURIComponent(loginId)}/input`,
    /** DELETE — abort an in-flight login. */
    providerLoginAbort: (loginId) => `${exports.API_BASE}/providers/login/${encodeURIComponent(loginId)}`,
    models: `${exports.API_BASE}/models`,
    budgets: `${exports.API_BASE}/budgets`,
    budget: (scope) => `${exports.API_BASE}/budgets/${encodeURIComponent(scope)}`,
    budgetCaps: `${exports.API_BASE}/budgets/caps`,
    teams: `${exports.API_BASE}/teams`,
    team: (name) => `${exports.API_BASE}/teams/${encodeURIComponent(name)}`,
    /** POST — body TeamRecommendRequest; returns a TeamRecommendResponse. */
    teamsRecommend: `${exports.API_BASE}/teams/recommend`,
    agents: `${exports.API_BASE}/agents`,
    agent: (id) => `${exports.API_BASE}/agents/${encodeURIComponent(id)}`,
    skills: `${exports.API_BASE}/skills`,
    skill: (id) => `${exports.API_BASE}/skills/${encodeURIComponent(id)}`,
    profiles: `${exports.API_BASE}/profiles`,
    profile: (name) => `${exports.API_BASE}/profiles/${encodeURIComponent(name)}`,
    forums: `${exports.API_BASE}/forums`,
    forum: (id) => `${exports.API_BASE}/forums/${encodeURIComponent(id)}`,
    taxonomy: `${exports.API_BASE}/taxonomy`,
    rubrics: `${exports.API_BASE}/rubrics`,
    rubric: (id) => `${exports.API_BASE}/rubrics/${encodeURIComponent(id)}`,
    /** GET — per-judge aggregation over active verdicts; returns { items }. */
    judgeStats: `${exports.API_BASE}/judges/stats`,
    evolution: `${exports.API_BASE}/evolution/proposals`,
    evolutionProposal: (id) => `${exports.API_BASE}/evolution/proposals/${encodeURIComponent(id)}`,
    evolutionReview: (id) => `${exports.API_BASE}/evolution/proposals/${encodeURIComponent(id)}/review`,
    janitor: `${exports.API_BASE}/system/janitor`,
    /** Generation-ladders + judge-pool settings. GET/PUT persisted server-side
     *  (packages/server/src/routes/library.ts). */
    settings: `${exports.API_BASE}/settings`,
    /** Fetch a file/artifact body by its (project-relative) path. */
    /**
     * Artifact/file content. Artifact paths are stored RELATIVE to the project
     * root, so pass `opts.projectPath` (or `opts.runId`, from which the server
     * looks up the root) to resolve them; absolute paths need neither.
     */
    content: (path, opts) => {
        const qs = new URLSearchParams({ path });
        if (opts?.projectPath)
            qs.set("project_path", opts.projectPath);
        if (opts?.runId)
            qs.set("run_id", opts.runId);
        return `${exports.API_BASE}/content?${qs.toString()}`;
    },
    /** Global SSE stream. When PP_API_TOKEN is set this endpoint ALSO accepts
     *  the bearer as `?token=` — EventSource cannot send headers. */
    events: `${exports.API_BASE}/events`,
};
//# sourceMappingURL=api-types.js.map