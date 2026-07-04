import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { Pill } from "@/features/common/chips";
import { useTaxonomy } from "@/api/queries/library";
import { LibraryTabs } from "./LibraryTabs";

/** The 16 taxonomy sections (taxonomy_blueprint.md §4) as a flat table. */
export function TaxonomyPage() {
  const { data: sections, isLoading } = useTaxonomy();

  return (
    <Page title="Library" description="Taxonomy sections and their default artifact kinds.">
      <LibraryTabs active="taxonomy" count={sections?.length} />
      {isLoading ? (
        <EmptyState title="Loading taxonomy…" compact />
      ) : (
        <Card flush>
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-line-1 bg-bg-2 text-left">
                <th className="w-16 px-2.5 py-1.5 font-medium uppercase tracking-wide text-ink-3">id</th>
                <th className="px-2.5 py-1.5 font-medium uppercase tracking-wide text-ink-3">title</th>
                <th className="px-2.5 py-1.5 font-medium uppercase tracking-wide text-ink-3">artifact kinds</th>
                <th className="px-2.5 py-1.5 font-medium uppercase tracking-wide text-ink-3">master plan section</th>
              </tr>
            </thead>
            <tbody>
              {(sections ?? []).map((s) => (
                <tr key={s.id} className="border-b border-line-1/60">
                  <td className="mono tnum px-2.5 py-1.5 align-top text-ink-1">{s.id}</td>
                  <td className="px-2.5 py-1.5 align-top text-ink-1">{s.title}</td>
                  <td className="px-2.5 py-1.5 align-top">
                    <div className="flex flex-wrap gap-1">
                      {s.default_artifact_kinds.map((k) => (
                        <Pill key={k}>{k}</Pill>
                      ))}
                    </div>
                  </td>
                  <td className="mono px-2.5 py-1.5 align-top text-ink-2">{s.master_plan_section}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </Page>
  );
}
