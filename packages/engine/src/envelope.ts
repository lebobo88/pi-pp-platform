/**
 * GenResult — the uniform envelope every engine call returns.
 *
 * This is the pi-runtime analogue of the codex/gemini bridge result shape the
 * pair-programmer daemon used to return, normalized across all three vendors so
 * the orchestrator never sees provider-specific fields.
 */
import type { AssistantMessage, Model, Api, Usage } from "@earendil-works/pi-ai/compat";
import { computeCost, knownProviderIds, normalizeProviderAlias } from "@pp/core";

/**
 * An open provider id (pi's provider space). Historically this was the closed
 * union "anthropic" | "openai" | "google"; it is now any provider present in
 * the catalog (or any pi provider id we pass through verbatim).
 */
export type GenProvider = string;

export interface GenResult {
  /** Concatenated assistant text output. */
  text: string;
  /** Structured payload when the caller parsed/validated JSON (e.g. a critique verdict). */
  parsed?: unknown;
  /** input + cacheRead + cacheWrite (everything billed as prompt tokens). */
  tokens_in: number;
  /** output tokens. */
  tokens_out: number;
  /** USD cost. Prefers pi's own usage.cost.total; falls back to @pp/core prices. */
  cost_usd: number;
  /** Concrete model id, e.g. "claude-fable-5". */
  model: string;
  provider: GenProvider;
  /** Wall-clock duration of the call in ms. */
  wall_ms: number;
  /** Session id for coding-session calls; null for single completions/critiques. */
  session_id: string | null;
  /** pi stop reason ("stop" | "length" | ...) or an engine sentinel ("timeout", "aborted", "invalid_output"). */
  stop_reason: string;
  /** Absolute path (or archive path) of the session/failure file when one exists. */
  session_file?: string;
  /** Raw pi usage breakdown, when available. */
  usage_detail?: Usage;
}

/**
 * Normalize a pi provider id to a catalog provider id. Exact catalog matches
 * win; pi variant ids (e.g. "openai-codex", "google-vertex", "azure-openai-*")
 * fold onto their catalog provider for pricing/judge-key alignment; anything
 * unrecognized is returned verbatim so a newly-enabled provider still flows
 * through. Unlike the old three-vendor version, this NEVER throws.
 */
export function toGenProvider(provider: string): GenProvider {
  if (knownProviderIds().includes(provider)) return provider;
  return normalizeProviderAlias(provider) ?? provider;
}

/** Concatenate the text content blocks of an assistant message. */
export function messageText(msg: AssistantMessage): string {
  return msg.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}

export interface GenResultOverrides {
  wall_ms: number;
  session_id: string | null;
  session_file?: string;
  parsed?: unknown;
  /** Override the extracted text (e.g. a normalized critique JSON string). */
  text?: string;
  /** Override the stop reason (e.g. engine sentinels). */
  stop_reason?: string;
}

/**
 * Build a GenResult from a pi AssistantMessage. Aggregates the message's own
 * usage; for multi-turn sessions the caller should instead build from summed
 * usage via {@link buildGenResultFromTotals}.
 */
export function buildGenResult<TApi extends Api>(
  msg: AssistantMessage,
  model: Model<TApi>,
  overrides: GenResultOverrides,
): GenResult {
  const usage = msg.usage;
  const tokens_in = usage.input + usage.cacheRead + usage.cacheWrite;
  const tokens_out = usage.output;
  const catalogCost = usage.cost?.total ?? 0;
  const cost_usd = catalogCost > 0 ? catalogCost : computeCost(model.id, tokens_in, tokens_out);
  return {
    text: overrides.text ?? messageText(msg),
    parsed: overrides.parsed,
    tokens_in,
    tokens_out,
    cost_usd,
    model: model.id,
    provider: toGenProvider(model.provider),
    wall_ms: overrides.wall_ms,
    session_id: overrides.session_id,
    stop_reason: overrides.stop_reason ?? msg.stopReason,
    session_file: overrides.session_file,
    usage_detail: usage,
  };
}

export interface UsageTotals {
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

/**
 * Build a GenResult from pre-aggregated token/cost totals (multi-turn coding
 * sessions where usage is summed across every assistant turn).
 */
export function buildGenResultFromTotals<TApi extends Api>(
  model: Model<TApi>,
  totals: UsageTotals,
  fields: {
    text: string;
    wall_ms: number;
    session_id: string | null;
    session_file?: string;
    stop_reason: string;
    usage_detail?: Usage;
    parsed?: unknown;
  },
): GenResult {
  const cost_usd =
    totals.cost_usd > 0 ? totals.cost_usd : computeCost(model.id, totals.tokens_in, totals.tokens_out);
  return {
    text: fields.text,
    parsed: fields.parsed,
    tokens_in: totals.tokens_in,
    tokens_out: totals.tokens_out,
    cost_usd,
    model: model.id,
    provider: toGenProvider(model.provider),
    wall_ms: fields.wall_ms,
    session_id: fields.session_id,
    stop_reason: fields.stop_reason,
    session_file: fields.session_file,
    usage_detail: fields.usage_detail,
  };
}
