import { expect, test } from "bun:test";
import { FrameStore, type PackedFrameData } from "../../src/wasm/frames";

function fixture(): PackedFrameData {
  return {
    frame_ticks: new Int32Array([139489, 139857]),
    frame_reg_ticks: new Int32Array([137835, 138203]),
    player_offsets: new Uint32Array([0, 1, 2]),
    player_i32: new Int32Array([
      91, 2, 7, 1, 1877, 2652, 42714, 30, 4, 5, 4, 19280, 13331,
      91, 2, 7, 1, 1903, 2652, 42714, 30, 4, 5, 4, 19280, 13331,
    ]),
    player_f32: new Float32Array([
      -3267, 1540, 904, 262, 359, 526.61, 600,
      -2915, -1266, 248, 296, 10, 0, 0,
    ]),
    player_i32_stride: 13,
    player_f32_stride: 7,
    trooper_offsets: new Uint32Array(3),
    troopers: new Int32Array(),
    urn_offsets: new Uint32Array(3),
    urns: new Float32Array(),
  };
}

test("packed barrier fields preserve coordinates, health and subsequent player rows", () => {
  const store = new FrameStore(fixture());
  const before = store.at(0)!.players[0];
  expect(before.barrier).toBeCloseTo(526.61, 2);
  expect(before.max_barrier).toBe(600);
  expect([before.x, before.y, before.z, before.yaw, before.pitch]).toEqual([-3267, 1540, 904, 262, 359]);
  expect([before.health, before.max_health, before.net_worth]).toEqual([1877, 2652, 42714]);
  const after = store.at(1)!.players[0];
  expect([after.x, after.y, after.barrier, after.max_barrier]).toEqual([-2915, -1266, 0, 0]);
  store.forEachPlayerAt(0, (player) => expect(player.barrier).toBeCloseTo(526.61, 2));
});

test("a stale WASM float stride fails clearly", () => {
  expect(() => new FrameStore({ ...fixture(), player_f32_stride: 5 })).toThrow("invalid packed frame data");
});
