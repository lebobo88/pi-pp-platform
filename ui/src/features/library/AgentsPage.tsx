import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { AgentSummary } from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Markdown } from "@/components/Markdown";
import { EmptyState } from "@/components/EmptyState";
import { Pill } from "@/features/common/chips";
import { useAgents, useAgent } from "@/api/queries/library";
import { LibraryTabs } from "./LibraryTabs";
import { cn } from "@/lib/cn";

/** Master-detail agent-prompt browser. Selection deep-links via ?id=. */
export function AgentsPage() {
  const { data: agents, isLoading } = useAgents();
  const [query, setQuery] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();

  // Filter by name + description, then group by category alphabetically.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (agents ?? []).filter(
      (a) => !q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
    );
    const byCategory = new Map<string, AgentSummary[]>();
    for (const a of filtered) {
      const list = byCategory.get(a.category) ?? [];
      list.push(a);
      byCategory.set(a.category, list);
    }
    return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [agents, query]);

  const firstVisibleId = groups[0]?.[1][0]?.id ?? null;
  const activeId = searchParams.get("id") ?? firstVisibleId;
  const { data: detail, isLoading: detailLoading } = useAgent(activeId ?? undefined);

  const select = (id: string) => setSearchParams({ id }, { replace: true });

  return (
    <Page title="Library" description="Agent prompts dispatched by team and forum stages.">
      <LibraryTabs active="agents" count={agents?.length} />
      {isLoading ? (
        <EmptyState title="Loading agents…" compact />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <div>
            <input
              data-testid="agents-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents…"
              className="mb-2 w-full rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent"
            />
            <Card flush className="max-h-[70vh] overflow-auto">
              {groups.length === 0 ? (
                <EmptyState title="No agents match" description="Try a different search." compact />
              ) : (
                groups.map(([category, list]) => (
                  <div key={category}>
                    <div
                      data-testid={`agents-group-${category}`}
                      className="sticky top-0 z-10 border-b border-line-1 bg-bg-1 px-3 py-1 text-[11px] uppercase tracking-wide text-ink-3"
                    >
                      {category}
                    </div>
                    <ul className="divide-y divide-line-1">
                      {list.map((a) => (
                        <li key={a.id}>
                          <button
                            type="button"
                            data-testid={`agent-row-${a.id}`}
                            onClick={() => select(a.id)}
                            className={cn(
                              "flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-2",
                              activeId === a.id && "bg-bg-2",
                            )}
                          >
                            <span className="mono truncate text-[12px] text-ink-1">{a.id}</span>
                            <Pill title="referencing teams">{a.teams.length}</Pill>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </Card>
          </div>

          <Card
            data-testid="agent-detail"
            title={activeId ? <span className="mono">{activeId}</span> : "Agent"}
            actions={detail && <Pill>{detail.origin}</Pill>}
          >
            {detailLoading ? (
              <div className="text-[12px] text-ink-3">Loading…</div>
            ) : detail ? (
              <>
                <p className="text-[13px] text-ink-2">{detail.description}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Pill tone="accent">{detail.category}</Pill>
                  {detail.tier && <Pill tone="judge" title="model tier">{detail.tier}</Pill>}
                  {detail.model && <Pill title="frontmatter model">{detail.model}</Pill>}
                </div>
                {detail.teams.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-1">
                    <span className="text-[11px] text-ink-3">used by</span>
                    {detail.teams.map((t) => (
                      <Link key={t} to="/library/teams">
                        <Pill tone="accent" className="transition-colors hover:border-accent">{t}</Pill>
                      </Link>
                    ))}
                  </div>
                )}
                <div className="mt-4 border-t border-line-1 pt-3">
                  <Markdown source={detail.body || "_No prompt body._"} />
                </div>
              </>
            ) : (
              <EmptyState title="Select an agent" compact />
            )}
          </Card>
        </div>
      )}
    </Page>
  );
}
