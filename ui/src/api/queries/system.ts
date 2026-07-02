import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import {
  apiPaths,
  type DoctorReport,
  type EvolutionProposal,
  type JanitorReport,
  type HarnessSettings,
} from "@shared/api-types";

export function useHealth() {
  return useQuery({
    queryKey: qk.health,
    queryFn: ({ signal }) => api.get<{ ok: boolean; version?: string }>(apiPaths.health, { signal }),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

export function useDoctor() {
  return useQuery({
    queryKey: qk.doctor,
    queryFn: ({ signal }) => api.get<DoctorReport>(apiPaths.doctor, { signal }),
  });
}

export function useEvolutionProposals() {
  return useQuery({
    queryKey: qk.evolution,
    queryFn: ({ signal }) => api.get<EvolutionProposal[]>(apiPaths.evolution, { signal }),
  });
}

export function useJanitor() {
  return useQuery({
    queryKey: qk.janitor,
    queryFn: ({ signal }) => api.get<JanitorReport>(apiPaths.janitor, { signal }),
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api.get<HarnessSettings>(apiPaths.settings, { signal }),
    staleTime: 60_000,
  });
}
