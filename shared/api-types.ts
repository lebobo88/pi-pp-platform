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
 *   - assets/prices.json               (ModelInfo)
 */

/* ────────────────────────────────────────────────────────────────────────
 * Enums — mirror daemon/src/config.ts
 * ──────────────────────────────────────────────────────────────────────── */

export const RUN_STATUS = ["pending", "running", "surfaced", "complete", "crashed", "aborted"] as const;
export type RunStatus = (typeof RUN_STATUS)[number];

export const STAGE_STATUS = ["open", "passed", "surfaced", "skipped"] as const;
export type StageStatus = (typeof STAGE_STATUS)[number];

export const ATTEMPT_STATUS = ["ok", "error", "timeout", "needs_review"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUS)[number];

export const VERDICT_OUTCOME = ["pass", "fail", "revise"] as const;
export type VerdictOutcome = (typeof VERDICT_OUTCOME)[number];

export const RUN_MODE = ["single", "best_of", "team", "review"] as const;
export type RunMode = (typeof RUN_MODE)[number];

export const VENDORS = ["openai", "google", "anthropic"] as const;
export type Vendor = (typeof VENDORS)[number];

export const CLAUDE_TIERS = ["haiku", "sonnet", "opus", "fable"] as const;
export type ClaudeTier = (typeof CLAUDE_TIERS)[number];

export type GateType =
  | "spec"
  | "design"
  | "security"
  | "contract"
  | "code_style"
  | "docs_polish"
  | "lint_class";

export type JudgeTier = "cross_vendor" | "same_vendor";

/* ────────────────────────────────────────────────────────────────────────
 * DB row shapes — mirror packages/core/src/db/schema.ts
 * ──────────────────────────────────────────────────────────────────────── */

/** `runs` table row. */
export interface RunRow {
  id: string;
  session_id: string | null;
  project_path: string;
  request_text: string;
  team: string | null;
  mode: RunMode;
  forum: string | null;
  n: number | null;
  status: RunStatus;
  profile_snapshot_json: string | null;
  taxonomy_mapping_json: string | null;
  head_sha: string | null;
  tree_dirty_hash: string | null;
  cli_versions_json: string | null;
  cli_flags_json: string | null;
  hydra_workflow_id: string | null;
  hydra_envelope_id: string | null;
  hydra_origin_squad: string | null;
  hydra_envelope_type: string | null;
  constitution_sha: string | null;
  constitution_attestation_id: string | null;
  eights_episodic_handle: string | null;
  audit_bom_handle: string | null;
  started_at: string;
  finished_at: string | null;
}

/** `stages` table row. */
export interface StageRow {
  id: string;
  run_id: string;
  kind: string;
  gate_type: GateType | string;
  status: StageStatus;
  winner_attempt_id: string | null;
  started_at: string;
  finished_at: string | null;
  notes_json: string | null;
}

/** `attempts` table row. */
export interface AttemptRow {
  id: string;
  stage_id: string;
  producer: string;
  model_id: string;
  prompt_hash: string | null;
  artifact_path: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  wall_ms: number | null;
  retry_index: number;
  parent_attempt_id: string | null;
  status: AttemptStatus;
  attempted_tier: ClaudeTier | null;
  created_at: string;
}

/** `verdicts` table row. */
export interface VerdictRow {
  id: string;
  attempt_id: string;
  judge_producer: string;
  judge_model_id: string;
  rubric_id: string | null;
  outcome: VerdictOutcome;
  critique_md: string | null;
  score_json: string | null;
  cross_vendor: number; // 0 | 1 (SQLite boolean)
  eights_memory_id: string | null;
  created_at: string;
}

/** `artifacts` table row. */
export interface ArtifactRow {
  id: string;
  run_id: string;
  stage_id: string | null;
  taxonomy_section: string | null;
  kind: string | null;
  path: string;
  sha256: string;
  bytes: number;
  cell: string | null;
  eights_memory_id: string | null;
  eights_handle: string | null;
  created_at: string;
}

/** `missability_checks` table row. */
export interface MissabilityCheckRow {
  id: string;
  run_id: string;
  check_id: string;
  status: "pass" | "fail" | "skipped" | string;
  evidence_path: string | null;
  created_at: string;
}

