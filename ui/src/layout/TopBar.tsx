import { useMemo } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/Button";
import { Meter } from "@/components/Meter";
import { StatusDot } from "@/components/StatusChip";
import { IconPlus } from "@/components/icons";
import { ProjectPicker } from "@/layout/ProjectPicker";
import { useHealth } from "@/api/queries/system";
import { useBudgets, useCaps } from "@/api/queries/budgets";
import { formatUsd } from "@/lib/format";

export function TopBar() {
  const navigate = useNavigate();

  const { data: health } = useHealth();
  const { data: budgets } = useBudgets();
  const { data: caps } = useCaps();

  const daySpend = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const entry = budgets?.find((b) => b.scope === `day:${today}`) ?? budgets?.find((b) => b.scope.startsWith("day:"));
    return entry?.cost_usd ?? 0;
  }, [budgets]);

  const dayCap = caps?.find((c) => c.scope === "day")?.limit_usd;

  const healthy = health?.ok ?? false;

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line-1 bg-bg-1 px-3">
      <ProjectPicker />

      <div className="flex-1" />

      {/* Day budget: a capped meter when a day cap is configured, otherwise
          just the spend readout — never a fabricated max. */}
      {dayCap != null ? (
        <div className="w-40">
          <Meter
            value={daySpend}
            max={dayCap}
            height={5}
            readout={`${formatUsd(daySpend)} / ${formatUsd(dayCap)}`}
            label="Today"
            ticks={[
              { at: 0.8, tone: "warn" },
              { at: 1, tone: "fail" },
            ]}
          />
        </div>
      ) : (
        <div className="flex items-baseline gap-2" title="No day cap configured">
          <span className="text-[11px] text-ink-3">Today</span>
          <span className="mono tnum text-[11px] text-ink-2">{formatUsd(daySpend)}</span>
        </div>
      )}

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
