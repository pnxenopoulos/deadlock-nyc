import type { PlayerStatus } from "./player-details";

export interface StatusHistory {
  values: PlayerStatus[];
  players: { steam_id: string; ticks: number[]; indices: number[] }[];
}

function changeIndexAt(ticks: readonly number[], tick: number): number {
  let lo = 0;
  let hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ticks[mid] <= tick) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Recorded masks at displayed frame ticks. No worker query is needed. */
export class StatusStore {
  private readonly players: Map<string, StatusHistory["players"][number]>;

  constructor(private readonly history: StatusHistory) {
    this.players = new Map(history.players.map((p) => [p.steam_id, p]));
  }

  at(steamId: string, tick: number): PlayerStatus | undefined {
    const player = this.players.get(steamId);
    if (!player) return undefined;
    const index = changeIndexAt(player.ticks, tick);
    return index >= 0 ? this.history.values[player.indices[index]] : undefined;
  }

  /** Percentage of [startTick, endTick) with a recorded predicted state.
   * Sampled changes hold until the next sample; unknown coverage returns null. */
  percentageInWindow(steamId: string, state: string, startTick: number, endTick: number): number | null {
    const player = this.players.get(steamId);
    if (!player || endTick <= startTick) return null;
    let index = changeIndexAt(player.ticks, startTick);
    if (index < 0) return null;
    let activeTicks = 0;
    for (; index < player.ticks.length && player.ticks[index] < endTick; index++) {
      const start = Math.max(startTick, player.ticks[index]);
      const end = Math.min(endTick, player.ticks[index + 1] ?? endTick);
      if (end <= start) continue;
      const states = this.history.values[player.indices[index]]?.states;
      if (states == null) return null;
      if (states.includes(state)) activeTicks += end - start;
    }
    return (activeTicks / (endTick - startTick)) * 100;
  }
}
