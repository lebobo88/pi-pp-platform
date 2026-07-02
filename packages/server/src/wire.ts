/**
 * Mapping helpers between @pp/core / @pp/engine shapes and the UI wire contract
 * (shared/api-types.ts). Kept in one place because several core shapes do NOT
 * match the wire shape 1:1 (see the deltas noted in each function).
 */
import { prices, enabledProviders, catalog } from "@pp/core";
import { getProviderStatus, listPiModels, providersWithCredential, type ProviderStatus as EngineProviderStatus } from "@pp/engine";

/** The AuthStorage type, derived from the engine signature (no pi dep in @pp/server). */
type AuthStorage = Parameters<typeof getProviderStatus>[0];

/** Open provider id (catalog provider space). */
export type WireVendor = string;

/** Enabled providers from the catalog, in catalog order. Reflects user
 * catalog.json overrides — prefer this over the WIRE_VENDORS snapshot. */
export function wireVendors(): string[] {
  return enabledProviders();
}

/**
 * Providers to surface as cards / in the model catalog: enabled catalog
 * providers PLUS any provider that has a stored credential — so a keyed provider
 * (e.g. deepseek/xai) always gets a card even before it is enabled in the
 * catalog. Catalog providers come first, then keyed-only ones.
 */
export function visibleProviders(storage: AuthStorage): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...enabledProviders(), ...providersWithCredential(storage)]) {
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/** Back-compat snapshot for importers expecting a constant. Prefer wireVendors(). */
export const WIRE_VENDORS: readonly WireVendor[] = enabledProviders();

/** Wire ProviderStatus (shared/api-types). */
export interface WireProviderStatus {
  vendor: WireVendor;
  configured: boolean;
  cli_installed: boolean;
  cli_version: string | null;
  has_api_key: boolean;
  logged_in: boolean;
  masked_key: string | null;
  degraded: boolean;
}

/**
 * Build the wire ProviderStatus from the engine's auth status. DELTA vs the
 * UI mock: the pi runtime has NO sub-CLIs, so cli_installed/cli_version/logged_in
 * are always false/null here (they were codex/gemini/copilot CLI fields in the
 * legacy daemon). `masked_key` carries only the engine's non-reversible
 * fingerprint — never a raw key.
 */
export function providerStatusWire(storage: AuthStorage, vendor: WireVendor): WireProviderStatus {
  const s: EngineProviderStatus = getProviderStatus(storage, vendor);
  return {
    vendor,
    configured: s.configured,
    cli_installed: false,
    cli_version: null,
    has_api_key: !!s.fingerprint,
    logged_in: false,
    masked_key: s.fingerprint ?? null,
    degraded: false,
  };
}

export function allProviderStatuses(storage: AuthStorage): WireProviderStatus[] {
  return visibleProviders(storage).map((v) => providerStatusWire(storage, v));
}

export interface WireModelInfo {
  id: string;
  vendor: WireVendor;
  /** Ladder tier name (across all generation ladders) or null. */
  tier: string | null;
  input_per_1m: number;
  output_per_1m: number;
  context_window?: number;
  note?: string;
}

/** id → tier, built across EVERY generation ladder (not just the Claude one). */
function tierById(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of Object.values(catalog().generation_ladders)) {
    for (const [tier, modelId] of Object.entries(l.tiers)) out[modelId] = tier;
  }
  return out;
}

/** pi model ids merged with any catalog-declared custom models, for one provider. */
export function modelsForProviderMerged(provider: string): WireModelInfo[] {
  const byId = tierById();
  const cat = catalog().providers[provider]?.models ?? {};
  const priceTable = prices()[provider] ?? {};
  const out: WireModelInfo[] = [];
  const seen = new Set<string>();
  for (const m of listPiModels(provider)) {
    seen.add(m.id);
    out.push({
      id: m.id,
      vendor: provider,
      tier: byId[m.id] ?? null,
      input_per_1m: m.input_per_1m,
      output_per_1m: m.output_per_1m,
      context_window: m.context_window,
    });
  }
  // Catalog-declared models pi does not ship (custom) — priced from the catalog.
  for (const [id, m] of Object.entries(cat)) {
    if (seen.has(id)) continue;
    const rate = priceTable[id];
    out.push({
      id,
      vendor: provider,
      tier: byId[id] ?? null,
      input_per_1m: rate?.input ?? m.input_per_1m,
      output_per_1m: rate?.output ?? m.output_per_1m,
    });
  }
  return out;
}

/**
 * The full UI model catalog: pi's models (with pricing + context) for every
 * visible provider (enabled catalog ∪ keyed), plus any catalog custom models.
 * Tiers are looked up across the catalog's generation ladders.
 */
export function modelsWire(storage: AuthStorage): WireModelInfo[] {
  const out: WireModelInfo[] = [];
  for (const provider of visibleProviders(storage)) {
    out.push(...modelsForProviderMerged(provider));
  }
  return out;
}
