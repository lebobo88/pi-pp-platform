import { useState } from "react";
import type { TeamSpec } from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Drawer } from "@/components/Drawer";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { StatusChip } from "@/components/StatusChip";
import { Pill } from "@/features/common/chips";
import { useTeams, useTeam } from "@/api/queries/library";
import { LibraryTabs } from "./LibraryTabs";

export function TeamsPage() {
  const { data: teams, isLoading } = useTeams();
  const [selected, setSelected] = useState<TeamSpec | null>(null);

  return (
    <Page title="Library" description="Specialized team pipelines (project → user → built-in).">
      <LibraryTabs active="teams" />
      {isLoading ? (
        <EmptyState title="Loading teams…" compact />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(teams ?? []).map((team) => (
            <button key={team.name} type="button" onClick={() => setSelected(team)} className="text-left">
              <Card
                className="h-full transition-colors hover:border-line-2"
                title={<span className="text-ink-1">{team.name}</span>}
                actions={team.origin && <OriginBadge origin={team.origin} />}
              >
                <p className="line-clamp-2 text-[12px] text-ink-3">{team.description}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {/* The list endpoint omits stages — show taxonomy tags instead. */}
                  {(team.stages ?? []).map((s, i) => (
                    <Pill key={i} title={`${s.gate_type} · ${s.judge.tier}`}>{s.kind}</Pill>
                  ))}
                  {!team.stages && (team.taxonomy_required ?? []).map((t) => (
                    <Pill key={t} tone="accent">{t}</Pill>
                  ))}
                </div>
              </Card>
            </button>
          ))}
        </div>
      )}

      <TeamDetailDrawer team={selected} onClose={() => setSelected(null)} />
    </Page>
  );
}

function OriginBadge({ origin }: { origin: "project" | "user" | "builtin" }) {
  const tone = origin === "project" ? "accent" : origin === "user" ? "run" : "default";
  return <Pill tone={tone}>{origin}</Pill>;
}

function TeamDetailDrawer({ team, onClose }: { team: TeamSpec | null; onClose: () => void }) {
  // The list item lacks stages; fetch the full team for the pipeline.
  const { data: full } = useTeam(team?.name);
  const detail = full ?? team;
  return (
    <Drawer
      open={!!team}
      onClose={onClose}
      width={560}
      title={team ? <span className="flex items-center gap-2">{team.name} {team.origin && <OriginBadge origin={team.origin} />}</span> : ""}
      footer={<Button variant="primary" onClick={onClose}>Close</Button>}
    >
      {detail && (
        <>
          <p className="text-[13px] text-ink-2">{detail.description}</p>
          {detail.taxonomy_required && detail.taxonomy_required.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-ink-3">taxonomy:</span>
              {detail.taxonomy_required.map((t) => (
                <Pill key={t} tone="accent">{t}</Pill>
              ))}
            </div>
          )}

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
                  <Pill>{s.generator.primary ?? s.generator.agent}</Pill>
                  {s.generator.model_tier && <Pill tone="judge">{s.generator.model_tier}</Pill>}
                  <span className="ml-2 text-ink-3">judge</span>
                  <StatusChip tone={s.judge.tier === "cross_vendor" ? "judge" : "dim"} label={s.judge.tier.replace(/_/g, "-")} />
                  {s.judge.rubric && <Pill tone="accent">{s.judge.rubric}</Pill>}
                  {s.best_of_n_on_major_scope && <Pill tone="accent">best-of {s.best_of_n_on_major_scope} @ major</Pill>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Drawer>
  );
}
