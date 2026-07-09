import type { ClaudeTier, ModelInfo } from "@shared/api-types";

export interface ModelRoutingCatalog {
  configuredProviders: string[];
  catalogModels: ModelInfo[];
  liveModelsByProvider?: Map<string, string[]>;
  providerLabels?: Map<string, string>;
}

export interface ProviderModelChoice {
  provider: string;
  providerLabel: string;
  modelId: string;
  canonical: string;
  label: string;
}

export type ResolvedProviderModelChoice =
  | {
      ok: true;
      provider: string;
      providerLabel: string;
      modelId: string;
      canonical: string;
      label: string;
    }
  | {
      ok: false;
      reason: "empty" | "unknown" | "provider_unconfigured" | "ambiguous";
      raw: string;
      provider?: string;
      modelId?: string;
      providers?: string[];
    };

export function providerModelCanonical(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export function parseProviderModelCanonical(value: string): { provider: string; modelId: string } | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

export function providerModelLabel(provider: string, modelId: string, providerLabels?: Map<string, string>): string {
  return `${providerLabels?.get(provider) ?? provider} / ${modelId}`;
}

export function buildProviderModelChoices(catalog: ModelRoutingCatalog): ProviderModelChoice[] {
  const configured = new Set(catalog.configuredProviders);
  const choices: ProviderModelChoice[] = [];
  const seen = new Set<string>();
  const push = (provider: string, modelId: string) => {
    if (!configured.has(provider)) return;
    const canonical = providerModelCanonical(provider, modelId);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    const providerLabel = catalog.providerLabels?.get(provider) ?? provider;
    choices.push({
      provider,
      providerLabel,
      modelId,
      canonical,
      label: `${providerLabel} / ${modelId}`,
    });
  };

  for (const model of catalog.catalogModels) push(model.vendor, model.id);
  for (const provider of catalog.configuredProviders) {
    for (const modelId of catalog.liveModelsByProvider?.get(provider) ?? []) push(provider, modelId);
  }
  return choices;
}

function providerModelSet(catalog: ModelRoutingCatalog, provider: string): Set<string> {
  const ids = new Set<string>();
  for (const model of catalog.catalogModels) {
    if (model.vendor === provider) ids.add(model.id);
  }
  for (const modelId of catalog.liveModelsByProvider?.get(provider) ?? []) ids.add(modelId);
  return ids;
}

export function resolveProviderModelChoice(rawValue: string, catalog: ModelRoutingCatalog): ResolvedProviderModelChoice {
  const raw = rawValue.trim();
  if (!raw) return { ok: false, reason: "empty", raw };

  const configured = new Set(catalog.configuredProviders);
  const parsed = parseProviderModelCanonical(raw);
  if (parsed) {
    if (!configured.has(parsed.provider)) {
      return { ok: false, reason: "provider_unconfigured", raw, provider: parsed.provider, modelId: parsed.modelId };
    }
    const ids = providerModelSet(catalog, parsed.provider);
    if (!ids.has(parsed.modelId)) {
      return { ok: false, reason: "unknown", raw, provider: parsed.provider, modelId: parsed.modelId };
    }
    const providerLabel = catalog.providerLabels?.get(parsed.provider) ?? parsed.provider;
    return {
      ok: true,
      provider: parsed.provider,
      providerLabel,
      modelId: parsed.modelId,
      canonical: providerModelCanonical(parsed.provider, parsed.modelId),
      label: `${providerLabel} / ${parsed.modelId}`,
    };
  }

  const providers = catalog.configuredProviders.filter((provider) => providerModelSet(catalog, provider).has(raw));
  if (providers.length === 1) {
    const provider = providers[0]!;
    const providerLabel = catalog.providerLabels?.get(provider) ?? provider;
    return {
      ok: true,
      provider,
      providerLabel,
      modelId: raw,
      canonical: providerModelCanonical(provider, raw),
      label: `${providerLabel} / ${raw}`,
    };
  }
  if (providers.length > 1) {
    return { ok: false, reason: "ambiguous", raw, modelId: raw, providers };
  }
  return { ok: false, reason: "unknown", raw, modelId: raw };
}

export function normalizeLadderOverrides(
  overrides: Partial<Record<ClaudeTier, string>>,
  catalog: ModelRoutingCatalog,
): { ok: true; value: Partial<Record<ClaudeTier, string>> } | { ok: false; tier: ClaudeTier; error: ResolvedProviderModelChoice } {
  const next: Partial<Record<ClaudeTier, string>> = {};
  for (const [tier, value] of Object.entries(overrides) as Array<[ClaudeTier, string]>) {
    const resolved = resolveProviderModelChoice(value, catalog);
    if (!resolved.ok) return { ok: false, tier, error: resolved };
    next[tier] = resolved.canonical;
  }
  return { ok: true, value: next };
}

export function normalizeTierPoolOverrides(
  overrides: Partial<Record<ClaudeTier, string[]>>,
  catalog: ModelRoutingCatalog,
): { ok: true; value: Partial<Record<ClaudeTier, string[]>> } | { ok: false; tier: ClaudeTier; index: number; error: ResolvedProviderModelChoice | "duplicate" } {
  const next: Partial<Record<ClaudeTier, string[]>> = {};
  for (const [tier, pool] of Object.entries(overrides) as Array<[ClaudeTier, string[]]>) {
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const [index, value] of pool.entries()) {
      const resolved = resolveProviderModelChoice(value, catalog);
      if (!resolved.ok) return { ok: false, tier, index, error: resolved };
      if (seen.has(resolved.canonical)) return { ok: false, tier, index, error: "duplicate" };
      seen.add(resolved.canonical);
      normalized.push(resolved.canonical);
    }
    if (normalized.length > 0) next[tier] = normalized;
  }
  return { ok: true, value: next };
}
