import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { OathRosterOcrRecordSchema } from "../../../../../src/services/ocr/forms/oath.js";

describe("OathRosterOcrRecordSchema", () => {
  it("parses a clean UPAY586 record", () => {
    const parsed = OathRosterOcrRecordSchema.parse({
      sourcePage: 1,
      rowIndex: 0,
      printedName: "Marbell, Carlos, D",
      employeeId: "000412",
      dateSigned: "4-23-26",
      employeeSigned: true,
      officerSigned: true,
      documentType: "expected",
    });
    assert.equal(parsed.printedName, "Marbell, Carlos, D");
    assert.equal(parsed.documentType, "expected");
    assert.deepEqual(parsed.originallyMissing, []);
  });

  // Regression (2026-06-04): the prompt shows the model the page-format codes
  // (signin/upay585/upay586/unknown), so it emits one of them ("upay586") as
  // documentType instead of the abstract "expected". A strict
  // z.enum(["expected","unknown"]) rejected it, and per-page finalize() drops
  // the WHOLE record on any field failure → an otherwise-perfect row (name,
  // EID, both signatures) vanished and the operator saw 0 records to approve.
  it("coerces a page-format documentType to 'expected' instead of dropping the record", () => {
    const parsed = OathRosterOcrRecordSchema.safeParse({
      sourcePage: 1,
      rowIndex: 0,
      printedName: "Marbell, Carlos, D",
      employeeId: "000412",
      dateSigned: "4-23-26",
      employeeSigned: true,
      officerSigned: true,
      documentType: "upay586",
      originallyMissing: [],
    });
    assert.ok(parsed.success, "record with a page-format documentType must survive validation");
    assert.equal(parsed.data.documentType, "expected");
    assert.equal(parsed.data.printedName, "Marbell, Carlos, D");
    assert.equal(parsed.data.employeeId, "000412");
  });

  it("keeps 'unknown' for blank/garbage pages (case-insensitive)", () => {
    assert.equal(OathRosterOcrRecordSchema.parse({ sourcePage: 1, documentType: "unknown" }).documentType, "unknown");
    assert.equal(OathRosterOcrRecordSchema.parse({ sourcePage: 1, documentType: "UNKNOWN" }).documentType, "unknown");
  });

  it("defaults documentType to 'expected' when omitted", () => {
    assert.equal(OathRosterOcrRecordSchema.parse({ sourcePage: 1 }).documentType, "expected");
  });
});
