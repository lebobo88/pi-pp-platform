import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import {
  apiPaths,
  type ProviderStatus,
  type ProviderTestResult,
  type SetProviderKeyRequest,
  type OAuthLoginState,
  type OAuthLoginInputRequest,
  type OAuthLoginAbortResponse,
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

/** Begin a subscription (OAuth) login. Returns the initial OAuthLoginState. */
export function useStartProviderLogin(vendor: string) {
  return useMutation({
    mutationFn: () => api.post<OAuthLoginState>(apiPaths.providerLogin(vendor)),
  });
}

/** Supply a pending paste-a-code input to an in-flight login. */
export function useProviderLoginInput(loginId: string) {
  return useMutation({
    mutationFn: (value: string) =>
      api.post<OAuthLoginState>(apiPaths.providerLoginInput(loginId), { value } satisfies OAuthLoginInputRequest),
  });
}

/** Abort an in-flight login (called on cancel/close before completion). */
export function useAbortProviderLogin() {
  return useMutation({
    mutationFn: (loginId: string) => api.del<OAuthLoginAbortResponse>(apiPaths.providerLoginAbort(loginId)),
  });
}
