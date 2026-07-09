import type {
  Project,
  ProviderStatus,
  ModelInfo,
  BudgetEntry,
  BudgetCap,
  TeamSpec,
  TeamStage,
  ProfileSpec,
  RubricInfo,
  EvolutionProposal,
  DoctorReport,
  RunSummary,
  JanitorReport,
  Forum,
  TaxonomySection,
  HarnessSettings,
  InstallableProvider,
} from "@shared/api-types";
import { MOCK_RUN_ID, mockRunTree } from "./runTree";

export const mockProjects: Project[] = [
  {
    path: "C:/AiAppDeployments/acme-checkout",
    name: "acme-checkout",
    last_run_at: "2026-07-01T14:02:11.000Z",
    run_count: 23,
    profile: "web-ui",
  },
  {
    path: "C:/AiAppDeployments/orbit-api",
    name: "orbit-api",
    last_run_at: "2026-06-29T09:41:00.000Z",
    run_count: 41,
    profile: "api-platform",
  },
  {
    path: "C:/AiAppDeployments/pi-pp-platform",
    name: "pi-pp-platform",
    last_run_at: "2026-06-30T22:15:00.000Z",
    run_count: 7,
    profile: "internal-tool",
  },
];

/**
 * Deterministic run-history tail (all older than the hand-written rows) so the
 * cursor-paginated `GET /runs` envelope has multiple pages to serve in mock
 * mode. Every value derives from the index — no randomness, stable across runs.
 */
const HIST_PROJECTS = [
  "C:/AiAppDeployments/acme-checkout",
  "C:/AiAppDeployments/orbit-api",
  "C:/AiAppDeployments/pi-pp-platform",
] as const;
const HIST_REQUESTS = [
  "Add optimistic UI to the cart quantity stepper.",
  "Harden the webhook retry queue against duplicate delivery.",
  "Refactor the pricing service to the new money type.",
  "Write contract tests for the invoices list endpoint.",
  "Tighten CSP headers and document the exceptions.",
  "Add a changelog entry generator to the release script.",
  "Profile and fix the slow dashboard aggregate query.",
  "Migrate feature flags to the typed config loader.",
  "Draft the ADR for background-job idempotency keys.",
] as const;

function genRunHistory(count: number): RunSummary[] {
  const newest = Date.UTC(2026, 5, 27, 12, 0, 0); // 2026-06-27T12:00Z, older than every hand-written row
  const out: RunSummary[] = [];
  for (let i = 0; i < count; i++) {
    const started = new Date(newest - i * 7 * 3_600_000);
    const finished = new Date(started.getTime() + (9 + (i % 4) * 6) * 60_000);
    out.push({
      id: `run_hist${String(i).padStart(3, "0")}`,
      project_path: HIST_PROJECTS[i % HIST_PROJECTS.length]!,
      request_text: HIST_REQUESTS[i % HIST_REQUESTS.length]!,
      team: i % 3 === 0 ? "feature-team" : i % 3 === 1 ? "bug-fix-team" : null,
      mode: i % 3 === 2 ? "single" : "team",
      status: i % 9 === 5 ? "crashed" : "complete",
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      cost_usd: Math.round((0.08 + (i % 7) * 0.11) * 100) / 100,
    });
  }
  return out;
}

export const mockRunSummaries: RunSummary[] = [
  {
    id: MOCK_RUN_ID,
    project_path: mockRunTree.run.project_path,
    request_text: mockRunTree.run.request_text,
    team: "feature-team",
    mode: "team",
    status: "surfaced",
    started_at: "2026-07-01T14:02:11.000Z",
    finished_at: null,
    cost_usd: 1.29,
  },
  {
    id: "run_7bQ1mNr4tZ9",
    project_path: "C:/AiAppDeployments/orbit-api",
    request_text: "Fix N+1 query in the invoices list endpoint.",
    team: "bug-fix-team",
    mode: "team",
    status: "complete",
    started_at: "2026-06-29T09:41:00.000Z",
    finished_at: "2026-06-29T09:58:12.000Z",
    cost_usd: 0.42,
  },
  {
    id: "run_3xC8wDe2sK5",
    project_path: "C:/AiAppDeployments/orbit-api",
    request_text: "Draft an ADR for moving auth to short-lived JWTs.",
    team: null,
    mode: "single",
    status: "complete",
    started_at: "2026-06-28T16:20:00.000Z",
    finished_at: "2026-06-28T16:31:40.000Z",
    cost_usd: 0.11,
  },
  {
    id: "run_5vB9kFg6hL2",
    project_path: "C:/AiAppDeployments/pi-pp-platform",
    request_text: "Best-of-5 landing page hero variants.",
    team: null,
    mode: "best_of",
    status: "crashed",
    started_at: "2026-06-30T22:15:00.000Z",
    finished_at: "2026-06-30T22:19:03.000Z",
    cost_usd: 0.88,
  },
  ...genRunHistory(36),
];

