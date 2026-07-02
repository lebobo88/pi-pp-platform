/**
 * Mapping helpers between @pp/core / @pp/engine shapes and the UI wire contract
 * (shared/api-types.ts). Kept in one place because several core shapes do NOT
 * match the wire shape 1:1 (see the deltas noted in each function).
 */
import { prices, enabledProviders, catalog } from "@pp/core";
import { getProviderStatus, type ProviderStatus as EngineProviderStatus } from "@pp/engine";

/** The AuthStorage type, derived from the engine signature (no pi dep in @pp/server). */
type AuthStorage = Parameters<typeof getProviderStatus>[0];

/** Open provider id (catalog provider space). */
export type WireVendor = string;

/** Enabled providers from the catalog, in catalog order. Reflects user
 * catalog.json overrides — prefer this over the WIRE_VENDORS snapshot. */
export function wireVendors(): string[] {
  return enabledProviders();
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
  return wireVendors().map((v) => providerStatusWire(storage, v));
}

export interface WireModelInfo {
  id: string;
  vendor: WireVendor;
  /** Ladder tier name (across all generation ladders) or null. */
  tier: string | null;
  input_per_1m: number;
  output_per_1m: number;
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

/**
 * Flatten the @pp/core price table into the UI ModelInfo list. The price table
 * is provider→modelId→{input,output} (per-1M USD); tier is looked up across the
 * catalog's generation ladders. Only enabled catalog providers are emitted.
 */
export function modelsWire(): WireModelInfo[] {
  const table = prices();
  const enabled = new Set(wireVendors());
  const byId = tierById();
  const out: WireModelInfo[] = [];
  for (const [vendor, models] of Object.entries(table)) {
    if (!enabled.has(vendor)) continue;
    for (const [id, rate] of Object.entries(models)) {
      out.push({ id, vendor, tier: byId[id] ?? null, input_per_1m: rate.input, output_per_1m: rate.output });
    }
  }
  return out;
}
