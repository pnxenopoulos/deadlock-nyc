import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { abilityNameFromId } from "../../src/components/ability-icon";
import { DemoInfoDialog } from "../../src/components/demo-info-dialog";
import { PermanentBuffs, PlayerDetail } from "../../src/components/player-detail";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { PlayerDetails, PlayerStatus } from "../../src/wasm/player-details";
import { resolve } from "node:path";
import { checkWebpFiles } from "./check-webp-files";
import version from "../../src/data/boon-version.json";

const previousBase = process.env.BASE_URL;
beforeEach(() => { process.env.BASE_URL = "/"; });
afterEach(() => {
  if (previousBase === undefined) delete process.env.BASE_URL;
  else process.env.BASE_URL = previousBase;
});

const status: PlayerStatus = {
  states: ["SPRINTING", "VAMPIRE"],
  enabled_states: ["VAMPIRE", "NEAR_CLIMBABLE_ROPE"],
  disabled_states: ["SILENCED"],
  unknown_states: [], unknown_enabled_states: [999], unknown_disabled_states: [],
};
const details: PlayerDetails = {
  hero_stats: { values: [], contributions: [], metadata: { data_version: version.client_version, source_commit: version.source_commit } },
  ability_stats: { values: [], contributions: [] },
  imbues: { bindings: [
    { item_id: 84321454, item_name: "Quicksilver Reload", ability_id: 193508101, ability_name: "Rake", status: "recorded" },
    { item_id: 754480263, item_name: "Mystic Expansion", ability_id: 193508101, ability_name: "Rake", status: "recorded" },
  ] },
};

function renderPlayer(playerStatus?: PlayerStatus) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <PlayerDetail
        player={{ name: "Test", steam_id: "76561198405200740", hero_id: 63, hero_name: "Mina", team: 2, rank: 0 }}
        stats={undefined} items={undefined} abilityLevels={undefined}
        abilities={[{ ability_id: 193508101, ability_name: "ability_vampirebat_steallife" }]}
        details={details} status={playerStatus} onBack={() => {}}
      />
    </TooltipProvider>,
  );
}

test("permanent buffs show all nine pickup bonuses and health/spirit counts", async () => {
  const html = renderToStaticMarkup(<TooltipProvider><PermanentBuffs totals={{ values: [105, 2, 6, 8, 1, 2, 3, 0.2, 9], counts: [5, 4, 2, 4, 2, 4, 2, 2, null] }} /></TooltipProvider>);
  for (const text of ["Bonus health", "+105", "5 pickups", "Spirit power", "+8", "4 pickups", "Max ammo", "Move speed", "+0.2 m/s", "Weapon damage", "Count unavailable"]) expect(html).toContain(text);
  for (const icon of ["health", "resist_bullet", "ammo_clip_size", "spirit", "resist_spirit", "cooldown", "fire_rate", "move_speed", "damage_weapon"]) {
    expect(await Bun.file(resolve(import.meta.dir, "../../public/icons/properties", `${icon}.svg`)).exists()).toBe(true);
  }
});

test("shows one recorded status view without duplicated masks or engine footnotes", () => {
  const html = renderPlayer(status);
  expect(html).toContain("Sprinting");
  expect(html).toContain("Vampire");
  expect(html.match(/title="VAMPIRE"/g)).toHaveLength(1);
  for (const text of ["Predicted mask", "Enabled mask", "Disabled mask", "Near Climbable Rope", "Silenced", "Raw masks recorded", "Current values calculated by Boon", "Hover a stat for its input breakdown", "Exact stats at", "Estimated stats at", "state bit"]) {
    expect(html).not.toContain(text);
  }
});

test("distinguishes unavailable statuses from an empty recorded mask", () => {
  expect(renderPlayer()).toContain("No status data at this tick.");
  expect(renderPlayer({ ...status, states: undefined })).toContain("No status data at this tick.");
  expect(renderPlayer({ ...status, states: [] })).toContain("No active statuses.");
  expect(renderPlayer({ ...status, unknown_states: [321] })).toContain("1 state bit");
});

test("Mina's Rake displays every imbue source as an image, resolved by item ID", async () => {
  expect(abilityNameFromId(84321454)).toBe("upgrade_quick_silver");
  expect(abilityNameFromId(754480263)).toBe("upgrade_magic_reach");
  expect(abilityNameFromId(0)).toBeUndefined();
  const html = renderPlayer(status);
  expect(html).toContain('aria-label="Items imbuing Rake"');
  expect(html).toContain('src="/items/spirit/quicksilver_reload_psd.webp"');
  expect(html).toContain('src="/items/spirit/mystic_reach_psd.webp"');
  expect(html).not.toContain(">+1<");
  await checkWebpFiles([
    "/items/spirit/quicksilver_reload_psd.webp",
    "/items/spirit/mystic_reach_psd.webp",
  ], resolve(import.meta.dir, "../../public"));
});

test("Demo info replaces stat-query implementation details with the boon-data version", () => {
  const html = renderToStaticMarkup(
    <DemoInfoDialog open onClose={() => {}} name="111155916.dem" mode="Standard" totalTicks={188537} regulationClock={null} winner={null} />,
  );
  expect(html).toContain("boon-data version");
  expect(html).toContain(version.client_version);
  expect(html).not.toContain("Stat queries");
  expect(html).not.toContain("Prepared checkpoints");
});

test("Demo info shows the selected catalog and warns only for known mismatches", () => {
  const render = (version: string) => renderToStaticMarkup(<DemoInfoDialog open onClose={() => {}} name="111155916.dem" mode="Standard" totalTicks={188537} regulationClock={null} winner={null} catalog={{ version, demoVersion: "6746" }} />);
  expect(render("6746")).toContain("6746");
  expect(render("6746")).not.toContain("No bundled catalog");
  expect(render("6759")).toContain("No bundled catalog");
});
