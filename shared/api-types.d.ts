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
export declare const RUN_STATUS: readonly ["pending", "running", "surfaced", "complete", "crashed", "aborted"];
export type RunStatus = (typeof RUN_STATUS)[number];
export declare const STAGE_STATUS: readonly ["open", "passed", "surfaced", "skipped"];
export type StageStatus = (typeof STAGE_STATUS)[number];
export declare const ATTEMPT_STATUS: readonly ["ok", "error", "timeout", "needs_review"];
export type AttemptStatus = (typeof ATTEMPT_STATUS)[number];
export declare const VERDICT_OUTCOME: readonly ["pass", "fail", "revise"];
export type VerdictOutcome = (typeof VERDICT_OUTCOME)[number];
export declare const RUN_MODE: readonly ["single", "best_of", "team", "review"];
export type RunMode = (typeof RUN_MODE)[number];
/**
 * Historical built-in providers, kept as a display hint. The real provider set
 * is DYNAMIC (catalog-driven, exposed via GET /providers and /providers/available),
 * so `Vendor` is an open provider id — any of pi's providers may appear.
 */
export declare const VENDORS: readonly ["openai", "google", "anthropic"];
export type Vendor = string;
export declare const CLAUDE_TIERS: readonly ["haiku", "sonnet", "opus", "fable"];
export type ClaudeTier = (typeof CLAUDE_TIERS)[number];
export type GateType = "spec" | "design" | "security" | "contract" | "code_style" | "docs_polish" | "lint_class";
export type JudgeTier = "cross_vendor" | "same_vendor";
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
    /** v10: persisted resolved StageSpec[] plan (JSON) for run-recovery/resume. NULL on legacy rows. */
    stage_plan_json: string | null;
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
    /** v10: index into RunRow.stage_plan_json for this stage. NULL on legacy rows. */
    plan_index: number | null;
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
    /** Provider id that served this attempt's model (e.g. "github-copilot"). Absent on historical rows. */
    provider?: string;
    /** v13: prompt tokens consumed in this call (context fill numerator). NULL/absent on legacy rows. */
    context_used?: number | null;
    /** v13: catalog context_window for the model at generation time (context fill denominator). NULL/absent on legacy rows. */
    context_max?: number | null;
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
    cross_vendor: number;
    eights_memory_id: string | null;
    created_at: string;
    /** Provider id that served the judge model (e.g. "anthropic-messages"). Absent on historical rows. */
    judge_provider?: string;
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
    /** The server emits "n/a" (not "skipped") for checks that don't apply. */
    status: "pass" | "fail" | "n/a" | string;
    evidence_path: string | null;
    created_at: string;
}
/** `phases` table row — one per named pilot phase per run (v12). */
export interface PhaseTiming {
    id: number;
    run_id: string;
    /** Phase name: triage | profile | taxonomy | stage_loop | missability | master_plan | finalize */
    phase: string;
    started_at: string;
    finished_at: string;
    /** Elapsed wall-clock time in milliseconds. */
    wall_ms: number;
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
    /** v12: phase-level timing rows, ordered by started_at. Empty on legacy runs. */
    phases: PhaseTiming[];
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
/**
 * Cursor-paginated run listing.
 *
 * BREAKING CHANGE (wire): `GET /api/v1/runs` now returns this envelope instead
 * of a bare `RunSummary[]`. `next_cursor` is an opaque keyset cursor (base64url
 * of `"<started_at>|<id>"` of the last row on the page); pass it back as
 * `?cursor=` to fetch the next page. `null` means there are no more rows.
 * The legacy `GET /runs` route still returns the bare array.
 */
export interface RunListResponse {
    items: RunSummary[];
    next_cursor: string | null;
}
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
 * — only a masked, non-reversible fingerprint suitable for display.
 *
 * The pi runtime has NO sub-CLI binaries, so `cli_installed`/`cli_version` are
 * LEGACY fields the server always returns as `false`/`null`. `logged_in`, by
 * contrast, is REAL: it reports a locally logged-in vendor CLI / subscription
 * session detected on disk (e.g. `claude` / `codex` / `gh copilot` / `opencode`
 * login) — distinct from `configured`, which means the harness can actually
 * resolve a usable key. A provider may be `logged_in` but not yet `configured`.
 * `degraded` is always `false` on the pi server.
 */
export interface ProviderStatus {
    vendor: Vendor;
    /** A usable credential is present for this vendor (the harness can generate). */
    configured: boolean;
    /** @deprecated legacy CLI-era field — always false on the pi server. */
    cli_installed: boolean;
    /** @deprecated legacy CLI-era field — always null on the pi server. */
    cli_version: string | null;
    has_api_key: boolean;
    /**
     * A local vendor-CLI / subscription login was detected on disk. Presence
     * signal only — does not imply `configured`. For pi-OAuth providers
     * (anthropic, github-copilot, openai-codex) a subscription login via
     * POST /providers/:vendor/login makes the provider `configured` too.
     */
    logged_in: boolean;
    /** Masked key fingerprint for display; null when no key is set. */
    masked_key: string | null;
    /** @deprecated legacy field — always false on the pi server. */
    degraded: boolean;
}
/** A model the harness can route to, priced from the catalog. */
export interface ModelInfo {
    id: string;
    vendor: Vendor;
    /** Generation-ladder tier this model backs (any ladder), or null. */
    tier: string | null;
    /** USD per 1M input tokens. */
    input_per_1m: number;
    /** USD per 1M output tokens. */
    output_per_1m: number;
    /** Free-form pricing caveat from prices.json `_pricing_notes`, if any. */
    note?: string;
}
/** A provider offered in the add-provider picker (catalog + curated pi set). */
export interface InstallableProvider {
    id: string;
    display_name: string;
    /** Env var pi reads a key from, for display; null when unknown. */
    env_key_hint: string | null;
    /** True when the provider already has a catalog entry (models + pricing). */
    in_catalog: boolean;
    /** True when the catalog entry is enabled. */
    enabled: boolean;
    /** True when a key is already configured for this provider. */
    configured: boolean;
}
/** Models the catalog knows for a provider (for ladder / judge editors). */
export interface ProviderModels {
    provider: string;
    models: string[];
}
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
    judge: {
        tier: JudgeTier;
        rubric?: string;
        model_pref?: string;
    };
    best_of_n_on_major_scope?: number;
}
export interface TeamSpec {
    name: string;
    description: string;
    origin?: "project" | "user" | "builtin";
    profiles_compatible?: string[];
    /**
     * Present on the DETAIL fetch (`GET /teams/:name`). The LIST endpoint
     * (`GET /teams`) returns a summary WITHOUT stages, so treat as optional and
     * fetch the full team when you need the pipeline.
     */
    stages?: TeamStage[];
    taxonomy_required?: string[];
    missability_required?: string[];
}
export type AgentCategory = "engineering" | "judge" | "executive" | "game" | "governance" | "harness" | "other";
/**
 * One agent prompt (from `GET /agents`, sorted by id). Resolution mirrors
 * teams: project `.claude/agents` → user `~/.claude/agents` → built-in
 * assets/agents-src, first-resolution wins.
 */
