import { test } from "vitest";
import assert from "node:assert/strict";
import { extractSmartHrTransactionNumber } from "../../../../src/systems/ucpath/transaction.js";

test("extractSmartHrTransactionNumber reads the lower Transaction ID field", () => {
  assert.equal(
    extractSmartHrTransactionNumber("Transaction ID:\n\nT002144847\nInitiator Comments: ..."),
    "T002144847",
  );
});

test("extractSmartHrTransactionNumber reads the approval strip transaction label", () => {
  assert.equal(
    extractSmartHrTransactionNumber("Transaction: T002144847, ID: 10783653, Effdt: 2026-05-18, Unit: SDCMP:Pending"),
    "T002144847",
  );
});

test("extractSmartHrTransactionNumber returns null when no T-number is present", () => {
  assert.equal(
    extractSmartHrTransactionNumber("Enter Transaction Information\nTransaction ID:\nNEW"),
    null,
  );
});
