import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VerificationSchema } from "../../../../src/services/ocr/forms/shared.js";
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

  it("lists oath and emergency contact specs from the shared registry", () => {
    assert.deepEqual(
      listFormTypes().map((f) => f.formType).sort(),
      ["emergency-contact", "oath"],
    );
    assert.equal(getFormSpec("oath")?.formType, "oath");
    assert.equal(getFormSpec("emergency-contact")?.formType, "emergency-contact");
  });
});