export interface AgentSummary {
    /** Role slug — the prompt filename without `.md`. */
    id: string;
    /** Frontmatter `name`, falling back to the id. */
    name: string;
    description: string;
    category: AgentCategory;
    /** Frontmatter `model`: either a pinned id or a tier alias ("opus"). */
    model?: string;
    /** Derived from `model` — tier alias directly, pinned id via reverse lookup. */
    tier?: ClaudeTier;
    /** Team yamls whose stages dispatch this agent as a generator. */
    teams: string[];
    origin: "project" | "user" | "builtin";
}
/** Full agent (from `GET /agents/:id`) — summary plus the prompt body. */
export interface AgentDetail extends AgentSummary {
    /** Frontmatter-stripped markdown prompt body. */
    body: string;
}
/** Where a skill's body is injected: generator prompts, judge prompts, or reference-only. */
export type SkillInjection = "generator" | "judge" | "none";
/**
 * One skill (from `GET /skills`, sorted by id). Resolution mirrors agents:
 * project `.claude/skills` → user `~/.claude/skills` → built-in assets/skills,
 * first-resolution wins. Both flat `<id>.md` files and `<id>/SKILL.md`
 * directories are accepted at every level.
 *
 * Carve-out: a project/user copy without pp skill frontmatter is a plain
 * Claude Code skill — it never shadows a curated built-in of the same id
 * (the curated skill still wins).
 */
export interface SkillSummary {
    /** Skill slug — the filename without `.md` (or the `<id>/SKILL.md` dirname). */
    id: string;
    /** Frontmatter `name`, falling back to the id. */
    name: string;
    description: string;
    origin: "project" | "user" | "builtin";
    injection: SkillInjection;
    /** Empty array = applies everywhere; "*" entries also match everything. */
    applies_to_stages: string[];
    applies_to_agents: string[];
    applies_to_profiles: string[];
    /** Injection order: lower first. Default 50. */
    priority: number;
}
/** Full skill (from `GET /skills/:id`) — summary plus the body + injection budget. */
export interface SkillDetail extends SkillSummary {
    /** Frontmatter-stripped markdown body. */
    body: string;
    /** Frontmatter `version`; default 1. */
    version: number;
    /** Injection budget: bodies longer than this are truncated by the injector. Default 6000. */
    max_chars: number;
    applies_to_gate_types: string[];
}
/** `POST /teams/recommend` body. Deterministic heuristics — no model calls. */
export interface TeamRecommendRequest {
    request_text: string;
    /** Project-team override discovery + profile detection; defaults server-side. */
    project_path?: string;
    /** Explicit profile override; falls back to profile.yaml then detection. */
    profile?: string;
    /** Scope override; omit to use the heuristic triage classification. */
    scope?: "trivial" | "standard" | "major";
}
export interface TeamRecommendation {
    team: string;
    score: number;
    /** "high" only on the #1 entry when score>=6 and margin over #2 >=3. */
    confidence: "high" | "medium" | "low";
    /** Per-rule scoring reasons (profile compat, triage signals, keywords, …). */
    reasons: string[];
}
export interface TeamRecommendResponse {
    scope: "trivial" | "standard" | "major";
    /** True when triage (or the caller's override) classified the request as major. */
    suggest_team_mode: boolean;
    /** Top 5 of all discoverable teams, sorted score desc then name asc. */
    recommendations: TeamRecommendation[];
}
export interface ModelTierPolicy {
    default_cap?: ClaudeTier;
    per_stage_override?: Record<string, ClaudeTier>;
    scope_adjust?: {
        trivial?: -1 | 0;
        standard?: 0;
        major?: 0 | 1;
    };
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
    model_tier_policy?: ModelTierPolicy;
    /** Tier → concrete model id. UI-authored values prefer `provider/model`. */
    ladder?: Partial<Record<ClaudeTier, string>>;
    /** Tier → ordered pool of concrete model ids. Canonical entries are `provider/model`; duplicate detection + priority are based on the full string. */
    tier_pools?: Partial<Record<ClaudeTier, string[]>>;
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
/**
 * One aggregated row from GET /api/v1/judges/stats — per (judge_producer,
 * judge_model_id) disposition mix + calibration signal over ACTIVE
 * (non-retracted) verdicts.
 */
export interface JudgeStatRow {
    judge_producer: string;
    judge_model_id: string;
    n_verdicts: number;
    pass_rate: number;
    revise_rate: number;
    fail_rate: number;
    /** Mean of per-verdict minimum dimension scores; null when none had a numeric score. */
    avg_min_dimension_score: number | null;
    cross_vendor_share: number;
}
/** GET /api/v1/judges/stats response envelope. */
export interface JudgeStatsResponse {
    items: JudgeStatRow[];
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
        playwright: {
            status: string;
            reason?: string;
        };
        chrome_mcp: {
            status: string;
            note: string;
        };
    };
    db_path: string;
}
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
/**
 * Reproducible-replay bundle — mirrors @pp/core `buildReplayBundle`. Nested
 * stages → attempts → verdicts, not a flat list.
 */
