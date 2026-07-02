import type { RunTree, StageRow } from "@shared/api-types";
import type { LiveRunOverlay } from "@/stores/liveRunStore";
import { Card } from "@/components/Card";
import { LogPane } from "@/components/LogPane";
import { EmptyState } from "@/components/EmptyState";
import { StageStatusChip, Pill } from "@/features/common/chips";
import { AttemptCard } from "./AttemptCard";
import { VerdictCard } from "./VerdictCard";
import {
  stageAttempts,
  attemptVerdicts,
  candidateAttempts,
  isBestOfStage,
  reflexionThreads,
} from "@/lib/runModel";

export function StageDetail({
  tree,
  overlay,
  stageId,
  onOpenCandidates,
}: {
  tree: RunTree;
  overlay: LiveRunOverlay;
  stageId: string | null;
  onOpenCandidates: () => void;
}) {
  const stage: StageRow | undefined = tree.stages.find((s) => s.id === stageId);
  if (!stage) {
    return <EmptyState title="Select a stage" description="Pick a node from the pipeline rail." compact />;
  }

  const attempts = stageAttempts(tree, stage.id);
  const bestOf = isBestOfStage(attempts);
  const threads = reflexionThreads(tree, stage.id);
  const liveStatus = overlay.stageStatus[stage.id] ?? stage.status;
  const winnerId = overlay.stageWinner[stage.id] ?? stage.winner_attempt_id;

  // Attempt to tail: the winner, else the last attempt.
  const tailAttempt = winnerId ?? attempts[attempts.length - 1]?.id;

  return (
    <div className="space-y-3">
      <Card
        title={
          <span className="flex items-center gap-2">
            <span className="text-ink-1">{stage.kind}</span>
            <Pill>{stage.gate_type}</Pill>
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <StageStatusChip status={liveStatus} />
            {bestOf && (
              <button
                type="button"
                onClick={onOpenCandidates}
                className="mono text-[11px] text-accent underline decoration-accent-dim hover:decoration-accent"
              >
                best-of {candidateAttempts(attempts).length} →
              </button>
            )}
          </div>
        }
      >
        {attempts.length === 0 ? (
          <EmptyState title="No attempts yet" compact />
        ) : threads.length > 0 ? (
          <ReflexionThreadView tree={tree} stageId={stage.id} />
        ) : (
          <div className="space-y-3">
            {attempts.map((a) => (
              <AttemptCard key={a.id} attempt={a} liveStatus={overlay.attemptStatus[a.id]} winner={a.id === winnerId}>
                <VerdictList tree={tree} attemptId={a.id} />
              </AttemptCard>
            ))}
          </div>
        )}
      </Card>

      {tailAttempt && (
        <Card title="Output" flush>
          <div className="p-3">
            <LogPane attemptId={tailAttempt} height={220} title={`${stage.kind} · output`} />
          </div>
        </Card>
      )}
    </div>
  );
}

function VerdictList({ tree, attemptId }: { tree: RunTree; attemptId: string }) {
  const verdicts = attemptVerdicts(tree, attemptId);
  if (verdicts.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {verdicts.map((v) => (
        <VerdictCard key={v.id} verdict={v} />
      ))}
    </div>
  );
}

/** Reflexion chain: critique → retry attempt, rendered as a vertical thread. */
function ReflexionThreadView({ tree, stageId }: { tree: RunTree; stageId: string }) {
  const threads = reflexionThreads(tree, stageId);
  return (
    <div className="space-y-4">
      {threads.map((thread, ti) => (
        <div key={ti} className="space-y-2">
          {thread.steps.map((step, si) => (
            <div key={step.attempt.id} className="relative">
              {si > 0 && (
                <div className="mb-2 flex items-center gap-2 pl-1 text-[11px] text-judge">
                  <span aria-hidden>↻</span> reflexion retry — critique fed back to the generator
                </div>
              )}
              <AttemptCard attempt={step.attempt} winner={si === thread.steps.length - 1}>
                {step.verdicts.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {step.verdicts.map((v) => (
                      <VerdictCard key={v.id} verdict={v} />
                    ))}
                  </div>
                )}
              </AttemptCard>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
