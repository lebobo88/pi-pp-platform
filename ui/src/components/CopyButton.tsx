import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export interface CopyButtonProps {
  /** Text to write to the clipboard. */
  value: string;
  /** Optional label; when omitted the button is icon-only. */
  label?: string;
  className?: string;
  title?: string;
}

/** Copies `value` to the clipboard and flashes a confirmation. */
export function CopyButton({ value, label, className, title }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback for environments without the async clipboard API.
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* give up silently */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1100);
  }, [value]);

  return (
    <button
      type="button"
      onClick={onCopy}
      title={title ?? "Copy"}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border border-line-1 bg-bg-2 px-1.5 py-0.5",
        "text-[11px] text-ink-2 transition-colors hover:border-line-2 hover:text-ink-1",
        copied && "border-pass text-pass",
        className,
      )}
    >
      <span aria-hidden className="text-[11px]">
        {copied ? "✓" : "⧉"}
      </span>
      {label != null && <span>{copied ? "Copied" : label}</span>}
    </button>
  );
}