export interface ReplayBundle {
    run_id: string;
    request_text: string;
    project_path: string;
    team: string | null;
    mode: string;
    forum: string | null;
    n: number | null;
    status: string;
    head_sha: string | null;
    tree_dirty_hash: string | null;
    profile_snapshot: unknown;
    taxonomy_mapping: unknown;
    cli_versions: unknown;
    started_at: string;
    finished_at: string | null;
    stages: Array<{
        id: string;
        kind: string;
        gate_type: string;
        status: string;
        attempts: Array<{
            id: string;
            producer: string;
            model_id: string;
            attempted_tier: string | null;
            retry_index: number;
            parent_attempt_id: string | null;
            tokens_in: number | null;
            tokens_out: number | null;
            cost_usd: number | null;
            verdicts: Array<{
                judge_producer: string;
                judge_model_id: string;
                rubric_id: string | null;
                outcome: string;
                cross_vendor: boolean;
            }>;
        }>;
    }>;
    artifacts: Array<{
        kind: string | null;
        path: string;
        sha256: string;
    }>;
    tier_resolution: unknown;
    cli_flags: unknown;
    reproduction_notes: string;
}
/** One planned (or executed) janitor sweep target. */
export interface JanitorEntry {
    path: string;
    kind: "worktree" | "branch" | "lock" | "run";
    bytes: number;
    age_days: number;
}
/**
 * Janitor report — mirrors @pp/core janitor.ts. Two-phase: `dry_run: true`
 * returns the full sweep plan (entries with real byte/age accounting) without
 * mutating anything; a real run executes it, sums `reclaimed_bytes` over the
 * successful sweeps, and persists the report. A GET returns the last persisted
 * report, or an empty default (`ran_at: null`) when the janitor has never run.
 */
export interface JanitorReport {
    ran_at: string | null;
    dry_run: boolean;
    crashed_runs: string[];
    entries: JanitorEntry[];
    swept: number;
    reclaimed_bytes: number;
}
/** Raw text body of an on-disk artifact / candidate output (by path). */
export interface ArtifactContent {
    path: string;
    /** "diff" | "markdown" | "text" | "json" | … (viewer hint). */
    kind: string;
    content: string;
}
/** Launch-wizard payload. `mode` decides which of the optional fields apply. */
export interface StartRunRequest {
    project_path: string;
    request_text: string;
    mode: RunMode;
    /** Profile override; omit to auto-detect. */
    profile?: string | null;
    /** Team name (mode="team"). */
    team?: string | null;
    /** Forum name (mode="review"). */
    forum?: string | null;
    /** Candidate fan-out (mode="best_of"); 2..8. */
    n?: number | null;
    /** Claude tier ceiling / floor overrides. */
    tier_cap?: ClaudeTier | null;
    tier_floor?: ClaudeTier | null;
    /**
     * Per-run override of the effective generation ladder: Claude tier → concrete
     * model id. Highest precedence (above the project profile, global harness
     * settings ladder, and the catalog default). UI-authored values prefer
     * `provider/model`. A partial map only overrides the tiers it names; absent
     * leaves resolution byte-identical.
     */
    ladder_override?: Partial<Record<ClaudeTier, string>>;
    /**
     * Per-run override of the effective per-tier model POOLS (rotated across
     * Reflexion retries + best-of candidates). Canonical entries are
     * `provider/model`, and duplicate detection + priority are based on the full
     * canonical string. Same top precedence as `ladder_override`. A partial map
     * only overrides the tiers it names.
     */
    tier_pools_override?: Partial<Record<ClaudeTier, string[]>>;
    /** Triage scope override; omit for "auto". */
    scope_override?: "trivial" | "standard" | "major";
}
export interface StartRunResponse {
    run_id: string;
    /** True when the run was queued behind the concurrency cap before starting. */
    queued?: boolean;
}
export interface AbortRunResponse {
    run_id: string;
    status: RunStatus;
}
/** Retry a surfaced stage (Reflexion ×1) or re-run only its judge (gate). */
export interface StageActionResponse {
    run_id: string;
    stage_id: string;
    action: "retry" | "gate";
    ok: boolean;
    /**
     * True when this retry deliberately bypassed an exhausted Reflexion ×1 budget
     * via an operator override (`{ override: true }`). Absent/false otherwise.
     */
    overridden?: boolean;
}
/**
 * 409 body for `POST /runs/:id/stages/:sid/retry` when the Reflexion ×1 budget
 * is exhausted. `override_available` tells the client it may re-POST with
 * `{ override: true }` to retry anyway (diminishing returns).
 */
