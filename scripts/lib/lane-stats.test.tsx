import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LaneView } from "../../src/components/lane-view";
import { TimelineView } from "../../src/components/timeline-view";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { LANE_NAMES, laneGroups, laneSnapshots, laneTotals } from "../../src/lib/lane-stats";
import { healingSourceLabel } from "../../src/lib/timeline-sources";
import type { MatchSummary, SnapshotStat } from "../../src/wasm/boon";

const players = [1, 2, 3, 4].map((hero_id) => ({ hero_id, hero_name: `Hero ${hero_id}`, name: `Player ${hero_id}`, steam_id: String(hero_id), rank: 0, team: hero_id < 3 ? 2 : 3 }));
function snapshot(hero_id: number, time_s: number, net_worth: number): SnapshotStat {
  return { hero_id, time_s, net_worth, kills: 1, deaths: 0, assists: 2, creep_kills: 20, denies: 3, player_damage: 1000, player_healing: 50 } as SnapshotStat;
}
const summary: MatchSummary = {
  assigned_lanes: players.map((player) => ({ hero_id: player.hero_id, lane: 4 })),
  snapshots: players.flatMap((p) => [snapshot(p.hero_id, 540, p.hero_id * 1000), snapshot(p.hero_id, 720, p.hero_id * 2000)]),
  damage_sample_times: [], damage_matrix: [], damage_by_source: [], healing_by_source: [], regen_by_source: [],
};

test("lane phase uses the previous recorded sample and sums the assigned pair", () => {
  const snapshots = laneSnapshots(summary, 600);
  expect(snapshots.get(1)?.time_s).toBe(540);
  expect(laneTotals(players.slice(0, 2), snapshots).net_worth).toBe(3000);
  expect(laneTotals(players.slice(0, 2), snapshots).creep_kills).toBe(40);
  expect(laneSnapshots(summary, 120).size).toBe(0);
  expect(laneTotals(players.slice(0, 2), laneSnapshots(summary, 120)).net_worth).toBeNull();
  snapshots.delete(2);
  expect(laneTotals(players.slice(0, 2), snapshots).net_worth).toBeNull();
  expect(laneGroups(players, { ...summary, assigned_lanes: [] })[0][0]).toBeNull();
});

test("lane view includes individuals, pair totals, cutoff, and actual sample time", () => {
  const html = renderToStaticMarkup(<LaneView players={players} summary={summary} />);
  for (const text of ["Broadway", "Pair total", "Player 1", "Player 4", "Showing 9:00", "Lane phase cutoff", "Last hits", "Denies", "3,000", "Individual stats"]) expect(html).toContain(text);
  const empty = renderToStaticMarkup(<LaneView players={players} summary={{ ...summary, snapshots: [] }} />);
  expect(empty).toContain("No post-match lane stats");
});

test("lane names use York, Broadway and Greenwich with green instead of legacy purple", () => {
  expect(LANE_NAMES[1].label).toBe("York");
  expect(LANE_NAMES[4].label).toBe("Broadway");
  expect(LANE_NAMES[6]).toEqual({ label: "Greenwich", color: "#34d399" });
  const html = renderToStaticMarkup(<LaneView players={players} summary={{ ...summary, assigned_lanes: players.map((player) => ({ hero_id: player.hero_id, lane: 6 })) }} />);
  expect(html).toContain(">Greenwich</h3>");
  for (const name of ["York", "Broadway", "Greenwich"]) expect(html).not.toContain(`${name} lane`);
  expect(html).not.toContain("Purple");
});

