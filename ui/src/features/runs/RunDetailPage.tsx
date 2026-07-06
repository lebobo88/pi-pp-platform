import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "@/api/queryKeys";
import { Page } from "@/layout/Page";
import { Tabs } from "@/components/Tabs";
import { EmptyState } from "@/components/EmptyState";
import { useRun } from "@/api/queries/runs";
import { useCaps } from "@/api/queries/budgets";
import { useRunStream } from "@/stores/useRunStream";
import { useLiveRunOverlay } from "@/stores/useLiveRun";
import { buildPipeline } from "@/lib/runModel";
import { RunHeader } from "./components/RunHeader";
import { StagePipeline } from "./components/StagePipeline";
import { StageDetail } from "./components/StageDetail";
import { BestOfBoard } from "./components/BestOfBoard";
import {
  ArtifactsPanel,
  TaxonomyPanel,
  MissabilityPanel,
  RunBudgetPanel,
  ReplayPanel,
} from "./components/panels";

type TabId = "pipeline" | "candidates" | "artifacts" | "taxonomy" | "missability" | "budget" | "replay";

export function RunDetailPage() {
  const { runId } = useParams();
  const { data: tree, isLoading, error } = useRun(runId);
  // Run-scope budget cap (null when none is configured) — threaded to the
  // header meter and the budget panel so neither fabricates a max.
  const { data: caps } = useCaps();
  const runCapUsd = caps?.find((c) => c.scope === "run")?.limit_usd ?? null;
  // Drive the live overlay (mock mode animates via the scripted SSE replay).
  const streamStatus = useRunStream(runId);
  const overlay = useLiveRunOverlay(runId ?? "");

  const [tab, setTab] = useState<TabId>("pipeline");
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const pinnedRef = useRef(false);

  // Keep the REST tree fresh while post-hoc work streams in: every discrete
  // gate event (gen / verdict / surfaced — incl. operator retries on a
  // finished run) refetches the run so attempts and verdicts appear without a
  // manual reload. Debounced so an event burst causes one refetch.
  const qc = useQueryClient();
  const gateEventCount = overlay.gateEvents?.length ?? 0;
  useEffect(() => {
    if (!runId || gateEventCount === 0) return;
    const t = setTimeout(() => void qc.invalidateQueries({ queryKey: qk.run(runId) }), 400);
    return () => clearTimeout(t);
  }, [gateEventCount, qc, runId]);

  const pipeline = useMemo(() => (tree ? buildPipeline(tree, overlay) : []), [tree, overlay]);

  // Default selection = first stage; auto-follow the running stage until the
  // user clicks a node (then stay pinned).
  useEffect(() => {
    if (!tree) return;
    if (selectedStage == null && pipeline.length > 0) {
      setSelectedStage(pipeline[0]!.stageId);
    }
    if (!pinnedRef.current) {
      const running = pipeline.find((n) => n.state === "running");
      if (running && running.stageId !== selectedStage) setSelectedStage(running.stageId);
    }
  }, [tree, pipeline, selectedStage]);

  const selectStage = (id: string) => {
    pinnedRef.current = true;
    setSelectedStage(id);
  };

  if (isLoading) {
    return (
      <Page title="Run">
        <EmptyState title="Loading run…" compact />
      </Page>
    );
  }
  if (error || !tree) {
    return (
      <Page title="Run">
        <EmptyState title="Run not found" description={runId} />
      </Page>
    );
  }

  const bestOfCount = pipeline.filter((n) => n.isBestOf).length;

  return (
    <Page title="Run" description={<span className="mono">{tree.run.id}</span>} className="space-y-4">
      <RunHeader tree={tree} overlay={overlay} streamStatus={streamStatus} capUsd={runCapUsd} />

      <Tabs
        active={tab}
        onChange={(t) => setTab(t as TabId)}
        items={[
          { id: "pipeline", label: "Pipeline" },
          { id: "candidates", label: "Candidates", count: bestOfCount || undefined },
          { id: "artifacts", label: "Artifacts", count: tree.artifacts.length || undefined },
          { id: "taxonomy", label: "Taxonomy" },
          { id: "missability", label: "Missability" },
          { id: "budget", label: "Budget" },
          { id: "replay", label: "Replay" },
        ]}
      />

      {tab === "pipeline" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <StagePipeline nodes={pipeline} selectedStageId={selectedStage} onSelect={selectStage} />
          <StageDetail
            tree={tree}
            overlay={overlay}
            stageId={selectedStage}
            onOpenCandidates={() => setTab("candidates")}
          />
        </div>
      )}

      {tab === "candidates" && <BestOfBoard tree={tree} overlay={overlay} />}
      {tab === "artifacts" && <ArtifactsPanel tree={tree} />}
      {tab === "taxonomy" && <TaxonomyPanel tree={tree} />}
      {tab === "missability" && <MissabilityPanel runId={tree.run.id} />}
      {tab === "budget" && <RunBudgetPanel tree={tree} capUsd={runCapUsd} />}
      {tab === "replay" && <ReplayPanel runId={tree.run.id} />}
    </Page>
  );
}
