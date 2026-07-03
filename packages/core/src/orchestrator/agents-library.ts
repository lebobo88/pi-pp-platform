/**
 * Agents library. Lists and resolves the agent prompt files that define the
 * platform's sub-agent roster. Resolution mirrors teams.ts:
 * project → user → built-in (assets/agents-src, PP_ASSETS_DIR override).
 * Read-only: unlike teams there is no DB cache — prompts are re-read from
 * disk on every call to honor edits.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_TIER_MODELS, isClaudeTier, type ClaudeTier } from "../config.js";
import { parseFrontmatter, type FlatFrontmatter } from "../util/frontmatter.js";
import { listTeams, getTeam } from "./teams.js";

export const AGENT_CATEGORIES = [
  "engineering", "judge", "executive", "game", "governance", "harness", "other",
] as const;
export type AgentCategory = typeof AGENT_CATEGORIES[number];

export type AgentOrigin = "project" | "user" | "builtin";

export type AgentSummary = {
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
  origin: AgentOrigin;
};

export type AgentDetail = AgentSummary & {
  /** Frontmatter-stripped markdown prompt body. */
  body: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
// @pp/core layout: packages/core/{dist,src}/orchestrator/agents-library.js → 4
// levels up is the workspace root, where the built-in prompts live under
// assets/agents-src. (Same pattern as teams.ts.)
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/** Built-in prompt dir; PP_ASSETS_DIR overrides (mirrors @pp/pilot's loader). */
function builtinAgentsDir(): string {
  return process.env.PP_ASSETS_DIR
    ? join(process.env.PP_ASSETS_DIR, "agents-src")
    : join(REPO_ROOT, "assets", "agents-src");
}

export function agentsDirCandidates(projectPath?: string): Array<{ dir: string; origin: AgentOrigin }> {
  const candidates: Array<{ dir: string; origin: AgentOrigin }> = [];
  if (projectPath) candidates.push({ dir: join(projectPath, ".claude", "agents"), origin: "project" });
  candidates.push({ dir: join(homedir(), ".claude", "agents"), origin: "user" });
  candidates.push({ dir: builtinAgentsDir(), origin: "builtin" });
  return candidates;
}

/**
 * Roles whose name alone doesn't signal the bucket. Checked before the prefix
 * heuristics below so e.g. judge-router lands in "harness" (it routes judges,
 * it doesn't judge) despite the judge- prefix.
 */
const EXPLICIT_CATEGORY: Record<string, AgentCategory> = {
  // Harness plumbing: the /pp:run lifecycle's own bookkeeping roles.
  "triage": "harness",
  "taxonomy-mapper": "harness",
  "profile-loader": "harness",
  "master-plan-patcher": "harness",
  "run-finalizer": "harness",
  "reflexion-coach": "harness",
  "judge-router": "harness",
  "missability-inspector": "harness",
  "agents-md-author": "harness",
  "pair-programmer-orchestrator": "harness",
  // Comparative evaluation (best-of-N + Borda) — a judge without the prefix.
  "oracle-evaluator": "judge",
  // AgentSmith / Matrix governance surface beyond the smith- prefix.
  "sentinel-watcher": "governance",
  "keymaker-router": "governance",
  "neo-generator": "governance",
  "governance-author": "governance",
  "ai-controls-author": "governance",
  // Executive rooms without a c?o / chief- name.
  "boardroom": "executive",
  "crisis-warroom": "executive",
  "mna-cockpit": "executive",
  "capital-allocation": "executive",
  // Game-discipline roles without the game- prefix.
  "economy-designer": "game",
  "encounter-designer": "game",
  "level-designer": "game",
  "narrative-designer": "game",
  "netcode-programmer": "game",
  "tech-animator": "game",
  "technical-artist": "game",
  "live-ops-manager": "game",
};

/** ceo/cfo/cto/caio/chro/ciso/csco/cxo/... — C-suite acronyms. */
const EXECUTIVE_ACRONYM_RE = /^c[a-z]{1,3}o$/;

