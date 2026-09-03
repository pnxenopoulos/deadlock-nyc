export interface PlayerPosition {
  slot: number;
  team: number;
  hero_id: number;
  alive: boolean;
  x: number;
  y: number;
  /** World height; negative values render on the tunnels layer. */
  z: number;
  /** Look angles in degrees: yaw is horizontal facing; pitch is vertical. */
  yaw: number;
  pitch: number;
  health: number;
  max_health: number;
  /** Current damage-absorbing barrier remaining. */
  barrier: number;
  net_worth: number;
  ap_net_worth: number;
  kills: number;
  deaths: number;
  assists: number;
  hero_damage: number;
  hero_healing: number;
  /** Cumulative damage dealt to objectives. */
  objective_damage: number;
  bonus_health: number;
  spirit_power: number;
  fire_rate: number;
  weapon_damage: number;
  cooldown_reduction: number;
  ammo: number;
  bullet_resist: number;
  spirit_resist: number;
  status_resist: number;
  bullet_lifesteal: number;
  spirit_lifesteal: number;
  /** Boon StatId completeness bits; unset values are best-effort estimates. */
  stat_complete_mask: number;
}

export interface PositionFrame {
  tick: number;
  /** Active, non-paused ticks elapsed at this frame. */
  reg_ticks: number;
  players: PlayerPosition[];
  /** Alive lane troopers, packed by the Rust parser. */
  troopers: number[];
  /** Live urn positions as flat x/y pairs. */
  urns: number[];
}

export interface PackedFrameData {
  frame_ticks: Int32Array;
  frame_reg_ticks: Int32Array;
  player_offsets: Uint32Array;
  player_i32: Int32Array;
  player_f32: Float32Array;
  player_i32_stride: number;
  player_f32_stride: number;
  trooper_offsets: Uint32Array;
  troopers: Int32Array;
  urn_offsets: Uint32Array;
  urns: Float32Array;
}

const PLAYER_I32_STRIDE = 15;
const PLAYER_F32_STRIDE = 17;

/** Compact, transferable storage for sampled frames.
 *
 * The parser returns numeric columns instead of retaining tens of thousands of
 * nested JavaScript objects. Only frames requested by the UI are materialized;
 * a two-entry cache keeps the current/next playback frames stable.
 */
export class FrameStore {
  private readonly cache = new Map<number, PositionFrame>();

  constructor(private readonly packed: PackedFrameData) {
    const n = packed.frame_ticks.length;
    if (
      packed.frame_reg_ticks.length !== n ||
      packed.player_offsets.length !== n + 1 ||
      packed.trooper_offsets.length !== n + 1 ||
      packed.urn_offsets.length !== n + 1 ||
      packed.player_i32.length % PLAYER_I32_STRIDE !== 0 ||
      packed.player_f32.length % PLAYER_F32_STRIDE !== 0 ||
      packed.player_i32_stride !== PLAYER_I32_STRIDE ||
      packed.player_f32_stride !== PLAYER_F32_STRIDE
    ) {
      throw new Error("invalid packed frame data");
    }
  }

  get length(): number {
    return this.packed.frame_ticks.length;
  }

