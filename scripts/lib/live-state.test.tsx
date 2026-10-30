import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildAbilityCooldowns,
  activeCooldown,
  chargeAt,
} from "../../src/lib/ability-state";
import { PlayerRoster } from "../../src/components/player-roster";
import { PlayerLiveState } from "../../src/components/player-live-state";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import type { AbilityTick } from "../../src/components/map-view";
import type { PlayerPosition } from "../../src/wasm/frames";

const row: AbilityTick = {
  tick: 64,
  hero_id: 1,
  ability_id: 7,
  slot: 0,
  cooldown_start: 100,
  cooldown_end: 110,
  remaining_charges: 2,
  charge_recharge_start: 0,
  charge_recharge_end: 0,
};
const clock = (tick: number) => tick - Math.min(128, Math.max(0, tick - 128));
const live: PlayerPosition = {
  slot: 0,
  team: 3,
  hero_id: 1,
  alive: true,
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  health: 700,
  max_health: 1000,
  barrier: 250,
  max_barrier: 500,
  net_worth: 0,
  ap_net_worth: 0,
  kills: 0,
  deaths: 0,
  assists: 0,
  hero_damage: 0,
  objective_damage: 0,
};

test("cooldown readings freeze across pauses and do not use future reductions", () => {
  const abilities = buildAbilityCooldowns(
    [row, { ...row, tick: 384, cooldown_end: 107 }],
    clock,
  ).get(1)!;
  const state = abilities.get(7)!;
  expect(activeCooldown(state.cooldowns, 63)).toBeNull();
  expect(activeCooldown(state.cooldowns, clock(128))?.remaining).toBe(9);
  expect(activeCooldown(state.cooldowns, clock(192))?.remaining).toBe(9);
  expect(activeCooldown(state.cooldowns, clock(256))?.remaining).toBe(9);
  expect(activeCooldown(state.cooldowns, clock(320))?.remaining).toBe(8);
  expect(activeCooldown(state.cooldowns, clock(384))?.remaining).toBe(4);
  expect(activeCooldown(state.cooldowns, 512)).toBeNull();
});

test("recorded ready states clear a cooldown and charge progress uses active ticks", () => {
  const state = buildAbilityCooldowns(
    [
      row,
      {
        ...row,
        tick: 192,
        cooldown_start: 0,
        cooldown_end: 0,
        remaining_charges: 1,
        charge_recharge_start: 1,
        charge_recharge_end: 6,
      },
    ],
    clock,
  )
    .get(1)!
    .get(7)!;
  expect(activeCooldown(state.cooldowns, 128)).toBeNull();
  expect(chargeAt(state.charges, clock(192), state.maxCharges)?.progress).toBe(
    0,
  );
  expect(chargeAt(state.charges, clock(256), state.maxCharges)?.progress).toBe(
    0,
  );
  expect(
    chargeAt(state.charges, clock(384), state.maxCharges)?.progress,
  ).toBeCloseTo(0.4);
  expect(chargeAt(state.charges, 63, state.maxCharges)).toBeNull();
});

test("Live is the default roster and includes recorded health and barrier", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <PlayerRoster
        roster={[
          {
            hero_id: 1,
            hero_name: "Infernus",
            name: "Test",
            steam_id: "1",
            team: 3,
            rank: 0,
          },
        ]}
        stats={new Map([[1, live]])}
        team={3}
        align="left"
        onSelect={() => {}}
      />
    </TooltipProvider>,
  );
  expect(html).toContain("Health / barrier &amp; abilities");
  expect(html).toContain("700 / 1000");
  expect(html).toContain("+250");
  expect(html).toContain('aria-label="Health"');
  expect(html).toContain('aria-label="Barrier"');
  expect(html).not.toContain(">K</span>");
});

test("compact abilities distinguish missing, cooling down and ready states", () => {
  const cooldowns = buildAbilityCooldowns([row], (tick) => tick).get(1);
  const render = (tick: number, stats = live) =>
    renderToStaticMarkup(
      <PlayerLiveState
        stats={stats}
        abilities={[{ ability_id: 7, ability_name: "citadel_ability_test" }]}
        cooldowns={cooldowns}
        tick={tick}
        color="#e08438"
      />,
    );
  expect(render(0)).toContain("No recorded state");
  expect(render(128)).toContain("9.0s cooldown");
  expect(render(704)).toContain("Ready");
  expect(render(128, { ...live, alive: false, health: 0 })).toContain("Dead");
});
