import { cn } from "@/lib/cn";

export interface MeterTick {
  /** 0..1 position along the track. */
  at: number;
  label?: string;
  tone?: "warn" | "fail" | "dim";
}

export interface MeterProps {
  /** Current value. */
  value: number;
  /** Max value (track full). */
  max: number;
  /** Tick marks — used for budget 80% / 100% tripwires. */
  ticks?: MeterTick[];
  /** Label rendered above the track. */
  label?: string;
  /** Right-aligned readout (e.g. "$3.10 / $10.00"). */
  readout?: string;
  className?: string;
  /** Track height in px. */
  height?: number;
}

/**
 * Horizontal meter with tick marks. The fill color shifts warn→fail as the
 * value crosses the tick thresholds, which is how budget tripwires read at a
 * glance.
 */
export function Meter({ value, max, ticks = [], label, readout, className, height = 6 }: MeterProps) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;

  // Fill tone from the highest crossed tick threshold.
  const crossed = ticks
    .filter((t) => pct >= t.at)
    .sort((a, b) => b.at - a.at)[0];
  const fillTone = crossed?.tone ?? "run";
  const fillColor = `var(--${fillTone === "run" ? "accent" : fillTone})`;

  return (
    <div className={cn("w-full", className)}>
      {(label != null || readout != null) && (
        <div className="mb-1 flex items-baseline justify-between gap-2">
          {label != null && <span className="text-[11px] text-ink-3">{label}</span>}
          {readout != null && (
            <span className="mono tnum text-[11px] text-ink-2">{readout}</span>
          )}
        </div>
      )}
      <div
        className="relative w-full overflow-hidden rounded-full bg-bg-3"
        style={{ height }}
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${pct * 100}%`, background: fillColor }}
        />
        {ticks.map((t, i) => (
          <span
            key={i}
            title={t.label}
            className="absolute top-0 h-full w-px"
            style={{
              left: `${Math.min(1, Math.max(0, t.at)) * 100}%`,
              background: `var(--${t.tone ?? "line-2"})`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
