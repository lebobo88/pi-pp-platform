import { useMemo } from "react";
import { useNavigate, Link } from "react-router";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Meter } from "@/components/Meter";
import { StatusChip, StatusDot } from "@/components/StatusChip";
import { EmptyState } from "@/components/EmptyState";
import { DataTable, type Column } from "@/components/DataTable";
import { RunStatusChip, ModeChip, Pill } from "@/features/common/chips";
import { useRuns } from "@/api/queries/runs";
import { useBudgets, useCaps } from "@/api/queries/budgets";
import { useProviders } from "@/api/queries/providers";
import { useDoctor } from "@/api/queries/system";
import { runTone } from "@/lib/status";
import { formatUsd, formatRelative, formatElapsed, basename, shortId } from "@/lib/format";
import { OnboardingChecklist } from "./OnboardingChecklist";
import type { RunSummary } from "@shared/api-types";

export function DashboardPage() {
  const navigate = useNavigate();
  const { data: runs } = useRuns({ limit: 50 });
  const { data: budgets } = useBudgets();
  const { data: caps } = useCaps();
  const { data: providers } = useProviders();
  const { data: doctor } = useDoctor();

  const active = useMemo(() => (runs ?? []).filter((r) => r.status === "running" || r.status === "pending"), [runs]);
  const surfaced = useMemo(() => (runs ?? []).filter((r) => r.status === "surfaced"), [runs]);
  const recent = useMemo(() => (runs ?? []).slice(0, 6), [runs]);

  const today = new Date().toISOString().slice(0, 10);
  const daySpend =
    budgets?.find((b) => b.scope === `day:${today}`)?.cost_usd ??
    budgets?.find((b) => b.scope.startsWith("day:"))?.cost_usd ??
    0;
  const dayCap = caps?.find((c) => c.scope === "day")?.limit_usd;

  const recentColumns: Column<RunSummary>[] = [
    { key: "id", header: "Run", render: (r) => shortId(r.id, 12), sortValue: (r) => r.id, mono: true },
    { key: "request", header: "Request", render: (r) => <span className="line-clamp-1">{r.request_text}</span>, sortValue: (r) => r.request_text },
    { key: "mode", header: "Mode", render: (r) => <ModeChip mode={r.mode} /> },
    { key: "status", header: "Status", render: (r) => <RunStatusChip status={r.status} /> },
    { key: "cost", header: "Cost", render: (r) => formatUsd(r.cost_usd), sortValue: (r) => r.cost_usd ?? 0, mono: true, align: "right" },
    { key: "when", header: "Started", render: (r) => formatRelative(r.started_at), sortValue: (r) => r.started_at, mono: true, align: "right" },
  ];

  return (
    <Page title="Dashboard" description="Live harness overview." className="space-y-4">
      {/* First-launch checklist — only while the harness has zero runs. */}
      {runs != null && runs.length === 0 && <OnboardingChecklist />}

      {/* Surfaced-runs banner (persistent) */}
      {surfaced.length > 0 && (
        <div className="rounded-md border border-[color-mix(in_srgb,var(--warn)_45%,transparent)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] px-3 py-2">
          <div className="flex items-center gap-2">
            <StatusDot tone="warn" />
            <span className="text-[13px] font-medium text-ink-1">
              {surfaced.length} run{surfaced.length > 1 ? "s" : ""} surfaced for review
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {surfaced.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => navigate(`/runs/${r.id}`)}
                className="mono rounded-sm border border-line-2 bg-bg-2 px-2 py-1 text-[11px] text-ink-1 hover:border-warn"
              >
                {shortId(r.id, 12)} · {basename(r.project_path)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Active runs strip */}
      <Card title="Active runs">
        {active.length === 0 ? (
          <EmptyState title="No active runs" description="Dispatch one from New run." compact />
        ) : (
          <div className="flex flex-wrap gap-2">
            {active.map((r) => (
              <div key={r.id} className="flex items-stretch gap-0 rounded-md border border-line-1 bg-bg-2 hover:border-run">
                <button
                  type="button"
                  onClick={() => navigate(`/runs/${r.id}`)}
                  className="flex items-center gap-2 px-3 py-2 text-left"
                >
                  <StatusDot tone={runTone(r.status)} pulse />
                  <span className="min-w-0">
                    <span className="mono block text-[11px] text-ink-3">{shortId(r.id, 12)}</span>
                    <span className="block max-w-[220px] truncate text-[12px] text-ink-1">{r.request_text}</span>
                  </span>
                  <span className="mono tnum ml-2 text-[11px] text-ink-3">{formatElapsed(r.started_at, r.finished_at)}</span>
                </button>
                <Link
                  to={`/runs/${r.id}/live`}
                  title="Live Observatory view"
                  className="mono flex items-center border-l border-line-1 px-2 text-[10px] text-run hover:bg-run/10"
                >
                  live
                </Link>
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Day budget — capped meter only when a day cap is configured; never
            a fabricated max (same rule as TopBar). */}
        <Card title="Today's budget">
          {dayCap != null ? (
            <>
              <Meter
                value={daySpend}
                max={dayCap}
                label="Spend"
                readout={`${formatUsd(daySpend)} / ${formatUsd(dayCap)}`}
                ticks={[{ at: 0.8, tone: "warn" }, { at: 1, tone: "fail" }]}
              />
              <p className="mt-2 text-[11px] text-ink-3">Downgrade at 80%, block at 100%.</p>
            </>
          ) : (
            <div className="flex items-baseline justify-between gap-2" title="No day cap configured">
              <span className="text-[11px] text-ink-3">Spend</span>
              <span className="mono tnum text-[12px] text-ink-1">{formatUsd(daySpend)}</span>
            </div>
          )}
        </Card>

        {/* Provider status row */}
        <Card title="Providers">
          <div className="flex flex-wrap gap-2">
            {(providers ?? []).map((p) => (
              <StatusChip
                key={p.vendor}
                tone={p.degraded ? "warn" : p.configured ? "pass" : "dim"}
                label={p.vendor}
                title={p.degraded ? "degraded" : p.configured ? "configured" : "not configured"}
              />
            ))}
            {(!providers || providers.length === 0) && <span className="text-[12px] text-ink-3">No providers.</span>}
          </div>
        </Card>

        {/* Doctor summary */}
        <Card title="Health">
          {doctor ? (
            <div className="space-y-1.5 text-[12px]">
              <Row label="DB reachable" ok={doctor.db_reachable} />
              <Row label="Cross-vendor ready" ok={doctor.cross_vendor_ready} />
              <div className="flex items-center gap-1.5 pt-1">
                {Object.entries(doctor.vendors_configured).map(([v, ok]) => (
                  <Pill key={v} tone={ok ? "run" : "default"}>{v}{ok ? " ✓" : " ✕"}</Pill>
                ))}
              </div>
            </div>
          ) : (
            <span className="text-[12px] text-ink-3">Doctor unavailable.</span>
          )}
        </Card>
      </div>

      {/* Recent runs */}
      <Card title="Recent runs" flush>
        <DataTable
          columns={recentColumns}
          rows={recent}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/runs/${r.id}`)}
          initialSort={{ key: "when", dir: "desc" }}
          empty={<EmptyState title="No runs yet" compact />}
        />
      </Card>
    </Page>
  );
}

function Row({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-2">{label}</span>
      <StatusChip tone={ok ? "pass" : "fail"} label={ok ? "yes" : "no"} />
    </div>
  );
}