export interface RetryExhaustedResponse {
    error: "retry_exhausted";
    reason?: string;
    override_available: true;
}
/** Body for `POST /runs/:id/stages/:sid/retry`. */
export interface StageRetryRequest {
    /** Bypass an exhausted Reflexion ×1 budget (deliberate, logged operator action). */
    override?: boolean;
}
/**
 * `GET /runs/:id/completion-readiness` — read-only inspection of exactly what
 * (if anything) blocks a run from reaching `status = 'complete'`, extracted
 * from the same VG-1/VG-2/VG-4/VG-7 gate logic `finalizeRun` enforces so the
 * two paths never drift. Never mutates the run.
 */
export interface CompletionReadinessResponse {
    run_id: string;
    /** True when `POST /runs/:id/resume` would make forward progress (not necessarily reach `complete` in one call). */
    resumable: boolean;
    /** Coarse human-readable summary of why `resumable` is false, or null when resumable. */
    blocking_reason: string | null;
    /** Stage rows with `status = 'surfaced'` — must be retried/regated before resume can proceed. */
    surfaced_stages: Array<{
        stage_id: string;
        kind: string;
        plan_index: number | null;
        reason?: string;
    }>;
    /**
     * Stage rows with `status = 'open'` — a row exists but the stage never
     * reached a terminal outcome (e.g. a crash mid-stage). Treated identically
     * to `surfaced_stages`: must be resolved before resume proceeds; never
     * silently skipped just because a row exists for that plan slot.
     */
    incomplete_stages: Array<{
        stage_id: string;
        kind: string;
        plan_index: number | null;
    }>;
    /**
     * Planned stage-plan slots (from `runs.stage_plan_json`) with no
     * corresponding stage row in `('passed', 'surfaced', 'skipped')`. Empty
     * when no plan was persisted (legacy run) and reconstruction found nothing
     * remaining, or `null` when the plan could not be reconstructed at all
     * (see `blocking_reason`).
     */
    remaining_planned_stages: Array<{
        plan_index: number;
        kind: string;
        gate_type: string;
    }> | null;
    missing_required_artifacts: string[];
    failed_required_missability_checks: string[];
    unpopulated_master_plan_sections: string[];
}
/**
 * `POST /runs/:id/resume` — reopens a `surfaced`/blocked run on the SAME
 * run_id: continues any remaining planned stages, then reruns
 * missability/master-plan/finalize. Never forks a child run. When blocked,
 * makes no writes and returns the same shape `completion-readiness` would.
 */
export interface RunResumeResponse {
    run_id: string;
    status: RunStatus;
    /** True when this call made forward progress (continued a stage or reached a new terminal finalize). */
    resumed: boolean;
    /** Present when `resumed: false` — the blockers that prevented progress. */
    readiness?: CompletionReadinessResponse;
}
/**
 * Write-only provider key set. The raw key travels ONLY in this request body;
 * it is never returned. The response is the masked ProviderStatus.
 */
export interface SetProviderKeyRequest {
    api_key: string;
}
/** Result of a live credential/model-resolution probe for a vendor. */
export interface ProviderTestResult {
    vendor: Vendor;
    ok: boolean;
    status: "ok" | "fail" | "skipped";
    model?: string;
    wall_ms?: number;
    detail?: string;
}
/**
 * A vendor that supports subscription (OAuth) login — from `GET /providers/oauth`.
 * Only pi-native OAuth providers appear (anthropic, github-copilot, openai-codex).
 */
export interface OAuthProviderDescriptor {
    id: Vendor;
    name: string;
}
/** `GET /providers/oauth` response. */
export interface OAuthProvidersResponse {
    providers: OAuthProviderDescriptor[];
}
/**
 * Live state of a subscription-login flow. The flow is interactive: it surfaces
 * a browser `auth` URL and/or a `deviceCode`, and may pause at a `prompt`
 * awaiting `POST /providers/login/:loginId/input`. Terminal states are `done`
 * (provider is now `configured`) and `error`. Carries no secrets.
 */
export interface OAuthLoginState {
    login_id: string;
    vendor: Vendor;
    status: "starting" | "awaiting_browser" | "awaiting_device_code" | "awaiting_input" | "done" | "error";
    auth?: {
        url: string;
        instructions?: string;
    };
    device_code?: {
        user_code: string;
        verification_uri: string;
        interval_seconds?: number;
        expires_in_seconds?: number;
    };
    prompt?: {
        message: string;
        placeholder?: string;
    };
    error?: string;
}
/** Body for `POST /providers/login/:loginId/input` (a paste-a-code step). */
export interface OAuthLoginInputRequest {
    value: string;
}
/** `DELETE /providers/login/:loginId` response. */
export interface OAuthLoginAbortResponse {
    login_id: string;
    aborted: true;
}
/**
 * Result of `POST /providers/:vendor/models/refresh` (no request body).
 * `models` is the refreshed (or static-fallback) pi model-id list; unknown
 * vendors 404 with `{error: "unknown provider"}`.
 */