/**
 * Full run detail — the shape returned by the daemon's `getRun(run_id)`
 * (orchestrator/runs.ts): raw rows for the run and every descendant, joined
 * client-side into the run tree the /runs/:runId screen renders.
 */
export interface RunTree {
  run: RunRow;
  stages: StageRow[];
  attempts: AttemptRow[];
  verdicts: VerdictRow[];
  artifacts: ArtifactRow[];
}

/**
 * Compact run listing — the projection returned by `listRuns` (SELECT id,
 * project_path, request_text, team, mode, status, started_at, finished_at).
 */
export interface RunSummary {
  id: string;
  project_path: string;
  request_text: string;
  team: string | null;
  mode: RunMode;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  /**
   * Rolling run cost. Not a `runs` column — the daemon LEFT JOINs
   * budgets(scope="run:<id>") into the list projection. Optional so a bare
   * listing without the join still type-checks.
   */
  cost_usd?: number | null;
}

/* ────────────────────────────────────────────────────────────────────────
 * UI-level resource shapes
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * A project the harness has seen. The daemon keys everything off
 * `project_path`; the UI treats a distinct path as a project and derives a
 * display name from its basename.
 */
export interface Project {
  /** Canonical absolute project path — the primary key. */
  path: string;
  /** Display name (basename of path, or an operator-set label). */
  name: string;
  /** ISO timestamp of the most recent run in this project, if any. */
  last_run_at: string | null;
  /** Total runs recorded against this path. */
  run_count: number;
  /** Detected profile name, when known. */
  profile: string | null;
}

/**
 * Provider (vendor) health as surfaced to the UI. NEVER carries a raw API key
 * — only a masked fragment (e.g. "sk-…4f9c") suitable for display.
 */
export interface ProviderStatus {
  vendor: Vendor;
  /** CLI installed AND a usable credential present. */
  configured: boolean;
  cli_installed: boolean;
  cli_version: string | null;
  has_api_key: boolean;
  logged_in: boolean;
  /** Masked key fragment for display; null when no key is set. */
  masked_key: string | null;
  /** Creds say "configured" but a smoke probe revealed a broken bridge. */
  degraded: boolean;
}

