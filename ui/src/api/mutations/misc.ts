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
  type DetectProfileResult,
  type WriteProfileRequest,
  type DoctorReport,
  type JanitorReport,
  type JanitorRunRequest,
  type HarnessSettings,
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

export function useDetectProfile(path: string) {
  return useMutation({
    mutationFn: () => api.post<DetectProfileResult>(apiPaths.projectProfileDetect(path)),
  });
}

export function useWriteProfile(path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: WriteProfileRequest) => api.put<{ ok: boolean }>(apiPaths.projectProfile(path), req),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.project(path) }),
  });
}

export function useRunDoctor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<DoctorReport>(apiPaths.doctor),
    onSuccess: (data) => qc.setQueryData(qk.doctor, data),
  });
}

export function useRunJanitor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (execute: boolean) => api.post<JanitorReport>(apiPaths.janitor, { execute } satisfies JanitorRunRequest),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.janitor }),
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: HarnessSettings) => api.put<HarnessSettings>(apiPaths.settings, settings),
    onSuccess: (data) => qc.setQueryData(["settings"], data),
  });
}
