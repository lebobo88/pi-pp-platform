import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import {
  apiPaths,
  type Project,
  type ProjectDetail,
  type DocContent,
  type ProjectProfileDocument,
} from "@shared/api-types";

export function useProjects() {
  return useQuery({
    queryKey: qk.projects,
    queryFn: ({ signal }) => api.get<Project[]>(apiPaths.projects, { signal }),
  });
}

export function useProject(path: string | undefined) {
  return useQuery({
    queryKey: qk.project(path ?? ""),
    queryFn: ({ signal }) => api.get<ProjectDetail>(apiPaths.project(path!), { signal }),
    enabled: !!path,
  });
}

export function useProjectProfile(path: string | undefined) {
  return useQuery({
    queryKey: qk.projectProfile(path ?? ""),
    queryFn: ({ signal }) => api.get<ProjectProfileDocument | null>(apiPaths.projectProfile(path!), { signal }),
    enabled: !!path,
  });
}

export function useMasterPlan(path: string | undefined) {
  return useQuery({
    queryKey: qk.projectDoc(path ?? "", "master-plan"),
    queryFn: ({ signal }) => api.get<DocContent>(apiPaths.projectMasterPlan(path!), { signal }),
    enabled: !!path,
  });
}

export function useAgentsMd(path: string | undefined) {
  return useQuery({
    queryKey: qk.projectDoc(path ?? "", "agents-md"),
    queryFn: ({ signal }) => api.get<DocContent>(apiPaths.projectAgentsMd(path!), { signal }),
    enabled: !!path,
  });
}

export function useConstitution(path: string | undefined) {
  return useQuery({
    queryKey: qk.projectDoc(path ?? "", "constitution"),
    queryFn: ({ signal }) => api.get<DocContent>(apiPaths.projectConstitution(path!), { signal }),
    enabled: !!path,
  });
}