test("lane columns put the top-map pair above totals and the bottom-map pair below", () => {
  const html = renderToStaticMarkup(<LaneView players={players} summary={summary} />);
  expect([...html.matchAll(/data-lane="([^"]+)"/g)].map((match) => match[1])).toEqual(["York", "Broadway", "Greenwich"]);
  expect(html).toContain("md:grid-cols-3");
  const broadway = html.split('data-lane="Broadway"')[1].split("</article>")[0];
  const top = broadway.indexOf('data-team="3" data-side="top"');
  const middle = broadway.indexOf('aria-label="Broadway totals"');
  const bottom = broadway.indexOf('data-team="2" data-side="bottom"');
  expect(top).toBeGreaterThanOrEqual(0);
  expect(middle).toBeGreaterThan(top);
  expect(bottom).toBeGreaterThan(middle);
  expect(broadway.slice(top, middle)).toContain("Player 3");
  expect(broadway.slice(top, middle)).not.toContain("Player 1");
  expect(broadway.slice(bottom)).toContain("Player 1");
  expect(broadway.match(/<details/g)).toHaveLength(2);
});

test("individual lane stats start collapsed without map-side labels", () => {
  const html = renderToStaticMarkup(<LaneView players={players} summary={summary} />);
  expect(html).not.toContain("Top of map");
  expect(html).not.toContain("Bottom of map");
  const dropdowns = html.match(/<details\b[^>]*>/g) ?? [];
  expect(dropdowns).toHaveLength(2);
  for (const dropdown of dropdowns) expect(dropdown).not.toMatch(/\sopen(?:[\s=>])/);
});

test("missing assignments remain separate and legacy green IDs do not duplicate columns", () => {
  const render = (data: MatchSummary) => renderToStaticMarkup(<LaneView players={players} summary={data} />);
  const legacy = render({ ...summary, assigned_lanes: players.map((player) => ({ hero_id: player.hero_id, lane: 3 })) });
  expect([...legacy.matchAll(/data-lane="([^"]+)"/g)].map((match) => match[1])).toEqual(["York", "Broadway", "Greenwich"]);
  const unassigned = render({ ...summary, assigned_lanes: [] });
  expect(unassigned).toContain("Unassigned players");
  expect(unassigned).toContain("Player 1");
  expect(unassigned).not.toContain("Difference vs opposing lane");
});

test("pair totals show signed souls, denies, damage and healing differences against the opposing lane", () => {
  const data = { ...summary, snapshots: summary.snapshots.map((row) => ({
    ...row, denies: row.hero_id, player_damage: row.hero_id * 100, player_healing: row.hero_id * 10,
  })) };
  const html = renderToStaticMarkup(<LaneView players={players} summary={data} />);
  const green = [...html.matchAll(/class="block text-\[10px\] text-emerald-500">([^<]+)<\/span>/g)].map((match) => match[1]);
  const red = [...html.matchAll(/class="block text-\[10px\] text-red-500">([^<]+)<\/span>/g)].map((match) => match[1]);
  expect(green).toEqual(["+4,000", "+4", "+400", "+40"]);
  expect(red).toEqual(["−4,000", "−4", "−400", "−40"]);
  expect(html.match(/title="Difference vs opposing lane"/g)).toHaveLength(8);
});

test("pair differences are neutral at zero and hidden when data is unavailable or from different times", () => {
  const render = (data: MatchSummary, roster = players) => renderToStaticMarkup(<LaneView players={roster} summary={data} />);
  expect(render(summary).match(/text-muted-foreground">±0/g)).toHaveLength(6);
  const missingHealing = { ...summary, snapshots: summary.snapshots.map((row) => row.hero_id === 1 ? { ...row, player_healing: null } : row) };
  expect(render(missingHealing).match(/title="Difference vs opposing lane"/g)).toHaveLength(6);
  const differentTimes = { ...summary, snapshots: summary.snapshots.map((row) => row.hero_id === 1 && row.time_s === 540 ? { ...row, time_s: 360 } : row) };
  expect(render(differentTimes)).not.toContain("Difference vs opposing lane");
  expect(render(summary, players.slice(0, 2))).not.toContain("Difference vs opposing lane");
  expect(render({ ...summary, snapshots: [] })).not.toContain("Difference vs opposing lane");
});

test("timeline offers recorded healing/regen sources and additional totals", () => {
  const html = renderToStaticMarkup(<TooltipProvider><TimelineView players={players} summary={summary} /></TooltipProvider>);
  for (const text of ["Timeline metric", "Healing by source", "Regeneration by source", "Self healing", "Teammate healing", "Damage taken", "Barrier absorption", "Damage mitigated"]) expect(html).toContain(text);
  expect(healingSourceLabel("modifier_citadel_in_fountain")).toBe("Fountain");
  expect(healingSourceLabel("medic_trooper_aoe_health_pickup_amber/regen")).toBe("Trooper healing");
  expect(healingSourceLabel("upgrade_quick_silver")).toBe("Quicksilver Reload");
});
