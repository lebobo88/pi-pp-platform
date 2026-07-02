import { StatusChip } from "@/components/StatusChip";
import { cn } from "@/lib/cn";
import { runTone, stageTone, attemptTone, verdictTone } from "@/lib/status";
import type {
  RunStatus,
  StageStatus,
  AttemptStatus,
  VerdictOutcome,
  RunMode,
  Vendor,
} from "@shared/api-types";
import type { PipelineState } from "@/lib/runModel";

export function RunStatusChip({ status, pulse }: { status: RunStatus; pulse?: boolean }) {
  return <StatusChip tone={runTone(status)} label={status} pulse={pulse ?? status === "running"} />;
}

export function StageStatusChip({ status }: { status: StageStatus }) {
  return <StatusChip tone={stageTone(status)} label={status} />;
}

export function AttemptStatusChip({ status }: { status: AttemptStatus }) {
  return <StatusChip tone={attemptTone(status)} label={status.replace(/_/g, " ")} />;
}

export function VerdictChip({ outcome }: { outcome: VerdictOutcome }) {
  return <StatusChip tone={verdictTone(outcome)} label={outcome} />;
}

const PIPELINE_TONE = {
  pending: "dim",
  running: "run",
  passed: "pass",
  surfaced: "warn",
  failed: "fail",
  skipped: "dim",
} as const;

export function PipelineStateChip({ state }: { state: PipelineState }) {
  return <StatusChip tone={PIPELINE_TONE[state]} label={state} pulse={state === "running"} />;
}

/** A small non-status pill (mode, tier, vendor, gate, origin). */
export function Pill({
  children,
  tone = "default",
  title,
  className,
}: {
  children: React.ReactNode;
  tone?: "default" | "accent" | "judge" | "run";
  title?: string;
  className?: string;
}) {
  const toneClass =
    tone === "accent"
      ? "border-accent-dim/50 text-accent"
      : tone === "judge"
        ? "border-[color-mix(in_srgb,var(--judge)_45%,transparent)] text-judge"
        : tone === "run"
          ? "border-[color-mix(in_srgb,var(--run)_45%,transparent)] text-run"
          : "border-line-2 text-ink-2";
  return (
    <span
      title={title}
      className={cn(
        "mono inline-flex items-center rounded-sm border bg-bg-2 px-1.5 py-0.5 text-[11px] leading-none",
        toneClass,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ModeChip({ mode }: { mode: RunMode }) {
  const label = mode === "best_of" ? "best-of" : mode;
  return <Pill tone={mode === "team" ? "accent" : "default"}>{label}</Pill>;
}

export function TierChip({ tier }: { tier: string | null | undefined }) {
  if (!tier) return null;
  return <Pill tone={tier === "fable" ? "judge" : "default"} title="generation-ladder tier">{tier}</Pill>;
}

export function VendorChip({ vendor }: { vendor: Vendor | string }) {
  return <Pill title="vendor">{vendor}</Pill>;
}
