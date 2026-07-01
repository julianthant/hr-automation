import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  pickTerminationRow,
  pickHireRow,
  buildHireSearchName,
  parseSsSmartHrRows,
  isWithinSeparationWindow,
  SEPARATION_TERMINATION_WINDOW_DAYS,
  isHireInFlightStatus,
  hireEffectiveDateMatches,
  decideHireDuplicateSkip,
  HIRE_IN_FLIGHT_APPROVAL_STATUSES,
} from "../../../../src/systems/ucpath/ss-smart-hr.js";
import type { SsSmartHrRow } from "../../../../src/systems/ucpath/ss-smart-hr.js";

const row = (action: string, transactionId: string, approvalStatus: string): SsSmartHrRow => ({
  action,
  transactionId,
  approvalStatus,
});

describe("pickTerminationRow", () => {
  it("returns null when there is no TER row (Mariah Diaz case: XFR + HIR only)", () => {
    const rows = [
      row("XFR", "T001221113", "Approved"),
      row("HIR", "T001065418", "Approved"),
    ];
    assert.equal(pickTerminationRow(rows), null);
  });

  it("finds the pending TER row among other actions (Zaira Argumedo case)", () => {
    const rows = [
      row("TER", "T002168945", "Pending"),
      row("XFR", "T001861336", "Approved"),
      row("REH", "T001195324", "Approved"),
      row("HIR", "T001191954", "Approved"),
      row("HIR", "T001179411", "Approved"),
    ];
    const picked = pickTerminationRow(rows);
    assert.ok(picked);
    assert.equal(picked.transactionId, "T002168945");
    assert.equal(picked.approvalStatus, "Pending");
  });

  it("finds an approved TER row", () => {
    const rows = [
      row("HIR", "T001000001", "Approved"),
      row("TER", "T002999999", "Approved"),
    ];
    const picked = pickTerminationRow(rows);
    assert.ok(picked);
    assert.equal(picked.approvalStatus, "Approved");
  });

  it("is case- and whitespace-insensitive on the action code", () => {
    const rows = [row(" ter ", "T002000000", "Pending")];
    const picked = pickTerminationRow(rows);
    assert.ok(picked);
    assert.equal(picked.transactionId, "T002000000");
  });

  it("returns the first TER row when more than one exists (newest-first grid)", () => {
    const rows = [
      row("TER", "T002222222", "Pending"),
      row("TER", "T002111111", "Approved"),
    ];
    const picked = pickTerminationRow(rows);
    assert.ok(picked);
    assert.equal(picked.transactionId, "T002222222");
  });

  it("returns null on an empty grid", () => {
    assert.equal(pickTerminationRow([]), null);
  });
});

/**
 * Onboarding's pre-submit duplicate-hire probe: the hire-family analogue of
 * `pickTerminationRow`. A `HIR`/`REH` row for the searched person means a hire
 * is already in flight, so the submit must be skipped.
 */
describe("pickHireRow", () => {
  it("returns null when there is no hire row (only TER/XFR)", () => {
    const rows = [
      row("TER", "T002999999", "Approved"),
      row("XFR", "T001221113", "Approved"),
    ];
    assert.equal(pickHireRow(rows), null);
  });

  it("finds the HIR row among other actions", () => {
    const rows = [
      row("TER", "T002168945", "Pending"),
      row("XFR", "T001861336", "Approved"),
      row("HIR", "T001191954", "Pending"),
    ];
    const picked = pickHireRow(rows);
    assert.ok(picked);
    assert.equal(picked.transactionId, "T001191954");
    assert.equal(picked.approvalStatus, "Pending");
  });

  it("also matches a REH (rehire) action", () => {
    const rows = [row("REH", "T001195324", "Saved")];
    const picked = pickHireRow(rows);
    assert.ok(picked);
    assert.equal(picked.action, "REH");
  });

  it("is case- and whitespace-insensitive on the action code", () => {
    const picked = pickHireRow([row(" hir ", "T002000000", "Pending")]);
    assert.ok(picked);
    assert.equal(picked.transactionId, "T002000000");
  });

  it("returns the first hire row when more than one exists (newest-first grid)", () => {
    const rows = [
      row("HIR", "T002222222", "Pending"),
      row("HIR", "T002111111", "Approved"),
    ];
    const picked = pickHireRow(rows);
    assert.ok(picked);
    assert.equal(picked.transactionId, "T002222222");
  });

  it("returns null on an empty grid", () => {
    assert.equal(pickHireRow([]), null);
  });
});

