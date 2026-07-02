/**
 * Layered Claude-tier resolver — an exact in-process reproduction of the
 * `/pp:run` step-6a algorithm (see pair-programmer/.claude/commands/pp/run.md).
 *
 * The resolver ONLY governs Claude generators. For Codex/Gemini producers the
 * caller skips this and uses the vendor default model id. Precedence stacks
 * low→high, highest wins:
 *
 *   1. AGENT_TIER_DEFAULTS[agent]        (agent frontmatter mirror; base)
 *   2. team_yaml generator.model_tier    (assignment)
 *   3. profile scope_adjust[scope]       (relative shiftTier, clamped)
 *   4. profile per_stage_override / default_cap   (assignment / down-clamp)
 *   5. CLI --tier-cap (down-clamp) / --tier-floor (up-clamp)
 *
 * Off-ladder guard: an explicitly-selected off-ladder tier (fable, tierIndex<0)
 * is NEVER touched by the numeric cap/floor comparisons — team-yaml/profile set
 * it intentionally and the comparison is undefined for it. shiftTier already
 * returns off-ladder tiers unchanged, so scope_adjust is a no-op on them too.
 */

import {
  shiftTier,
  tierIndex,
  isClaudeTier,
  type ClaudeTier,
  type ModelTierPolicy,
} from "@pp/core";
import type { Scope } from "@pp/core";
import { generationModelIdForTier } from "./generation-model.js";
import { TierResolutionError } from "./errors.js";

/**
 * Default Claude tier per agent role. Mirror of the AGENT_TIER_DEFAULTS table
 * at the top of run.md. The source of truth is each agent's `model:`
 * frontmatter; this table is for traceability + fail-loud dispatch. Judges are
 * intentionally absent — they pick their own model from an internal rotation.
 */
export const AGENT_TIER_DEFAULTS: Record<string, ClaudeTier> = {
  // opus
  "strategy-author": "opus",
  "spec-author": "opus",
  architect: "opus",
  "security-reviewer": "opus",
  "discovery-researcher": "opus",
  "ai-controls-author": "opus",
  "narrative-designer": "opus",
  "encounter-designer": "opus",
  "level-designer": "opus",
  "game-ai-programmer": "opus",
  "netcode-programmer": "opus",
  "game-security": "opus",
  // sonnet
  engineer: "sonnet",
  "api-designer": "sonnet",
  designer: "sonnet",
  "design-system-curator": "sonnet",
  "test-strategist": "sonnet",
  "docs-author": "sonnet",
  "ops-author": "sonnet",
  "data-modeler": "sonnet",
  "release-planner": "sonnet",
  "retirement-planner": "sonnet",
  "governance-author": "sonnet",
  "economy-designer": "sonnet",
  "live-ops-manager": "sonnet",
  "tech-animator": "sonnet",
  "technical-artist": "sonnet",
  "game-accessibility-specialist": "sonnet",
  // haiku
  triage: "haiku",
  "taxonomy-mapper": "haiku",
  "profile-loader": "haiku",
  "judge-router": "haiku",
  "missability-inspector": "haiku",
  "master-plan-patcher": "haiku",
  "run-finalizer": "haiku",
  "reflexion-coach": "haiku",
  "browser-validator": "haiku",
  "visual-regression-runner": "haiku",
};

/** One layer's contribution to the resolution, for the tier_decisions.json trace. */
export type TierTraceEntry = {
  layer:
    | "frontmatter"
    | "team_yaml"
    | "scope_adjust"
    | "profile_per_stage"
    | "profile_cap"
    | "cli_cap"
    | "cli_floor"
    | "fable_capability_gate"
    | "retry";
  tier: ClaudeTier;
  /** Extra context (scope, delta, from→to, reason). */
  [k: string]: unknown;
};

export type TierFlags = {
  tierCap?: ClaudeTier;
  tierFloor?: ClaudeTier;
  noTierPolicy?: boolean;
};

export type TierResolveInput = {
  /** The stage's generator agent (must exist in AGENT_TIER_DEFAULTS). */
  agent: string;
  /** The stage kind (used for profile per_stage_override lookup). */
  stageKind: string;
  /** Triage/taxonomy scope, feeds scope_adjust. */
  scope: Scope;
  /** team_yaml generator.model_tier, when a team stage pins it. */
  teamStageModelTier?: ClaudeTier;
  /** Profile model_tier_policy, if any. */
  profilePolicy?: ModelTierPolicy | null;
  flags: TierFlags;
};

export type TierResolution = {
  tier: ClaudeTier;
  model_id: string;
  trace: TierTraceEntry[];
};