// The pi runtime has no sub-CLIs: cli_installed/cli_version/logged_in/degraded
// are legacy fields the server always returns false/null. masked_key carries the
// engine's non-reversible fingerprint. These fixtures mirror that exactly.
export const mockProviders: ProviderStatus[] = [
  { vendor: "anthropic", configured: true, cli_installed: false, cli_version: null, has_api_key: true, logged_in: false, masked_key: "sk-ant-…9f2c", degraded: false },
  { vendor: "openai", configured: true, cli_installed: false, cli_version: null, has_api_key: true, logged_in: false, masked_key: "sk-…a71b", degraded: false },
  { vendor: "azure-openai", configured: true, cli_installed: false, cli_version: null, has_api_key: true, logged_in: false, masked_key: "azu…c19f", degraded: false },
  { vendor: "google", configured: false, cli_installed: false, cli_version: null, has_api_key: false, logged_in: false, masked_key: null, degraded: false },
];

export const mockModels: ModelInfo[] = [
  { id: "claude-fable-5", vendor: "anthropic", tier: "fable", input_per_1m: 30, output_per_1m: 150, note: "Conservative placeholder pricing." },
  { id: "claude-opus-4-7", vendor: "anthropic", tier: "opus", input_per_1m: 15, output_per_1m: 75 },
  { id: "claude-sonnet-4-6", vendor: "anthropic", tier: "sonnet", input_per_1m: 3, output_per_1m: 15 },
  { id: "claude-haiku-4-5-20251001", vendor: "anthropic", tier: "haiku", input_per_1m: 0.8, output_per_1m: 4 },
  { id: "gpt-5.4", vendor: "openai", tier: null, input_per_1m: 4, output_per_1m: 12 },
  { id: "gpt-5.4-mini", vendor: "openai", tier: null, input_per_1m: 0.8, output_per_1m: 2.4 },
  { id: "gpt-5.3-codex", vendor: "openai", tier: null, input_per_1m: 3, output_per_1m: 9 },
  { id: "gpt-5.4-mini", vendor: "azure-openai", tier: null, input_per_1m: 0.9, output_per_1m: 2.7, note: "Regional Azure pricing sample." },
  { id: "gemini-2.5-pro", vendor: "google", tier: null, input_per_1m: 3.5, output_per_1m: 10.5 },
  { id: "gemini-2.5-flash", vendor: "google", tier: null, input_per_1m: 0.3, output_per_1m: 0.9 },
];

export const mockSettings: HarnessSettings = {
  ladders: {
    claude: {
      haiku: "anthropic/claude-haiku-4-5-20251001",
      sonnet: "anthropic/claude-sonnet-4-6",
      opus: "anthropic/claude-opus-4-7",
      fable: "anthropic/claude-fable-5",
      tier_pools: {
        sonnet: ["openai/gpt-5.4-mini", "anthropic/claude-sonnet-4-6"],
      },
    },
  },
  judge_pool: [
    { provider: "openai", model: "gpt-5.4" },
    { provider: "google", model: "gemini-2.5-pro" },
    { provider: "anthropic", model: "claude-opus-4-7" },
  ],
};

/** GET /providers/available — catalog providers + a curated pi set (add-provider picker). */
export const mockAvailableProviders: InstallableProvider[] = [
  { id: "openai", display_name: "OpenAI", env_key_hint: "OPENAI_API_KEY", in_catalog: true, enabled: true, configured: true },
  { id: "azure-openai", display_name: "Azure OpenAI", env_key_hint: "AZURE_OPENAI_API_KEY", in_catalog: true, enabled: true, configured: true },
  { id: "google", display_name: "Google", env_key_hint: "GEMINI_API_KEY", in_catalog: true, enabled: true, configured: false },
  { id: "anthropic", display_name: "Anthropic", env_key_hint: "ANTHROPIC_API_KEY", in_catalog: true, enabled: true, configured: true },
  { id: "mistral", display_name: "Mistral", env_key_hint: "MISTRAL_API_KEY", in_catalog: false, enabled: false, configured: false },
  { id: "deepseek", display_name: "DeepSeek", env_key_hint: "DEEPSEEK_API_KEY", in_catalog: false, enabled: false, configured: false },
  { id: "groq", display_name: "Groq", env_key_hint: "GROQ_API_KEY", in_catalog: false, enabled: false, configured: false },
  { id: "xai", display_name: "xAI (Grok)", env_key_hint: "XAI_API_KEY", in_catalog: false, enabled: false, configured: false },
];

