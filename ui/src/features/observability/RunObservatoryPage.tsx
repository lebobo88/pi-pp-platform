/**
 * RunObservatoryPage — full-screen live per-run view at /runs/:runId/live.
 *
 * Layout:
 *   Header strip: run id, status chip, live dot, last signal, elapsed, budget meters
 *   Main grid: PhaseTimeline | StagePipeline | AttemptMetaGrid | GateFeed | LogPane
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useRun } from "@/api/queries/runs";
import { useCaps } from "@/api/queries/budgets";
import { useRunStream } from "@/stores/useRunStream";
import { useLiveRunOverlay } from "@/stores/useLiveRun";
import { buildPipeline, runElapsedMs, isBestOfStage, stageAttempts, runTotals } from "@/lib/runModel";
import { formatUsd, formatRelative, formatDuration } from "@/lib/format";
import { Card } from "@/components/Card";
import { Meter } from "@/components/Meter";
import { Sparkline } from "@/components/Sparkline";
import { LogPane } from "@/components/LogPane";
import { EmptyState } from "@/components/EmptyState";
import { RunStatusChip } from "@/features/common/chips";
import { StagePipeline } from "@/features/runs/components/StagePipeline";
import { BestOfBoard } from "@/features/runs/components/BestOfBoard";
import { PhaseTimeline } from "./PhaseTimeline";
import { AttemptMetaGrid } from "./AttemptMetaGrid";
import { GateFeed } from "./GateFeed";
import { cn } from "@/lib/cn";

/* ── Constants ────────────────────────────────────────────────────────── */

/** Reflexion ceiling: initial + one retry = 2 attempts per stage. */
const REFLEXION_CEILING = 2;

/* ── Live signal header ───────────────────────────────────────────────── */

function LiveDot({ open }: { open: boolean }) {
  if (!open) return null;
  return (
    <span className="mono text-[10px] text-run pp-pulse" title="SSE open">
      ● live
    </span>
  );
}

function LastSignalText({ lastEventTs }: { lastEventTs: string | null | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!lastEventTs) return null;
  return (
    <span className="mono text-[11px] text-ink-3">
      last signal {formatRelative(lastEventTs)}
    </span>
  );
}

/* ── Reflexion ceiling meter ─────────────────────────────────────────── */

interface ReflexionMeterProps {
  attemptsUsed: number;
}

function ReflexionMeter({ attemptsUsed }: ReflexionMeterProps) {
  const atCeiling = attemptsUsed >= REFLEXION_CEILING;
  return (
    <Meter
      value={attemptsUsed}
      max={REFLEXION_CEILING}
      label="Stage attempts"
      readout={`${attemptsUsed} / ${REFLEXION_CEILING}`}
      ticks={[
        { at: 1, tone: atCeiling ? "fail" : "warn", label: "Reflexion ceiling" },
      ]}
    />
  );
}

/* ── Main page ───────────────────────────────────────────────────────── */

