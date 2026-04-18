import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  stepCacheGet,
  stepCacheSet,
  stepCacheClear,
  pruneOldStepCache,
  DEFAULT_STEP_CACHE_DIR,
} from "../../../src/core/index.js";

const TEST_DIR = ".tracker-step-cache-test";

function itemDir(workflow: string, itemId: string): string {
  return join(TEST_DIR, `${workflow}-${itemId}`);
}

function recordPath(workflow: string, itemId: string, stepName: string): string {
  return join(itemDir(workflow, itemId), `${stepName}.json`);
}

/** Write a step-cache JSON directly (bypassing stepCacheSet) so we can seed
 *  stale timestamps, corrupt content, etc. */
function writeRaw(
  workflow: string,
  itemId: string,
  stepName: string,
  content: unknown,
): string {
  const dir = itemDir(workflow, itemId);
  mkdirSync(dir, { recursive: true });
  const path = recordPath(workflow, itemId, stepName);
  writeFileSync(
    path,
    typeof content === "string" ? content : JSON.stringify(content),
  );
  return path;
}

/** Backdate a file's mtime by `msAgo` ms. Both atime + mtime are updated so
 *  pruneOldStepCache (which reads mtime) sees the file as old. */
function backdate(path: string, msAgo: number): void {
  const t = (Date.now() - msAgo) / 1000;
  utimesSync(path, t, t);
}

describe("stepCacheGet / stepCacheSet round-trip", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("returns null on missing file", () => {
    assert.equal(
      stepCacheGet("onboarding", "test@x.edu", "extraction", { dir: TEST_DIR }),
      null,
    );
  });

  it("returns null when the step-cache directory does not exist", () => {
    const missing = join(TEST_DIR, "nope-" + Date.now());
    assert.equal(
      stepCacheGet("onboarding", "test@x.edu", "extraction", { dir: missing }),
      null,
    );
  });

  it("stores and retrieves a value within the default TTL", () => {
    const value = { firstName: "Jane", ssn: "123456789" };
    stepCacheSet("onboarding", "test@x.edu", "extraction", value, { dir: TEST_DIR });
    const got = stepCacheGet<typeof value>(
      "onboarding",
      "test@x.edu",
      "extraction",
      { dir: TEST_DIR },
    );
    assert.deepEqual(got, value);
  });

  it("creates the directory tree on set", () => {
    stepCacheSet("onboarding", "test@x.edu", "extraction", { x: 1 }, { dir: TEST_DIR });
    assert.ok(existsSync(recordPath("onboarding", "test@x.edu", "extraction")));
  });

  it("separates distinct (workflow, itemId, stepName) tuples", () => {
    stepCacheSet("onboarding", "a@x.edu", "extraction", { v: 1 }, { dir: TEST_DIR });
    stepCacheSet("onboarding", "b@x.edu", "extraction", { v: 2 }, { dir: TEST_DIR });
    stepCacheSet("onboarding", "a@x.edu", "person-search", { v: 3 }, { dir: TEST_DIR });
    assert.deepEqual(
      stepCacheGet("onboarding", "a@x.edu", "extraction", { dir: TEST_DIR }),
      { v: 1 },
    );
    assert.deepEqual(
      stepCacheGet("onboarding", "b@x.edu", "extraction", { dir: TEST_DIR }),
      { v: 2 },
    );
    assert.deepEqual(
      stepCacheGet("onboarding", "a@x.edu", "person-search", { dir: TEST_DIR }),
      { v: 3 },
    );
  });

  it("overwrites prior cached value (last-writer-wins)", () => {
    stepCacheSet("onboarding", "a@x.edu", "extraction", { v: 1 }, { dir: TEST_DIR });
    stepCacheSet("onboarding", "a@x.edu", "extraction", { v: 2 }, { dir: TEST_DIR });
    assert.deepEqual(
      stepCacheGet("onboarding", "a@x.edu", "extraction", { dir: TEST_DIR }),
      { v: 2 },
    );
  });
});

describe("stepCacheGet — TTL", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("returns null outside the default TTL (stale record)", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    writeRaw("onboarding", "a@x.edu", "extraction", {
      workflow: "onboarding",
      itemId: "a@x.edu",
      stepName: "extraction",
      ts: threeHoursAgo,
      value: { v: 1 },
    });
    // Default is 2h — 3h-old record should miss.
    assert.equal(
      stepCacheGet("onboarding", "a@x.edu", "extraction", { dir: TEST_DIR }),
      null,
    );
  });

  it("honors a custom withinHours wider than the record age", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    writeRaw("onboarding", "a@x.edu", "extraction", {
      workflow: "onboarding",
      itemId: "a@x.edu",
      stepName: "extraction",
      ts: threeHoursAgo,
      value: { v: 1 },
    });
    assert.deepEqual(
      stepCacheGet("onboarding", "a@x.edu", "extraction", {
        dir: TEST_DIR,
        withinHours: 24,
      }),
      { v: 1 },
    );
  });

  it("disables the TTL check when withinHours is 0", () => {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    writeRaw("onboarding", "a@x.edu", "extraction", {
      workflow: "onboarding",
      itemId: "a@x.edu",
      stepName: "extraction",
      ts: weekAgo,
      value: { v: 1 },
    });
    assert.deepEqual(
      stepCacheGet("onboarding", "a@x.edu", "extraction", {
        dir: TEST_DIR,
        withinHours: 0,
      }),
      { v: 1 },
    );
  });
});

