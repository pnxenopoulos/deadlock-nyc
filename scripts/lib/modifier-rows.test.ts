import { expect, test } from "bun:test";
import { isIgnoredModifier, isPermanentStatPickup, statDiagnostic } from "../../src/lib/modifier-rows";

const preMatch = "modifier ID 1243903559 (modifier_citadel_pre_match_wait) has no stat definition";

test("ignores only explicitly listed modifier names, including qualified names", () => {
  expect(isIgnoredModifier("modifier_citadel_pre_match_wait")).toBe(true);
  expect(isIgnoredModifier("engine/modifier_citadel_pre_match_wait")).toBe(true);
  for (const name of ["", "modifier_citadel_pre_match_wait_debuff", "modifier_in_fountain", "modifier_grapple_arm"]) {
    expect(isIgnoredModifier(name)).toBe(false);
  }
});

test("suppresses allowlisted missing-definition warnings without changing other diagnostics", () => {
  const unknown = "unresolved modifier ID 999";
  expect(statDiagnostic(`ignored modifiers: ${preMatch}`)).toBeUndefined();
  expect(statDiagnostic(`ignored modifiers: ${preMatch}; ${unknown}`)).toBe(`ignored modifiers: ${unknown}`);
  expect(statDiagnostic(`ignored modifiers: ${unknown}; ${preMatch}`)).toBe(`ignored modifiers: ${unknown}`);
  expect(statDiagnostic(`missing replay field; ignored modifiers: ${preMatch}; unmapped inputs: active bonus`))
    .toBe("missing replay field; unmapped inputs: active bonus");
  expect(statDiagnostic(`ignored modifiers: ${preMatch}; inferred activation: temporary buff; unmapped inputs: active bonus`))
    .toBe("inferred activation: temporary buff; unmapped inputs: active bonus");
  const unrelated = `invalid input: ${preMatch}`;
  expect(statDiagnostic(unrelated)).toBe(unrelated);
  expect(statDiagnostic("ignored modifiers: modifier ID 42 (modifier_grapple_arm) has no stat definition"))
    .toBe("ignored modifiers: modifier ID 42 (modifier_grapple_arm) has no stat definition");
  expect(statDiagnostic("ignored modifiers: ambiguous modifier ID 42; an owner is required"))
    .toBe("ignored modifiers: ambiguous modifier ID 42; an owner is required");
  expect(statDiagnostic()).toBeUndefined();
});

test("hides permanent stat pickups with generic or qualified modifier names", () => {
  for (const modifier_name of [
    "modifier_permanent_pickup",
    "firerate_permanent_pickup_lv2/modifier_permanent_pickup",
    "spirit_permanent_pickup_lv3/modifier_permanent_pickup",
  ]) {
    expect(isPermanentStatPickup({ ability_name: "", modifier_name })).toBe(true);
  }
});

test("identifies every permanent pickup stat and tier when only the source name resolves", () => {
  for (const stat of ["ammo", "bulletresist", "cd", "firerate", "hp", "movespeed", "range", "spirit", "spiritresist", "wp"]) {
    for (const tier of ["", "_lv2", "_lv3"]) {
      expect(isPermanentStatPickup({
        ability_name: `${stat}_permanent_pickup${tier}`,
        modifier_name: "",
      })).toBe(true);
    }
  }
});

test("keeps other permanent effects and temporary pickups visible", () => {
  for (const modifier of [
    { ability_name: "upgrade_siphon_bullets", modifier_name: "modifier_siphon_bullets" },
    { ability_name: "", modifier_name: "modifier_permanent_health_bonus" },
    { ability_name: "ammo_pickup", modifier_name: "modifier_temporary_pickup" },
    { ability_name: "", modifier_name: "modifier_in_fountain" },
    { ability_name: "", modifier_name: "" },
  ]) {
    expect(isPermanentStatPickup(modifier)).toBe(false);
  }
});

test("filters display entries without changing the original parser data", () => {
  const modifiers = [
    { ability_name: "hp_permanent_pickup", modifier_name: "modifier_permanent_pickup" },
    { ability_name: "upgrade_siphon_bullets", modifier_name: "modifier_siphon_bullets" },
  ];
  const visible = modifiers.filter((modifier) => !isPermanentStatPickup(modifier));
  expect(visible).toEqual([modifiers[1]]);
  expect(modifiers).toHaveLength(2);
});
