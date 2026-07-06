/**
 * runCodingSession() — a multi-turn agentic coding session over pi's
 * createAgentSession, replacing the codex/gemini "coding" bridge.
 *
 * System-prompt injection: we build a DefaultResourceLoader with an explicit
 * `systemPrompt` and all project discovery disabled (noExtensions/noSkills/
 * noContextFiles/...). This is the cleanest mechanism the 0.80.3 SDK offers —
 * `systemPrompt` overrides SYSTEM.md discovery in-memory, so we neither write a
 * `.pi/SYSTEM.md` into the worktree nor pollute the candidate tree, and there
 * is nothing to clean up afterwards.
 *
 * Tools: `noTools: "all"` disables the built-ins; our guarded ToolDefinitions
 * (see tool-guards.ts) are the SOLE tool surface. `readonly` policy exposes only
 * read/grep/find/ls.
 *
 * Tool forcing: openai-compat models (deepseek especially) sometimes answer a
 * coding prompt with prose instead of tool calls — the session then ends after
 * one turn having written nothing. For `coding` sessions on openai-compat APIs
 * an inline extension injects `tool_choice: "required"` into each provider
 * request until the first successful mutating tool call, we issue one
 * in-session recovery prompt if a whole prompt() pass drove zero mutating
 * calls, and as a last resort the text-materializer fallback parses
 * ```lang:path fenced blocks out of the final text (PP_TEXT_MATERIALIZE_FALLBACK).
 * A coding session that still changed nothing returns stop_reason
 * "no_tool_calls" so the pilot can skip judging and retry/surface cleanly.
 *
 * Completion: we await session.prompt() (which drives the full agent loop) and
 * also observe `agent_end` for the terminal turn. Usage is aggregated across
 * every assistant turn via getSessionStats().
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AuthStorage,
  type ModelRegistry,
  type AgentSessionEvent,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api, ThinkingLevel } from "@earendil-works/pi-ai/compat";
import { buildGenResultFromTotals, type GenResult } from "./envelope.js";
import { buildToolDefinitions, type ToolPolicy } from "./tool-guards.js";
import {
  extractFileBlocks,
  materializeFiles,
  textMaterializeFallbackEnabled,
} from "./text-materializer.js";
import { makeSessionRef } from "./session-store.js";
import { platformDir } from "./auth.js";

export interface CodingSessionOpts {
  cwd: string;
  systemPrompt: string;
  taskPrompt: string;
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentSessionEvent) => void;
  /**
   * Convenience stream of incremental assistant text as the model generates it.
   * Fired for each streamed text delta so callers (the pilot) can surface live
   * output WITHOUT knowing pi's event union — see extractAssistantTextDelta,
   * which degrades to silence rather than guessing field names if pi's shape
   * changes. Independent of `onEvent`, which still receives the raw events.
   */
  onOutputDelta?: (chunk: string) => void;
  /** Directory that holds the session's <role>-<attempt>.jsonl file. */
  sessionDir: string;
  toolPolicy: ToolPolicy;
  /** Role/attempt used to name the session file. Default: "coder" / 0. */
  role?: string;
  attempt?: number;
  /** Credential + model resolution (injected by createEngine when omitted). */
  authStorage?: AuthStorage;
  modelRegistry?: ModelRegistry;
}

/** Tool names whose successful execution means the working tree may have changed. */
const MUTATING_TOOLS = new Set(["bash", "write", "edit"]);

/**
 * Pull an assistant text delta out of a streaming session event WITHOUT
 * hard-coding pi's event union: we read through `unknown` and degrade to a
 * no-op (undefined) whenever the shape isn't the text delta we expect. pi
 * emits incremental assistant text as `message_update` events whose
 * `assistantMessageEvent` is a `text_delta`; the readable text lives on
 * `.delta` (falling back to `.text`). If a future pi renames these fields the
 * live stream simply goes quiet rather than throwing or emitting garbage — the
 * persisted artifact/diff is unaffected either way.
 */