export function RunObservatoryPage() {
  const { runId } = useParams<{ runId: string }>();
  const { data: tree, isLoading, error } = useRun(runId);
  const { data: caps } = useCaps();
  const runCapUsd = caps?.find((c) => c.scope === "run")?.limit_usd ?? null;

  const streamStatus = useRunStream(runId);
  const overlay = useLiveRunOverlay(runId ?? "");

  const isLive =
    streamStatus === "open" || streamStatus === "reconnecting";

  // Live elapsed ticker
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!isLive || tree?.run.finished_at) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [isLive, tree?.run.finished_at]);

  const elapsed = tree ? formatDuration(runElapsedMs(tree)) : "—";

  const pipeline = useMemo(
    () => (tree ? buildPipeline(tree, overlay) : []),
    [tree, overlay],
  );

  // Local pipeline highlight — the Observatory does not use selection to
  // filter other panes (attempts, gate feed, logs are already scoped by
  // running-attempt / newest-first), so this is purely visual for the pipeline.
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  useEffect(() => {
    // Default: latest stage in the pipeline (last element), or null if empty.
    const defaultStageId =
      pipeline.length > 0 ? pipeline[pipeline.length - 1]!.stageId : null;
    // Keep the current selection only when it is genuinely present in this
    // run's pipeline. This handles both route changes (runId) and mid-session
    // stage-list mutations where the selected stage disappears.
    const stagePresent =
      selectedStage != null &&
      pipeline.some((s) => s.stageId === selectedStage);
    const next = stagePresent ? selectedStage : defaultStageId;
    if (selectedStage !== next) {
      setSelectedStage(next);
    }
  }, [runId, pipeline, selectedStage]);

  // Find most-recent running attempt for the LogPane
  const attempts = overlay.attempts ?? {};
  const runningAttempt = Object.values(attempts)
    .filter((a) => a.status === "running")
    .sort((a, b) =>
      Date.parse(b.startedAt ?? "") - Date.parse(a.startedAt ?? ""),
    )[0];
  const latestAttempt = Object.values(attempts).sort((a, b) =>
    Date.parse(b.startedAt ?? "") - Date.parse(a.startedAt ?? ""),
  )[0];
  const logAttemptId = runningAttempt?.attemptId ?? latestAttempt?.attemptId;

  // Count open-stage attempts for reflexion meter
  const openStageIds = Object.entries(overlay.stageStatus ?? {})
    .filter(([, s]) => s === "open")
    .map(([id]) => id);
  const openStageAttemptCount = openStageIds.reduce((sum, sid) => {
    const count = Object.values(attempts).filter((a) => a.stageId === sid).length;
    return Math.max(sum, count);
  }, 0);

  // Best-of stages detection
  const hasBestOf =
    tree != null &&
    tree.stages.some((s) => isBestOfStage(stageAttempts(tree, s.id)));
  const liveBordaHasData = Object.keys(overlay.borda ?? {}).length > 0;
  const showBestOfBoard = hasBestOf || liveBordaHasData;

  const status = overlay.status ?? tree?.run.status ?? null;
  // Prefer live overlay cost when there is any live signal for this run;
  // otherwise fall back to the historical run-row cost. Never mix the two
  // with max() — that silently picks whichever source happened to be larger.
  const historicalCostUsd = tree ? runTotals(tree).costUsd : 0;
  const liveCost = overlay.costUsd ?? 0;
  const liveHasSignal =
    liveCost > 0 || (overlay.costSeries?.length ?? 0) > 0;
  const costUsd = liveHasSignal ? liveCost : historicalCostUsd;

  /* ── Loading / error states ──────────────────────────────────────────── */

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-[1400px] px-5 py-5">
        <EmptyState title="Loading observatory…" compact />
      </div>
    );
  }

  if (error || !tree) {
    return (
      <div className="mx-auto w-full max-w-[1400px] px-5 py-5">
        <EmptyState
          title="Run not found"
          description={
            runId ? `No run found for id: ${runId}` : "No run id in URL."
          }
        />
        <div className="mt-4 text-center">
          <Link
            to="/runs"
            className="mono text-[12px] text-accent underline underline-offset-2"
          >
            ← Back to runs
          </Link>
        </div>
      </div>
    );
  }

  const { run } = tree;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-0">
      {/* ── Header strip ─────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-line-1 bg-bg-1 px-5 py-3">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3">
          {/* Left: id + status + live dot */}
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={`/runs/${run.id}`}
              className="mono text-[11px] text-ink-3 hover:text-ink-1"
              title="Back to run detail"
            >
              ← {run.id.slice(0, 16)}
            </Link>
            <span className="text-ink-3">·</span>
            {status && <RunStatusChip status={status} pulse={isLive} />}
            <LiveDot open={streamStatus === "open"} />
            <LastSignalText lastEventTs={overlay.lastEventTs} />
          </div>

          {/* Right: elapsed + meters */}
          <div className="flex flex-wrap items-center gap-4">
            <div className="mono flex items-baseline gap-1.5">
              <span className="text-[11px] text-ink-3">elapsed</span>
              <span className="tnum text-[11px] text-ink-2">{elapsed}</span>
            </div>

            {/* Cost sparkline */}
            {(overlay.costSeries?.length ?? 0) > 1 && (
              <Sparkline
                data={overlay.costSeries!}
                width={80}
                height={20}
                color="var(--accent)"
              />
            )}

            {/* Budget meter */}
            <div className="w-48">
              {runCapUsd != null ? (
                <Meter
                  value={costUsd}
                  max={runCapUsd}
                  label="Budget"
                  readout={`${formatUsd(costUsd)} / ${formatUsd(runCapUsd)}`}
                  ticks={[
                    { at: 0.8, tone: "warn", label: "80%" },
                    { at: 1.0, tone: "fail", label: "100%" },
                  ]}
                />
              ) : (
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] text-ink-3">spend</span>
                  <span className="mono tnum text-[11px] text-ink-2">
                    {formatUsd(costUsd)}
                  </span>
                </div>
              )}
            </div>

            {/* Reflexion ceiling meter (only when a stage is open) */}
            {openStageIds.length > 0 && (
              <div className="w-40">
                <ReflexionMeter attemptsUsed={openStageAttemptCount} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Main grid ────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[1400px] px-5 py-4">
          <div
            className={cn(
              "grid gap-4",
              "grid-cols-1 lg:grid-cols-[200px_minmax(0,1fr)_minmax(0,1fr)]",
            )}
          >
            {/* Column 1: Phase timeline + Stage pipeline */}
            <div className="space-y-4">
              <PhaseTimeline entries={overlay.phaseTimeline ?? []} />
              <StagePipeline
                nodes={pipeline}
                selectedStageId={selectedStage}
                onSelect={setSelectedStage}
              />
            </div>

            {/* Column 2: Attempt meta grid + Gate feed */}
            <div className="space-y-4">
              <AttemptMetaGrid overlay={overlay} />
              <GateFeed events={overlay.gateEvents ?? []} />
            </div>

            {/* Column 3: Log pane + optional BestOfBoard */}
            <div className="space-y-4">
              <Card title={logAttemptId ? `Log · ${logAttemptId.slice(0, 12)}` : "Log"} flush>
                <LogPane
                  attemptId={logAttemptId}
                  height={360}
                  title={logAttemptId ? `attempt ${logAttemptId.slice(0, 12)}` : "output"}
                />
              </Card>

              {showBestOfBoard && (
                <BestOfBoard tree={tree} overlay={overlay} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
