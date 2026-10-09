import { afterEach, beforeEach, expect, test } from "bun:test";
import { disposeDemo, parseDemo, parseDemoFile, requestPlayerDetails } from "./boon";
import { disposePlayerDetails, queryPlayerDetails, type PlayerDetails } from "./player-details";

class ReplayWorker {
  static instances: ReplayWorker[] = [];
  onmessage?: (event: MessageEvent) => void;
  onerror?: (event: { message: string }) => void;
  messages: { id: number; type: string }[] = [];
  terminated = false;
  constructor() { ReplayWorker.instances.push(this); }
  postMessage(message: { id: number; type: string }) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  reply(data: unknown) { this.onmessage?.(new MessageEvent("message", { data })); }
}

const originalWorker = globalThis.Worker;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
beforeEach(() => {
  ReplayWorker.instances = [];
  globalThis.Worker = ReplayWorker as unknown as typeof Worker;
  Object.defineProperty(globalThis, "document", { configurable: true, value: { baseURI: "https://example.com/" } });
});
afterEach(() => {
  disposePlayerDetails();
  disposeDemo();
  globalThis.Worker = originalWorker;
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

function details(value: number): PlayerDetails {
  return { hero_stats: { values: [{ stat: "clip_size", value, unit: "rounds", status: "calculated" }], contributions: [], metadata: { data_version: "test", source_commit: "test" } }, ability_stats: { values: [], contributions: [] }, imbues: { bindings: [] } };
}

function replyParsed(worker: ReplayWorker) {
  worker.reply({ id: worker.messages[0].id, ok: true, header: {}, catalog: { version: "6746", demoVersion: "6746" }, players: [], winner: null, summary: {}, checkpointed: true, statuses: { values: [], players: [] }, positions: {
    frame_ticks: new Int32Array([10]), frame_reg_ticks: new Int32Array([10]),
    player_offsets: new Uint32Array([0, 0]), player_i32: new Int32Array(), player_f32: new Float32Array(),
    player_i32_stride: 13, player_f32_stride: 7,
    trooper_offsets: new Uint32Array([0, 0]), troopers: new Int32Array(),
    urn_offsets: new Uint32Array([0, 0]), urns: new Float32Array(),
  } });
}

async function load(file: File) {
  const parsed = parseDemo(new Uint8Array(8), 8, undefined, file);
  const worker = ReplayWorker.instances.at(-1)!;
  replyParsed(worker);
  await parsed;
  return worker;
}

test("replacement releases the old worker before reading the new file", async () => {
  const file = new File([], "one.dem");
  const worker = await load(file);
  const detail = requestPlayerDetails(file, 10, "one").catch((error) => error);
  const replacement = new File([], "two.dem");
  let completeRead!: (bytes: ArrayBuffer) => void;
  Object.defineProperty(replacement, "arrayBuffer", { value: () => {
    expect(worker.terminated).toBe(true);
    return new Promise<ArrayBuffer>((resolve) => { completeRead = resolve; });
  } });
  const parsed = parseDemoFile(replacement, 8);
  expect(worker.terminated).toBe(true);
  expect(ReplayWorker.instances.length).toBe(1);
  expect(await detail).toHaveProperty("message", "Replay was closed");
  completeRead(new ArrayBuffer(8));
  await Promise.resolve();
  const nextWorker = ReplayWorker.instances.at(-1)!;
  expect(nextWorker).not.toBe(worker);
  replyParsed(nextWorker);
  await parsed;
});

test("a replacement file read failure does not retain or recreate a worker", async () => {
  const worker = await load(new File([], "one.dem"));
  const file = new File([], "broken.dem");
  Object.defineProperty(file, "arrayBuffer", { value: () => Promise.reject(new Error("read failed")) });
  await expect(parseDemoFile(file, 8)).rejects.toThrow("read failed");
  expect(worker.terminated).toBe(true);
  expect(ReplayWorker.instances.length).toBe(1);
});

test("map and details retain and reuse one worker until the demo is closed", async () => {
  const file = new File([], "one.dem");
  const worker = await load(file);
  expect(worker.terminated).toBe(false);
  const result = requestPlayerDetails(file, 10, "one");
  expect(worker.messages.at(-1)?.type).toBe("details");
  worker.reply({ id: worker.messages.at(-1)!.id, ok: true, details: details(1) });
  expect((await result).hero_stats.values[0].value).toBe(1);
  expect(ReplayWorker.instances.length).toBe(1);
  disposeDemo();
  expect(worker.terminated).toBe(true);
});

test("same tick/player cache entries never cross demo files", async () => {
  const firstFile = new File([], "one.dem");
  const firstWorker = await load(firstFile);
  const first = queryPlayerDetails(firstFile, 10, "one");
  await Promise.resolve();
  firstWorker.reply({ id: firstWorker.messages.at(-1)!.id, ok: true, details: details(1) });
  expect((await first).hero_stats.values[0].value).toBe(1);
  expect((await queryPlayerDetails(firstFile, 10, "one")).hero_stats.values[0].value).toBe(1);
  expect(firstWorker.messages.length).toBe(2);

  const secondFile = new File([], "two.dem");
  const secondWorker = await load(secondFile);
  const second = queryPlayerDetails(secondFile, 10, "one");
  await Promise.resolve();
  expect(secondWorker.messages.at(-1)?.type).toBe("details");
  secondWorker.reply({ id: secondWorker.messages.at(-1)!.id, ok: true, details: details(2) });
  expect((await second).hero_stats.values[0].value).toBe(2);
  expect(firstWorker.terminated).toBe(true);
});

test("worker failure rejects outstanding queries and releases the retained heap", async () => {
  const file = new File([], "one.dem");
  const worker = await load(file);
  const query = requestPlayerDetails(file, 10, "one").catch((error) => error);
  worker.onerror?.({ message: "worker crashed" });
  expect(await query).toHaveProperty("message", "worker crashed");
  expect(worker.terminated).toBe(true);
  expect(await requestPlayerDetails(file, 10, "one").catch((error) => error)).toHaveProperty("message", "This demo is not loaded");
});
