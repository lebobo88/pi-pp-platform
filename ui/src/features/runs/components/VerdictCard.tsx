import { useState } from "react";
import type { VerdictRow } from "@shared/api-types";
import { cn } from "@/lib/cn";
import { Drawer } from "@/components/Drawer";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/Button";
import { VerdictChip, Pill } from "@/features/common/chips";
import { RubricScoreTable } from "./RubricScoreTable";
import { verdictTone, toneVar } from "@/lib/status";
import { useRubric } from "@/api/queries/library";

export function VerdictCard({ verdict }: { verdict: VerdictRow }) {
  const [rubricOpen, setRubricOpen] = useState(false);
  const tone = verdictTone(verdict.outcome);

  return (
    <div className="rounded-md border border-line-1 bg-bg-1">
      <div
        className="flex items-center justify-between gap-2 rounded-t-md border-l-2 px-3 py-1.5"
        style={{ borderLeftColor: toneVar(tone), background: `color-mix(in srgb, ${toneVar(tone)} 8%, transparent)` }}
      >
        <div className="flex items-center gap-2">
          <VerdictChip outcome={verdict.outcome} />
          <span className="mono text-[11px] text-ink-2">{verdict.judge_model_id}</span>
          {verdict.cross_vendor === 1 && (
            <Pill tone="judge" title="cross-vendor verdict">cross-vendor</Pill>
          )}
        </div>
        {verdict.rubric_id && (
          <button
            type="button"
            onClick={() => setRubricOpen(true)}
            className="mono text-[11px] text-accent underline decoration-accent-dim hover:decoration-accent"
          >
            {verdict.rubric_id}
          </button>
        )}
      </div>

      <div className="space-y-2 p-3">
        {verdict.critique_md && <Markdown source={verdict.critique_md} className="text-[12px]" />}
        <RubricScoreTable scoreJson={verdict.score_json} />
      </div>

      {verdict.rubric_id && (
        <RubricDrawer
          rubricId={verdict.rubric_id}
          open={rubricOpen}
          onClose={() => setRubricOpen(false)}
        />
      )}
    </div>
  );
}

function RubricDrawer({ rubricId, open, onClose }: { rubricId: string; open: boolean; onClose: () => void }) {
  const { data, isLoading, error } = useRubric(open ? rubricId : undefined);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={<span className="mono">{rubricId}</span>}
      footer={<Button variant="primary" onClick={onClose}>Close</Button>}
    >
      {isLoading && <div className="text-[12px] text-ink-3">Loading rubric…</div>}
      {error && <div className="text-[12px] text-fail">Failed to load rubric.</div>}
      {data && (
        <>
          <div className="mb-3 flex items-center gap-2">
            <Pill tone="accent">{data.kind}</Pill>
            <Pill>v{data.version}</Pill>
            {data.source_url && (
              <a
                href={data.source_url}
                target="_blank"
                rel="noreferrer"
                className={cn("mono text-[11px] text-accent underline decoration-accent-dim")}
              >
                source ↗
              </a>
            )}
          </div>
          <Markdown source={data.markdown ?? "_No rubric body._"} />
        </>
      )}
    </Drawer>
  );
}
