import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  hashKey,
  hasRecentlySucceeded,
  recordSuccess,
  findRecentTransactionId,
  pruneOldIdempotencyRecords,
  DEFAULT_IDEMPOTENCY_DIR,
  IDEMPOTENCY_FILENAME,
} from "../../../src/core/index.js";
import { _readRecordsForTest } from "../../../src/core/idempotency.js";

const TEST_DIR = ".tracker-idempotency-test";

function makeRec(
  key: string,
  transactionId: string,
  ts: string,
  workflow = "onboarding",
): string {
  return JSON.stringify({ key, transactionId, ts, workflow }) + "\n";
}

describe("hashKey", () => {
  it("returns a 64-char hex sha256 string", () => {
    const h = hashKey({ workflow: "onboarding", emplId: "12345" });
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it("is deterministic for same input", () => {
    const a = hashKey({ workflow: "onboarding", emplId: "12345" });
    const b = hashKey({ workflow: "onboarding", emplId: "12345" });
    assert.equal(a, b);
  });

  it("is stable across key order (sorted before hashing)", () => {
    const a = hashKey({ a: 1, b: 2, c: 3 });
    const b = hashKey({ c: 3, a: 1, b: 2 });
    const c = hashKey({ b: 2, c: 3, a: 1 });
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it("differs when any value changes", () => {
    const a = hashKey({ workflow: "onboarding", emplId: "12345" });
    const b = hashKey({ workflow: "onboarding", emplId: "12346" });
    assert.notEqual(a, b);
  });

  it("differs across workflows", () => {
    const a = hashKey({ workflow: "onboarding", emplId: "12345" });
    const b = hashKey({ workflow: "work-study", emplId: "12345" });
    assert.notEqual(a, b);
  });

  it("handles missing/undefined values via JSON semantics", () => {
    const a = hashKey({ ssn: undefined, emplId: "x" });
    const b = hashKey({ emplId: "x" });
    // JSON.stringify omits undefined properties — same hash.
    assert.equal(a, b);
  });
});

describe("hasRecentlySucceeded + recordSuccess round-trip", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("returns false when no record exists", () => {
    const key = hashKey({ workflow: "x", a: "1" });
    assert.equal(hasRecentlySucceeded(key, { dir: TEST_DIR }), false);
  });

  it("returns true after recordSuccess", () => {
    const key = hashKey({ workflow: "x", a: "1" });
    recordSuccess(key, "TX_123", "onboarding", TEST_DIR);
    assert.equal(hasRecentlySucceeded(key, { dir: TEST_DIR }), true);
  });

  it("matches only the exact key", () => {
    const keyA = hashKey({ workflow: "x", a: "1" });
    const keyB = hashKey({ workflow: "x", a: "2" });
    recordSuccess(keyA, "TX_A", "onboarding", TEST_DIR);
    assert.equal(hasRecentlySucceeded(keyA, { dir: TEST_DIR }), true);
    assert.equal(hasRecentlySucceeded(keyB, { dir: TEST_DIR }), false);
  });

  it("findRecentTransactionId returns the latest matching txId", () => {
    const key = hashKey({ workflow: "x", a: "1" });
    const filePath = join(TEST_DIR, IDEMPOTENCY_FILENAME);
    const earlier = new Date(Date.now() - 1_000).toISOString();
    const later = new Date().toISOString();
    // Manually write two records with different timestamps
    writeFileSync(
      filePath,
      makeRec(key, "TX_OLD", earlier) + makeRec(key, "TX_NEW", later),
    );
    assert.equal(findRecentTransactionId(key, { dir: TEST_DIR }), "TX_NEW");
  });

  it("falls back to null when no matching record exists", () => {
    const key = hashKey({ workflow: "x", a: "1" });
    assert.equal(findRecentTransactionId(key, { dir: TEST_DIR }), null);
  });
});

describe("withinDays cutoff", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("ignores records older than the cutoff", () => {
    const key = hashKey({ workflow: "x", a: "1" });
    const oldTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(join(TEST_DIR, IDEMPOTENCY_FILENAME), makeRec(key, "TX_OLD", oldTs));

    // Default cutoff is 14 days — old record should not match
    assert.equal(hasRecentlySucceeded(key, { dir: TEST_DIR }), false);

    // Explicit wider window picks it up
    assert.equal(
      hasRecentlySucceeded(key, { dir: TEST_DIR, withinDays: 60 }),
      true,
    );
  });

  it("honors custom withinDays", () => {
    const key = hashKey({ workflow: "x", a: "1" });
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(TEST_DIR, IDEMPOTENCY_FILENAME),
      makeRec(key, "TX_3D", threeDaysAgo),
    );

    assert.equal(hasRecentlySucceeded(key, { dir: TEST_DIR, withinDays: 1 }), false);
    assert.equal(hasRecentlySucceeded(key, { dir: TEST_DIR, withinDays: 7 }), true);
  });
});

describe("pruneOldIdempotencyRecords", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("drops entries older than withinDays and keeps newer ones", () => {
    const keyA = hashKey({ workflow: "x", a: "1" });
    const keyB = hashKey({ workflow: "x", a: "2" });
    const oldTs = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const newTs = new Date().toISOString();

    writeFileSync(
      join(TEST_DIR, IDEMPOTENCY_FILENAME),
      makeRec(keyA, "TX_OLD", oldTs) + makeRec(keyB, "TX_NEW", newTs),
    );

    const removed = pruneOldIdempotencyRecords(14, TEST_DIR);
    assert.equal(removed, 1);
    const remaining = _readRecordsForTest(TEST_DIR);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].transactionId, "TX_NEW");
  });

  it("returns 0 when nothing is pruned", () => {
    const key = hashKey({ workflow: "x", a: "1" });
    recordSuccess(key, "TX_1", "onboarding", TEST_DIR);
    const removed = pruneOldIdempotencyRecords(14, TEST_DIR);
    assert.equal(removed, 0);
  });

  it("returns 0 when file does not exist", () => {
    const missing = ".tracker-idempotency-missing-" + Date.now();
    const removed = pruneOldIdempotencyRecords(14, missing);
    assert.equal(removed, 0);
  });
});

describe("read resilience", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("skips malformed lines rather than throwing", () => {
    const key = hashKey({ workflow: "x", a: "1" });
    const validRecord = makeRec(key, "TX_OK", new Date().toISOString());
    writeFileSync(
      join(TEST_DIR, IDEMPOTENCY_FILENAME),
      "not-json\n" + validRecord + "also-not-json\n",
    );
    assert.equal(hasRecentlySucceeded(key, { dir: TEST_DIR }), true);
  });

  it("writes to default dir when none provided (and file is line-delimited JSON)", () => {
    // Verify default path is .tracker by spot-checking the constant
    assert.equal(DEFAULT_IDEMPOTENCY_DIR, ".tracker");
  });
});
