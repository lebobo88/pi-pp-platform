/**
 * Deterministic team recommendation. Scores every discoverable team
 * (project → user → built-in via listTeams) against the request text,
 * the heuristic triage signals, and the active project profile, then
 * returns the top 5 with per-rule reasons. Pure heuristics — no model
 * calls — so the /pp:run major-scope abort path and the
 * /api/v1/teams/recommend endpoint can suggest a pipeline without
 * burning tokens.
 */

import { heuristicTriage, type Scope } from "./taxonomy.js";
import { listTeams, getTeam } from "./teams.js";
import { loadProjectProfile } from "./profiles.js";
import { detectProfile } from "./profile-detect.js";

export type TeamRecommendation = {
  team: string;
  score: number;
  confidence: "high" | "medium" | "low";
  reasons: string[];
};

export type TeamRecommendResult = {
  scope: Scope;
  /** True when triage (or the caller's override) classified the request as major. */
  suggest_team_mode: boolean;
  recommendations: TeamRecommendation[];
};

/**
 * Static keyword hints per built-in team: +2 per distinct regex hit.
 * Game teams are listed too, but rule 1's game gate (-5 without a
 * game-dev* profile) keeps them from outranking non-game teams on
 * generic projects.
 */
export const TEAM_KEYWORD_HINTS: Record<string, RegExp[]> = {
  "bug-fix-team": [
    /\b(bug|crash|broken|defect|glitch|regression)\b/,
    /\b(fix|fixes|fixing|repro|reproduce|stack ?trace)\b/,
  ],
  "refactor-team": [
    /\b(refactor\w*|restructure|decouple|extract|clean[- ]?up|tech(nical)? debt|behavior[- ]preserving)\b/,
  ],
  "ux-team": [
    /\b(ux|user experience|wireframes?|user flows?|screen states?|information architecture|usability|a11y|accessibility)\b/,
  ],
  "design-system-team": [
    /\b(design system|design tokens?|component (library|specs?|kit)|storybook|style ?guide|theming)\b/,
  ],
  "data-team": [
    /\b(erd|schema|data model|lineage|data retention|analytics events?|data dictionary|entity|entities|warehouse)\b/,
  ],
  "ops-team": [
    /\b(slos?|slis?|alerts?|dashboards?|runbooks?|telemetry|observability|on[- ]call|incident|monitoring)\b/,
  ],
  "marketing-team": [
    /\b(marketing|landing pages?|blog posts?|ad copy|seo|campaign|newsletter|copywriting)\b/,
  ],
  "strategy-team": [
    /\b(strateg\w*|vision|business case|investment|portfolio|kill[- ]criteria|risk register)\b/,
    /\bokrs?\b/,
    /\broadmap\b/,
  ],
  "discovery-team": [
    /\b(discovery|user research|personas?|journey maps?|interviews?|jtbd|glossary)\b/,
  ],
  "docs-team": [
    /\b(docs|documentation|readme|changelog|release notes|user guide|tutorial)\b/,
  ],
  "feature-team": [
    /\b(features?|new [a-z]+ (flow|page|screen|endpoint|capability|integration)|end[- ]to[- ]end|greenfield)\b/,
  ],
  "feature-team-tdd": [
    /\btdd\b/,
    /\b(test[- ](first|driven)|failing tests?|red[- ]green)\b/,
  ],
  "deep-reasoning-team": [
    /\b(deep reasoning|formal proof|prove|correctness|race condition|deadlock|concurrency)\b/,
  ],
  "governance-team": [
    /\b(raci|governance|decision logs?|review forums?|decision rights|cadence)\b/,
  ],
  "ai-controls-team": [
    /\b(ai|llm|agents?|agentic|prompts?|evals?|eval suite|hitl|guardrails?|hallucination|tool[- ]permissions?|model card)\b/,
  ],
  "release-team": [
    /\b(release|rollout|rollback|deploy(ment)?|launch|cutover|canary)\b/,
  ],
  "retirement-team": [
    /\b(deprecat\w*|retire\w*|sunset|eol|end[- ]of[- ]life|decommission|shut ?down)\b/,
  ],
  "security-review-team": [
    /\b(security|threat model|vulnerabilit\w*|owasp|asvs|pentest|auth[nz]?|oauth|cve|encryption|secrets?|rbac)\b/,
  ],
  // ─── Game teams (gated by rule 1 unless the profile is game-dev*) ───────
  "game-feature-team": [
    /\b(game|gameplay|mechanics?|gdd|level|boss|enemy|npc|quest|player)\b/,
  ],
  "game-bug-fix-team": [
    /\b(game|gameplay)\b[\s\S]*\b(bug|crash|glitch)\b|\b(bug|crash|glitch)\b[\s\S]*\b(game|gameplay)\b/,
  ],
  "game-refactor-team": [
    /\brefactor\w*\b[\s\S]*\b(game|engine|unity|unreal|godot)\b|\b(game|engine|unity|unreal|godot)\b[\s\S]*\brefactor\w*\b/,
  ],
  "game-netcode-team": [
    /\b(netcode|multiplayer|replication|server[- ]auth\w*|anti[- ]cheat|desync|matchmaking)\b/,
  ],
  "game-live-ops-team": [
    /\b(live[- ]?ops|season pass|battle pass|patch notes|hotfix|a\/b test)\b/,
  ],
  "game-cert-team": [
    /\b(cert|trc|lotcheck|submission|esrb|pegi|iarc)\b/,
  ],
  "game-accessibility-team": [
    /\b(gag|xag|subtitles?|colou?r[- ]?blind|remappable)\b/,
  ],
  "game-art-pipeline-team": [
    /\b(art pipeline|rig(ging)?|animation|blend[- ]tree|dcc|blender|textures?|shaders?)\b/,
  ],
};

