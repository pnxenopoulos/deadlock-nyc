import type { ObjectiveHealthEvent, ObjectiveInfo } from "@/components/map-view";

/** Replay only samples at or before the tick, including Patron phase and position. */
export function objectivesAt(objectives: ObjectiveInfo[], samples: ObjectiveHealthEvent[], tick: number) {
  const latest = new Map<number, ObjectiveHealthEvent>();
  for (const sample of samples) {
    if (sample.tick > tick) break;
    latest.set(sample.id, sample);
  }
  return objectives.flatMap((objective) => {
    if (tick < objective.spawn_tick || objective.death_tick != null && tick >= objective.death_tick) return [];
    const sample = latest.get(objective.id);
    return [{
      kind: objective.kind, team: objective.team,
      x: sample?.x ?? objective.x, y: sample?.y ?? objective.y,
      health: sample?.health ?? objective.max_health,
      max_health: sample?.max_health ?? objective.max_health,
      phase: sample?.phase,
    }];
  });
}
