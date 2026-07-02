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
} from "@earendil-works/pi-coding-agent";
import type { Model, Api, ThinkingLevel } from "@earendil-works/pi-ai/compat";
import { buildGenResultFromTotals, type GenResult } from "./envelope.js";
import { buildToolDefinitions, type ToolPolicy } from "./tool-guards.js";
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

export async function runCodingSession(opts: CodingSessionOpts): Promise<GenResult> {
  if (!opts.authStorage || !opts.modelRegistry) {
    throw new Error("runCodingSession requires authStorage + modelRegistry (use engine.runCodingSession to inject them)");
  }
  const agentDir = platformDir();
  const ref = makeSessionRef(opts.sessionDir, opts.role ?? "coder", opts.attempt ?? 0);

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
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.create(opts.cwd, opts.sessionDir, { id: ref.id });

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir,
    authStorage: opts.authStorage,
    modelRegistry: opts.modelRegistry,
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
    noTools: "all",
    customTools: buildToolDefinitions(opts.cwd, opts.toolPolicy),
    resourceLoader,
    sessionManager,
    settingsManager,
  });

  let timedOut = false;
  const unsubscribe = opts.onEvent ? session.subscribe(opts.onEvent) : () => {};

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

  const stop_reason = timedOut ? "timeout" : opts.signal?.aborted ? "aborted" : "stop";

  session.dispose();

  return buildGenResultFromTotals(
    opts.model,
    { tokens_in, tokens_out, cost_usd: stats.cost },
    { text, wall_ms, session_id, session_file, stop_reason },
  );
}
