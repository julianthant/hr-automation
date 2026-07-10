import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  VerificationSchema,
  ocrChildItemIdPrefix,
  isForceResearchFlagRecord,
  assertCarryForwardKindCompatible,
} from "../../../../src/services/ocr/forms/shared.js";
import { getFormSpec, listFormTypes } from "../../../../src/services/ocr/forms/registry.js";

describe("shared OCR forms", () => {
  it("exports a reusable verification schema", () => {
    const parsed = VerificationSchema.parse({
      state: "verified",
      hrStatus: "Active",
      department: "HOUSING/DINING/HOSPITALITY",
      screenshotFilename: "person-org-summary.png",
      checkedAt: "2026-05-04T12:00:00.000Z",
    });
    assert.equal(parsed.state, "verified");
  });

  it("lists oath, emergency contact, onbase, verify, and i9 specs from the shared registry", () => {
    assert.deepEqual(
      listFormTypes().map((f) => f.formType).sort(),
      ["emergency-contact", "i9", "oath", "onbase-emergency-contact", "verify"],
    );
    assert.equal(getFormSpec("oath")?.formType, "oath");
    assert.equal(getFormSpec("emergency-contact")?.formType, "emergency-contact");
    assert.equal(getFormSpec("onbase-emergency-contact")?.formType, "onbase-emergency-contact");
    assert.equal(getFormSpec("verify")?.formType, "verify");
    assert.equal(getFormSpec("i9")?.formType, "i9");
  });

  it("i9 is read-only — optional roster, no approve fan-out", () => {
    const i9 = listFormTypes().find((f) => f.formType === "i9");
    assert.ok(i9);
    assert.equal(i9.rosterMode, "optional");
    assert.equal(i9.hasApproveFanOut, false);
  });

  it("verify is read-only — optional roster, no approve fan-out", () => {
    const verify = listFormTypes().find((f) => f.formType === "verify");
    assert.ok(verify);
    assert.equal(verify.rosterMode, "optional");
    assert.equal(verify.hasApproveFanOut, false);
  });

  it("ocrChildItemIdPrefix maps each form to a distinct prefix; non-oath forms are NOT mislabeled ec (F8)", () => {
    assert.equal(ocrChildItemIdPrefix("oath"), "ocr-oath");
    assert.equal(ocrChildItemIdPrefix("emergency-contact"), "ocr-ec");
    // The bug: the old ternary `formType === "oath" ? "oath" : "ec"` made verify
    // (and any future form) read `ocr-ec`. The helper keeps them distinct.
    assert.equal(ocrChildItemIdPrefix("verify"), "ocr-verify");
    assert.equal(ocrChildItemIdPrefix("new-form"), "ocr-new-form");
  });

  it("isForceResearchFlagRecord is the shared forceResearch===true predicate (F8e)", () => {
    assert.equal(isForceResearchFlagRecord({ forceResearch: true }), true);
    assert.equal(isForceResearchFlagRecord({ forceResearch: false }), false);
    assert.equal(isForceResearchFlagRecord({}), false);
    assert.equal(isForceResearchFlagRecord(null), false);
  });

  it("assertCarryForwardKindCompatible rejects two different KNOWN kinds, tolerates undefined (F8e)", () => {
    assert.doesNotThrow(() => assertCarryForwardKindCompatible("oath", "oath", "oath"));
    assert.doesNotThrow(() => assertCarryForwardKindCompatible("oath", undefined, "oath"));
    assert.doesNotThrow(() => assertCarryForwardKindCompatible("oath", "oath", undefined));
    assert.throws(
      () => assertCarryForwardKindCompatible("oath", "oath", "emergency-contact"),
      /cross-form-kind/,
    );
  });

  it("standalone oath/EC brand the OCR default (no spec traceCode); verify keeps 'vf' (E2E-007)", () => {
    // Operation codes (os/ou/ec) come only from the operation intent — a
    // spec-level code made standalone OCR-panel preps grep-collide with real
    // tickets/operations.
    assert.equal(getFormSpec("emergency-contact")?.traceCode, undefined);
    assert.equal(getFormSpec("oath")?.traceCode, undefined);
    assert.equal(getFormSpec("verify")?.traceCode, "vf");
  });
});
