import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { onbaseEmergencyContactOcrFormSpec } from "../../../../../src/services/ocr/forms/onbase-emergency-contact.js";

const spec = onbaseEmergencyContactOcrFormSpec;

function ecRecord(over: Record<string, unknown> = {}): never {
  return {
    sourcePage: 2,
    formKind: "emergency-contact",
    employee: { name: "Khosrowjerdi, Ali", employeeId: "10866338" },
    emergencyContact: {
      name: "Pat Doe",
      relationship: "Spouse",
      primary: true,
      sameAddressAsEmployee: true,
      address: null,
    },
    notes: [],
    documentType: "expected",
    originallyMissing: [],
    matchState: "matched",
    matchSource: "form",
    matchConfidence: 1,
    selected: true,
    warnings: [],
    ...over,
  } as never;
}

const ctx = {
  sessionId: "sess",
  runId: "run1",
  pdfFileId: "abc123def456",
  pdfOriginalName: "batch.pdf",
};

describe("onbaseEmergencyContactOcrFormSpec", () => {
  it("reuses emergency-contact's extraction (same prompt + schema name) but a new formType", () => {
    assert.equal(spec.formType, "onbase-emergency-contact");
    assert.equal(spec.schemaName, "emergency-contact-batch");
    assert.equal(spec.rosterMode, "required");
  });

  it("fans out to the onbase daemon", () => {
    assert.ok(spec.approveTo);
    assert.equal(spec.approveTo.workflow, "onbase");
  });

  it("deriveInput builds an OnbaseInput from the record + document context", () => {
    const input = spec.approveTo!.deriveInput(ecRecord(), ctx) as Record<string, unknown>;
    assert.equal(input.ucpathId, "10866338");
    assert.equal(input.sourcePage, 2);
    assert.equal(input.pdfFileId, "abc123def456");
    assert.equal(input.pdfOriginalName, "batch.pdf");
    assert.equal(input.documentType, "X_HR_Emergency Contact");
    assert.equal(input.documentName, "EMERGENCY CONTACT INFORMATION");
    assert.equal(input.employeeName, "Khosrowjerdi, Ali");
    // "Last, First" splits into the fallback name fields.
    assert.equal(input.lastName, "Khosrowjerdi");
    assert.equal(input.firstName, "Ali");
  });

  it("deriveItemId is deterministic per parent run + index", () => {
    assert.equal(spec.approveTo!.deriveItemId(ecRecord(), "parent-run", 3), "ocr-onbase-parent-run-r3");
  });

  it("canFanOut requires a resolvable EID and an EC-classified page", () => {
    assert.equal(spec.approveTo!.canFanOut!(ecRecord()), true);
    assert.equal(
      spec.approveTo!.canFanOut!(ecRecord({ employee: { name: "X", employeeId: "" } })),
      false,
    );
    assert.equal(spec.approveTo!.canFanOut!(ecRecord({ formKind: "oath" })), false);
  });
});