export interface ProviderModelsRefreshResponse {
    provider: string;
    /**
     * True only when a LIVE discovery actually ran (the provider supports
     * dynamic model refresh and the fetch succeeded). False when the provider
     * is static or the refresh failed — `models` then carries the built-in list.
     */
    refreshed: boolean;
    models: string[];
}
/** Autogenesis review decision. */
export type EvolutionDecision = "approve" | "reject" | "commit" | "rollback";
export interface EvolutionReviewRequest {
    decision: EvolutionDecision;
    /** Optional reviewer note (stored on the evolution_commits row for commit). */
    note?: string;
    /**
     * Reviewer-authored override body. REQUIRED by `decision: "commit"` — the
     * analyzer detects drift but authors no patch, so the reviewer supplies the
     * content to write to the resource's project-override target. A commit
     * without content returns `422 content_required`.
     */
    content?: string;
}
/**
 * Review response from the server. `approve`/`reject` mutate the proposal
 * status and return this ack. `commit` writes `content` to the proposal's
 * project-scoped override target (rubric → `.claude/rubrics/<id>.md`,
 * stage-prompt → `.claude/agents/<role>.md`, missability →
 * `.harness/missability-overrides.json`), snapshotting any pre-existing
 * target; `rollback` restores the snapshot (or deletes a target the commit
 * created). Wrong-status or path-guard violations return `409`.
 */
export interface EvolutionReviewResponse {
    id: string;
    decision: EvolutionDecision;
    status: string;
    updated: boolean;
    /** Absolute path of the override file written (commit) or restored/deleted (rollback). */
    target_path?: string;
    /** Absolute path of the pre-commit snapshot; null when the target didn't exist before. */
    snapshot_path?: string | null;
}
/** Replace the set of budget caps. */
export interface SetBudgetCapsRequest {
    caps: BudgetCap[];
}
/** Request body for `POST /profiles/detect`. */
export interface DetectProfileRequest {
    project_path: string;
    /**
     * Optional user request text. Refines detection when the filesystem is
     * inconclusive (e.g. a game-shaped request on an empty project routes to a
     * game-dev-* profile instead of generic mode).
     */
    request_text?: string;
}
/**
 * Profile detection result — mirrors @pp/core `detectProfile` (`ProfileDetection`).
 * The server returns this from `POST /profiles/detect`.
 */
export interface DetectProfileResult {
    recommendation: string | null;
    confidence: "high" | "medium" | "low" | string;
    signals: string[];
    alternatives: string[];
    flags?: unknown;
}
/** Write (or validate) a project's profile.yaml via `PUT /projects/:path/profile`. */
export interface WriteProfileRequest {
    /** Apply a built-in profile by name… */
    name?: string;
    /** …or write raw yaml (validated server-side; 422 on parse/shape error). */
    yaml?: string;
}
/** GET /projects/:path/profile — the raw project file plus the resolved spec. */
export interface ProjectProfileDocument {
    path: string;
    yaml: string;
    resolved: ProfileSpec;
}
/** Janitor run mode: `dry_run: true` previews, otherwise it executes. */
export interface JanitorRunRequest {
    dry_run: boolean;
}
/** `POST /doctor` is async: it acks immediately and emits `doctor.result` on SSE. */
export interface DoctorRunAck {
    ok: boolean;
    started: boolean;
}
/** Register a project via `POST /projects`. */
export interface RegisterProjectRequest {
    path: string;
    name?: string;
}
export interface ForumStage {
    kind: string;
    artifact_kind?: string;
    gate_type: GateType | string;
    generator_agent: string;
    judge_tier: JudgeTier;
    rubric_id?: string;
}
/** Full forum (from `GET /forums/:id`). List returns the summary subset. */
export interface Forum {
    id: string;
    title: string;
    description: string;
    produces: string;
    stages?: ForumStage[];
    required_missability_checks?: string[];
}
/** A taxonomy section (from `GET /taxonomy`) — mirrors @pp/core TAXONOMY_SECTIONS. */
export interface TaxonomySection {
    id: string;
    title: string;
    default_artifact_kinds: string[];
    master_plan_section: string;
}
/**
 * One named generation ladder in HarnessSettings: each tier maps to a concrete
 * model id, plus an optional reserved `tier_pools` key carrying per-tier model
 * POOLS for rotation (Reflexion retry + best-of). Every key EXCEPT `tier_pools`
 * is a tier name.
 */
export interface HarnessLadder {
    /** tier name → concrete model id (reserved key `tier_pools` excluded). UI-authored values prefer `provider/model`. */
    [tier: string]: string | Record<string, string[]> | undefined;
    /**
     * Per-tier model pools, mirroring the catalog ladder's `tier_pools`. Layered
     * above the catalog default and below any per-run / profile override.
     * Canonical entries are `provider/model`; duplicate detection + priority are
     * based on the full canonical string. Reserved key — not a tier.
     */
    tier_pools?: Record<string, string[]>;
}
/**
 * Harness settings the control plane edits: the named generation ladders
 * (ladderName → tier → model id, plus optional per-ladder `tier_pools`) and the
 * ordered judge pool. Persisted server-side. The default install has one
 * ladder, "claude". Cross-provider judge coverage is derived from the pool's
 * distinct providers.
 */
