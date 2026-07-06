import { useState } from "react";
import { useNavigate, Link } from "react-router";
import type { RunSummary, RunStatus } from "@shared/api-types";
import { RUN_STATUS } from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { RunStatusChip, ModeChip } from "@/features/common/chips";
import { useRuns } from "@/api/queries/runs";
import { useUiStore } from "@/stores/uiStore";
import { formatUsd, formatElapsed, formatRelative, shortId, basename } from "@/lib/format";

/** Server page size — small enough that "Load more" is exercised on real history. */
const PAGE_SIZE = 25;

export function RunsPage() {
  const navigate = useNavigate();
  const activeProject = useUiStore((s) => s.activeProjectPath);
  const [status, setStatus] = useState<RunStatus | "">("");

  const {
    data: runs,
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useRuns({
    project_path: activeProject ?? undefined,
    status: status || undefined,
    limit: PAGE_SIZE,
  });

  // Client-side sorting over a partial page would mislead (rows beyond the
  // cursor are missing), so headers only sort once all pages are loaded.
  const sortable = !hasNextPage;
  const sortVal = <V extends string | number>(fn: (r: RunSummary) => V) => (sortable ? fn : undefined);

  const columns: Column<RunSummary>[] = [
    { key: "id", header: "Run", render: (r) => shortId(r.id, 14), sortValue: sortVal((r) => r.id), mono: true, width: 130 },
    {
      key: "request",
      header: "Request",
      render: (r) => <span className="line-clamp-1 text-ink-1">{r.request_text}</span>,
      sortValue: sortVal((r) => r.request_text),
    },
    { key: "project", header: "Project", render: (r) => basename(r.project_path), sortValue: sortVal((r) => r.project_path), mono: true, width: 130 },
    { key: "mode", header: "Mode", render: (r) => <ModeChip mode={r.mode} />, sortValue: sortVal((r) => r.mode), width: 90 },
    { key: "status", header: "Status", render: (r) => <RunStatusChip status={r.status} />, sortValue: sortVal((r) => r.status), width: 110 },
    { key: "cost", header: "Cost", render: (r) => formatUsd(r.cost_usd), sortValue: sortVal((r) => r.cost_usd ?? 0), mono: true, align: "right", width: 80 },
    { key: "dur", header: "Duration", render: (r) => formatElapsed(r.started_at, r.finished_at), sortValue: sortVal((r) => Date.parse(r.finished_at ?? new Date().toISOString()) - Date.parse(r.started_at)), mono: true, align: "right", width: 90 },
    { key: "started", header: "Started", render: (r) => formatRelative(r.started_at), sortValue: sortVal((r) => r.started_at), mono: true, align: "right", width: 110 },
    {
      key: "live",
      header: "",
      width: 48,
      render: (r) => {
        const isActive = r.status === "running" || r.status === "pending";
        return (
          <Link
            to={`/runs/${r.id}/live`}
            onClick={(e) => e.stopPropagation()}
            title="Live view"
            className={isActive
              ? "mono rounded-sm border border-run/50 bg-run/10 px-1.5 py-0.5 text-[10px] text-run hover:bg-run/20"
              : "mono rounded-sm border border-line-2 px-1.5 py-0.5 text-[10px] text-ink-3 opacity-50 hover:opacity-80"}
          >
            live
          </Link>
        );
      },
    },
  ];

  return (
    <Page
      title="Runs"
      description="History across all projects. Filter with the project picker or by status."
      actions={<Button variant="primary" onClick={() => navigate("/runs/new")}>New run</Button>}
    >
      <Card
        flush
        title="History"
        actions={
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as RunStatus | "")}
            className="h-6 rounded-sm border border-line-2 bg-bg-2 px-1.5 text-[11px] text-ink-1 outline-none hover:border-ink-3"
          >
            <option value="">all statuses</option>
            {RUN_STATUS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        }
      >
        {isLoading ? (
          <div className="p-6 text-center text-[12px] text-ink-3">Loading runs…</div>
        ) : (
          <DataTable
            columns={columns}
            rows={runs ?? []}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/runs/${r.id}`)}
            initialSort={{ key: "started", dir: "desc" }}
            empty={<EmptyState title="No runs" description="No runs match the current filters." compact />}
            stickyHeader
          />
        )}
      </Card>

      <div className="mt-3 flex justify-center">
        <Button
          size="sm"
          variant="ghost"
          disabled={!hasNextPage || isFetchingNextPage}
          onClick={() => fetchNextPage()}
        >
          {isLoading || isFetchingNextPage ? "Loading…" : hasNextPage ? "Load more" : "End of history"}
        </Button>
      </div>
    </Page>
  );
}
