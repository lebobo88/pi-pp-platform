import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import {
  apiPaths,
  type ProviderStatus,
  type ModelInfo,
  type InstallableProvider,
  type ProviderModels,
} from "@shared/api-types";

/**
 * Query key for one provider's live model-id list. Parameterized on the vendor,
 * so it lives here beside the hook (the shared `qk` map carries only the static
 * provider keys); the models/refresh mutation reuses it to seed the cache.
 */
export const providerModelsKey = (vendor: string) => ["providers", vendor, "models"] as const;

/** GET /providers/:vendor/models — pi's model ids for one provider (ladder / judge-pool autocomplete). */
export function useProviderModels(vendor: string) {
  return useQuery({
    queryKey: providerModelsKey(vendor),
    queryFn: ({ signal }) => api.get<ProviderModels>(apiPaths.providerModels(vendor), { signal }),
    enabled: vendor.length > 0,
    staleTime: 60_000,
  });
}

export function useProviders() {
  return useQuery({
    queryKey: qk.providers,
    queryFn: ({ signal }) => api.get<ProviderStatus[]>(apiPaths.providers, { signal }),
  });
}

/** The installable provider set (catalog + curated pi providers) for the add-provider picker. */
export function useAvailableProviders() {
  return useQuery({
    queryKey: qk.providersAvailable,
    queryFn: ({ signal }) => api.get<InstallableProvider[]>(apiPaths.providersAvailable, { signal }),
    staleTime: 30_000,
  });
}

export function useModels() {
  return useQuery({
    queryKey: qk.models,
    queryFn: ({ signal }) => api.get<ModelInfo[]>(apiPaths.models, { signal }),
    staleTime: 60_000,
  });
}