/**
 * Resolve the initial tier for a stage. Throws TierResolutionError when the
 * agent has no default — run.md: "Refusing to dispatch beats silently
 * inheriting Opus."
 */
export function resolveTier(input: TierResolveInput): TierResolution {
  const trace: TierTraceEntry[] = [];

  const base = AGENT_TIER_DEFAULTS[input.agent];
  if (!base) {
    throw new TierResolutionError(
      `agent "${input.agent}" has no tier — add a \`model:\` to its agent file or update ` +
        `AGENT_TIER_DEFAULTS. Refusing to dispatch beats silently inheriting Opus.`,
      input.agent,
    );
  }
  let tier: ClaudeTier = base;
  trace.push({ layer: "frontmatter", tier });

  // Layer 2: team_yaml stage override (assignment).
  if (input.teamStageModelTier) {
    tier = input.teamStageModelTier;
    trace.push({ layer: "team_yaml", tier });
  }

  // Layer 3: triage scope adjustment (relative shift; no-op on off-ladder).
  const delta = input.profilePolicy?.scope_adjust?.[input.scope] ?? 0;
  if (delta !== 0) {
    tier = shiftTier(tier, delta);
    trace.push({ layer: "scope_adjust", scope: input.scope, delta, tier });
  }

  // Layer 4: profile policy (per_stage_override beats default_cap). Skipped
  // entirely under --no-tier-policy.
  const policy = input.profilePolicy;
  if (!input.flags.noTierPolicy && policy) {
    const override = policy.per_stage_override?.[input.stageKind];
    if (override) {
      tier = override;
      trace.push({ layer: "profile_per_stage", tier });
    } else if (
      policy.default_cap &&
      tierIndex(tier) >= 0 &&
      tierIndex(tier) > tierIndex(policy.default_cap)
    ) {
      tier = policy.default_cap;
      trace.push({ layer: "profile_cap", tier });
    }
  }

  // Layer 5: CLI flags (highest precedence). Off-ladder guard: only apply the
  // numeric cap/floor comparison when the current tier is on the ladder.
  if (
    input.flags.tierCap &&
    tierIndex(tier) >= 0 &&
    tierIndex(tier) > tierIndex(input.flags.tierCap)
  ) {
    tier = input.flags.tierCap;
    trace.push({ layer: "cli_cap", tier });
  }
  if (
    input.flags.tierFloor &&
    tierIndex(tier) >= 0 &&
    tierIndex(tier) < tierIndex(input.flags.tierFloor)
  ) {
    tier = input.flags.tierFloor;
    trace.push({ layer: "cli_floor", tier });
  }

  // Fable capability gate: fable is never reached by auto-escalation and has no
  // CLI flag; it can only arrive here via a team_yaml/profile assignment. Note
  // it in the trace so the tier_decisions.json audit shows the explicit pin.
  if (tier === "fable") {
    trace.push({
      layer: "fable_capability_gate",
      tier,
      reason: "fable pinned explicitly via team_yaml or profile per_stage_override",
    });
  }

  return { tier, model_id: generationModelIdForTier(tier), trace };
}

/**
 * Escalate a stage's tier by +1 for a Reflexion retry (haiku→sonnet→opus; opus
 * stays; off-ladder unchanged). The CLI floor still applies on retry (ladder
 * tiers only); the CLI cap does NOT — escalation is intentional. Returns the
 * retry tier, model id, and the trace entry to append.
 */
export function escalateTierForRetry(
  initialTier: ClaudeTier,
  flags: TierFlags,
  verdictOutcome: string,
): { tier: ClaudeTier; model_id: string; trace: TierTraceEntry } {
  let retryTier = shiftTier(initialTier, +1);
  if (
    flags.tierFloor &&
    tierIndex(retryTier) >= 0 &&
    tierIndex(retryTier) < tierIndex(flags.tierFloor)
  ) {
    retryTier = flags.tierFloor;
  }
  return {
    tier: retryTier,
    model_id: generationModelIdForTier(retryTier),
    trace: { layer: "retry", tier: retryTier, initial: initialTier, reason: `verdict:${verdictOutcome}` },
  };
}

/** Parse + validate a CLI tier flag value. Fable has no flag (ladder only). */
export function parseTierFlag(value: string): ClaudeTier {
  const v = value.trim().toLowerCase();
  if (v === "opus" || v === "sonnet" || v === "haiku") return v;
  throw new Error(`expected opus|sonnet|haiku, got '${value}'`);
}

export { isClaudeTier };
