import { useMemo } from "react";
import { useNavigate } from "react-router";
import { cn } from "@/lib/cn";
import { Button } from "@/components/Button";
import { Meter } from "@/components/Meter";
import { StatusDot } from "@/components/StatusChip";
import { IconPlus, IconChevron } from "@/components/icons";
import { useUiStore } from "@/stores/uiStore";
import { useProjects } from "@/api/queries/projects";
import { useHealth } from "@/api/queries/system";
import { useBudgets } from "@/api/queries/budgets";
import { formatUsd } from "@/lib/format";

/** Day budget assumption for the mini-meter until a configured cap exists. */
const DAY_BUDGET_USD = 8;

export function TopBar() {
  const navigate = useNavigate();
  const activeProjectPath = useUiStore((s) => s.activeProjectPath);
  const setActiveProject = useUiStore((s) => s.setActiveProject);

  const { data: projects } = useProjects();
  const { data: health } = useHealth();
  const { data: budgets } = useBudgets();

  const daySpend = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const entry = budgets?.find((b) => b.scope === `day:${today}`) ?? budgets?.find((b) => b.scope.startsWith("day:"));
    return entry?.cost_usd ?? 0;
  }, [budgets]);

  const healthy = health?.ok ?? false;

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line-1 bg-bg-1 px-3">
      {/* Project picker placeholder — a native select stands in for the
          searchable picker later agents will build. */}
      <div className="relative">
        <select
          value={activeProjectPath ?? ""}
          onChange={(e) => setActiveProject(e.target.value || null)}
          className={cn(
            "h-7 min-w-[180px] appearance-none rounded-sm border border-line-2 bg-bg-2 pl-2.5 pr-7",
            "text-[12px] text-ink-1 outline-none hover:border-ink-3",
          )}
        >
          <option value="">All projects</option>
          {projects?.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>
        <IconChevron className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 rotate-90 text-ink-3" />
      </div>

      <div className="flex-1" />

      {/* Day budget mini-meter */}
      <div className="w-40">
        <Meter
          value={daySpend}
          max={DAY_BUDGET_USD}
          height={5}
          readout={`${formatUsd(daySpend)} / ${formatUsd(DAY_BUDGET_USD)}`}
          label="Today"
          ticks={[
            { at: 0.8, tone: "warn" },
            { at: 1, tone: "fail" },
          ]}
        />
      </div>

      {/* Health dot */}
      <div
        className="flex items-center gap-1.5 rounded-sm border border-line-1 bg-bg-2 px-2 py-1"
        title={healthy ? "Daemon reachable" : "Daemon unreachable"}
      >
        <StatusDot tone={healthy ? "pass" : "fail"} pulse={healthy} />
        <span className="text-[11px] text-ink-2">{healthy ? "online" : "offline"}</span>
      </div>

      <Button variant="primary" size="sm" icon={<IconPlus />} onClick={() => navigate("/runs/new")}>
        New run
      </Button>
    </header>
  );
}