export const mockCaps: BudgetCap[] = [
  { scope: "day", limit_usd: 8, warn_pct: 0.8, block_pct: 1.0 },
  { scope: "run", limit_usd: 3, warn_pct: 0.8, block_pct: 1.0 },
];

/** GET /system/janitor before any run (empty default); mockJanitor is a POST-execute result. */
export const mockJanitorEmpty: JanitorReport = { ran_at: null, dry_run: false, crashed_runs: [], swept: 0, reclaimed_bytes: 0, entries: [] };
export const mockJanitor: JanitorReport = {
  ran_at: "2026-07-01T03:00:00.000Z",
  dry_run: false,
  crashed_runs: [],
  swept: 3,
  reclaimed_bytes: 41_582_336,
  entries: [
    { path: ".harness/candidates/run_5vB9kFg6hL2", kind: "worktree", bytes: 41_582_080, age_days: 1.2 },
    { path: "C:/AiAppDeployments/acme-checkout/.harness/.lock", kind: "lock", bytes: 256, age_days: 1.2 },
    { path: "pp/cand-run_5vB9kFg6hL2-a", kind: "branch", bytes: 0, age_days: 1.2 },
  ],
};

/** Governance forums — mirror @pp/core forums.ts. The real GET /forums list
 * returns the summary subset; the detail (GET /forums/:id) adds `stages`.
 * The mock serves these full objects for both routes. */
export const mockForums: Forum[] = [
  { id: "framing", title: "Problem framing / discovery review", description: "Confirms the problem, target users, and success metric before scope work begins.", produces: "Problem statement, evidence, success metrics", stages: [
    { kind: "problem_statement", artifact_kind: "one_pager", gate_type: "spec", generator_agent: "research-analyst", judge_tier: "cross_vendor", rubric_id: "feature-spec-quality@2" },
    { kind: "success_metrics", artifact_kind: "okrs", gate_type: "spec", generator_agent: "strategy-lead", judge_tier: "same_vendor" },
  ] },
  { id: "architecture", title: "Architecture review", description: "Reviews the technical approach, ADRs, and system boundaries.", produces: "ADRs, C4 sketches, tech design", stages: [
    { kind: "adr", artifact_kind: "adr", gate_type: "design", generator_agent: "architect", judge_tier: "cross_vendor", rubric_id: "adr-madr-structure@1" },
    { kind: "c4_sketch", artifact_kind: "c4_diagram", gate_type: "design", generator_agent: "architect", judge_tier: "same_vendor" },
  ] },
  { id: "security", title: "Security review", description: "Threat model, control mapping, and privacy review. Cross-vendor on every gate.", produces: "Threat model, control matrix, PIA", required_missability_checks: ["authz-matrix", "secrets-scan"], stages: [
    { kind: "threat_model", artifact_kind: "threat_model", gate_type: "security", generator_agent: "threat-modeler", judge_tier: "cross_vendor", rubric_id: "stride-threat-model@1" },
    { kind: "controls", artifact_kind: "control_matrix", gate_type: "security", generator_agent: "security-reviewer", judge_tier: "cross_vendor", rubric_id: "owasp-asvs@2" },
    { kind: "privacy_impact", artifact_kind: "pia", gate_type: "security", generator_agent: "privacy-reviewer", judge_tier: "cross_vendor" },
  ] },
  { id: "api-design", title: "API / contract review", description: "OpenAPI/AsyncAPI stability and integration wiring.", produces: "OpenAPI, event catalog", stages: [
    { kind: "openapi", artifact_kind: "openapi", gate_type: "contract", generator_agent: "api-designer", judge_tier: "cross_vendor", rubric_id: "openapi-3.1-stability@1" },
    { kind: "event_catalog", artifact_kind: "event_catalog", gate_type: "contract", generator_agent: "api-designer", judge_tier: "same_vendor" },
  ] },
  { id: "data-governance", title: "Data governance review", description: "ERD, lineage, retention, and analytics events.", produces: "ERD, retention policy, lineage", stages: [
    { kind: "erd", artifact_kind: "erd", gate_type: "design", generator_agent: "db-designer", judge_tier: "same_vendor" },
    { kind: "retention_policy", artifact_kind: "retention_policy", gate_type: "security", generator_agent: "privacy-reviewer", judge_tier: "cross_vendor" },
  ] },
  { id: "release-readiness", title: "Release readiness review", description: "Rollout, rollback, migration runbook, and comms.", produces: "Rollout plan, rollback plan", stages: [
    { kind: "rollout_plan", artifact_kind: "rollout_plan", gate_type: "design", generator_agent: "release-engineer", judge_tier: "cross_vendor" },
    { kind: "rollback_plan", artifact_kind: "rollback_plan", gate_type: "design", generator_agent: "release-engineer", judge_tier: "same_vendor" },
    { kind: "migration_runbook", artifact_kind: "migration_runbook", gate_type: "docs_polish", generator_agent: "migration-planner", judge_tier: "same_vendor" },
  ] },
  { id: "cost", title: "Cost review", description: "Budget envelope and tier-ladder cost analysis.", produces: "Cost model, budget caps", stages: [
    { kind: "cost_model", artifact_kind: "business_case", gate_type: "spec", generator_agent: "cfo", judge_tier: "same_vendor" },
  ] },
  { id: "privacy", title: "Privacy review", description: "PIA/DPIA, data-flow, and retention/deletion.", produces: "PIA, data-flow map", stages: [
    { kind: "pia", artifact_kind: "pia", gate_type: "security", generator_agent: "privacy-reviewer", judge_tier: "cross_vendor" },
    { kind: "data_flow_map", artifact_kind: "lineage_map", gate_type: "design", generator_agent: "data-engineer", judge_tier: "same_vendor" },
  ] },
  { id: "accessibility", title: "Accessibility review", description: "WCAG 2.2 AA conformance and a11y plan.", produces: "A11y plan, conformance report", stages: [
    { kind: "a11y_plan", artifact_kind: "a11y_plan", gate_type: "design", generator_agent: "a11y-auditor", judge_tier: "cross_vendor", rubric_id: "wcag-2.2-aa@1" },
  ] },
  { id: "incident-postmortem", title: "Incident post-mortem", description: "Blameless post-mortem and corrective actions.", produces: "Post-mortem, action items", stages: [
    { kind: "post_mortem", artifact_kind: "post_mortem", gate_type: "docs_polish", generator_agent: "incident-commander", judge_tier: "same_vendor" },
    { kind: "action_items", artifact_kind: "decision_log", gate_type: "spec", generator_agent: "incident-commander", judge_tier: "same_vendor" },
  ] },
];

