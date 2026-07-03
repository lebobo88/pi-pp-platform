/**
 * Skill registry. Skills are frontmatter-markdown files that carry reusable
 * domain knowledge (judge policy, artifact conventions, executive frameworks)
 * plus injection metadata describing which generator stages they apply to.
 * Resolution mirrors teams.ts / agents-library.ts:
 * project `.claude/skills` → user `~/.claude/skills` → built-in assets/skills
 * (PP_ASSETS_DIR override), first-resolution wins. Both flat `<id>.md` files
 * AND `<id>/SKILL.md` directories are accepted at every level (Claude Code
 * ships both shapes). Resolved skills are cached in the `skills` SQLite table;
 * `getSkill` always re-reads from disk to honor edits (same as team_get).
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db, txImmediate } from "../db/database.js";
import { parseFrontmatter, type FlatFrontmatter } from "../util/frontmatter.js";

export type SkillOrigin = "project" | "user" | "builtin";

export const SKILL_INJECTIONS = ["generator", "judge", "none"] as const;
export type SkillInjection = typeof SKILL_INJECTIONS[number];

export type SkillSummary = {
  /** Skill slug — the filename without `.md` (or the `<id>/SKILL.md` dirname). */
  id: string;
  /** Frontmatter `name`, falling back to the id. */
  name: string;
  description: string;
  origin: SkillOrigin;
  /** Where the body is injected: generator prompts, judge prompts, or reference-only. */
  injection: SkillInjection;
  /** Empty array = applies everywhere; "*" entries also match everything. */
  applies_to_stages: string[];
  applies_to_agents: string[];
  applies_to_profiles: string[];
  /** Injection order: lower first. Default 50. */
  priority: number;
};

export type SkillSpec = SkillSummary & {
  /** Frontmatter `version`; default 1. */
  version: number;
  /** Injection budget: bodies longer than this are truncated by the injector. Default 6000. */
  max_chars: number;
  applies_to_gate_types: string[];
  /** Frontmatter-stripped markdown body. */
  body: string;
};

export const SKILL_PRIORITY_DEFAULT = 50;
export const SKILL_MAX_CHARS_DEFAULT = 6000;

const __dirname = dirname(fileURLToPath(import.meta.url));
// @pp/core layout: packages/core/{dist,src}/orchestrator/skills.js → 4 levels
// up is the workspace root, where built-in skills live under assets/skills.
// (Same pattern as teams.ts / agents-library.ts.)
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/** Built-in skills dir; PP_ASSETS_DIR overrides (mirrors agents-library.ts). */
function builtinSkillsDir(): string {
  return process.env.PP_ASSETS_DIR
    ? join(process.env.PP_ASSETS_DIR, "skills")
    : join(REPO_ROOT, "assets", "skills");
}

export function skillsDirCandidates(projectPath?: string): Array<{ dir: string; origin: SkillOrigin }> {
  const candidates: Array<{ dir: string; origin: SkillOrigin }> = [];
  if (projectPath) candidates.push({ dir: join(projectPath, ".claude", "skills"), origin: "project" });
  candidates.push({ dir: join(homedir(), ".claude", "skills"), origin: "user" });
  candidates.push({ dir: builtinSkillsDir(), origin: "builtin" });
  return candidates;
}

/** Split a csv frontmatter value ("spec, docs" | "*") into trimmed entries. */
function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseIntOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function parseInjection(value: string | undefined): SkillInjection {
  return (SKILL_INJECTIONS as readonly string[]).includes(value ?? "")
    ? (value as SkillInjection)
    : "none";
}

function toSpec(id: string, origin: SkillOrigin, frontmatter: FlatFrontmatter, body: string): SkillSpec {
  return {
    id,
    name: frontmatter.name || id,
    description: frontmatter.description ?? "",
    origin,
    injection: parseInjection(frontmatter.injection),
    applies_to_stages: parseCsv(frontmatter.applies_to_stages),
    applies_to_agents: parseCsv(frontmatter.applies_to_agents),
    applies_to_profiles: parseCsv(frontmatter.applies_to_profiles),
    applies_to_gate_types: parseCsv(frontmatter.applies_to_gate_types),
    priority: parseIntOr(frontmatter.priority, SKILL_PRIORITY_DEFAULT),
    version: parseIntOr(frontmatter.version, 1),
    max_chars: parseIntOr(frontmatter.max_chars, SKILL_MAX_CHARS_DEFAULT),
    body,
  };
}

