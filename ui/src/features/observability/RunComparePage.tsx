/**
 * RunComparePage — side-by-side comparison of 2–4 runs at /runs/compare.
 *
 * URL: /runs/compare?ids=run_a,run_b[,run_c,run_d]
 *
 * Shows:
 *   • Per-run summary cards (cost, tokens, duration, stages, pass rate)
 *   • Stage-by-stage aligned table (cost/tokens/verdict per run per stage kind)
 *   • Stacked per-stage cost bars (pure Tailwind div bars)
 *   • Model usage breakdown table
 */
import { useMemo } from "react";
import { useSearchParams, Link } from "react-router";
import { useRunComparison } from "@/api/queries/runs";
import type { RunComparisonStageRow, RunComparisonTotals } from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { formatUsd, formatTokens, formatDuration, shortId } from "@/lib/format";

/* ── Colour palette for N runs (up to 4) ─────────────────────────────── */

const RUN_COLOURS = [
  "bg-blue-500",
  "bg-purple-500",
  "bg-emerald-500",
  "bg-amber-500",
] as const;

const RUN_TEXT_COLOURS = [
  "text-blue-400",
  "text-purple-400",
  "text-emerald-400",
  "text-amber-400",
] as const;

/* ── Helpers ──────────────────────────────────────────────────────────── */

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function verdictColour(outcome: string | null): string {
  if (outcome === "pass") return "text-emerald-400";
  if (outcome === "fail") return "text-red-400";
  if (outcome === "revise") return "text-amber-400";
  return "text-ink-3";
}

/* ── Per-run summary card ─────────────────────────────────────────────── */

interface SummaryCardProps {
  runId: string;
  totals: RunComparisonTotals;
  colourIdx: number;
}

