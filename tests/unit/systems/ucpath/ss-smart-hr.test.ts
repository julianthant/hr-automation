import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { pickTerminationRow } from "../../../../src/systems/ucpath/ss-smart-hr.js";
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
