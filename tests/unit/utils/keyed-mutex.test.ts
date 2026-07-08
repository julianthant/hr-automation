/**
 * Unit tests for src/utils/keyed-mutex.ts — the in-process per-key async lock
 * behind the enqueue-with-supersede serialization (enqueue-dispatch.ts).
 */
import { test } from "vitest";
import assert from "node:assert/strict";

import { KeyedMutex } from "../../../src/utils/keyed-mutex.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("runExclusive serializes callers sharing a key (no interleaving)", async () => {
  const mutex = new KeyedMutex();
  const events: string[] = [];
  const gate = deferred();

  const first = mutex.runExclusive("k", async () => {
    events.push("first:start");
    await gate.promise;
    events.push("first:end");
  });
  const second = mutex.runExclusive("k", () => {
    events.push("second:start");
    events.push("second:end");
  });

  // Give the second caller every chance to start early (it must not).
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events, ["first:start"]);

  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("different keys never contend", async () => {
  const mutex = new KeyedMutex();
  const events: string[] = [];
  const gate = deferred();

  const a = mutex.runExclusive("a", async () => {
    events.push("a:start");
    await gate.promise;
    events.push("a:end");
  });
  const b = mutex.runExclusive("b", () => {
    events.push("b:start");
  });

  await b; // must complete while "a" still holds its own key's lock
  assert.deepEqual(events, ["a:start", "b:start"]);
  gate.resolve();
  await a;
});

test("a throwing holder releases the lock and the rejection reaches its own caller only", async () => {
  const mutex = new KeyedMutex();
  await assert.rejects(
    mutex.runExclusive("k", () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  // The next caller on the same key runs normally.
  const result = await mutex.runExclusive("k", () => "ok");
  assert.equal(result, "ok");
});

test("returns the callback's resolved value", async () => {
  const mutex = new KeyedMutex();
  assert.equal(await mutex.runExclusive("k", () => 42), 42);
});
