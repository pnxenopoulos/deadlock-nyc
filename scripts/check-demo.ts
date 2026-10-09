import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { PositionsResult } from "../src/components/map-view";
import type { PlayerInfo } from "../src/components/player-roster";
import { FrameStore, type PackedFrameData } from "../src/wasm/frames";
import type { PlayerDetails } from "../src/wasm/player-details";
import { StatusStore, type StatusHistory } from "../src/wasm/statuses";
import init, { DemoParser } from "../src/wasm/pkg/boon_wasm.js";
import { selectBoonCatalog } from "../src/wasm/catalog";
import { regulationTicksAt } from "../src/lib/replay-clock";
import { PickupStore } from "../src/wasm/pickups";
import type { MatchSummary } from "../src/wasm/boon";
import { laneSnapshots } from "../src/lib/lane-stats";
import { objectivesAt } from "../src/lib/objectives";
import { OutnumberedCombat } from "../src/lib/outnumbered-combat";

// Run the real browser WASM adapter without a DOM. The demo is local and
// gitignored; rebuild with `bun run wasm` before running this check.
const root = resolve(import.meta.dir, "..");
const demo = resolve(process.argv[2] ?? resolve(root, "111155916.dem"));
const tick = Number(process.argv[3] ?? 73952);
assert(Number.isInteger(tick) && tick >= 0, "tick must be a nonnegative integer");
await init({
  module_or_path: await Bun.file(resolve(root, "src/wasm/pkg/boon_wasm_bg.wasm")).arrayBuffer(),
});
const parser = new DemoParser(new Uint8Array(await Bun.file(demo).arrayBuffer()));

