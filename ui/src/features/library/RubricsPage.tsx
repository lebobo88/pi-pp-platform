import { useState } from "react";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Markdown } from "@/components/Markdown";
import { EmptyState } from "@/components/EmptyState";
import { Pill } from "@/features/common/chips";
import { useRubrics, useRubric } from "@/api/queries/library";
import { LibraryTabs } from "./LibraryTabs";
import { cn } from "@/lib/cn";

export function RubricsPage() {
  const { data: rubrics, isLoading } = useRubrics();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeId = selectedId ?? rubrics?.[0]?.id ?? null;
  const { data: detail, isLoading: bodyLoading } = useRubric(activeId ?? undefined);

  return (
    <Page title="Library" description="Standard-aligned judging rubrics shipped with the harness.">
      <LibraryTabs active="rubrics" />
      {isLoading ? (
        <EmptyState title="Loading rubrics…" compact />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <Card flush>
            <ul className="divide-y divide-line-1">
              {(rubrics ?? []).map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-2",
                      activeId === r.id && "bg-bg-2",
                    )}
                  >
                    <span className="mono truncate text-[12px] text-ink-1">{r.id}</span>
                    <Pill>{r.kind}</Pill>
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          <Card
            title={activeId ? <span className="mono">{activeId}</span> : "Rubric"}
            actions={detail?.source_url && (
              <a href={detail.source_url} target="_blank" rel="noreferrer" className="mono text-[11px] text-accent underline decoration-accent-dim">
                source ↗
              </a>
            )}
          >
            {bodyLoading ? (
              <div className="text-[12px] text-ink-3">Loading…</div>
            ) : detail ? (
              <Markdown source={detail.markdown ?? "_No body._"} />
            ) : (
              <EmptyState title="Select a rubric" compact />
            )}
          </Card>
        </div>
      )}
    </Page>
  );
}
