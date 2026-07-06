/**
 * PhaseTimeline — vertical timeline of overlay.phaseTimeline entries.
 * Active phase pulses; done phases are static. Durations via formatDuration.
 */
import { Card } from "@/components/Card";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import type { PhaseTimelineEntry } from "@/stores/liveRunStore";

const PHASE_LABELS: Record<string, string> = {
  triage: "Triage",
  profile: "Profile",
  taxonomy: "Taxonomy",
  stage_loop: "Stage Loop",
  missability: "Missability",
  master_plan: "Master Plan",
  finalize: "Finalize",
};

function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase.replace(/_/g, " ");
}

export function PhaseTimeline({ entries }: { entries: PhaseTimelineEntry[] }) {
  if (entries.length === 0) {
    return (
      <Card title="Phase Timeline">
        <p className="py-2 text-center text-[12px] text-ink-3">No phase data yet.</p>
      </Card>
    );
  }

  return (
    <Card title="Phase Timeline">
      <ol className="relative py-1">
        {entries.map((entry, i) => {
          const isActive = entry.status === "active";
          const isLast = i === entries.length - 1;
          const durationMs =
            Date.parse(entry.lastAt) - Date.parse(entry.startedAt);
          const durationLabel = Number.isFinite(durationMs)
            ? formatDuration(durationMs)
            : "—";

          const dotColor = isActive ? "var(--run)" : "var(--pass)";

          return (
            <li key={`${entry.phase}-${i}`} className="relative flex gap-3 pb-4">
              {/* Vertical connector line */}
              {!isLast && (
                <span
                  className="absolute left-[7px] top-4 h-[calc(100%-4px)] w-px"
                  style={{ background: "var(--line-2)" }}
                  aria-hidden
                />
              )}

              {/* Dot */}
              <span
                className={cn(
                  "relative z-10 mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border-2",
                  isActive && "pp-pulse",
                )}
                style={{ borderColor: dotColor, background: "var(--bg-1)" }}
              >
                <span
                  className="size-1.5 rounded-full"
                  style={{ background: dotColor }}
                />
              </span>

              {/* Content */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "text-[12px] font-medium",
                      isActive ? "text-ink-1" : "text-ink-2",
                    )}
                  >
                    {phaseLabel(entry.phase)}
                  </span>
                  <span className="mono tnum shrink-0 text-[11px] text-ink-3">
                    {durationLabel}
                  </span>
                </div>
                {entry.detail && (
                  <p className="mt-0.5 truncate text-[11px] text-ink-3" title={entry.detail}>
                    {entry.detail}
                  </p>
                )}
                <p className="mono text-[10px] text-ink-3/60">
                  {isActive ? "active" : "done"}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
