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

/**
 * One persisted harness_settings ladder: tier → model id, plus an optional
 * reserved `tier_pools` key (mirrors the catalog ladder + the wire
 * HarnessLadder). Every other key is a tier name.
 */
interface PersistedLadder {
  [tier: string]: string | Record<string, string[]> | undefined;
  tier_pools?: Record<string, string[]>;
}

interface PersistedSettings {
  ladders?: Record<string, PersistedLadder>;
}

/** The persisted ladder's tier→model map, with the reserved `tier_pools` key stripped. */
function settingsTiers(l: PersistedLadder | undefined): Record<string, string> {
  if (!l) return {};
  const out: Record<string, string> = {};
  for (const [tier, v] of Object.entries(l)) {
    if (tier === "tier_pools") continue;
    if (typeof v === "string") out[tier] = v;
  }
  return out;
}

/** The persisted ladder's per-tier pools (empty when none). */
function settingsPools(l: PersistedLadder | undefined): Record<string, string[]> {
  const p = l?.tier_pools;
  return p && typeof p === "object" ? p : {};
}

/**
 * Optional TOP-precedence override of the effective ladder — the per-tier
 * `ladder` / `tier_pools` merge that the caller assembles from the per-run
 * request override (highest) layered over the project profile. Applied ABOVE
 * the global harness_settings ladder and the catalog default. Absent (or empty)
 * → resolution is byte-identical to the pre-override behavior.
 */
export interface LadderOverride {
  ladder?: Record<string, string>;
  tier_pools?: Record<string, string[]>;
}

/**
 * Assemble the TOP-precedence {@link LadderOverride} for a run: the per-run
 * request override (highest) layered per-tier OVER the project profile's
 * `ladder` / `tier_pools` (per-run wins each tier it names). `undefined` inputs
 * are treated as empty; when nothing is supplied at either level the result is
 * `undefined` and resolution stays byte-identical. The resolver then applies the
 * result ABOVE the global harness_settings ladder and the catalog default —
 * completing the precedence chain
 *
 *   per-run override > project profile > harness_settings ladder > catalog default
 *
 * for BOTH tiers and tier_pools.
 */
export function mergeLadderOverride(
  profileLadder?: Record<string, string | undefined>,
  profilePools?: Record<string, string[] | undefined>,
  perRunLadder?: Record<string, string | undefined>,
  perRunPools?: Record<string, string[] | undefined>,
): LadderOverride | undefined {
  const ladder: Record<string, string> = {};
  for (const [tier, v] of Object.entries({ ...(profileLadder ?? {}), ...(perRunLadder ?? {}) })) {
    if (typeof v === "string" && v.length > 0) ladder[tier] = v;
  }
  const tier_pools: Record<string, string[]> = {};
  for (const [tier, v] of Object.entries({ ...(profilePools ?? {}), ...(perRunPools ?? {}) })) {
    if (Array.isArray(v) && v.length > 0) tier_pools[tier] = v;
  }
  const hasLadder = Object.keys(ladder).length > 0;
  const hasPools = Object.keys(tier_pools).length > 0;
  if (!hasLadder && !hasPools) return undefined;
  return {
    ...(hasLadder ? { ladder } : {}),
    ...(hasPools ? { tier_pools } : {}),
  };
}

/**
 * tier → model id for the effective default ladder, layered per-tier low→high:
 *
 *   catalog default  <  global harness_settings.ladders[name]  <  override
 *
 * where `override` is the caller's merged (per-run over profile) top layer. The
 * base merges settings tiers ON TOP of the catalog per-tier (settings wins the
 * tiers it names, catalog fills the rest); the override then wins the tiers it
 * names. With no settings and no override the map equals the catalog default —
 * byte-identical to the pre-precedence behavior.
 */
export function effectiveLadderTiers(override?: LadderOverride): Record<string, string> {
  const settings = getPlatformSetting("harness_settings") as PersistedSettings | undefined;
  const name = defaultLadderName();
  const catalogTiers =
    Object.keys(tierModelsFor(name)).length > 0
      ? tierModelsFor(name)
      : (CLAUDE_TIER_MODELS as Record<string, string>);
  const base = { ...catalogTiers, ...settingsTiers(settings?.ladders?.[name]) };
  const over = override?.ladder;
  if (over && Object.keys(over).length > 0) return { ...base, ...over };
  return base;
}

/**
 * tier → model POOL for the effective default ladder, layered per-tier low→high:
 *
 *   catalog tier_pools  <  global harness_settings.ladders[name].tier_pools  <  override
 *
 * Prior to this the settings layer was silently dropped (only the catalog pools
 * + override were consulted), so a tier_pool configured ONLY in harness_settings
 * never took effect and the documented precedence was false. Empty when nothing
 * is configured at any layer — the common case, which keeps
 * generationModelIdForTier on its single-model path.
 */
export function effectiveTierPools(override?: LadderOverride): Record<string, string[]> {
  const settings = getPlatformSetting("harness_settings") as PersistedSettings | undefined;
  const name = defaultLadderName();
  const base = { ...tierPoolsFor(name), ...settingsPools(settings?.ladders?.[name]) };
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

/**
 * Availability-aware pool rotation for the errored-attempt infra retry. Scans
 * the tier's pool starting at `rotationIndex` for the first model whose provider
 * the caller reports available (via {@link isModelAvailable} — typically the
 * health-registry `isProviderAvailable`), so a quota/rate-limited provider is
 * skipped rather than re-hit. When NO pool model is available (or no pool is
 * configured) it falls back to the plain rotation at `rotationIndex`: the filter
 * only ever reorders WITHIN an existing pool — it never invents a model, and the
 * caller's own two-error-then-surface guard still bounds the retries.
 */
export function generationModelIdForTierAvailable(
  tier: string,
  rotationIndex: number,
  override: LadderOverride | undefined,
  isModelAvailable: (modelId: string) => boolean,
): string {
  const pool = effectiveTierPools(override)[tier];
  if (pool && pool.length > 0) {
    for (let step = 0; step < pool.length; step++) {
      const i = (((rotationIndex + step) % pool.length) + pool.length) % pool.length;
      if (isModelAvailable(pool[i]!)) return pool[i]!;
    }
  }
  // No pool, or every pool model is cooled down — take the plain rotation.
  return generationModelIdForTier(tier, rotationIndex, override);
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
