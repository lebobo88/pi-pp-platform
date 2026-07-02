import { useId } from "react";
import { cn } from "@/lib/cn";

export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  /** Stroke color (CSS color or var). Defaults to accent. */
  color?: string;
  /** Fill the area under the line with a faded gradient. */
  fill?: boolean;
  className?: string;
}

/** Inline SVG sparkline — no axes, no dependency. */
export function Sparkline({
  data,
  width = 96,
  height = 24,
  color = "var(--accent)",
  fill = true,
  className,
}: SparklineProps) {
  if (data.length === 0) {
    return <svg width={width} height={height} className={className} aria-hidden />;
  }

  const gradId = useId();
  const pad = 1.5;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = data.length > 1 ? (width - pad * 2) / (data.length - 1) : 0;

  const points = data.map((v, i) => {
    const x = pad + i * stepX;
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return [x, y] as const;
  });

  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = points[points.length - 1]!;
  const first = points[0]!;
  const area = `${line} L${last[0].toFixed(1)},${height} L${first[0].toFixed(1)},${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("overflow-visible", className)}
      aria-hidden
    >
      {fill && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
      )}
      {fill && <path d={area} fill={`url(#${gradId})`} stroke="none" />}
      <path d={line} fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={1.6} fill={color} />
    </svg>
  );
}
