/**
 * AttemptMetaGrid — card per overlay.attempts entry, newest first.
 * Shows gen line, tokens, cost, stop_reason, verdict, tier escalation annotation.
 */
import { Card } from "@/components/Card";
import { cn } from "@/lib/cn";
import {
  VerdictChip,
  TierChip,
  Pill,
} from "@/features/common/chips";
import { formatUsd, formatTokens, shortId } from "@/lib/format";
import type { AttemptMeta, LiveRunOverlay } from "@/stores/liveRunStore";
import type { VerdictOutcome } from "@shared/api-types";

function ZeroBadge() {
  return (
    <span className="mono inline-flex items-center rounded-sm border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-[10px] text-warn">
      zero-change
    </span>
  );
}

function CrossVendorBadge() {
  return (
    <span
      className="mono inline-flex items-center rounded-sm border border-judge/40 bg-judge/10 px-1.5 py-0.5 text-[10px] text-judge"
      title="Cross-vendor judge"
    >
      ✕ vendor
    </span>
  );
}

function EscalationAnnotation({ detail }: { detail: string }) {
  return (
    <div className="mt-1 text-[11px] text-warn">
      ↑ {detail}
    </div>
  );
}

interface AttemptCardProps {
  meta: AttemptMeta;
  verdict?: VerdictOutcome;
  judgeModel?: string;
  crossVendor?: boolean;
  escalationNote?: string;
}

function AttemptMetaCard({
  meta,
  verdict,
  judgeModel,
  crossVendor,
  escalationNote,
}: AttemptCardProps) {
  const isRunning = meta.status === "running";
  const tokens =
    (meta.tokensIn ?? 0) + (meta.tokensOut ?? 0);

  return (
    <div
      className={cn(
        "rounded-md border bg-bg-1 p-3",
        isRunning ? "border-run/40" : "border-line-1",
      )}
    >
      {/* Gen line */}
      <div className="flex flex-wrap items-center gap-1.5">
        {meta.agent && (
          <span className="mono text-[12px] text-ink-2">{meta.agent}</span>
        )}
        {meta.agent && meta.model && (
          <span className="text-ink-3">·</span>
        )}
        {meta.model && (
          <span className="mono text-[12px] text-ink-1">{meta.model}</span>
        )}
        <TierChip tier={meta.tier} />
        {meta.retryIndex != null && meta.retryIndex > 0 && (
          <Pill tone="judge" title="reflexion retry">
            retry {meta.retryIndex}
          </Pill>
        )}
        {meta.candidateIndex != null && (
          <Pill tone="default" title="candidate index">
            c{meta.candidateIndex}
          </Pill>
        )}
        {isRunning && (
          <span
            className="mono ml-auto size-2 shrink-0 rounded-full pp-pulse"
            style={{ background: "var(--run)" }}
          />
        )}
      </div>

      {/* Attempt id + status */}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="mono text-[11px] text-ink-3" title={meta.attemptId}>
          {shortId(meta.attemptId, 14)}
        </span>
        <span
          className={cn(
            "mono text-[11px]",
            isRunning ? "text-run" : "text-pass",
          )}
        >
          {meta.status}
        </span>
      </div>

      {/* Escalation annotation */}
      {escalationNote && <EscalationAnnotation detail={escalationNote} />}

      {/* Stats */}
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5">
        {tokens > 0 && (
          <>
            <span className="text-[11px] text-ink-3">tokens in</span>
            <span className="mono tnum text-[11px] text-ink-2">
              {formatTokens(meta.tokensIn)}
            </span>
            <span className="text-[11px] text-ink-3">tokens out</span>
            <span className="mono tnum text-[11px] text-ink-2">
              {formatTokens(meta.tokensOut)}
            </span>
          </>
        )}
        {meta.costUsd != null && (
          <>
            <span className="text-[11px] text-ink-3">cost</span>
            <span className="mono tnum text-[11px] text-ink-2">
              {formatUsd(meta.costUsd)}
            </span>
          </>
        )}
        {meta.stopReason && (
          <>
            <span className="text-[11px] text-ink-3">stop</span>
            <span className="mono text-[11px] text-ink-2">{meta.stopReason}</span>
          </>
        )}
        {meta.toolCallCount != null && (
          <>
            <span className="text-[11px] text-ink-3">tools</span>
            <span className="mono tnum text-[11px] text-ink-2">
              {meta.toolCallCount}
            </span>
          </>
        )}
        {meta.filesChanged != null && (
          <>
            <span className="text-[11px] text-ink-3">files Δ</span>
            <span className="mono tnum text-[11px] text-ink-2">
              {meta.filesChanged}
            </span>
          </>
        )}
      </div>

      {/* Zero-change badge */}
      {meta.zeroChange && (
        <div className="mt-2">
          <ZeroBadge />
        </div>
      )}

      {/* Verdict row */}
      {verdict && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line-1 pt-2">
          <VerdictChip outcome={verdict} />
          {judgeModel && (
            <span className="mono text-[11px] text-ink-3">{judgeModel}</span>
          )}
          {crossVendor && <CrossVendorBadge />}
        </div>
      )}
    </div>
  );
}

