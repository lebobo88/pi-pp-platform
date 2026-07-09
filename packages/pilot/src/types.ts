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
import type { LadderOverride } from "./generation-model.js";

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
  /**
   * Per-run effective-ladder overrides (highest precedence, above the project
   * profile, the global harness_settings ladder, and the catalog default).
   * `ladderOverride` maps a Claude tier → concrete model id; `tierPoolsOverride`
   * maps a tier → model pool. Absent → resolution is byte-identical.
   */
  ladderOverride?: Partial<Record<ClaudeTier, string>>;
  tierPoolsOverride?: Partial<Record<ClaudeTier, string[]>>;
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
  /**
   * team_yaml stage `skills` — explicit skill ids that are ALWAYS injected
   * into the generator prompt (on top of the registry's auto-selection),
   * regardless of each skill's own injection/applies_to_* scoping.
   */
  skills?: string[];
  /** When set (>=2), run this stage as a best-of-N candidate race. */
  bestOf?: number;
  /**
   * Force a specific execution mode, overriding the role's default
   * classification. Forums pin "completion" so advisory/readonly roles produce
   * an artifact without mutating the project tree.
   */
  execution?: "session-coding" | "session-readonly" | "completion";
  /**
   * v10: index into the run's persisted `stage_plan_json` array that this
   * StageSpec came from. Set by `RunPilot.execute()` (and the resume flow)
   * right before dispatch, so the created `stages` row can be stamped with
   * `plan_index` and a later resume can compute "first plan slot with no
   * stage row" instead of guessing from `kind` alone. `undefined` for
   * plans that bypass persistence (e.g. `stagesOverride` test/server seam
   * before a plan is persisted).
   */
  planIndex?: number;
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
  /**
   * TOP-precedence effective-ladder override for this run: the per-run request
   * override merged OVER the project profile's ladder/tier_pools (per-run wins
   * per-tier). Assembled after the profile phase and passed to the tier
   * resolver, which applies it above the global harness_settings ladder and the
   * catalog default. Undefined → resolution is byte-identical.
   */
  ladderOverride?: LadderOverride;

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

  /**
   * Artifacts from stages that PASSED, in pipeline order. Downstream stages
   * inject these into their prompts ("Approved upstream artifacts") so e.g.
   * the code stage implements the approved spec instead of re-deriving the
   * request from scratch.
   */
  stageArtifacts: Array<{ kind: string; agent: string; path: string; text: string }>;

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
