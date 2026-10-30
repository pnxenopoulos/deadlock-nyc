import {
  ProbabilityEventTooltip,
  MID_BOSS_COLOR,
} from "./win-probability-event-tooltip";
import * as React from "react";
import type { ProbabilityEvent } from "@/lib/win-probability-events";
import { TEAM_COLORS } from "./player-roster";

const color = (event: ProbabilityEvent) =>
  event.kind === "mid_boss"
    ? MID_BOSS_COLOR
    : (TEAM_COLORS[event.team ?? -1] ?? "#94a3b8");

/** Separate controls sit alongside the chart slider, with wider hit areas than the lines. */
export function WinProbabilityEvents({
  events,
  x,
  top,
  height,
  width,
  formatTick,
  onSeek,
  onHover,
  tooltips = true,
}: {
  events: ProbabilityEvent[];
  x: (tick: number) => number;
  top: number;
  height: number;
  width: number;
  formatTick: (tick: number) => string;
  onSeek: (tick: number) => void;
  onHover: (tick: number | null) => void;
  tooltips?: boolean;
}) {
  const [active, setActive] = React.useState<ProbabilityEvent | null>(null);
  const show = React.useCallback(
    (event: ProbabilityEvent | null) => {
      setActive(event);
      onHover(event?.tick ?? null);
    },
    [onHover],
  );
  const selected = active && events.includes(active) ? active : null;
  React.useEffect(() => {
    if (active && !events.includes(active)) show(null);
  }, [active, events, show]);
  const nearby =
    tooltips && selected
      ? events.filter((e) => Math.abs(x(e.tick) - x(selected.tick)) <= 4)
      : [];
  return (
    <>
      {events.map((event, i) => (
        <button
          key={event.kind + ":" + event.tick + ":" + i}
          type="button"
          data-timeline-event={event.kind}
          aria-label={
            formatTick(event.tick) + " · " + event.title + ". " + event.detail
          }
          className={
            "absolute z-10 w-2 cursor-pointer border-0 bg-transparent p-0 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring " +
            (event.kind === "mid_boss" ? "opacity-90" : "opacity-50")
          }
          style={{ left: x(event.tick) - 4, top, height }}
          onPointerEnter={() => show(event)}
          onPointerLeave={() => show(null)}
          onFocus={() => show(event)}
          onBlur={() => show(null)}
          onClick={() => onSeek(event.tick)}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-1/2"
            style={{
              borderLeft:
                (event.kind === "death"
                  ? "1.5px dotted "
                  : event.kind === "mid_boss"
                    ? "2px solid "
                    : "1.5px solid ") + color(event),
            }}
          />
        </button>
      ))}
      {tooltips && selected && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20 w-72 max-w-[calc(100%-16px)] space-y-2 rounded-md border border-border bg-popover p-2 text-xs text-popover-foreground shadow-md"
          style={{
            top: top + 8,
            left: Math.max(8, Math.min(x(selected.tick) - 100, width - 296)),
          }}
        >
          {nearby.map((event, i) => (
            <ProbabilityEventTooltip
              key={event.kind + ":" + event.tick + ":" + i}
              event={event}
              formatTick={formatTick}
            />
          ))}
        </div>
      )}
    </>
  );
}