export interface HarnessSettings {
    ladders: Record<string, HarnessLadder>;
    /** Ordered judge selections; cross-provider coverage is derived. */
    judge_pool: Array<{
        provider: string;
        model: string;
    }>;
}
/** A TDD pre/post execution result from the tdd_checks table. */
export type TddCheckGateEntry = {
    gate: "tdd_check";
    id: string;
    stage_id: string;
    phase: string;
    mode: string;
    test_runner: string;
    status: string;
    passed_count: number | null;
    failed_count: number | null;
    duration_ms: number;
    reason: string | null;
    ts: string;
};
/** A structural artifact validator result from the artifact_validations table. */
export type ArtifactValidationGateEntry = {
    gate: "artifact_validation";
    id: string;
    stage_id: string;
    artifact_id: string | null;
    validator_kind: string;
    artifact_kind: string | null;
    artifact_path: string;
    status: string;
    duration_ms: number;
    reason: string | null;
    ts: string;
};
/** A judge verdict from the verdicts table (joined through attempts → stages). */
export type VerdictGateEntry = {
    gate: "verdict";
    id: string;
    stage_id: string;
    attempt_id: string;
    judge_producer: string;
    judge_model_id: string;
    rubric_id: string | null;
    /** "pass" | "fail" | "revise" */
    outcome: VerdictOutcome;
    cross_vendor: boolean;
    /** True when this verdict was retracted (retracted_at IS NOT NULL). */
    retracted: boolean;
    ts: string;
};
/** A smoke/assertion result extracted from stages.notes_json.smoke_results. */
export type SmokeGateEntry = {
    gate: "smoke";
    stage_id: string;
    candidate_index: number;
    status: string;
    reason: string | null;
    ts: string;
};
/**
 * One entry in `GET /api/v1/runs/:id/gates` — discriminated by `gate`.
 * Unified, timestamp-ascending history of every gate check for a run:
 * TDD pre/post checks, artifact validations, judge verdicts, and smoke results.
 */
export type GateHistoryEntry = TddCheckGateEntry | ArtifactValidationGateEntry | VerdictGateEntry | SmokeGateEntry;
/** Non-2xx response body. `details` carries per-field errors on 422. */
export interface ApiError {
    error: string;
    details?: Record<string, string> | unknown;
}
/** Base envelope shared by every SSE frame. */
export interface SseEnvelope<TType extends string, TData> {
    type: TType;
    /** Present on all run-scoped events; absent on some global events. */
    run_id?: string;
    ts: string;
    seq: number;
    data: TData;
}
export type RunCreatedEvent = SseEnvelope<"run.created", RunSummary>;
export type RunStatusEvent = SseEnvelope<"run.status", {
    run_id: string;
    status: RunStatus;
}>;
export type RunFinalizedGlobalEvent = SseEnvelope<"run.finalized", {
    run_id: string;
    status: RunStatus;
    finished_at: string;
}>;
export type BudgetTripwireEvent = SseEnvelope<"budget.tripwire", {
    scope: string;
    pct: number;
    limit_usd: number;
    cost_usd: number;
    action: "downgrade" | "block" | "warn";
}>;
export type ProviderStatusEvent = SseEnvelope<"provider.status", ProviderStatus>;
export type DoctorResultEvent = SseEnvelope<"doctor.result", DoctorReport>;
export type EvolutionProposalCreatedEvent = SseEnvelope<"evolution.proposal.created", EvolutionProposal>;
export type JanitorResultEvent = SseEnvelope<"janitor.result", {
    swept: number;
    reclaimed_bytes: number;
    details?: unknown;
}>;
/** Emitted (before a run_id exists) when a run waits behind the concurrency cap. */
export type RunQueuedEvent = SseEnvelope<"run.queued", {
    project_path: string;
    request_text: string;
    mode: string;
}>;
export type GlobalSseEvent = RunCreatedEvent | RunStatusEvent | RunFinalizedGlobalEvent | BudgetTripwireEvent | ProviderStatusEvent | DoctorResultEvent | EvolutionProposalCreatedEvent | JanitorResultEvent | RunQueuedEvent;
export type RunStartedEvent = SseEnvelope<"run.started", {
    mode: string;
    scope?: string;
    project_path: string;
    request: string;
}>;
/**
 * Well-known run lifecycle phases. The `(string & {})` tail keeps the type
 * open so unknown phases (e.g. from future pilot versions) remain assignable.
 */
