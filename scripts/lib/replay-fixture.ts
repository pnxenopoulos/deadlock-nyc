import { FrameStore, type PlayerPosition } from "../../src/wasm/frames";

export function replayFrames(samples: { tick: number; players: PlayerPosition[] }[]): FrameStore {
  const rows = samples.flatMap((sample) => sample.players);
  let offset = 0;
  const playerOffsets = samples.map((sample) => {
    const start = offset;
    offset += sample.players.length;
    return start;
  });
  playerOffsets.push(offset);
  const emptyOffsets = new Uint32Array(samples.length + 1);
  return new FrameStore({
    frame_ticks: Int32Array.from(samples.map((sample) => sample.tick)),
    frame_reg_ticks: Int32Array.from(samples.map((sample) => sample.tick)),
    player_offsets: Uint32Array.from(playerOffsets),
    player_i32: Int32Array.from(rows.flatMap((p) => [
      p.slot, p.team, p.hero_id, Number(p.alive), p.health, p.max_health,
      p.net_worth, p.ap_net_worth, p.kills, p.deaths, p.assists, p.hero_damage, p.objective_damage,
    ])),
    player_f32: Float32Array.from(rows.flatMap((p) => [p.x, p.y, p.z, p.yaw, p.pitch, p.barrier, p.max_barrier])),
    player_i32_stride: 13, player_f32_stride: 7,
    trooper_offsets: emptyOffsets, troopers: new Int32Array(),
    urn_offsets: emptyOffsets, urns: new Float32Array(),
  });
}

export function replayPlayer(hero_id: number, team: number, overrides: Partial<PlayerPosition> = {}): PlayerPosition {
  return {
    hero_id, team, slot: hero_id, alive: true, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    health: 1000, max_health: 1000, barrier: 0, max_barrier: 0,
    net_worth: 10000, ap_net_worth: 0, kills: 0, deaths: 0, assists: 0,
    hero_damage: 0, objective_damage: 0, ...overrides,
  };
}
