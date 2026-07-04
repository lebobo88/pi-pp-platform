/**
 * Fixtures for the agents library + skill registry + team recommendation
 * (B0 plumbing endpoints: GET /agents[/:id], GET /skills[/:id],
 * POST /teams/recommend).
 */
import type {
  AgentSummary,
  AgentDetail,
  AgentCategory,
  SkillSummary,
  SkillDetail,
  TeamRecommendRequest,
  TeamRecommendResponse,
  TeamRecommendation,
} from "@shared/api-types";

/** Curated agents with distinctive descriptions (search targets in tests). */
const curatedAgents: AgentSummary[] = [
  { id: "api-designer", name: "API Designer", description: "Contracts-first OpenAPI/AsyncAPI author; keeps surfaces stable across versions.", category: "engineering", model: "opus", tier: "opus", teams: ["feature-team", "api-platform-team"], origin: "builtin" },
  { id: "architect", name: "Architect", description: "System boundaries, ADRs, and C4 sketches for the design gate.", category: "engineering", model: "claude-opus-4-7", tier: "opus", teams: ["feature-team", "deep-reasoning-team"], origin: "builtin" },
  { id: "docs-author", name: "Docs Author", description: "User docs, runbooks, and changelogs in the project voice.", category: "engineering", model: "haiku", tier: "haiku", teams: ["feature-team", "docs-team"], origin: "builtin" },
  { id: "engineer", name: "Engineer", description: "Implementation diffs that honor the spec's acceptance criteria and the repo idioms.", category: "engineering", teams: ["feature-team", "bug-fix-team", "mobile-team"], origin: "builtin" },
  { id: "gate-judge", name: "Gate Judge", description: "Rubric-driven verdicts with per-dimension scores and a Reflexion critique.", category: "judge", teams: [], origin: "builtin" },
  { id: "security-reviewer", name: "Security Reviewer", description: "STRIDE threat models and OWASP ASVS control mapping.", category: "governance", model: "opus", tier: "opus", teams: ["security-review-team", "privacy-team"], origin: "builtin" },
  { id: "spec-author", name: "Spec Author", description: "Feature specs with testable acceptance criteria; the first stage of most teams.", category: "engineering", model: "opus", tier: "opus", teams: ["feature-team", "bug-fix-team"], origin: "builtin" },
  { id: "test-strategist", name: "Test Strategist", description: "Failing-first tests and regression guards for the TDD red/green gate.", category: "engineering", teams: ["bug-fix-team", "refactor-team"], origin: "project" },
];

/* The long tail — mirrors the real catalog's size (75 agents), so the page's
 * search + grouping get exercised realistically under VITE_MOCK=1. */
const TAIL_DESCRIPTION: Record<AgentCategory, (name: string) => string> = {
  engineering: (n) => `${n} — stage generator for implementation-adjacent artifacts.`,
  judge: (n) => `${n} — gate judge scoring one artifact kind against its rubric.`,
  executive: (n) => `${n} — strategic framing and business-context briefs.`,
  game: (n) => `${n} — game-profile generator (design docs, balance, content).`,
  governance: (n) => `${n} — governance-forum reviewer producing audit-ready artifacts.`,
  harness: (n) => `${n} — internal harness role dispatched by the lifecycle itself.`,
  other: (n) => `${n} — supporting specialist available to any pipeline.`,
};

