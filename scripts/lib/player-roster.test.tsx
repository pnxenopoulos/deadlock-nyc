import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlayerRoster, type PlayerInfo, type StatGroup } from "../../src/components/player-roster";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { PlayerPosition } from "../../src/wasm/frames";

const player: PlayerInfo = { hero_id: 63, hero_name: "Mina", name: "Test", steam_id: "63", team: 2, rank: 0 };
const stats: PlayerPosition = {
  slot: 0, team: 2, hero_id: 63, alive: true,
  x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
  health: 1000, max_health: 1000, barrier: 0, max_barrier: 0,
  net_worth: 10000, ap_net_worth: 0, kills: 1, deaths: 0, assists: 2,
  hero_damage: 1030, objective_damage: 200,
};

function render(group: StatGroup, live: PlayerPosition | null = stats) {
  return renderToStaticMarkup(<TooltipProvider>
    <PlayerRoster roster={[player]} stats={live ? new Map([[player.hero_id, live]]) : new Map()}
      team={2} align="left" statGroup={group} onSelect={() => {}} />
  </TooltipProvider>);
}

function ratio(live: PlayerPosition | null) {
  const html = render("econ", live);
  return [...html.split("<tbody>")[1].matchAll(/<td\b[^>]*>(.*?)<\/td>/g)][4][1];
}

test("roster removes objective damage per minute and keeps stat groups aligned", () => {
  for (const group of ["basic", "advanced", "econ", "position"] as const) {
    const html = render(group);
    expect(html).not.toContain("OBJ/m");
    expect(html.match(/<th\b/g)).toHaveLength(6);
    expect(html.match(/<td\b/g)).toHaveLength(6);
  }
  expect(render("advanced")).toContain("DPM");
  expect(render("econ")).toContain("D/NW");
});

test("damage per net worth uses two significant digits and includes objective damage", () => {
  expect(ratio(stats)).toBe("0.12");
  expect(ratio({ ...stats, hero_damage: 10340, objective_damage: 2000 })).toBe("1.2");
  expect(ratio({ ...stats, hero_damage: 100, objective_damage: 20 })).toBe("0.012");
  expect(ratio({ ...stats, hero_damage: 1000, objective_damage: 0 })).toBe("0.10");
  expect(ratio({ ...stats, net_worth: 0 })).toBe("—");
  expect(ratio(null)).toBe("—");
});
