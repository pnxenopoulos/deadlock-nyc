import type { PauseInterval } from "@/components/map-view";
import type { PlayerInfo } from "@/components/player-roster";
import type { FrameStore, PlayerPosition } from "@/wasm/frames";
import type { StatusStore } from "@/wasm/statuses";
import { SOURCE_UNITS_PER_METER } from "./utils";

export const OUTNUMBERED_RADIUS_METERS = 30;
const RADIUS_SQUARED = (OUTNUMBERED_RADIUS_METERS * SOURCE_UNITS_PER_METER) ** 2;
const TICKS_PER_SECOND = 64;
type Interval = { start: number; end: number; outnumbered: boolean | null };

/** Change-only proximity classifications, built once from existing samples.
 * Counts living heroes in 3D, including the subject on their own side.
 * Proximity is not line of sight or proof of participation. */
export class OutnumberedCombat {
  private readonly intervals = new Map<number, Interval[]>();
  private readonly firstTick: number;
  private readonly lastTick: number;

  constructor(
    frames: FrameStore,
    players: readonly PlayerInfo[],
    statuses: StatusStore,
    private readonly pauses: readonly PauseInterval[],
  ) {
    this.firstTick = frames.tickAt(0) ?? 0;
    this.lastTick = frames.tickAt(frames.length - 1) ?? 0;
    for (const player of players) this.intervals.set(player.hero_id, []);
    for (let i = 0; i + 1 < frames.length; i++) {
      const start = frames.tickAt(i)!;
      const end = frames.tickAt(i + 1)!;
      const positions = new Map<number, PlayerPosition>();
      frames.forEachPlayerAt(i, (player) => positions.set(player.hero_id, player));
      const complete = players.every((player) => positions.has(player.hero_id));
      for (const player of players) {
        const subject = positions.get(player.hero_id);
        let outnumbered: boolean | null = null;
        if (subject && !subject.alive) outnumbered = false;
        else if (subject) {
          const states = statuses.at(player.steam_id, start)?.states;
          if (states != null && !states.includes("IN_COMBAT")) outnumbered = false;
          else if (states != null && complete) {
            let allies = 1;
            let enemies = 0;
            for (const other of players) {
              const nearby = positions.get(other.hero_id)!;
              if (nearby.hero_id === subject.hero_id || !nearby.alive) continue;
              const distanceSquared = (nearby.x - subject.x) ** 2
                + (nearby.y - subject.y) ** 2 + (nearby.z - subject.z) ** 2;
              if (distanceSquared > RADIUS_SQUARED) continue;
              if (nearby.team === subject.team) allies++;
              else enemies++;
            }
            outnumbered = enemies > allies;
          }
        }
        const intervals = this.intervals.get(player.hero_id)!;
        const previous = intervals.at(-1);
        if (previous?.outnumbered === outnumbered && previous.end === start) previous.end = end;
        else intervals.push({ start, end, outnumbered });
      }
    }
  }

  /** Elapsed gameplay seconds in [startTick, endTick), excluding pauses.
   * Unknown positive-duration coverage returns null, not an invented zero. */
  secondsInWindow(heroId: number, startTick: number, endTick: number): number | null {
    const intervals = this.intervals.get(heroId);
    if (!intervals || endTick <= startTick || startTick < this.firstTick || endTick > this.lastTick) return null;
    let ticks = 0;
    for (const interval of intervals) {
      if (interval.start >= endTick) break;
      if (interval.end <= startTick || interval.outnumbered === false) continue;
      const start = Math.max(startTick, interval.start);
      const end = Math.min(endTick, interval.end);
      let elapsed = end - start;
      for (const pause of this.pauses) {
        elapsed -= Math.max(0, Math.min(end, pause.end) - Math.max(start, pause.start));
      }
      if (elapsed <= 0) continue;
      if (interval.outnumbered == null) return null;
      ticks += elapsed;
    }
    return ticks / TICKS_PER_SECOND;
  }
}
