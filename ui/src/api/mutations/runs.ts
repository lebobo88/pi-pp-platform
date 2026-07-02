import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import {
  apiPaths,
  type StartRunRequest,
  type StartRunResponse,
  type AbortRunResponse,
  type StageActionResponse,
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
    mutationFn: (stageId: string) => api.post<StageActionResponse>(apiPaths.runStageRetry(runId, stageId)),
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
