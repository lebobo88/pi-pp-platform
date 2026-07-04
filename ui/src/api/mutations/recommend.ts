import { useMutation } from "@tanstack/react-query";
import { api } from "@/api/client";
import {
  apiPaths,
  type TeamRecommendRequest,
  type TeamRecommendResponse,
} from "@shared/api-types";

/**
 * POST /teams/recommend — deterministic team-recommendation heuristics (no
 * model calls server-side). Modelled as a mutation because it's a POST scored
 * per request body; callers keep the latest response in mutation state.
 */
export function useRecommendTeams() {
  return useMutation({
    mutationFn: (req: TeamRecommendRequest) =>
      api.post<TeamRecommendResponse>(apiPaths.teamsRecommend, req),
  });
}
