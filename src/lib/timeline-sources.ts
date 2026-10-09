import { statSourceLabel } from "./stat-breakdown";

/** Matrix sources are internal names rather than boon-data record paths. */
export function healingSourceLabel(source: string): string {
  const owner = source.split("/")[0];
  if (owner.startsWith("medic_trooper_aoe_health_pickup")) return "Trooper healing";
  return ({ base_stat_regen: "Base regeneration", modifier_citadel_in_fountain: "Fountain",
    modifier_invis_bush: "Veil", player_regen: "Player regeneration" } as Record<string, string>)[owner]
    ?? statSourceLabel(owner);
}
