/**
 * runAuthoringCompletion() — a single LLM completion.
 *
 * The engine returns text + usage; the caller is responsible for writing any
 * artifacts. This is the pi analogue of the codex/gemini "generate" bridge for
 * non-coding-session authoring (specs, ADRs, docs, rubrics, ...).
 */
import type { Model, Api, ThinkingLevel } from "@earendil-works/pi-ai/compat";
import { buildGenResult, type GenResult } from "./envelope.js";
import { defaultComplete, type LlmComplete } from "./llm.js";

export interface AuthoringCompletionOpts {
  model: Model<Api>;
  systemPrompt: string;
  userPrompt: string;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  thinkingLevel?: ThinkingLevel;
  /** Injected completion fn (defaults to the production pi-ai path). */
  complete?: LlmComplete;
}

export async function runAuthoringCompletion(opts: AuthoringCompletionOpts): Promise<GenResult> {
  const complete = opts.complete ?? defaultComplete;
  const t0 = Date.now();
  const msg = await complete({
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    apiKey: opts.apiKey,
    headers: opts.headers,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    reasoning: opts.thinkingLevel,
  });
  return buildGenResult(msg, opts.model, {
    wall_ms: Date.now() - t0,
    session_id: null,
  });
}
