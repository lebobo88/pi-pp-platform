/**
 * Deterministic run-cost estimator for the launch wizard. Produces a USD range
 * from a coarse per-stage token model crossed with a cheap/dear tier price. The
 * range communicates uncertainty (tier ladder can shift a run between the two);
 * it is intentionally an estimate, not a quote.
 */
import type { RunMode } from "@shared/api-types";

export interface TierPrice {
  input_per_1m: number;
  output_per_1m: number;
}

export interface CostEstimateInput {
  mode: RunMode;
  /** Number of gate stages the run will execute. */
  stageCount: number;
  /** Best-of fan-out (candidates on the implementation stage); 1 otherwise. */
  n: number;
  /** Cheapest tier price on the ladder (usually haiku). */
  cheapPrice: TierPrice;
  /** Dearest allowed tier price (tier cap, else opus). */
  dearPrice: TierPrice;
}

export interface CostEstimate {
  minUsd: number;
  maxUsd: number;
}

// Coarse per-stage token model: one generation + one judge pass.
const STAGE_TOKENS_IN = 6000;
const STAGE_TOKENS_OUT = 2500;
const GEN_PLUS_JUDGE = 1.4; // generation cost + ~0.4 judge overhead

function costAt(units: number, price: TierPrice): number {
  const perUnit =
    (STAGE_TOKENS_IN / 1_000_000) * price.input_per_1m +
    (STAGE_TOKENS_OUT / 1_000_000) * price.output_per_1m;
  return units * GEN_PLUS_JUDGE * perUnit;
}

export function estimateRunCost(input: CostEstimateInput): CostEstimate {
  const stages = Math.max(1, input.stageCount);
  // Best-of adds (n-1) extra candidates on a single stage.
  const extraCandidates = input.mode === "best_of" ? Math.max(0, input.n - 1) : 0;
  const units = stages + extraCandidates;

  const a = costAt(units, input.cheapPrice);
  const b = costAt(units, input.dearPrice);
  const minUsd = Math.min(a, b);
  const maxUsd = Math.max(a, b);
  return { minUsd, maxUsd };
}

/** Default stage-count heuristic per mode when the team pipeline is unknown. */
export function defaultStageCount(mode: RunMode): number {
  switch (mode) {
    case "single":
      return 2; // code + docs polish
    case "best_of":
      return 2;
    case "review":
      return 3; // forum pipelines run ~3 stages
    case "team":
      return 5; // caller overrides with the real team.stages.length
    default:
      return 3;
  }
}
