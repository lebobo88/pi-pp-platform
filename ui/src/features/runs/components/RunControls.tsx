import { useState } from "react";
import type { RunStatus, StageStatus } from "@shared/api-types";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { toast } from "@/stores/uiStore";
import { useAbortRun, useRetryStage, useGateStage } from "@/api/mutations/runs";

/** Abort button — only meaningful while the run is in-flight. */
export function AbortRunButton({ runId, status }: { runId: string; status: RunStatus }) {
  const [open, setOpen] = useState(false);
  const abort = useAbortRun(runId);
  const inFlight = status === "running" || status === "pending";
  if (!inFlight) return null;

  return (
    <>
      <Button variant="danger" size="sm" onClick={() => setOpen(true)}>Abort</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Abort run?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={abort.isPending}
              onClick={() =>
                abort.mutate(undefined, {
                  onSuccess: () => {
                    toast({ tone: "warn", title: "Run aborted", message: runId });
                    setOpen(false);
                  },
                  onError: (e) => toast({ tone: "error", title: "Abort failed", message: e instanceof Error ? e.message : "" }),
                })
              }
            >
              {abort.isPending ? "Aborting…" : "Abort run"}
            </Button>
          </>
        }
      >
        This stops in-flight generation and marks the run <span className="mono">aborted</span>. Completed
        stages are preserved; nothing is merged.
      </Modal>
    </>
  );
}

/** Retry (Reflexion ×1) + re-gate actions for a stage. */
export function StageActions({
  runId,
  stageId,
  stageStatus,
}: {
  runId: string;
  stageId: string;
  stageStatus: StageStatus;
}) {
  const retry = useRetryStage(runId);
  const gate = useGateStage(runId);
  const canRetry = stageStatus === "surfaced";

  return (
    <div className="flex items-center gap-1.5">
      {canRetry && (
        <Button
          size="sm"
          variant="default"
          disabled={retry.isPending}
          onClick={() =>
            retry.mutate(stageId, {
              onSuccess: () => toast({ tone: "info", title: "Stage retry queued", message: stageId }),
              onError: (e) => toast({ tone: "error", title: "Retry failed", message: e instanceof Error ? e.message : "" }),
            })
          }
          title="Retry with the verdict's critique fed back (Reflexion ×1)"
        >
          {retry.isPending ? "Retrying…" : "Retry"}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={gate.isPending}
        onClick={() =>
          gate.mutate(stageId, {
            onSuccess: () => toast({ tone: "info", title: "Re-judge queued", message: stageId }),
            onError: (e) => toast({ tone: "error", title: "Gate failed", message: e instanceof Error ? e.message : "" }),
          })
        }
        title="Re-run only the judge on this stage (no regeneration)"
      >
        {gate.isPending ? "Judging…" : "Re-gate"}
      </Button>
    </div>
  );
}
