import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emergencyContactOcrFormSpec } from "../../../../../src/services/ocr/forms/emergency-contact.js";
import type { RosterRow } from "../../../../../src/services/matching/match.js";

function makeRecord(name: string) {
  return {
    sourcePage: 1,
    employee: { name, employeeId: "" },
    emergencyContact: {
      name: "Jane Contact",
      relationship: "Spouse",
      primary: true as const,
      sameAddressAsEmployee: true as const,
    },
    notes: [],
    documentType: "expected" as const,
    originallyMissing: [],
  };
}

function rosterRow(name: string, eid: string): RosterRow {
  return { eid, name };
}

describe("emergencyContactOcrFormSpec.matchRecord auto-accept floor", () => {
  it("auto-accepts exact single candidate (score 1.0 ≥ ROSTER_AUTO_ACCEPT)", async () => {
    const result = await emergencyContactOcrFormSpec.matchRecord({
      record: makeRecord("John Doe"),
      roster: [rosterRow("John Doe", "10000001")],
    });
    assert.equal(result.matchState, "matched");
    assert.equal(result.employee.employeeId, "10000001");
  });

  it("auto-accepts token-set single candidate (score 0.9 ≥ ROSTER_AUTO_ACCEPT)", async () => {
    // "John Michael Doe" vs "John Doe" — token-set match, score 0.9
    const result = await emergencyContactOcrFormSpec.matchRecord({
      record: makeRecord("John Michael Doe"),
      roster: [rosterRow("John Doe", "10000002")],
    });
    assert.equal(result.matchState, "matched");
    assert.equal(result.employee.employeeId, "10000002");
  });

  it("does NOT auto-accept single fuzzy candidate below ROSTER_AUTO_ACCEPT (score 0.7)", async () => {
    // "John Smyth" vs "John Smith" — Levenshtein-1, score 0.7 < 0.85
    const result = await emergencyContactOcrFormSpec.matchRecord({
      record: makeRecord("John Smyth"),
      roster: [rosterRow("John Smith", "10000003")],
    });
    assert.equal(result.matchState, "lookup-pending");
    assert.equal(result.employee.employeeId, "");
  });
});
