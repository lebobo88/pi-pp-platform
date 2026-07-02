import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { apiPaths, type ArtifactContent } from "@shared/api-types";

/** Fetch a file/artifact body by path. Disabled for empty paths. */
export function useContent(path: string | undefined) {
  return useQuery({
    queryKey: ["content", path ?? ""],
    queryFn: ({ signal }) => api.get<ArtifactContent>(apiPaths.content(path!), { signal }),
    enabled: !!path,
    staleTime: 60_000,
  });
}