describe("stepCacheGet — resilience", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("returns null on corrupt JSON content", () => {
    writeRaw("onboarding", "a@x.edu", "extraction", "{not-json-at-all");
    assert.equal(
      stepCacheGet("onboarding", "a@x.edu", "extraction", { dir: TEST_DIR }),
      null,
    );
  });

  it("returns null when the record has no ts field", () => {
    writeRaw("onboarding", "a@x.edu", "extraction", { value: { v: 1 } });
    assert.equal(
      stepCacheGet("onboarding", "a@x.edu", "extraction", { dir: TEST_DIR }),
      null,
    );
  });

  it("returns null when the record has an unparseable ts", () => {
    writeRaw("onboarding", "a@x.edu", "extraction", {
      workflow: "onboarding",
      itemId: "a@x.edu",
      stepName: "extraction",
      ts: "not-a-date",
      value: { v: 1 },
    });
    assert.equal(
      stepCacheGet("onboarding", "a@x.edu", "extraction", { dir: TEST_DIR }),
      null,
    );
  });
});

describe("stepCacheSet — path-segment safety", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  const unsafeItemIds: Array<[string, string]> = [
    ["forward slash", "foo/bar"],
    ["backslash", "foo\\bar"],
    ["NUL byte", "foo\0bar"],
    ["ASCII control char", "foo\x01bar"],
    ["dot", "."],
    ["double dot", ".."],
    ["relative path segment", "a/../b"],
    ["empty string", ""],
  ];

  for (const [label, itemId] of unsafeItemIds) {
    it(`throws on unsafe itemId: ${label}`, () => {
      assert.throws(
        () => stepCacheSet("onboarding", itemId, "extraction", { v: 1 }, { dir: TEST_DIR }),
        /step-cache/,
      );
    });
  }

  for (const [label, workflow] of unsafeItemIds) {
    it(`throws on unsafe workflow: ${label}`, () => {
      assert.throws(
        () => stepCacheSet(workflow, "test@x.edu", "extraction", { v: 1 }, { dir: TEST_DIR }),
        /step-cache/,
      );
    });
  }

  for (const [label, stepName] of unsafeItemIds) {
    it(`throws on unsafe stepName: ${label}`, () => {
      assert.throws(
        () => stepCacheSet("onboarding", "test@x.edu", stepName, { v: 1 }, { dir: TEST_DIR }),
        /step-cache/,
      );
    });
  }

  it("accepts common safe itemIds (email, emplId, docId)", () => {
    const safe = ["test@ucsd.edu", "12345", "99999", "user+tag@example.com"];
    for (const id of safe) {
      assert.doesNotThrow(() =>
        stepCacheSet("onboarding", id, "extraction", { v: 1 }, { dir: TEST_DIR }),
      );
    }
  });
});

describe("stepCacheSet — non-serializable values throw", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("throws on circular references", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    assert.throws(
      () => stepCacheSet("onboarding", "a@x.edu", "extraction", obj, { dir: TEST_DIR }),
      /circular|JSON/i,
    );
  });

  it("throws on BigInt values", () => {
    assert.throws(
      () =>
        stepCacheSet(
          "onboarding",
          "a@x.edu",
          "extraction",
          { n: 1n },
          { dir: TEST_DIR },
        ),
      /BigInt|JSON/i,
    );
  });
});

describe("stepCacheClear", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("removes a single step file when stepName is provided", () => {
    stepCacheSet("onboarding", "a@x.edu", "extraction", { v: 1 }, { dir: TEST_DIR });
    stepCacheSet("onboarding", "a@x.edu", "person-search", { v: 2 }, { dir: TEST_DIR });

    stepCacheClear("onboarding", "a@x.edu", "extraction", TEST_DIR);

    assert.equal(
      stepCacheGet("onboarding", "a@x.edu", "extraction", { dir: TEST_DIR }),
      null,
    );
    // Sibling step still present.
    assert.deepEqual(
      stepCacheGet("onboarding", "a@x.edu", "person-search", { dir: TEST_DIR }),
      { v: 2 },
    );
  });

  it("removes the entire item directory when stepName is omitted", () => {
    stepCacheSet("onboarding", "a@x.edu", "extraction", { v: 1 }, { dir: TEST_DIR });
    stepCacheSet("onboarding", "a@x.edu", "person-search", { v: 2 }, { dir: TEST_DIR });

    stepCacheClear("onboarding", "a@x.edu", undefined, TEST_DIR);

    assert.ok(!existsSync(itemDir("onboarding", "a@x.edu")));
  });

  it("is silent when the target does not exist", () => {
    // No setup — nothing was ever set.
    assert.doesNotThrow(() =>
      stepCacheClear("onboarding", "nobody@x.edu", "extraction", TEST_DIR),
    );
    assert.doesNotThrow(() =>
      stepCacheClear("onboarding", "nobody@x.edu", undefined, TEST_DIR),
    );
  });
});

