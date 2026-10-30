import * as React from "react";
import {
  DEFAULT_EVENT_VISIBILITY,
  probabilityEvents,
  type EventVisibility,
} from "@/lib/win-probability-events";
import { WinProbabilityEventControls } from "./win-probability-event-controls";
import type { KillEvent, ObjectiveEvent } from "./map-view";
import type { PlayerInfo } from "./player-roster";
import { FeatureRequired } from "./replay-options";
import { LoaderCircle } from "lucide-react";
import { WinProbabilityChart } from "./win-probability-chart";
import type { ReplayProbability } from "@/ml/types";

export function WinProbabilityCard({
  probability,
  onRetry,
  onEnable,
  players = [],
  killEvents = [],
  objectiveEvents = [],
  ...timeline
}: {
  probability: ReplayProbability;
  onRetry: () => void;
  onEnable?: () => void;
  players?: PlayerInfo[];
  killEvents?: KillEvent[];
  objectiveEvents?: ObjectiveEvent[];
  currentTick: number;
  firstTick: number;
  lastTick: number;
  onSeek: (tick: number) => void;
  formatTick: (tick: number) => string;
}) {
  const [visibility, setVisibility] = React.useState<EventVisibility>({
    ...DEFAULT_EVENT_VISIBILITY,
  });
  const events = React.useMemo(
    () =>
      probabilityEvents(players, killEvents, objectiveEvents).filter(
        (event) => visibility[event.kind],
      ),
    [players, killEvents, objectiveEvents, visibility],
  );
  return (
    <section
      aria-label="Live win probability"
      className="flex shrink-0 flex-col gap-1"
    >
      <div className="flex flex-wrap items-center justify-between gap-1">
        <h3 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Win probability
        </h3>
        {probability.enabled !== false && !probability.error && (
          <WinProbabilityEventControls
            compact
            value={visibility}
            onChange={setVisibility}
          />
        )}
      </div>
      {probability.enabled === false ? (
        <FeatureRequired feature="Win probability" onEnable={onEnable} />
      ) : probability.error ? (
        <div
          role="alert"
          className="rounded-md border border-border bg-card p-2 text-xs"
        >
          <p>Win probability unavailable.</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {probability.error}
          </p>
          <button type="button" onClick={onRetry} className="mt-1 underline">
            Retry
          </button>
        </div>
      ) : (
        <>
          {probability.progress && (
            <p
              role="status"
              className="flex items-center gap-1 text-[10px] text-muted-foreground"
            >
              <LoaderCircle className="size-3 animate-spin" />
              {probability.progress.phase}
              {probability.progress.total > 0
                ? " · " +
                  Math.round(
                    (100 * probability.progress.completed) /
                      probability.progress.total,
                  ) +
                  "%"
                : "…"}
            </p>
          )}
          <div className="flex h-28 min-h-0 flex-col gap-1">
            <WinProbabilityChart
              compact
              events={events}
              points={probability.points}
              complete={!probability.progress}
              {...timeline}
            />
          </div>
        </>
      )}
    </section>
  );
}
