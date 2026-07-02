/**
 * Mapping helpers between @pp/core / @pp/engine shapes and the UI wire contract
 * (shared/api-types.ts). Kept in one place because several core shapes do NOT
 * match the wire shape 1:1 (see the deltas noted in each function).
 */
import { prices } from "@pp/core";
import { getProviderStatus, TIER_MODELS, type ProviderStatus as EngineProviderStatus } from "@pp/engine";

/** The AuthStorage type, derived from the engine signature (no pi dep in @pp/server). */
type AuthStorage = Parameters<typeof getProviderStatus>[0];

export type WireVendor = "openai" | "google" | "anthropic";
export const WIRE_VENDORS: readonly WireVendor[] = ["openai", "google", "anthropic"];

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
  return WIRE_VENDORS.map((v) => providerStatusWire(storage, v));
}

export interface WireModelInfo {
  id: string;
  vendor: WireVendor;
  tier: "fable" | "opus" | "sonnet" | "haiku" | null;
  input_per_1m: number;
  output_per_1m: number;
  note?: string;
}

/** id → tier for the pinned Claude models. */
const TIER_BY_ID: Record<string, WireModelInfo["tier"]> = Object.fromEntries(
  Object.entries(TIER_MODELS).map(([tier, m]) => [m.id, tier as WireModelInfo["tier"]]),
);

/**
 * Flatten the @pp/core price table into the UI ModelInfo list. The price table
 * is vendor→modelId→{input,output} (per-1M USD); tier is looked up from the
 * engine's TIER_MODELS. Vendors outside openai|google|anthropic are dropped.
 */
export function modelsWire(): WireModelInfo[] {
  const table = prices();
  const out: WireModelInfo[] = [];
  for (const [vendor, models] of Object.entries(table)) {
    if (!(WIRE_VENDORS as readonly string[]).includes(vendor)) continue;
    for (const [id, rate] of Object.entries(models)) {
      out.push({
        id,
        vendor: vendor as WireVendor,
        tier: TIER_BY_ID[id] ?? null,
        input_per_1m: rate.input,
        output_per_1m: rate.output,
      });
    }
  }
  return out;
}
