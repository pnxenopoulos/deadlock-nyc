import { expect, test } from "bun:test";
import { contributionLabel, contributionValue, statSourceLabel } from "../../src/lib/stat-breakdown";
import type { StatContribution } from "../../src/wasm/player-details";
import { contributionSource, visibleContributions } from "../../src/lib/stat-breakdown";

function contribution(fields: Partial<StatContribution> = {}): StatContribution {
  return {
    stat: "spirit_resist", input: "spirit_resist", kind: "percent", value: 2.25,
    source: "misc.vdata#/spiritresist_permanent_pickup_lv2/m_sModifer",
    definition_path: "m_PlayerDataGlobal.m_vecStatViewerModifierValues.5.m_flValue",
    ...fields,
  };
}

test("uses the owning hero, item or pickup instead of a field name or array index", () => {
  expect(statSourceLabel("heroes.vdata#/hero_vampirebat")).toBe("Mina");
  expect(statSourceLabel("misc.vdata#/spiritresist_permanent_pickup/m_sModifer")).toBe("Spirit resist pickup (tier 1)");
  expect(statSourceLabel("misc.vdata#/spiritresist_permanent_pickup_lv2/m_sModifer")).toBe("Spirit resist pickup (tier 2)");
  expect(statSourceLabel("abilities.vdata#/upgrade_tech_armor/m_AutoIntrinsicModifiers/0")).toBe("Spirit Armor");
  expect(statSourceLabel("abilities.vdata#/upgrade_reduce_debuff_duration/m_AutoIntrinsicModifiers/0")).toBe("Dispel Magic");
  expect(statSourceLabel("abilities.vdata#/upgrade_spellbreaker/m_AutoIntrinsicModifiers/0")).toBe("Spellbreaker");
  expect(statSourceLabel("abilities.vdata#/ability_vampirebat_batblink/m_ExplodeModifier")).toBe("Sanguine Retreat");
  expect(statSourceLabel("replay/player_pawn")).toBe("Recorded player");
  expect(statSourceLabel("abilities.vdata#/upgrade_not_yet_localized/m_AutoIntrinsicModifiers/0")).toBe("Not Yet Localized");
});

test("weapon damage shows category and pickup bonuses, not intermediate item costs", () => {
  const rows = [
    contribution({ stat: "weapon_damage", input: "purchase_cost", kind: "purchase_cost", value: 1600, source: "abilities.vdata#/upgrade_fire_rate" }),
    contribution({ stat: "weapon_damage", input: "weapon_damage", kind: "purchase_percent", value: 12, source: "heroes.vdata#/hero_vampirebat" }),
    contribution({ stat: "weapon_damage", input: "weapon_damage", kind: "percent", value: 3, source: "misc.vdata#/wp_permanent_pickup/m_sModifer" }),
  ];
  const visible = visibleContributions(rows);
  expect(visible.map(contributionSource)).toEqual(["Category bonus", "Weapon power pickup (tier 1)"]);
  expect(visible.map((row) => contributionValue(row, "%"))).toEqual(["+12%", "+3%"]);
  expect(rows).toHaveLength(3);
});

test("labels contribution roles and displays units and signs without altering inputs", () => {
  const row = Object.freeze(contribution());
  expect(contributionLabel(row)).toBe("Bonus");
  expect(contributionValue(row, "%")).toBe("+2.25%");
  expect(contributionLabel(contribution({ kind: "boon_flat", value: 0 }))).toBe("Level bonus");
  expect(contributionValue(contribution({ kind: "boon_flat", value: 0 }), "%")).toBe("0%");
  expect(contributionValue(contribution({ kind: "reduction", value: -10 }), "%")).toBe("-10%");
  expect(contributionValue(contribution({ value: 10 }), "%")).toBe("+10%");
  expect(contributionValue(contribution({ value: 18 }), "%")).toBe("+18%");
  expect(contributionValue(contribution({ kind: "runtime_count", value: 3 }), "%")).toBe("3");
  expect(contributionLabel(contribution({ input: "spirit_power", kind: "flat", value: 18 }))).toBe("Spirit Power · Bonus");
  expect(contributionValue(contribution({ input: "spirit_power", kind: "flat", value: 18 }), "%")).toBe("+18");
  expect(contributionValue(contribution({ stat: "move_speed", input: "move_speed", kind: "base", value: 6 }), "m/s")).toBe("6 m/s");
  expect(contributionValue(contribution({ stat: "fire_rate", input: "fire_rate", value: 10 }), "per second")).toBe("+10%");
});
