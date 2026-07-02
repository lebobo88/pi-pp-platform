/**
 * Role-prompt loader.
 *
 * Loads an agent prompt from assets/agents-src/<role>.md, parses its YAML
 * frontmatter (name, description, model, tools), derives the Claude tier from
 * the pinned model id, classifies the role's execution mode, and renders a
 * clean system prompt for the pi runtime.
 *
 * The source prompts were written for Claude Code: they instruct the agent to
 * call `mcp__pp_harness__*` / `mcp__pp_codex__*` tools and to be dispatched via
 * the Task tool. In the in-process pilot the DRIVER does that bookkeeping, so
 * those procedure fragments are stripped before the body becomes a pi system
 * prompt — otherwise the model would try to call tools it doesn't have.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CLAUDE_TIER_MODELS, type ClaudeTier } from "@pp/core";

export type ExecutionMode = "session-coding" | "session-readonly" | "completion";

/** Roles that author code directly in a worktree → guarded coding session. */
export const CODING_ROLES = new Set<string>([
  "engineer",
  "test-strategist",
  "neo-generator",
  "browser-validator",
  "visual-regression-runner",
]);

/** Roles that need repo read access but must not mutate → readonly session. */
export const READONLY_ROLES = new Set<string>([
  "architect",
  "api-designer",
  "data-modeler",
  "security-reviewer",
  "missability-inspector",
  "taxonomy-mapper",
  "profile-loader",
  "discovery-researcher",
  "designer",
  "design-system-curator",
]);

export function classifyExecution(role: string): ExecutionMode {
  if (CODING_ROLES.has(role)) return "session-coding";
  if (READONLY_ROLES.has(role)) return "session-readonly";
  return "completion";
}

export type RoleFrontmatter = {
  name?: string;
  description?: string;
  model?: string;
  tools?: string;
};

export type RolePrompt = {
  role: string;
  name: string;
  description: string;
  model?: string;
  /** Derived from `model` via reverse CLAUDE_TIER_MODELS lookup. */
  tier?: ClaudeTier;
  tools: string[];
  execution: ExecutionMode;
  /** The prompt body with Claude-Code-specific procedure stripped. */
  cleanedBody: string;
};

/** Reverse lookup: pinned model id → tier. */
export function tierForModel(model: string | undefined): ClaudeTier | undefined {
  if (!model) return undefined;
  for (const [tier, id] of Object.entries(CLAUDE_TIER_MODELS)) {
    if (id === model) return tier as ClaudeTier;
  }
  return undefined;
}

/** Parse `--- yaml --- body`. Returns empty frontmatter when absent. */
export function parseFrontmatter(md: string): { frontmatter: RoleFrontmatter; body: string } {
  // Normalize a possible UTF-8 BOM and CRLF line endings so the frontmatter
  // fence matches regardless of how the asset file was saved on disk.
  const normalized = md.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(normalized);
  if (!m) return { frontmatter: {}, body: md };
  const yamlBlock = m[1]!;
  const body = m[2] ?? "";
  const frontmatter: RoleFrontmatter = {};
  // The agent frontmatter is deliberately flat (name/description/model/tools),
  // so a line-based parse avoids pulling a YAML dependency into a hot path and
  // sidesteps multi-line description quoting quirks.
  for (const line of yamlBlock.split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.trim();
    if (key === "name" || key === "description" || key === "model" || key === "tools") {
      frontmatter[key] = value;
    }
  }
  return { frontmatter, body };
}

/**
 * Strip Claude-Code-specific procedure so the body can serve as a pi system
 * prompt. Two passes:
 *   1. Drop whole `##`/`###` sections whose heading marks a Claude-Code path
 *      (Path B/C, DEPRECATED, external-CLI dispatch).
 *   2. Drop individual lines that instruct calls to mcp__pp_* tools or the
 *      Task tool — the pilot performs that bookkeeping itself.
 */
