import { useMemo } from "react";
import { cn } from "@/lib/cn";
import { parseUnifiedDiff, diffStats, type DiffLine } from "@/lib/diff";
import { basename } from "@/lib/format";

export interface DiffViewProps {
  /** Raw unified diff text. */
  patch: string;
  className?: string;
  /** Hide the per-file header rows. */
  hideFileHeaders?: boolean;
}

const rowBase = "grid grid-cols-[44px_44px_1fr] font-mono text-[12px] leading-[1.5]";

function lineClasses(type: DiffLine["type"]): string {
  switch (type) {
    case "add":
      return "bg-[color-mix(in_srgb,var(--pass)_12%,transparent)]";
    case "del":
      return "bg-[color-mix(in_srgb,var(--fail)_12%,transparent)]";
    case "hunk":
      return "bg-bg-2 text-judge";
    case "meta":
      return "bg-bg-2/40 text-ink-3";
    default:
      return "";
  }
}

function gutterText(type: DiffLine["type"]): string {
  if (type === "add") return "+";
  if (type === "del") return "−";
  return "";
}

/** Hand-rolled unified-diff renderer. Colors +/- lines and hunk headers. */
export function DiffView({ patch, className, hideFileHeaders }: DiffViewProps) {
  const parsed = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const stats = useMemo(() => diffStats(parsed), [parsed]);

  if (parsed.files.length === 0) {
    return <div className="p-3 text-[12px] text-ink-3">No changes.</div>;
  }

  return (
    <div className={cn("overflow-hidden rounded-md border border-line-1 bg-bg-0", className)}>
      {!hideFileHeaders && (
        <div className="flex items-center justify-between gap-3 border-b border-line-1 bg-bg-2 px-3 py-1.5">
          <span className="mono truncate text-[12px] text-ink-2">
            {parsed.files.length === 1
              ? fileTitle(parsed.files[0]!.newPath, parsed.files[0]!.oldPath)
              : `${parsed.files.length} files`}
          </span>
          <span className="mono tnum shrink-0 text-[11px]">
            <span className="text-pass">+{stats.added}</span>{" "}
            <span className="text-fail">−{stats.removed}</span>
          </span>
        </div>
      )}
      <div className="overflow-auto">
        {parsed.files.map((file, fi) => (
          <div key={fi}>
            {!hideFileHeaders && parsed.files.length > 1 && (
              <div className="mono border-y border-line-1 bg-bg-2 px-3 py-1 text-[12px] text-ink-2">
                {fileTitle(file.newPath, file.oldPath)}
                {file.binary && <span className="ml-2 text-ink-3">(binary)</span>}
              </div>
            )}
            {file.binary && file.hunks.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-ink-3">Binary file not shown.</div>
            ) : (
              file.hunks.map((hunk, hi) => (
                <div key={hi}>
                  {hunk.lines.map((line, li) => (
                    <div key={li} className={cn(rowBase, lineClasses(line.type))}>
                      <span className="select-none border-r border-line-1/60 px-1.5 text-right text-ink-3">
                        {line.oldLine ?? ""}
                      </span>
                      <span className="select-none border-r border-line-1/60 px-1.5 text-right text-ink-3">
                        {line.newLine ?? ""}
                      </span>
                      <span className="flex whitespace-pre-wrap break-all px-2">
                        <span
                          className={cn(
                            "mr-1 inline-block w-2 shrink-0 select-none text-center",
                            line.type === "add" && "text-pass",
                            line.type === "del" && "text-fail",
                          )}
                        >
                          {gutterText(line.type)}
                        </span>
                        <span className="min-w-0">
                          {line.type === "hunk" || line.type === "meta" ? line.content : line.content || " "}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function fileTitle(newPath: string | null, oldPath: string | null): string {
  if (newPath && newPath !== "/dev/null") return basename(newPath);
  if (oldPath && oldPath !== "/dev/null") return `${basename(oldPath)} (deleted)`;
  return "diff";
}
