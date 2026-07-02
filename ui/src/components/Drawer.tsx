import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { useDismissable } from "@/lib/overlay";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Side the drawer slides in from. */
  side?: "right" | "left";
  /** Width in px. */
  width?: number;
  className?: string;
}

/** Slide-over panel rendered in a portal. Used for artifact / attempt detail. */
export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
  side = "right",
  width = 520,
  className,
}: DrawerProps) {
  useDismissable(open, onClose);
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "absolute top-0 flex h-full flex-col border-line-2 bg-bg-1 shadow-2xl",
          side === "right" ? "right-0 border-l" : "left-0 border-r",
          className,
        )}
        style={{ width }}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line-1 px-4 py-2.5">
          <div className="truncate text-[13px] font-medium text-ink-1">{title}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 text-ink-3 transition-colors hover:text-ink-1"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">{children}</div>
        {footer != null && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line-1 bg-bg-2/50 px-4 py-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