describe("stepCacheClear — path-segment safety", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("throws on unsafe workflow", () => {
    assert.throws(
      () => stepCacheClear("../../hack", "test@x.edu", "extraction", TEST_DIR),
      /step-cache/,
    );
  });

  it("throws on unsafe itemId", () => {
    assert.throws(
      () => stepCacheClear("onboarding", "foo/bar", "extraction", TEST_DIR),
      /step-cache/,
    );
  });

  it("throws on unsafe stepName (when provided)", () => {
    assert.throws(
      () => stepCacheClear("onboarding", "test@x.edu", "../../escape", TEST_DIR),
      /step-cache/,
    );
  });

  it("does NOT throw when stepName is omitted AND workflow+itemId are safe", () => {
    // No throw, no-op on missing item dir.
    assert.doesNotThrow(() =>
      stepCacheClear("onboarding", "nobody@x.edu", undefined, TEST_DIR),
    );
  });
});

describe("pruneOldStepCache", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("removes files older than maxAgeHours and keeps fresh ones", () => {
    stepCacheSet("onboarding", "fresh@x.edu", "extraction", { v: 1 }, { dir: TEST_DIR });
    stepCacheSet("onboarding", "stale@x.edu", "extraction", { v: 2 }, { dir: TEST_DIR });
    // Backdate the stale record's file mtime by 10 days.
    backdate(recordPath("onboarding", "stale@x.edu", "extraction"), 10 * 24 * 60 * 60 * 1000);

    const removed = pruneOldStepCache(168 /* 7 days */, TEST_DIR);

    assert.equal(removed, 1);
    // Fresh file still there.
    assert.ok(existsSync(recordPath("onboarding", "fresh@x.edu", "extraction")));
    // Stale file gone AND its empty item dir removed.
    assert.ok(!existsSync(itemDir("onboarding", "stale@x.edu")));
  });

  it("uses a default of 168h (7 days) when maxAgeHours is omitted", () => {
    stepCacheSet("onboarding", "day5@x.edu", "extraction", { v: 1 }, { dir: TEST_DIR });
    stepCacheSet("onboarding", "day10@x.edu", "extraction", { v: 2 }, { dir: TEST_DIR });
    backdate(recordPath("onboarding", "day5@x.edu", "extraction"), 5 * 24 * 60 * 60 * 1000);
    backdate(recordPath("onboarding", "day10@x.edu", "extraction"), 10 * 24 * 60 * 60 * 1000);

    const removed = pruneOldStepCache(undefined, TEST_DIR);

    assert.equal(removed, 1, "only the 10-day-old file should be pruned at default 168h");
    assert.ok(existsSync(recordPath("onboarding", "day5@x.edu", "extraction")));
    assert.ok(!existsSync(itemDir("onboarding", "day10@x.edu")));
  });

  it("returns 0 when the dir does not exist", () => {
    const missing = join(TEST_DIR, "nope-" + Date.now());
    assert.equal(pruneOldStepCache(168, missing), 0);
  });

  it("leaves item dirs that still contain fresh files", () => {
    stepCacheSet("onboarding", "mixed@x.edu", "extraction", { v: 1 }, { dir: TEST_DIR });
    stepCacheSet("onboarding", "mixed@x.edu", "person-search", { v: 2 }, { dir: TEST_DIR });
    backdate(recordPath("onboarding", "mixed@x.edu", "extraction"), 10 * 24 * 60 * 60 * 1000);

    const removed = pruneOldStepCache(168, TEST_DIR);

    assert.equal(removed, 1);
    // Item dir is preserved because one file inside is fresh.
    assert.ok(existsSync(itemDir("onboarding", "mixed@x.edu")));
    assert.ok(existsSync(recordPath("onboarding", "mixed@x.edu", "person-search")));
  });

  it("ignores non-json files inside item directories", () => {
    stepCacheSet("onboarding", "a@x.edu", "extraction", { v: 1 }, { dir: TEST_DIR });
    // Drop a non-json file inside the item dir.
    writeFileSync(join(itemDir("onboarding", "a@x.edu"), "notes.txt"), "ignore me");
    backdate(join(itemDir("onboarding", "a@x.edu"), "notes.txt"), 30 * 24 * 60 * 60 * 1000);

    const removed = pruneOldStepCache(168, TEST_DIR);
    assert.equal(removed, 0, "non-json files are not counted by the pruner");
  });
});

describe("DEFAULT_STEP_CACHE_DIR", () => {
  it("is .tracker/step-cache (colocated with other .tracker/ artifacts)", () => {
    assert.equal(DEFAULT_STEP_CACHE_DIR, ".tracker/step-cache");
  });
});
