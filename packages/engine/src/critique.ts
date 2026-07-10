/**
 * critique() — LLM-as-judge, reproducing the pair-programmer critique bridge
 * behavior on top of the pi runtime.
 *
 * - impartial-judge system prompt, JSON-only output,
 * - artifact wrapped in @pp/core's untrusted envelope,
 * - schema text from @pp/core buildCritiqueOutputSchema(),
 * - JSON extraction + validateCritiqueResult from @pp/core,
 * - retry ONCE on invalid output, appending the validation failure,
 * - archive failures to <cwd>/.harness/critique_failures/<provider>_<ms>.txt.
 *
 * The LLM call is injectable (`complete`) so the parse/retry logic can be
 * exercised against canned malformed→valid sequences without any network.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Model, Api } from "@earendil-works/pi-ai/compat";
import {
  wrapUntrusted,
  buildCritiqueOutputSchema,
  validateCritiqueResult,
} from "@pp/core";
import {
  buildGenResult,
  messageText,
  toGenProvider,
  classifyProviderError,
  assistantErrorMessage,
  type GenResult,
} from "./envelope.js";
import { defaultComplete, type LlmComplete } from "./llm.js";

const JUDGE_SYSTEM_PROMPT =
  "You are an impartial code/spec/design judge. Apply the provided rubric to the " +
  "artifact under review. Return ONLY a single JSON object with fields: " +
  'outcome ("pass" | "fail" | "revise"), critique_md (markdown string), and ' +
  "score_entries (an array of { dimension, score } entries where score is a " +
  "number in [0,1]). Do not wrap the JSON in prose or code fences.";

export interface CritiqueOpts {
  judgeModel: Model<Api>;
  rubricMd: string;
  artifactText: string;
  contextMd?: string;
  /** JSON Schema object describing the expected verdict. Defaults to the core schema. */
  outputSchema?: Record<string, unknown>;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Working directory used to locate the failure archive. Defaults to process.cwd(). */
  cwd?: string;
  /** Injected completion fn (defaults to the production pi-ai path). */
  complete?: LlmComplete;
}

/** Number of extra attempts after the first on invalid output (mirrors CRITIQUE_RETRY_ATTEMPTS=1). */
const CRITIQUE_RETRY_ATTEMPTS = 1;

/** Default wall-clock cap for a single judge call — withTimeout never armed
 * before (llm.ts:60 only starts the timer when timeoutMs is set), so a hung
 * provider could stall a stage indefinitely. Override with PP_CRITIQUE_TIMEOUT_MS. */
const CRITIQUE_TIMEOUT_MS_DEFAULT = 300_000;

/**
 * Output-token budget for a critique. A judge verdict is small, but reasoning
 * models burn thinking tokens INSIDE the output budget, so without an explicit
 * cap a low provider default can truncate the JSON and read as invalid output.
 * Env PP_CRITIQUE_MAX_TOKENS (default 32k), capped by the model's own maxTokens.
 */
function critiqueMaxTokens(model: Model<Api>): number {
  const raw = Number(process.env.PP_CRITIQUE_MAX_TOKENS);
  const requested = Number.isFinite(raw) && raw > 0 ? raw : 32_768;
  const cap = (model as { maxTokens?: number }).maxTokens;
  return cap && cap > 0 ? Math.min(requested, cap) : requested;
}

