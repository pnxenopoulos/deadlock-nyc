import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TimelineReadout } from "../../src/components/timeline-view";
import { percentageOfTotal, teamContributions } from "../../src/lib/timeline-contributions";
import type { SnapshotStat } from "../../src/wasm/boon";

const players = [1, 2, 3].map((hero_id) => ({
  hero_id, hero_name: `Hero ${hero_id}`, name: `Player ${hero_id}`,
  steam_id: String(hero_id), rank: 0, team: hero_id < 3 ? 2 : 3,
}));
const snapshot = (hero_id: number, time_s: number, net_worth: number, player_healing?: number | null) =>
  ({ hero_id, time_s, net_worth, player_healing }) as SnapshotStat;

test("team contributions use only the hovered sample and that team's total", () => {
  const snapshots = [
    snapshot(1, 540, 1000), snapshot(2, 540, 3000), snapshot(3, 540, 8000),
    snapshot(1, 720, 9000), snapshot(2, 720, 9000),
  ];
  const rows = teamContributions(players, snapshots, 540, 2, "net_worth", 4000);
  expect(rows).toEqual([
    { label: "Hero 2", name: "Player 2", heroId: 2, v: 3000, percentage: "75%" },
    { label: "Hero 1", name: "Player 1", heroId: 1, v: 1000, percentage: "25%" },
  ]);
  expect(teamContributions(players, snapshots, 540, 3, "net_worth", 8000)[0].percentage).toBe("100%");
  expect(teamContributions(players, snapshots, 600, 2, "net_worth", 4000)).toEqual([]);
  expect(snapshots.map((row) => row.hero_id)).toEqual([1, 2, 3, 1, 2]);
});

test("contributions use the chosen metric without inventing missing values", () => {
  const snapshots = [snapshot(1, 540, 1000, 50), snapshot(2, 540, 3000, 150)];
  expect(teamContributions(players, snapshots, 540, 2, "player_healing", 200).map((row) => [row.v, row.percentage]))
    .toEqual([[150, "75%"], [50, "25%"]]);
  expect(teamContributions(players, [snapshot(1, 540, 1000, null), snapshot(2, 540, 3000)], 540, 2, "player_healing", 0))
    .toEqual([]);
  expect(teamContributions(players, [snapshot(1, 540, 0, 0)], 540, 2, "player_healing", 0)[0].percentage).toBe("0%");
});

test("percentages handle fractional shares and empty totals", () => {
  expect(percentageOfTotal(1, 3)).toBe("33.3%");
  expect(percentageOfTotal(2, 3)).toBe("66.7%");
  expect(percentageOfTotal(0, 100)).toBe("0%");
  expect(percentageOfTotal(0, 0)).toBe("0%");
  expect(percentageOfTotal(100, 100)).toBe("100%");
});

test("team readout indents player contributions beneath the team total", () => {
  const children = teamContributions(players, [snapshot(1, 540, 1000), snapshot(2, 540, 3000)], 540, 2, "net_worth", 4000)
    .map((row) => ({ ...row, color: "#fbbf24" }));
  const html = renderToStaticMarkup(<TimelineReadout rows={[{ label: "Amber", color: "#fbbf24", v: 4000, children }]} />);
  expect(html).toContain("Amber");
  expect(html).toContain('class="pl-4"');
  expect(html).toContain('title="Hero 2 · Player 2"');
  expect(html).toContain('title="Hero 1 · Player 1"');
  expect(html).toContain(" (75%)");
  expect(html).toContain(" (25%)");
  expect(html.match(/%\)/g)).toHaveLength(2);
});

test("source readout places shares in parentheses beside each value", () => {
  const html = renderToStaticMarkup(<TimelineReadout rows={[
    { label: "Weapon", color: "#fbbf24", v: 60, percentage: percentageOfTotal(60, 100) },
    { label: "Ability", color: "#a78bfa", v: 40, percentage: percentageOfTotal(40, 100) },
  ]} />);
  expect(html).toContain('>60<span class="text-muted-foreground"> (60%)</span>');
  expect(html).toContain('>40<span class="text-muted-foreground"> (40%)</span>');
  expect(html).not.toContain('class="pl-4"');
});
