import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { apiPaths, type Project } from "@shared/api-types";

export function useProjects() {
  return useQuery({
    queryKey: qk.projects,
    queryFn: ({ signal }) => api.get<Project[]>(apiPaths.projects, { signal }),
  });
}