/** All 16 taxonomy sections — mirror of @pp/core TAXONOMY_SECTIONS (artifact
 * kind lists abridged for the very wide sections). */
export const mockTaxonomy: TaxonomySection[] = [
  { id: "4.1", title: "Strategy, business context, and investment logic", default_artifact_kinds: ["vision_brief", "business_case", "okrs", "one_pager"], master_plan_section: "2. Business and portfolio context" },
  { id: "4.2", title: "User, market, workflow, and domain understanding", default_artifact_kinds: ["research_brief", "personas", "journey_map"], master_plan_section: "3. Stakeholders and users" },
  { id: "4.3", title: "Product scope, requirements, and prioritization", default_artifact_kinds: ["prd", "feature_spec", "acceptance_criteria"], master_plan_section: "6. Functional requirements" },
  { id: "4.4", title: "Experience design, content, and accessibility", default_artifact_kinds: ["ia_map", "user_flow", "wireframes", "design_tokens", "component_specs", "a11y_plan"], master_plan_section: "9. UX/UI/content design" },
  { id: "4.5", title: "Domain model, data, analytics, and information lifecycle", default_artifact_kinds: ["erd", "data_dictionary", "lineage_map", "retention_policy", "migration_plan"], master_plan_section: "10. Domain and data model" },
  { id: "4.6", title: "Architecture and technical strategy", default_artifact_kinds: ["adr", "c4_diagram", "deployment_arch", "tech_design_doc"], master_plan_section: "11. Architecture and technical strategy" },
  { id: "4.7", title: "Interfaces, contracts, and integration wiring", default_artifact_kinds: ["openapi", "asyncapi", "route_inventory", "event_catalog"], master_plan_section: "12. Interfaces and contracts" },
  { id: "4.8", title: "Engineering implementation system and code quality", default_artifact_kinds: ["coding_standard", "review_checklist", "diff", "code"], master_plan_section: "13. Engineering standards and delivery model" },
  { id: "4.9", title: "Security, privacy, compliance, and trust", default_artifact_kinds: ["threat_model", "control_matrix", "pia", "sbom"], master_plan_section: "14. Security, privacy, and compliance" },
  { id: "4.10", title: "Quality engineering and verification", default_artifact_kinds: ["test_strategy", "test_plan", "contract_tests", "performance_budget"], master_plan_section: "15. Test and verification strategy" },
  { id: "4.11", title: "Delivery, environments, release, and change management", default_artifact_kinds: ["rollout_plan", "rollback_plan", "migration_runbook", "release_notes"], master_plan_section: "19. Launch, migration, and rollback plan" },
  { id: "4.12", title: "Observability, reliability, operations, and support", default_artifact_kinds: ["slo_doc", "telemetry_taxonomy", "runbook", "alert_catalog"], master_plan_section: "16. Operations and support model" },
  { id: "4.13", title: "Documentation, enablement, and knowledge management", default_artifact_kinds: ["changelog", "release_notes", "runbook", "user_doc"], master_plan_section: "Appendices" },
  { id: "4.14", title: "Team operating model, decision governance, and execution cadence", default_artifact_kinds: ["raci", "decision_log", "delivery_plan"], master_plan_section: "17. Team operating model and governance" },
  { id: "4.15", title: "AI and agentic system controls", default_artifact_kinds: ["ai_system_spec", "eval_suite", "tool_permission_matrix", "hitl_workflow"], master_plan_section: "Appendices" },
  { id: "4.16", title: "Deprecation, retirement, and lifecycle exit", default_artifact_kinds: ["eol_plan", "migration_guide", "sunset_comms"], master_plan_section: "20. Deprecation and retirement plan" },
];

