/** Order shared with the compact WASM pickup history (pickups.rs). */
export const PICKUP_STATS = [
  { label: "Bonus health", icon: "health", unit: "" },
  { label: "Bullet resist", icon: "resist_bullet", unit: "%" },
  { label: "Max ammo", icon: "ammo_clip_size", unit: "%" },
  { label: "Spirit power", icon: "spirit", unit: "" },
  { label: "Spirit resist", icon: "resist_spirit", unit: "%" },
  { label: "Cooldown reduction", icon: "cooldown", unit: "%" },
  { label: "Fire rate", icon: "fire_rate", unit: "%" },
  { label: "Move speed", icon: "move_speed", unit: "m/s" },
  { label: "Weapon damage", icon: "damage_weapon", unit: "%" },
] as const;

export interface PickupTotals {
  values: number[];
  counts: (number | null | undefined)[];
}

export interface PickupEvent extends PickupTotals {
  steam_id: string;
  tick: number;
}

/** Change-only controller totals; seeking needs no replay or worker query. */
export class PickupStore {
  private readonly players = new Map<string, PickupEvent[]>();

  constructor(events: PickupEvent[]) {
    for (const event of events) {
      const player = this.players.get(event.steam_id);
      if (player) player.push(event);
      else this.players.set(event.steam_id, [event]);
    }
  }

  at(steamId: string, tick: number): PickupTotals | undefined {
    const events = this.players.get(steamId);
    if (!events) return undefined;
    let lo = 0;
    let hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (events[mid].tick <= tick) lo = mid + 1;
      else hi = mid;
    }
    return lo ? events[lo - 1] : undefined;
  }
}
