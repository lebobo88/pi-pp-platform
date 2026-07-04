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

/**
 * Which layer of the override chain a role prompt resolved from. There is
 * deliberately NO user (`~/.claude/agents`) layer: unlike skills, role
 * prompts carry no discriminating frontmatter, so any Claude Code user agent
 * sharing a role name (AgentSmith installs engineer.md, architect.md, … at
 * user scope) would silently replace pp's vetted generator prompts.
 */
export type RolePromptOrigin = "project" | "builtin";

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
  /** project `.claude/agents` → builtin agents-src (no user layer). */
  origin: RolePromptOrigin;
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
  // fence matches regardless of how the asset file was saved on disk. Locate
  // the fences with indexOf rather than a backtracking `[\s\S]*?` regex — the
  // latter is O(n^2) on prompts that have no closing fence (some executive
  // agents), which made loading the full library pathologically slow.
  const normalized = md.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: md };
  const close = normalized.indexOf("\n---", 4);
  if (close < 0) return { frontmatter: {}, body: md };
  const yamlBlock = normalized.slice(4, close);
  // Body starts after the closing fence line (skip to the next newline).
  const afterFence = normalized.indexOf("\n", close + 1);
  const body = afterFence < 0 ? "" : normalized.slice(afterFence + 1);
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

/**
 * Load and parse a role prompt through the override chain (first hit wins):
 *
 *   1. `<projectPath>/.claude/agents/<role>.md` — project override (written
 *      by an evolution commit on a `resource:pp.stage-prompt.*` proposal,
 *      or authored by hand)
 *   2. `assets/agents-src/<role>.md`            — repo builtin
 *
 * There is deliberately NO `~/.claude/agents` layer (see RolePromptOrigin):
 * a Claude Code user agent sharing a role name must never replace a vetted
 * generator prompt. Evolution commits write project scope only.
 *
 * Without `opts.projectPath` the project layer is skipped; fixtures with no
 * override files resolve to the builtin exactly as before.
 */
export function loadRolePrompt(role: string, opts: { projectPath?: string } = {}): RolePrompt {
  const candidates: Array<{ path: string; origin: RolePromptOrigin }> = [];
  if (opts.projectPath) {
    candidates.push({ path: join(opts.projectPath, ".claude", "agents", `${role}.md`), origin: "project" });
  }
  candidates.push({ path: join(agentsSrcDir(), `${role}.md`), origin: "builtin" });

  const found = candidates.find((c) => existsSync(c.path));
  if (!found) {
    throw new Error(`prompt loader: no agent prompt for role "${role}" at ${candidates.at(-1)!.path}`);
  }
  const md = readFileSync(found.path, "utf8");
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
    origin: found.origin,
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
  /** Execution mode of the stage — drives the completion output contract below. */
  execution?: ExecutionMode;
  /**
   * Skills selected for this stage (already budgeted/truncated by the caller —
   * see stage-loop's selectStageSkills). Rendered as an "## Applicable skills"
   * section after the profile summary and before gotchas/addenda.
   */
  skills?: Array<{ name: string; body: string }>;
  /**
   * Artifacts from already-PASSED stages (the approved spec, ADRs, …), rendered
   * right after the execution contract so the generator implements what the
   * gate approved instead of re-deriving the request. Bodies are budgeted here
   * (PP_UPSTREAM_BUDGET_CHARS, default 16000 total).
   */
  upstreamArtifacts?: Array<{ kind: string; text: string }>;
  /** The project's AGENTS.md conventions (placeholder sections pre-stripped). */
  agentsMd?: string;
  /** On Reflexion retries: the rejected attempt's artifact, for revision. */
  priorArtifact?: string;
};

/** Default total budget (chars) for upstream artifact bodies in one prompt. */
const UPSTREAM_BUDGET_CHARS_DEFAULT = 16_000;

/**
 * Read `<project>/AGENTS.md` for prompt injection, dropping sections whose
 * body is still the scaffold placeholder. Returns null when the file is
 * missing or nothing substantive remains — the caller then omits the block.
 * This restores the original pair-programmer contract where every generator
 * read AGENTS.md first ("Conventions in AGENTS.md beat your priors").
 */