const DAY = "2026-07-01";
export const mockBudgets: BudgetEntry[] = [
  { scope: `day:${DAY}`, tokens_in: 184300, tokens_out: 78210, cost_usd: 6.42, updated_at: "2026-07-01T14:13:59.000Z" },
  { scope: `run:${MOCK_RUN_ID}`, tokens_in: 58120, tokens_out: 24230, cost_usd: 1.29, updated_at: "2026-07-01T14:13:59.000Z" },
  { scope: "model:claude-opus-4-7", tokens_in: 29900, tokens_out: 13430, cost_usd: 0.86, updated_at: "2026-07-01T14:12:44.000Z" },
  { scope: "tier:opus", tokens_in: 29900, tokens_out: 13430, cost_usd: 0.86, updated_at: "2026-07-01T14:12:44.000Z" },
  { scope: "tier:sonnet", tokens_in: 21450, tokens_out: 9180, cost_usd: 0.20, updated_at: "2026-07-01T14:10:11.000Z" },
  { scope: "tier:haiku", tokens_in: 6770, tokens_out: 1620, cost_usd: 0.02, updated_at: "2026-07-01T14:13:59.000Z" },
];

/** Terse team factory for the long tail of built-in teams. */
function genTeam(
  name: string,
  description: string,
  stageSpecs: Array<[kind: string, gate: string, tier?: "cross_vendor" | "same_vendor"]>,
  taxonomy: string[],
): TeamSpec {
  const stages: TeamStage[] = stageSpecs.map(([kind, gate, tier]) => ({
    kind,
    gate_type: gate,
    generator: { agent: `${kind.replace(/_/g, "-")}-author`, primary: "claude" },
    judge: { tier: tier ?? (gate === "security" || gate === "contract" || gate === "spec" ? "cross_vendor" : "same_vendor") },
  }));
  return { name, description, origin: "builtin", stages, taxonomy_required: taxonomy };
}