/** Artifact authors + pipeline specialists dispatched by the team yamls. */
const ENGINEERING_SUFFIX_RE =
  /-(author|designer|modeler|reviewer|strategist|validator|runner|planner|researcher|curator)$/;

export function categorizeAgent(role: string): AgentCategory {
  const explicit = EXPLICIT_CATEGORY[role];
  if (explicit) return explicit;
  if (role.startsWith("judge-")) return "judge";
  if (role.startsWith("game-")) return "game";
  if (role.startsWith("smith-")) return "governance";
  if (role.startsWith("chief-") || EXECUTIVE_ACRONYM_RE.test(role)) return "executive";
  if (role === "engineer" || role === "architect" || role === "designer") return "engineering";
  if (ENGINEERING_SUFFIX_RE.test(role)) return "engineering";
  return "other";
}

/**
 * Frontmatter `model` → tier. Executive prompts pin a tier alias ("opus")
 * while the engineering prompts pin a concrete id ("claude-sonnet-4-6"), so
 * accept both: alias directly, pinned id via reverse CLAUDE_TIER_MODELS lookup.
 */
export function tierForAgentModel(model: string | undefined): ClaudeTier | undefined {
  if (!model) return undefined;
  if (isClaudeTier(model)) return model;
  for (const [tier, id] of Object.entries(CLAUDE_TIER_MODELS)) {
    if (id === model) return tier as ClaudeTier;
  }
  return undefined;
}

/**
 * agent role → team names whose stages dispatch it as a generator. Built by
 * resolving every listed team through getTeam (project → user → built-in) and
 * walking stages[].generator.agent.
 */
export function agentTeamIndex(project_path?: string): Record<string, string[]> {
  const project = project_path ?? process.cwd();
  const index: Record<string, string[]> = {};
  for (const entry of listTeams({ project_path: project })) {
    const resolved = getTeam({ name: entry.name, project_path: project });
    if (!resolved) continue;
    for (const stage of resolved.team.stages ?? []) {
      const agent = stage.generator?.agent;
      if (!agent) continue;
      const teams = (index[agent] ??= []);
      if (!teams.includes(entry.name)) teams.push(entry.name);
    }
  }
  return index;
}

function toSummary(
  id: string,
  origin: AgentOrigin,
  frontmatter: FlatFrontmatter,
  teamIndex: Record<string, string[]>,
): AgentSummary {
  return {
    id,
    name: frontmatter.name || id,
    description: frontmatter.description ?? "",
    category: categorizeAgent(id),
    model: frontmatter.model || undefined,
    tier: tierForAgentModel(frontmatter.model),
    teams: teamIndex[id] ?? [],
    origin,
  };
}

export function listAgents(opts: { project_path?: string } = {}): AgentSummary[] {
  const teamIndex = agentTeamIndex(opts.project_path);
  const seen = new Map<string, AgentSummary>();
  for (const { dir, origin } of agentsDirCandidates(opts.project_path)) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      const id = file.replace(/\.md$/, "");
      if (seen.has(id)) continue;        // first-resolution wins
      try {
        const { frontmatter } = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
        seen.set(id, toSummary(id, origin, frontmatter, teamIndex));
      } catch { /* ignore */ }
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function getAgent(opts: { id: string; project_path?: string }): AgentDetail | null {
  // Ids come off the wire — reject anything that could escape the prompt dirs.
  if (!/^[\w.-]+$/.test(opts.id)) return null;
  for (const { dir, origin } of agentsDirCandidates(opts.project_path)) {
    const path = join(dir, `${opts.id}.md`);
    if (!existsSync(path)) continue;
    try {
      const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));
      const teamIndex = agentTeamIndex(opts.project_path);
      return { ...toSummary(opts.id, origin, frontmatter, teamIndex), body };
    } catch {
      continue;
    }
  }
  return null;
}
