import * as React from "react";
import { ChevronDown, Swords } from "lucide-react";

import { heroPortraitUrl, TEAM_COLORS, TEAM_NAMES, type PlayerInfo } from "@/components/player-roster";
import { LANE_NAMES, laneGroups, laneSnapshots, laneTotals, type LaneTotals } from "@/lib/lane-stats";
import type { MatchSummary, SnapshotStat } from "@/wasm/boon";

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
const number = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString();

// Positive world Y is the top of the map: Archmother above, Hidden King below.
const TOP_TEAM = 3;
const BOTTOM_TEAM = 2;
const METRICS = [
  { key: "net_worth", label: "Souls", compare: true },
  { key: "kda", label: "K / D / A", compare: false },
  { key: "creep_kills", label: "Last hits", compare: false },
  { key: "denies", label: "Denies", compare: true },
  { key: "player_damage", label: "Hero damage", compare: true },
  { key: "player_healing", label: "Healing", compare: true },
] as const;
type MetricKey = typeof METRICS[number]["key"];

function statValue(row: Partial<LaneTotals> | undefined, key: MetricKey) {
  return key === "kda"
    ? `${number(row?.kills)} / ${number(row?.deaths)} / ${number(row?.assists)}`
    : number(row?.[key]);
}

function ComparisonCell({ value, opponent }: { value?: number | null; opponent?: number | null }) {
  const difference = value != null && opponent != null ? value - opponent : null;
  return (
    <td>
      {number(value)}
      {difference != null && (
        <span title="Difference vs opposing lane" className={`block text-[10px] ${difference > 0 ? "text-emerald-500" : difference < 0 ? "text-red-500" : "text-muted-foreground"}`}>
          {difference === 0 ? "±0" : `${difference > 0 ? "+" : "−"}${number(Math.abs(difference))}`}
        </span>
      )}
    </td>
  );
}

