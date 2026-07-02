import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { apiPaths, type ProviderStatus, type ModelInfo, type InstallableProvider } from "@shared/api-types";

export function useProviders() {
  return useQuery({
    queryKey: qk.providers,
    queryFn: ({ signal }) => api.get<ProviderStatus[]>(apiPaths.providers, { signal }),
  });
}

/** The installable provider set (catalog + curated pi providers) for the add-provider picker. */
export function useAvailableProviders() {
  return useQuery({
    queryKey: ["providers", "available"] as const,
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
