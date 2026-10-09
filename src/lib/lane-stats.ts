import type { PlayerInfo } from "@/components/player-roster";
import type { MatchSummary, SnapshotStat } from "@/wasm/boon";

export const LANE_NAMES: Record<number, { label: string; color: string }> = {
  1: { label: "York", color: "#fbbf24" },
  3: { label: "Greenwich", color: "#34d399" },
  4: { label: "Broadway", color: "#60a5fa" },
  // The current green lane retains the protocol's legacy purple-lane ID.
  6: { label: "Greenwich", color: "#34d399" },
};

/** Do not interpolate cumulative samples or use a later sample at a cutoff. */
export function laneSnapshots(summary: MatchSummary, cutoff: number): Map<number, SnapshotStat> {
  const rows = new Map<number, SnapshotStat>();
  for (const snapshot of summary.snapshots) {
    if (snapshot.time_s <= cutoff && snapshot.time_s > (rows.get(snapshot.hero_id)?.time_s ?? -1)) {
      rows.set(snapshot.hero_id, snapshot);
    }
  }
  return rows;
}

export function laneGroups(players: PlayerInfo[], summary: MatchSummary) {
  const assignments = new Map(summary.assigned_lanes.map((row) => [row.hero_id, row.lane]));
  const groups = new Map<number | null, PlayerInfo[]>();
  for (const player of players) {
    const assigned = assignments.get(player.hero_id);
    const lane = assigned && LANE_NAMES[assigned] ? assigned : null;
    const group = groups.get(lane);
    if (group) group.push(player);
    else groups.set(lane, [player]);
  }
  return [...groups].sort(([a], [b]) => (a ?? Infinity) - (b ?? Infinity));
}

export const LANE_COLUMNS = ["net_worth", "kills", "deaths", "assists", "creep_kills", "denies", "player_damage", "player_healing"] as const;
export type LaneTotals = Record<typeof LANE_COLUMNS[number], number | null>;

/** An unavailable teammate/field makes the pair total unavailable, not zero. */
export function laneTotals(players: PlayerInfo[], snapshots: Map<number, SnapshotStat>): LaneTotals {
  return Object.fromEntries(LANE_COLUMNS.map((key) => {
    const values = players.map((player) => snapshots.get(player.hero_id)?.[key]);
    return [key, values.length && values.every((value) => value != null)
      ? values.reduce<number>((sum, value) => sum + value!, 0) : null];
  })) as LaneTotals;
}
