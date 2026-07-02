import { cn } from "@/lib/cn";

/** Render a verdict's score_json as a compact dimension table. */
export function RubricScoreTable({ scoreJson }: { scoreJson: string | null }) {
  if (!scoreJson) return null;
  let scores: Record<string, unknown>;
  try {
    scores = JSON.parse(scoreJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const entries = Object.entries(scores).filter(([, v]) => typeof v === "number");
  if (entries.length === 0) return null;

  const max = Math.max(5, ...entries.map(([, v]) => v as number));

  return (
    <table className="w-full text-[12px]">
      <tbody>
        {entries.map(([dim, value]) => {
          const v = value as number;
          const pct = Math.max(0, Math.min(1, v / max));
          const tone = pct >= 0.8 ? "var(--pass)" : pct >= 0.5 ? "var(--warn)" : "var(--fail)";
          return (
            <tr key={dim}>
              <td className="py-1 pr-2 text-ink-2">{dim.replace(/_/g, " ")}</td>
              <td className="w-full py-1">
                <span className="block h-1.5 w-full overflow-hidden rounded-full bg-bg-3">
                  <span className="block h-full rounded-full" style={{ width: `${pct * 100}%`, background: tone }} />
                </span>
              </td>
              <td className={cn("mono tnum py-1 pl-2 text-right text-ink-1")}>{v}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