/** Explicit timeout wins; else env; else the 5-minute default. */
function critiqueTimeoutMs(explicit?: number): number {
  if (explicit && explicit > 0) return explicit;
  const raw = Number(process.env.PP_CRITIQUE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : CRITIQUE_TIMEOUT_MS_DEFAULT;
}

export async function critique(opts: CritiqueOpts): Promise<GenResult> {
  const complete = opts.complete ?? defaultComplete;
  const cwd = opts.cwd ?? process.cwd();
  const provider = toGenProvider(opts.judgeModel.provider);
  const schema = opts.outputSchema ?? buildCritiqueOutputSchema();
  const wrappedArtifact = wrapUntrusted("artifact-under-review", opts.artifactText);

  const basePrompt =
    `## Rubric\n${opts.rubricMd}\n\n` +
    (opts.contextMd ? `## Context\n${opts.contextMd}\n\n` : "") +
    `## Expected JSON schema\n${JSON.stringify(schema, null, 2)}\n\n` +
    `## Artifact\n${wrappedArtifact}\n`;

  let userPrompt = basePrompt;
  let lastReason = "malformed JSON";
  let lastText = "";
  let wall_ms = 0;
  const totalAttempts = 1 + CRITIQUE_RETRY_ATTEMPTS;
  const maxTokens = critiqueMaxTokens(opts.judgeModel);
  const timeoutMs = critiqueTimeoutMs(opts.timeoutMs);

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const t0 = Date.now();
    const msg = await complete({
      model: opts.judgeModel,
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      userPrompt,
      apiKey: opts.apiKey,
      headers: opts.headers,
      signal: opts.signal,
      timeoutMs,
      maxTokens,
      reasoning: "high",
    });
    wall_ms += Date.now() - t0;

    // Provider error (quota / rate limit / other): pi resolves the completion
    // with stopReason:"error" and stashes the real cause in errorMessage. There
    // is no malformed JSON to fix by retrying — short-circuit immediately, and
    // archive the REAL provider cause (not "empty output"). Return a
    // distinguishable `provider_error` stop reason so the caller can fail over
    // to another provider instead of treating it as a genuine invalid verdict.
    if (msg.stopReason === "error") {
      const errorMessage =
        assistantErrorMessage(msg) ?? "provider resolved stopReason=error with no message";
      const errorClass = classifyProviderError(errorMessage);
      const archivePath = archiveCritiqueFailure({
        cwd,
        provider,
        model: opts.judgeModel.id,
        duration_ms: wall_ms,
        attempts: attempt + 1,
        error: `provider_error (${errorClass}): ${errorMessage}`,
        stdout: errorMessage,
      });
      return {
        text: messageText(msg),
        parsed: undefined,
        tokens_in: msg.usage.input + msg.usage.cacheRead + msg.usage.cacheWrite,
        tokens_out: msg.usage.output,
        cost_usd: msg.usage.cost?.total ?? 0,
        model: opts.judgeModel.id,
        provider,
        wall_ms,
        session_id: null,
        stop_reason: "provider_error",
        session_file: archivePath,
        error_class: errorClass,
        error_message: errorMessage,
      };
    }

    const text = messageText(msg);
    lastText = text;

    const validated = validateCritiqueResult({ text });
    if (validated.ok) {
      return buildGenResult(msg, opts.judgeModel, {
        wall_ms,
        session_id: null,
        parsed: validated.verdict,
        text: JSON.stringify(validated.verdict, null, 2),
      });
    }

    lastReason = validated.reason;
    // Append the validation failure to the prompt for the retry.
    userPrompt =
      `${basePrompt}\n## Your previous response was INVALID\n` +
      `Reason: ${validated.reason}.\n` +
      `Return ONLY the JSON object matching the schema above — no prose, no code fences.`;
  }

  // All attempts failed validation — archive context and return an invalid-output result.
  const archivePath = archiveCritiqueFailure({
    cwd,
    provider,
    model: opts.judgeModel.id,
    duration_ms: wall_ms,
    attempts: totalAttempts,
    error: lastReason,
    stdout: lastText,
  });

  return {
    text: lastText,
    parsed: undefined,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    model: opts.judgeModel.id,
    provider,
    wall_ms,
    session_id: null,
    stop_reason: "invalid_output",
    session_file: archivePath,
  };
}

export interface CritiqueFailureContext {
  cwd: string;
  provider: string;
  model: string;
  duration_ms: number;
  attempts: number;
  error: string;
  stdout: string;
}

/**
 * Archive a failed critique to <cwd>/.harness/critique_failures/<provider>_<ms>.txt,
 * mirroring the daemon's archiveCliFailureContext fields
 * (provider/model/duration/stderr→error). Best-effort; returns the path or undefined.
 */
export function archiveCritiqueFailure(ctx: CritiqueFailureContext): string | undefined {
  try {
    const dir = join(ctx.cwd, ".harness", "critique_failures");
    mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    const path = join(dir, `${ctx.provider}_${ts}.txt`);
    const stdout = ctx.stdout ?? "";
    const stdoutTail = stdout.length > 4096 ? stdout.slice(-4096) : stdout;
    const body =
      `# ${ctx.provider} critique failure\n` +
      `timestamp_unix_ms: ${ts}\n` +
      `cwd: ${sanitizePath(ctx.cwd)}\n` +
      `model: ${ctx.model}\n` +
      `attempts: ${ctx.attempts}\n` +
      `duration_ms: ${ctx.duration_ms}\n` +
      `error: ${ctx.error}\n` +
      `\n## output (last 4096 chars)\n${stdoutTail}\n`;
    writeFileSync(path, body, "utf8");
    return path;
  } catch {
    return undefined;
  }
}

/** Replace the user's home dir with `~` so archives don't leak it. */
function sanitizePath(s: string): string {
  const home = homedir();
  if (!home) return s;
  return s.split(home).join("~");
}
