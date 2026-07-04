import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Markdown } from "@/components/Markdown";
import { EmptyState } from "@/components/EmptyState";
import { Pill } from "@/features/common/chips";
import { useSkills, useSkill } from "@/api/queries/library";
import { LibraryTabs } from "./LibraryTabs";
import { cn } from "@/lib/cn";

/** Master-detail skill-registry browser. Selection deep-links via ?id=. */
export function SkillsPage() {
  const { data: skills, isLoading } = useSkills();
  const [query, setQuery] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (skills ?? []).filter(
      (s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [skills, query]);

  const activeId = searchParams.get("id") ?? filtered[0]?.id ?? null;
  const { data: detail, isLoading: detailLoading } = useSkill(activeId ?? undefined);

  // A skill with no applies_to entries (or a "*") injects everywhere.
  const appliesEverywhere =
    !!detail &&
    (detail.applies_to_stages.length === 0 || detail.applies_to_stages.includes("*")) &&
    detail.applies_to_profiles.length === 0;

  return (
    <Page title="Library" description="Skills injected into generator and judge prompts.">
      <LibraryTabs active="skills" count={skills?.length} />
      {isLoading ? (
        <EmptyState title="Loading skills…" compact />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
          <div>
            <input
              data-testid="skills-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills…"
              className="mb-2 w-full rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent"
            />
            <Card flush className="max-h-[70vh] overflow-auto">
              {filtered.length === 0 ? (
                <EmptyState title="No skills match" description="Try a different search." compact />
              ) : (
                <ul className="divide-y divide-line-1">
                  {filtered.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        data-testid={`skill-row-${s.id}`}
                        onClick={() => setSearchParams({ id: s.id }, { replace: true })}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-2",
                          activeId === s.id && "bg-bg-2",
                        )}
                      >
                        <span className="mono truncate text-[12px] text-ink-1">{s.id}</span>
                        <Pill tone={s.injection === "judge" ? "judge" : "default"} title="injection target">
                          {s.injection}
                        </Pill>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card
            data-testid="skill-detail"
            title={activeId ? <span className="mono">{activeId}</span> : "Skill"}
            actions={detail && <Pill>{detail.origin}</Pill>}
          >
            {detailLoading ? (
              <div className="text-[12px] text-ink-3">Loading…</div>
            ) : detail ? (
              <>
                <p className="text-[13px] text-ink-2">{detail.description}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Pill tone={detail.injection === "judge" ? "judge" : "default"} title="injection target">
                    {detail.injection}
                  </Pill>
                  {detail.applies_to_stages.map((st) => (
                    <Pill key={st} title="applies to stage">{st}</Pill>
                  ))}
                  {detail.applies_to_profiles.map((p) => (
                    <Pill key={p} tone="accent" title="applies to profile">{p}</Pill>
                  ))}
                </div>
                {appliesEverywhere && (
                  <p className="mt-1.5 text-[11px] text-ink-3">applies to all stages</p>
                )}
                <div className="mt-4 border-t border-line-1 pt-3">
                  <Markdown source={detail.body || "_No skill body._"} />
                </div>
              </>
            ) : (
              <EmptyState title="Select a skill" compact />
            )}
          </Card>
        </div>
      )}
    </Page>
  );
}
