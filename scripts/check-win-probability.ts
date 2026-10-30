/** Verify browser feature tensors against Python reference snapshots (local files only). */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import init, { DemoParser } from "../src/wasm/pkg/boon_wasm.js";
import { selectBoonCatalog } from "../src/wasm/catalog";
import { encodeGraphs } from "../src/ml/features";
import type { Encoder, RawGraph } from "../src/ml/types";
const root = resolve(import.meta.dir, "..");
const fixture = resolve(
  process.argv[3] ?? "../deadlock-win-prob/.cache/nyc-integration",
);
const reference = await Bun.file(resolve(fixture, "reference.json")).json();
const roster = await Bun.file(resolve(fixture, "roster.json")).json();
await init({
  module_or_path: await Bun.file(
    resolve(root, "src/wasm/pkg/boon_wasm_bg.wasm"),
  ).arrayBuffer(),
});
const parser = new DemoParser(
  new Uint8Array(
    await Bun.file(
      resolve(process.argv[2] ?? "../deadlock-win-prob/111155916.dem"),
    ).arrayBuffer(),
  ),
);
const catalog = selectBoonCatalog(parser.fileHeader());
const catalogs = await Promise.all(
  ["heroes", "abilities", "modifiers", "misc"].map(
    async (name) =>
      new Uint8Array(
        await Bun.file(
          resolve(root, "public/boon-data", catalog.version, `${name}.json`),
        ).arrayBuffer(),
      ),
  ),
);
parser.loadCatalog(catalogs[0], catalogs[1], catalogs[2], catalogs[3]);
const parsed = parser.playerPositions(8, () => {}) as {
  players: { steam_id: string; team: number }[];
};
const viewerRoster = parsed.players.map(
  (p) => [p.steam_id, p.team] as [string, number],
);
for (const [steam, team] of roster)
  assert(
    viewerRoster.some((p) => p[0] === steam && p[1] === team),
    "viewer roster differs from training roster",
  );
console.time("Extract one-second snapshots");
const total = parser.prepareWinProbability(viewerRoster, () => {});
console.timeEnd("Extract one-second snapshots");
const selected: RawGraph[] = [],
  ticks: number[] = [];
for (let start = 0; start < total; start += 32) {
  const graphs = parser.winProbabilityBatch(
    start,
    Math.min(32, total - start),
  ) as RawGraph[];
  for (const graph of graphs) {
    ticks.push(graph.tick);
    if (reference.ticks.includes(graph.tick)) selected.push(graph);
  }
}
assert.deepEqual(
  ticks,
  reference.sampling_ticks,
  "one-second sampling or pause boundaries differ",
);
assert.equal(selected.length, reference.ticks.length);
for (const graph of selected) {
  graph.players.sort((a, b) => Number(a.hero_id) - Number(b.hero_id));
  graph.objectives.sort(
    (a, b) =>
      Number(a.entity_id) - Number(b.entity_id) ||
      Number(a.entity_serial) - Number(b.entity_serial),
  );
  graph.ziplines.sort((a, b) => Number(a.node_handle) - Number(b.node_handle));
}
const encoder = (await Bun.file(
  resolve(root, "public/models/win-probability/encoder.json"),
).json()) as Encoder;
const inputs = encodeGraphs(selected, encoder);
await Bun.write(
  resolve(fixture, "browser-graphs.json"),
  JSON.stringify(selected),
);
let maxError = 0;
for (const [name, input] of Object.entries(inputs)) {
  const expected = reference.inputs[name];
  assert.deepEqual(input.dims, expected.shape, `shape: ${name}`);
  let failures = 0;
  for (let i = 0; i < input.data.length; i++) {
    const value = Number(input.data[i]),
      error = Math.abs(value - Number(expected.data[i]));
    maxError = Math.max(maxError, error);
    const tolerance = input.type === "float32" ? 2e-5 : 0;
    if (error > tolerance || !Number.isFinite(error)) {
      if (failures++ < 8)
        console.error(name, i, {
          actual: value,
          expected: expected.data[i],
          error,
        });
    }
  }
  assert.equal(failures, 0, `feature mismatch: ${name}`);
}
await Bun.write(
  resolve(fixture, "browser-graphs.json"),
  JSON.stringify(selected),
);
console.log(
  JSON.stringify({
    total,
    ticks: selected.map((g) => g.tick),
    maxFeatureError: maxError,
  }),
);
parser.clearWinProbability();
parser.free();
