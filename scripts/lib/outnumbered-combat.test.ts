import { expect, test } from "bun:test";
import { OutnumberedCombat, OUTNUMBERED_RADIUS_METERS } from "../../src/lib/outnumbered-combat";
import { SOURCE_UNITS_PER_METER } from "../../src/lib/utils";
import type { PlayerInfo } from "../../src/components/player-roster";
import type { PlayerStatus } from "../../src/wasm/player-details";
import { StatusStore } from "../../src/wasm/statuses";
import { replayFrames, replayPlayer } from "./replay-fixture";

const subject = replayPlayer(1, 2);
const enemies = [replayPlayer(2, 3), replayPlayer(3, 3)];
const combat: PlayerStatus = { states: ["IN_COMBAT"], unknown_states: [], unknown_enabled_states: [], unknown_disabled_states: [] };
const noCombat: PlayerStatus = { ...combat, states: [], enabled_states: ["IN_COMBAT"] };
const rosterOf = (rows: typeof subject[]): PlayerInfo[] => rows.map((p) => ({
  hero_id: p.hero_id, team: p.team, steam_id: String(p.hero_id), name: String(p.hero_id), hero_name: String(p.hero_id), rank: 0,
}));
const statuses = (roster: PlayerInfo[], state = combat) => new StatusStore({
  values: [state], players: roster.map((p) => ({ steam_id: p.steam_id, ticks: [0], indices: [0] })),
});

function duration(rows: typeof subject[], state = combat) {
  const roster = rosterOf(rows);
  return new OutnumberedCombat(replayFrames([{ tick: 0, players: rows }, { tick: 64, players: rows }]),
    roster, statuses(roster, state), []).secondsInWindow(1, 0, 64);
}

test("outnumbered combat counts the subject, so 1v1 and 2v2 are even, not outnumbered", () => {
  expect(OUTNUMBERED_RADIUS_METERS).toBe(30);
  expect(duration([subject, enemies[0]])).toBe(0);
  expect(duration([subject, ...enemies])).toBe(1);
  expect(duration([subject, ...enemies, replayPlayer(4, 2)])).toBe(0);
  expect(duration([subject, ...enemies, replayPlayer(4, 2), replayPlayer(5, 3)])).toBe(1);
  expect(duration([subject])).toBe(0);
});

test("only living heroes count, and the subject must have predicted IN_COMBAT", () => {
  expect(duration([subject, ...enemies], noCombat)).toBe(0);
  expect(duration([{ ...subject, alive: false }, ...enemies])).toBe(0);
  expect(duration([subject, enemies[0], { ...enemies[1], alive: false }])).toBe(0);
  expect(duration([subject, ...enemies, replayPlayer(4, 2, { alive: false })])).toBe(1);
});

test("the 30-metre radius uses converted world units and full 3D distance", () => {
  const meters = SOURCE_UNITS_PER_METER;
  expect(duration([subject, enemies[0], { ...enemies[1], x: 29.99 * meters }])).toBe(1);
  expect(duration([subject, enemies[0], { ...enemies[1], x: 30.01 * meters }])).toBe(0);
  expect(duration([subject, enemies[0], { ...enemies[1], z: 31 * meters }])).toBe(0);
  expect(duration([subject, enemies[0], { ...enemies[1], x: 24 * meters, y: 24 * meters }])).toBe(0);
  expect(duration([subject, ...enemies, replayPlayer(4, 2, { y: 31 * meters })])).toBe(1);
});

test("window durations weight unequal samples and do not leak future frames", () => {
  const rows = [subject, ...enemies];
  const roster = rosterOf(rows);
  const even = [subject, enemies[0], { ...enemies[1], alive: false }];
  const frames = replayFrames([
    { tick: 0, players: rows }, { tick: 16, players: even },
    { tick: 80, players: rows }, { tick: 128, players: rows },
  ]);
  const store = new OutnumberedCombat(frames, roster, statuses(roster), []);
  expect(store.secondsInWindow(1, 0, 128)).toBe(1);
  expect(store.secondsInWindow(1, 8, 96)).toBe(0.375);
  expect(store.secondsInWindow(1, 16, 80)).toBe(0);
  expect(store.secondsInWindow(1, 80, 128)).toBe(0.75);
  expect(store.secondsInWindow(1, 0, 16)).toBe(0.25);
  expect(store.secondsInWindow(1, 128, 192)).toBeNull();
  expect(store.secondsInWindow(1, 16, 16)).toBeNull();
  expect(store.secondsInWindow(1, 80, 16)).toBeNull();
  expect(store.secondsInWindow(1, -1, 16)).toBeNull();
  expect(store.secondsInWindow(99, 0, 128)).toBeNull();
});

test("outnumbered duration excludes pauses, including clipped pause boundaries", () => {
  const rows = [subject, ...enemies];
  const roster = rosterOf(rows);
  const frames = replayFrames([{ tick: 0, players: rows }, { tick: 128, players: rows }]);
  const store = new OutnumberedCombat(frames, roster, statuses(roster), [{ start: 16, end: 96 }]);
  expect(store.secondsInWindow(1, 0, 128)).toBe(0.75);
  expect(store.secondsInWindow(1, 8, 104)).toBe(0.25);
  expect(store.secondsInWindow(1, 20, 30)).toBe(0);
});

test("missing status or player coverage is unavailable rather than invented", () => {
  const rows = [subject, ...enemies];
  const roster = rosterOf(rows);
  const frames = replayFrames([{ tick: 0, players: rows }, { tick: 64, players: rows }, { tick: 128, players: rows }]);
  const history = new StatusStore({ values: [{ ...combat, states: undefined }, combat], players: [
    { steam_id: "1", ticks: [0, 64], indices: [0, 1] },
  ] });
  const store = new OutnumberedCombat(frames, roster, history, []);
  expect(store.secondsInWindow(1, 0, 128)).toBeNull();
  expect(store.secondsInWindow(1, 64, 128)).toBe(1);
  expect(new OutnumberedCombat(frames, roster, history, [{ start: 0, end: 64 }])
    .secondsInWindow(1, 0, 128)).toBe(1);
  const missing = replayFrames([
    { tick: 0, players: rows }, { tick: 64, players: rows.slice(0, 2) }, { tick: 128, players: rows },
  ]);
  expect(new OutnumberedCombat(missing, roster, statuses(roster), []).secondsInWindow(1, 0, 128)).toBeNull();
  expect(new OutnumberedCombat(missing, roster, statuses(roster, noCombat), []).secondsInWindow(1, 0, 128)).toBe(0);
  expect(new OutnumberedCombat(replayFrames([]), roster, statuses(roster), []).secondsInWindow(1, 0, 64)).toBeNull();
});
