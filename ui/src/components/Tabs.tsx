import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TabItem {
  id: string;
  label: ReactNode;
  /** Optional count badge. */
  count?: number;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
}

/** Underline tab strip. Controlled. */
export function Tabs({ items, active, onChange, className }: TabsProps) {
  return (
    <div
      role="tablist"
      className={cn("flex items-stretch gap-0.5 border-b border-line-1", className)}
    >
      {items.map((it) => {
        const selected = it.id === active;
        return (
          <button
            key={it.id}
            role="tab"
            aria-selected={selected}
            disabled={it.disabled}
            onClick={() => !it.disabled && onChange(it.id)}
            className={cn(
              "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[12px] font-medium transition-colors",
              "disabled:opacity-40 disabled:pointer-events-none",
              selected
                ? "border-accent text-ink-1"
                : "border-transparent text-ink-3 hover:text-ink-1",
            )}
          >
            {it.label}
            {it.count != null && (
              <span
                className={cn(
                  "mono rounded-full px-1 text-[10px] leading-tight",
                  selected ? "bg-accent-dim/30 text-accent" : "bg-bg-3 text-ink-3",
                )}
              >
                {it.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
