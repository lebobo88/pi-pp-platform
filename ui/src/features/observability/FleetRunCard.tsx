/**
 * FleetRunCard — compact card for a single active/recent run in Mission Control.
 *
 * Data sources:
 *   - `run` from the REST list (RunSummary)
 *   - `fleetEntry` from fleetStore (live status overlay, cost, reasons)
 *
 * Links: primary → /runs/:id/live, secondary → /runs/:id
 */
import { Link } from "react-router";
import type { RunSummary } from "@shared/api-types";
import type { FleetEntry } from "@/stores/fleetStore";
import { RunStatusChip, ModeChip } from "@/features/common/chips";
import { formatUsd, formatDuration, formatRelative, shortId, basename } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useRunLoopCeiling } from "@/api/queries/runs";

/** `loop {calls}/{ceiling}` line — warn/fail tone past 80%/100%, hidden when no ceiling data yet. */
function LoopGuardLine({ runId, isActive }: { runId: string; isActive: boolean }) {
  const { data } = useRunLoopCeiling(runId, isActive ? 10_000 : undefined);
  if (!data || data.ceiling <= 0) return null;
  const pct = data.validator_calls / data.ceiling;
  const tone = pct >= 1 ? "text-fail" : pct >= 0.8 ? "text-warn" : "text-ink-2";
  return (
    <div className={cn("mono text-[11px]", tone)}>
      loop {data.validator_calls}/{data.ceiling}
    </div>
  );
}

export interface FleetRunCardProps {
  run: RunSummary;
  fleetEntry?: FleetEntry;
  /** When true, show a compact single-line row style instead of full card. */
  compact?: boolean;
}

function elapsed(startedAt: string, finishedAt: string | null): string {
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  return formatDuration(end - start);
}

export function FleetRunCard({ run, fleetEntry, compact = false }: FleetRunCardProps) {
  // Merge: live fleet status beats REST status for display
  const liveStatus = fleetEntry?.status ?? run.status;
  const isActive = liveStatus === "running" || liveStatus === "pending";
  const costUsd = fleetEntry?.costUsd ?? run.cost_usd;

  if (compact) {
    return (
      <div className="flex items-center justify-between gap-3 border-b border-line-1 px-3 py-2 last:border-b-0 hover:bg-bg-2 transition-colors">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to={`/runs/${run.id}/live`}
            className="mono text-[11px] text-accent hover:underline truncate"
            title={run.id}
          >
            {shortId(run.id, 14)}
          </Link>
          <RunStatusChip status={liveStatus} />
          <span className="min-w-0 truncate text-[11px] text-ink-3" title={run.request_text}>
            {run.request_text}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[11px] text-ink-3 mono">
          <span>{formatRelative(run.started_at)}</span>
          {costUsd != null && <span>{formatUsd(costUsd)}</span>}
          <Link
            to={`/runs/${run.id}`}
            className="text-[10px] text-ink-3 hover:text-ink-1 border border-line-2 rounded-sm px-1 py-0.5"
            title="Run detail"
          >
            detail
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-md border bg-bg-1 shadow-[0_1px_0_0_rgba(255,255,255,0.02)_inset] flex flex-col gap-2 p-3",
        isActive
          ? "border-run/40"
          : liveStatus === "surfaced" || liveStatus === "crashed"
            ? "border-warn/40"
            : "border-line-1",
      )}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Link
            to={`/runs/${run.id}/live`}
            className="mono text-[12px] font-medium text-accent hover:underline truncate"
            title={run.id}
          >
            {shortId(run.id, 14)}
          </Link>
          <span className="text-[11px] text-ink-3 truncate" title={run.project_path}>
            {basename(run.project_path)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <RunStatusChip status={liveStatus} />
        </div>
      </div>

      {/* Intent — what this run is doing, straight from the request */}
      <p className="text-[11px] leading-snug text-ink-2 line-clamp-2" title={run.request_text}>
        {run.request_text}
      </p>

      {/* Mode + elapsed */}
      <div className="flex items-center gap-2 flex-wrap">
        <ModeChip mode={run.mode} />
        <span className="mono text-[11px] text-ink-3">
          {elapsed(run.started_at, run.finished_at)}
        </span>
        <span className="mono text-[11px] text-ink-3">
          {formatRelative(run.started_at)}
        </span>
      </div>

      {/* Cost */}
      {costUsd != null && (
        <div className="mono text-[11px] text-ink-2">
          {formatUsd(costUsd)}
        </div>
      )}
      <LoopGuardLine runId={run.id} isActive={isActive} />

      {/* Footer links */}
      <div className="flex items-center gap-2 pt-0.5">
        <Link
          to={`/runs/${run.id}/live`}
          className={cn(
            "mono rounded-sm border px-1.5 py-0.5 text-[10px] transition-colors",
            isActive
              ? "border-run/50 bg-run/10 text-run hover:bg-run/20"
              : "border-line-2 text-ink-3 opacity-70 hover:opacity-100",
          )}
        >
          live
        </Link>
        <Link
          to={`/runs/${run.id}`}
          className="mono rounded-sm border border-line-2 px-1.5 py-0.5 text-[10px] text-ink-3 opacity-70 hover:opacity-100 transition-opacity"
        >
          detail
        </Link>
      </div>
    </div>
  );
}
