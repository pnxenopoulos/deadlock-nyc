import abilityNames from "../data/ability-names.json";
import heroNames from "../data/hero-names.json";
import itemNames from "../data/item-names.json";
import type { StatContribution } from "../wasm/player-details";

const SOURCE_NAMES: Record<string, string> = { ...abilityNames, ...itemNames, ...heroNames };
const PICKUP_STATS: Record<string, string> = {
  ammo: "Ammo", bulletresist: "Bullet resist", cd: "Cooldown", firerate: "Fire rate",
  hp: "Health", movespeed: "Move speed", range: "Range", spirit: "Spirit power",
  spiritresist: "Spirit resist", wp: "Weapon power",
};
const KIND_LABELS: Record<string, string> = {
  base: "Base", base_light_reference: "Light melee reference", boon_flat: "Level bonus",
  boon_percent: "Level bonus", spirit_flat: "Spirit scaling", spirit_percent: "Spirit scaling",
  flat: "Bonus", percent: "Bonus", multiplier: "Multiplier", reduction: "Resistance reduction",
  property: "Property", runtime_count: "Recorded count", runtime_count_percent: "Count bonus",
  purchase_cost: "Item cost", purchase_flat: "Item category bonus", purchase_percent: "Item category bonus",
  flat_per_second: "Per-second bonus", distance_percent: "Distance bonus",
  post_multiplier_flat: "Bonus after multipliers",
};

function readable(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** The first path component is the owner; the last is often a field or index. */
export function statSourceLabel(source: string): string {
  if (source === "replay/player_pawn") return "Recorded player";
  const owner = (source.split("#/")[1] ?? source).split("/")[0];
  const pickup = owner.match(/^(.*)_permanent_pickup(?:_lv(\d+))?$/);
  if (pickup) {
    return `${PICKUP_STATS[pickup[1]] ?? readable(pickup[1])} pickup (tier ${pickup[2] ?? "1"})`;
  }
  return SOURCE_NAMES[owner] ?? readable(owner.replace(/^(?:hero_|upgrade_|citadel_ability_|ability_)/, ""));
}

export function contributionLabel(row: StatContribution): string {
  const kind = row.definition_path.includes("/m_mapStandardLevelUpUpgrades/")
    ? "Level bonus"
    : KIND_LABELS[row.kind] ?? readable(row.kind);
  return row.input === row.stat ? kind : `${readable(row.input)} · ${kind}`;
}

/** Purchase costs are intermediate inputs, not another bonus to the stat. */
export function visibleContributions(rows: StatContribution[]): StatContribution[] {
  return rows.filter((row) => row.kind !== "purchase_cost");
}

export function contributionSource(row: StatContribution): string {
  return row.kind === "purchase_flat" || row.kind === "purchase_percent"
    ? "Category bonus"
    : statSourceLabel(row.source);
}

export function contributionValue(row: StatContribution, unit: string): string {
  const percent = row.kind.includes("percent") || row.kind === "reduction";
  const inputUnit = row.kind === "runtime_count" ? ""
    : row.kind === "purchase_cost" ? " souls"
    : percent ? "%"
    : row.input === row.stat ? ({ "%": "%", "m/s": " m/s", m: " m", s: "s", multiplier: "×" }[unit] ?? "")
    : "";
  const sign = row.value > 0 && !["base", "base_light_reference", "runtime_count", "purchase_cost", "multiplier"].includes(row.kind) ? "+" : "";
  return `${sign}${row.value.toFixed(2).replace(/\.?0+$/, "")}${inputUnit}`;
}

export const RESISTANCE_EXPLANATION = "Base and growth combine first. Other resistance bonuses stack multiplicatively, not by addition. Reductions stack separately and are subtracted.";
