import { useState } from "react";
import { Link } from "react-router";
import type { Forum } from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Drawer } from "@/components/Drawer";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { StatusChip } from "@/components/StatusChip";
import { Pill } from "@/features/common/chips";
import { useForums, useForum } from "@/api/queries/library";
import { LibraryTabs } from "./LibraryTabs";

/** Governance-review forums (Section 8) — card grid with a pipeline drawer. */
export function ForumsPage() {
  const { data: forums, isLoading } = useForums();
  const [selected, setSelected] = useState<Forum | null>(null);

  return (
    <Page title="Library" description="Governance-review forums and their pipelines.">
      <LibraryTabs active="forums" count={forums?.length} />
      {isLoading ? (
        <EmptyState title="Loading forums…" compact />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(forums ?? []).map((forum) => (
            <button key={forum.id} type="button" onClick={() => setSelected(forum)} className="text-left">
              <Card
                className="h-full transition-colors hover:border-line-2"
                title={<span className="text-ink-1">{forum.title}</span>}
                actions={<Pill className="normal-case">{forum.id}</Pill>}
              >
                <p className="line-clamp-2 text-[12px] text-ink-3">{forum.description}</p>
                <p className="mono mt-2 text-[11px] text-ink-3" title="produces">
                  → {forum.produces}
                </p>
              </Card>
            </button>
          ))}
        </div>
      )}

      <ForumDetailDrawer forum={selected} onClose={() => setSelected(null)} />
    </Page>
  );
}

function ForumDetailDrawer({ forum, onClose }: { forum: Forum | null; onClose: () => void }) {
  // The list rows are the summary subset; fetch the full forum for the stages.
  const { data: full } = useForum(forum?.id);
  const detail = full ?? forum;
  return (
    <Drawer
      open={!!forum}
      onClose={onClose}
      width={560}
      title={forum ? <span className="flex items-center gap-2">{forum.title} <Pill>{forum.id}</Pill></span> : ""}
      footer={<Button variant="primary" onClick={onClose}>Close</Button>}
    >
      {detail && (
        <>
          <p className="text-[13px] text-ink-2">{detail.description}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1">
            <span className="text-[11px] text-ink-3">produces:</span>
            {detail.produces.split(/,\s*/).map((p) => (
              <Pill key={p} tone="accent">{p}</Pill>
            ))}
          </div>

          {!detail.stages && <p className="mt-4 text-[12px] text-ink-3">Loading pipeline…</p>}
          <div className="mt-4 space-y-2">
            {(detail.stages ?? []).map((s, i) => (
              <div key={i} className="rounded-md border border-line-1 bg-bg-1 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="mono text-[11px] text-ink-3">{i + 1}</span>
                    <span className="text-[13px] font-medium text-ink-1">{s.kind}</span>
                  </span>
                  <Pill>{s.gate_type}</Pill>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="text-ink-3">gen</span>
                  <Link to={`/library/agents?id=${encodeURIComponent(s.generator_agent)}`} onClick={onClose}>
                    <Pill tone="accent" className="transition-colors hover:border-accent">{s.generator_agent}</Pill>
                  </Link>
                  <span className="ml-2 text-ink-3">judge</span>
                  <StatusChip tone={s.judge_tier === "cross_vendor" ? "judge" : "dim"} label={s.judge_tier.replace(/_/g, "-")} />
                  {s.rubric_id && <Pill tone="accent">{s.rubric_id}</Pill>}
                  {s.artifact_kind && <Pill title="artifact kind">{s.artifact_kind}</Pill>}
                </div>
              </div>
            ))}
          </div>

          {detail.required_missability_checks && detail.required_missability_checks.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-1 border-t border-line-1 pt-3">
              <span className="text-[11px] text-ink-3">missability:</span>
              {detail.required_missability_checks.map((c) => (
                <Pill key={c}>{c}</Pill>
              ))}
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}
