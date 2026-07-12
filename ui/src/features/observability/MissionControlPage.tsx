/**
 * MissionControlPage — global fleet dashboard at /observability.
 *
 * Architecture:
 *   - Fleet state comes from fleetStore (fed by global SSE stream only).
 *   - Run list data polled via useRuns (REST, 5s refetch).
 *   - Today's spend from the budgets endpoint (same as Budgets page).
 *   - NO per-run EventSource connections opened here.
 */
import { useMemo, useEffect } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Sparkline } from "@/components/Sparkline";
import { RunStatusChip } from "@/features/common/chips";
import { useRuns } from "@/api/queries/runs";
import { useBudgets } from "@/api/queries/budgets";
import { useFleet } from "@/stores/useFleet";
import { formatUsd, formatRelative, shortId, basename } from "@/lib/format";
import { FleetRunCard } from "./FleetRunCard";
import type { RunSummary } from "@shared/api-types";
import type { FleetEntry } from "@/stores/fleetStore";

/** Runs considered "needs attention" */
function needsAttention(run: RunSummary, entry: FleetEntry | undefined): boolean {
  const status = entry?.status ?? run.status;
  return status === "surfaced" || status === "crashed" || status === "aborted";
}

function todayScope(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `day:${y}-${m}-${d}`;
}

/* ── KPI stat strip ──────────────────────────────────────────────────── */

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
  to?: string;
  sparkData?: number[];
}