export function cleanClaudeCodeProcedure(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];

  const headingDropRe =
    /^#{2,4}\s+.*\b(path\s+b|path\s+c|paths?\s+b\s*\/?\s*c|deprecated|codex\/gemini dispatch|external[- ]cli)\b/i;
  const headingRe = /^#{1,6}\s+/;
  const lineDropRe =
    /(mcp__pp_harness__|mcp__pp_codex__|mcp__pp_gemini__|\bTask\s*\(|\bTask[- ]invoke\b|the\s+Task\s+tool)/i;

  let dropSection = false;
  let dropHeadingLevel = 0;
  for (const line of lines) {
    if (headingRe.test(line)) {
      const level = (/^(#{1,6})/.exec(line)?.[1] ?? "#").length;
      if (dropSection && level <= dropHeadingLevel) {
        // A sibling/parent heading ends the dropped section.
        dropSection = false;
      }
      if (!dropSection && headingDropRe.test(line)) {
        dropSection = true;
        dropHeadingLevel = level;
        continue;
      }
    }
    if (dropSection) continue;
    if (lineDropRe.test(line)) continue;
    out.push(line);
  }

  // Collapse the runs of blank lines the removals leave behind.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

let _repoRoot: string | null = null;

/** Walk up from this module until pnpm-workspace.yaml is found. */
export function repoRoot(): string {
  if (_repoRoot) return _repoRoot;
  const override = process.env.PP_REPO_ROOT;
  if (override && existsSync(join(override, "pnpm-workspace.yaml"))) {
    _repoRoot = override;
    return override;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      _repoRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("prompt loader: could not locate repo root (pnpm-workspace.yaml)");
}

export function agentsSrcDir(): string {
  return process.env.PP_ASSETS_DIR
    ? join(process.env.PP_ASSETS_DIR, "agents-src")
    : join(repoRoot(), "assets", "agents-src");
}

function assetsDir(...parts: string[]): string {
  const base = process.env.PP_ASSETS_DIR ?? join(repoRoot(), "assets");
  return join(base, ...parts);
}

/** Load and parse a role prompt from assets/agents-src/<role>.md. */
export function loadRolePrompt(role: string): RolePrompt {
  const path = join(agentsSrcDir(), `${role}.md`);
  if (!existsSync(path)) {
    throw new Error(`prompt loader: no agent prompt for role "${role}" at ${path}`);
  }
  const md = readFileSync(path, "utf8");
  const { frontmatter, body } = parseFrontmatter(md);
  const tools = (frontmatter.tools ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    role,
    name: frontmatter.name ?? role,
    description: frontmatter.description ?? "",
    model: frontmatter.model,
    tier: tierForModel(frontmatter.model),
    tools,
    execution: classifyExecution(role),
    cleanedBody: cleanClaudeCodeProcedure(body),
  };
}

export type RenderContext = {
  /** Human-readable profile summary block. */
  profileSummary?: string;
  /** Prior critiques to fold back into the prompt (cross-run reflexion). */
  priorCritiques?: string[];
  /** Active profile name — selects a gotcha pack for game-dev profiles. */
  profileName?: string;
  /** The user request text, appended so the agent sees the ask. */
  requestText?: string;
};

/** Load the game engine gotcha pack for a game-dev-* profile, if present. */
export function loadGotchasForProfile(profileName?: string): string | null {
  if (!profileName || !profileName.startsWith("game-dev")) return null;
  const engine = profileName.replace(/^game-dev-?/, "") || "custom";
  const candidates: Record<string, string> = {
    unity: "unity.md",
    unreal: "unreal-5.md",
    godot: "godot-4.md",
    web: "web-engines.md",
    custom: "custom.md",
    "": "custom.md",
  };
  const file = candidates[engine] ?? "custom.md";
  const path = assetsDir("gotchas", file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Load a game prompt-addendum for a role, if one exists. */
export function loadPromptAddendum(role: string, profileName?: string): string | null {
  if (!profileName || !profileName.startsWith("game-dev")) return null;
  const path = assetsDir("prompt-addenda", `${role}-game.md`);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * Render the final system prompt: the cleaned body plus injected context
 * blocks (profile summary, prior critiques, game gotchas + addenda). The user
 * request itself is passed as the pi task/user prompt, not folded in here.
 */
export function renderSystemPrompt(role: RolePrompt, ctx: RenderContext = {}): string {
  const blocks: string[] = [role.cleanedBody.trim()];

  if (ctx.profileSummary) {
    blocks.push(`## Active project profile\n\n${ctx.profileSummary.trim()}`);
  }

  const addendum = loadPromptAddendum(role.role, ctx.profileName);
  if (addendum) blocks.push(`## Engine-specific guidance\n\n${addendum.trim()}`);

  const gotchas = loadGotchasForProfile(ctx.profileName);
  if (gotchas) blocks.push(`## Engine gotchas\n\n${gotchas.trim()}`);

  if (ctx.priorCritiques && ctx.priorCritiques.length > 0) {
    const joined = ctx.priorCritiques.map((c, i) => `### Prior critique ${i + 1}\n\n${c.trim()}`).join("\n\n");
    blocks.push(`## Prior critiques (learn from these)\n\n${joined}`);
  }

  return blocks.join("\n\n") + "\n";
}

/** List every role that has a prompt file — used by /pp:doctor-style checks. */
export function listRolePrompts(): string[] {
  const dir = agentsSrcDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}
