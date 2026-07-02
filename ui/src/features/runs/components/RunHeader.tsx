import { useEffect, useState } from "react";
import type { RunTree } from "@shared/api-types";
import type { LiveRunOverlay } from "@/stores/liveRunStore";
import type { SseStatus } from "@/api/sse";
import { Card } from "@/components/Card";
import { Meter } from "@/components/Meter";
import { CopyButton } from "@/components/CopyButton";
import { KeyValue } from "@/components/KeyValue";
import { RunStatusChip, ModeChip } from "@/features/common/chips";
import { AbortRunButton } from "./RunControls";
import { formatUsd, formatDuration, formatTokens, basename, shortId } from "@/lib/format";
import { runTotals, runElapsedMs } from "@/lib/runModel";

const RUN_CAP_USD = 3;

export function RunHeader({
  tree,
  overlay,
  streamStatus,
}: {
  tree: RunTree;
  overlay: LiveRunOverlay;
  streamStatus: SseStatus;
}) {
  const { run } = tree;
  const status = overlay.status ?? run.status;
  const totals = runTotals(tree);
  const cost = Math.max(overlay.costUsd, totals.costUsd);
  const tokens = overlay.tokensIn + overlay.tokensOut || totals.tokensIn + totals.tokensOut;

  // Live-ticking elapsed while the run is open.
  const isLive = status === "running" || streamStatus === "open" || streamStatus === "reconnecting";
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!isLive || run.finished_at) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [isLive, run.finished_at]);

  const elapsed = formatDuration(runElapsedMs(tree));

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <RunStatusChip status={status} pulse={isLive} />
            <ModeChip mode={run.mode} />
            {run.team && <span className="mono text-[12px] text-accent">{run.team}</span>}
            {streamStatus === "open" && (
              <span className="mono text-[10px] text-run">● live</span>
            )}
            {streamStatus === "reconnecting" && (
              <span className="mono text-[10px] text-warn">● reconnecting</span>
            )}
          </div>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-1">{run.request_text}</p>
          <div className="mt-2 flex items-center gap-2">
            <span className="mono text-[11px] text-ink-3">{shortId(run.id, 16)}</span>
            <CopyButton value={run.id} title="Copy run id" />
            <span className="text-ink-3">·</span>
            <span className="mono text-[11px] text-ink-3">{basename(run.project_path)}</span>
          </div>
        </div>

        <div className="w-64 shrink-0 space-y-3">
          <div className="flex justify-end">
            <AbortRunButton runId={run.id} status={status} />
          </div>
          <Meter
            value={cost}
            max={RUN_CAP_USD}
            label="Run budget"
            readout={`${formatUsd(cost)} / ${formatUsd(RUN_CAP_USD)}`}
            ticks={[
              { at: 0.8, tone: "warn", label: "80% downgrade" },
              { at: 1, tone: "fail", label: "100% block" },
            ]}
          />
          <KeyValue
            labelWidth={72}
            rows={[
              { label: "elapsed", value: elapsed, mono: true },
              { label: "tokens", value: formatTokens(tokens), mono: true },
              { label: "started", value: new Date(run.started_at).toLocaleString(), mono: true },
            ]}
          />
        </div>
      </div>
    </Card>
  );
}