const TAIL: Array<[id: string, category: AgentCategory, teams?: string[]]> = [
  ["backend-engineer", "engineering", ["feature-team", "api-platform-team"]],
  ["frontend-engineer", "engineering", ["feature-team", "ux-team"]],
  ["mobile-engineer", "engineering", ["mobile-team"]],
  ["data-engineer", "engineering", ["data-team"]],
  ["ml-engineer", "engineering", []],
  ["devops-engineer", "engineering", ["release-team"]],
  ["sre", "engineering", ["release-team"]],
  ["platform-engineer", "engineering", []],
  ["refactoring-specialist", "engineering", ["refactor-team"]],
  ["perf-engineer", "engineering", ["performance-team"]],
  ["db-designer", "engineering", ["data-team"]],
  ["migration-planner", "engineering", ["release-team"]],
  ["integration-engineer", "engineering", ["api-platform-team"]],
  ["sdk-author", "engineering", ["sdk-team"]],
  ["cli-author", "engineering", ["sdk-team"]],
  ["release-engineer", "engineering", ["release-team"]],
  ["build-engineer", "engineering", []],
  ["code-reviewer", "engineering", ["feature-team", "bug-fix-team"]],
  ["debugging-specialist", "engineering", ["bug-fix-team"]],
  ["accessibility-engineer", "engineering", ["ux-team"]],
  ["i18n-engineer", "engineering", ["ux-team"]],
  ["observability-engineer", "engineering", ["release-team"]],
  ["cache-strategist", "engineering", ["performance-team"]],
  ["queue-designer", "engineering", ["api-platform-team"]],
  ["contract-judge", "judge"],
  ["design-judge", "judge"],
  ["security-judge", "judge"],
  ["docs-judge", "judge"],
  ["test-judge", "judge"],
  ["ux-judge", "judge"],
  ["borda-arbiter", "judge"],
  ["ceo", "executive"],
  ["cfo", "executive"],
  ["cto", "executive"],
  ["coo", "executive"],
  ["cmo", "executive"],
  ["chief-risk-officer", "executive"],
  ["chief-people-officer", "executive"],
  ["strategy-lead", "executive"],
  ["game-designer", "game", ["game-team"]],
  ["level-designer", "game", ["game-team"]],
  ["narrative-designer", "game", ["game-team"]],
  ["economy-designer", "game", ["game-team"]],
  ["combat-designer", "game", ["game-team"]],
  ["ui-ux-game-designer", "game", ["game-team"]],
  ["audio-designer", "game", ["game-team"]],
  ["liveops-planner", "game", ["game-team"]],
  ["privacy-reviewer", "governance", ["privacy-team"]],
  ["compliance-auditor", "governance", ["security-review-team"]],
  ["threat-modeler", "governance", ["security-review-team"]],
  ["incident-commander", "governance", []],
  ["sbom-auditor", "governance", ["security-review-team"]],
  ["policy-author", "governance", []],
  ["a11y-auditor", "governance", ["ux-team"]],
  ["triage-classifier", "harness"],
  ["taxonomy-mapper", "harness"],
  ["missability-checker", "harness"],
  ["master-plan-patcher", "harness"],
  ["autogenesis-analyst", "harness"],
  ["janitor-agent", "harness"],
  ["research-analyst", "other"],
  ["technical-writer", "other", ["docs-team"]],
  ["prompt-engineer", "other"],
  ["translator", "other"],
  ["brand-reviewer", "other", ["ux-team"]],
  ["data-scientist", "other", ["data-team"]],
  ["support-triager", "other"],
];

function tailAgent([id, category, teams = []]: (typeof TAIL)[number]): AgentSummary {
  const name = id
    .split("-")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
  return { id, name, description: TAIL_DESCRIPTION[category](name), category, teams, origin: "builtin" };
}

/** 75 agents (8 curated + 67 tail), sorted by id like the real endpoint. */
export const mockAgents: AgentSummary[] = [...curatedAgents, ...TAIL.map(tailAgent)].sort((a, b) =>
  a.id.localeCompare(b.id),
);

export function mockAgentDetail(summary: AgentSummary): AgentDetail {
  return {
    ...summary,
    body: `# ${summary.name}\n\n${summary.description}\n\n## Operating rules\n\n- Read the stage brief and the project profile before generating.\n- Emit exactly one artifact of the stage's kind.\n- Cite acceptance criteria by id when claiming coverage.\n`,
  };
}

