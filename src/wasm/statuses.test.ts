import { expect, test } from "bun:test";
import { StatusStore } from "./statuses";
import type { PlayerStatus } from "./player-details";

const status = (states: string[]): PlayerStatus => ({ states, unknown_states: [], unknown_enabled_states: [], unknown_disabled_states: [] });

test("statuses seek backward/forward at exact change boundaries and remain player-specific", () => {
  const empty = status([]);
  const active = status(["stunned"]);
  const store = new StatusStore({ values: [empty, active], players: [
    { steam_id: "one", ticks: [10, 20, 30], indices: [0, 1, 0] },
    { steam_id: "two", ticks: [15], indices: [1] },
  ] });
  for (const [tick, expected] of [[30, empty], [20, active], [19, empty], [29, active], [10, empty]] as const) {
    expect(store.at("one", tick)).toBe(expected);
  }
  expect(store.at("one", 9)).toBeUndefined();
  expect(store.at("two", 30)).toBe(active);
  expect(store.at("absent", 30)).toBeUndefined();
});

test("status window percentages weight durations and clip both boundaries", () => {
  const store = new StatusStore({ values: [status([]), status(["IN_COMBAT"])], players: [
    { steam_id: "one", ticks: [10, 20, 80, 90], indices: [0, 1, 0, 1] },
    { steam_id: "two", ticks: [10], indices: [0] },
  ] });
  const percentage = (start: number, end: number) => store.percentageInWindow("one", "IN_COMBAT", start, end);
  expect(percentage(10, 100)).toBeCloseTo(70 / 90 * 100);
  expect(percentage(15, 25)).toBe(50);
  expect(percentage(30, 70)).toBe(100);
  expect(percentage(19, 20)).toBe(0);
  expect(percentage(20, 21)).toBe(100);
  expect(percentage(79, 80)).toBe(100);
  expect(percentage(80, 81)).toBe(0);
  expect(percentage(90, 110)).toBe(100);
  expect(store.percentageInWindow("two", "IN_COMBAT", 10, 100)).toBe(0);
  // A later window must not affect a subsequent backward seek.
  expect(percentage(10, 20)).toBe(0);
});

test("combat percentages use predicted IN_COMBAT, not enabled or bullet-hit states", () => {
  const store = new StatusStore({ values: [
    { ...status(["IN_COMBAT_BULLET_HIT"]), enabled_states: ["IN_COMBAT"] },
    status(["IN_COMBAT", "IN_COMBAT"]),
  ], players: [{ steam_id: "one", ticks: [10, 20], indices: [0, 1] }] });
  expect(store.percentageInWindow("one", "IN_COMBAT", 10, 20)).toBe(0);
  expect(store.percentageInWindow("one", "IN_COMBAT", 10, 30)).toBe(50);
  expect(store.percentageInWindow("one", "IN_COMBAT", 20, 30)).toBe(100);
});

test("unknown status coverage and empty windows are unavailable, not zero", () => {
  const store = new StatusStore({ values: [
    status([]), { ...status([]), states: undefined }, status(["IN_COMBAT"]),
  ], players: [{ steam_id: "one", ticks: [10, 20, 30], indices: [0, 1, 2] }] });
  const percentage = (start: number, end: number) => store.percentageInWindow("one", "IN_COMBAT", start, end);
  expect(percentage(9, 20)).toBeNull();
  expect(percentage(10, 10)).toBeNull();
  expect(percentage(20, 10)).toBeNull();
  expect(percentage(10, 30)).toBeNull();
  expect(percentage(20, 30)).toBeNull();
  expect(percentage(10, 20)).toBe(0);
  expect(percentage(30, 40)).toBe(100);
  expect(store.percentageInWindow("absent", "IN_COMBAT", 10, 20)).toBeNull();
});
