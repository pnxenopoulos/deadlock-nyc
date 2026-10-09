import type { PlayerInfo } from "@/components/player-roster";
import type { SnapshotStat } from "@/wasm/boon";

export function percentageOfTotal(value: number, total: number): string {
  return `${(total > 0 ? value / total * 100 : 0).toFixed(1).replace(/\.0$/, "")}%`;
}

/** Contributions use the hovered sample and the displayed team total, not a
 * nearby sample or the sum of both teams. Missing values remain unavailable. */
export function teamContributions(
  players: PlayerInfo[], snapshots: SnapshotStat[], time: number,
  team: number, metric: keyof SnapshotStat, total: number,
) {
  const values = new Map(snapshots.filter((row) => row.time_s === time).map((row) => [row.hero_id, row[metric]]));
  return players.filter((player) => player.team === team).flatMap((player) => {
    const value = values.get(player.hero_id);
    return value == null ? [] : [{
      label: player.hero_name, name: player.name, heroId: player.hero_id,
      v: value, percentage: percentageOfTotal(value, total),
    }];
  }).sort((a, b) => b.v - a.v);
}