interface AttemptMetaGridProps {
  overlay: LiveRunOverlay;
}

/** Parse judge model + cross-vendor flag from a verdict gate event detail string. */
function parseVerdictDetail(detail?: string): {
  judgeModel?: string;
  crossVendor?: boolean;
} {
  if (!detail) return {};
  const judgeMatch = /judge=([^\s]+)/.exec(detail);
  const crossMatch = /cross=(true|1)/.exec(detail);
  return {
    judgeModel: judgeMatch?.[1],
    crossVendor: crossMatch != null,
  };
}

export function AttemptMetaGrid({ overlay }: AttemptMetaGridProps) {
  const attempts = overlay.attempts ?? {};
  const gateEvents = overlay.gateEvents ?? [];

  // Build verdict lookup: attemptId → VerdictOutcome
  const verdictByAttempt: Record<string, VerdictOutcome> = {};
  for (const [id, outcome] of Object.entries(overlay.verdicts ?? {})) {
    verdictByAttempt[id] = outcome;
  }

  // Build verdict detail lookup from gate events (judge model + cross-vendor)
  const verdictDetailByAttempt: Record<
    string,
    { judgeModel?: string; crossVendor?: boolean }
  > = {};
  for (const ev of gateEvents) {
    if (ev.kind === "verdict" && ev.attemptId) {
      verdictDetailByAttempt[ev.attemptId] = parseVerdictDetail(ev.detail);
    }
  }

  // Build escalation lookup. Prefer keying by attemptId when the reflexion
  // event references one — stops us from smearing a single escalation across
  // every attempt in the stage (incl. attempts that predate the escalation).
  // Falls back to a per-stage note applied only to the CHILD attempt of the
  // retry (retryIndex > 0) so the initial attempt never wears the badge.
  const escalationByAttempt: Record<string, string> = {};
  const escalationByStage: Record<string, string> = {};
  for (const ev of gateEvents) {
    if (ev.kind !== "reflexion" || !ev.detail) continue;
    const tierMatch = /^([a-z]+)→([a-z]+)/.exec(ev.detail);
    if (!tierMatch) continue;
    const note = `escalated ${tierMatch[1]} → ${tierMatch[2]}`;
    if (ev.attemptId) {
      escalationByAttempt[ev.attemptId] = note;
    } else if (ev.stageId) {
      escalationByStage[ev.stageId] = note;
    }
  }

  const entries = Object.values(attempts);
  if (entries.length === 0) {
    return (
      <Card title="Attempts">
        <p className="py-2 text-center text-[12px] text-ink-3">
          No attempts yet.
        </p>
      </Card>
    );
  }

  // Sort newest first. Prefer startedAt; when either side lacks a timestamp,
  // tie-break by retryIndex desc, then candidateIndex desc, then attemptId desc
  // so we get a deterministic newest-first order instead of collapsing to the
  // Object.values() order.
  const sorted = [...entries].sort((a, b) => {
    const ta = a.startedAt ? Date.parse(a.startedAt) : NaN;
    const tb = b.startedAt ? Date.parse(b.startedAt) : NaN;
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
      return tb - ta;
    }
    const ra = a.retryIndex ?? 0;
    const rb = b.retryIndex ?? 0;
    if (ra !== rb) return rb - ra;
    const ca = a.candidateIndex ?? 0;
    const cb = b.candidateIndex ?? 0;
    if (ca !== cb) return cb - ca;
    return b.attemptId.localeCompare(a.attemptId);
  });

  return (
    <Card title={`Attempts (${entries.length})`}>
      <div className="space-y-3">
        {sorted.map((meta) => (
          <AttemptMetaCard
            key={meta.attemptId}
            meta={meta}
            verdict={verdictByAttempt[meta.attemptId]}
            judgeModel={
              verdictDetailByAttempt[meta.attemptId]?.judgeModel
            }
            crossVendor={
              verdictDetailByAttempt[meta.attemptId]?.crossVendor
            }
            escalationNote={
              escalationByAttempt[meta.attemptId] ??
              (meta.retryIndex != null && meta.retryIndex > 0
                ? escalationByStage[meta.stageId]
                : undefined)
            }
          />
        ))}
      </div>
    </Card>
  );
}
