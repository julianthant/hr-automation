import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runWorkerPool } from "../../src/utils/worker-pool.js";

describe("runWorkerPool", () => {
  it("processes all items across workers", async () => {
    const processed: number[] = [];
    await runWorkerPool({
      items: [1, 2, 3, 4, 5],
      workerCount: 2,
      setup: async () => ({}),
      process: async (item) => { processed.push(item); },
    });
    assert.deepEqual(processed.sort(), [1, 2, 3, 4, 5]);
  });

  it("stops worker after maxConsecutiveErrors", async () => {
    let attempts = 0;
    await runWorkerPool({
      items: [1, 2, 3, 4, 5],
      workerCount: 1,
      maxConsecutiveErrors: 2,
      setup: async () => ({}),
      process: async () => { attempts++; throw new Error("fail"); },
    });
    assert.equal(attempts, 2);
  });

  it("resets error count on success", async () => {
    const results: number[] = [];
    await runWorkerPool({
      items: [1, 2, 3, 4],
      workerCount: 1,
      maxConsecutiveErrors: 2,
      setup: async () => ({}),
      process: async (item) => {
        results.push(item);
        if (item === 2) throw new Error("fail");
      },
    });
    assert.deepEqual(results, [1, 2, 3, 4]);
  });

  it("calls teardown for each worker", async () => {
    const tornDown: number[] = [];
    await runWorkerPool({
      items: [1, 2],
      workerCount: 2,
      setup: async (id) => ({ id }),
      process: async () => {},
      teardown: async (ctx) => { tornDown.push(ctx.id); },
    });
    assert.equal(tornDown.length, 2);
  });
});