describe("buildHireSearchName", () => {
  it("builds the PeopleSoft Last,First key", () => {
    assert.equal(buildHireSearchName("Jane", "Doe"), "Doe,Jane");
  });

  it("trims surrounding whitespace on each part", () => {
    assert.equal(buildHireSearchName("  Jane ", " Doe  "), "Doe,Jane");
  });

  it("falls back to the last name alone when first is missing", () => {
    assert.equal(buildHireSearchName("", "Doe"), "Doe");
    assert.equal(buildHireSearchName("   ", "Doe"), "Doe");
  });

  it("falls back to the first name alone when last is missing", () => {
    assert.equal(buildHireSearchName("Jane", ""), "Jane");
  });

  it("returns an empty string when neither name is present", () => {
    assert.equal(buildHireSearchName("", ""), "");
    assert.equal(buildHireSearchName("  ", "  "), "");
  });
});

/**
 * Grid parse from a cell-text matrix. The live failure (EID 10759273, "Ava
 * Tolles", 2026-06-24): SS Smart HR showed an APPROVED TER, but the header-only
 * scan returned nothing, so transaction-check wrongly created a duplicate that
 * UCPath then rejected. The dual-pass parse must find the TER both with AND
 * without a clean header row.
 */
describe("parseSsSmartHrRows", () => {
  // Image #3 layout: Transaction ID | Template Sequence | Name | Empl ID | Action | Approval Status | Business Unit
  const HEADER = ["Transaction ID", "Template Sequence", "Name", "Empl ID", "Action", "Approval Status", "Business Unit"];
  const tollesData = [
    ["T002168976", "2176494", "Ava Tolles", "10759273", "TER", "Approved", "SDCMP"],
    ["T002161023", "2168535", "Ava Tolles", "10759273", "TER", "Approved", "SDCMP"],
    ["T002161009", "2168521", "Ava Tolles", "10759273", "TER", "Approved", "SDCMP"],
    ["T002027497", "2035007", "Ava Tolles", "10759273", "HIR", "Approved", "SDCMP"],
    ["T001707018", "1714466", "Ava Tolles", "10759273", "HIR", "Approved", "SDCMP"],
  ];

  it("header-keyed: parses the Tolles grid and finds the APPROVED TER (the live duplicate-create bug)", () => {
    const parsed = parseSsSmartHrRows([HEADER, ...tollesData]);
    assert.equal(parsed.length, 5);
    const ter = pickTerminationRow(parsed);
    assert.ok(ter, "must find a TER row");
    assert.equal(ter.transactionId, "T002168976");
    assert.equal(ter.approvalStatus, "Approved");
  });

  it("pattern fallback: still finds the APPROVED TER when the header row is missing/merged", () => {
    // No header row at all — the nested/split-table case the header-only scan missed.
    const parsed = parseSsSmartHrRows(tollesData);
    const ter = pickTerminationRow(parsed);
    assert.ok(ter, "pattern pass must recover the TER without a header");
    assert.equal(ter.transactionId, "T002168976");
    assert.equal(ter.action, "TER");
    assert.equal(ter.approvalStatus, "Approved");
  });

  it("does not mistake the 5-letter Business Unit (SDCMP) for the 3-letter action code", () => {
    const parsed = parseSsSmartHrRows([["T002168976", "2176494", "Ava Tolles", "10759273", "TER", "Approved", "SDCMP"]]);
    assert.equal(parsed[0].action, "TER");
    assert.equal(parsed[0].transactionId, "T002168976", "the 7-digit template seq / EID are not the T-id");
  });

  it("is order-independent in the pattern pass (columns shuffled, no header)", () => {
    const parsed = parseSsSmartHrRows([["Pending", "Some Name", "TER", "10759273", "T002168945"]]);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].transactionId, "T002168945");
    assert.equal(parsed[0].action, "TER");
    assert.equal(parsed[0].approvalStatus, "Pending");
  });

  it("dedupes a transaction id that both passes would emit (header + pattern overlap)", () => {
    const parsed = parseSsSmartHrRows([HEADER, tollesData[0]]);
    assert.equal(parsed.length, 1, "the single data row appears once, not twice");
  });

  it("skips rows without a transaction id or without a status; empty matrix → []", () => {
    assert.deepEqual(parseSsSmartHrRows([]), []);
    assert.deepEqual(parseSsSmartHrRows([["just", "some", "chrome", "row"]]), []);
    // A T-id with no recognizable status is not a transaction row.
    assert.deepEqual(parseSsSmartHrRows([["T002168976", "no status here", "SDCMP"]]), []);
  });
});

/**
 * An employee can be terminated for a PRIOR job, leaving an old TER on the SS
 * Smart HR list that is NOT this separation. The TER's effective date must be
 * close to the Kuali separation date ("a week or two max") for it to be reused;
 * a far-off effdt is a prior termination and a fresh transaction must be made.
 */
