import { useEffect, useRef, useState, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/cn";
import { parseAnsi, stripAnsi, type AnsiColor } from "@/lib/ansi";
import { useAttemptLog } from "@/stores/useLiveRun";
import { CopyButton } from "@/components/CopyButton";

export interface LogPaneProps {
  /** Attempt id whose buffer to tail (from liveRunStore). */
  attemptId?: string;
  /** Static lines, when not tailing a live attempt. */
  lines?: string[];
  className?: string;
  /** Pixel height of the scroll viewport. */
  height?: number;
  title?: string;
}

const ANSI_VAR: Record<AnsiColor, string> = {
  black: "var(--ink-3)",
  red: "var(--fail)",
  green: "var(--pass)",
  yellow: "var(--warn)",
  blue: "var(--run)",
  magenta: "var(--judge)",
  cyan: "var(--run)",
  white: "var(--ink-1)",
};

const ROW_HEIGHT = 17;

/**
 * Virtualized append-only log viewer with a sticky "follow" pill. While
 * following, new lines auto-scroll into view; scrolling up detaches follow and
 * shows a pill to re-attach. Renders a minimal ANSI SGR color subset.
 */
export function LogPane({ attemptId, lines: staticLines, className, height = 320, title }: LogPaneProps) {
  const buffer = useAttemptLog(attemptId ?? "__none__");
  const lines = staticLines ?? buffer.lines;

  const parentRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 24,
  });

  // Auto-scroll to bottom while following.
  useEffect(() => {
    if (follow && lines.length > 0) {
      virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
    }
  }, [lines.length, follow, virtualizer]);

  // Detach follow when the user scrolls away from the bottom.
  const onScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * 1.5;
    setFollow(atBottom);
  }, []);

  const copyText = staticLines
    ? staticLines.map(stripAnsi).join("\n")
    : buffer.lines.map(stripAnsi).join("\n");

  const items = virtualizer.getVirtualItems();

  return (
    <div className={cn("relative overflow-hidden rounded-md border border-line-1 bg-bg-0", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-line-1 bg-bg-2 px-3 py-1.5">
        <span className="mono truncate text-[11px] text-ink-3">
          {title ?? "output"}
          {buffer.dropped > 0 && (
            <span className="ml-2 text-ink-3">(+{buffer.dropped} older lines trimmed)</span>
          )}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="mono tnum text-[11px] text-ink-3">{lines.length} lines</span>
          <CopyButton value={copyText} title="Copy log" />
        </div>
      </div>

      <div
        ref={parentRef}
        onScroll={onScroll}
        className="overflow-auto bg-bg-0"
        style={{ height }}
      >
        {lines.length === 0 ? (
          <div className="px-3 py-2 font-mono text-[12px] text-ink-3">No output yet.</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
            {items.map((vi) => {
              const line = lines[vi.index] ?? "";
              return (
                <div
                  key={vi.key}
                  className="mono absolute left-0 flex w-full whitespace-pre px-3 text-[12px] leading-[17px]"
                  style={{ top: 0, transform: `translateY(${vi.start}px)`, height: ROW_HEIGHT }}
                >
                  <span className="mr-3 inline-block w-8 shrink-0 select-none text-right text-ink-3/50">
                    {vi.index + 1 + buffer.dropped}
                  </span>
                  <span className="min-w-0 flex-1">
                    {parseAnsi(line).map((span, i) => (
                      <span
                        key={i}
                        style={{
                          color: span.color ? ANSI_VAR[span.color] : undefined,
                          fontWeight: span.bold ? 600 : undefined,
                          opacity: span.dim ? 0.6 : undefined,
                        }}
                      >
                        {span.text}
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!follow && (
        <button
          type="button"
          onClick={() => {
            setFollow(true);
            if (lines.length > 0) virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
          }}
          className={cn(
            "absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-accent bg-bg-2 px-3 py-1",
            "text-[11px] font-medium text-accent shadow-lg transition-colors hover:bg-bg-3",
          )}
        >
          ↓ Follow
        </button>
      )}
    </div>
  );
}
