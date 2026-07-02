import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { KeyValue } from "@/components/KeyValue";
import { Pill } from "@/features/common/chips";
import { useProfiles } from "@/api/queries/library";
import { LibraryTabs } from "./LibraryTabs";

export function ProfilesPage() {
  const { data: profiles, isLoading } = useProfiles();

  return (
    <Page title="Library" description="Project profiles and their gate policy.">
      <LibraryTabs active="profiles" />
      {isLoading ? (
        <EmptyState title="Loading profiles…" compact />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {(profiles ?? []).map((p) => (
            <Card key={p.name} title={<span className="flex items-center gap-2 text-ink-1">{p.name}</span>}>
              <p className="text-[12px] text-ink-3">{p.description}</p>

              {p.extends && p.extends.length > 0 && (
                <div className="mt-2 flex items-center gap-1.5 text-[11px]">
                  <span className="text-ink-3">extends</span>
                  {p.extends.map((e, i) => (
                    <span key={e} className="flex items-center gap-1.5">
                      {i > 0 && <span className="text-ink-3">→</span>}
                      <Pill tone="accent">{e}</Pill>
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-3">
                <KeyValue
                  labelWidth={128}
                  rows={[
                    { label: "taxonomy", value: p.required_taxonomy_sections?.join(", ") || "—", mono: true },
                    { label: "rubrics", value: p.required_rubrics ? Object.entries(p.required_rubrics).map(([g, r]) => `${g}=${r}`).join(", ") : "—", mono: true },
                    { label: "artifacts", value: p.required_artifacts?.join(", ") || "—", mono: true },
                    { label: "validators", value: p.required_validators ? Object.keys(p.required_validators).join(", ") : "—", mono: true },
                    { label: "strict validators", value: p.required_validators_strict?.join(", ") || "—", mono: true },
                    { label: "missability", value: p.required_missability_checks?.join(", ") || "—", mono: true },
                  ]}
                />
              </div>
              {p.notes && <p className="mt-2 border-t border-line-1 pt-2 text-[11px] text-ink-3">{p.notes}</p>}
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}