/** heuristicTriage signal → team score boosts (rule 2). */
const SIGNAL_TEAM_BOOSTS: Record<string, Array<{ team: string; delta: number }>> = {
  "security-keyword": [
    { team: "security-review-team", delta: 3 },
    { team: "ai-controls-team", delta: 1 },
  ],
  "doc-only": [{ team: "docs-team", delta: 4 }],
  "retirement-keyword": [{ team: "retirement-team", delta: 4 }],
  "release-keyword": [{ team: "release-team", delta: 2 }],
  "major-keyword": [
    { team: "feature-team", delta: 1 },
    { team: "refactor-team", delta: 1 },
  ],
};

/** Tokens (len >= 4) too generic to signal a team via name/description overlap. */
const OVERLAP_STOPWORDS = new Set([
  "about", "actually", "adds", "adding", "after", "also", "another", "back",
  "been", "before", "being", "best", "better", "between", "build", "built",
  "cannot", "change", "changes", "code", "could", "current", "does", "doing",
  "done", "down", "each", "ensure", "every", "everything", "existing", "file",
  "files", "first", "flow", "flows", "from", "gets", "give", "goes", "good",
  "have", "having", "here", "input", "instead", "into", "issue", "just",
  "keep", "know", "like", "little", "look", "made", "make", "makes", "many",
  "maps", "maybe", "more", "most", "much", "must", "need", "needs", "next",
  "onto", "only", "other", "over", "part", "parts", "place", "please",
  "project", "really", "right", "same", "section", "should", "show", "side",
  "small", "some", "something", "still", "such", "sure", "take", "team",
  "teams", "than", "that", "their", "them", "then", "there", "these", "they",
  "thing", "things", "this", "those", "through", "time", "under", "update",
  "updates", "upon", "used", "user", "users", "uses", "using", "very", "want",
  "wants", "well", "were", "what", "when", "where", "which", "while", "will",
  "with", "within", "without", "work", "works", "would", "your",
]);

export type TeamRecommendOptions = {
  request_text: string;
  project_path: string;
  /** Explicit profile override; falls back to profile.yaml then detection. */
  profile?: string;
  /** Scope override (e.g. the driver's triage already classified the run). */
  scope?: Scope;
};

