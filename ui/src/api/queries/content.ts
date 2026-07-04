import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { apiPaths, type ArtifactContent } from "@shared/api-types";

/**
 * Fetch a file/artifact body by path. Artifact paths are stored RELATIVE to the
 * project root, so pass `opts.runId` (or `opts.projectPath`) for the server to
 * resolve them; absolute paths need neither. Disabled for empty paths.
 */
export function useContent(path: string | undefined, opts?: { runId?: string; projectPath?: string }) {
  return useQuery({
    queryKey: ["content", path ?? "", opts?.runId ?? "", opts?.projectPath ?? ""],
    queryFn: ({ signal }) =>
      api.get<ArtifactContent>(apiPaths.content(path!, { runId: opts?.runId, projectPath: opts?.projectPath }), { signal }),
    enabled: !!path,
    staleTime: 60_000,
  });
}
