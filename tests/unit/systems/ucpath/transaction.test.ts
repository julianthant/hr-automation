import { describe, test } from "vitest";
import assert from "node:assert/strict";
import {
  extractSmartHrTransactionNumber,
  rowMatchesTerminationEid,
  classifyOutcomeSignals,
  parsePayRate,
} from "../../../../src/systems/ucpath/transaction.js";

describe("parsePayRate", () => {
  test("extracts the numeric rate from a formatted wage", () => {
    assert.equal(parsePayRate("$17.75 per hour"), "17.75");
    assert.equal(parsePayRate("20"), "20");
    assert.equal(parsePayRate("$18.50"), "18.50");
  });
  test("throws (fail loud) on a digit-free wage instead of submitting it verbatim", () => {
    // "TBD"/"Negotiable"/"N/A" would previously be typed straight into the
    // UCPath Compensation Rate field; now they fail loud.
    assert.throws(() => parsePayRate("TBD"), /unparseable pay rate/);
    assert.throws(() => parsePayRate("Negotiable"), /unparseable pay rate/);
    assert.throws(() => parsePayRate("N/A"), /unparseable pay rate/);
  });
  test("handles comma-formatted wages instead of truncating at the comma", () => {
    // The old /[\d.]+/ stopped at the first comma: "$1,250.00" → "1" — a wrong
    // rate typed into a real UCPath transaction.
    assert.equal(parsePayRate("$1,250.00"), "1250.00");
    assert.equal(parsePayRate("$1,250.00 biweekly"), "1250.00");
    assert.equal(parsePayRate("$12,345.67"), "12345.67");
  });
  test("throws on malformed digit-separator grouping instead of guessing", () => {
    // Stripping the comma from "1,25.00" would silently submit 125.
    assert.throws(() => parsePayRate("$1,25.00"), /ambiguous digit separators/);
    assert.throws(() => parsePayRate("$12,3456"), /ambiguous digit separators/);
  });
});

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

describe("rowMatchesTerminationEid", () => {
  test("exact EID in a termination row → true", () => {
    assert.equal(
      rowMatchesTerminationEid(
        ["John Smith", "10694136", "TER Termination"],
        "10694136 John Smith TER Termination Pending",
        "10694136",
      ),
      true,
    );
  });

  test("EID present but row not a termination → false", () => {
    assert.equal(
      rowMatchesTerminationEid(
        ["10694136", "HIR Hire"],
        "10694136 John Smith HIR Hire Approved",
        "10694136",
      ),
      false,
    );
  });

  test("EID only as substring of a larger cell value → false", () => {
    // cell "10694136X" contains "1069413" but must not match eid "1069413"
    assert.equal(
      rowMatchesTerminationEid(
        ["10694136X", "TER Termination"],
        "10694136X TER Termination Pending",
        "1069413",
      ),
      false,
    );
  });

  test("no cell matches the EID → false", () => {
    assert.equal(
      rowMatchesTerminationEid(
        ["Jane Doe", "DEPT001", "TER Termination"],
        "Jane Doe DEPT001 TER Termination Pending",
        "10694136",
      ),
      false,
    );
  });
});

/**
 * The per-tick decision behind `waitForTransactionOutcome`. The bug it guards:
 * a late-rendering error banner read `count() === 0` at a single sampled instant
 * and returned `{ success: true }` for a transaction that actually errored. The
 * decision now requires a positive success marker OR treats a visible error
 * banner as authoritative — with the error banner winning even a tie.
 */
describe("classifyOutcomeSignals", () => {
  test("error banner visible → 'error' (even when the success marker is also visible)", () => {
    assert.equal(classifyOutcomeSignals(true, true), "error");
  });

  test("error banner only → 'error'", () => {
    assert.equal(classifyOutcomeSignals(true, false), "error");
  });

  test("success marker only → 'success'", () => {
    assert.equal(classifyOutcomeSignals(false, true), "success");
  });

  test("neither signal yet → 'pending' (keep polling, do not conclude success)", () => {
    assert.equal(classifyOutcomeSignals(false, false), "pending");
  });
});