  get retainedBytes(): number {
    const buffers = new Set<ArrayBuffer>();
    for (const view of packedFrameViews(this.packed)) {
      if (view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
    }
    let total = 0;
    for (const buffer of buffers) total += buffer.byteLength;
    return total;
  }

  tickAt(index: number): number | undefined {
    return index >= 0 && index < this.length
      ? this.packed.frame_ticks[index]
      : undefined;
  }

  regTicksAt(index: number): number | undefined {
    return index >= 0 && index < this.length
      ? this.packed.frame_reg_ticks[index]
      : undefined;
  }

  /** Visits players in one frame without constructing a PositionFrame or its
   * trooper/urn arrays. Use this for whole-demo analysis passes. */
  forEachPlayerAt(
    index: number,
    visit: (player: PlayerPosition) => void,
  ): void {
    if (index < 0 || index >= this.length) return;
    const start = this.packed.player_offsets[index];
    const end = this.packed.player_offsets[index + 1];
    for (let row = start; row < end; row++) visit(this.playerAt(row));
  }

  at(index: number): PositionFrame | undefined {
    if (index < 0 || index >= this.length) return undefined;
    const cached = this.cache.get(index);
    if (cached) return cached;

    const playerStart = this.packed.player_offsets[index];
    const playerEnd = this.packed.player_offsets[index + 1];
    const players: PlayerPosition[] = [];
    for (let row = playerStart; row < playerEnd; row++) {
      players.push(this.playerAt(row));
    }
    const trooperStart = this.packed.trooper_offsets[index];
    const trooperEnd = this.packed.trooper_offsets[index + 1];
    const urnStart = this.packed.urn_offsets[index];
    const urnEnd = this.packed.urn_offsets[index + 1];
    const frame: PositionFrame = {
      tick: this.packed.frame_ticks[index],
      reg_ticks: this.packed.frame_reg_ticks[index],
      players,
      troopers: Array.from(this.packed.troopers.subarray(trooperStart, trooperEnd)),
      urns: Array.from(this.packed.urns.subarray(urnStart, urnEnd)),
    };

    this.cache.set(index, frame);
    if (this.cache.size > 2) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return frame;
  }

  private playerAt(row: number): PlayerPosition {
    const ii = row * PLAYER_I32_STRIDE;
    const fi = row * PLAYER_F32_STRIDE;
    return {
      slot: this.packed.player_i32[ii],
      team: this.packed.player_i32[ii + 1],
      hero_id: this.packed.player_i32[ii + 2],
      alive: this.packed.player_i32[ii + 3] !== 0,
      x: this.packed.player_f32[fi],
      y: this.packed.player_f32[fi + 1],
      z: this.packed.player_f32[fi + 2],
      yaw: this.packed.player_f32[fi + 3],
      pitch: this.packed.player_f32[fi + 4],
      health: this.packed.player_i32[ii + 4],
      max_health: this.packed.player_i32[ii + 5],
      net_worth: this.packed.player_i32[ii + 6],
      ap_net_worth: this.packed.player_i32[ii + 7],
      kills: this.packed.player_i32[ii + 8],
      deaths: this.packed.player_i32[ii + 9],
      assists: this.packed.player_i32[ii + 10],
      hero_damage: this.packed.player_i32[ii + 11],
      hero_healing: this.packed.player_i32[ii + 12],
      objective_damage: this.packed.player_i32[ii + 13],
      stat_complete_mask: this.packed.player_i32[ii + 14],
      bonus_health: this.packed.player_f32[fi + 5],
      spirit_power: this.packed.player_f32[fi + 6],
      fire_rate: this.packed.player_f32[fi + 7],
      weapon_damage: this.packed.player_f32[fi + 8],
      cooldown_reduction: this.packed.player_f32[fi + 9],
      ammo: this.packed.player_f32[fi + 10],
      barrier: this.packed.player_f32[fi + 11],
      bullet_resist: this.packed.player_f32[fi + 12],
      spirit_resist: this.packed.player_f32[fi + 13],
      status_resist: this.packed.player_f32[fi + 14],
      bullet_lifesteal: this.packed.player_f32[fi + 15],
      spirit_lifesteal: this.packed.player_f32[fi + 16],
    };
  }

  forEach(visit: (frame: PositionFrame, index: number) => void): void {
    for (let i = 0; i < this.length; i++) visit(this.at(i)!, i);
  }

  indexAtOrAfter(tick: number): number {
    if (this.length === 0) return -1;
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.packed.frame_ticks[mid] < tick) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, this.length - 1);
  }

  nearest(tick: number): PositionFrame | undefined {
    const afterIndex = this.indexAtOrAfter(tick);
    if (afterIndex < 0) return undefined;
    const beforeIndex = afterIndex - 1;
    if (
      beforeIndex >= 0 &&
      Math.abs(this.packed.frame_ticks[beforeIndex] - tick) <=
        Math.abs(this.packed.frame_ticks[afterIndex] - tick)
    ) {
      return this.at(beforeIndex);
    }
    return this.at(afterIndex);
  }
}

export function packedFrameViews(data: PackedFrameData): ArrayBufferView[] {
  return [
    data.frame_ticks,
    data.frame_reg_ticks,
    data.player_offsets,
    data.player_i32,
    data.player_f32,
    data.trooper_offsets,
    data.troopers,
    data.urn_offsets,
    data.urns,
  ];
}