describe("isWithinSeparationWindow", () => {
  it("treats the SAME date (either format) as within the window", () => {
    assert.equal(isWithinSeparationWindow("2026-06-17", "06/17/2026"), true);
    assert.equal(isWithinSeparationWindow("06/17/2026", "06/17/2026"), true);
  });

  it("treats term-eff = separation + 1 day (the normal case) as within the window", () => {
    assert.equal(isWithinSeparationWindow("2026-06-18", "06/17/2026"), true);
  });

  it("accepts up to the tolerance and rejects beyond it (default 14 days)", () => {
    assert.equal(SEPARATION_TERMINATION_WINDOW_DAYS, 14);
    assert.equal(isWithinSeparationWindow("2026-07-01", "06/17/2026"), true, "14 days → within");
    assert.equal(isWithinSeparationWindow("2026-07-02", "06/17/2026"), false, "15 days → outside");
    assert.equal(isWithinSeparationWindow("2026-06-03", "06/17/2026"), true, "14 days before → within");
  });

  it("rejects a PRIOR termination for a different job (the Megan Pateno screenshot)", () => {
    // TER effdt 2023-10-08 vs a 2026 separation → years apart → not this one.
    assert.equal(isWithinSeparationWindow("2023-10-08", "06/17/2026"), false);
  });

  it("honors a custom tolerance", () => {
    assert.equal(isWithinSeparationWindow("2026-06-24", "06/17/2026", 7), true, "exactly 7 days");
    assert.equal(isWithinSeparationWindow("2026-06-25", "06/17/2026", 7), false, "8 days > 7");
  });

  it("returns false on an unparseable date (treated as not a confident match)", () => {
    assert.equal(isWithinSeparationWindow("", "06/17/2026"), false);
    assert.equal(isWithinSeparationWindow("Effdt unknown", "06/17/2026"), false);
    assert.equal(isWithinSeparationWindow("2026-06-17", "not a date"), false);
  });

  it("handles month/year boundaries correctly", () => {
    assert.equal(isWithinSeparationWindow("2026-01-05", "12/28/2025"), true, "8 days across year end");
    assert.equal(isWithinSeparationWindow("2026-03-01", "02/20/2026"), true, "9 days across month end");
  });
});

/**
 * Onboarding's duplicate-hire skip was originally a NAME + hire-action match with
 * NO approval-status or effective-date disambiguation. Two real defects:
 *   1. A DIFFERENT same-named person's stale HIR row made today's onboarding of a
 *      different "Nguyen,John" wrongly match → "Already Submitted" → the real
 *      person was never hired (fires on the FIRST run, not just retries).
 *   2. A prior Denied/Error/Pushed-Back hire (one that did NOT go through and
 *      legitimately needs resubmitting) also tripped the skip and could never be
 *      resubmitted.
 * The gate now skips ONLY on a HIGH-CONFIDENCE match, biasing to SUBMIT on any
 * uncertainty (a false skip — never hiring someone — is worse than the
 * probe-guarded double-submit risk).
 */
describe("isHireInFlightStatus", () => {
  it("treats Pending / Approved / Manually Processed as in-flight/succeeded (skip-eligible)", () => {
    assert.deepEqual(
      [...HIRE_IN_FLIGHT_APPROVAL_STATUSES],
      ["Pending", "Approved", "Manually Processed"],
    );
    assert.equal(isHireInFlightStatus("Pending"), true);
    assert.equal(isHireInFlightStatus("Approved"), true);
    assert.equal(isHireInFlightStatus("Manually Processed"), true);
  });

  it("treats terminal-FAILED statuses as NOT in-flight (they must be resubmitted)", () => {
    assert.equal(isHireInFlightStatus("Denied"), false);
    assert.equal(isHireInFlightStatus("Error"), false);
    assert.equal(isHireInFlightStatus("Pushed Back"), false);
    assert.equal(isHireInFlightStatus("Recycled"), false);
    assert.equal(isHireInFlightStatus("Cancelled"), false);
  });

  it("is case- and whitespace-insensitive", () => {
    assert.equal(isHireInFlightStatus("  pending "), true);
    assert.equal(isHireInFlightStatus("MANUALLY   PROCESSED"), true);
    assert.equal(isHireInFlightStatus(""), false);
  });
});

