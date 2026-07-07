/**
 * Deterministic verdict derivation from judge scores.
 *
 * The judge label (pass/fail/revise) is advisory: two models can eyeball the
 * same rubric scores and disagree on the summary label. To make stage
 * branching and the persisted `verdicts.outcome` reproducible we derive the
 * outcome PURELY from the numeric per-dimension scores, and treat the judge's
 * self-reported label as a hint only.
 *
 * Sanitation is the load-bearing part: a judge may emit non-numeric entries
 * (strings, nested objects) or underscore-prefixed pseudo-dimensions
 * (`_cross_vendor`, `_notes`) that are NOT rubric dimensions. Those must never
 * reach the derivation math NOR the persisted `score_json` map (the UI iterates
 * it as a flat dimension→score map). `sanitizeDimensionScores` is therefore the
 * single chokepoint both the derivation and every persistence site route
 * through, so the row can never carry an unsanitized map — including the
 * fallback branch where derivation returns null (no numeric dimensions).
 */

import type { VerdictOutcome } from "../config.js";

/** Every dimension at/above this is a pass signal. */
const PASS_THRESHOLD = 0.7;
/** Any dimension below this is a hard fail signal. */
const FAIL_THRESHOLD = 0.5;

/**
 * Strip a raw judge score map down to the real numeric rubric dimensions:
 * drop underscore-prefixed pseudo-dimensions and any non-numeric / non-finite
 * value, and clamp every surviving score into [0,1]. Returns a fresh flat map
 * (never the input object); an input that is not a plain object yields `{}`.
 */
export function sanitizeDimensionScores(scores: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) return out;
  for (const [key, raw] of Object.entries(scores as Record<string, unknown>)) {
    if (key.startsWith("_")) continue; // pseudo-dimension (e.g. _cross_vendor)
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    out[key] = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  }
  return out;
}

/**
 * Derive a verdict outcome from raw judge scores, purely and deterministically:
 * sanitize (drop non-numeric + underscore keys, clamp to [0,1]), then band —
 * every dimension >= 0.7 → pass; any dimension < 0.5 → fail; otherwise revise.
 * Returns null when no numeric dimensions survive sanitation (the caller then
 * falls back to the advisory judge label, but still persists the sanitized map).
 */
export function deriveOutcomeFromScores(scores: unknown): VerdictOutcome | null {
  const dims = sanitizeDimensionScores(scores);
  const values = Object.values(dims);
  if (values.length === 0) return null;
  if (values.every((v) => v >= PASS_THRESHOLD)) return "pass";
  if (values.some((v) => v < FAIL_THRESHOLD)) return "fail";
  return "revise";
}

export type ResolvedVerdict = {
  /** Outcome to branch on AND persist: derived when derivable, else the judge label. */
  outcome: VerdictOutcome;
  /** Sanitized flat dimension→score map to persist as score_json in EVERY branch. */
  score_json: Record<string, number>;
  /** The judge's advisory self-reported label. */
  judge_label: VerdictOutcome;
  /** True when a numeric outcome was derived (derivation did not return null). */
  derived: boolean;
  /** True when the derived outcome overrode a disagreeing judge label. */
  disagreed: boolean;
  /** critique_md with the disagreement provenance note appended when they disagree. */
  critique_md: string;
};

/**
 * Single resolution point shared by every verdict-recording site (the stage
 * loop's judge() and best-of's winner verdict). Guarantees two invariants the
 * cross-vendor review called out:
 *   (A) `score_json` is the sanitized flat dimension map in ALL branches —
 *       including the fallback where derivation returns null — so an
 *       unsanitized map (pseudo-dimensions, non-numeric junk) can never reach
 *       the verdicts row.
 *   (B) the map persisted is the actual per-dimension score map used for
 *       derivation (a flat map the UI iterates), never replaced by metadata.
 * On disagreement the derived outcome wins and a `[harness]` note recording the
 * judge's original label is appended to critique_md for provenance.
 */
export function resolveVerdict(input: {
  judge_outcome: VerdictOutcome;
  scores: unknown;
  critique_md?: string;
}): ResolvedVerdict {
  const score_json = sanitizeDimensionScores(input.scores);
  const derived = deriveOutcomeFromScores(input.scores);
  const judge_label = input.judge_outcome;
  const outcome = derived ?? judge_label;
  const disagreed = derived !== null && derived !== judge_label;
  let critique_md = input.critique_md ?? "";
  if (disagreed) {
    const note = `[harness] outcome derived from scores; judge label was ${judge_label}`;
    critique_md = critique_md ? `${critique_md}\n\n${note}` : note;
  }
  return { outcome, score_json, judge_label, derived: derived !== null, disagreed, critique_md };
}