try {
  console.log(`Checking ${demo} at tick ${tick}…`);
  const catalog = selectBoonCatalog(parser.fileHeader());
  const catalogs = await Promise.all(["heroes", "abilities", "modifiers", "misc"].map(
    async (name) => new Uint8Array(await Bun.file(
      resolve(root, "public/boon-data", catalog.version, `${name}.json`),
    ).arrayBuffer()),
  ));
  parser.loadCatalog(catalogs[0], catalogs[1], catalogs[2], catalogs[3]);
  const positions = parser.playerPositions(8, () => {}) as
    Omit<PositionsResult, "frames"> & PackedFrameData & { players: PlayerInfo[] };
  const frames = new FrameStore(positions);
  const pickups = new PickupStore(positions.permanent_buffs);
  assert(positions.permanent_buffs.length > 0, "no pickup history");
  assert(positions.permanent_buffs.length < frames.length, "pickup history is not change-only");
  for (const event of positions.permanent_buffs) {
    assert.equal(event.values.length, 9, "missing pickup bonus categories");
    assert.equal(event.counts.length, 9, "missing pickup counts");
    assert(event.values.every((value) => Number.isFinite(value) && value >= 0), "invalid pickup total");
    assert(event.counts.every((count) => count == null || Number.isInteger(count) && count >= 0), "invalid pickup count");
  }
  assert(positions.permanent_buffs.some((event) => event.values[0] > 0 && event.counts[0]! > 0), "no health pickups");
  assert(positions.permanent_buffs.some((event) => event.values[3] > 0 && event.counts[3]! > 0), "no spirit pickups");
  const summary = parser.summary() as MatchSummary;
  assert(summary.healing_by_source.length > 0, "no healing source series");
  assert(summary.regen_by_source.length > 0, "no regeneration source series");
  for (const source of [...summary.damage_by_source, ...summary.healing_by_source, ...summary.regen_by_source]) {
    assert.equal(source.values.length, summary.damage_sample_times.length, "summary series/time axis mismatch");
    assert(source.values.every((value, index, values) => value >= 0 && (!index || value >= values[index - 1])), "non-cumulative source series");
  }
  assert.equal(summary.assigned_lanes.length, positions.players.length, "missing recorded lane assignments");
  if (demo.endsWith("111155916.dem")) {
    assert.equal(laneSnapshots(summary, 600).get(63)?.time_s, 540, "lane cutoff uses a future sample");
  }
  const statusHistory = parser.playerStatusHistory(positions.frame_ticks) as StatusHistory;
  const statuses = new StatusStore(statusHistory);
  const checkpointed = parser.prepareStats();
  assert(checkpointed, "stat replay checkpoints were not prepared");
  assert(frames.length > 0, "no playback frames");
  let frameIndex = 0;
  while (frameIndex + 1 < frames.length && frames.tickAt(frameIndex + 1)! <= tick) frameIndex++;
  const frame = frames.at(frameIndex)!;
  assert.equal(regulationTicksAt(frames, frame.tick, positions.pause_intervals), frame.reg_ticks,
    "feed clock differs from the map regulation clock");
  assert(frame.tick <= tick && tick - frame.tick < 8, "requested tick is not in the replay");
  assert(positions.players.length > 0, "no roster");
  assert.equal(frame.players.length, positions.players.length, "players missing from map");
  frames.forEach((frame) => frame.players.forEach((player) => {
    assert(Number.isFinite(player.barrier) && player.barrier >= 0, "invalid barrier HP");
    assert(Number.isFinite(player.max_barrier) && player.max_barrier >= player.barrier,
      "barrier capacity is smaller than remaining HP");
  }));
  if (positions.players.some((player) => player.hero_name === "Wraith") && demo.endsWith("111155916.dem")) {
    const wraithBarrier = (tick: number) => frames.nearest(tick)!.players.find((player) => player.hero_id === 7)!.barrier;
    assert.equal(wraithBarrier(139480), 0, "Wraith has a barrier before Project Mind");
    assert(Math.abs(wraithBarrier(139488) - 526.61) < 0.01, "Wraith's Project Mind barrier is missing");
    assert.equal(wraithBarrier(139857), 0, "Wraith's Project Mind barrier did not end");
  }
  const onMap = (point: { x: number; y: number; z?: number }) => {
    for (const coordinate of [point.x, point.y, point.z ?? 0]) {
      assert(Number.isFinite(coordinate) && Math.abs(coordinate) < 16384,
        `off-map coordinate: ${JSON.stringify(point)}`);
    }
  };
  frame.players.forEach(onMap);
  positions.objectives.forEach(onMap);
  positions.neutral_camps.forEach(onMap);
  positions.breakable_events.forEach(onMap);
  positions.sinner_events.forEach(onMap);
  for (let index = 0; index < frame.urns.length; index += 2) {
    onMap({ x: frame.urns[index], y: frame.urns[index + 1] });
  }
  assert(positions.breakable_events.length > 0, "no breakable events");
  assert(positions.sinner_events.length > 0, "no Sinner's Sacrifice events");

  if (demo.endsWith("111155916.dem")) {
    const wraith = positions.players.find((player) => player.hero_name === "Wraith")!;
    const combat = statuses.percentageInWindow(wraith.steam_id, "IN_COMBAT",
      frames.tickAt(0)!, frames.tickAt(frames.length - 1)!);
    assert(combat != null && Math.abs(combat - 27.05) < 0.01,
      "heatmap combat percentage is not based on recorded IN_COMBAT time");
    const started = performance.now();
    const outnumbered = new OutnumberedCombat(frames, positions.players, statuses, positions.pause_intervals);
    const fullOutnumbered = positions.players.map((player) => {
      const seconds = outnumbered.secondsInWindow(player.hero_id, frames.tickAt(0)!, frames.tickAt(frames.length - 1)!);
      const combatPercentage = statuses.percentageInWindow(player.steam_id, "IN_COMBAT",
        frames.tickAt(0)!, frames.tickAt(frames.length - 1)!)!;
      const combatSeconds = combatPercentage / 100 * (frames.tickAt(frames.length - 1)! - frames.tickAt(0)!) / 64;
      assert(seconds != null && seconds >= 0 && seconds <= combatSeconds,
        `invalid outnumbered combat time for ${player.hero_name}`);
      return { hero: player.hero_name, seconds };
    });
    assert(fullOutnumbered.some((player) => player.seconds > 0), "no outnumbered combat intervals");
    const wraithOutnumbered = fullOutnumbered.find((player) => player.hero === "Wraith")!.seconds;
    assert.equal(outnumbered.secondsInWindow(wraith.hero_id, frames.tickAt(0)!, tick)!
      + outnumbered.secondsInWindow(wraith.hero_id, tick, frames.tickAt(frames.length - 1)!)!,
    wraithOutnumbered, "clipped outnumbered windows are not additive");
    console.log(`Heatmap: Wraith CBT ${combat.toFixed(2)}%, OUTN ${wraithOutnumbered.toFixed(1)}s; ` +
      `all 12 heroes verified; OUTN indexing ${(performance.now() - started).toFixed(1)}ms.`);
    assert(positions.objective_events.some((event) => event.kind === "patron"
      && event.tick === 169355 && event.action === "phase_one_destroyed"),
    "Patron's first-phase kill was reported as final destruction");
    const patronsAt = (tick: number) => objectivesAt(positions.objectives, positions.objective_health, tick)
      .find((objective) => objective.kind === "patron" && objective.team === 3);
    assert.equal(patronsAt(169361)?.phase, 2, "Patron vanished during transformation");
    assert.equal(patronsAt(182816)?.phase, 1, "second-phase Patron is missing");
    assert.equal(patronsAt(182816)?.health, 13350, "second-phase Patron health is wrong");
    assert.equal(patronsAt(185985), undefined, "Patron persists after its final death");
    const mina = positions.players.find((player) => player.hero_name === "Mina")!;
    const minaExact = (parser.playerDetails(182816, mina.steam_id) as PlayerDetails).status;
    assert.deepEqual(statuses.at(mina.steam_id, 182816), minaExact,
      "Mina's indexed status history differs from the exact tick query");
    assert(!minaExact?.states?.includes("BREAK_ICE_PATH"),
      "Mina has a stale Break Ice Path state at tick 182816");
    assert(statuses.at(mina.steam_id, 178465)?.states?.includes("BREAK_ICE_PATH"),
      "Mina's genuinely recorded Break Ice Path bit was silently suppressed");
    const minaHistory = statusHistory.players.find((player) => player.steam_id === mina.steam_id)!;
    for (const index of minaHistory.indices) {
      const states = statusHistory.values[index].states;
      if (states?.includes("BREAK_ICE_PATH")) {
        assert(states.includes("USING_ZIPLINE"), "Break Ice Path appeared outside Mina's recorded zipline state");
      }
    }
    assert(!positions.modifier_spans.some((span) => span.serial === 486
      && span.start_tick <= 73952 && (span.end_tick == null || span.end_tick > 73952)),
    "the removed zipline modifier reappeared from a table snapshot");
    // Upstream documents this parent as unresolved, not as a fixed lifetime.
    // Do not silently hide it or invent a local expiry.
    assert(positions.modifier_spans.some((span) => span.serial === 4604
      && span.start_tick <= 40441 && (span.end_tick == null || span.end_tick > 40441)),
    "the unresolved Grapple Arm parent was silently suppressed");
    assert(positions.modifier_spans.some((span) => span.serial === 4605
      && span.start_tick === 26134 && span.end_tick === 26169),
    "Grapple Arm's timed child did not end at its recorded removal");
    const urnEvents = positions.objective_events.filter((event) => event.kind === "urn");
    for (const [at, action, hero] of [
      [49642, "picked_up", 27], [51738, "returned", 27], [139996, "dropped", 7],
    ] as const) {
      assert(urnEvents.some((event) => event.tick === at && event.action === action
        && event.killer_hero_id === hero), `missing Urn ${action} at ${at}`);
    }
    const carrying = frames.nearest(49706)!;
    const carrier = carrying.players.find((player) => player.hero_id === 27)!;
    assert.equal(carrying.urns.length, 2, "carried Urn is missing or duplicated");
    assert(Math.abs(carrying.urns[0] - carrier.x) < 0.01
      && Math.abs(carrying.urns[1] - carrier.y) < 0.01, "Urn marker does not follow its recorded carrier");
    assert.equal(frames.nearest(51746)!.urns.length, 0, "Urn marker persists after return");
  }
  const player = positions.players.find((player) => player.hero_name === "Seven") ?? positions.players[0];
  const details = parser.playerDetails(tick, player.steam_id) as PlayerDetails;
  const pickup = pickups.at(player.steam_id, tick);
  assert(pickup, "missing selected player's pickup totals");
  for (const [stat, index] of [["bullet_resist", 1], ["spirit_resist", 4], ["fire_rate", 6], ["move_speed", 7], ["weapon_damage", 8]] as const) {
    const inputs = details.hero_stats.contributions.filter((row) => row.stat === stat && row.input === stat && row.source.startsWith("misc.vdata#/") && row.source.includes("_permanent_pickup"));
    if (!inputs.length) continue;
    const value = inputs.reduce((sum, row) => sum + row.value, 0);
    assert(Math.abs(value - pickup.values[index]) < 0.01, `${stat} pickup total differs from Boon's exact stat inputs: ${value} vs ${pickup.values[index]}`);
  }
  assert.equal(details.hero_stats.metadata.data_version, catalog.version);
  assert(details.hero_stats.values.some((row) => row.status === "calculated" && Number.isFinite(row.value)),
    "no calculated hero stats");
  assert(details.hero_stats.contributions.length > 0, "no hero stat breakdowns");
  assert(details.hero_stats.contributions.every((row) => row.stat && row.input && row.definition_path),
    "untagged hero stat contribution");
  assert(details.ability_stats.values.length > 0, "no ability stats");
  assert(details.ability_stats.contributions.length > 0, "no ability stat breakdowns");
  assert(Array.isArray(details.imbues.bindings), "missing imbue dataset");
  assert(Array.isArray(details.status?.states), "missing decoded player statuses");
  const frameDetails = parser.playerDetails(frame.tick, player.steam_id) as PlayerDetails;
  assert.deepEqual(statuses.at(player.steam_id, frame.tick), frameDetails.status,
    "pre-indexed statuses differ from the exact frame query");
  // A valid player can have no imbued items. Check another player when needed
  // so this replay also exercises actual bindings rather than only an empty list.
  let imbues = details.imbues.bindings;
  for (const candidate of positions.players) {
    if (imbues.length > 0) break;
    if (candidate.steam_id === player.steam_id) continue;
    imbues = (parser.playerDetails(tick, candidate.steam_id) as PlayerDetails).imbues.bindings;
  }
  assert(imbues.every((binding) => binding.item_id > 0 && binding.ability_id > 0),
    "imbue binding lacks an item or ability");
  console.log(`Passed: ${positions.players.length} players, ${frames.length} frames, ` +
    `${positions.breakable_events.length} breakables, ${positions.sinner_events.length} Sinner events; ` +
    `${player.hero_name}: ${details.hero_stats.values.length} hero stats, ` +
    `${details.ability_stats.values.length} ability stats, ${details.status.states.length} statuses; ` +
    `${imbues.length} imbues verified; checkpoints ${checkpointed ? "enabled" : "disabled"}.`);
  console.log(`Pickups: ${positions.permanent_buffs.length} sparse changes; ${player.hero_name}: ${JSON.stringify(pickup)}; ` +
    `${summary.healing_by_source.length} healing sources, ${summary.regen_by_source.length} regen sources; lane cutoff verified.`);
  console.log(`boon-data ${catalog.version}; demo build ${catalog.demoVersion ?? "unknown"}.`);
} finally {
  parser.free();
}
