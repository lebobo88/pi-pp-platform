import type {
  Project,
  ProviderStatus,
  ModelInfo,
  BudgetEntry,
  TeamSpec,
  ProfileSpec,
  RubricInfo,
  EvolutionProposal,
  DoctorReport,
  RunSummary,
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
  },
];

export const mockProviders: ProviderStatus[] = [
  {
    vendor: "anthropic",
    configured: true,
    cli_installed: true,
    cli_version: "claude 2.1.4",
    has_api_key: true,
    logged_in: true,
    masked_key: "sk-ant-…9f2c",
    degraded: false,
  },
  {
    vendor: "openai",
    configured: true,
    cli_installed: true,
    cli_version: "codex 0.34.0",
    has_api_key: true,
    logged_in: false,
    masked_key: "sk-…a71b",
    degraded: false,
  },
  {
    vendor: "google",
    configured: false,
    cli_installed: true,
    cli_version: "gemini 0.9.2",
    has_api_key: false,
    logged_in: false,
    masked_key: null,
    degraded: true,
  },
];

export const mockModels: ModelInfo[] = [
  { id: "claude-fable-5", vendor: "anthropic", tier: "fable", input_per_1m: 30, output_per_1m: 150, note: "Conservative placeholder pricing." },
  { id: "claude-opus-4-7", vendor: "anthropic", tier: "opus", input_per_1m: 15, output_per_1m: 75 },
  { id: "claude-sonnet-4-6", vendor: "anthropic", tier: "sonnet", input_per_1m: 3, output_per_1m: 15 },
  { id: "claude-haiku-4-5-20251001", vendor: "anthropic", tier: "haiku", input_per_1m: 0.8, output_per_1m: 4 },
  { id: "gpt-5.4", vendor: "openai", tier: null, input_per_1m: 4, output_per_1m: 12 },
  { id: "gpt-5.3-codex", vendor: "openai", tier: null, input_per_1m: 3, output_per_1m: 9 },
  { id: "gemini-2.5-pro", vendor: "google", tier: null, input_per_1m: 3.5, output_per_1m: 10.5 },
  { id: "gemini-2.5-flash", vendor: "google", tier: null, input_per_1m: 0.3, output_per_1m: 0.9 },
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
];

export const mockDoctor: DoctorReport = {
  cli_versions: { codex: "codex 0.34.0", gemini: "gemini 0.9.2", claude: "claude 2.1.4", git: "git 2.45.1", node: "v22.20.0" },
  db_reachable: true,
  vendors_configured: { openai: true, google: false, anthropic: true },
  vendor_credentials: {
    openai: { cli: true, api_key: true, logged_in: false },
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
