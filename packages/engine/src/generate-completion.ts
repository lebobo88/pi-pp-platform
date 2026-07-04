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

/**
 * Output budget for authoring completions. Without an explicit max_tokens the
 * provider default applies (deepseek: ~4k), which TRUNCATES long artifacts —
 * a full RFC-2119 PRD runs 8-16k tokens, and a `stop_reason: "length"` spec
 * gets judged as incomplete. Capped by the model's own maxTokens.
 */
function authoringMaxTokens(model: Model<Api>): number {
  const raw = Number(process.env.PP_AUTHORING_MAX_TOKENS);
  // 64k default: reasoning models (deepseek) burn thinking tokens INSIDE the
  // output budget, so a 16k-token PRD can need 2-3× that in max_tokens.
  const requested = Number.isFinite(raw) && raw > 0 ? raw : 65_536;
  const modelCap = (model as { maxTokens?: number }).maxTokens;
  return modelCap && modelCap > 0 ? Math.min(requested, modelCap) : requested;
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
    maxTokens: authoringMaxTokens(opts.model),
  });
  return buildGenResult(msg, opts.model, {
    wall_ms: Date.now() - t0,
    session_id: null,
  });
}
