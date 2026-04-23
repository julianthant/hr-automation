import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashKey, recordSuccess, findRecentTransactionId, hasRecentlySucceeded } from "../../../../src/core/idempotency.js";

// These tests characterize the data shape separations' ucpath-transaction
// step relies on. They don't invoke the handler (that needs Playwright);
// they pin the hashKey/recordSuccess/findRecentTransactionId contract the
// resume paths depend on.

test("separations idempotency: resume with recorded txn# → findRecentTransactionId returns it", () => {
  const dir = mkdtempSync(join(tmpdir(), "sep-idemp-"));
  const key = hashKey({ workflow: "separations", docId: "9999", emplId: "11111111" });
  recordSuccess(key, "T002999999", "separations", dir);

  assert.equal(hasRecentlySucceeded(key, { dir }), true);
  assert.equal(findRecentTransactionId(key, { dir }), "T002999999");
});

test("separations idempotency: resume with empty txn# (submit-without-readback) → findRecentTransactionId returns empty string", () => {
  const dir = mkdtempSync(join(tmpdir(), "sep-idemp-"));
  const key = hashKey({ workflow: "separations", docId: "3927", emplId: "10794813" });
  // Simulates yesterday's 3927/3854 path: submit succeeded, readback failed,
  // so we record an empty txn#. The resume path distinguishes this from the
  // "fully populated" case and runs readback-only.
  recordSuccess(key, "", "separations", dir);

  assert.equal(hasRecentlySucceeded(key, { dir }), true);
  assert.equal(findRecentTransactionId(key, { dir }), "");
});

test("separations idempotency: recordSuccess with a real txn# after an empty record persists both entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sep-idemp-"));
  const key = hashKey({ workflow: "separations", docId: "3927", emplId: "10794813" });
  // First: submit succeeded but readback failed → empty record
  recordSuccess(key, "", "separations", dir);
  // Separate the timestamps so findRecentTransactionId's sort-by-ts-desc
  // picks the real txn#. In production the readback-recovery call happens
  // minutes later; the synthetic ≥2ms delay is a minimum to cross the
  // millisecond boundary reliably.
  await new Promise((r) => setTimeout(r, 5));
  recordSuccess(key, "T002999999", "separations", dir);

  assert.equal(findRecentTransactionId(key, { dir }), "T002999999");
});

test("separations idempotency: key shape is stable across field order", () => {
  const a = hashKey({ workflow: "separations", docId: "3927", emplId: "10794813" });
  const b = hashKey({ emplId: "10794813", workflow: "separations", docId: "3927" });
  assert.equal(a, b);
});

test("separations idempotency: different docId → different key", () => {
  const a = hashKey({ workflow: "separations", docId: "3927", emplId: "10794813" });
  const b = hashKey({ workflow: "separations", docId: "3928", emplId: "10794813" });
  assert.notEqual(a, b);
});
