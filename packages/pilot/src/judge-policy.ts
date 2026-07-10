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
  /** True when the run carries the triage `greenfield` signal — swaps the
   * minimality-bearing default code rubric for the scope-fidelity variant. */
  greenfield?: boolean;
  /** True on a Reflexion retry — opens the escalated-judge lane. */
  retry?: boolean;
  /** Optional provider hint from a team stage's judge.model_pref. */
  preferredProvider?: GenProvider;
  /**
   * Force a cross-vendor judge regardless of the gate's base tier. Best-of-N
   * uses this: every candidate is Claude, so the judge must be non-Claude both
   * to satisfy the de-biasing contract and to avoid a same-vendor same-model
   * collision when a candidate used the same Claude model the judge pool pins.
   */
  forceCrossVendor?: boolean;
  /** The generator's REAL provider (derived from its effective-ladder model),
   * overriding the producer→provider guess. Cross-provider judging excludes it. */
  generatorProvider?: string;
  /** When set, only providers with a configured credential are eligible judges —
   * so a run never routes a judge to an unkeyed vendor. */
  keyedProviders?: string[];
  /**
   * Providers to drop from the eligible set — the judge-failover loop passes the
   * provider(s) that already errored on this stage so re-selection lands on a
   * fresh vendor. Purely subtractive: it can only shrink an already-eligible
   * pool, and an empty result still throws {@link JudgeUnavailableError} (never
   * fabricate a verdict).
   */
  excludeProviders?: string[];
};

export type JudgeSelection = {
  /** Legacy producer string for record_verdict (codex|gemini|claude). */
  judge_producer: Producer;
  /** Concrete judge model id. */
  judge_model: string;
  /** The provider's NON-escalated default judge model. Equals `judge_model`
   * unless the escalated lane was taken; the failover loop de-escalates to this
   * before abandoning the provider. */
  default_model: string;
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

  /**
   * The gate-bound rubric id for these inputs — the rubric-only slice of
   * {@link select}, WITHOUT its provider-rotation side effect. The generator
   * calls this BEFORE generating so it can be shown the very rubric it will be
   * judged against; select() derives its `rubric_id` from the same
   * `evaluateGate` inputs, so the id injected into the generator prompt equals
   * the id later recorded on the verdict. Returns null when no rubric binds.
   */
  rubricIdFor(
    input: Pick<
      JudgeSelectInput,
      "gateType" | "generatorProducer" | "generatorModel" | "promptKeywords" | "profile" | "artifactKind" | "rubricHint" | "greenfield"
    >,
  ): string | null {
    return evaluateGate({
      gate_type: input.gateType,
      generator_producer: input.generatorProducer,
      generator_model: input.generatorModel,
      prompt_keywords: input.promptKeywords,
      profile: input.profile ?? null,
      artifact_kind: input.artifactKind ?? null,
      rubric_hint: input.rubricHint ?? null,
      greenfield: input.greenfield ?? false,
    }).rubric_id;
  }

  select(runId: string, input: JudgeSelectInput): JudgeSelection {
    const decision = evaluateGate({
      gate_type: input.gateType,
      generator_producer: input.generatorProducer,
      generator_model: input.generatorModel,
      prompt_keywords: input.promptKeywords,
      profile: input.profile ?? null,
      artifact_kind: input.artifactKind ?? null,
      rubric_hint: input.rubricHint ?? null,
      greenfield: input.greenfield ?? false,
    });

    const genProvider = input.generatorProvider ?? producerToProvider(input.generatorProducer);
    const required = decision.required_cross_vendor || !!input.forceCrossVendor;

    // Base eligibility from the engine (drops kill-switched providers + the gen
    // vendor when cross-vendor is required). Additionally honor the global
    // Gemini kill-switch, which is separate from PP_DISABLE_GOOGLE.
    let eligible = eligibleJudgeProviders(genProvider, required).filter(
      (p) => p !== "google" || geminiEnabled(),
    );

    // Only providers with a configured credential can judge — never route to an
    // unkeyed vendor (e.g. anthropic in the pool when no anthropic key is set).
    if (input.keyedProviders) {
      const keyed = new Set(input.keyedProviders);
      eligible = eligible.filter((p) => keyed.has(p));
    }

    // Failover exclusions: drop providers that already errored on this stage so
    // re-selection lands on a fresh vendor. Subtractive only — an empty result
    // below still throws (halt, never fabricate).
    if (input.excludeProviders?.length) {
      const excluded = new Set(input.excludeProviders);
      eligible = eligible.filter((p) => !excluded.has(p));
    }

    // Same-vendor different-model invariant: if the only same-vendor option
    // would reuse the generator's exact model id, it cannot serve — drop it.
    eligible = eligible.filter((p) => {
      if (p !== genProvider) return true;
      const pool = JUDGE_POOLS[p];
      if (!pool) return false; // no judge model for this provider — cannot serve
      return pool.default !== input.generatorModel;
    });

    if (eligible.length === 0) {
      throw new JudgeUnavailableError(
        `no eligible judge for gate_type=${input.gateType} ` +
          `(generator=${genProvider}/${input.generatorModel}, ` +
          `required_cross_vendor=${required}). Every candidate judge provider is ` +
          `disabled, excluded, or has no configured key` +
          (input.keyedProviders ? ` (keyed: ${input.keyedProviders.join(", ") || "none"})` : "") +
          `. Configure a key for a judge provider different from the generator ` +
          `(the harness will not downgrade the gate or fabricate a verdict).`,
        input.gateType,
        required,
        genProvider,
      );
    }

    const provider = this.pickWithRotation(runId, eligible, input.preferredProvider);
    this.lastProviderByRun.set(runId, provider);

    const pool = JUDGE_POOLS[provider];
    if (!pool) {
      throw new JudgeUnavailableError(
        `judge provider "${provider}" has no catalog judge-pool entry`,
        input.gateType,
        required,
        genProvider,
      );
    }
    const escalated = !!input.retry && provider === "openai" && !!pool.escalated;
    const judge_model = escalated && pool.escalated ? pool.escalated : pool.default;

    return {
      judge_producer: providerToProducer(provider),
      judge_model,
      default_model: pool.default,
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
