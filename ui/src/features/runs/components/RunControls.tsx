import { useState } from "react";
import type { RunStatus, StageStatus } from "@shared/api-types";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Modal } from "@/components/Modal";
import { Pill } from "@/features/common/chips";
import { toast } from "@/stores/uiStore";
import { ApiClientError } from "@/api/client";
import { useAbortRun, useRetryStage, useGateStage, useResumeRun } from "@/api/mutations/runs";
import { useRunCompletionReadiness } from "@/api/queries/runs";

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

/** One blocker category row: label, count/detail, and whether it needs an operator action. */
function BlockerRow({ label, hint, action }: { label: string; hint: string; action: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <div className="min-w-0">
        <span className="text-[12px] text-ink-1">{label}</span>
        <span className="ml-2 text-[11px] text-ink-3">{hint}</span>
      </div>
      <Pill tone="accent">{action}</Pill>
    </li>
  );
}

/**
 * Surfaced-run recovery panel: shown only when `run.status === "surfaced"`.
 * Reads `GET .../completion-readiness` and renders each blocker category so
 * the operator knows exactly what's needed — a stage retry, pipeline
 * continuation, missing-artifact generation, missability rerun, or
 * master-plan population — with a "Resume" action enabled once every
 * blocker that resume itself can't clear has been resolved.
 */
export function SurfacedRunPanel({ runId, status }: { runId: string; status: RunStatus }) {
  const readiness = useRunCompletionReadiness(status === "surfaced" ? runId : undefined);
  const resume = useResumeRun(runId);
  if (status !== "surfaced") return null;

  const r = readiness.data;
  const blockers: Array<{ key: string; label: string; hint: string; action: string }> = [];
  if (r) {
    if (r.surfaced_stages.length > 0) {
      blockers.push({
        key: "surfaced_stages",
        label: `${r.surfaced_stages.length} stage${r.surfaced_stages.length === 1 ? "" : "s"} surfaced`,
        hint: r.surfaced_stages.map((s) => s.kind).join(", "),
        action: "Retry / re-gate",
      });
    }
    if (r.incomplete_stages.length > 0) {
      blockers.push({
        key: "incomplete_stages",
        label: `${r.incomplete_stages.length} stage${r.incomplete_stages.length === 1 ? "" : "s"} incomplete`,
        hint: r.incomplete_stages.map((s) => s.kind).join(", "),
        action: "Drive to a terminal outcome",
      });
    }
    if (r.remaining_planned_stages && r.remaining_planned_stages.length > 0) {
      blockers.push({
        key: "remaining_planned_stages",
        label: `${r.remaining_planned_stages.length} planned stage${r.remaining_planned_stages.length === 1 ? "" : "s"} not yet run`,
        hint: r.remaining_planned_stages.map((s) => s.kind).join(", "),
        action: "Resume continues these",
      });
    }
    if (r.missing_required_artifacts.length > 0) {
      blockers.push({
        key: "missing_required_artifacts",
        label: `${r.missing_required_artifacts.length} required artifact${r.missing_required_artifacts.length === 1 ? "" : "s"} missing`,
        hint: r.missing_required_artifacts.join(", "),
        action: "Generate artifact",
      });
    }
    if (r.failed_required_missability_checks.length > 0) {
      blockers.push({
        key: "failed_required_missability_checks",
        label: `${r.failed_required_missability_checks.length} missability check${r.failed_required_missability_checks.length === 1 ? "" : "s"} failed`,
        hint: r.failed_required_missability_checks.join(", "),
        action: "Missability rerun",
      });
    }
    if (r.unpopulated_master_plan_sections.length > 0) {
      blockers.push({
        key: "unpopulated_master_plan_sections",
        label: `${r.unpopulated_master_plan_sections.length} master-plan section${r.unpopulated_master_plan_sections.length === 1 ? "" : "s"} unpopulated`,
        hint: r.unpopulated_master_plan_sections.join(", "),
        action: "Master-plan population",
      });
    }
  }

  return (
    <Card
      title="Surfaced — needs follow-up"
      actions={
        <Button
          size="sm"
          variant="default"
          disabled={!r?.resumable || resume.isPending}
          title={r && !r.resumable ? (r.blocking_reason ?? "Not resumable yet") : "Continue this run on the same run_id"}
          onClick={() =>
            resume.mutate(undefined, {
              onSuccess: (res) => {
                if (res.resumed) {
                  toast({ tone: "info", title: "Run resumed", message: `status: ${res.status}` });
                } else {
                  toast({
                    tone: "warn",
                    title: "Resume made no progress",
                    message: res.readiness?.blocking_reason ?? "blockers remain",
                  });
                }
              },
              onError: (e) => toast({ tone: "error", title: "Resume failed", message: e instanceof Error ? e.message : "" }),
            })
          }
        >
          {resume.isPending ? "Resuming…" : "Resume"}
        </Button>
      }
    >
      {readiness.isLoading && <p className="text-[12px] text-ink-3">Checking completion readiness…</p>}
      {r && blockers.length === 0 && (
        <p className="text-[12px] text-ink-3">No blockers on record — resume will re-run completion phases.</p>
      )}
      {blockers.length > 0 && (
        <ul className="divide-y divide-line-1">
          {blockers.map(({ key, ...blocker }) => <BlockerRow key={key} {...blocker} />)}
        </ul>
      )}
    </Card>
  );
}
