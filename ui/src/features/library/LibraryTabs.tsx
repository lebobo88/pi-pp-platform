import { useNavigate } from "react-router";
import { Tabs } from "@/components/Tabs";

const ITEMS = [
  { id: "teams", label: "Teams", to: "/library/teams" },
  { id: "agents", label: "Agents", to: "/library/agents" },
  { id: "skills", label: "Skills", to: "/library/skills" },
  { id: "rubrics", label: "Rubrics", to: "/library/rubrics" },
  { id: "profiles", label: "Profiles", to: "/library/profiles" },
  { id: "forums", label: "Forums", to: "/library/forums" },
  { id: "taxonomy", label: "Taxonomy", to: "/library/taxonomy" },
] as const;

export type LibraryTab = (typeof ITEMS)[number]["id"];

/**
 * Tab strip shared by all /library/* pages. Each page passes its own list
 * length as `count` — it renders as a badge on that page's (active) tab.
 */
export function LibraryTabs({ active, count }: { active: LibraryTab; count?: number }) {
  const navigate = useNavigate();
  return (
    <div className="mb-4">
      <Tabs
        active={active}
        onChange={(id) => {
          const item = ITEMS.find((i) => i.id === id);
          if (item) navigate(item.to);
        }}
        items={ITEMS.map((i) => ({ id: i.id, label: i.label, count: i.id === active ? count : undefined }))}
      />
    </div>
  );
}
