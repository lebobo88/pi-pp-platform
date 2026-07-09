import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import {
  apiPaths,
  type StartRunRequest,
  type StartRunResponse,
  type AbortRunResponse,
  type StageActionResponse,
  type StageRetryRequest,
  type RunResumeResponse,
} from "@shared/api-types";

export function useStartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: StartRunRequest) => api.post<StartRunResponse>(apiPaths.runs, req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}

export function useAbortRun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<AbortRunResponse>(apiPaths.runAbort(runId)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.run(runId) });
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}

export function useRetryStage(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ stageId, override }: { stageId: string; override?: boolean }) =>
      api.post<StageActionResponse>(
        apiPaths.runStageRetry(runId, stageId),
        override ? ({ override: true } satisfies StageRetryRequest) : undefined,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.run(runId) }),
  });
}

export function useGateStage(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (stageId: string) => api.post<StageActionResponse>(apiPaths.runStageGate(runId, stageId)),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.run(runId) }),
  });
}

/**
 * Reopen a surfaced/blocked run on the same run_id: continues any remaining
 * planned stages, then reruns missability/master-plan/finalize. See
 * packages/pilot/src/resume.ts. `resumed: false` in the response means the
 * attempt made no forward progress (e.g. a surfaced stage still blocks it, or
 * another resume/execute is already active) — check `readiness` for why.
 */
export function useResumeRun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<RunResumeResponse>(apiPaths.runResume(runId)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.run(runId) });
      qc.invalidateQueries({ queryKey: qk.runCompletionReadiness(runId) });
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
  });
}
