import { loadReplay } from "./load-replay";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { disposeDemo, parseDemo, parseDemoFile, requestPlayerDetails, requestWinProbability } from "./boon";
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
  const parsed = parseDemo(new Uint8Array(8), 8, undefined, file, { modifiers: true, winProbability: true });
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


test("probability failures and cancellation do not unload the replay worker", async () => {
  const file = new File([], "probability.dem");
  const worker = await load(file);
  const controller = new AbortController();
  const cancelled = requestWinProbability(file, () => {}, controller.signal).catch(e => e);
  const id = worker.messages.at(-1)!.id;
  controller.abort();
  expect(await cancelled).toHaveProperty("name", "AbortError");
  expect(worker.messages.at(-1)!.type).toBe("cancel-probability");
  worker.reply({id, probabilityProgress:{phase:"stale",completed:1,total:1}});
  const failure = requestWinProbability(file, () => {}, new AbortController().signal).catch(e => e);
  worker.reply({id:worker.messages.at(-1)!.id,ok:false,error:"model unavailable"});
  expect(await failure).toHaveProperty("message","model unavailable");
  expect(worker.terminated).toBe(false);
  const detail = requestPlayerDetails(file,10,"one");
  worker.reply({id:worker.messages.at(-1)!.id,ok:true,details:details(7)});
  expect((await detail).hero_stats.values[0].value).toBe(7);
});

test("completed probabilities cache for only their demo and pending work rejects on close", async () => {
  const file = new File([], "probability.dem");
  const worker = await load(file);
  const result = {modelVersion:"model-test",points:[{tick:10,seconds:1,archmother:.7}]};
  const request = requestWinProbability(file, () => {}, new AbortController().signal);
  worker.reply({id:worker.messages.at(-1)!.id,ok:true,probabilities:result});
  expect(await request).toEqual(result);
  const count=worker.messages.length;
  expect(await requestWinProbability(file, () => {}, new AbortController().signal)).toEqual(result);
  expect(worker.messages.length).toBe(count);
  const other = new File([], "other.dem");
  const next = await load(other);
  const pending = requestWinProbability(other, () => {}, new AbortController().signal).catch(e => e);
  expect(next.messages.at(-1)!.type).toBe("win-probability");
  disposeDemo();
  expect(await pending).toHaveProperty("message","Replay was closed");
});


test("loading waits for complete predictions before exposing the parsed replay", async () => {
  const phases: string[] = [];
  let finished = false;
  const loading = loadReplay(new File([], "loading.dem"), 8, (p) => phases.push(p.phase), new AbortController().signal, { modifiers: true, winProbability: true });
  void loading.then(() => { finished = true; }, () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  const worker = ReplayWorker.instances.at(-1)!;
  worker.reply({ id: worker.messages[0].id, progress: true, tick: 4, total: 10 });
  replyParsed(worker);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(finished).toBe(false);
  expect(worker.messages.at(-1)!.type).toBe("win-probability");
  const id = worker.messages.at(-1)!.id;
  worker.reply({ id, probabilityProgress: { phase: "Computing win probabilities", completed: 1, total: 2 } });
  expect(phases).toEqual(["Parsing replay", "Computing win probabilities"]);
  expect(finished).toBe(false);
  const probabilities = { modelVersion: "test", backend: "wasm" as const, points: [{ tick: 10, seconds: 1, archmother: 0.7 }] };
  worker.reply({ id, ok: true, probabilities });
  const result = await loading;
  expect(result.probability).toEqual({ ...probabilities, enabled: true, progress: null });
  expect(result.parsed.positions.frames.length).toBe(1);
  expect(ReplayWorker.instances.length).toBe(1);
});

test("an unavailable model preserves the parsed replay for viewing and retry", async () => {
  const file = new File([], "offline-model.dem");
  const loading = loadReplay(file, 8, () => {}, new AbortController().signal, { modifiers: true, winProbability: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const worker = ReplayWorker.instances.at(-1)!;
  replyParsed(worker);
  await new Promise((resolve) => setTimeout(resolve, 0));
  worker.reply({ id: worker.messages.at(-1)!.id, ok: false, error: "model unavailable" });
  const result = await loading;
  expect(result.probability.error).toBe("model unavailable");
  expect(result.parsed.positions.frames.length).toBe(1);
  expect(worker.terminated).toBe(false);
});

test("cancelled loading does not become a successful replay with a model error", async () => {
  const controller = new AbortController();
  const loading = loadReplay(new File([], "cancelled.dem"), 8, () => {}, controller.signal, { modifiers: true, winProbability: true }).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const worker = ReplayWorker.instances.at(-1)!;
  replyParsed(worker);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  expect(await loading).toHaveProperty("name", "AbortError");
  expect(worker.messages.at(-1)!.type).toBe("cancel-probability");
});

test("cancelling a pending file read does not create a late replay worker", async () => {
  const controller = new AbortController();
  const file = new File([], "reading.dem");
  let finishRead!: (bytes: ArrayBuffer) => void;
  Object.defineProperty(file, "arrayBuffer", { value: () => new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; }) });
  const loading = loadReplay(file, 8, () => {}, controller.signal, { modifiers: true, winProbability: true }).catch((error) => error);
  controller.abort();
  finishRead(new ArrayBuffer(8));
  expect(await loading).toHaveProperty("name", "AbortError");
  expect(ReplayWorker.instances.length).toBe(0);
});


test("loading defaults skip inference and prevent accidental modifier/stat queries", async () => {
  const file = new File([], "basic.dem");
  const loading = loadReplay(file, 8, () => {}, new AbortController().signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const worker = ReplayWorker.instances.at(-1)!;
  expect(worker.messages[0]).toHaveProperty("modifiers", false);
  replyParsed(worker);
  const result = await loading;
  expect(result.probability.enabled).toBe(false);
  expect(worker.messages.map((m) => m.type)).toEqual(["parse"]);
  await expect(requestWinProbability(file, () => {}, new AbortController().signal)).rejects.toThrow("reparse");
  await expect(requestPlayerDetails(file, 10, "one")).rejects.toThrow("reparse");
  expect(worker.messages.length).toBe(1);
});

test("modifiers can be loaded without requesting a model", async () => {
  const loading = loadReplay(new File([], "modifiers.dem"), 8, () => {}, new AbortController().signal, { modifiers: true, winProbability: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const worker = ReplayWorker.instances.at(-1)!;
  expect(worker.messages[0]).toHaveProperty("modifiers", true);
  replyParsed(worker);
  expect((await loading).probability.enabled).toBe(false);
  expect(worker.messages.map((m) => m.type)).toEqual(["parse"]);
});

test("win probability can be loaded independently of statuses/modifiers", async () => {
  const loading = loadReplay(new File([], "predictions.dem"), 8, () => {}, new AbortController().signal, { modifiers: false, winProbability: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const worker = ReplayWorker.instances.at(-1)!;
  expect(worker.messages[0]).toHaveProperty("modifiers", false);
  replyParsed(worker);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(worker.messages.at(-1)?.type).toBe("win-probability");
  worker.reply({ id: worker.messages.at(-1)!.id, ok: true, probabilities: { modelVersion: "test", points: [] } });
  expect((await loading).probability.enabled).toBe(true);
});
