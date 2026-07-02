import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import {
  apiPaths,
  type RunSummary,
  type RunTree,
  type RunStatus,
  type ReplayBundle,
  type MissabilityCheckRow,
} from "@shared/api-types";

export interface RunsFilter {
  project_path?: string;
  status?: RunStatus;
  limit?: number;
}

function runsUrl(filter: RunsFilter): string {
  const params = new URLSearchParams();
  if (filter.project_path) params.set("project_path", filter.project_path);
  if (filter.status) params.set("status", filter.status);
  if (filter.limit != null) params.set("limit", String(filter.limit));
  const qs = params.toString();
  return qs ? `${apiPaths.runs}?${qs}` : apiPaths.runs;
}

export function useRuns(filter: RunsFilter = {}) {
  return useQuery({
    queryKey: qk.runs(filter),
    queryFn: ({ signal }) => api.get<RunSummary[]>(runsUrl(filter), { signal }),
  });
}

export function useRun(runId: string | undefined) {
  return useQuery({
    queryKey: qk.run(runId ?? ""),
    queryFn: ({ signal }) => api.get<RunTree>(apiPaths.run(runId!), { signal }),
    enabled: !!runId,
  });
}

export function useRunReplay(runId: string | undefined) {
  return useQuery({
    queryKey: qk.runReplay(runId ?? ""),
    queryFn: ({ signal }) => api.get<ReplayBundle>(apiPaths.runReplay(runId!), { signal }),
    enabled: !!runId,
  });
}

export function useRunMissability(runId: string | undefined) {
  return useQuery({
    queryKey: qk.runMissability(runId ?? ""),
    queryFn: ({ signal }) => api.get<MissabilityCheckRow[]>(apiPaths.runMissability(runId!), { signal }),
    enabled: !!runId,
  });
}
