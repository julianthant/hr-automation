import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  ONBASE_DOCUMENT_TYPES,
  ONBASE_EMERGENCY_CONTACT_DOC_TYPE,
  ONBASE_EMERGENCY_CONTACT_FORM_TYPE,
  isOnbaseDocTypeWired,
  onbaseDocTypeFormType,
  onbaseDocTypeLabel,
} from "../../../src/dashboard/lib/onbase-document-types.js";

describe("ONBASE_DOCUMENT_TYPES", () => {
  it("catalogs all 24 OnBase HR document types across the two groups", () => {
    assert.equal(ONBASE_DOCUMENT_TYPES.length, 24);
    const payroll = ONBASE_DOCUMENT_TYPES.filter((d) => d.group === "Payroll Records");
    const personnel = ONBASE_DOCUMENT_TYPES.filter((d) => d.group === "Personnel Records");
    assert.equal(payroll.length, 2);
    assert.equal(personnel.length, 22);
  });

  it("wires exactly one document type today — Emergency Contact", () => {
    const wired = ONBASE_DOCUMENT_TYPES.filter((d) => d.formType);
    assert.equal(wired.length, 1);
    assert.equal(wired[0]!.docType, ONBASE_EMERGENCY_CONTACT_DOC_TYPE);
    assert.equal(wired[0]!.formType, ONBASE_EMERGENCY_CONTACT_FORM_TYPE);
  });

  it("contains the Emergency Contact type in Personnel Records", () => {
    const ec = ONBASE_DOCUMENT_TYPES.find((d) => d.docType === ONBASE_EMERGENCY_CONTACT_DOC_TYPE);
    assert.ok(ec);
    assert.equal(ec.group, "Personnel Records");
  });
});

describe("isOnbaseDocTypeWired", () => {
  it("is true only for Emergency Contact", () => {
    assert.equal(isOnbaseDocTypeWired(ONBASE_EMERGENCY_CONTACT_DOC_TYPE), true);
    assert.equal(isOnbaseDocTypeWired("X_HR_Benefits"), false);
    assert.equal(isOnbaseDocTypeWired("X_HR_Separation"), false);
    assert.equal(isOnbaseDocTypeWired("not-a-real-type"), false);
  });
});

describe("onbaseDocTypeFormType", () => {
  it("maps Emergency Contact to its OCR form type and others to undefined", () => {
    assert.equal(
      onbaseDocTypeFormType(ONBASE_EMERGENCY_CONTACT_DOC_TYPE),
      ONBASE_EMERGENCY_CONTACT_FORM_TYPE,
    );
    assert.equal(onbaseDocTypeFormType("X_HR_Taxes"), undefined);
    assert.equal(onbaseDocTypeFormType("unknown"), undefined);
  });
});

describe("onbaseDocTypeLabel", () => {
  it("strips the X_HR_ prefix", () => {
    assert.equal(onbaseDocTypeLabel("X_HR_Emergency Contact"), "Emergency Contact");
    assert.equal(onbaseDocTypeLabel("X_HR_Benefits"), "Benefits");
    assert.equal(onbaseDocTypeLabel("Plain"), "Plain");
  });
});
