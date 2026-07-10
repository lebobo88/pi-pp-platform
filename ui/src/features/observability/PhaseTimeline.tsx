/**
 * PhaseTimeline — vertical timeline of overlay.phaseTimeline entries.
 *
 * Two rendering modes:
 *   - Live (in-flight): event-driven PhaseTimelineEntry list with a pulsing
 *     dot for the active phase. Duration derived from entry timestamps.
 *   - Persisted (completed run): Gantt-style view driven by PhaseTiming rows
 *     from the phases DB table. Bar widths are proportional to wall_ms,
 *     making relative phase cost immediately visible.
 *
 * The persisted view takes precedence when persistedTimings is non-empty.
 */
import { Card } from "@/components/Card";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/format";
import type { PhaseTimelineEntry } from "@/stores/liveRunStore";
import type { PhaseTiming } from "../../../../shared/api-types.js";

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

/* ── Gantt bar view for completed runs ─────────────────────────────────── */

function GanttView({ timings }: { timings: PhaseTiming[] }) {
  const maxMs = timings.reduce((m, t) => Math.max(m, t.wall_ms), 0) || 1;
  return (
    <ol className="space-y-2 py-1">
      {timings.map((t) => {
        const pct = Math.max(2, (t.wall_ms / maxMs) * 100);
        return (
          <li key={t.id ?? t.phase} className="space-y-0.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-medium text-ink-2">
                {phaseLabel(t.phase)}
              </span>
              <span className="mono tnum shrink-0 text-[11px] text-ink-3">
                {formatDuration(t.wall_ms)}
              </span>
            </div>
            {/* Gantt bar — width proportional to wall_ms relative to longest phase */}
            <div
              className="h-1.5 rounded-full"
              style={{ background: "var(--line-2)", overflow: "hidden" }}
            >
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${pct}%`, background: "var(--pass)" }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ── Live event-driven view for in-flight runs ──────────────────────────── */

function LiveView({ entries }: { entries: PhaseTimelineEntry[] }) {
  return (
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
  );
}

/* ── Public component ───────────────────────────────────────────────────── */

export function PhaseTimeline({
  entries,
  persistedTimings,
}: {
  entries: PhaseTimelineEntry[];
  /** v12: persisted phase-timing rows from the phases DB table. When present
   *  and non-empty, renders a Gantt bar view instead of the live dot list. */
  persistedTimings?: PhaseTiming[];
}) {
  const hasPersistedTimings = (persistedTimings?.length ?? 0) > 0;

  if (!hasPersistedTimings && entries.length === 0) {
    return (
      <Card title="Phase Timeline">
        <p className="py-2 text-center text-[12px] text-ink-3">No phase data yet.</p>
      </Card>
    );
  }

  return (
    <Card title="Phase Timeline">
      {hasPersistedTimings ? (
        <GanttView timings={persistedTimings!} />
      ) : (
        <LiveView entries={entries} />
      )}
    </Card>
  );
}
