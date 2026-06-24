import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { pickTerminationRow, parseSsSmartHrRows } from "../../../../src/systems/ucpath/ss-smart-hr.js";
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
