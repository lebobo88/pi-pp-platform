import { useState } from "react";
import type { RunStatus, StageStatus } from "@shared/api-types";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { toast } from "@/stores/uiStore";
import { ApiClientError } from "@/api/client";
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
  // Set once a retry returns 409 retry_exhausted, revealing the explicit override.
  const [exhausted, setExhausted] = useState(false);

  const runRetry = (override: boolean) =>
    retry.mutate(
      { stageId, override },
      {
        onSuccess: () => {
          setExhausted(false);
          toast({
            tone: override ? "warn" : "info",
            title: override ? "Override retry queued" : "Stage retry queued",
            message: stageId,
          });
        },
        onError: (e) => {
          // Reflexion ×1 budget spent — surface the real reason and offer override.
          if (e instanceof ApiClientError && e.status === 409) {
            setExhausted(true);
            toast({
              tone: "warn",
              title: "Retry budget exhausted (Reflexion ×1)",
              message: "Override available — a forced retry may yield diminishing returns.",
            });
            return;
          }
          toast({ tone: "error", title: "Retry failed", message: e instanceof Error ? e.message : "" });
        },
      },
    );

  return (
    <div className="flex items-center gap-1.5">
      {canRetry && (
        <Button
          size="sm"
          variant="default"
          disabled={retry.isPending}
          onClick={() => runRetry(false)}
          title="Retry with the verdict's critique fed back (Reflexion ×1)"
        >
          {retry.isPending ? "Retrying…" : "Retry"}
        </Button>
      )}
      {canRetry && exhausted && (
        <Button
          size="sm"
          variant="danger"
          disabled={retry.isPending}
          onClick={() => runRetry(true)}
          title="Force another retry past the Reflexion ×1 budget — diminishing returns likely"
        >
          Override &amp; retry anyway
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
