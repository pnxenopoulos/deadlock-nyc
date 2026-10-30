import { FeatureRequired } from "./replay-options";
import { WinProbabilityEventControls } from "./win-probability-event-controls";
import {
  DEFAULT_EVENT_VISIBILITY,
  type EventVisibility,
} from "@/lib/win-probability-events";
import { probabilityEvents } from "@/lib/win-probability-events";
import type { KillEvent, ObjectiveEvent } from "./map-view";
import * as React from "react";
import { LineChart, LoaderCircle, RotateCcw } from "lucide-react";
import type { PlayerInfo } from "./player-roster";
import { TimelineView } from "./timeline-view";
import { WinProbabilityChart } from "./win-probability-chart";
import type { MatchSummary } from "@/wasm/boon";
import type { ReplayProbability } from "@/ml/use-replay-probability";
import { cn } from "@/lib/utils";

export function TimelinePanel({
  enabled,
  onEnabledChange,
  onEnable,
  killEvents = [],
  objectiveEvents = [],
  probability,
  onRetry,
  players,
  summary,
  currentTick,
  firstTick,
  lastTick,
  onSeek,
  formatTick,
}: {
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  onEnable?: () => void;
  killEvents?: KillEvent[];
  objectiveEvents?: ObjectiveEvent[];
  probability: ReplayProbability;
  onRetry: () => void;
  players: PlayerInfo[];
  summary: MatchSummary;
  currentTick: number;
  firstTick: number;
  lastTick: number;
  onSeek: (tick: number) => void;
  formatTick: (tick: number) => string;
}) {
  const [eventVisibility, setEventVisibility] = React.useState<EventVisibility>(
    { ...DEFAULT_EVENT_VISIBILITY },
  );
  const allEvents = React.useMemo(
    () => probabilityEvents(players, killEvents, objectiveEvents),
    [players, killEvents, objectiveEvents],
  );
  const events = React.useMemo(
    () => allEvents.filter((event) => eventVisibility[event.kind]),
    [allEvents, eventVisibility],
  );
  const { points, progress, error } = probability;
  const percentage =
    progress && progress.total > 0
      ? Math.round((100 * progress.completed) / progress.total)
      : null;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
        <span className="text-xs font-medium">
          {enabled ? "Win probability" : "Timeline"}
        </span>
        {!enabled && progress && (
          <span
            role="status"
            className="ml-auto text-[10px] text-muted-foreground"
          >
            {progress.phase}
            {percentage != null ? " · " + percentage + "%" : "…"}
          </span>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Win probability"
          onClick={() => onEnabledChange(!enabled)}
          className={cn(
            "ml-auto inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            enabled
              ? "bg-primary/10 text-primary"
              : "bg-background text-muted-foreground hover:text-foreground",
          )}
        >
          <LineChart className="size-3.5" />
          Win probability
          <span
            aria-hidden
            className={cn(
              "relative h-3.5 w-6 rounded-full transition-colors",
              enabled ? "bg-primary" : "bg-muted-foreground/30",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-2.5 rounded-full bg-background transition-transform",
                enabled ? "translate-x-3" : "translate-x-0.5",
              )}
            />
          </span>
        </button>
      </div>
      {!enabled ? (
        <TimelineView players={players} summary={summary} />
      ) : (
        <>
          {probability.enabled !== false && !error && (
            <WinProbabilityEventControls
              value={eventVisibility}
              onChange={setEventVisibility}
            />
          )}
          {progress && (
            <div
              role="status"
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <LoaderCircle className="size-3 animate-spin" />
              {progress.phase}
              {percentage != null ? ` · ${percentage}%` : ""}
            </div>
          )}
          {probability.enabled === false ? (
            <FeatureRequired feature="Win probability" onEnable={onEnable} />
          ) : error ? (
            <div
              role="alert"
              className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-border bg-card p-6 text-center"
            >
              <p className="text-sm">Couldn’t calculate win probability.</p>
              <p className="max-w-md text-xs text-muted-foreground">{error}</p>
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1 text-xs"
              >
                <RotateCcw className="size-3" />
                Retry
              </button>
            </div>
          ) : (
            <WinProbabilityChart
              points={points}
              events={events}
              complete={!progress}
              currentTick={currentTick}
              firstTick={firstTick}
              lastTick={lastTick}
              onSeek={onSeek}
              formatTick={formatTick}
            />
          )}
          {probability.enabled !== false && (
            <p className="text-[10px] text-muted-foreground">
              Solid lines: objectives (owner team) · Dotted lines: player deaths
              (victim team) · Yellow: Mid Boss.
            </p>
          )}
        </>
      )}
    </div>
  );
}
