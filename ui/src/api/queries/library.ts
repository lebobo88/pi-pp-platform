import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import {
  apiPaths,
  type TeamSpec,
  type ProfileSpec,
  type RubricInfo,
  type Forum,
  type TaxonomySection,
} from "@shared/api-types";

export function useTeams() {
  return useQuery({
    queryKey: qk.teams,
    queryFn: ({ signal }) => api.get<TeamSpec[]>(apiPaths.teams, { signal }),
  });
}

export function useTeam(name: string | undefined) {
  return useQuery({
    queryKey: qk.team(name ?? ""),
    queryFn: ({ signal }) => api.get<TeamSpec>(apiPaths.team(name!), { signal }),
    enabled: !!name,
  });
}

export function useProfiles() {
  return useQuery({
    queryKey: qk.profiles,
    queryFn: ({ signal }) => api.get<ProfileSpec[]>(apiPaths.profiles, { signal }),
  });
}

export function useProfile(name: string | undefined) {
  return useQuery({
    queryKey: qk.profile(name ?? ""),
    queryFn: ({ signal }) => api.get<ProfileSpec>(apiPaths.profile(name!), { signal }),
    enabled: !!name,
  });
}

export function useRubrics() {
  return useQuery({
    queryKey: qk.rubrics,
    queryFn: ({ signal }) => api.get<RubricInfo[]>(apiPaths.rubrics, { signal }),
  });
}

export function useRubric(id: string | undefined) {
  return useQuery({
    queryKey: qk.rubric(id ?? ""),
    queryFn: ({ signal }) => api.get<RubricInfo>(apiPaths.rubric(id!), { signal }),
    enabled: !!id,
  });
}

export function useForums() {
  return useQuery({
    queryKey: ["forums"],
    queryFn: ({ signal }) => api.get<Forum[]>(apiPaths.forums, { signal }),
    staleTime: 60_000,
  });
}

export function useTaxonomy() {
  return useQuery({
    queryKey: ["taxonomy"],
    queryFn: ({ signal }) => api.get<TaxonomySection[]>(apiPaths.taxonomy, { signal }),
    staleTime: 60_000,
  });
}
