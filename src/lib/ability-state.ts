import type { AbilityTick } from "../components/map-view";
const TICKS_PER_SECOND = 64;

/** One reconstructed cooldown period for an ability, in active, non-paused ticks. */
export type CooldownSpan = {
  /** Active tick when this recorded state takes effect. */
  start: number;
  /** Tick the ability becomes available again. */
  end: number;
  /** Total cooldown length in seconds (the ring's full sweep). */
  total: number;
};

/** Charge count over time for a charge-based ability (valid from `startTick`). */
export type ChargeState = {
  startTick: number;
  /** Available charges at this point. */
  count: number;
  /** Tick the regenerating charge began filling (anchor for its bar). */
  rechargeStart: number;
  /** Tick the regenerating charge completes. */
  rechargeEnd: number;
  recharging: boolean;
};

/** Reconstructed cooldown + charge timeline for one ability. */
export type AbilityCooldown = {
  /** Max charges seen; ≥ 2 marks a charge-based ability (show pills, no ring). */
  maxCharges: number;
  cooldowns: CooldownSpan[];
  charges: ChargeState[];
};

// The cooldown active at `tick`, or null if the ability is ready. Spans are
// tick-ordered, so the latest recorded state starting at or before
// `tick` is the only candidate.
export function activeCooldown(
  spans: CooldownSpan[] | undefined,
  tick: number,
): { remaining: number; total: number } | null {
  if (!spans) return null;
  for (let i = spans.length - 1; i >= 0; i--) {
    if (spans[i].start <= tick) {
      return tick < spans[i].end
        ? {
            remaining: (spans[i].end - tick) / TICKS_PER_SECOND,
            total: spans[i].total,
          }
        : null;
    }
  }
  return null;
}

// Charge count + recharge progress (0..1 for the regenerating charge) at `tick`.
export function chargeAt(
  states: ChargeState[],
  tick: number,
  maxCharges: number,
): { count: number; recharging: boolean; progress: number } | null {
  for (let i = states.length - 1; i >= 0; i--) {
    const s = states[i];
    if (s.startTick <= tick) {
      const recharging =
        s.recharging && s.count < maxCharges && tick < s.rechargeEnd;
      const span = s.rechargeEnd - s.rechargeStart;
      const progress =
        recharging && span > 0
          ? Math.min(1, Math.max(0, (tick - s.rechargeStart) / span))
          : 0;
      return { count: s.count, recharging, progress };
    }
  }
  return null;
}

/** Keep each recorded change separate: later cooldown reductions must not alter earlier ticks. */
export function buildAbilityCooldowns(
  rows: AbilityTick[],
  clock: (tick: number) => number,
) {
  const groups = new Map<string, AbilityTick[]>();
  for (const row of rows) {
    const key = row.hero_id + ":" + row.ability_id;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const byHero = new Map<number, Map<number, AbilityCooldown>>();
  for (const records of groups.values()) {
    const cooldowns: CooldownSpan[] = [],
      charges: ChargeState[] = [];
    let castStart: number | null = null,
      castAnchor = 0;
    let rechargeStart: number | null = null,
      rechargeAnchor = 0,
      maxCharges = 0;
    for (const row of records) {
      const tick = clock(row.tick);
      if (castStart !== row.cooldown_start) {
        castStart = row.cooldown_start;
        castAnchor = tick;
      }
      const total = Math.max(0, row.cooldown_end - row.cooldown_start);
      cooldowns.push({
        start: tick,
        end: total > 0 ? castAnchor + total * TICKS_PER_SECOND : tick,
        total,
      });
      const recharging = row.charge_recharge_end > row.charge_recharge_start;
      if (rechargeStart !== row.charge_recharge_start) {
        rechargeStart = row.charge_recharge_start;
        rechargeAnchor = tick;
      }
      charges.push({
        startTick: tick,
        count: row.remaining_charges,
        rechargeStart: rechargeAnchor,
        rechargeEnd: recharging
          ? rechargeAnchor +
            (row.charge_recharge_end - row.charge_recharge_start) *
              TICKS_PER_SECOND
          : tick,
        recharging,
      });
      maxCharges = Math.max(maxCharges, row.remaining_charges);
    }
    const hero = records[0].hero_id,
      ability = records[0].ability_id;
    const abilities = byHero.get(hero) ?? new Map<number, AbilityCooldown>();
    abilities.set(ability, { maxCharges, cooldowns, charges });
    byHero.set(hero, abilities);
  }
  return byHero;
}