function toSummary(spec: SkillSpec): SkillSummary {
  const { id, name, description, origin, injection, applies_to_stages, applies_to_agents, applies_to_profiles, priority } = spec;
  return { id, name, description, origin, injection, applies_to_stages, applies_to_agents, applies_to_profiles, priority };
}

/** `<dir>/<id>.md` (flat) or `<dir>/<id>/SKILL.md` (directory form). */
function skillPathIn(dir: string, id: string): string | null {
  const flat = join(dir, `${id}.md`);
  if (existsSync(flat)) return flat;
  const nested = join(dir, id, "SKILL.md");
  if (existsSync(nested)) return nested;
  return null;
}

export function listSkills(opts: { project_path?: string } = {}): SkillSummary[] {
  const seen = new Map<string, SkillSummary>();
  for (const { dir, origin } of skillsDirCandidates(opts.project_path)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      let id: string;
      let path: string;
      if (entry.endsWith(".md")) {
        id = entry.replace(/\.md$/, "");
        path = join(dir, entry);
      } else {
        // Directory form: <id>/SKILL.md.
        id = entry;
        path = join(dir, entry, "SKILL.md");
        try {
          if (!statSync(join(dir, entry)).isDirectory() || !existsSync(path)) continue;
        } catch { continue; }
      }
      if (seen.has(id)) continue;          // first-resolution wins
      try {
        const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));
        seen.set(id, toSummary(toSpec(id, origin, frontmatter, body)));
      } catch { /* ignore */ }
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function getSkill(opts: { id: string; project_path?: string }): SkillSpec | null {
  // Ids come off the wire — reject anything that could escape the skill dirs.
  if (!/^[\w.-]+$/.test(opts.id)) return null;
  for (const { dir, origin } of skillsDirCandidates(opts.project_path)) {
    const path = skillPathIn(dir, opts.id);
    if (!path) continue;
    try {
      const text = readFileSync(path, "utf8");
      const { frontmatter, body } = parseFrontmatter(text);
      cacheSkillRow(opts.id, origin, text);
      return toSpec(opts.id, origin, frontmatter, body);
    } catch {
      continue;
    }
  }
  return null;
}

/** Empty list = unconstrained; "*" matches everything; else exact membership. */
function appliesTo(list: string[], value: string | undefined): boolean {
  if (list.length === 0 || list.includes("*")) return true;
  return value !== undefined && list.includes(value);
}

/**
 * Pure filter over the registry for a generator stage. `explicit` ids are
 * always included (regardless of injection/scoping — the caller asked for
 * them); otherwise a skill is selected when injection === "generator" AND
 * every non-empty applies_to_* list matches the stage context. Sorted
 * priority asc then id asc so injection order is deterministic.
 */
export function selectSkillsForStage(opts: {
  stage_kind: string;
  agent: string;
  gate_type?: string;
  profile?: string;
  project_path?: string;
  explicit?: string[];
}): SkillSpec[] {
  const picked = new Map<string, SkillSpec>();
  for (const id of opts.explicit ?? []) {
    const skill = getSkill({ id, project_path: opts.project_path });
    if (skill) picked.set(skill.id, skill);
  }
  for (const summary of listSkills({ project_path: opts.project_path })) {
    if (picked.has(summary.id)) continue;
    if (summary.injection !== "generator") continue;
    const skill = getSkill({ id: summary.id, project_path: opts.project_path });
    if (!skill) continue;
    if (!appliesTo(skill.applies_to_stages, opts.stage_kind)) continue;
    if (!appliesTo(skill.applies_to_agents, opts.agent)) continue;
    if (!appliesTo(skill.applies_to_gate_types, opts.gate_type)) continue;
    if (!appliesTo(skill.applies_to_profiles, opts.profile)) continue;
    picked.set(skill.id, skill);
  }
  return [...picked.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function cacheSkillRow(id: string, origin: SkillOrigin, md_text: string): void {
  txImmediate(() => {
    db()
      .prepare(`INSERT OR REPLACE INTO skills(id, origin, md_text, loaded_at) VALUES (?, ?, ?, ?)`)
      .run(id, origin, md_text, new Date().toISOString());
  });
}
