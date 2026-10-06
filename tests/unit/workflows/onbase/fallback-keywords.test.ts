import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { fallbackKeywordValues } from "../../../../src/workflows/onbase/handler.js";

const input = { ucpathId: "10002516", sourcePage: 8, pdfFileId: "source", documentType: "X_HR_Emergency Contact", documentName: "EMERGENCY CONTACT INFORMATION", firstName: "Source" };

describe("OnBase corrected fallback keywords", () => {
  it("uses reviewed department fields from edit-and-resume while retaining unedited names", () => {
    const values = fallbackKeywordValues(input, { departmentCode: "000412", departmentName: "HOUSING/DINING/HOSPITALITY", viceChancellorCode: "VCFA", viceChancellor: "VC-FINANCE AND ADMINISTRATION", lastName: "Nedhie" });
    assert.equal(values["First Name"], "Source");
    assert.equal(values["Last Name"], "Nedhie");
    assert.equal(values["Department Code"], "000412");
    assert.equal(values["Department Name"], "HOUSING/DINING/HOSPITALITY");
    assert.equal(values["Vice Chancellor Code"], "VCFA");
    assert.equal(values["Vice Chancellor"], "VC-FINANCE AND ADMINISTRATION");
  });
  it("rejects incorrectly typed reviewed values", () => {
    assert.throws(() => fallbackKeywordValues(input, { departmentCode: 412 }));
  });
  it("does not allow corrections to change the document, source page, identity, or dry-run boundary", () => {
    const values = fallbackKeywordValues(input, { ucpathId: "99999999", sourcePage: 1, pdfFileId: "other", documentType: "other", dryRun: false });
    assert.equal(Object.keys(values).length, 8);
    assert.equal(values["First Name"], "Source");
    assert.equal("UCPath ID" in values, false);
    assert.equal("documentType" in values, false);
    assert.equal("dryRun" in values, false);
  });
});
