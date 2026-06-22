import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { OnbaseInputSchema } from "../../../../src/workflows/onbase/schema.js";

describe("OnbaseInputSchema", () => {
  const base = { ucpathId: "10866338", sourcePage: 1, pdfFileId: "a".repeat(32) };

  it("accepts a minimal valid input and applies document defaults", () => {
    const parsed = OnbaseInputSchema.parse(base);
    assert.equal(parsed.ucpathId, "10866338");
    assert.equal(parsed.sourcePage, 1);
    assert.equal(parsed.documentType, "X_HR_Emergency Contact");
    assert.equal(parsed.documentName, "EMERGENCY CONTACT INFORMATION");
  });

  it("carries through optional fallback + display fields", () => {
    const parsed = OnbaseInputSchema.parse({
      ...base,
      employeeName: "Khosrowjerdi, Ali",
      lastName: "Khosrowjerdi",
      firstName: "Ali",
      departmentName: "HOUSING/DINING/HOSPITALITY",
      departmentCode: "000412",
      pdfOriginalName: "batch.pdf",
      dryRun: true,
    });
    assert.equal(parsed.employeeName, "Khosrowjerdi, Ali");
    assert.equal(parsed.departmentCode, "000412");
    assert.equal(parsed.dryRun, true);
  });

  it("rejects a non-numeric or too-short UCPath ID", () => {
    assert.equal(OnbaseInputSchema.safeParse({ ...base, ucpathId: "abc" }).success, false);
    assert.equal(OnbaseInputSchema.safeParse({ ...base, ucpathId: "123" }).success, false);
  });

  it("rejects a non-positive source page", () => {
    assert.equal(OnbaseInputSchema.safeParse({ ...base, sourcePage: 0 }).success, false);
    assert.equal(OnbaseInputSchema.safeParse({ ...base, sourcePage: -1 }).success, false);
    assert.equal(OnbaseInputSchema.safeParse({ ...base, sourcePage: 1.5 }).success, false);
  });

  it("requires a non-empty pdfFileId", () => {
    assert.equal(OnbaseInputSchema.safeParse({ ...base, pdfFileId: "" }).success, false);
  });
});
