import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { useUiStore, type ToastTone } from "@/stores/uiStore";

const toneStyle: Record<ToastTone, { bar: string; glyph: string }> = {
  info: { bar: "var(--run)", glyph: "ℹ" },
  success: { bar: "var(--pass)", glyph: "✓" },
  warn: { bar: "var(--warn)", glyph: "!" },
  error: { bar: "var(--fail)", glyph: "✕" },
};

/** Store-driven toast viewport. Mount once, near the app root. */
export function ToastViewport() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;

  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => {
        const s = toneStyle[t.tone];
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex overflow-hidden rounded-md border border-line-2 bg-bg-2 shadow-xl"
            role="status"
          >
            <span className="w-1 shrink-0" style={{ background: s.bar }} />
            <div className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2">
              <span className="mt-px text-[12px]" style={{ color: s.bar }} aria-hidden>
                {s.glyph}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-ink-1">{t.title}</div>
                {t.message != null && (
                  <div className="mt-0.5 break-words text-[11px] text-ink-3">{t.message}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                className={cn("shrink-0 text-ink-3 transition-colors hover:text-ink-1")}
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