function LaneSide({ team, side, players, snapshots }: {
  team: number; side: "top" | "bottom"; players: PlayerInfo[]; snapshots: Map<number, SnapshotStat>;
}) {
  const color = TEAM_COLORS[team];
  return (
    <div data-team={team} data-side={side} className="px-3 py-3" style={{ backgroundColor: `${color}0d` }}>
      <div className="mb-3 text-xs">
        <span className="font-semibold" style={{ color }}>{TEAM_NAMES[team]}</span>
      </div>
      {players.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">No recorded lane assignment</p>
      ) : (
        <details className="group">
          <summary className="cursor-pointer list-none rounded focus-visible:outline focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <div className="grid grid-cols-2 gap-3">
              {players.map((player) => {
                const portrait = heroPortraitUrl(player.hero_id);
                return <div key={player.hero_id} className="flex min-w-0 items-center gap-2" title={`${player.hero_name} · ${player.name}`}>
                  {portrait && <img src={portrait} alt="" className="size-10 flex-shrink-0 rounded-md object-cover" style={{ boxShadow: `0 0 0 1px ${color}66` }} />}
                  <div className="min-w-0 text-xs">
                    <span className="block truncate font-medium">{player.hero_name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{player.name}</span>
                  </div>
                </div>;
              })}
            </div>
            <span className="mt-3 flex items-center justify-center gap-1 text-[10px] text-muted-foreground">
              Individual stats <ChevronDown className="size-3 transition-transform group-open:rotate-180" aria-hidden />
            </span>
          </summary>
          <div className="mt-3 overflow-x-auto border-t border-border/50 pt-2">
            <table className="w-full text-right text-[10px] tabular-nums [&_td]:py-1 [&_th]:py-1">
              <thead><tr><th className="text-left font-normal text-muted-foreground">Player stats</th>{players.map((player) => <th key={player.hero_id} className="px-1 font-medium">{player.hero_name}</th>)}</tr></thead>
              <tbody>{METRICS.map((metric) => <tr key={metric.key}>
                <th className="pr-2 text-left font-normal text-muted-foreground">{metric.label}</th>
                {players.map((player) => <td key={player.hero_id} className="whitespace-nowrap px-1">{statValue(snapshots.get(player.hero_id), metric.key)}</td>)}
              </tr>)}</tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

function LaneCard({ lane, players, snapshots }: { lane: number; players: PlayerInfo[]; snapshots: Map<number, SnapshotStat> }) {
  const top = players.filter((player) => player.team === TOP_TEAM);
  const bottom = players.filter((player) => player.team === BOTTOM_TEAM);
  const totals = [laneTotals(top, snapshots), laneTotals(bottom, snapshots)];
  const comparable = new Set(players.map((player) => snapshots.get(player.hero_id)?.time_s)).size === 1;
  const name = LANE_NAMES[lane];
  return (
    <article data-lane={name.label} className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-background/30">
      <h3 className="border-b border-border py-3 text-center text-base font-semibold" style={{ color: name.color, borderTop: `3px solid ${name.color}` }}>{name.label}</h3>
      <LaneSide team={TOP_TEAM} side="top" players={top} snapshots={snapshots} />
      <div className="flex-1 border-y border-border px-3 py-3">
        <h4 className="mb-2 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{top.length === 2 && bottom.length === 2 ? "Pair total" : "Lane total"}</h4>
        <table aria-label={`${name.label} totals`} className="w-full table-fixed text-center text-xs tabular-nums [&_td]:py-2.5 [&_th]:py-2.5">
          <thead><tr className="text-[10px]">
            <th style={{ color: TEAM_COLORS[TOP_TEAM] }}>{TEAM_NAMES[TOP_TEAM]}</th>
            <th className="font-normal text-muted-foreground">Stat</th>
            <th style={{ color: TEAM_COLORS[BOTTOM_TEAM] }}>{TEAM_NAMES[BOTTOM_TEAM]}</th>
          </tr></thead>
          <tbody>{METRICS.map((metric) => <tr key={metric.key} className="border-t border-border/40">
            {metric.compare ? <ComparisonCell value={totals[0][metric.key]} opponent={comparable ? totals[1][metric.key] : undefined} /> : <td className="whitespace-nowrap">{statValue(totals[0], metric.key)}</td>}
            <th className="font-normal text-muted-foreground" title={metric.key === "creep_kills" ? "Lane creep last hits" : undefined}>{metric.label}</th>
            {metric.compare ? <ComparisonCell value={totals[1][metric.key]} opponent={comparable ? totals[0][metric.key] : undefined} /> : <td className="whitespace-nowrap">{statValue(totals[1], metric.key)}</td>}
          </tr>)}</tbody>
        </table>
      </div>
      <LaneSide team={BOTTOM_TEAM} side="bottom" players={bottom} snapshots={snapshots} />
    </article>
  );
}

export function LaneView({ players, summary }: { players: PlayerInfo[]; summary: MatchSummary }) {
  const [cutoff, setCutoff] = React.useState(600);
  const snapshots = React.useMemo(() => laneSnapshots(summary, cutoff), [summary, cutoff]);
  const groups = React.useMemo(() => laneGroups(players, summary), [players, summary]);
  const byLane = new Map(groups);
  const lanes = [1, 4, byLane.has(6) || !byLane.has(3) ? 6 : 3];
  // Preserve distinct assignments in older recordings that contain both IDs.
  if (byLane.has(3) && byLane.has(6)) lanes.push(3);
  const sampleTimes = [...new Set([...snapshots.values()].map((row) => row.time_s))].sort((a, b) => a - b);
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Swords className="size-4" />Lane phase</h2>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Cutoff
          <select aria-label="Lane phase cutoff" className="rounded border border-border bg-background px-2 py-1 text-foreground" value={cutoff} onChange={(event) => setCutoff(Number(event.target.value))}>
            {[180, 360, 540, 600, 720, 900].map((value) => <option key={value} value={value}>{clock(value)}</option>)}
          </select>
        </label>
      </header>
      <p className="text-xs text-muted-foreground">
        Starting lane assignments; lane swaps are not tracked. Cumulative stats use the last recorded sample at or before the cutoff.
        {sampleTimes.length > 0 && ` Showing ${sampleTimes.map(clock).join(" / ")}.`}
      </p>
      {summary.snapshots.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No post-match lane stats in this recording.</p>
      ) : (
        <>
          <div className="grid items-start gap-4 md:grid-cols-3">
            {lanes.map((lane) => <LaneCard key={lane} lane={lane} players={byLane.get(lane) ?? []} snapshots={snapshots} />)}
          </div>
          {byLane.has(null) && (
            <article className="overflow-hidden rounded-lg border border-border">
              <h3 className="border-b border-border px-3 py-2 text-sm font-semibold">Unassigned players</h3>
              {[TOP_TEAM, BOTTOM_TEAM].map((team) => <LaneSide key={team} team={team} side={team === TOP_TEAM ? "top" : "bottom"} players={byLane.get(null)!.filter((player) => player.team === team)} snapshots={snapshots} />)}
            </article>
          )}
        </>
      )}
    </section>
  );
}