function extractAssistantTextDelta(event: AgentSessionEvent): string | undefined {
  const e = event as unknown as { type?: string; assistantMessageEvent?: unknown };
  if (e.type !== "message_update") return undefined;
  const ame = e.assistantMessageEvent as
    | { type?: string; delta?: unknown; text?: unknown }
    | null
    | undefined;
  if (!ame || ame.type !== "text_delta") return undefined;
  const delta =
    typeof ame.delta === "string" ? ame.delta : typeof ame.text === "string" ? ame.text : undefined;
  return delta && delta.length > 0 ? delta : undefined;
}

/**
 * Tools that directly write files. `bash` stays in MUTATING_TOOLS (a session
 * can legitimately produce its changes via shell), but a bash-only session
 * that merely ran tests must not report files_changed — that flag previously
 * lied whenever a session ran a single command.
 */
const FILE_WRITING_TOOLS = new Set(["write", "edit"]);

/**
 * openai-compat APIs where (a) `tool_choice` is honored in the request payload
 * and (b) models are known to sometimes answer coding prompts as prose instead
 * of tool calls. Anthropic sessions are left untouched — their loop already
 * drives tools reliably and `tool_choice: required` changes Claude semantics.
 */
function isOpenAiCompatApi(api: string): boolean {
  return api === "openai-completions" || api === "openai-responses";
}

/**
 * Default thinking level for openai-compat coding sessions. deepseek's
 * reasoning mode ("high") is known to drop function calling; "low" maps to
 * null in its thinkingLevelMap, i.e. plain chat mode where tools work.
 * Override with PP_CODING_THINKING_LEVEL.
 */
function codingThinkingLevel(model: Model<Api>, explicit?: ThinkingLevel): ThinkingLevel | undefined {
  if (explicit) return explicit;
  if (!isOpenAiCompatApi(model.api)) return undefined;
  const raw = process.env.PP_CODING_THINKING_LEVEL;
  if (raw === "off") return undefined;
  const allowed: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];
  if (raw && (allowed as string[]).includes(raw)) return raw as ThinkingLevel;
  return "low";
}

const RECOVERY_PROMPT =
  "Your previous reply contained NO tool calls, so nothing was written to disk and it will be " +
  "discarded. Do it again now using ONLY the provided tools: call write/edit to create every file " +
  "and bash to run commands. Do not describe the files or paste them as code blocks — emit tool calls.";