function SummaryCard({ runId, totals, colourIdx }: SummaryCardProps) {
  const textColour = RUN_TEXT_COLOURS[colourIdx] ?? "text-ink-1";
  return (
    <Card title={<span className={textColour}>{shortId(runId, 16)}</span>}>
      <div className="space-y-1.5 text-[12px]">
        <div className="flex justify-between gap-2">
          <span className="text-ink-3">Cost</span>
          <span className="mono tnum text-ink-1">{formatUsd(totals.cost_usd)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-3">Tokens in</span>
          <span className="mono tnum text-ink-1">{formatTokens(totals.tokens_in)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-3">Tokens out</span>
          <span className="mono tnum text-ink-1">{formatTokens(totals.tokens_out)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-3">Duration</span>
          <span className="mono tnum text-ink-1">{formatDuration(totals.wall_ms)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-3">Stages</span>
          <span className="mono tnum text-ink-1">{totals.stage_count}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-3">Pass rate</span>
          <span className="mono tnum text-ink-1">{pct(totals.pass_rate)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink-3">Reflexion retries</span>
          <span className="mono tnum text-ink-1">{totals.reflexion_count}</span>
        </div>
      </div>
    </Card>
  );
}

/* ── Stage table ──────────────────────────────────────────────────────── */

interface StageTableProps {
  runIds: string[];
  rows: RunComparisonStageRow[];
}

function StageTable({ runIds, rows }: StageTableProps) {
  if (rows.length === 0) {
    return <EmptyState title="No stage data" compact />;
  }

  // Max cost across all (run, stage) slots for bar scaling.
  const maxCost = Math.max(
    1e-9,
    ...rows.flatMap((r) =>
      runIds.map((id) => r.per_run[id]?.cost ?? 0),
    ),
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-ink-3">
            <th className="py-1.5 pr-3 font-medium">Stage</th>
            {runIds.map((id, i) => (
              <th key={id} className={`py-1.5 px-2 font-medium ${RUN_TEXT_COLOURS[i] ?? ""}`}>
                {shortId(id, 14)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.stage_kind}-${row.plan_order}`}
              className="border-t border-line-1"
            >
              <td className="py-1.5 pr-3">
                <span className="mono text-ink-1">{row.stage_kind}</span>
                {row.plan_order > 0 && (
                  <span className="ml-1 text-[10px] text-ink-3">#{row.plan_order + 1}</span>
                )}
              </td>
              {runIds.map((id, colIdx) => {
                const slot = row.per_run[id];
                if (!slot) {
                  return (
                    <td key={id} className="px-2 py-1.5 text-ink-3">
                      —
                    </td>
                  );
                }
                const barPct = maxCost > 0 ? (slot.cost / maxCost) * 100 : 0;
                const colour = RUN_COLOURS[colIdx] ?? "bg-blue-500";
                return (
                  <td key={id} className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      {/* Stacked cost bar */}
                      <div className="h-1.5 w-16 rounded-full bg-bg-3">
                        <div
                          className={`h-full rounded-full ${colour} opacity-70`}
                          style={{ width: `${barPct}%` }}
                        />
                      </div>
                    </div>
                    <div className="mt-0.5 space-y-0.5">
                      <div className="mono tnum text-ink-1">{formatUsd(slot.cost)}</div>
                      <div className="mono tnum text-[10px] text-ink-3">
                        {formatTokens(slot.tokens)} tok
                      </div>
                      <div className={`text-[10px] font-medium ${verdictColour(slot.winning_verdict_outcome)}`}>
                        {slot.winning_verdict_outcome ?? slot.status}
                      </div>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Model usage table ────────────────────────────────────────────────── */

interface ModelUsageTableProps {
  runIds: string[];
  perRun: Record<string, RunComparisonTotals>;
}

function ModelUsageTable({ runIds, perRun }: ModelUsageTableProps) {
  // Union of all model ids across all runs.
  const allModels = useMemo(() => {
    const s = new Set<string>();
    for (const id of runIds) {
      for (const m of Object.keys(perRun[id]?.model_usage ?? {})) {
        s.add(m);
      }
    }
    return [...s].sort();
  }, [runIds, perRun]);

  if (allModels.length === 0) {
    return <EmptyState title="No model data" compact />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-ink-3">
            <th className="py-1.5 pr-3 font-medium">Model</th>
            {runIds.map((id, i) => (
              <th key={id} className={`py-1.5 px-2 font-medium ${RUN_TEXT_COLOURS[i] ?? ""}`}>
                {shortId(id, 14)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {allModels.map((model) => (
            <tr key={model} className="border-t border-line-1">
              <td className="mono py-1.5 pr-3 text-ink-1">{model}</td>
              {runIds.map((id) => {
                const usage = perRun[id]?.model_usage[model];
                if (!usage) {
                  return (
                    <td key={id} className="px-2 py-1.5 text-ink-3">
                      —
                    </td>
                  );
                }
                return (
                  <td key={id} className="px-2 py-1.5">
                    <div className="mono tnum text-ink-1">{formatUsd(usage.cost)}</div>
                    <div className="mono tnum text-[10px] text-ink-3">
                      {formatTokens(usage.tokens)} tok · {usage.stages} stage{usage.stages !== 1 ? "s" : ""}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────── */

export function RunComparePage() {
  const [params] = useSearchParams();
  const rawIds = params.get("ids") ?? "";
  const ids = rawIds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const { data, isLoading, error } = useRunComparison(ids);

  if (ids.length < 2) {
    return (
      <Page title="Compare Runs">
        <EmptyState
          title="Select 2–4 runs to compare"
          description="Use the checkboxes on the Runs list page to pick runs, then click Compare Selected."
        />
      </Page>
    );
  }

  if (isLoading) {
    return (
      <Page title="Compare Runs">
        <div className="p-6 text-center text-[12px] text-ink-3">Loading comparison…</div>
      </Page>
    );
  }

  if (error || !data) {
    const msg =
      error instanceof Error ? error.message : "One or more run ids not found.";
    return (
      <Page title="Compare Runs">
        <EmptyState title="Could not load comparison" description={msg} />
      </Page>
    );
  }

  const runIds = data.run_ids;

  return (
    <Page
      title="Compare Runs"
      description={
        <span>
          Comparing {runIds.length} runs.{" "}
          <Link to="/runs" className="underline hover:text-ink-1">
            Back to runs
          </Link>
        </span>
      }
      className="space-y-4"
    >
      {/* Summary cards — one per run */}
      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: `repeat(${runIds.length}, minmax(0, 1fr))` }}
      >
        {runIds.map((id, i) => (
          <SummaryCard
            key={id}
            runId={id}
            totals={data.per_run[id]!}
            colourIdx={i}
          />
        ))}
      </div>

      {/* Stage-by-stage aligned table */}
      <Card title="Stage breakdown" flush>
        <div className="p-3">
          <StageTable runIds={runIds} rows={data.stage_rows} />
        </div>
      </Card>

      {/* Model usage breakdown */}
      <Card title="Model usage" flush>
        <div className="p-3">
          <ModelUsageTable runIds={runIds} perRun={data.per_run} />
        </div>
      </Card>
    </Page>
  );
}
