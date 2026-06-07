import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { OathRosterOcrRecordSchema, oathOcrFormSpec } from "../../../../../src/services/ocr/forms/oath.js";

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

  // 2026-06-06: oath formKind can now be "emergency-contact" or "unknown"
  // when the model classifies a page as non-oath in a standalone oath run.
  it("accepts formKind 'emergency-contact' (EC page inside an oath run)", () => {
    const parsed = OathRosterOcrRecordSchema.safeParse({
      sourcePage: 2,
      formKind: "emergency-contact",
      documentType: "expected",
    });
    assert.ok(parsed.success, "formKind emergency-contact must be valid in the oath schema");
    assert.equal(parsed.data.formKind, "emergency-contact");
  });

  it("accepts formKind 'unknown' (blank page inside an oath run)", () => {
    const parsed = OathRosterOcrRecordSchema.safeParse({
      sourcePage: 3,
      formKind: "unknown",
      documentType: "unknown",
    });
    assert.ok(parsed.success, "formKind unknown must be valid in the oath schema");
    assert.equal(parsed.data.formKind, "unknown");
  });

  it("defaults formKind to 'oath' when omitted", () => {
    const parsed = OathRosterOcrRecordSchema.parse({ sourcePage: 1 });
    assert.equal(parsed.formKind, "oath");
  });

  // Regression (F13, 2026-06-07): the prompt tells the model to NULL
  // oath-specific fields (printedName, dateSigned, employeeSigned, officerSigned)
  // for non-oath pages. `z.string().optional()` / `z.boolean().optional()`
  // REJECT an explicit `null` (they only allow `undefined`), so a correctly
  // classified EC/unknown page with those fields nulled was schema-dropped →
  // per-page.ts flipped it to success:false → data loss. printedName /
  // employeeSigned are now `.nullable().optional()`.
  it("accepts null cross-form fields on a wrong-form page (EC/unknown inside an oath run)", () => {
    const parsed = OathRosterOcrRecordSchema.safeParse({
      sourcePage: 2,
      formKind: "emergency-contact",
      printedName: null,
      employeeId: null,
      dateSigned: null,
      employeeSigned: null,
      officerSigned: null,
      documentType: "expected",
      originallyMissing: [],
    });
    assert.ok(
      parsed.success,
      `wrong-form oath record with nulled cross-form fields must parse — got: ${JSON.stringify(!parsed.success && parsed.error.issues)}`,
    );
    assert.equal(parsed.data.printedName, null);
    assert.equal(parsed.data.employeeSigned, null);
    assert.equal(parsed.data.formKind, "emergency-contact");
  });
});

// ─── oathOcrFormSpec.approveTo.canFanOut ─────────────────────────────────────
// An EC/unknown page classified inside an oath run must NOT be fanned out as
// an oath signer row, even if it happens to have `selected: true` and a valid
// EID. The `canFanOut` guard blocks this before the approve fan-out.

// Base record for canFanOut tests — using the raw shape the spec's approveTo receives.
// We avoid typing this as OathPreviewRecord directly to prevent the "two types with
// the same name" TS ambiguity between the backend oath.ts type and the frontend types.ts type.
function makeApprovedOathRecord(overrides: Record<string, unknown> = {}) {
  return {
    formKind: "oath" as "oath" | "emergency-contact" | "unknown",
    sourcePage: 1,
    rowIndex: 0,
    printedName: "Doe, Jane",
    employeeId: "10000001",
    employeeSigned: true,
    officerSigned: true,
    dateSigned: "04/23/2026",
    notes: [] as string[],
    matchState: "matched" as const,
    selected: true,
    warnings: [] as string[],
    documentType: "expected" as "expected" | "unknown",
    originallyMissing: [] as string[],
    ...overrides,
  };
}

describe("oathOcrFormSpec.approveTo.canFanOut", () => {
  const canFanOut = oathOcrFormSpec.approveTo!.canFanOut!;

  it("returns true for a selected oath record with a valid EID", () => {
    const rec = makeApprovedOathRecord();
    assert.equal(canFanOut(rec), true);
  });

  it("returns false for a record classified as 'emergency-contact' even with a valid EID + selected", () => {
    const rec = makeApprovedOathRecord({ formKind: "emergency-contact" });
    assert.equal(canFanOut(rec), false, "EC-classified record must not fan out as an oath signer");
  });

  it("returns false for a record classified as 'unknown'", () => {
    const rec = makeApprovedOathRecord({ formKind: "unknown" });
    assert.equal(canFanOut(rec), false, "unknown-classified record must not fan out as an oath signer");
  });

  it("returns false for an unselected oath record", () => {
    const rec = makeApprovedOathRecord({ selected: false });
    assert.equal(canFanOut(rec), false);
  });

  it("returns false for an oath record with no valid EID", () => {
    const rec = makeApprovedOathRecord({ employeeId: "" });
    assert.equal(canFanOut(rec), false);
  });
});
