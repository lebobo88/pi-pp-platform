/**
 * Judge selection policy — the in-process analogue of the `gate_eligible_judges`
 * daemon tool plus the judge-router/judge-policy skill rules.
 *
 * Wraps @pp/core `evaluateGate` (which owns the cross-vendor requirement,
 * content-aware + profile-aware upgrades, and rubric binding) and layers the
 * engine's concrete JUDGE_POOLS on top:
 *
 *  - picks a judge provider honoring cross-vendor + the per-provider kill
 *    switches (PP_DISABLE_OPENAI/GOOGLE/ANTHROPIC) and the global Gemini
 *    kill-switch (PP_DISABLE_GEMINI),
 *  - rotates the provider across stages within a run (de-biasing),
 *  - escalates the OpenAI judge to gpt-5.5 on Reflexion retries
 *    (codex_critique_escalated),
 *  - enforces the same-vendor different-model invariant,
 *  - throws {@link JudgeUnavailableError} when the pool is empty — the caller
 *    surfaces the stage and aborts the run (judge-halt protocol).
 */

import {
  evaluateGate,
  geminiEnabled,
  type GateType,
  type Profile,
} from "@pp/core";
import {
  JUDGE_POOLS,
  eligibleJudgeProviders,
  type GenProvider,
} from "@pp/engine";
import { JudgeUnavailableError } from "./errors.js";

/** The pilot's generator producers map onto the three vendor spaces. */
export type Producer = "claude" | "codex" | "gemini";

/** producer (DB/legacy string) → GenProvider (pi vendor space). */
export function producerToProvider(producer: string): GenProvider {
  if (producer === "codex") return "openai";
  if (producer === "gemini") return "google";
  return "anthropic"; // claude / copilot default to anthropic here
}

/** GenProvider → the legacy producer string persisted on verdicts. */
export function providerToProducer(provider: GenProvider): Producer {
  if (provider === "openai") return "codex";
  if (provider === "google") return "gemini";
  return "claude";
}

export type JudgeSelectInput = {
  gateType: GateType;
  generatorProducer: string;
  generatorModel: string;
  promptKeywords?: string;
  profile?: Profile | null;
  artifactKind?: string | null;
  rubricHint?: string | null;
  /** True on a Reflexion retry — opens the escalated-judge lane. */
  retry?: boolean;
  /** Optional provider hint from a team stage's judge.model_pref. */
  preferredProvider?: GenProvider;
};

export type JudgeSelection = {
  /** Legacy producer string for record_verdict (codex|gemini|claude). */
  judge_producer: Producer;
  /** Concrete judge model id. */
  judge_model: string;
  /** pi vendor of the judge. */
  provider: GenProvider;
  /** Whether the daemon gate demanded cross-vendor. */
  required_cross_vendor: boolean;
  /** True when judge vendor != generator vendor. */
  cross_vendor: boolean;
  /** Rubric id bound by the gate (may be null). */
  rubric_id: string | null;
  /** True when the escalated model (gpt-5.5) was selected. */
  escalated: boolean;
  /** Human-readable reason from the gate decision. */
  reason: string;
};

/**
 * Stateful across a run: remembers the last judge provider so consecutive
 * stages rotate. Construct one per RunPilot.
 */
export class JudgePolicy {
  private lastProviderByRun = new Map<string, GenProvider>();

  select(runId: string, input: JudgeSelectInput): JudgeSelection {
    const decision = evaluateGate({
      gate_type: input.gateType,
      generator_producer: input.generatorProducer,
      generator_model: input.generatorModel,
      prompt_keywords: input.promptKeywords,
      profile: input.profile ?? null,
      artifact_kind: input.artifactKind ?? null,
      rubric_hint: input.rubricHint ?? null,
    });

    const genProvider = producerToProvider(input.generatorProducer);
    const required = decision.required_cross_vendor;

    // Base eligibility from the engine (drops kill-switched providers + the gen
    // vendor when cross-vendor is required). Additionally honor the global
    // Gemini kill-switch, which is separate from PP_DISABLE_GOOGLE.
    let eligible = eligibleJudgeProviders(genProvider, required).filter(
      (p) => p !== "google" || geminiEnabled(),
    );

    // Same-vendor different-model invariant: if the only same-vendor option
    // would reuse the generator's exact model id, it cannot serve — drop it.
    eligible = eligible.filter((p) => {
      if (p !== genProvider) return true;
      const pool = JUDGE_POOLS[p];
      return pool.default !== input.generatorModel;
    });

    if (eligible.length === 0) {
      throw new JudgeUnavailableError(
        `no eligible judge for gate_type=${input.gateType} ` +
          `(generator=${input.generatorProducer}/${input.generatorModel}, ` +
          `required_cross_vendor=${required}). Every candidate vendor is disabled ` +
          `or excluded. Configure another vendor (OPENAI/GEMINI/ANTHROPIC) and retry — ` +
          `the harness will not downgrade the gate or fabricate a verdict.`,
        input.gateType,
        required,
        genProvider,
      );
    }

    const provider = this.pickWithRotation(runId, eligible, input.preferredProvider);
    this.lastProviderByRun.set(runId, provider);

    const pool = JUDGE_POOLS[provider];
    const escalated =
      !!input.retry && provider === "openai" && "escalated" in pool;
    const judge_model =
      escalated && "escalated" in pool ? pool.escalated : pool.default;

    return {
      judge_producer: providerToProducer(provider),
      judge_model,
      provider,
      required_cross_vendor: required,
      cross_vendor: provider !== genProvider,
      rubric_id: decision.rubric_id,
      escalated,
      reason: decision.reason,
    };
  }

  /**
   * Prefer the team hint when eligible, otherwise rotate away from the
   * last-used provider so consecutive stages don't hit the same judge.
   */
  private pickWithRotation(
    runId: string,
    eligible: GenProvider[],
    preferred?: GenProvider,
  ): GenProvider {
    if (preferred && eligible.includes(preferred)) return preferred;
    const last = this.lastProviderByRun.get(runId);
    if (last && eligible.length > 1) {
      const rotated = eligible.filter((p) => p !== last);
      if (rotated.length > 0) return rotated[0]!;
    }
    return eligible[0]!;
  }
}
