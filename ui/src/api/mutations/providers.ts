import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import {
  apiPaths,
  type ProviderStatus,
  type ProviderTestResult,
  type SetProviderKeyRequest,
} from "@shared/api-types";

/** Write-only key set. The raw key leaves the client only in this request. */
export function useSetProviderKey(vendor: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (api_key: string) =>
      api.put<ProviderStatus>(apiPaths.providerKey(vendor), { api_key } satisfies SetProviderKeyRequest),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.providers }),
  });
}

export function useTestProvider(vendor: string) {
  return useMutation({
    mutationFn: () => api.post<ProviderTestResult>(apiPaths.providerTest(vendor)),
  });
}

export function useDeleteProviderKey(vendor: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del<ProviderStatus>(apiPaths.providerKey(vendor)),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.providers }),
  });
}
