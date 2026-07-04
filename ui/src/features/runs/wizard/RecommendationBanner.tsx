/**
 * Advisory strip above the mode grid showing the team recommender's top pick.
 * Errors are deliberately silent (the recommendation is a hint, not a gate);
 * while the heuristics run we show a single quiet line.
 */
import type { RunMode, TeamRecommendResponse } from "@shared/api-types";
import { Button } from "@/components/Button";
import { Pill } from "@/features/common/chips";

export function RecommendationBanner({
  loading,
  response,
  mode,
  onUseTeamMode,
}: {
  loading: boolean;
  response: TeamRecommendResponse | null;
  mode: RunMode;
  onUseTeamMode: (team: string) => void;
}) {
  if (loading) {
    return <p className="text-[11px] text-ink-3">Analyzing request…</p>;
  }
  const top = response?.recommendations[0];
  if (!top) return null;

  return (
    <div className="rounded-md border border-accent-dim/40 bg-bg-2 p-2.5" data-testid="recommendation-banner">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="accent">recommended team</Pill>
        <span className="text-[12px] font-medium text-ink-1">{top.team}</span>
        <span className="mono text-[11px] text-ink-3">confidence {top.confidence}</span>
      </div>
      {top.reasons.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {top.reasons.map((r, i) => (
            <li key={i} className="text-[11px] text-ink-3">
              · {r}
            </li>
          ))}
        </ul>
      )}
      {mode !== "team" && (
        <Button
          size="sm"
          variant="ghost"
          className="-ml-2 mt-1.5"
          data-testid="use-team-mode"
          onClick={() => onUseTeamMode(top.team)}
        >
          Use team mode with {top.team}
        </Button>
      )}
    </div>
  );
}
