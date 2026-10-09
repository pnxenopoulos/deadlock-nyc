import { expect, test } from "bun:test";
import { regulationTicksAt } from "../../src/lib/replay-clock";
import { FrameStore } from "../../src/wasm/frames";

function frames(ticks: number[], regulation: number[]) {
  const offsets = new Uint32Array(ticks.length + 1);
  return new FrameStore({
    frame_ticks: Int32Array.from(ticks),
    frame_reg_ticks: Int32Array.from(regulation),
    player_offsets: offsets,
    player_i32: new Int32Array(),
    player_f32: new Float32Array(),
    player_i32_stride: 13,
    player_f32_stride: 7,
    trooper_offsets: offsets,
    troopers: new Int32Array(),
    urn_offsets: offsets,
    urns: new Float32Array(),
  });
}

test("feed timestamps use the same regulation clock as playback frames", () => {
  const store = frames([1, 76113], [0, 74459]);
  expect(regulationTicksAt(store, 76113, [])).toBe(store.regTicksAt(1)!);
  const pauses = [{ start: 34743, end: 35902 }, { start: 35982, end: 36476 }];
  expect(regulationTicksAt(store, 76112, pauses)).toBe(74458);
  expect(Math.floor(regulationTicksAt(store, 76112, pauses) / 64)).toBe(19 * 60 + 23);
});

test("unsampled events freeze during pauses, including boundary ticks", () => {
  const store = frames([1, 9, 17, 25, 33], [0, 8, 11, 12, 20]);
  const pauses = [{ start: 12, end: 24 }];
  for (const tick of [12, 13, 17, 23, 24]) {
    expect(regulationTicksAt(store, tick, pauses)).toBe(11);
  }
  expect(regulationTicksAt(store, 10, pauses)).toBe(9);
  expect(regulationTicksAt(store, 26, pauses)).toBe(13);
  expect(regulationTicksAt(store, 0, pauses)).toBe(0);
});

test("an empty replay has no regulation time", () => {
  expect(regulationTicksAt(frames([], []), 100, [])).toBe(0);
});
