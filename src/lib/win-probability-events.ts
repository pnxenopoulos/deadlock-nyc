import type { KillEvent, ObjectiveEvent } from "../components/map-view";
import { TEAM_NAMES, type PlayerInfo } from "../components/player-roster";

interface EventBase {
  tick: number;
  team: number | null;
  title: string;
  detail: string;
  killer?: PlayerInfo;
}
export type ProbabilityEvent = EventBase &
  (
    | { kind: "death"; victim?: PlayerInfo }
    | {
        kind: "objective";
        objectiveKind: ObjectiveEvent["kind"];
        objectiveName: string;
        firstPhase: boolean;
      }
    | { kind: "mid_boss" }
  );
export type EventVisibility = Record<ProbabilityEvent["kind"], boolean>;
export const DEFAULT_EVENT_VISIBILITY: Readonly<EventVisibility> =
  Object.freeze({ death: false, objective: true, mid_boss: true });

const names: Record<string, string> = {
  guardian: "Guardian",
  walker: "Walker",
  shrine: "Shrine",
  base_guardian: "Base Guardian",
  patron: "Patron",
  mid_boss: "Mid Boss",
  objective: "Objective",
};
/** Objective ownership and victim teams determine colors, independent of the killer. */
export function probabilityEvents(
  players: PlayerInfo[],
  kills: KillEvent[],
  objectives: ObjectiveEvent[],
): ProbabilityEvent[] {
  const roster = new Map(players.map((p) => [p.hero_id, p]));
  const actor = (id: number) => {
    const player = roster.get(id);
    if (!player) return id ? "Hero " + id : "Unknown/non-player";
    return (
      (player.hero_name || "Hero " + id) +
      (player.name ? " — " + player.name : "") +
      " (" +
      (TEAM_NAMES[player.team] ?? "Unknown team") +
      ")"
    );
  };
  const markers = kills.map<ProbabilityEvent>((event) => ({
    tick: event.tick,
    kind: "death",
    victim: roster.get(event.victim_hero_id),
    killer: roster.get(event.attacker_hero_id),
    team: roster.get(event.victim_hero_id)?.team ?? null,
    title:
      (roster.get(event.victim_hero_id)?.hero_name ?? "Unknown player") +
      " died",
    detail:
      actor(event.attacker_hero_id) + " killed " + actor(event.victim_hero_id),
  }));
  for (const event of objectives) {
    if (
      !names[event.kind] ||
      !["destroyed", "killed", "phase_one_destroyed"].includes(event.action)
    )
      continue;
    const midBoss = event.kind === "mid_boss";
    const common = {
      tick: event.tick,
      team: midBoss ? null : event.team,
      killer: roster.get(event.killer_hero_id),
      title:
        (midBoss ? "" : (TEAM_NAMES[event.team] ?? "Unknown team") + " ") +
        names[event.kind] +
        (event.action === "phase_one_destroyed"
          ? " first phase destroyed"
          : midBoss
            ? " killed"
            : " destroyed"),
      detail:
        (midBoss ? "Killed by " : "Destroyed by ") +
        actor(event.killer_hero_id),
    };
    markers.push(
      midBoss
        ? { ...common, kind: "mid_boss" }
        : {
            ...common,
            kind: "objective",
            objectiveKind: event.kind,
            objectiveName: names[event.kind],
            firstPhase: event.action === "phase_one_destroyed",
          },
    );
  }
  return markers.sort((a, b) => a.tick - b.tick);
}
