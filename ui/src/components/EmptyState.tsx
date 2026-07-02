import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  /** Optional glyph / illustration. */
  icon?: ReactNode;
  /** Optional call-to-action(s). */
  actions?: ReactNode;
  className?: string;
  /** Compact variant for inline/section emptiness. */
  compact?: boolean;
}

export function EmptyState({ title, description, icon, actions, className, compact }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 py-8" : "gap-3 py-16",
        className,
      )}
    >
      {icon != null && (
        <div className="flex size-10 items-center justify-center rounded-md border border-line-1 bg-bg-2 text-ink-3 [&_svg]:size-5">
          {icon}
        </div>
      )}
      <div className="space-y-1">
        <div className="text-[13px] font-medium text-ink-1">{title}</div>
        {description != null && (
          <div className="max-w-sm text-[12px] leading-relaxed text-ink-3">{description}</div>
        )}
      </div>
      {actions != null && <div className="mt-1 flex items-center gap-2">{actions}</div>}
    </div>
  );
}
