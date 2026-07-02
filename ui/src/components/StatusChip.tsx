import { cn } from "@/lib/cn";
import { type StatusTone, toneVar, toneIsLive } from "@/lib/status";

export interface StatusChipProps {
  /** Visible label. */
  label: string;
  tone: StatusTone;
  /** Force the 1.6s pulse (defaults to on for "live" tones like run). */
  pulse?: boolean;
  /** Dot only, no label chrome. */
  bare?: boolean;
  className?: string;
  title?: string;
}

/** 8px status dot + label. The dot pulses for in-flight tones. */
export function StatusChip({ label, tone, pulse, bare, className, title }: StatusChipProps) {
  const live = pulse ?? toneIsLive(tone);
  const dot = (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", live && "pp-pulse")}
      style={{ background: toneVar(tone) }}
    />
  );
  if (bare) {
    return <span title={title ?? label} className={cn("inline-flex", className)}>{dot}</span>;
  }
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border border-line-1 bg-bg-2 px-1.5 py-0.5",
        "text-[11px] font-medium leading-none text-ink-1",
        className,
      )}
    >
      {dot}
      <span className="tracking-wide">{label}</span>
    </span>
  );
}

/** Bare dot helper for dense tables. */
export function StatusDot({ tone, pulse, title }: { tone: StatusTone; pulse?: boolean; title?: string }) {
  const live = pulse ?? toneIsLive(tone);
  return (
    <span
      title={title}
      className={cn("inline-block size-2 rounded-full align-middle", live && "pp-pulse")}
      style={{ background: toneVar(tone) }}
    />
  );
}
