/**
 * ModelCatalog — resolves platform tiers / judge pools to concrete pi Models
 * over a ModelRegistry backed by the platform AuthStorage.
 *
 * Tier + judge tables live here for M2. The pilot unifies these with
 * @pp/core config.ts in M3 — @pp/core is intentionally left untouched.
 */
import { ModelRegistry, type AuthStorage } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai/compat";
import type { GenProvider } from "./envelope.js";

export type Tier = "fable" | "opus" | "sonnet" | "haiku";

/** Platform tier → concrete pinned model (all Anthropic for M2). */
export const TIER_MODELS: Record<Tier, { provider: GenProvider; id: string }> = {
  fable: { provider: "anthropic", id: "claude-fable-5" },
  opus: { provider: "anthropic", id: "claude-opus-4-7" },
  sonnet: { provider: "anthropic", id: "claude-sonnet-4-6" },
  haiku: { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
};

/** Cross-vendor judge pools, keyed by vendor. */
export const JUDGE_POOLS = {
  openai: { default: "gpt-5.4", escalated: "gpt-5.5" },
  google: { default: "gemini-3.1-pro-preview" },
  anthropic: { default: "claude-opus-4-7" },
} as const;

const KILL_SWITCH_ENV: Record<GenProvider, string> = {
  openai: "PP_DISABLE_OPENAI",
  google: "PP_DISABLE_GOOGLE",
  anthropic: "PP_DISABLE_ANTHROPIC",
};

/** True when a provider is disabled via its per-provider kill switch. */
export function isProviderDisabled(provider: GenProvider): boolean {
  return process.env[KILL_SWITCH_ENV[provider]] === "1";
}

/**
 * The judge providers eligible for a given generator.
 *
 * - honors the per-provider kill switches (PP_DISABLE_OPENAI/GOOGLE/ANTHROPIC),
 * - when `requiredCrossVendor` is true, excludes the generator's own vendor.
 */
export function eligibleJudgeProviders(
  generatorProvider: GenProvider,
  requiredCrossVendor: boolean,
): GenProvider[] {
  const all: GenProvider[] = ["openai", "google", "anthropic"];
  return all.filter((p) => {
    if (isProviderDisabled(p)) return false;
    if (requiredCrossVendor && p === generatorProvider) return false;
    return true;
  });
}

export interface JudgeSelection {
  provider: GenProvider;
  model: string;
}

export class ModelCatalog {
  readonly registry: ModelRegistry;

  constructor(authStorage: AuthStorage, modelsJsonPath?: string) {
    this.registry = ModelRegistry.create(authStorage, modelsJsonPath);
  }

  /** Resolve a concrete model. Throws if the provider/id is not in the registry. */
  resolve(provider: string, id: string): Model<Api> {
    const model = this.registry.find(provider, id);
    if (!model) {
      const err = this.registry.getError();
      throw new Error(
        `model "${provider}/${id}" not found in ModelRegistry` + (err ? ` (models.json error: ${err})` : ""),
      );
    }
    return model;
  }

  /** Resolve a platform tier to its pinned model. */
  resolveTier(tier: Tier): Model<Api> {
    const t = TIER_MODELS[tier];
    return this.resolve(t.provider, t.id);
  }

  /**
   * Pick a judge model for the first eligible provider, honoring cross-vendor
   * and kill-switch rules. `escalated` selects the escalated model where a pool
   * defines one (openai). Returns null when no provider is eligible.
   */
  pickJudge(
    generatorProvider: GenProvider,
    opts: { requiredCrossVendor: boolean; escalated?: boolean; preferred?: GenProvider } = {
      requiredCrossVendor: false,
    },
  ): JudgeSelection | null {
    const eligible = eligibleJudgeProviders(generatorProvider, opts.requiredCrossVendor);
    if (eligible.length === 0) return null;
    const ordered = opts.preferred && eligible.includes(opts.preferred)
      ? [opts.preferred, ...eligible.filter((p) => p !== opts.preferred)]
      : eligible;
    const provider = ordered[0]!;
    const pool = JUDGE_POOLS[provider];
    const model = opts.escalated && "escalated" in pool ? pool.escalated : pool.default;
    return { provider, model };
  }
}