function KpiCard({ label, value, sub, highlight, to, sparkData }: KpiCardProps) {
  const inner = (
    <div
      className={`rounded-md border border-line-1 bg-bg-1 px-4 py-3 flex flex-col gap-0.5${to ? " group-hover:border-line-2 group-hover:bg-bg-2 transition-colors" : ""}`}
    >
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className={`mono text-[22px] font-semibold ${highlight ? "text-warn" : "text-ink-1"}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-ink-3">{sub}</div>}
      {sparkData && sparkData.length >= 2 && (
        <Sparkline data={sparkData} width={80} height={16} color="var(--accent)" fill className="mt-1 self-start" />
      )}
    </div>
  );

  if (to) {
    return (
      <Link
        to={to}
        aria-label={`${label}: ${value} — view budget history`}
        className="block group rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
      >
        {inner}
      </Link>
    );
  }

  return inner;
}

/* ── Needs-Attention lane ────────────────────────────────────────────── */

interface AttentionRowProps {
  run: RunSummary;
  entry: FleetEntry | undefined;
}

function AttentionRow({ run, entry }: AttentionRowProps) {
  const status = entry?.status ?? run.status;
  const reason = entry?.surfacedReason ?? entry?.abortReason ?? null;

  return (
    <div className="flex items-start gap-3 border-b border-line-1 px-3 py-2.5 last:border-b-0 hover:bg-bg-2 transition-colors">
      <div className="pt-0.5 shrink-0">
        <RunStatusChip status={status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Link
            to={`/runs/${run.id}/live`}
            className="mono text-[12px] font-medium text-accent hover:underline"
            title={run.id}
          >
            {shortId(run.id, 14)}
          </Link>
          <span className="text-[11px] text-ink-3 truncate" title={run.project_path}>
            {basename(run.project_path)}
          </span>
          <span className="mono text-[11px] text-ink-3">{formatRelative(run.started_at)}</span>
        </div>
        {reason && (
          <p className="mt-0.5 text-[11px] text-warn line-clamp-2">{reason}</p>
        )}
      </div>
      <Link
        to={`/runs/${run.id}`}
        className="shrink-0 mono rounded-sm border border-line-2 px-1.5 py-0.5 text-[10px] text-ink-3 opacity-70 hover:opacity-100"
      >
        detail
      </Link>
    </div>
  );
}

/* ── Main page ───────────────────────────────────────────────────────── */

/** Number of finished runs to show in the recent strip. */
const RECENT_STRIP_COUNT = 8;
const SPEND_SPARKLINE_DAYS = 7;

export function MissionControlPage() {
  // Poll run list at 5s for active runs
  const { data: runs = [], isLoading } = useRuns({ limit: 100 });

  // Refetch runs every 5s (fleet store keeps status live; REST fills in new runs)
  const qc = useQueryClient();
  useEffect(() => {
    const t = setInterval(() => {
      qc.invalidateQueries({ queryKey: ["runs"] });
    }, 5_000);
    return () => clearInterval(t);
  }, [qc]);
  // Today's spend
  const { data: budgets = [] } = useBudgets();
  const todayBudget = useMemo(() => {
    const scope = todayScope();
    return budgets.find((b) => b.scope === scope);
  }, [budgets]);

  const spendHistory = useMemo(() => {
    return budgets
      .filter((b) => /^day:\d{4}-\d{2}-\d{2}$/.test(b.scope))
      .sort((a, b) => a.scope.localeCompare(b.scope))
      .slice(-SPEND_SPARKLINE_DAYS)
      .map((b) => b.cost_usd);
  }, [budgets]);

  // Fleet store for live status overlay
  const fleet = useFleet();

  // Categorize runs
  const { active, attention, finished } = useMemo(() => {
    const active: RunSummary[] = [];
    const attention: RunSummary[] = [];
    const finished: RunSummary[] = [];

    for (const run of runs) {
      const entry = fleet.entries.get(run.id);
      const status = entry?.status ?? run.status;

      if (needsAttention(run, entry)) {
        attention.push(run);
      } else if (status === "running" || status === "pending") {
        active.push(run);
      } else {
        finished.push(run);
      }
    }

    // Finished: newest first, limited
    finished.sort((a, b) => b.started_at.localeCompare(a.started_at));
    return {
      active,
      attention,
      finished: finished.slice(0, RECENT_STRIP_COUNT),
    };
  }, [runs, fleet]);

  // Count surfaced-today: runs that finalized as surfaced or crashed today
  const today = new Date().toISOString().slice(0, 10);
  const surfacedToday = useMemo(
    () =>
      runs.filter((r) => {
        const entry = fleet.entries.get(r.id);
        const status = entry?.status ?? r.status;
        const ts = r.finished_at ?? r.started_at;
        return (status === "surfaced" || status === "crashed") && ts.startsWith(today);
      }).length,
    [runs, fleet, today],
  );

  return (
    <Page
      title="Mission Control"
      description="Global fleet dashboard — live status from the event stream, no per-run connections."
    >
      <div className="space-y-5">
        {/* KPI strip */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <KpiCard
            label="Active runs"
            value={String(active.length)}
            sub={isLoading ? "loading…" : `${runs.length} total`}
          />
          <KpiCard
            label="Today's spend"
            value={formatUsd(todayBudget?.cost_usd ?? 0)}
            sub={todayBudget ? `${todayBudget.tokens_in + todayBudget.tokens_out} tokens` : "—"}
            to="/budgets"
            sparkData={spendHistory}
          />
          <KpiCard
            label="Surfaced today"
            value={String(surfacedToday)}
            sub="needs attention"
            highlight={surfacedToday > 0}
          />
        </div>

        {/* Needs-Attention lane */}
        <Card title="Needs attention">
          {attention.length === 0 ? (
            <EmptyState
              title="All clear"
              description="No surfaced or crashed runs right now."
              compact
            />
          ) : (
            <div className="divide-y-0">
              {attention.map((run) => (
                <AttentionRow
                  key={run.id}
                  run={run}
                  entry={fleet.entries.get(run.id)}
                />
              ))}
            </div>
          )}
        </Card>

        {/* Active runs grid */}
        <section>
          <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wide text-ink-2">
            Active runs{active.length > 0 && ` (${active.length})`}
          </h2>
          {active.length === 0 ? (
            <div className="rounded-md border border-line-1 bg-bg-1">
              <EmptyState
                title="No active runs"
                description="Start a new run from the Runs page."
                compact
                actions={
                  <Link
                    to="/runs/new"
                    className="mono rounded-sm border border-accent/50 bg-accent/10 px-2 py-1 text-[11px] text-accent hover:bg-accent/20 transition-colors"
                  >
                    New run
                  </Link>
                }
              />
            </div>
          ) : (
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {active.map((run) => (
                <FleetRunCard
                  key={run.id}
                  run={run}
                  fleetEntry={fleet.entries.get(run.id)}
                />
              ))}
            </div>
          )}
        </section>

        {/* Recent finished strip */}
        {finished.length > 0 && (
          <Card title="Recent finished">
            <div className="-mx-3 -mb-3">
              {finished.map((run) => (
                <FleetRunCard
                  key={run.id}
                  run={run}
                  fleetEntry={fleet.entries.get(run.id)}
                  compact
                />
              ))}
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}
