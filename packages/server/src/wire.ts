/**
 * Mapping helpers between @pp/core / @pp/engine shapes and the UI wire contract
 * (shared/api-types.ts). Kept in one place because several core shapes do NOT
 * match the wire shape 1:1 (see the deltas noted in each function).
 */
import { prices, enabledProviders, catalog } from "@pp/core";
import {
  getProviderStatus,
  listPiModels,
  providersWithCredential,
  providersWithCliLogin,
  getProviderHealth,
  type ProviderStatus as EngineProviderStatus,
  type ProviderHealth,
  type ProviderHealthEntry,
} from "@pp/engine";

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
 * providers PLUS any provider that has a stored credential PLUS any provider
 * with a locally logged-in vendor CLI / subscription — so a keyed provider
 * (e.g. deepseek/xai) or a subscription-logged-in provider (e.g. github-copilot)
 * always gets a card even before it is enabled in the catalog. Catalog providers
 * come first, then keyed-/login-only ones.
 */
export function visibleProviders(storage: AuthStorage): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of [...enabledProviders(), ...providersWithCredential(storage), ...providersWithCliLogin()]) {
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

/** Back-compat snapshot for importers expecting a constant. Prefer wireVendors(). */
export const WIRE_VENDORS: readonly WireVendor[] = enabledProviders();

/** Wire ProviderBalance (shared/api-types). */
export interface WireProviderBalance {
  amount: number;
  currency: string;
  as_of: string;
}

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
  /** Live health-registry state (WS2). Additive/optional across the wire. */
  health?: ProviderHealth;
  last_error?: string;
  last_error_at?: string;
  cooldown_until?: string;
  balance?: WireProviderBalance;
}

/** Fold the engine's health-registry entry (epoch-ms timestamps) into the
 * additive wire fields (ISO timestamps). `unknown` health is omitted so a
 * never-observed provider's payload stays byte-identical to the pre-WS2 shape. */
function healthWireFields(h: ProviderHealthEntry): Partial<WireProviderStatus> {
  const out: Partial<WireProviderStatus> = {};
  if (h.health !== "unknown") out.health = h.health;
  if (h.last_error) out.last_error = h.last_error;
  if (h.last_error_at != null) out.last_error_at = new Date(h.last_error_at).toISOString();
  if (h.cooldown_until != null) out.cooldown_until = new Date(h.cooldown_until).toISOString();
  if (h.balance) {
    out.balance = {
      amount: h.balance.amount,
      currency: h.balance.currency,
      as_of: new Date(h.balance.as_of).toISOString(),
    };
  }
  return out;
}

/**
 * Build the wire ProviderStatus from the engine's auth status. DELTA vs the
 * UI mock: the pi runtime has NO sub-CLIs, so cli_installed/cli_version are
 * always false/null here (they were codex/gemini/copilot CLI-binary fields in
 * the legacy daemon). `logged_in`, however, is REAL: it reflects a locally
 * logged-in vendor CLI / subscription session detected on disk (distinct from
 * `configured`, which means pi can actually resolve a usable key). `masked_key`
 * carries only the engine's non-reversible fingerprint — never a raw key.
 */
export function providerStatusWire(storage: AuthStorage, vendor: WireVendor): WireProviderStatus {
  const s: EngineProviderStatus = getProviderStatus(storage, vendor);
  return {
    vendor,
    configured: s.configured,
    cli_installed: false,
    cli_version: null,
    has_api_key: !!s.fingerprint,
    logged_in: s.loggedIn,
    masked_key: s.fingerprint ?? null,
    degraded: false,
    // Enrich with live health-registry state (health, last error, cooldown,
    // last-known balance). All fields additive/optional — a never-observed
    // provider adds nothing beyond the pre-WS2 shape.
    ...healthWireFields(getProviderHealth(vendor)),
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
