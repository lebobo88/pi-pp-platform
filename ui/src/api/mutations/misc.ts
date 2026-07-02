import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import {
  apiPaths,
  type EvolutionProposal,
  type EvolutionReviewRequest,
  type ProfileBootstrapRequest,
  type BudgetCap,
  type SetBudgetCapsRequest,
} from "@shared/api-types";

export function useReviewProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string } & EvolutionReviewRequest) =>
      api.post<EvolutionProposal>(apiPaths.evolutionReview(args.id), {
        decision: args.decision,
        note: args.note,
      } satisfies EvolutionReviewRequest),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.evolution }),
  });
}

export function useBootstrapProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: ProfileBootstrapRequest) =>
      api.post<{ ok: boolean }>(apiPaths.profileBootstrap, req),
    onSuccess: (_data, req) => {
      qc.invalidateQueries({ queryKey: qk.project(req.project_path) });
      qc.invalidateQueries({ queryKey: qk.projects });
    },
  });
}

export function useSetCaps() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (caps: BudgetCap[]) =>
      api.put<BudgetCap[]>(apiPaths.budgetCaps, { caps } satisfies SetBudgetCapsRequest),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.budgetCaps }),
  });
}
