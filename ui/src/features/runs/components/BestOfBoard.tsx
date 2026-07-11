import { useState } from "react";
import type { RunTree, StageRow } from "@shared/api-types";
import type { LiveRunOverlay } from "@/stores/liveRunStore";
import { cn } from "@/lib/cn";
import { Card } from "@/components/Card";
import { DiffView } from "@/components/DiffView";
import { EmptyState } from "@/components/EmptyState";
import { AttemptCard } from "./AttemptCard";
import { Pill } from "@/features/common/chips";
import { verdictTone, toneVar } from "@/lib/status";
import { useContent } from "@/api/queries/content";
import {
  stageAttempts,
  candidateAttempts,
  buildBordaTable,
  attemptVerdicts,
  isBestOfStage,
} from "@/lib/runModel";

export function BestOfBoard({ tree, overlay }: { tree: RunTree; overlay: LiveRunOverlay }) {
  const bestOfStages = tree.stages.filter((s) => isBestOfStage(stageAttempts(tree, s.id)));
  if (bestOfStages.length === 0) {
    return (
      <EmptyState
        title="No best-of stages"
        description="This run had no candidate races. Best-of-N is triggered on major-scope stages."
        compact
      />
    );
  }
  return (
    <div className="space-y-4">
      {bestOfStages.map((stage) => (
        <BestOfStagePanel key={stage.id} tree={tree} overlay={overlay} stage={stage} />
      ))}
    </div>
  );
}

function BestOfStagePanel({
  tree,
  overlay,
  stage,
}: {
  tree: RunTree;
  overlay: LiveRunOverlay;
  stage: StageRow;
}) {
  const attempts = stageAttempts(tree, stage.id);
  const candidates = candidateAttempts(attempts);
  const verdicts = attempts.flatMap((a) => attemptVerdicts(tree, a.id));
  const winnerId = overlay.stageWinner[stage.id] ?? stage.winner_attempt_id;
  const liveRanking = overlay.borda[stage.id];

  const table = buildBordaTable(attempts, verdicts, { ranking: liveRanking, winnerAttemptId: winnerId });
  const [selected, setSelected] = useState<string>(winnerId ?? candidates[0]?.id ?? "");

  const selectedAttempt = candidates.find((c) => c.id === selected);
  const { data: doc } = useContent(selectedAttempt?.artifact_path ?? undefined);
  const diff = doc?.content ?? null;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="text-ink-1">{stage.kind}</span>
          <Pill tone="accent">best-of {candidates.length}</Pill>
        </span>
      }
    >
      {/* Candidate grid */}
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${Math.min(candidates.length, 3)}, minmax(0, 1fr))` }}
      >
        {table.candidates.map((c) => (
          <button key={c.attempt.id} type="button" onClick={() => setSelected(c.attempt.id)} className="text-left">
            <div className={cn("rounded-md ring-1 ring-inset transition-shadow", selected === c.attempt.id ? "ring-accent" : "ring-transparent")}>
              <AttemptCard attempt={c.attempt} winner={c.winner} compact>
                <div className="mt-2 flex items-center justify-between text-[11px]">
                  <span className="text-ink-3">Borda</span>
                  <span className="mono tnum text-ink-1">
                    {c.points} pts · rank {c.rank}
                  </span>
                </div>
              </AttemptCard>
            </div>
          </button>
        ))}
      </div>

      {/* REQ-ENT-4/7: Entropy banner — rendered once per stage, only when entropy captured */}
      <EntropyBanner entropy={overlay.stageEntropy?.[stage.id]} />

      {/* Borda table: judges × candidates */}
      <div className="mt-4">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">Borda · judges × candidates</div>
        <div className="overflow-x-auto rounded-md border border-line-1">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-line-1 bg-bg-2 text-left">
                <th className="px-2.5 py-1.5 font-medium text-ink-3">candidate</th>
                {table.judges.map((j) => (
                  <th key={j} className="mono px-2.5 py-1.5 text-center font-medium text-ink-3">{j}</th>
                ))}
                <th className="px-2.5 py-1.5 text-right font-medium text-ink-3">pts</th>
              </tr>
            </thead>
            <tbody>
              {table.candidates.map((c) => (
                <tr key={c.attempt.id} className="border-b border-line-1/60">
                  <td className="mono px-2.5 py-1.5 text-ink-1">
                    {c.winner && <span className="mr-1 text-accent">★</span>}
                    {c.attempt.model_id}
                  </td>
                  {table.judges.map((j) => {
                    const outcome = table.cell(c.attempt.id, j);
                    return (
                      <td key={j} className="px-2.5 py-1.5 text-center">
                        {outcome ? (
                          <span
                            className="mono inline-block rounded px-1 text-[11px]"
                            style={{ color: toneVar(verdictTone(outcome)) }}
                          >
                            {outcome}
                          </span>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="mono tnum px-2.5 py-1.5 text-right text-ink-1">{c.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Candidate diff viewer */}
      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Candidate diff</div>
          <span className="mono text-[11px] text-ink-3">{selected}</span>
        </div>
        {diff ? (
          <DiffView patch={diff} />
        ) : (
          <EmptyState title="No diff artifact" description="This candidate produced no unified diff." compact />
        )}
      </div>
    </Card>
  );
}

/**
 * REQ-ENT-4..8: Stage-level diff-entropy banner.
 * Rendered once per stage between the candidate grid and the Borda table.
 * Omitted entirely when no entropy has been captured for the stage.
 *
 * Color thresholds (REQ-ENT-5):
 *   < 0.6   → neutral (ink-3)
 *   0.6–0.85 → amber/warn (boundary values resolve amber)
 *   > 0.85  → red/fail
 */
function entropyColor(maxSimilarity: number): string {
  if (maxSimilarity > 0.85) return "border-fail/40 bg-fail/10 text-fail";
  if (maxSimilarity >= 0.6) return "border-warn/40 bg-warn/10 text-warn";
  return "border-line-1 bg-bg-2 text-ink-3";
}

function EntropyBanner({
  entropy,
}: {
  entropy?: { maxSimilarity: number; warning: string | null };
}) {
  // REQ-ENT-7: render nothing when entropy is absent.
  if (!entropy) return null;

  const colorClass = entropyColor(entropy.maxSimilarity);

  return (
    <div
      className={cn(
        "mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]",
        colorClass,
      )}
    >
      <span className="font-medium shrink-0">diff entropy</span>
      {/* REQ-ENT-8: show numeric value when present */}
      <span className="mono">max similarity {entropy.maxSimilarity.toFixed(3)}</span>
      {/* REQ-ENT-6: show warning text when non-empty */}
      {entropy.warning && (
        <span className="ml-1 truncate">{entropy.warning}</span>
      )}
    </div>
  );
}
