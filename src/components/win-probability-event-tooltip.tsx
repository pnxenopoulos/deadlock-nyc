import { Bomb, Crosshair, Skull, UserRound } from "lucide-react";
import { OBJECTIVE_ICONS } from "./map-view";
import {
  heroPortraitUrl,
  TEAM_COLORS,
  TEAM_NAMES,
  type PlayerInfo,
} from "./player-roster";
import type { ProbabilityEvent } from "@/lib/win-probability-events";

const NEUTRAL_COLOR = "#94a3b8";
export const MID_BOSS_COLOR = "#e0b84a";

function Actor({
  player,
  fallback,
}: {
  player?: PlayerInfo;
  fallback: string;
}) {
  const url = player ? heroPortraitUrl(player.hero_id) : null;
  const label = player
    ? (player.hero_name || "Unknown hero") +
      (player.name ? " — " + player.name : "")
    : fallback;
  return (
    <>
      {url ? (
        <img
          src={url}
          alt=""
          aria-hidden
          width={16}
          height={16}
          className="size-4 shrink-0 rounded object-contain"
        />
      ) : (
        <UserRound className="size-4 shrink-0" aria-hidden />
      )}
      <span
        className="min-w-0"
        aria-label={
          label +
          (player
            ? " (" + (TEAM_NAMES[player.team] ?? "Unknown team") + ")"
            : "")
        }
      >
        {label}
      </span>
    </>
  );
}

/** Event rows keep the victim/owner and killer colors independent. */
export function ProbabilityEventTooltip({
  event,
  formatTick,
}: {
  event: ProbabilityEvent;
  formatTick: (tick: number) => string;
}) {
  const killerColor = TEAM_COLORS[event.killer?.team ?? -1] ?? NEUTRAL_COLOR;
  const ownerColor = TEAM_COLORS[event.team ?? -1] ?? NEUTRAL_COLOR;
  const ObjectiveIcon =
    event.kind === "objective" ? OBJECTIVE_ICONS[event.objectiveKind] : null;
  return (
    <div data-event-tooltip={event.kind} className="space-y-1.5">
      {event.kind === "death" ? (
        <>
          <div
            className="flex items-center gap-1.5 font-medium"
            style={{ color: ownerColor }}
            data-event-row="victim"
          >
            <Skull className="size-3.5 shrink-0" aria-hidden />
            <Actor player={event.victim} fallback="Unknown player" />
            <span className="ml-auto shrink-0 text-[10px] font-normal text-muted-foreground">
              {formatTick(event.tick)}
            </span>
          </div>
          <div
            className="flex items-center gap-1.5 text-[11px]"
            style={{ color: killerColor }}
            data-event-row="killer"
          >
            <Crosshair className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">Killed by </span>
            <Actor player={event.killer} fallback="Unknown/non-player" />
          </div>
        </>
      ) : event.kind === "objective" ? (
        <>
          <div
            className="flex items-center gap-1.5 font-medium"
            style={{ color: ownerColor }}
            data-event-row="objective"
          >
            <Bomb className="size-3.5 shrink-0" aria-hidden />
            {ObjectiveIcon && (
              <ObjectiveIcon className="size-4 shrink-0" aria-hidden />
            )}
            <span>
              {event.objectiveName}
              {event.firstPhase ? " · first phase" : ""}
            </span>
            <span className="ml-auto shrink-0 text-[10px] font-normal text-muted-foreground">
              {formatTick(event.tick)}
            </span>
          </div>
          <div
            className="flex items-center gap-1.5 text-[11px]"
            style={{ color: killerColor }}
            data-event-row="killer"
          >
            <span className="shrink-0">Destroyed by</span>
            <Actor player={event.killer} fallback="Unknown/non-player" />
          </div>
        </>
      ) : (
        <>
          <p className="font-medium" style={{ color: MID_BOSS_COLOR }}>
            {formatTick(event.tick)} · {event.title}
          </p>
          <div
            className="flex items-center gap-1.5 text-[11px]"
            style={{ color: killerColor }}
            data-event-row="killer"
          >
            <span className="shrink-0">Killed by</span>
            <Actor player={event.killer} fallback="Unknown/non-player" />
          </div>
        </>
      )}
    </div>
  );
}
