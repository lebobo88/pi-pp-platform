import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { apiPaths, type ProviderStatus, type ModelInfo } from "@shared/api-types";

export function useProviders() {
  return useQuery({
    queryKey: qk.providers,
    queryFn: ({ signal }) => api.get<ProviderStatus[]>(apiPaths.providers, { signal }),
  });
}

export function useModels() {
  return useQuery({
    queryKey: qk.models,
    queryFn: ({ signal }) => api.get<ModelInfo[]>(apiPaths.models, { signal }),
    staleTime: 60_000,
  });
}