export type RunPhase = "triage" | "profile" | "taxonomy" | "tier-resolve" | "skills" | "artifact-promotion" | "master-plan" | "autogenesis" | "best-of-merge" | (string & {});
export type RunContextEvent = SseEnvelope<"run.context", {
    phase: RunPhase;
    [k: string]: unknown;
}>;
export type StageStartedEvent = SseEnvelope<"stage.started", {
    stage_id: string;
    kind: string;
    gate_type: string;
    agent?: string;
}>;
export type StageFinalizedEvent = SseEnvelope<"stage.finalized", {
    stage_id: string;
    status: StageStatus;
    winner_attempt_id: string | null;
}>;
export type StageSurfacedEvent = SseEnvelope<"stage.surfaced", {
    stage_id: string;
    reason: string;
    aborting_run?: boolean;
}>;
export type AttemptStartedEvent = SseEnvelope<"attempt.started", {
    stage_id: string;
    agent?: string;
    model?: string;
    tier?: string | null;
    retry_index?: number;
    /** Pre-allocated attempt id, when the harness mints it before dispatch. */
    attempt_id?: string;
    /** Best-of-N candidate slot index (0-based). */
    candidate_index?: number;
    /** Diversification seed used for this candidate. */
    seed?: number;
    /** Provider id resolved for this attempt's model (e.g. "github-copilot"). */
    provider?: string;
}>;
export type AttemptOutputEvent = SseEnvelope<"attempt.output", {
    attempt_id: string;
    stage_id?: string;
    chunk: string;
}>;
export type AttemptCompletedEvent = SseEnvelope<"attempt.completed", {
    stage_id: string;
    attempt_id: string;
    model?: string;
    tokens_in?: number | null;
    tokens_out?: number | null;
    cost_usd?: number | null;
    /** Reason the model stopped generating (e.g. "end_turn", "max_tokens"). */
    stop_reason?: string;
    /** Number of tool/function calls made during this attempt. */
    tool_call_count?: number;
    /** Number of source files the attempt changed. */
    files_changed?: number;
    /** Project-relative paths of every file the attempt wrote or modified. */
    materialized_files?: string[];
    /** True when the attempt produced no net diff against the pre-attempt tree. */
    zero_change?: boolean;
    /** Provider id resolved for this attempt's model — same as AttemptStartedEvent.provider for convenience. */
    provider?: string;
    /** v13: prompt tokens consumed (context fill numerator). Absent when unknown. */
    context_used_tokens?: number | null;
    /** v13: catalog context_window for the model (context fill denominator). Absent when unknown. */
    context_max_tokens?: number | null;
    /** v13: context fill fraction, rounded to 3 decimals (used/max). Absent when either operand is unknown. */
    context_pct?: number | null;
}>;
export type VerdictRecordedEvent = SseEnvelope<"verdict.recorded", {
    attempt_id: string;
    outcome: VerdictOutcome;
    stage_id?: string;
    judge_producer?: string;
    judge_model?: string;
    cross_vendor?: boolean;
    rubric_id?: string | null;
    judge_provider?: string;
}>;
export type VerdictRetractedEvent = SseEnvelope<"verdict.retracted", {
    attempt_id: string;
    stage_id?: string;
}>;
export type ReflexionRetryEvent = SseEnvelope<"reflexion.retry", {
    stage_id: string;
    initial_tier?: string;
    retry_tier?: string;
    critique_excerpt?: string;
}>;
export type BordaUpdatedEvent = SseEnvelope<"borda.updated", {
    stage_id: string;
    phase?: string;
    /** Present on the winner frame; the informational frames carry scores. */
    ranking?: Array<{
        attempt_id: string;
        points: number;
        rank: number;
    }>;
    leader_attempt_id?: string | null;
    scores?: unknown;
}>;
export type SmokeStatusEvent = SseEnvelope<"smoke.status", {
    stage_id?: string;
    attempt_id?: string;
    status: "pass" | "fail" | "skipped";
    route?: string;
    detail?: string;
}>;
export type ValidationResultEvent = SseEnvelope<"validation.result", {
    stage_id?: string;
    validator_kind?: string;
    status: string;
    reason?: string;
}>;
export type MissabilityResultEvent = SseEnvelope<"missability.result", {
    check_id: string;
    status: string;
    evidence_path?: string | null;
}>;
/**
 * Periodic budget update emitted during a run. cost_usd is the CUMULATIVE
 * spend for the scope so far — it is NOT a delta since the last tick.
 */
export type BudgetTickEvent = SseEnvelope<"budget.tick", {
    scope: string;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
}>;
export interface FinalizationArtifactRef {
    kind: "constitution" | "project_master" | string;
    path: string;
    sha256?: string | null;
    artifact_id?: string | null;
}
export type RunFinalizedEvent = SseEnvelope<"run.finalized", {
    run_id: string;
    status: RunStatus;
    finished_at: string;
    abort_reason?: string;
    artifacts?: FinalizationArtifactRef[];
}>;
/** Emitted when a named pilot phase (triage, profile, taxonomy, stage_loop, missability, master_plan, finalize) completes. */
export type PhaseCompletedEvent = SseEnvelope<"phase.completed", {
    phase: string;
    wall_ms: number;
}>;
/**
 * Emitted by the supervisor when an attempt's context fill fraction exceeds 0.75
 * (context_pct > 75%). Mirrors the budget.tripwire pattern: fire once per
 * attempt and degrade gracefully when context data is absent.
 */