/** The long tail — compact built-in teams so the Library shows a full roster. */
const MORE_TEAMS: TeamSpec[] = [
  genTeam("refactor-team", "Invariants → behavior-preserving refactor → regression guard (TDD).", [["invariants", "spec"], ["refactor", "code_style"], ["tests", "code_style"]], ["4.8", "4.10"]),
  genTeam("ux-team", "IA → flows → screen-state matrix → wireframes → a11y plan.", [["ia_map", "design"], ["user_flow", "design"], ["wireframes", "design"], ["a11y_plan", "design"]], ["4.4"]),
  genTeam("design-system-team", "Design tokens → component specs → preview artifacts.", [["design_tokens", "design"], ["component_specs", "design"]], ["4.4", "4.7"]),
  genTeam("ai-controls-team", "AI system spec → eval suite → tool-permission matrix → HITL workflow.", [["ai_system_spec", "spec"], ["eval_suite", "code_style"], ["tool_permissions", "security"], ["hitl_workflow", "design"]], ["4.15"]),
  genTeam("data-team", "ERD → data dictionary → lineage → retention → migration plan.", [["erd", "design"], ["data_dictionary", "design"], ["lineage_map", "design"], ["migration_plan", "contract"]], ["4.5"]),
  genTeam("discovery-team", "Research brief → personas → journey map → glossary.", [["research_brief", "spec"], ["personas", "spec"], ["journey_map", "design"]], ["4.2"]),
  genTeam("strategy-team", "Vision brief → business case → OKRs → kill-criteria → risk register.", [["vision_brief", "spec"], ["business_case", "spec"], ["okrs", "spec"], ["risk_register", "security"]], ["4.1", "4.14"]),
  genTeam("governance-team", "RACI → decision log → review forums → cadence.", [["raci", "design"], ["decision_log", "design"]], ["4.14"]),
  genTeam("ops-team", "SLOs → telemetry taxonomy → dashboards → alerts → runbooks.", [["slo_doc", "spec"], ["telemetry_taxonomy", "design"], ["runbook", "docs_polish"]], ["4.12"]),
  genTeam("release-team", "Rollout → rollback → migration runbook → comms.", [["rollout_plan", "spec"], ["rollback_plan", "contract"], ["migration_runbook", "docs_polish"]], ["4.11"]),
  genTeam("retirement-team", "EOL plan → migration guide → archive/retention → sunset comms.", [["eol_plan", "spec"], ["migration_guide", "docs_polish"], ["sunset_comms", "docs_polish"]], ["4.16"]),
  genTeam("deep-reasoning-team", "Fable-tier deep-reasoning pipeline for high-stakes spec + architecture.", [["deep_spec", "spec", "cross_vendor"], ["deep_design", "design", "cross_vendor"]], ["4.3", "4.6"]),
  genTeam("game-feature-team", "GDD → mechanic spec → level greybox → encounter design → implementation.", [["mechanic_spec", "spec"], ["level_greybox", "design"], ["encounter_design", "design"], ["implementation", "code_style"]], ["4.3", "4.4", "4.8"]),
  genTeam("game-live-ops-team", "Season plan → economy spreadsheet → progression curve → loot tables.", [["season_plan", "spec"], ["economy_spreadsheet", "design"], ["loot_table", "design"]], ["4.5", "4.11"]),
  genTeam("game-accessibility-team", "GAG/XAG/APX-grounded accessibility plan for games.", [["accessibility_plan", "design", "cross_vendor"]], ["4.4"]),
  genTeam("game-cert-team", "Cert submission packet → perf budget → platform TRC checklist.", [["cert_submission_packet", "spec"], ["performance_budget", "code_style"]], ["4.10", "4.11"]),
  genTeam("api-platform-team", "OpenAPI contract → event catalog → threat model → contract tests.", [["openapi", "contract"], ["event_catalog", "contract"], ["threat_model", "security"], ["contract_tests", "code_style"]], ["4.7", "4.9", "4.10"]),
  genTeam("perf-team", "Performance budget → profile → optimization → verification.", [["performance_budget", "spec"], ["performance_profile", "code_style"], ["optimization", "code_style"]], ["4.10"]),
  genTeam("docs-team", "User docs → runbook → changelog → release notes.", [["user_doc", "docs_polish"], ["runbook", "docs_polish"], ["changelog", "docs_polish"]], ["4.13"]),
  genTeam("privacy-team", "PIA → data-flow → retention/deletion → DPIA sign-off.", [["pia", "security"], ["data_flow", "security"], ["retention_deletion", "security"]], ["4.9"]),
  genTeam("mobile-team", "Mobile IA → flows → platform a11y → implementation.", [["ia_map", "design"], ["user_flow", "design"], ["implementation", "code_style"]], ["4.4", "4.8"]),
  genTeam("sdk-team", "Public API surface → semver contract → examples → reference docs.", [["route_inventory", "contract"], ["contract_tests", "code_style"], ["user_doc", "docs_polish"]], ["4.7", "4.13"]),
  genTeam("embedded-team", "HAL design → memory budget → RTOS task map → implementation.", [["tech_design_doc", "design"], ["performance_budget", "code_style"], ["implementation", "code_style"]], ["4.6", "4.10"]),
];