describe("hireEffectiveDateMatches", () => {
  it("matches the SAME day across ISO (drill-in) and US (run) formats", () => {
    assert.equal(hireEffectiveDateMatches("2026-07-01", "07/01/2026"), true);
    assert.equal(hireEffectiveDateMatches("07/01/2026", "07/01/2026"), true);
    assert.equal(hireEffectiveDateMatches("2026-7-1", "07/01/2026"), true);
  });

  it("does NOT match a DIFFERENT hire date (a different hire event / stale row)", () => {
    assert.equal(hireEffectiveDateMatches("2026-06-24", "07/01/2026"), false);
    assert.equal(hireEffectiveDateMatches("2025-07-01", "07/01/2026"), false);
  });

  it("is an EXACT match — even one day off does not match (unlike the separation window)", () => {
    assert.equal(hireEffectiveDateMatches("2026-07-02", "07/01/2026"), false);
    assert.equal(hireEffectiveDateMatches("2026-06-30", "07/01/2026"), false);
  });

  it("returns false on an unreadable / missing date (fail-open at the caller)", () => {
    assert.equal(hireEffectiveDateMatches("", "07/01/2026"), false);
    assert.equal(hireEffectiveDateMatches("Effdt unknown", "07/01/2026"), false);
    assert.equal(hireEffectiveDateMatches("2026-07-01", ""), false);
  });
});

describe("decideHireDuplicateSkip", () => {
  const RUN = "07/01/2026";
  const hire = (action: string, approvalStatus: string): SsSmartHrRow =>
    row(action, "T002100000", approvalStatus);

  it("SKIPS a Pending HIR whose effdt matches this run (the genuine retry duplicate)", () => {
    const d = decideHireDuplicateSkip(hire("HIR", "Pending"), "2026-07-01", RUN);
    assert.equal(d.skip, true);
  });

  it("SKIPS an Approved / Manually Processed / REH hire with a matching effdt", () => {
    assert.equal(decideHireDuplicateSkip(hire("HIR", "Approved"), "07/01/2026", RUN).skip, true);
    assert.equal(decideHireDuplicateSkip(hire("HIR", "Manually Processed"), "2026-07-01", RUN).skip, true);
    assert.equal(decideHireDuplicateSkip(hire("REH", "Pending"), "2026-07-01", RUN).skip, true);
  });

  it("does NOT skip when there is no hire row (null candidate → submit)", () => {
    const d = decideHireDuplicateSkip(null, "2026-07-01", RUN);
    assert.equal(d.skip, false);
  });

  // Defect #1 — the false positive that silently skipped a legit hire.
  it("does NOT skip a same-named person's STALE hire row (effdt differs → submit)", () => {
    const d = decideHireDuplicateSkip(hire("HIR", "Pending"), "2026-06-24", RUN);
    assert.equal(d.skip, false, "a different-dated hire is a different hire event / different person");
  });

  // Defect #2 — the status-blind skip that blocked resubmitting a failed hire.
  it("does NOT skip a terminal-FAILED hire even with a matching effdt (must resubmit)", () => {
    assert.equal(decideHireDuplicateSkip(hire("HIR", "Denied"), "2026-07-01", RUN).skip, false);
    assert.equal(decideHireDuplicateSkip(hire("HIR", "Error"), "2026-07-01", RUN).skip, false);
    assert.equal(decideHireDuplicateSkip(hire("HIR", "Pushed Back"), "2026-07-01", RUN).skip, false);
  });

  // Fail-open on ambiguity — uncertainty must resolve to SUBMIT, never skip.
  it("does NOT skip when the drilled effdt is unreadable (fail-open → submit)", () => {
    const d = decideHireDuplicateSkip(hire("HIR", "Pending"), "", RUN);
    assert.equal(d.skip, false);
  });

  it("does NOT skip when this run has no effective date to disambiguate against", () => {
    assert.equal(decideHireDuplicateSkip(hire("HIR", "Pending"), "2026-07-01", undefined).skip, false);
    assert.equal(decideHireDuplicateSkip(hire("HIR", "Pending"), "2026-07-01", "").skip, false);
  });

  it("does NOT skip a non-hire action even if it slipped in (defensive)", () => {
    assert.equal(decideHireDuplicateSkip(hire("TER", "Approved"), "2026-07-01", RUN).skip, false);
    assert.equal(decideHireDuplicateSkip(hire("XFR", "Approved"), "2026-07-01", RUN).skip, false);
  });

  it("carries a human-readable reason for the audit log on every branch", () => {
    assert.match(decideHireDuplicateSkip(null, "", RUN).reason, /no hire/i);
    assert.match(decideHireDuplicateSkip(hire("HIR", "Denied"), "2026-07-01", RUN).reason, /in-flight|resubmit|status/i);
    assert.match(decideHireDuplicateSkip(hire("HIR", "Pending"), "2026-06-24", RUN).reason, /effdt|effective/i);
    assert.match(decideHireDuplicateSkip(hire("HIR", "Pending"), "2026-07-01", RUN).reason, /2026-07-01|match/i);
  });
});
