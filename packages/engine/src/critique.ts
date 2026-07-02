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
import { buildGenResult, messageText, toGenProvider, type GenResult } from "./envelope.js";
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

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const t0 = Date.now();
    const msg = await complete({
      model: opts.judgeModel,
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      userPrompt,
      apiKey: opts.apiKey,
      headers: opts.headers,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      reasoning: "high",
    });
    wall_ms += Date.now() - t0;
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