/** A model the harness can route to, priced from assets/prices.json. */
export interface ModelInfo {
  id: string;
  vendor: Vendor;
  /** Claude tier this model backs, when it is a Claude model. */
  tier: ClaudeTier | null;
  /** USD per 1M input tokens. */
  input_per_1m: number;
  /** USD per 1M output tokens. */
  output_per_1m: number;
  /** Free-form pricing caveat from prices.json `_pricing_notes`, if any. */
  note?: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * Team / Profile specs — mirror daemon/src/orchestrator/{teams,profiles}.ts
 * ──────────────────────────────────────────────────────────────────────── */

export interface TeamStage {
  kind: string;
  artifact_kind?: string;
  gate_type: string;
  generator: {
    agent: string;
    primary?: string;
    fallback?: string;
    model_tier?: ClaudeTier;
  };
  judge: { tier: JudgeTier; rubric?: string; model_pref?: string };
  best_of_n_on_major_scope?: number;
}

export interface TeamSpec {
  name: string;
  description: string;
  origin?: "project" | "user" | "builtin";
  profiles_compatible?: string[];
  stages: TeamStage[];
  taxonomy_required?: string[];
  missability_required?: string[];
}

export interface ProfileSpec {
  name: string;
  description: string;
  extends?: string[];
  required_taxonomy_sections?: string[];
  required_rubrics?: Record<string, string>;
  required_artifacts?: string[];
  required_missability_checks?: string[];
  required_validators?: Record<string, string[]>;
  required_validators_strict?: string[];
  notes?: string;
}

/** A standard-aligned rubric shipped with the harness (`rubrics` table). */
export interface RubricInfo {
  id: string;
  kind: string;
  version: string;
  source_url: string | null;
  /** Full markdown body — present on detail fetch, omitted from list. */
  markdown?: string;
}

/** A `budgets` table row — rolling token/cost totals for a scope. */
export interface BudgetEntry {
  /** e.g. "run:<id>", "day:2026-07-01", "model:<id>", "tier:opus". */
  scope: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  updated_at: string;
}

/** An `evolution_proposals` table row (T4 autogenesis). */
export interface EvolutionProposal {
  id: string;
  run_id: string;
  resource_rid: string;
  proposed_change: string;
  justification: string;
  signal_count: number;
  risk_class: string;
  eights_proposal_id: string | null;
  status: "pending" | "approved" | "rejected" | "committed" | "rolled_back" | string;
  created_at: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * Doctor — mirror daemon/src/orchestrator/runs.ts `doctor()`
 * ──────────────────────────────────────────────────────────────────────── */

export interface DoctorVendorCredentials {
  cli: boolean;
  api_key: boolean;
  logged_in: boolean;
}

export interface DoctorSmokeResult {
  status: "ok" | "fail" | "skipped";
  model: string;
  exit_code?: number;
  stderr_tail?: string;
  wall_ms?: number;
  reason?: string;
}

export interface DoctorReport {
  cli_versions: Record<string, string | null>;
  db_reachable: boolean;
  vendors_configured: Record<Vendor, boolean>;
  vendor_credentials: Record<Vendor, DoctorVendorCredentials>;
  judge_capabilities: unknown;
  vendor_degraded: Record<Vendor, boolean>;
  gemini_disabled: boolean;
  cross_vendor_ready: boolean;
  critique_smoke: Record<string, DoctorSmokeResult>;
  browser_engines: {
    playwright: { status: string; reason?: string };
    chrome_mcp: { status: string; note: string };
  };
  db_path: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * Project detail + managed documents (M5b read-only screens)
 * ──────────────────────────────────────────────────────────────────────── */

/** Presence/freshness of a harness-managed document (CONSTITUTION/AGENTS.md/…). */
export interface DocStatus {
  present: boolean;
  sha: string | null;
  updated_at: string | null;
  /** Number of managed sections, when applicable (master plan / AGENTS.md). */
  sections: number | null;
}

/** A managed markdown document's full body (fetched for the panel view). */
export interface DocContent {
  path: string;
  markdown: string;
  sha: string;
  updated_at: string;
}

/** Project overview enriched with managed-document status. */
export interface ProjectDetail extends Project {
  active_profile: string | null;
  constitution: DocStatus;
  agents_md: DocStatus;
  master_plan: DocStatus;
  recent_runs: RunSummary[];
}

/* ────────────────────────────────────────────────────────────────────────
 * Budget caps
 * ──────────────────────────────────────────────────────────────────────── */

/** A configured spend cap for a budget scope prefix (read-only in M5b). */
export interface BudgetCap {
  /** Scope prefix the cap applies to: "day" | "run" | "model" | "tier". */
  scope: string;
  limit_usd: number;
  /** Fraction (0..1) at which the harness downgrades the model tier. */
  warn_pct: number;
  /** Fraction (0..1) at which the harness blocks pending HITL. */
  block_pct: number;
}

/* ────────────────────────────────────────────────────────────────────────
 * Replay bundle — mirror daemon/src/orchestrator/replay.ts reconstruction
 * ──────────────────────────────────────────────────────────────────────── */

export interface ReplayBundle {
  run_id: string;
  head_sha: string | null;
  tree_dirty_hash: string | null;
  cli_versions: Record<string, string | null>;
  cli_flags: Record<string, unknown> | null;
  stages: Array<{
    stage_id: string;
    kind: string;
    gate_type: string;
    prompt_hashes: string[];
  }>;
  artifacts: Array<{ path: string; sha256: string; bytes: number }>;
  generated_at: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * Janitor report — mirror daemon/src/orchestrator/janitor.ts
 * ──────────────────────────────────────────────────────────────────────── */

export interface JanitorReport {
  ran_at: string;
  swept: number;
  reclaimed_bytes: number;
  entries: Array<{ path: string; kind: string; bytes: number; age_days: number }>;
}

/** Raw text body of an on-disk artifact / candidate output (by path). */
export interface ArtifactContent {
  path: string;
  /** "diff" | "markdown" | "text" | "json" | … (viewer hint). */
  kind: string;
  content: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * Error envelope
 * ──────────────────────────────────────────────────────────────────────── */

/** Non-2xx response body. `details` carries per-field errors on 422. */
export interface ApiError {
  error: string;
  details?: Record<string, string> | unknown;
}

/* ────────────────────────────────────────────────────────────────────────
 * SSE event union
 *
 * Two streams: a global stream (GET /api/v1/events) and a per-run stream
 * (GET /api/v1/runs/:runId/events). Every frame is `{type, run_id?, ts, seq,
 * data}`. `seq` is monotonic per stream and used as the SSE `id:` for
 * Last-Event-ID resume; `ts` is an ISO timestamp.
 * ──────────────────────────────────────────────────────────────────────── */

/** Base envelope shared by every SSE frame. */
export interface SseEnvelope<TType extends string, TData> {
  type: TType;
  /** Present on all run-scoped events; absent on some global events. */
  run_id?: string;
  ts: string;
  seq: number;
  data: TData;
}

/* ── Global stream events ─────────────────────────────────────────────── */

export type RunCreatedEvent = SseEnvelope<"run.created", RunSummary>;
export type RunStatusEvent = SseEnvelope<
  "run.status",
  { run_id: string; status: RunStatus }
>;
export type RunFinalizedGlobalEvent = SseEnvelope<
  "run.finalized",
  { run_id: string; status: RunStatus; finished_at: string }
>;
export type BudgetTripwireEvent = SseEnvelope<
  "budget.tripwire",
  { scope: string; pct: number; limit_usd: number; cost_usd: number; action: "downgrade" | "block" | "warn" }
>;
export type ProviderStatusEvent = SseEnvelope<"provider.status", ProviderStatus>;
export type DoctorResultEvent = SseEnvelope<"doctor.result", DoctorReport>;
export type EvolutionProposalCreatedEvent = SseEnvelope<
  "evolution.proposal.created",
  EvolutionProposal
>;
export type JanitorResultEvent = SseEnvelope<
  "janitor.result",
  { swept: number; reclaimed_bytes: number; details?: unknown }
>;

export type GlobalSseEvent =
  | RunCreatedEvent
  | RunStatusEvent
  | RunFinalizedGlobalEvent
  | BudgetTripwireEvent
  | ProviderStatusEvent
  | DoctorResultEvent
  | EvolutionProposalCreatedEvent
  | JanitorResultEvent;

/* ── Per-run stream events ────────────────────────────────────────────── */

export type StageStartedEvent = SseEnvelope<"stage.started", StageRow>;
export type StageFinalizedEvent = SseEnvelope<
  "stage.finalized",
  { stage_id: string; status: StageStatus; winner_attempt_id: string | null }
>;
export type AttemptStartedEvent = SseEnvelope<"attempt.started", AttemptRow>;
export type AttemptOutputEvent = SseEnvelope<
  "attempt.output",
  { attempt_id: string; stage_id: string; chunk: string }
>;
export type AttemptCompletedEvent = SseEnvelope<"attempt.completed", AttemptRow>;
export type VerdictRecordedEvent = SseEnvelope<"verdict.recorded", VerdictRow>;
export type VerdictRetractedEvent = SseEnvelope<
  "verdict.retracted",
  { verdict_id: string; attempt_id: string; retracted_at: string }
>;
export type ReflexionRetryEvent = SseEnvelope<
  "reflexion.retry",
  { stage_id: string; parent_attempt_id: string; retry_index: number; critique_md: string | null }
>;
export type BordaUpdatedEvent = SseEnvelope<
  "borda.updated",
  {
    stage_id: string;
    ranking: Array<{ attempt_id: string; points: number; rank: number }>;
    leader_attempt_id: string | null;
  }
>;
export type SmokeStatusEvent = SseEnvelope<
  "smoke.status",
  { attempt_id: string; stage_id: string; status: "pass" | "fail" | "skipped"; route?: string; detail?: string }
>;
export type ValidationResultEvent = SseEnvelope<
  "validation.result",
  {
    stage_id: string;
    artifact_id: string | null;
    validator_kind: string;
    status: "verified" | "violation" | "execution_error" | "skipped";
    reason?: string;
  }
>;
export type MissabilityResultEvent = SseEnvelope<
  "missability.result",
  { check_id: string; status: "pass" | "fail" | "skipped"; evidence_path: string | null }
>;
export type BudgetTickEvent = SseEnvelope<
  "budget.tick",
  { scope: string; tokens_in: number; tokens_out: number; cost_usd: number }
>;
export type RunFinalizedEvent = SseEnvelope<
  "run.finalized",
  { run_id: string; status: RunStatus; finished_at: string }
>;

export type RunSseEvent =
  | StageStartedEvent
  | StageFinalizedEvent
  | AttemptStartedEvent
  | AttemptOutputEvent
  | AttemptCompletedEvent
  | VerdictRecordedEvent
  | VerdictRetractedEvent
  | ReflexionRetryEvent
  | BordaUpdatedEvent
  | SmokeStatusEvent
  | ValidationResultEvent
  | MissabilityResultEvent
  | BudgetTickEvent
  | RunFinalizedEvent;

/** Any SSE event across either stream. */
export type SseEvent = GlobalSseEvent | RunSseEvent;

/** Discriminant union of every event `type` string. */
export type SseEventType = SseEvent["type"];

/** Narrow an SseEvent to a specific member by its `type`. */
export type SseEventOf<T extends SseEventType> = Extract<SseEvent, { type: T }>;

export const GLOBAL_SSE_EVENT_TYPES: readonly GlobalSseEvent["type"][] = [
  "run.created",
  "run.status",
  "run.finalized",
  "budget.tripwire",
  "provider.status",
  "doctor.result",
  "evolution.proposal.created",
  "janitor.result",
];

export const RUN_SSE_EVENT_TYPES: readonly RunSseEvent["type"][] = [
  "stage.started",
  "stage.finalized",
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
];

/* ────────────────────────────────────────────────────────────────────────
 * REST path builder
 *
 * Single source of truth for every REST route the client hits. Values are
 * functions where the path is parameterized, strings otherwise. All paths are
 * relative to the daemon origin (the dev server proxies /api → :7878).
 * ──────────────────────────────────────────────────────────────────────── */

export const API_BASE = "/api/v1" as const;

export const apiPaths = {
  base: API_BASE,

  health: "/healthz",
  doctor: `${API_BASE}/doctor`,

  projects: `${API_BASE}/projects`,
  project: (path: string) => `${API_BASE}/projects/${encodeURIComponent(path)}`,
  projectMasterPlan: (path: string) => `${API_BASE}/projects/${encodeURIComponent(path)}/master-plan`,
  projectAgentsMd: (path: string) => `${API_BASE}/projects/${encodeURIComponent(path)}/agents-md`,
  projectConstitution: (path: string) => `${API_BASE}/projects/${encodeURIComponent(path)}/constitution`,

  runs: `${API_BASE}/runs`,
  run: (runId: string) => `${API_BASE}/runs/${encodeURIComponent(runId)}`,
  runEvents: (runId: string) => `${API_BASE}/runs/${encodeURIComponent(runId)}/events`,
  runReplay: (runId: string) => `${API_BASE}/runs/${encodeURIComponent(runId)}/replay`,
  runMissability: (runId: string) => `${API_BASE}/runs/${encodeURIComponent(runId)}/missability`,

  providers: `${API_BASE}/providers`,
  models: `${API_BASE}/models`,

  budgets: `${API_BASE}/budgets`,
  budget: (scope: string) => `${API_BASE}/budgets/${encodeURIComponent(scope)}`,
  budgetCaps: `${API_BASE}/budgets/caps`,

  teams: `${API_BASE}/teams`,
  team: (name: string) => `${API_BASE}/teams/${encodeURIComponent(name)}`,

  profiles: `${API_BASE}/profiles`,
  profile: (name: string) => `${API_BASE}/profiles/${encodeURIComponent(name)}`,

  rubrics: `${API_BASE}/rubrics`,
  rubric: (id: string) => `${API_BASE}/rubrics/${encodeURIComponent(id)}`,

  evolution: `${API_BASE}/evolution/proposals`,
  evolutionProposal: (id: string) => `${API_BASE}/evolution/proposals/${encodeURIComponent(id)}`,

  janitor: `${API_BASE}/system/janitor`,

  /** Fetch a file/artifact body by its (project-relative) path. */
  content: (path: string) => `${API_BASE}/content?path=${encodeURIComponent(path)}`,

  /** Global SSE stream. */
  events: `${API_BASE}/events`,
} as const;

export type ApiPaths = typeof apiPaths;
