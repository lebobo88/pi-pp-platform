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
  type AgentSummary,
  type AgentDetail,
  type SkillSummary,
  type SkillDetail,
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
    // The server wraps the spec: GET /teams/:name → { team, origin }. Unwrap
    // to a flat TeamSpec (origin merged) so callers get stages directly.
    queryFn: ({ signal }) =>
      api.get<{ team: TeamSpec; origin?: TeamSpec["origin"] }>(apiPaths.team(name!), { signal }),
    select: (raw) => ({ ...raw.team, origin: raw.origin ?? raw.team.origin }) as TeamSpec,
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

/** List omits the prompt body (AgentSummary); use useAgent for the detail. */
export function useAgents() {
  return useQuery({
    queryKey: qk.agents,
    queryFn: ({ signal }) => api.get<AgentSummary[]>(apiPaths.agents, { signal }),
    staleTime: 60_000,
  });
}

export function useAgent(id: string | undefined) {
  return useQuery({
    queryKey: qk.agent(id ?? ""),
    queryFn: ({ signal }) => api.get<AgentDetail>(apiPaths.agent(id!), { signal }),
    enabled: !!id,
    staleTime: 60_000,
  });
}

/** List omits the skill body (SkillSummary); use useSkill for the detail. */
export function useSkills() {
  return useQuery({
    queryKey: qk.skills,
    queryFn: ({ signal }) => api.get<SkillSummary[]>(apiPaths.skills, { signal }),
    staleTime: 60_000,
  });
}

export function useSkill(id: string | undefined) {
  return useQuery({
    queryKey: qk.skill(id ?? ""),
    queryFn: ({ signal }) => api.get<SkillDetail>(apiPaths.skill(id!), { signal }),
    enabled: !!id,
    staleTime: 60_000,
  });
}

export function useForums() {
  return useQuery({
    queryKey: qk.forums,
    queryFn: ({ signal }) => api.get<Forum[]>(apiPaths.forums, { signal }),
    staleTime: 60_000,
  });
}

/** Full forum (list rows are the summary subset; detail includes stages). */
export function useForum(id: string | undefined) {
  return useQuery({
    queryKey: qk.forum(id ?? ""),
    queryFn: ({ signal }) => api.get<Forum>(apiPaths.forum(id!), { signal }),
    enabled: !!id,
    staleTime: 60_000,
  });
}

export function useTaxonomy() {
  return useQuery({
    queryKey: qk.taxonomy,
    queryFn: ({ signal }) => api.get<TaxonomySection[]>(apiPaths.taxonomy, { signal }),
    staleTime: 60_000,
  });
}
