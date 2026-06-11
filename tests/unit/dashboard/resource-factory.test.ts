import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createCachedResource,
  createPolledResource,
} from "../../../src/dashboard/components/hooks/resource-factory.js";

/**
 * The React-hook surface (`useResource`) needs a DOM harness, which the
 * dashboard doesn't have yet. These tests exercise the non-hook machinery the
 * factories expose — `refresh`, `prefetch`, `peek`, the equals dedup, and the
 * fetch-once/refresh lifecycle — which is where the shared-singleton logic
 * lives.
 */

describe("createPolledResource", () => {
  it("seeds peek() with the initial value", () => {
    const resource = createPolledResource<number>({
      fetcher: () => 1,
      intervalMs: 1000,
      initial: 7,
    });
    assert.equal(resource.peek(), 7);
  });

  it("refresh() updates the cache from the fetcher", async () => {
    let value = 10;
    const resource = createPolledResource<number>({
      fetcher: () => value,
      intervalMs: 1000,
      initial: 0,
    });
    resource.refresh();
    await flush();
    assert.equal(resource.peek(), 10);
    value = 20;
    resource.refresh();
    await flush();
    assert.equal(resource.peek(), 20);
  });

  it("drops a fetch that equals the cache (no churn)", async () => {
    let calls = 0;
    const resource = createPolledResource<{ n: number }>({
      fetcher: () => ({ n: 5 }),
      intervalMs: 1000,
      initial: { n: 0 },
      equals: (a, b) => a.n === b.n,
    });
    resource.refresh();
    await flush();
    const first = resource.peek();
    calls += 1;
    resource.refresh();
    await flush();
    // A new object with the same `n` is equal → cache identity is preserved.
    assert.strictEqual(resource.peek(), first);
    assert.equal(calls, 1);
  });

  it("retains the last value when the fetcher throws", async () => {
    let shouldThrow = false;
    const resource = createPolledResource<number>({
      fetcher: () => {
        if (shouldThrow) throw new Error("boom");
        return 42;
      },
      intervalMs: 1000,
      initial: 0,
    });
    resource.refresh();
    await flush();
    assert.equal(resource.peek(), 42);
    shouldThrow = true;
    resource.refresh();
    await flush();
    assert.equal(resource.peek(), 42); // unchanged
  });
});

describe("createCachedResource", () => {
  it("starts null, fetches once, and serves the value via peek()", async () => {
    let calls = 0;
    const resource = createCachedResource<string[]>({
      fetcher: async () => {
        calls += 1;
        return ["a", "b"];
      },
      fallback: [],
    });
    assert.equal(resource.peek(), null);
    resource.prefetch();
    await flush();
    assert.deepEqual(resource.peek(), ["a", "b"]);
    // prefetch is idempotent — a second prefetch with a primed cache no-ops.
    resource.prefetch();
    await flush();
    assert.equal(calls, 1);
  });

  it("refresh() forces a refetch even when primed", async () => {
    let payload = ["one"];
    const resource = createCachedResource<string[]>({
      fetcher: async () => payload,
      fallback: [],
    });
    resource.prefetch();
    await flush();
    assert.deepEqual(resource.peek(), ["one"]);
    payload = ["two"];
    resource.refresh();
    await flush();
    assert.deepEqual(resource.peek(), ["two"]);
  });

  it("settles to the fallback when the fetch rejects", async () => {
    const resource = createCachedResource<string[]>({
      fetcher: async () => {
        throw new Error("network down");
      },
      fallback: [],
    });
    resource.prefetch();
    await flush();
    assert.deepEqual(resource.peek(), []);
  });
});

/** Let queued microtasks (the fetch promise chains) settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
