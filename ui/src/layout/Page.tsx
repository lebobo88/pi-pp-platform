import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface PageProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** Standard page frame: header row + scrollable body with consistent padding. */
export function Page({ title, description, actions, children, className }: PageProps) {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-5 py-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[18px] font-semibold tracking-tight text-ink-1">{title}</h1>
          {description != null && (
            <p className="mt-0.5 text-[12px] text-ink-3">{description}</p>
          )}
        </div>
        {actions != null && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className={cn(className)}>{children}</div>
    </div>
  );
}
