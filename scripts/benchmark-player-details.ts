import assert from "node:assert/strict";
import { resolve } from "node:path";
import init, { DemoParser } from "../src/wasm/pkg/boon_wasm.js";
import { StatusStore, type StatusHistory } from "../src/wasm/statuses";
import type { PlayerDetails } from "../src/wasm/player-details";
import type { PlayerInfo } from "../src/components/player-roster";
import { selectBoonCatalog } from "../src/wasm/catalog";

const root = resolve(import.meta.dir, "..");
const wasm = await init({ module_or_path: await Bun.file(resolve(root, "src/wasm/pkg/boon_wasm_bg.wasm")).arrayBuffer() });
const parser = new DemoParser(new Uint8Array(await Bun.file(process.argv[2] ?? resolve(root, "111155916.dem")).arrayBuffer()));
const measure = <T>(label: string, run: () => T): T => {
  const start = performance.now();
  const result = run();
  console.log(`${label}: ${(performance.now() - start).toFixed(1)}ms`);
  return result;
};
// Hash-map iteration order is not significant, but every value, diagnostic,
// explanation and duplicate is. Sort arrays recursively for comparisons.
function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, canonical(val)]));
  return value;
}

try {
  const catalog = selectBoonCatalog(parser.fileHeader());
  const catalogs = await Promise.all(["heroes", "abilities", "modifiers", "misc"].map(async (name) => new Uint8Array(await Bun.file(resolve(root, "public/boon-data", catalog.version, `${name}.json`)).arrayBuffer())));
  parser.loadCatalog(catalogs[0], catalogs[1], catalogs[2], catalogs[3]);
  const positions = measure("map", () => parser.playerPositions(8, () => {})) as { players: PlayerInfo[]; frame_ticks: Int32Array };
  console.log(`WASM heap after map: ${(wasm.memory.buffer.byteLength / 1024 ** 2).toFixed(0)} MiB`);
  const history = measure("status indexing", () => parser.playerStatusHistory(positions.frame_ticks)) as StatusHistory;
  const statuses = new StatusStore(history);
  console.log(`status palette: ${history.values.length}; changes: ${history.players.reduce((n, p) => n + p.ticks.length, 0)}`);
  console.log(`WASM heap after statuses: ${(wasm.memory.buffer.byteLength / 1024 ** 2).toFixed(0)} MiB`);
  const queries = [
    ["Wraith", 139488], ["Seven", 73952], ["Mina", 40441], ["Mina", 26169], ["Wraith", 29320],
    ["Wraith", positions.frame_ticks[positions.frame_ticks.length - 1]],
  ] as const;
  const fresh = queries.map(([hero, target]) => {
    const steamId = positions.players.find((p) => p.hero_name === hero)!.steam_id;
    const tick = positions.frame_ticks.reduce((closest, candidate) => Math.abs(candidate - target) < Math.abs(closest - target) ? candidate : closest);
    const details = measure(`uncached ${hero} ${tick}`, () => parser.playerDetails(tick, steamId)) as PlayerDetails;
    assert.deepEqual(statuses.at(steamId, tick), details.status, `indexed status differs at ${tick}`);
    return { hero, tick, steamId, details };
  });
  assert(measure("checkpoint preparation", () => parser.prepareStats()), "stat replay checkpoints were not prepared; rebuild with bun run wasm");
  console.log(`WASM heap after preparation: ${(wasm.memory.buffer.byteLength / 1024 ** 2).toFixed(0)} MiB`);
  const preparedHeapSize = wasm.memory.buffer.byteLength;
  assert(measure("repeat preparation", () => parser.prepareStats()));
  assert.equal(wasm.memory.buffer.byteLength, preparedHeapSize, "repeated preparation grew the heap");
  for (const { hero, tick, steamId, details } of fresh) {
    const cached = measure(`checkpoint ${hero} ${tick}`, () => parser.playerDetails(tick, steamId));
    assert.deepEqual(canonical(cached), canonical(details), `checkpoint changed results at ${tick}`);
  }
  measure("10,000 status lookups", () => {
    for (let i = 0; i < 10000; i++) statuses.at(fresh[0].steamId, positions.frame_ticks[i % positions.frame_ticks.length]);
  });
  // Boon binds checkpoints to a catalog instance, even for identical bytes.
  parser.loadCatalog(catalogs[0], catalogs[1], catalogs[2], catalogs[3]);
  const query = fresh[0];
  const reloaded = measure("query after catalog reload", () => parser.playerDetails(query.tick, query.steamId));
  assert.deepEqual(canonical(reloaded), canonical(query.details), "catalog reload changed results or reused old checkpoints");
  console.log("Exact fresh/checkpoint results and indexed statuses match.");
} finally {
  parser.free();
}