export function recommendTeams(opts: TeamRecommendOptions): TeamRecommendResult {
  const triage = heuristicTriage({ request_text: opts.request_text });
  const scope: Scope = opts.scope ?? triage.scope;
  const profile = resolveActiveProfile(opts);
  const text = opts.request_text.toLowerCase();
  const tokens = requestTokens(text);

  const scored: TeamRecommendation[] = listTeams({ project_path: opts.project_path }).map((t) => {
    let score = 0;
    const reasons: string[] = [];

    // (1) Profile compatibility + game gate.
    const compat = t.profiles_compatible ?? [];
    if (profile && compat.includes(profile)) {
      score += 3;
      reasons.push(`profile ${profile} compatible`);
    } else if (profile && compat.length > 0) {
      score -= 2;
      reasons.push(`not listed for profile ${profile}`);
    }
    if (t.name.startsWith("game-") && !(profile ?? "").startsWith("game-dev")) {
      score -= 5;
      reasons.push("game team without a game-dev profile");
    }

    // (2) Triage signal boosts.
    for (const signal of triage.signals) {
      for (const boost of SIGNAL_TEAM_BOOSTS[signal] ?? []) {
        if (boost.team === t.name) {
          score += boost.delta;
          reasons.push(`triage signal ${signal}`);
        }
      }
    }

    // (3) Static keyword hints: +2 per distinct regex hit.
    for (const re of TEAM_KEYWORD_HINTS[t.name] ?? []) {
      if (re.test(text)) {
        score += 2;
        reasons.push(`keyword hint /${re.source}/`);
      }
    }

    // (4) Generic token overlap with team name + description: +1 each.
    const haystack = `${t.name} ${t.description}`.toLowerCase();
    for (const tok of tokens) {
      if (haystack.includes(tok)) {
        score += 1;
        reasons.push(`token "${tok}" overlaps team name/description`);
      }
    }

    // (5) Scope priors.
    if (scope === "major" && t.name === "feature-team") {
      score += 2;
      reasons.push("major scope favors feature-team");
    }
    if (scope === "trivial") {
      const stages = stageCount(t.name, opts.project_path);
      if (stages != null && stages >= 5) {
        score -= 2;
        reasons.push(`trivial scope penalizes ${stages}-stage pipeline`);
      }
    }

    return { team: t.name, score, confidence: "low" as const, reasons };
  });

  // Stable rank: score desc, then name asc.
  scored.sort((a, b) => b.score - a.score || a.team.localeCompare(b.team));
  const recommendations = scored.slice(0, 5);

  const runnerUp = scored[1]?.score ?? Number.NEGATIVE_INFINITY;
  for (let i = 0; i < recommendations.length; i++) {
    const rec = recommendations[i]!;
    if (i === 0 && rec.score >= 6 && rec.score - runnerUp >= 3) rec.confidence = "high";
    else if (rec.score >= 3) rec.confidence = "medium";
    else rec.confidence = "low";
  }

  return {
    scope,
    suggest_team_mode: scope === "major",
    recommendations,
  };
}

/**
 * Active-profile resolution: explicit arg → <project>/.harness/profile.yaml →
 * detectProfile when its confidence is high or medium.
 */
function resolveActiveProfile(opts: { profile?: string; project_path: string }): string | null {
  if (opts.profile) return opts.profile;
  const loaded = loadProjectProfile(opts.project_path);
  if (loaded) return loaded.name;
  const detected = detectProfile(opts.project_path);
  if (detected.recommendation && (detected.confidence === "high" || detected.confidence === "medium")) {
    return detected.recommendation;
  }
  return null;
}

function requestTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[^a-z0-9_-]+/)) {
    if (raw.length < 4) continue;
    if (OVERLAP_STOPWORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

function stageCount(name: string, project_path: string): number | null {
  const found = getTeam({ name, project_path });
  return found ? found.team.stages.length : null;
}