export const mockTeams: TeamSpec[] = [
  {
    name: "feature-team",
    description: "Spec → design → contracts → implementation → docs for a net-new feature.",
    origin: "builtin",
    profiles_compatible: ["web-ui", "api-platform", "internal-tool"],
    taxonomy_required: ["4.3", "4.6", "4.7", "4.8"],
    stages: [
      { kind: "spec", gate_type: "spec", generator: { agent: "spec-author", primary: "claude", model_tier: "opus" }, judge: { tier: "cross_vendor", rubric: "feature-spec-quality@2" } },
      { kind: "design", gate_type: "design", generator: { agent: "architect", primary: "claude", model_tier: "opus" }, judge: { tier: "cross_vendor", rubric: "adr-madr-structure@1" } },
      { kind: "contracts", gate_type: "contract", generator: { agent: "api-designer", primary: "codex" }, judge: { tier: "cross_vendor", rubric: "openapi-3.1-stability@1" } },
      { kind: "implementation", gate_type: "code_style", generator: { agent: "engineer", primary: "claude" }, judge: { tier: "same_vendor", rubric: "code-quality@3" }, best_of_n_on_major_scope: 3 },
      { kind: "docs", gate_type: "docs_polish", generator: { agent: "docs-author", primary: "claude", model_tier: "haiku" }, judge: { tier: "same_vendor" } },
    ],
  },
  {
    name: "bug-fix-team",
    description: "Repro → failing test → fix → regression guard. Enforces the TDD red/green gate.",
    origin: "builtin",
    profiles_compatible: ["web-ui", "api-platform", "sdk"],
    taxonomy_required: ["4.3", "4.8", "4.10"],
    stages: [
      { kind: "repro", gate_type: "spec", generator: { agent: "spec-author", primary: "claude" }, judge: { tier: "same_vendor" } },
      { kind: "tests_pre", gate_type: "code_style", generator: { agent: "test-strategist", primary: "claude" }, judge: { tier: "same_vendor" } },
      { kind: "fix", gate_type: "code_style", generator: { agent: "engineer", primary: "claude" }, judge: { tier: "cross_vendor", rubric: "code-quality@3" } },
    ],
  },
  {
    name: "security-review-team",
    description: "Threat model → control mapping → privacy review. Cross-vendor on every gate.",
    origin: "builtin",
    profiles_compatible: ["enterprise", "api-platform"],
    taxonomy_required: ["4.9"],
    stages: [
      { kind: "threat_model", gate_type: "security", generator: { agent: "security-reviewer", primary: "claude", model_tier: "opus" }, judge: { tier: "cross_vendor", rubric: "stride-threat-model@1" } },
      { kind: "controls", gate_type: "security", generator: { agent: "security-reviewer", primary: "claude" }, judge: { tier: "cross_vendor", rubric: "owasp-asvs@2" } },
    ],
  },
  ...MORE_TEAMS,
];

export const mockProfiles: ProfileSpec[] = [
  {
    name: "web-ui",
    description: "Browser-facing UI work. Demands wireframes, a11y, and visual regression.",
    required_taxonomy_sections: ["4.4", "4.8", "4.10"],
    required_rubrics: { design: "wcag-2.2-aa@1", code_style: "code-quality@3" },
    required_artifacts: ["wireframes", "component_specs", "a11y_plan"],
    required_missability_checks: ["changelog-present", "a11y-smoke"],
    required_validators: { wireframe: ["mermaid_render"] },
    notes: "Layers `mobile` when a mobile target is detected.",
  },
  {
    name: "api-platform",
    description: "Backend service / API surface. Contracts-first with OpenAPI validation.",
    required_taxonomy_sections: ["4.7", "4.8", "4.9", "4.10"],
    required_rubrics: { contract: "openapi-3.1-stability@1", security: "owasp-asvs@2" },
    required_artifacts: ["openapi", "threat_model"],
    required_validators: { openapi: ["contracts_lint"] },
    required_validators_strict: ["contracts_lint"],
  },
  {
    name: "enterprise",
    description: "Regulated / high-assurance. Forces cross-vendor judging on every gate.",
    required_taxonomy_sections: ["4.9", "4.14"],
    required_rubrics: { security: "owasp-asvs@2" },
    required_artifacts: ["threat_model", "control_matrix", "raci"],
    notes: "cross_vendor forced on all gates; validators fail-closed.",
  },
];

export const mockRubrics: RubricInfo[] = [
  { id: "feature-spec-quality@2", kind: "spec", version: "2", source_url: null },
  { id: "adr-madr-structure@1", kind: "design", version: "1", source_url: "https://adr.github.io/madr/" },
  { id: "openapi-3.1-stability@1", kind: "contract", version: "1", source_url: "https://spec.openapis.org/oas/v3.1.0" },
  { id: "code-quality@3", kind: "code_style", version: "3", source_url: null },
  { id: "owasp-asvs@2", kind: "security", version: "2", source_url: "https://owasp.org/www-project-application-security-verification-standard/" },
  { id: "stride-threat-model@1", kind: "security", version: "1", source_url: null },
  { id: "wcag-2.2-aa@1", kind: "design", version: "1", source_url: "https://www.w3.org/TR/WCAG22/" },
];

