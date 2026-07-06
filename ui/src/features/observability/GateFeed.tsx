/**
 * GateFeed — typed live event feed, newest-first.
 * Renders the overlay.gateEvents ring (capped at 200).
 */
import { Card } from "@/components/Card";
import { cn } from "@/lib/cn";
import type { GateEvent, GateEventKind } from "@/stores/liveRunStore";
import { shortId } from "@/lib/format";

/* ── Kind chip colors ─────────────────────────────────────────────────── */

const KIND_COLOR: Record<GateEventKind, string> = {
  gen: "var(--accent)",
  hook: "var(--dim)",
  artifact: "var(--pass)",
  judge: "var(--judge)",
  verdict: "var(--judge)",
  reflexion: "var(--warn)",
  smoke: "var(--warn)",
  validation: "var(--run)",
  missability: "var(--run)",
  borda: "var(--accent-dim, var(--accent))",
  surfaced: "var(--warn)",
};

function KindChip({ kind }: { kind: GateEventKind }) {
  const color = KIND_COLOR[kind] ?? "var(--dim)";
  return (
    <span
      className="mono inline-flex shrink-0 items-center rounded-sm border px-1.5 py-0.5 text-[10px] leading-none"
      style={{
        borderColor: `color-mix(in srgb,${color} 45%,transparent)`,
        color,
      }}
    >
      {kind}
    </span>
  );
}

function OutcomeChip({ outcome }: { outcome: string }) {
  const isPass =
    outcome === "ok" || outcome === "pass" || outcome === "updated";
  const isFail = outcome === "fail" || outcome === "error";
  const isWarn = outcome === "retry" || outcome === "surfaced" || outcome === "revise";

  const color = isPass
    ? "var(--pass)"
    : isFail
      ? "var(--fail)"
      : isWarn
        ? "var(--warn)"
        : "var(--ink-3)";

  return (
    <span
      className="mono shrink-0 text-[10px]"
      style={{ color }}
    >
      {outcome}
    </span>
  );
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const DETAIL_MAX = 80;

function truncateDetail(s: string): { text: string; truncated: boolean } {
  if (s.length <= DETAIL_MAX) return { text: s, truncated: false };
  return { text: s.slice(0, DETAIL_MAX) + "…", truncated: true };
}

interface GateEventRowProps {
  ev: GateEvent;
}

function GateEventRow({ ev }: GateEventRowProps) {
  const time = formatTime(ev.at);
  const detail = ev.detail ? truncateDetail(ev.detail) : null;

  return (
    <div className="flex items-start gap-2 border-b border-line-1/40 py-1.5 last:border-b-0">
      {/* seq */}
      <span className="mono w-8 shrink-0 text-right text-[10px] text-ink-3/60">
        {ev.seq >= 0 ? ev.seq : "—"}
      </span>

      {/* time */}
      <span className="mono shrink-0 text-[11px] text-ink-3">{time}</span>

      {/* kind chip */}
      <KindChip kind={ev.kind} />

      {/* stage / attempt ids */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {ev.stageId && (
          <span
            className="mono truncate text-[11px] text-ink-3"
            title={ev.stageId}
          >
            {shortId(ev.stageId, 12)}
          </span>
        )}
        {ev.attemptId && (
          <span
            className="mono truncate text-[11px] text-ink-3/70"
            title={ev.attemptId}
          >
            / {shortId(ev.attemptId, 12)}
          </span>
        )}

        {/* outcome */}
        {ev.outcome && <OutcomeChip outcome={ev.outcome} />}

        {/* detail */}
        {detail && (
          <span
            className={cn(
              "min-w-0 truncate text-[11px] text-ink-3",
            )}
            title={detail.truncated ? ev.detail : undefined}
          >
            {detail.text}
          </span>
        )}
      </div>
    </div>
  );
}

interface GateFeedProps {
  events: GateEvent[];
}

export function GateFeed({ events }: GateFeedProps) {
  // Render newest-first; cap at ring size (200)
  const sorted = [...events].reverse().slice(0, 200);

  return (
    <Card
      title={`Gate Feed (${events.length})`}
      flush
    >
      {sorted.length === 0 ? (
        <div className="px-3 py-4 text-center text-[12px] text-ink-3">
          No events yet.
        </div>
      ) : (
        <div className="max-h-[480px] overflow-y-auto px-3">
          {sorted.map((ev, i) => (
            <GateEventRow key={`${ev.seq}-${i}`} ev={ev} />
          ))}
        </div>
      )}
    </Card>
  );
}
