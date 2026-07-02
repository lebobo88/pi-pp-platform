import { useNavigate } from "react-router";
import { Tabs } from "@/components/Tabs";

const ITEMS = [
  { id: "teams", label: "Teams", to: "/library/teams" },
  { id: "rubrics", label: "Rubrics", to: "/library/rubrics" },
  { id: "profiles", label: "Profiles", to: "/library/profiles" },
] as const;

export function LibraryTabs({ active }: { active: "teams" | "rubrics" | "profiles" }) {
  const navigate = useNavigate();
  return (
    <div className="mb-4">
      <Tabs
        active={active}
        onChange={(id) => {
          const item = ITEMS.find((i) => i.id === id);
          if (item) navigate(item.to);
        }}
        items={ITEMS.map((i) => ({ id: i.id, label: i.label }))}
      />
    </div>
  );
}
