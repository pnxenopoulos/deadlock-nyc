import { expect, test } from "bun:test";
import { LatestQuery } from "./latest-query";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("only the newest queued query runs, with at most one active query", async () => {
  const queue = new LatestQuery<number>();
  const running = deferred<number>();
  const calls: string[] = [];
  const first = queue.query("first", () => { calls.push("first"); return running.promise; });
  const obsolete = queue.query("old", async () => { calls.push("old"); return 2; }).catch((error) => error);
  const last = queue.query("last", async () => { calls.push("last"); return 3; });
  await flush();
  expect(calls).toEqual(["first"]);
  expect(await obsolete).toHaveProperty("name", "AbortError");
  running.resolve(1);
  expect(await first).toBe(1);
  expect(await last).toBe(3);
  expect(calls).toEqual(["first", "last"]);
});

test("identical requests share work and subscribers can abort independently", async () => {
  const queue = new LatestQuery<number>();
  const running = deferred<number>();
  const controller = new AbortController();
  let calls = 0;
  const first = queue.query("same", () => { calls++; return running.promise; }, controller.signal).catch((error) => error);
  const second = queue.query("same", async () => 999);
  controller.abort();
  expect(await first).toHaveProperty("name", "AbortError");
  running.resolve(4);
  expect(await second).toBe(4);
  expect(calls).toBe(1);
});

test("aborted queued requests are never sent to the worker", async () => {
  const queue = new LatestQuery<number>();
  const running = deferred<number>();
  const first = queue.query("first", () => running.promise);
  const controller = new AbortController();
  const queued = queue.query("cancelled", async () => { throw new Error("must not run"); }, controller.signal).catch((error) => error);
  controller.abort();
  expect(await queued).toHaveProperty("name", "AbortError");
  running.resolve(1);
  await first;
});

test("worker failures release the queue for the next request", async () => {
  const queue = new LatestQuery<number>();
  const first = queue.query("fails", async () => { throw new Error("worker failed"); }).catch((error) => error);
  const next = queue.query("next", async () => 5);
  expect(await first).toHaveProperty("message", "worker failed");
  expect(await next).toBe(5);
});

test("returning to the active tick cancels a now-obsolete queued tick", async () => {
  const queue = new LatestQuery<number>();
  const running = deferred<number>();
  const first = queue.query("first", () => running.promise);
  const obsolete = queue.query("old", async () => { throw new Error("must not run"); }).catch((error) => error);
  const same = queue.query("first", async () => 999);
  expect(await obsolete).toHaveProperty("name", "AbortError");
  running.resolve(1);
  expect(await first).toBe(1);
  expect(await same).toBe(1);
});
