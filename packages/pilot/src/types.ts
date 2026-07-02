/**
 * Shared pilot types. Kept dependency-light so phase modules and run-pilot.ts
 * can import them without cycles.
 */

import type { Engine } from "@pp/engine";
import type {
  ProfileSpec,
  TeamSpec,
  Scope,
  RunStatus,
  ClaudeTier,
} from "@pp/core";
import type { EventBus } from "./events.js";
import type { JudgePolicy } from "./judge-policy.js";
import type { TierTraceEntry, TierFlags } from "./tier-resolver.js";

export type RunMode = "single" | "team" | "best_of" | "review";

/** A monotonic clock seam so tests can pin durations if needed. */
export type Clock = () => number;

export type RunPilotOptions = {
  projectPath: string;
  requestText: string;
  mode: RunMode;
  team?: string;
  forum?: string;
  n?: number;
  scopeOverride?: Scope;
  tierCap?: ClaudeTier;
  tierFloor?: ClaudeTier;
  noTierPolicy?: boolean;
  engine: Engine;
  bus: EventBus;
  clock?: Clock;
  signal?: AbortSignal;
  /**
   * Explicit stage set, bypassing scope/mode-derived planning. A test + server
   * seam for driving a precise pipeline (e.g. a 2-stage TDD red→green or a
   * single best-of code stage) without a full team yaml.
   */
  stagesOverride?: StageSpec[];
  /**
   * Injectable per-candidate runtime smoke outcome for best-of stages. In
   * production the engineer records the real smoke result; this seam lets tests
   * exercise the smoke post-filter / merge-refusal paths deterministically.
   */
  smokeDecision?: SmokeDecision;
};

export type SmokeDecision = (candidateIndex: number) => "pass" | "fail" | "infra_error" | "skipped";

/** The specification of one stage in the pipeline. */
export type StageSpec = {
  kind: string;
  gate_type: string;
  /** The generator agent role (drives tier + prompt + execution mode). */
  agent: string;
  /** Canonical artifact kind (for gate rubric selection), when known. */
  artifact_kind?: string;
  /** team_yaml generator.model_tier pin, when a team stage set it. */
  teamStageModelTier?: ClaudeTier;
  /** team_yaml judge.rubric hint, when set. */
  rubricHint?: string;
  /** team_yaml judge.model_pref hint. */
  judgeModelPref?: string;
  /** When set (>=2), run this stage as a best-of-N candidate race. */
  bestOf?: number;
  /**
   * Force a specific execution mode, overriding the role's default
   * classification. Forums pin "completion" so advisory/readonly roles produce
   * an artifact without mutating the project tree.
   */
  execution?: "session-coding" | "session-readonly" | "completion";
};

export type StageOutcome = "passed" | "surfaced" | "aborted";

/**
 * The mutable run context threaded through every phase. Phase functions read
 * and update this object; run-pilot.ts owns its lifecycle.
 */
export type RunContext = {
  // identity
  run_id: string;
  artifact_dir: string;
  started_at: string;

  // inputs
  projectPath: string;
  requestText: string;
  mode: RunMode;
  teamName?: string;
  forum?: string;
  n?: number;
  flags: TierFlags;

  // engine / io seams
  engine: Engine;
  bus: EventBus;
  judgePolicy: JudgePolicy;
  clock: Clock;
  signal?: AbortSignal;
  smokeDecision?: SmokeDecision;

  // phase 1/4: triage + taxonomy
  scope: Scope;
  signals: string[];
  sections: Array<{ id: string; title: string; rationale: string; required_artifacts: string[] }>;
  missabilityRequired: string[];

  // phase 2: profile
  profile: ProfileSpec | null;
  profileName?: string;

  // phase 6: team pipeline (major/team/review modes)
  team?: TeamSpec;

  // tier audit accumulator (archived as tier_decisions.json)
  tierTrace: Array<{
    stage_kind: string;
    agent: string;
    initial_tier: ClaudeTier;
    model_id: string;
    trace: TierTraceEntry[];
  }>;

  // outcome
  finalStatus: Extract<RunStatus, "complete" | "surfaced" | "aborted" | "crashed">;
  /** Set when the run aborts (judge halt, unexpected error) with context. */
  abortReason?: string;
};

/** Emit an event through the bus with the run id filled in. */
export function emit(
  ctx: Pick<RunContext, "bus" | "run_id">,
  type: import("./events.js").PilotEventType,
  data: Record<string, unknown> = {},
  extra: { stage_id?: string; attempt_id?: string } = {},
): void {
  ctx.bus.emit({ type, run_id: ctx.run_id, data, ...extra });
}
