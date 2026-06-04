import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  MAX_PARALLEL_WORKERS,
  MIN_PARALLEL_WORKERS,
  normalizeRunOptions,
  parseParallelWorkers,
  runOptionsToDaemonFlags,
  serializeRunOptionsForData,
} from "../../../src/domain/run-options.js";

describe("parseParallelWorkers", () => {
  it("treats missing / null as Auto (undefined)", () => {
    assert.equal(parseParallelWorkers(undefined), undefined);
    assert.equal(parseParallelWorkers(null), undefined);
  });

  it("treats empty / 'auto' (any case, trimmed) as Auto", () => {
    assert.equal(parseParallelWorkers(""), undefined);
    assert.equal(parseParallelWorkers("  "), undefined);
    assert.equal(parseParallelWorkers("auto"), undefined);
    assert.equal(parseParallelWorkers("AUTO"), undefined);
    assert.equal(parseParallelWorkers(" Auto "), undefined);
  });

  it("parses a numeric string in range", () => {
    assert.equal(parseParallelWorkers("4"), 4);
    assert.equal(parseParallelWorkers(" 6 "), 6);
  });

  it("parses a number in range", () => {
    assert.equal(parseParallelWorkers(1), 1);
    assert.equal(parseParallelWorkers(8), 8);
  });

  it("accepts the documented min and max boundaries", () => {
    assert.equal(parseParallelWorkers(MIN_PARALLEL_WORKERS), MIN_PARALLEL_WORKERS);
    assert.equal(parseParallelWorkers(MAX_PARALLEL_WORKERS), MAX_PARALLEL_WORKERS);
  });

  it("throws on zero, negative, and out-of-range explicit values", () => {
    assert.throws(() => parseParallelWorkers(0), /not a valid worker count/);
    assert.throws(() => parseParallelWorkers(-1), /not a valid worker count/);
    assert.throws(() => parseParallelWorkers("0"), /not a valid worker count/);
    assert.throws(() => parseParallelWorkers(MAX_PARALLEL_WORKERS + 1), /not a valid worker count/);
    assert.throws(() => parseParallelWorkers("99"), /not a valid worker count/);
  });

  it("throws on non-integers and non-numeric junk (no permissive coercion)", () => {
    assert.throws(() => parseParallelWorkers(4.5), /not a valid worker count/);
    assert.throws(() => parseParallelWorkers("4.5"), /not a valid worker count/);
    assert.throws(() => parseParallelWorkers("1e2"), /not a valid worker count/);
    assert.throws(() => parseParallelWorkers("0x4"), /not a valid worker count/);
    assert.throws(() => parseParallelWorkers("4 workers"), /not a valid worker count/);
    assert.throws(() => parseParallelWorkers("banana"), /not a valid worker count/);
    assert.throws(() => parseParallelWorkers(NaN), /not a valid worker count/);
    assert.throws(() => parseParallelWorkers({}), /not a valid worker count/);
    assert.throws(() => parseParallelWorkers(true), /not a valid worker count/);
  });
});

describe("normalizeRunOptions", () => {
  it("returns {} for undefined input and for Auto", () => {
    assert.deepEqual(normalizeRunOptions(undefined), {});
    assert.deepEqual(normalizeRunOptions({}), {});
    assert.deepEqual(normalizeRunOptions({ parallelWorkers: "auto" }), {});
    assert.deepEqual(normalizeRunOptions({ parallelWorkers: undefined }), {});
  });

  it("carries a valid explicit count", () => {
    assert.deepEqual(normalizeRunOptions({ parallelWorkers: 4 }), { parallelWorkers: 4 });
    assert.deepEqual(normalizeRunOptions({ parallelWorkers: "2" }), { parallelWorkers: 2 });
  });

  it("throws on an explicit invalid count", () => {
    assert.throws(() => normalizeRunOptions({ parallelWorkers: 0 }), /not a valid worker count/);
    assert.throws(() => normalizeRunOptions({ parallelWorkers: "20" }), /not a valid worker count/);
  });
});

describe("runOptionsToDaemonFlags", () => {
  it("returns {} for undefined, Auto, and an explicit 1", () => {
    assert.deepEqual(runOptionsToDaemonFlags(undefined), {});
    assert.deepEqual(runOptionsToDaemonFlags({}), {});
    assert.deepEqual(runOptionsToDaemonFlags({ parallelWorkers: 1 }), {});
  });

  it("returns { parallel: N } only for N > 1", () => {
    assert.deepEqual(runOptionsToDaemonFlags({ parallelWorkers: 2 }), { parallel: 2 });
    assert.deepEqual(runOptionsToDaemonFlags({ parallelWorkers: 4 }), { parallel: 4 });
    assert.deepEqual(runOptionsToDaemonFlags({ parallelWorkers: 8 }), { parallel: 8 });
  });
});

describe("serializeRunOptionsForData", () => {
  it("returns {} for undefined and Auto", () => {
    assert.deepEqual(serializeRunOptionsForData(undefined), {});
    assert.deepEqual(serializeRunOptionsForData({}), {});
  });

  it("emits a string-valued worker count for any explicit value, including 1", () => {
    assert.deepEqual(serializeRunOptionsForData({ parallelWorkers: 1 }), { parallelWorkers: "1" });
    assert.deepEqual(serializeRunOptionsForData({ parallelWorkers: 4 }), { parallelWorkers: "4" });
  });

  it("round-trips through parseParallelWorkers", () => {
    const serialized = serializeRunOptionsForData({ parallelWorkers: 6 });
    assert.equal(parseParallelWorkers(serialized.parallelWorkers), 6);
  });
});
