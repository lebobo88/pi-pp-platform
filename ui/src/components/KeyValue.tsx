import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface KeyValueRow {
  label: ReactNode;
  value: ReactNode;
  /** Render the value in the mono/tabular stack (ids, costs, tokens). */
  mono?: boolean;
}

export interface KeyValueProps {
  rows: KeyValueRow[];
  /** Label column width. */
  labelWidth?: number;
  className?: string;
}

/** Dense definition list for metadata panels. */
export function KeyValue({ rows, labelWidth = 116, className }: KeyValueProps) {
  return (
    <dl className={cn("grid gap-x-3 gap-y-1.5", className)} style={{ gridTemplateColumns: `${labelWidth}px 1fr` }}>
      {rows.map((r, i) => (
        <div key={i} className="contents">
          <dt className="truncate text-[12px] text-ink-3">{r.label}</dt>
          <dd
            className={cn(
              "min-w-0 break-words text-[12px] text-ink-1",
              r.mono && "mono tnum",
            )}
          >
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
