import { expect, test } from "bun:test";
import { PickupStore } from "./pickups";

test("sparse pickup totals seek backward without leaking another player's totals", () => {
  const store = new PickupStore([
    { steam_id: "a", tick: 10, values: [15, 0, 0, 2], counts: [1, 0, 0, 1] },
    { steam_id: "b", tick: 11, values: [25], counts: [1] },
    { steam_id: "a", tick: 30, values: [40, 0, 0, 8], counts: [2, 0, 0, 3] },
    { steam_id: "a", tick: 40, values: [0], counts: [0] },
  ]);
  expect(store.at("a", 9)).toBeUndefined();
  expect(store.at("a", 30)?.values[0]).toBe(40);
  expect(store.at("a", 20)?.counts[0]).toBe(1);
  expect(store.at("b", 100)?.values[0]).toBe(25);
  expect(store.at("a", 40)?.values[0]).toBe(0);
  expect(store.at("unknown", 100)).toBeUndefined();
});
