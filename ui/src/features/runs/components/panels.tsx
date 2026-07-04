import { useState } from "react";
import type { RunTree, ArtifactRow } from "@shared/api-types";
import { Card } from "@/components/Card";
import { DataTable, type Column } from "@/components/DataTable";
import { DiffView } from "@/components/DiffView";
import { Markdown } from "@/components/Markdown";
import { EmptyState } from "@/components/EmptyState";
import { CopyButton } from "@/components/CopyButton";
import { StatusChip } from "@/components/StatusChip";
import { Meter } from "@/components/Meter";
import { Pill } from "@/features/common/chips";
import { formatBytes, formatUsd, formatTokens, shortId, basename } from "@/lib/format";
import { costBreakdown, taxonomyCoverage, runTotals, type CostBreakdownRow } from "@/lib/runModel";
import { useRunMissability, useRunReplay } from "@/api/queries/runs";
import { useContent } from "@/api/queries/content";

/* ── Artifacts ─────────────────────────────────────────────────────────── */

export function ArtifactsPanel({ tree }: { tree: RunTree }) {
  const [selected, setSelected] = useState<ArtifactRow | null>(tree.artifacts[0] ?? null);
  const { data: doc } = useContent(selected?.path);
  if (tree.artifacts.length === 0) {
    return <EmptyState title="No artifacts" compact />;
  }
  const content = doc?.content ?? null;
  const isDiff = doc?.kind === "diff" || selected?.kind === "diff" || selected?.path.endsWith(".diff");

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <Card title="Artifacts" flush>
        <ul className="divide-y divide-line-1">
          {tree.artifacts.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setSelected(a)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-2 ${selected?.id === a.id ? "bg-bg-2" : ""}`}
              >
                <span className="min-w-0">
                  <span className="mono block truncate text-[12px] text-ink-1">{basename(a.path)}</span>
                  <span className="text-[11px] text-ink-3">{a.taxonomy_section ?? "—"} · {a.cell ?? "—"}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {a.kind && <Pill>{a.kind}</Pill>}
                  <span className="mono tnum text-[11px] text-ink-3">{formatBytes(a.bytes)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title={selected ? <span className="mono">{basename(selected.path)}</span> : "Preview"}
        actions={selected && <CopyButton value={selected.sha256} label="sha256" title="Copy sha256" />}
        flush
      >
        <div className="p-3">
          {!selected ? (
            <EmptyState title="Select an artifact" compact />
          ) : content == null ? (
            <EmptyState title="No preview" description={<span className="mono">{selected.path}</span>} compact />
          ) : isDiff ? (
            <DiffView patch={content} />
          ) : (
            <Markdown source={content} />
          )}
        </div>
      </Card>
    </div>
  );
}

/* ── Taxonomy ──────────────────────────────────────────────────────────── */

export function TaxonomyPanel({ tree }: { tree: RunTree }) {
  const rows = taxonomyCoverage(tree);
  if (rows.length === 0) return <EmptyState title="No taxonomy mapping" compact />;
  return (
    <Card title="Taxonomy coverage" flush>
      <ul className="divide-y divide-line-1">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="mono text-[12px] text-accent">{r.id}</span>
                <span className="truncate text-[12px] text-ink-1">{r.title}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap gap-1">
                {r.presentArtifacts.length === 0 ? (
                  <span className="text-[11px] text-ink-3">no artifacts</span>
                ) : (
                  r.presentArtifacts.map((k, i) => <Pill key={i}>{k}</Pill>)
                )}
              </div>
            </div>
            <StatusChip tone={r.covered ? "pass" : "warn"} label={r.covered ? "covered" : "partial"} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ── Missability ───────────────────────────────────────────────────────── */

export function MissabilityPanel({ runId }: { runId: string }) {
  const { data, isLoading } = useRunMissability(runId);
  if (isLoading) return <Card title="Missability"><div className="text-[12px] text-ink-3">Loading…</div></Card>;
  const checks = data ?? [];
  if (checks.length === 0) return <EmptyState title="No missability checks" compact />;
  const failed = checks.filter((c) => c.status === "fail").length;

  return (
    <Card
      title="Missability checks"
      actions={
        <StatusChip
          tone={failed > 0 ? "fail" : "pass"}
          label={failed > 0 ? `${failed} failing` : "all clear"}
        />
      }
      flush
    >
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-line-1 bg-bg-2 text-left text-ink-3">
            <th className="px-3 py-1.5 font-medium">check</th>
            <th className="px-3 py-1.5 font-medium">status</th>
            <th className="px-3 py-1.5 font-medium">evidence</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.id} className="border-b border-line-1/60">
              <td className="mono px-3 py-1.5 text-ink-1">{c.check_id}</td>
              <td className="px-3 py-1.5">
                <StatusChip
                  tone={c.status === "pass" ? "pass" : c.status === "fail" ? "fail" : "dim"}
                  label={c.status}
                />
              </td>
              <td className="mono px-3 py-1.5 text-ink-3">{c.evidence_path ? basename(c.evidence_path) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/* ── Budget (run scope) ────────────────────────────────────────────────── */

export function RunBudgetPanel({ tree, capUsd }: { tree: RunTree; capUsd: number | null }) {
  const totals = runTotals(tree);
  const byModel = costBreakdown(tree, "model");
  const byTier = costBreakdown(tree, "tier");

  const cols: Column<CostBreakdownRow>[] = [
    { key: "key", header: "key", render: (r) => r.key, sortValue: (r) => r.key, mono: true },
    { key: "attempts", header: "n", render: (r) => r.attempts, sortValue: (r) => r.attempts, mono: true, align: "right" },
    { key: "tokens", header: "tokens", render: (r) => formatTokens(r.tokensIn + r.tokensOut), sortValue: (r) => r.tokensIn + r.tokensOut, mono: true, align: "right" },
    { key: "cost", header: "cost", render: (r) => formatUsd(r.costUsd), sortValue: (r) => r.costUsd, mono: true, align: "right" },
  ];

  return (
    <div className="space-y-3">
      <Card title="Run total">
        {capUsd != null ? (
          <Meter value={totals.costUsd} max={capUsd} readout={`${formatUsd(totals.costUsd)} / ${formatUsd(capUsd)}`} label="Run budget" ticks={[{ at: 0.8, tone: "warn" }, { at: 1, tone: "fail" }]} />
        ) : (
          <div className="flex items-baseline justify-between gap-2" title="No run cap configured">
            <span className="text-[11px] text-ink-3">Run spend</span>
            <span className="mono tnum text-[12px] text-ink-1">{formatUsd(totals.costUsd)}</span>
          </div>
        )}
        <div className="mt-2 text-[12px] text-ink-2">
          <span className="mono tnum">{formatTokens(totals.tokensIn)}</span> in ·{" "}
          <span className="mono tnum">{formatTokens(totals.tokensOut)}</span> out
        </div>
      </Card>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Card title="By model" flush>
          <DataTable columns={cols} rows={byModel} rowKey={(r) => r.key} initialSort={{ key: "cost", dir: "desc" }} />
        </Card>
        <Card title="By tier" flush>
          <DataTable columns={cols} rows={byTier} rowKey={(r) => r.key} initialSort={{ key: "cost", dir: "desc" }} />
        </Card>
      </div>
    </div>
  );
}

/* ── Replay ────────────────────────────────────────────────────────────── */

export function ReplayPanel({ runId }: { runId: string }) {
  const { data, isLoading } = useRunReplay(runId);
  if (isLoading) return <Card title="Replay"><div className="text-[12px] text-ink-3">Loading…</div></Card>;
  if (!data) return <EmptyState title="No replay bundle" compact />;
  const json = JSON.stringify(data, null, 2);
  return (
    <Card
      title={<span className="flex items-center gap-2">Replay bundle <span className="mono text-[11px] text-ink-3">{shortId(data.run_id, 14)}</span></span>}
      actions={<CopyButton value={json} label="Copy JSON" />}
      flush
    >
      <pre className="mono max-h-[520px] overflow-auto p-3 text-[12px] leading-relaxed text-ink-2">{json}</pre>
    </Card>
  );
}
