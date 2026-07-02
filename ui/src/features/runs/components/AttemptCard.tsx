import type { AttemptRow } from "@shared/api-types";
import { cn } from "@/lib/cn";
import { KeyValue } from "@/components/KeyValue";
import { CopyButton } from "@/components/CopyButton";
import { AttemptStatusChip, TierChip, VendorChip, Pill } from "@/features/common/chips";
import { formatUsd, formatTokens, formatDuration, shortId } from "@/lib/format";

export function AttemptCard({
  attempt,
  liveStatus,
  winner,
  compact,
  children,
}: {
  attempt: AttemptRow;
  liveStatus?: string;
  winner?: boolean;
  compact?: boolean;
  children?: React.ReactNode;
}) {
  const status = (liveStatus ?? attempt.status) as AttemptRow["status"];
  return (
    <div
      className={cn(
        "rounded-md border bg-bg-1",
        winner ? "border-accent-dim" : "border-line-1",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-line-1 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {winner && <span className="text-accent" title="winner">★</span>}
          <VendorChip vendor={attempt.producer} />
          <span className="mono truncate text-[12px] text-ink-1">{attempt.model_id}</span>
          <TierChip tier={attempt.attempted_tier} />
          {attempt.retry_index > 0 && <Pill tone="judge" title="reflexion retry">retry {attempt.retry_index}</Pill>}
        </div>
        <AttemptStatusChip status={status} />
      </div>

      <div className="p-3">
        <KeyValue
          labelWidth={compact ? 64 : 90}
          rows={[
            {
              label: "attempt",
              mono: true,
              value: (
                <span className="inline-flex items-center gap-1.5">
                  {shortId(attempt.id, 14)}
                  <CopyButton value={attempt.id} title="Copy attempt id" />
                </span>
              ),
            },
            { label: "seed", value: attempt.prompt_hash ?? "—", mono: true },
            { label: "tokens", value: `${formatTokens(attempt.tokens_in)} in · ${formatTokens(attempt.tokens_out)} out`, mono: true },
            { label: "cost", value: formatUsd(attempt.cost_usd), mono: true },
            { label: "wall", value: formatDuration(attempt.wall_ms), mono: true },
          ]}
        />
        {children}
      </div>
    </div>
  );
}