export function loadAgentsMdForPrompt(projectPath: string): string | null {
  const path = join(projectPath, "AGENTS.md");
  if (!existsSync(path)) return null;
  const md = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const lines = md.split("\n");
  const kept: string[] = [];
  let section: string[] = [];
  let substantive = false;
  const flush = () => {
    if (section.length === 0) return;
    const body = section.slice(1).join("\n").trim();
    const isPlaceholder = body === "" || /^_?to be populated_?\.?$/i.test(body);
    if (!isPlaceholder) {
      kept.push(...section);
      // Only a filled ## section counts as substance — the # title/preamble
      // alone is generic scaffold text not worth a prompt block.
      if (/^##\s/.test(section[0] ?? "")) substantive = true;
    }
    section = [];
  };
  for (const line of lines) {
    if (/^##\s/.test(line)) flush();
    section.push(line);
  }
  flush();
  if (!substantive) return null;
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out.length > 0 ? out : null;
}

/**
 * Completion mode has NO tools and NO file access — the model's entire response
 * IS the artifact. Agentic models (deepseek/codex-style) otherwise narrate "let
 * me read the files…" or emit tool calls, which fail every artifact gate. This
 * directive makes them produce the document directly.
 */
const COMPLETION_CONTRACT =
  "## Output contract (READ FIRST)\n\n" +
  "You are running in COMPLETION mode: you have NO tools, NO file access, and NO " +
  "further turns. Your ENTIRE response IS the deliverable artifact. Do NOT narrate " +
  "steps, do NOT say you will read files or explore the codebase, do NOT ask " +
  "questions, and do NOT emit tool calls or code-fenced tool syntax. Output ONLY " +
  "the complete, final artifact in the required format — nothing before or after it. " +
  "Any preamble or process note will FAIL the review gate.";

/**
 * Coding sessions: some models answer with code in a markdown block or ask
 * clarifying questions instead of calling the file tools — which writes nothing
 * to disk, so the gate sees no diff and fails. This contract forces real tool use.
 */
const SESSION_CODING_CONTRACT =
  "## Execution contract (READ FIRST)\n\n" +
  "You have file-editing tools (write/edit/bash) and a real working directory. You " +
  "MUST USE THE TOOLS to create and modify files — the harness only captures changes " +
  "you actually write to disk and commit; code shown only in a chat/markdown reply is " +
  "IGNORED and FAILS the gate. Do NOT answer with a code block instead of editing, do " +
  "NOT ask clarifying questions, and do NOT offer options — make reasonable assumptions " +
  "(pick a sensible language/file path if unspecified) and implement the change directly, " +
  "then verify your files are written before finishing.";

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
  const execution = ctx.execution ?? role.execution;
  const blocks: string[] = [];
  // Lead with the execution contract so weaker agentic models produce the
  // artifact directly (completion) or actually call the file tools (coding).
  if (execution === "completion") blocks.push(COMPLETION_CONTRACT);
  else if (execution === "session-coding") blocks.push(SESSION_CODING_CONTRACT);

  // Approved upstream artifacts come BEFORE the role body: the spec the gate
  // passed is the ground truth this stage implements. Budgeted so a huge
  // upstream diff can't starve the rest of the prompt.
  if (ctx.upstreamArtifacts && ctx.upstreamArtifacts.length > 0) {
    const raw = Number(process.env.PP_UPSTREAM_BUDGET_CHARS);
    let remaining = Number.isFinite(raw) && raw >= 0 ? raw : UPSTREAM_BUDGET_CHARS_DEFAULT;
    const parts: string[] = [];
    for (const a of ctx.upstreamArtifacts) {
      if (remaining <= 0) break;
      const body = a.text.length > remaining ? `${a.text.slice(0, remaining)}\n\n[truncated]` : a.text;
      remaining -= Math.min(a.text.length, remaining);
      parts.push(`### Approved ${a.kind} artifact\n\n${body.trim()}`);
    }
    blocks.push(
      "## Approved upstream artifacts (implement THIS)\n\n" +
        "Earlier pipeline stages produced these and they PASSED review. They are the authoritative " +
        "definition of the work — implement them; do not re-interpret the raw request.\n\n" +
        parts.join("\n\n"),
    );
  }

  blocks.push(role.cleanedBody.trim());

  if (ctx.profileSummary) {
    blocks.push(`## Active project profile\n\n${ctx.profileSummary.trim()}`);
  }

  if (ctx.agentsMd) {
    blocks.push(
      "## Project conventions (AGENTS.md — these beat your priors)\n\n" + ctx.agentsMd.trim(),
    );
  }

  if (ctx.skills && ctx.skills.length > 0) {
    // Skill bodies were written for Claude Code — run them through the same
    // procedure-stripping pass as the agent prompt bodies.
    const joined = ctx.skills
      .map((s) => `### Skill: ${s.name}\n\n${cleanClaudeCodeProcedure(s.body).trim()}`)
      .join("\n\n");
    blocks.push(`## Applicable skills\n\n${joined}`);
  }

  const addendum = loadPromptAddendum(role.role, ctx.profileName);
  if (addendum) blocks.push(`## Engine-specific guidance\n\n${addendum.trim()}`);

  const gotchas = loadGotchasForProfile(ctx.profileName);
  if (gotchas) blocks.push(`## Engine gotchas\n\n${gotchas.trim()}`);

  if (ctx.priorArtifact) {
    const cap = 12_000;
    const body =
      ctx.priorArtifact.length > cap ? `${ctx.priorArtifact.slice(0, cap)}\n\n[truncated]` : ctx.priorArtifact;
    blocks.push(
      "## Your previous attempt (rejected — revise, do not restart)\n\n" + body.trim(),
    );
  }

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
