import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { useDismissable } from "@/lib/overlay";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Max width in px. */
  width?: number;
  className?: string;
}

/** Centered modal dialog rendered in a portal. */
export function Modal({ open, onClose, title, children, footer, width = 440, className }: ModalProps) {
  useDismissable(open, onClose);
  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative z-10 w-full overflow-hidden rounded-md border border-line-2 bg-bg-1 shadow-2xl",
          className,
        )}
        style={{ maxWidth: width }}
      >
        {title != null && (
          <div className="flex items-center justify-between gap-3 border-b border-line-1 px-4 py-2.5">
            <div className="text-[13px] font-medium text-ink-1">{title}</div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-ink-3 transition-colors hover:text-ink-1"
            >
              ✕
            </button>
          </div>
        )}
        <div className="px-4 py-3 text-[13px] text-ink-1">{children}</div>
        {footer != null && (
          <div className="flex items-center justify-end gap-2 border-t border-line-1 bg-bg-2/50 px-4 py-2.5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
