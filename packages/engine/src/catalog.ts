/**
 * ModelCatalog — resolves platform tiers / judge pools to concrete pi Models
 * over a ModelRegistry backed by the platform AuthStorage.
 *
 * Tier + judge tables live here for M2. The pilot unifies these with
 * @pp/core config.ts in M3 — @pp/core is intentionally left untouched.
 */
import { ModelRegistry, type AuthStorage } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai/compat";
import {
  ladder as catalogLadder,
  judgePool,
  judgePoolProviders,
  killSwitchEnvFor,
  type JudgePoolEntry,
} from "@pp/core";
import type { GenProvider } from "./envelope.js";
import { projectCatalogModelsJson } from "./catalog-to-modelsjson.js";
import { splitQualifiedModelId } from "./models.js";

/** Default-ladder tier names. Open string: a ladder can define any tier set. */
export type Tier = string;

interface TierModel { provider: GenProvider; id: string }

/** Build the default-ladder tier→model map from the catalog. */
function buildTierModels(): Record<string, TierModel> {
  const l = catalogLadder();
  const provider = l?.provider ?? "anthropic";
  const out: Record<string, TierModel> = {};
  for (const [tier, id] of Object.entries(l?.tiers ?? {})) {
    out[tier] = { provider, id };
  }
  return out;
}

/**
 * Platform tier → concrete pinned model, derived from the catalog's default
 * generation ladder. Computed at module load; the default catalog reproduces
 * the historical all-Anthropic map exactly.
 */
export const TIER_MODELS: Record<Tier, TierModel> = buildTierModels();

export interface JudgePool { default: string; escalated?: string }

/**
 * Build cross-provider judge pools (keyed by provider) from a list of entries.
 * Defaults to the catalog's judge pool when no entries are provided.
 * First entry per provider wins; `escalated` is only added when the entry defines it.
 */
export function buildJudgePools(entries: JudgePoolEntry[] = judgePool()): Record<string, JudgePool> {
  const out: Record<string, JudgePool> = {};
  for (const e of entries) {
    if (out[e.provider]) continue; // first entry per provider wins
    out[e.provider] = e.escalated ? { default: e.model, escalated: e.escalated } : { default: e.model };
  }
  return out;
}

/** Cross-provider judge pools, keyed by provider. */
export const JUDGE_POOLS: Record<string, JudgePool> = buildJudgePools();

/** True when a provider is disabled via its per-provider kill switch
 * (PP_DISABLE_<PROVIDER>, e.g. PP_DISABLE_OPENAI, PP_DISABLE_MISTRAL). */
export function isProviderDisabled(provider: GenProvider): boolean {
  return process.env[killSwitchEnvFor(provider)] === "1";
}

/**
 * The judge providers eligible for a given generator.
 *
 * - iterates the supplied pool providers (defaults to the catalog judge pool),
 * - honors the per-provider kill switches (PP_DISABLE_<PROVIDER>),
 * - when `requiredCrossVendor` is true, excludes the generator's own provider
 *   (the generalized JUDGE-1 cross-vendor → cross-provider invariant).
 *
 * The optional third argument lets callers supply an operator-configured pool
 * (from harness_settings.judge_pool) so settings-over-catalog precedence is
 * honored without changing the kill-switch or cross-vendor logic.
 */
export function eligibleJudgeProviders(
  generatorProvider: GenProvider,
  requiredCrossVendor: boolean,
  poolProviders: string[] = judgePoolProviders(),
): GenProvider[] {
  return poolProviders.filter((p) => {
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
    // When the catalog enables providers/models pi does not ship, they are
    // projected into a models.json under the platform dir; pi merges it
    // (custom wins). For the default (all pi-shipped) catalog this is undefined
    // and behavior is identical to passing no path.
    const path = modelsJsonPath ?? projectCatalogModelsJson();
    this.registry = ModelRegistry.create(authStorage, path);
  }

  /** Resolve a concrete model. Throws if the provider/id is not in the registry.
   * Accepts provider-qualified ids ("openai/gpt-5.5") wherever a bare id is
   * legal: when the qualifier names the same provider, the bare id resolves. */
  resolve(provider: string, id: string): Model<Api> {
    const qualified = splitQualifiedModelId(id);
    const bareId = qualified.provider === provider ? qualified.model : id;
    const model = this.registry.find(provider, bareId);
    if (!model) {
      const err = this.registry.getError();
      throw new Error(
        `model "${provider}/${bareId}" not found in ModelRegistry` + (err ? ` (models.json error: ${err})` : ""),
      );
    }
    return model;
  }

  /** Resolve a platform tier to its pinned model. */
  resolveTier(tier: Tier): Model<Api> {
    const t = TIER_MODELS[tier];
    if (!t) throw new Error(`unknown tier "${tier}" — not in the default generation ladder`);
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
    if (!pool) return null;
    const model = opts.escalated && pool.escalated ? pool.escalated : pool.default;
    return { provider, model };
  }
}
