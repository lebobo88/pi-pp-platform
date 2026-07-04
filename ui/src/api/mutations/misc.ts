import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import {
  apiPaths,
  type EvolutionReviewRequest,
  type EvolutionReviewResponse,
  type BudgetCap,
  type SetBudgetCapsRequest,
  type DetectProfileResult,
  type WriteProfileRequest,
  type DoctorRunAck,
  type JanitorReport,
  type JanitorRunRequest,
  type HarnessSettings,
  type ProjectDetail,
  type RegisterProjectRequest,
} from "@shared/api-types";

export function useReviewProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string } & EvolutionReviewRequest) =>
      api.post<EvolutionReviewResponse>(apiPaths.evolutionReview(args.id), {
        decision: args.decision,
        note: args.note,
        // Reviewer-authored override body — REQUIRED by decision:"commit"
        // (the server 422s with `content_required` without it).
        content: args.content,
      } satisfies EvolutionReviewRequest),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.evolution }),
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

/** POST /profiles/detect — body {project_path}; returns a ProfileDetection. */
export function useDetectProfile(path: string) {
  return useMutation({
    mutationFn: () => api.post<DetectProfileResult>(apiPaths.profilesDetect, { project_path: path }),
  });
}

/** PUT /projects/:path/profile — apply a built-in by {name} or write {yaml}. */
export function useWriteProfile(path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: WriteProfileRequest) => api.put<unknown>(apiPaths.projectProfile(path), req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.project(path) });
      qc.invalidateQueries({ queryKey: qk.projects });
    },
  });
}

/**
 * POST /doctor — async: acks immediately, result arrives via SSE doctor.result.
 * `smoke: true` additionally runs the critique smoke test against each keyed
 * vendor (slow + costs tokens), so it defaults off.
 */
export function useRunDoctor() {
  return useMutation({
    mutationFn: (opts?: { smoke?: boolean }) =>
      api.post<DoctorRunAck>(apiPaths.doctor, { smoke: opts?.smoke ?? false }),
  });
}

/** POST /system/janitor — {dry_run: true} previews, otherwise executes. */
export function useRunJanitor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dry_run: boolean) => api.post<JanitorReport>(apiPaths.janitor, { dry_run } satisfies JanitorRunRequest),
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

export function useRegisterProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: RegisterProjectRequest) => api.post<ProjectDetail>(apiPaths.projects, req),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api.del<{ removed: boolean; path: string }>(apiPaths.project(path)),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects }),
  });
}
