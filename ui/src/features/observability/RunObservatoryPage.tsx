/**
 * RunObservatoryPage — full-screen live per-run view at /runs/:runId/live.
 *
 * Layout:
 *   Header strip: run id, status chip, live dot, last signal, elapsed, budget meters
 *   Main grid: PhaseTimeline | StagePipeline | AttemptMetaGrid | GateFeed | LogPane
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useRun, useRunEventLog, useRunEventLogFull } from "@/api/queries/runs";
import { useCaps } from "@/api/queries/budgets";
import { useRunStream } from "@/stores/useRunStream";
import { useLiveRunOverlay } from "@/stores/useLiveRun";
import { liveRunStore } from "@/stores/liveRunStore";
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
import { ReplayPlayer } from "./ReplayPlayer";
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

  const shouldHydrateFromEventLog = !!tree?.run.finished_at;

  // Replay mode gates — when replay is active the standard hydration effect and
  // SSE stream must not run so they don't race with the replay ingest.
  const [isReplayActive, setIsReplayActive] = useState(false);
  const handleReplayActiveChange = useCallback((active: boolean) => {
    setIsReplayActive(active);
  }, []);

  const { data: eventLog } = useRunEventLog(runId, shouldHydrateFromEventLog && !isReplayActive);
  // Full event log (paginated) for the replay player — only fetched for finished runs.
  const { data: fullEventLog = [], isLoading: fullEventLogLoading } = useRunEventLogFull(
    runId,
    shouldHydrateFromEventLog,
  );
  const streamStatus = useRunStream(runId, !shouldHydrateFromEventLog && !isReplayActive);
  const overlay = useLiveRunOverlay(runId ?? "");

  const isLive =
    streamStatus === "open" || streamStatus === "reconnecting";

  useEffect(() => {
    if (!runId || !eventLog?.length || isReplayActive) return;
    for (const ev of eventLog) liveRunStore.ingest(runId, ev);
  }, [eventLog, runId, isReplayActive]);

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
  // Derive the effective selection at render time so navigation between runs
  // (or a mid-session stage-list mutation that drops the current selection)
  // never renders a single frame with a stale/invalid selectedStage — a bare
  // useEffect would run after render and cause a placeholder flash.
  const effectiveSelectedStage = useMemo(() => {
    const stagePresent =
      selectedStage != null &&
      pipeline.some((s) => s.stageId === selectedStage);
    if (stagePresent) return selectedStage;
    return pipeline.length > 0 ? pipeline[pipeline.length - 1]!.stageId : null;
  }, [selectedStage, pipeline]);
  // Sync state to the derived value so subsequent renders and any external
  // consumers of setSelectedStage observe a consistent id. Guarded by an
  // equality check to avoid an update loop.
  useEffect(() => {
    if (selectedStage !== effectiveSelectedStage) {
      setSelectedStage(effectiveSelectedStage);
    }
  }, [selectedStage, effectiveSelectedStage, runId]);

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
  const finalArtifacts = tree.artifacts.filter(
    (artifact) => artifact.kind === "constitution" || artifact.kind === "project_master",
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-bg-0">
      <div className="sr-only" aria-live="polite">
        Run {run.id} is {status ?? "unknown"}. Stream is {streamStatus}.
      </div>
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

      {/* ── Replay player (finished runs only) ───────────────────────── */}
      {shouldHydrateFromEventLog && (
        <div className="shrink-0 border-b border-line-1 bg-bg-1 px-5 py-2">
          <div className="mx-auto max-w-[1400px]">
            <ReplayPlayer
              runId={run.id}
              events={fullEventLog}
              loading={fullEventLogLoading}
              tree={tree}
              onActiveChange={handleReplayActiveChange}
            />
          </div>
        </div>
      )}

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
              <PhaseTimeline
                entries={overlay.phaseTimeline ?? []}
                persistedTimings={tree?.phases}
                runFinished={!!tree?.run.finished_at}
              />
              <StagePipeline
                nodes={pipeline}
                selectedStageId={effectiveSelectedStage}
                onSelect={setSelectedStage}
              />
            </div>

            {/* Column 2: Attempt meta grid + Gate feed */}
            <div className="space-y-4">
              <AttemptMetaGrid overlay={overlay} />
              <GateFeed
                events={overlay.gateEvents ?? []}
                runId={runId}
                isFinished={shouldHydrateFromEventLog}
              />
              {finalArtifacts.length > 0 && (
                <Card title="Final artifacts">
                  <ul className="space-y-2 text-[12px] text-ink-2">
                    {finalArtifacts.map((artifact) => (
                      <li key={artifact.id} className="flex items-center justify-between gap-3">
                        <span className="mono">{artifact.path}</span>
                        <Link
                          to={`/projects/${encodeURIComponent(run.project_path)}`}
                          className="mono text-[11px] text-accent underline underline-offset-2"
                        >
                          open project docs
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
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
