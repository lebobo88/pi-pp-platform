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
import { getPlatformSetting, defaultLadderName, tierModelsFor, tierPoolsFor, CLAUDE_TIER_MODELS } from "@pp/core";
import { providerForModel, type Engine } from "@pp/engine";

type ResolvedModel = ReturnType<Engine["catalog"]["resolve"]>;

interface PersistedSettings {
  ladders?: Record<string, Record<string, string>>;
}

/**
 * Optional per-run override of the effective ladder — a project profile's
 * `ladder` / `tier_pools`. Layered ABOVE the global harness_settings ladder and
 * the catalog default. Absent (or empty) → resolution is byte-identical to the
 * pre-override behavior. Structurally satisfied by @pp/core's ProfileSpec, so a
 * caller can pass the resolved profile directly once it is threaded through
 * (REST/settings plumbing lands in a follow-up).
 */
export interface LadderOverride {
  ladder?: Record<string, string>;
  tier_pools?: Record<string, string[]>;
}

/**
 * tier → model id for the effective default ladder, layered low→high:
 *   catalog default ladder  <  global harness_settings ladder  <  profile ladder.
 * The base (settings-or-catalog) preserves the original replace-wholesale
 * behavior; the optional `override.ladder` merges per-tier ON TOP. With no
 * override the returned map is exactly what it was before this argument existed.
 */
export function effectiveLadderTiers(override?: LadderOverride): Record<string, string> {
  const settings = getPlatformSetting("harness_settings") as PersistedSettings | undefined;
  const name = defaultLadderName();
  const fromSettings = settings?.ladders?.[name];
  const base =
    fromSettings && Object.keys(fromSettings).length > 0
      ? fromSettings
      : Object.keys(tierModelsFor(name)).length > 0
        ? tierModelsFor(name)
        : (CLAUDE_TIER_MODELS as Record<string, string>);
  const over = override?.ladder;
  if (over && Object.keys(over).length > 0) return { ...base, ...over };
  return base;
}

/**
 * tier → model POOL for the effective default ladder: catalog pools with the
 * optional `override.tier_pools` (a project profile's pools) merged per-tier ON
 * TOP. Empty when nothing configured — the common case, which keeps
 * generationModelIdForTier on its single-model path.
 */
export function effectiveTierPools(override?: LadderOverride): Record<string, string[]> {
  const base = tierPoolsFor(defaultLadderName());
  const over = override?.tier_pools;
  if (over && Object.keys(over).length > 0) return { ...base, ...over };
  return base;
}

/**
 * Resolve a Claude tier name to its concrete model id via the effective ladder.
 *
 * When a POOL exists for the tier, rotate through it: pool[rotationIndex %
 * pool.length] (rotationIndex undefined → 0, i.e. the first attempt draws
 * pool[0]). When no pool is configured, this is the original single-model
 * lookup — byte-identical, so runs with tier_pools absent everywhere resolve
 * exactly as before.
 */
export function generationModelIdForTier(
  tier: string,
  rotationIndex?: number,
  override?: LadderOverride,
): string {
  const pool = effectiveTierPools(override)[tier];
  if (pool && pool.length > 0) {
    const i = ((rotationIndex ?? 0) % pool.length + pool.length) % pool.length;
    return pool[i]!;
  }
  const tiers = effectiveLadderTiers(override);
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