export const mockRubricBody = `# code-quality@3

A same-vendor code-style gate. Applied at the \`code_style\` stage of feature and
bug-fix teams.

## Dimensions

| Dimension | Weight | Fail if |
| --- | --- | --- |
| Correctness | 0.4 | Logic diverges from the spec's acceptance criteria |
| Clarity | 0.2 | Names/structure obscure intent; dead code |
| Tests | 0.3 | New behavior lacks a covering test |
| Safety | 0.1 | Unsanitized input, un-parameterized queries |

## Notes

- A \`needs_review\` self-verify finding forces a **cross-vendor re-judge**
  before the stage may be marked \`passed\`.
- Score \`>= 0.75\` weighted → **pass**; \`0.5–0.75\` → **revise**; \`< 0.5\` → **fail**.
`;

export const mockEvolutionProposals: EvolutionProposal[] = [
  {
    id: "evo_4417",
    run_id: "run_7bQ1mNr4tZ9",
    resource_rid: "rubric:code-quality@3",
    proposed_change:
      "Down-weight the Clarity dimension from 0.2 → 0.15 and add a 0.05 'diff hygiene' sub-score. Rationale: Clarity false-positives on idiomatic early returns.",
    justification: "Same false-positive flagged across 4 runs on early-return patterns.",
    signal_count: 4,
    risk_class: "medium",
    eights_proposal_id: "eights_prop_9981",
    status: "pending",
    created_at: "2026-06-30T18:22:00.000Z",
  },
  {
    id: "evo_4390",
    run_id: "run_3xC8wDe2sK5",
    resource_rid: "team:security-review-team",
    proposed_change: "Insert a `data_flow` stage between threat_model and controls.",
    justification: "Reviewers repeatedly hand-authored data-flow diagrams post-hoc.",
    signal_count: 3,
    risk_class: "high",
    eights_proposal_id: null,
    status: "approved",
    created_at: "2026-06-27T11:05:00.000Z",
  },
  {
    id: "evo_4358",
    run_id: "run_3xC8wDe2sK5",
    resource_rid: "rubric:wcag-2.2-aa@1",
    proposed_change: "Add a 'focus-visible on custom controls' checkpoint to the keyboard section.",
    justification: "3 runs shipped custom dropdowns with no visible focus ring; the rubric never flagged it.",
    signal_count: 3,
    risk_class: "high",
    eights_proposal_id: "eights_prop_0877",
    status: "committed",
    created_at: "2026-06-25T09:40:00.000Z",
  },
  {
    id: "evo_4402",
    run_id: "run_7bQ1mNr4tZ9",
    resource_rid: "rubric:owasp-asvs@2",
    proposed_change: "Relax ASVS V2.1.1 (password length) check to WARN when the project is a non-auth internal tool.",
    justification: "5 internal-tool runs flagged V2.1.1 as a false positive on services with no auth surface.",
    signal_count: 5,
    risk_class: "high",
    eights_proposal_id: "eights_prop_1042",
    status: "pending",
    created_at: "2026-07-01T08:12:00.000Z",
  },
];

export const mockDoctor: DoctorReport = {
  cli_versions: { codex: "codex 0.34.0", gemini: "gemini 0.9.2", claude: "claude 2.1.4", git: "git 2.45.1", node: "v22.20.0" },
  db_reachable: true,
  vendors_configured: { openai: true, "azure-openai": true, google: false, anthropic: true },
  vendor_credentials: {
    openai: { cli: true, api_key: true, logged_in: false },
    "azure-openai": { cli: true, api_key: true, logged_in: false },
    google: { cli: true, api_key: false, logged_in: false },
    anthropic: { cli: true, api_key: true, logged_in: true },
  },
  judge_capabilities: { cross_vendor_pairs: [["anthropic", "openai"]] },
  vendor_degraded: { openai: false, google: true, anthropic: false },
  gemini_disabled: false,
  cross_vendor_ready: true,
  critique_smoke: {
    codex: { status: "ok", model: "gpt-5.4", wall_ms: 2100 },
    gemini: { status: "skipped", model: "gemini-2.5-pro", reason: "vendor not configured" },
  },
  browser_engines: {
    playwright: { status: "ok" },
    chrome_mcp: { status: "agent_probed_at_runtime", note: "detected by browser-validator agent at runtime" },
  },
  db_path: "C:/Users/robob/.pp/daemon.db",
};
