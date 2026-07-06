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
  judgeProvider?: string;
  crossVendor?: boolean;
  escalationNote?: string;
}

function AttemptMetaCard({
  meta,
  verdict,
  judgeModel,
  judgeProvider,
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
        {meta.provider && (
          <Pill tone="default" title="provider">{meta.provider}</Pill>
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
          {judgeProvider && (
            <Pill tone="judge" title="judge provider">{judgeProvider}</Pill>
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

/** Parse judge model + cross-vendor flag + judge_provider from a verdict gate event detail string. */
function parseVerdictDetail(detail?: string): {
  judgeModel?: string;
  judgeProvider?: string;
  crossVendor?: boolean;
} {
  if (!detail) return {};
  const judgeMatch = /judge=([^\s]+)/.exec(detail);
  const judgeProviderMatch = /judge_provider=([^\s]+)/.exec(detail);
  const crossMatch = /cross=(true|1)/.exec(detail);
  return {
    judgeModel: judgeMatch?.[1],
    judgeProvider: judgeProviderMatch?.[1],
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
    { judgeModel?: string; judgeProvider?: string; crossVendor?: boolean }
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

  // Build a [timestamp, retryIndex, candidateIndex, attemptId] tuple for each
  // attempt so every pair is compared using the same key structure — a strict
  // weak ordering is required for Array.prototype.sort to be well-defined.
  function toSortKey(a: AttemptMeta): [number, number, number, string] {
    let ts: number;
    if (typeof a.startedAt === "number") {
      ts = a.startedAt;
    } else if (typeof a.startedAt === "string") {
      const parsed = Date.parse(a.startedAt);
      ts = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    } else {
      ts = Number.NEGATIVE_INFINITY;
    }
    return [
      ts,
      a.retryIndex ?? -1,
      a.candidateIndex ?? -1,
      typeof a.attemptId === "string" ? a.attemptId : "",
    ];
  }

  // Sort newest first by the same tuple for every pair (strictly weak ordering).
  const sorted = [...entries].sort((a, b) => {
    const ka = toSortKey(a);
    const kb = toSortKey(b);
    // startedAt desc
    if (ka[0] !== kb[0]) return kb[0] - ka[0];
    // retryIndex desc
    if (ka[1] !== kb[1]) return kb[1] - ka[1];
    // candidateIndex desc
    if (ka[2] !== kb[2]) return kb[2] - ka[2];
    // attemptId asc (lexicographic total-ordering tie-breaker)
    return ka[3] < kb[3] ? -1 : ka[3] > kb[3] ? 1 : 0;
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
            judgeProvider={
              verdictDetailByAttempt[meta.attemptId]?.judgeProvider
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