export type ContextWarningEvent = SseEnvelope<"context.warning", {
    stage_id: string;
    attempt_id: string;
    context_pct: number;
    context_used_tokens: number;
    context_max_tokens: number;
}>;
export type RunSseEvent = RunStartedEvent | RunContextEvent | StageStartedEvent | StageFinalizedEvent | StageSurfacedEvent | AttemptStartedEvent | AttemptOutputEvent | AttemptCompletedEvent | VerdictRecordedEvent | VerdictRetractedEvent | ReflexionRetryEvent | BordaUpdatedEvent | SmokeStatusEvent | ValidationResultEvent | MissabilityResultEvent | BudgetTickEvent | RunFinalizedEvent | PhaseCompletedEvent | ContextWarningEvent;
/** Any SSE event across either stream. */
export type EventLogEntry = RunSseEvent;
export type SseEvent = GlobalSseEvent | RunSseEvent;
/** Discriminant union of every event `type` string. */
export type SseEventType = SseEvent["type"];
/** Narrow an SseEvent to a specific member by its `type`. */
export type SseEventOf<T extends SseEventType> = Extract<SseEvent, {
    type: T;
}>;
export declare const GLOBAL_SSE_EVENT_TYPES: readonly GlobalSseEvent["type"][];
export declare const RUN_SSE_EVENT_TYPES: readonly RunSseEvent["type"][];
export declare const API_BASE: "/api/v1";
export declare const apiPaths: {
    readonly base: "/api/v1";
    readonly health: "/healthz";
    readonly doctor: "/api/v1/doctor";
    readonly projects: "/api/v1/projects";
    readonly project: (path: string) => string;
    /** GET reads / PUT writes `.harness/profile.yaml` (body: {name} | {yaml}). */
    readonly projectProfile: (path: string) => string;
    /** POST — body {project_path}; returns a ProfileDetection. */
    readonly profilesDetect: "/api/v1/profiles/detect";
    readonly projectMasterPlan: (path: string) => string;
    readonly projectAgentsMd: (path: string) => string;
    readonly projectConstitution: (path: string) => string;
    readonly runs: "/api/v1/runs";
    readonly run: (runId: string) => string;
    /** Per-run SSE stream. When PP_API_TOKEN is set this endpoint ALSO accepts
     *  the bearer as `?token=` — EventSource cannot send headers. */
    readonly runEvents: (runId: string) => string;
    readonly runEventLog: (runId: string) => string;
    /** GET — unified gate history (tdd_checks, artifact_validations, verdicts, smoke) for a run; 404 when run unknown. */
    readonly runGates: (runId: string) => string;
    readonly runReplay: (runId: string) => string;
    readonly runMissability: (runId: string) => string;
    readonly runBorda: (runId: string) => string;
    readonly runAbort: (runId: string) => string;
    /** GET — read-only completion-readiness blockers (see CompletionReadinessResponse). */
    readonly runCompletionReadiness: (runId: string) => string;
    /** POST — resume a surfaced/blocked run on the same run_id (see RunResumeResponse). */
    readonly runResume: (runId: string) => string;
    readonly runStageRetry: (runId: string, stageId: string) => string;
    readonly runStageGate: (runId: string, stageId: string) => string;
    readonly providers: "/api/v1/providers";
    readonly providersAvailable: "/api/v1/providers/available";
    readonly providerKey: (vendor: string) => string;
    readonly providerTest: (vendor: string) => string;
    readonly providerModels: (vendor: string) => string;
    /** POST — re-fetch a dynamic provider's live model list (no body). */
    readonly providerModelsRefresh: (vendor: string) => string;
    /** GET — vendors that support subscription (OAuth) login. */
    readonly providersOauth: "/api/v1/providers/oauth";
    /** POST — start a subscription (OAuth) login; returns an OAuthLoginState. */
    readonly providerLogin: (vendor: string) => string;
    /** GET — poll a login's state. */
    readonly providerLoginState: (loginId: string) => string;
    /** POST — supply a pending paste-a-code input (body OAuthLoginInputRequest). */
    readonly providerLoginInput: (loginId: string) => string;
    /** DELETE — abort an in-flight login. */
    readonly providerLoginAbort: (loginId: string) => string;
    readonly models: "/api/v1/models";
    readonly budgets: "/api/v1/budgets";
    readonly budget: (scope: string) => string;
    readonly budgetCaps: "/api/v1/budgets/caps";
    readonly teams: "/api/v1/teams";
    readonly team: (name: string) => string;
    /** POST — body TeamRecommendRequest; returns a TeamRecommendResponse. */
    readonly teamsRecommend: "/api/v1/teams/recommend";
    readonly agents: "/api/v1/agents";
    readonly agent: (id: string) => string;
    readonly skills: "/api/v1/skills";
    readonly skill: (id: string) => string;
    readonly profiles: "/api/v1/profiles";
    readonly profile: (name: string) => string;
    readonly forums: "/api/v1/forums";
    readonly forum: (id: string) => string;
    readonly taxonomy: "/api/v1/taxonomy";
    readonly rubrics: "/api/v1/rubrics";
    readonly rubric: (id: string) => string;
    /** GET — per-judge aggregation over active verdicts; returns { items }. */
    readonly judgeStats: "/api/v1/judges/stats";
    readonly evolution: "/api/v1/evolution/proposals";
    readonly evolutionProposal: (id: string) => string;
    readonly evolutionReview: (id: string) => string;
    readonly janitor: "/api/v1/system/janitor";
    /** Generation-ladders + judge-pool settings. GET/PUT persisted server-side
     *  (packages/server/src/routes/library.ts). */
    readonly settings: "/api/v1/settings";
    /** Fetch a file/artifact body by its (project-relative) path. */
    /**
     * Artifact/file content. Artifact paths are stored RELATIVE to the project
     * root, so pass `opts.projectPath` (or `opts.runId`, from which the server
     * looks up the root) to resolve them; absolute paths need neither.
     */
    readonly content: (path: string, opts?: {
        projectPath?: string;
        runId?: string;
    }) => string;
    /** Global SSE stream. When PP_API_TOKEN is set this endpoint ALSO accepts
     *  the bearer as `?token=` — EventSource cannot send headers. */
    readonly events: "/api/v1/events";
};
export type ApiPaths = typeof apiPaths;