export const mockSkills: SkillSummary[] = [
  { id: "api-contracts", name: "API Contracts", description: "OpenAPI 3.1 stability rules: additive-only changes, deprecation windows, semver.", origin: "builtin", injection: "generator", applies_to_stages: ["contracts"], applies_to_agents: ["api-designer"], applies_to_profiles: ["api-platform", "sdk"], priority: 40 },
  { id: "frontend-design", name: "Frontend Design", description: "Instrument-panel design idioms: tokens, spacing, dark-first, single accent.", origin: "builtin", injection: "generator", applies_to_stages: ["*"], applies_to_agents: ["engineer"], applies_to_profiles: ["web-ui"], priority: 50 },
  { id: "judge-calibration", name: "Judge Calibration", description: "Scoring anchors and severity ladders so verdicts stay comparable across gates.", origin: "builtin", injection: "judge", applies_to_stages: [], applies_to_agents: [], applies_to_profiles: [], priority: 30 },
  { id: "repo-conventions", name: "Repo Conventions", description: "Project-local commit, naming, and directory conventions.", origin: "project", injection: "generator", applies_to_stages: [], applies_to_agents: [], applies_to_profiles: [], priority: 60 },
  { id: "threat-modeling", name: "Threat Modeling", description: "STRIDE walkthrough recipe with data-flow-first decomposition.", origin: "builtin", injection: "generator", applies_to_stages: ["threat_model", "controls"], applies_to_agents: ["security-reviewer"], applies_to_profiles: ["enterprise", "api-platform"], priority: 40 },
];

export function mockSkillDetail(summary: SkillSummary): SkillDetail {
  return {
    ...summary,
    body: `# ${summary.name}\n\n${summary.description}\n\n## Checklist\n\n1. Load the relevant reference before generating.\n2. Apply the conventions to the artifact, not as commentary.\n3. Flag conflicts with the project profile instead of silently overriding.\n`,
    version: 1,
    max_chars: 6000,
    applies_to_gate_types: [],
  };
}

/** Deterministic keyword heuristics — mirrors the flavor of team-recommend.ts. */
export function mockRecommendTeams(req: TeamRecommendRequest): TeamRecommendResponse {
  const text = (req.request_text ?? "").toLowerCase();
  const scored: TeamRecommendation[] = [];
  const add = (team: string, score: number, reasons: string[]) => scored.push({ team, score, confidence: "low", reasons });

  if (/\b(bug|fix|crash|regression|broken)\b/.test(text)) {
    add("bug-fix-team", 8, ["keywords: bug/fix", "TDD red/green gate applies"]);
  }
  if (/\b(security|threat|auth|vulnerab)/.test(text)) {
    add("security-review-team", 7, ["keywords: security/threat", "cross-vendor judging"]);
  }
  if (/\b(api|endpoint|contract|openapi)\b/.test(text)) {
    add("api-platform-team", 6, ["keywords: api/contract"]);
  }
  if (/\b(ui|page|screen|component|design)\b/.test(text)) {
    add("ux-team", 5, ["keywords: ui/design", `profile ${req.profile ?? "web-ui"} compatible`]);
  }
  add("feature-team", 4, ["default: net-new feature pipeline"]);
  add("docs-team", 1, ["fallback: docs-only interpretation"]);

  const recommendations = scored
    .sort((a, b) => b.score - a.score || a.team.localeCompare(b.team))
    .slice(0, 5)
    .map((r, i, all) => ({
      ...r,
      confidence:
        i === 0 && r.score >= 6 && (all[1] == null || r.score - all[1].score >= 3)
          ? ("high" as const)
          : r.score >= 4
            ? ("medium" as const)
            : ("low" as const),
    }));

  const scope = req.scope ?? (text.length > 240 ? "major" : text.length < 40 ? "trivial" : "standard");
  return { scope, suggest_team_mode: scope === "major", recommendations };
}
