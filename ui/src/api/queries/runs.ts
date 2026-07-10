import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import {
  apiPaths,
  type RunSummary,
  type RunListResponse,
  type RunTree,
  type RunStatus,
  type ReplayBundle,
  type MissabilityCheckRow,
  type CompletionReadinessResponse,
  type EventLogEntry,
  type GateHistoryEntry,
  type RunComparisonResponse,
  API_BASE,
} from "@shared/api-types";

export interface RunsFilter {
  project_path?: string;
  status?: RunStatus;
  /** Page size — the server caps at 500 and defaults to 50. */
  limit?: number;
}

function runsUrl(filter: RunsFilter, cursor?: string): string {
  const params = new URLSearchParams();
  if (filter.project_path) params.set("project_path", filter.project_path);
  if (filter.status) params.set("status", filter.status);
  if (filter.limit != null) params.set("limit", String(filter.limit));
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  return qs ? `${apiPaths.runs}?${qs}` : apiPaths.runs;
}

/**
 * Normalize a page body. The server ships the `{items, next_cursor}` envelope;
 * keep a defensive wrap so a legacy bare array still renders (as a single page).
 */
function toPage(res: RunListResponse | RunSummary[]): RunListResponse {
  return Array.isArray(res) ? { items: res, next_cursor: null } : res;
}

/**
 * Cursor-paginated run listing over `GET /runs`.
 *
 * `data` is the flattened `RunSummary[]` across all loaded pages (so existing
 * consumers keep reading a plain list); the infinite-query controls
 * (`hasNextPage` / `fetchNextPage` / `isFetchingNextPage`) ride along for
 * pagination-aware screens. A `["runs"]` prefix invalidation refetches every
 * loaded page.
 */
export function useRuns(filter: RunsFilter = {}) {
  return useInfiniteQuery({
    queryKey: qk.runsInfinite(filter),
    queryFn: async ({ signal, pageParam }) =>
      toPage(await api.get<RunListResponse | RunSummary[]>(runsUrl(filter, pageParam), { signal })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    select: (data) => data.pages.flatMap((p) => p.items),
  });
}

export function useRun(runId: string | undefined) {
  return useQuery({
    queryKey: qk.run(runId ?? ""),
    queryFn: ({ signal }) => api.get<RunTree>(apiPaths.run(runId!), { signal }),
    enabled: !!runId,
  });
}

export function useRunEventLog(runId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.runEventLog(runId ?? ""),
    queryFn: ({ signal }) => api.get<EventLogEntry[]>(apiPaths.runEventLog(runId!), { signal }),
    enabled: !!runId && enabled,
  });
}

/**
 * Paginate GET /runs/:id/event-log until all events are fetched.
 *
 * The route clamps limit to [1, 1000] (default 200). We request 1000 per page
 * and follow the seq cursor until the server returns fewer rows than requested,
 * indicating exhaustion. Only enabled when `enabled` is true (gate on
 * run.finished_at so live runs keep using the SSE stream).
 */
export function useRunEventLogFull(runId: string | undefined, enabled = true) {
  const PAGE_SIZE = 1000;
  return useQuery({
    queryKey: qk.runEventLogFull(runId ?? ""),
    queryFn: async ({ signal }) => {
      const all: EventLogEntry[] = [];
      let since: number | undefined = undefined;
      while (true) {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (since != null) params.set("since", String(since));
        const url = `${API_BASE}/runs/${encodeURIComponent(runId!.toString())}/event-log?${params.toString()}`;
        const page = await api.get<EventLogEntry[]>(url, { signal });
        if (!Array.isArray(page) || page.length === 0) break;
        all.push(...page);
        if (page.length < PAGE_SIZE) break;
        // Advance cursor to the highest seq on this page.
        const lastSeq = Math.max(
          ...page.map((e) => ((e as unknown as { seq?: number }).seq ?? -1)),
        );
        if (lastSeq < 0) break;
        since = lastSeq;
      }
      return all;
    },
    enabled: !!runId && enabled,
    staleTime: 60_000,
  });
}

/**
 * Unified gate history for a run — fetched from GET /api/v1/runs/:id/gates.
 * Only enabled when `enabled` is true (gate it on run.finished_at, like
 * useRunEventLog, so live runs keep using the SSE stream).
 */
export function useRunGateHistory(runId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.runGateHistory(runId ?? ""),
    queryFn: ({ signal }) => api.get<GateHistoryEntry[]>(apiPaths.runGates(runId!), { signal }),
    enabled: !!runId && enabled,
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

/** Persisted Borda rankings (best-effort). The live ranking arrives via SSE. */
export function useRunBorda(runId: string | undefined) {
  return useQuery({
    queryKey: ["runs", "borda", runId ?? ""],
    queryFn: ({ signal }) =>
      api.get<Array<{ stage_id: string; borda: unknown }>>(apiPaths.runBorda(runId!), { signal }),
    enabled: !!runId,
  });
}

/**
 * Read-only completion-readiness blockers for a run (surfaced/incomplete
 * stages, remaining planned stages, missing artifacts, failed missability
 * checks, unpopulated master-plan sections). Drives the "Resume" action's
 * enabled state and the blocker-category breakdown in the run detail view.
 */
export function useRunCompletionReadiness(runId: string | undefined) {
  return useQuery({
    queryKey: qk.runCompletionReadiness(runId ?? ""),
    queryFn: ({ signal }) => api.get<CompletionReadinessResponse>(apiPaths.runCompletionReadiness(runId!), { signal }),
    enabled: !!runId,
  });
}

/**
 * Cross-run comparison data for 2–4 run ids.
 * Disabled when ids is empty or has fewer than 2 entries.
 */
export function useRunComparison(ids: string[]) {
  return useQuery({
    queryKey: qk.runsCompare(ids),
    queryFn: ({ signal }) => api.get<RunComparisonResponse>(apiPaths.runsCompare(ids), { signal }),
    enabled: ids.length >= 2,
  });
}
