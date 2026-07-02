import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Optional header title. */
  title?: ReactNode;
  /** Optional right-aligned header slot (actions, status). */
  actions?: ReactNode;
  /** Remove inner padding (for tables / logs that manage their own). */
  flush?: boolean;
}

export function Card({ title, actions, flush, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-md border border-line-1 bg-bg-1 shadow-[0_1px_0_0_rgba(255,255,255,0.02)_inset]",
        className,
      )}
      {...rest}
    >
      {(title != null || actions != null) && (
        <div className="flex items-center justify-between gap-3 border-b border-line-1 px-3 py-2">
          <div className="text-[12px] font-medium uppercase tracking-wide text-ink-2">
            {title}
          </div>
          {actions != null && <div className="flex items-center gap-1.5">{actions}</div>}
        </div>
      )}
      <div className={cn(!flush && "p-3")}>{children}</div>
    </div>
  );
}
