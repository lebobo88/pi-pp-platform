import { useEffect, useMemo, useState } from "react";
import type { BudgetEntry, BudgetCap } from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Meter } from "@/components/Meter";
import { Sparkline } from "@/components/Sparkline";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { useBudgets, useCaps } from "@/api/queries/budgets";
import { useSetCaps } from "@/api/mutations/misc";
import { toast } from "@/stores/uiStore";
import { formatUsd, formatTokens, formatRelative } from "@/lib/format";

function prefixOf(scope: string): string {
  return scope.split(":")[0] ?? scope;
}

export function BudgetsPage() {
  const { data: budgets, isLoading } = useBudgets();
  const { data: caps } = useCaps();

  const groups = useMemo(() => {
    const g = new Map<string, BudgetEntry[]>();
    for (const b of budgets ?? []) {
      const p = prefixOf(b.scope);
      const list = g.get(p) ?? [];
      list.push(b);
      g.set(p, list);
    }
    return g;
  }, [budgets]);

  const capFor = (prefix: string): BudgetCap | undefined => caps?.find((c) => c.scope === prefix);

  if (isLoading) return <Page title="Budgets"><EmptyState title="Loading…" compact /></Page>;

  const day = groups.get("day") ?? [];
  const run = groups.get("run") ?? [];
  const model = groups.get("model") ?? [];
  const tier = groups.get("tier") ?? [];

  return (
    <Page title="Budgets" description="Rolling token and cost totals by scope." className="space-y-4">
      <CapsEditor caps={caps ?? []} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <CappedScopeCard title="Day" entries={day} cap={capFor("day")} />
        <CappedScopeCard title="Run" entries={run} cap={capFor("run")} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BreakdownCard title="By model" entries={model} />
        <BreakdownCard title="By tier" entries={tier} />
      </div>
    </Page>
  );
}

/** Editable spend caps (limit + warn/block thresholds). */
function CapsEditor({ caps }: { caps: BudgetCap[] }) {
  const setCaps = useSetCaps();
  const [draft, setDraft] = useState<BudgetCap[]>(caps);
  useEffect(() => setDraft(caps), [caps]);

  const update = (scope: string, patch: Partial<BudgetCap>) =>
    setDraft((d) => d.map((c) => (c.scope === scope ? { ...c, ...patch } : c)));

  const dirty = JSON.stringify(draft) !== JSON.stringify(caps);

  if (caps.length === 0) return null;

  return (
    <Card
      title="Spend caps"
      actions={
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty || setCaps.isPending}
          onClick={() =>
            setCaps.mutate(draft, {
              onSuccess: () => toast({ tone: "success", title: "Caps saved" }),
              onError: (e) => toast({ tone: "error", title: "Save failed", message: e instanceof Error ? e.message : "" }),
            })
          }
        >
          {setCaps.isPending ? "Saving…" : "Save caps"}
        </Button>
      }
    >
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-ink-3">
            <th className="py-1 font-medium">scope</th>
            <th className="py-1 font-medium">limit (USD)</th>
            <th className="py-1 font-medium">warn %</th>
            <th className="py-1 font-medium">block %</th>
          </tr>
        </thead>
        <tbody>
          {draft.map((c) => (
            <tr key={c.scope}>
              <td className="mono py-1 pr-3 text-ink-1">{c.scope}</td>
              <td className="py-1 pr-3">
                <NumberInput value={c.limit_usd} step={0.5} min={0} onChange={(v) => update(c.scope, { limit_usd: v })} />
              </td>
              <td className="py-1 pr-3">
                <NumberInput value={Math.round(c.warn_pct * 100)} step={5} min={0} max={100} suffix="%" onChange={(v) => update(c.scope, { warn_pct: v / 100 })} />
              </td>
              <td className="py-1">
                <NumberInput value={Math.round(c.block_pct * 100)} step={5} min={0} max={100} suffix="%" onChange={(v) => update(c.scope, { block_pct: v / 100 })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function NumberInput({
  value,
  onChange,
  step,
  min,
  max,
  suffix,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mono tnum w-20 rounded-sm border border-line-2 bg-bg-2 px-1.5 py-0.5 text-[12px] text-ink-1 outline-none focus:border-accent"
      />
      {suffix && <span className="text-[11px] text-ink-3">{suffix}</span>}
    </span>
  );
}

function CappedScopeCard({ title, entries, cap }: { title: string; entries: BudgetEntry[]; cap?: BudgetCap }) {
  const entry = entries[0];
  if (!entry) return <Card title={title}><EmptyState title="No data" compact /></Card>;
  const limit = cap?.limit_usd ?? entry.cost_usd * 1.5;
  return (
    <Card title={title} actions={<span className="mono text-[11px] text-ink-3">{entry.scope}</span>}>
      <Meter
        value={entry.cost_usd}
        max={limit}
        label={cap ? `cap ${formatUsd(limit)}` : "no cap set"}
        readout={`${formatUsd(entry.cost_usd)} / ${formatUsd(limit)}`}
        ticks={cap ? [{ at: cap.warn_pct, tone: "warn" }, { at: cap.block_pct, tone: "fail" }] : []}
      />
      <div className="mt-2 flex items-center justify-between text-[11px] text-ink-3">
        <span className="mono tnum">{formatTokens(entry.tokens_in)} in · {formatTokens(entry.tokens_out)} out</span>
        <span>{formatRelative(entry.updated_at)}</span>
      </div>
    </Card>
  );
}

function BreakdownCard({ title, entries }: { title: string; entries: BudgetEntry[] }) {
  const spark = entries.map((e) => e.cost_usd);
  const columns: Column<BudgetEntry>[] = [
    { key: "scope", header: "scope", render: (e) => e.scope.split(":").slice(1).join(":") || e.scope, sortValue: (e) => e.scope, mono: true },
    { key: "tokens", header: "tokens", render: (e) => formatTokens(e.tokens_in + e.tokens_out), sortValue: (e) => e.tokens_in + e.tokens_out, mono: true, align: "right" },
    { key: "cost", header: "cost", render: (e) => formatUsd(e.cost_usd), sortValue: (e) => e.cost_usd, mono: true, align: "right" },
  ];
  return (
    <Card
      title={title}
      actions={spark.length > 1 ? <Sparkline data={spark} width={90} height={22} /> : undefined}
      flush
    >
      {entries.length === 0 ? (
        <EmptyState title="No data" compact />
      ) : (
        <DataTable columns={columns} rows={entries} rowKey={(e) => e.scope} initialSort={{ key: "cost", dir: "desc" }} />
      )}
    </Card>
  );
}
