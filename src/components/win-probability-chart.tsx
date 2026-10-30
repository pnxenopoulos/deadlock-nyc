import { WinProbabilityEvents } from "./win-probability-events";
import type { ProbabilityEvent } from "@/lib/win-probability-events";
import * as React from "react";
import { TEAM_COLORS, TEAM_NAMES } from "./player-roster";
import { probabilityAt, tickAtPosition } from "@/ml/timeline";
import type { ProbabilityPoint } from "@/ml/types";

export function WinProbabilityChart({
  points,
  compact = false,
  events = [],
  complete,
  currentTick,
  firstTick,
  lastTick,
  onSeek,
  formatTick,
}: {
  points: ProbabilityPoint[];
  compact?: boolean;
  events?: ProbabilityEvent[];
  complete: boolean;
  currentTick: number;
  firstTick: number;
  lastTick: number;
  onSeek: (tick: number) => void;
  formatTick: (tick: number) => string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [box, setBox] = React.useState({ w: 800, h: 360 });
  const [hover, setHover] = React.useState<number | null>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setBox({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const margin = compact
      ? { l: 32, r: 14, t: 9, b: 20 }
      : { l: 44, r: 16, t: 20, b: 32 },
    width = Math.max(1, box.w - margin.l - margin.r),
    height = Math.max(1, box.h - margin.t - margin.b),
    span = Math.max(1, lastTick - firstTick);
  const x = (tick: number) => margin.l + ((tick - firstTick) / span) * width;
  const y = (p: number) => margin.t + (1 - p) * height;
  const paths = React.useMemo(
    () =>
      [3, 2].map((team) =>
        points
          .map(
            (p) =>
              `${margin.l + ((p.tick - firstTick) / span) * width},${margin.t + (1 - (team === 3 ? p.archmother : 1 - p.archmother)) * height}`,
          )
          .join(" "),
      ),
    [points, firstTick, span, width, height],
  );
  const targetTick = hover ?? currentTick;
  const selected =
    !complete && targetTick > (points.at(-1)?.tick ?? -1)
      ? undefined
      : probabilityAt(points, targetTick);
  const currentPrediction =
    !complete && currentTick > (points.at(-1)?.tick ?? -1)
      ? undefined
      : probabilityAt(points, currentTick);
  const at = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    return tickAtPosition(
      clientX,
      rect.left + margin.l,
      width,
      firstTick,
      lastTick,
    );
  };
  return (
    <>
      <div
        className={
          compact
            ? "flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] tabular-nums"
            : "flex flex-wrap items-center gap-x-5 gap-y-1 text-xs tabular-nums"
        }
        aria-live="off"
      >
        {[3, 2].map((team) => (
          <span key={team} className="flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ background: TEAM_COLORS[team] }}
            />
            {TEAM_NAMES[team]}{" "}
            <strong>
              {selected
                ? `${((team === 3 ? selected.archmother : 1 - selected.archmother) * 100).toFixed(1)}%`
                : "—"}
            </strong>
          </span>
        ))}
        <span className="text-muted-foreground">
          {formatTick(hover ?? currentTick)}
        </span>
      </div>
      <div
        ref={ref}
        className={
          "relative min-w-0 flex-1 touch-none select-none overflow-hidden rounded-lg border border-border bg-card " +
          (compact ? "min-h-20" : "min-h-44")
        }
      >
        <div
          className="absolute inset-0"
          role="slider"
          tabIndex={0}
          aria-label="Win probability replay timeline"
          aria-valuemin={firstTick}
          aria-valuemax={lastTick}
          aria-valuenow={currentTick}
          aria-valuetext={`${formatTick(currentTick)}${currentPrediction ? `, Archmother ${(currentPrediction.archmother * 100).toFixed(1)} percent` : ""}`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            onSeek(at(e.clientX));
          }}
          onPointerMove={(e) => {
            setHover(at(e.clientX));
            if (e.buttons === 1) onSeek(at(e.clientX));
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onPointerLeave={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === "Home") {
              e.preventDefault();
              onSeek(firstTick);
            } else if (e.key === "End") {
              e.preventDefault();
              onSeek(lastTick);
            }
          }}
        >
          <svg
            width="100%"
            height="100%"
            className="absolute inset-0"
            aria-hidden
          >
            {(compact ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((p) => (
              <g key={p}>
                <line
                  x1={margin.l}
                  x2={margin.l + width}
                  y1={y(p)}
                  y2={y(p)}
                  className="stroke-border"
                  strokeDasharray={p === 0.5 ? "4 4" : undefined}
                />
                <text
                  x={margin.l - 8}
                  y={y(p)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className={
                    compact
                      ? "fill-muted-foreground text-[8px]"
                      : "fill-muted-foreground text-[10px]"
                  }
                >
                  {p * 100}%
                </text>
              </g>
            ))}
            {(compact ? [0, 0.5, 1] : [0, 0.2, 0.4, 0.6, 0.8, 1]).map((f) => (
              <text
                key={f}
                x={margin.l + f * width}
                y={box.h - 10}
                textAnchor="middle"
                className={
                  compact
                    ? "fill-muted-foreground text-[8px]"
                    : "fill-muted-foreground text-[10px]"
                }
              >
                {formatTick(firstTick + f * (lastTick - firstTick))}
              </text>
            ))}
            {paths.map((path, i) => (
              <polyline
                key={i}
                points={path}
                fill="none"
                stroke={TEAM_COLORS[i === 0 ? 3 : 2]}
                strokeWidth={1.7}
                strokeLinejoin="round"
              />
            ))}
            <line
              x1={x(currentTick)}
              x2={x(currentTick)}
              y1={margin.t}
              y2={margin.t + height}
              className="stroke-foreground"
              strokeWidth={1.5}
            />
            {hover != null && (
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={margin.t}
                y2={margin.t + height}
                className="stroke-foreground/35"
                strokeDasharray="3 3"
              />
            )}
          </svg>
          {!points.length && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              Preparing predictions…
            </div>
          )}
        </div>
        <WinProbabilityEvents
          events={events.filter(
            (event) => event.tick >= firstTick && event.tick <= lastTick,
          )}
          x={x}
          top={margin.t}
          height={height}
          width={box.w}
          formatTick={formatTick}
          onSeek={onSeek}
          onHover={setHover}
          tooltips={!compact}
        />
      </div>
    </>
  );
}