export async function runCodingSession(opts: CodingSessionOpts): Promise<GenResult> {
  if (!opts.authStorage || !opts.modelRegistry) {
    throw new Error("runCodingSession requires authStorage + modelRegistry (use engine.runCodingSession to inject them)");
  }
  const agentDir = platformDir();
  const ref = makeSessionRef(opts.sessionDir, opts.role ?? "coder", opts.attempt ?? 0);

  // ── tool-forcing extension + tool-call accounting ─────────────────────────
  // deepseek (and some other openai-compat models) answer coding prompts as
  // prose unless tool_choice forces the issue. The extension injects
  // `tool_choice: "required"` into every outgoing request until the first
  // successful mutating tool call, then reverts to "auto" so the model can
  // produce its final text turn.
  let toolCallCount = 0;
  let mutatingToolCalls = 0;
  // Forcing `tool_choice: "required"` predates the tools-allowlist fix above —
  // it papered over sessions that had NO tools attached at all. With tools
  // actually advertised, mainstream models call them unprompted, and several
  // providers hard-400 on required tool_choice in thinking mode (deepseek v4:
  // "Thinking mode does not support this tool_choice"). Opt back in with
  // PP_FORCE_TOOL_CHOICE=1 if a prose-preferring model needs it.
  const forceToolChoice =
    process.env.PP_FORCE_TOOL_CHOICE === "1" &&
    opts.toolPolicy === "coding" &&
    isOpenAiCompatApi(opts.model.api);
  const toolForcingExtension: ExtensionFactory = (pi) => {
    pi.on("before_provider_request", (event) => {
      if (!forceToolChoice || mutatingToolCalls > 0) return undefined;
      const payload = event.payload as Record<string, unknown> | null;
      if (!payload || typeof payload !== "object") return undefined;
      const tools = (payload as { tools?: unknown[] }).tools;
      if (!Array.isArray(tools) || tools.length === 0) return undefined;
      return { ...payload, tool_choice: "required" };
    });
  };

  let fileWritingCalls = 0;
  const trackToolEvents = (event: AgentSessionEvent): void => {
    if (event.type === "tool_execution_start") toolCallCount++;
    if (event.type === "tool_execution_end" && !event.isError) {
      if (MUTATING_TOOLS.has(event.toolName)) mutatingToolCalls++;
      if (FILE_WRITING_TOOLS.has(event.toolName)) fileWritingCalls++;
    }
    if (opts.onOutputDelta) {
      const delta = extractAssistantTextDelta(event);
      if (delta) opts.onOutputDelta(delta);
    }
    opts.onEvent?.(event);
  };

  const settingsManager = SettingsManager.create(opts.cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir,
    settingsManager,
    systemPrompt: opts.systemPrompt,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [toolForcingExtension],
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.create(opts.cwd, opts.sessionDir, { id: ref.id });

  // 0.80.3: `noTools: "all"` sets the session's allowed-tool set to EMPTY, and
  // that filter is applied to customTools too — sessions silently ran with no
  // tools at all (models then hallucinate tool syntax as text). Naming our
  // guarded tools in `tools` re-admits exactly them and nothing else.
  const customTools = buildToolDefinitions(opts.cwd, opts.toolPolicy);

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir,
    authStorage: opts.authStorage,
    modelRegistry: opts.modelRegistry,
    model: opts.model,
    thinkingLevel: codingThinkingLevel(opts.model, opts.thinkingLevel),
    noTools: "all",
    tools: customTools.map((t) => t.name),
    customTools,
    resourceLoader,
    sessionManager,
    settingsManager,
  });

  let timedOut = false;
  const unsubscribe = session.subscribe(trackToolEvents);

  const timer =
    opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          void session.abort();
        }, opts.timeoutMs)
      : undefined;

  const onExternalAbort = () => void session.abort();
  if (opts.signal) {
    if (opts.signal.aborted) void session.abort();
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const t0 = Date.now();
  try {
    await session.prompt(opts.taskPrompt);
    // One in-session recovery: a coding session that drove zero mutating tool
    // calls wrote nothing to disk — tell the model plainly and let it try once
    // more with full context. Intra-attempt, so Reflexion ×1 is untouched.
    if (
      opts.toolPolicy === "coding" &&
      mutatingToolCalls === 0 &&
      !timedOut &&
      !opts.signal?.aborted
    ) {
      await session.prompt(RECOVERY_PROMPT);
    }
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
    unsubscribe();
  }
  const wall_ms = Date.now() - t0;

  const stats = session.getSessionStats();
  const tokens_in = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite;
  const tokens_out = stats.tokens.output;
  const text = session.getLastAssistantText() ?? "";
  const session_file = session.sessionFile ?? ref.path;
  const session_id = session.sessionId;

  session.dispose();

  // Last resort: the model narrated the change set as ```lang:path fenced
  // blocks instead of calling tools. Materialize them through the same
  // write-tool guards so the attempt still yields a judgeable diff.
  let materialized_files = 0;
  if (
    opts.toolPolicy === "coding" &&
    mutatingToolCalls === 0 &&
    !timedOut &&
    !opts.signal?.aborted &&
    textMaterializeFallbackEnabled()
  ) {
    const blocks = extractFileBlocks(text);
    if (blocks.length > 0) {
      materialized_files = materializeFiles(opts.cwd, blocks).written.length;
    }
  }

  // files_changed reports actual file writes (write/edit tools or the
  // materializer). The looser mutatingToolCalls (bash included) still governs
  // the recovery prompt and the no_tool_calls stop reason — a session that
  // produced its change purely via bash is not a "no tool calls" session.
  const files_changed = fileWritingCalls > 0 || materialized_files > 0;
  const stop_reason = timedOut
    ? "timeout"
    : opts.signal?.aborted
      ? "aborted"
      : opts.toolPolicy === "coding" && mutatingToolCalls === 0 && materialized_files === 0
        ? "no_tool_calls"
        : "stop";

  return buildGenResultFromTotals(
    opts.model,
    { tokens_in, tokens_out, cost_usd: stats.cost },
    {
      text,
      wall_ms,
      session_id,
      session_file,
      stop_reason,
      tool_call_count: toolCallCount,
      files_changed,
      materialized_files,
    },
  );
}
