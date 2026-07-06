/**
 * Generation-model resolution for the active (effective) generation ladder.
 *
 * The pilot's tier system stays Claude-tier-named (haiku/sonnet/opus/fable) for
 * escalation + audit, but the concrete model each tier maps to comes from the
 * EFFECTIVE ladder: the operator's persisted harness_settings ladder if present,
 * else the catalog's default ladder. The provider is DERIVED FROM THE MODEL, so
 * a ladder pointed at (say) deepseek models generates with deepseek — not the
 * hardcoded anthropic assumption the pilot used to make.
 */
import { getPlatformSetting, defaultLadderName, tierModelsFor, CLAUDE_TIER_MODELS } from "@pp/core";
import { providerForModel, type Engine } from "@pp/engine";

type ResolvedModel = ReturnType<Engine["catalog"]["resolve"]>;

interface PersistedSettings {
  ladders?: Record<string, Record<string, string>>;
}

/** tier → model id for the effective default ladder (settings override → catalog). */
export function effectiveLadderTiers(): Record<string, string> {
  const settings = getPlatformSetting("harness_settings") as PersistedSettings | undefined;
  const name = defaultLadderName();
  const fromSettings = settings?.ladders?.[name];
  if (fromSettings && Object.keys(fromSettings).length > 0) return fromSettings;
  const fromCatalog = tierModelsFor(name);
  return Object.keys(fromCatalog).length > 0 ? fromCatalog : (CLAUDE_TIER_MODELS as Record<string, string>);
}

/** Resolve a Claude tier name to its concrete model id via the effective ladder. */
export function generationModelIdForTier(tier: string): string {
  const tiers = effectiveLadderTiers();
  return (
    tiers[tier] ??
    (CLAUDE_TIER_MODELS as Record<string, string>)[tier] ??
    CLAUDE_TIER_MODELS.sonnet
  );
}

export interface GenerationModel {
  provider: string;
  model_id: string;
  model: ResolvedModel;
}

/** Resolve the concrete generation Model for a tier: effective-ladder model id
 * + model-derived provider, resolved through pi's ModelRegistry. */
export function resolveGenerationModel(engine: Engine, tier: string): GenerationModel {
  const model_id = generationModelIdForTier(tier);
  // Credential-aware: ambiguous ids resolve to a provider the engine can
  // actually authenticate against, not whichever vendor enumerates first.
  const provider = providerForModel(model_id, engine.authStorage);
  return { provider, model_id, model: engine.catalog.resolve(provider, model_id) };
}
