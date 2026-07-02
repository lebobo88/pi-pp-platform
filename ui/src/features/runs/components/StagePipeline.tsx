import { cn } from "@/lib/cn";
import type { PipelineNode, PipelineState } from "@/lib/runModel";
import { Pill } from "@/features/common/chips";

const STATE_COLOR: Record<PipelineState, string> = {
  pending: "var(--dim)",
  running: "var(--run)",
  passed: "var(--pass)",
  surfaced: "var(--warn)",
  failed: "var(--fail)",
  skipped: "var(--dim)",
};

export function StagePipeline({
  nodes,
  selectedStageId,
  onSelect,
}: {
  nodes: PipelineNode[];
  selectedStageId: string | null;
  onSelect: (stageId: string) => void;
}) {
  return (
    <div className="rounded-md border border-line-1 bg-bg-1 p-2">
      <div className="mb-1 px-1.5 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">
        Pipeline
      </div>
      <ol className="relative">
        {nodes.map((node, i) => {
          const selected = node.stageId === selectedStageId;
          const color = STATE_COLOR[node.state];
          const isLast = i === nodes.length - 1;
          return (
            <li key={node.stageId} className="relative">
              {!isLast && (
                <span
                  className="absolute left-[13px] top-6 h-[calc(100%-12px)] w-px"
                  style={{ background: "var(--line-2)" }}
                  aria-hidden
                />
              )}
              <button
                type="button"
                onClick={() => onSelect(node.stageId)}
                className={cn(
                  "relative flex w-full items-center gap-2.5 rounded-sm px-1.5 py-1.5 text-left transition-colors",
                  selected ? "bg-bg-3" : "hover:bg-bg-2",
                )}
              >
                <span
                  className={cn(
                    "z-10 flex size-[18px] shrink-0 items-center justify-center rounded-full border-2",
                    node.state === "running" && "pp-pulse",
                  )}
                  style={{ borderColor: color, background: "var(--bg-1)" }}
                >
                  <span className="size-1.5 rounded-full" style={{ background: color }} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-[12px]", selected ? "text-ink-1" : "text-ink-2")}>
                    {node.kind}
                  </span>
                  <span className="mono text-[10px] text-ink-3">{node.gateType}</span>
                </span>
                {node.isBestOf && (
                  <Pill tone="accent" title="best-of-N stage">
                    ×{node.attemptCount}
                  </Pill>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
