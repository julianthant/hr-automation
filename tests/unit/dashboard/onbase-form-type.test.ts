import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { resolveOnbaseModalFormType } from "../../../src/dashboard/components/run-modal/onbase-form-type.js";
import { ONBASE_EMERGENCY_CONTACT_DOC_TYPE } from "../../../src/dashboard/lib/onbase-document-types.js";

// ISS-001 (2026-06-24, e2e): the OnBase run modal's Run button was a silent
// no-op — handleSubmit returns early on `!formType`, and the close-reset effect
// (which also runs on initial mount while open=false) had nulled formType while
// the docType->formType effect never re-derived it on open. The whole OnBase
// workflow was unstartable from the dashboard. The fix gates+derives via this
// pure helper, keyed on `open`. These pins lock that contract.
describe("resolveOnbaseModalFormType (ISS-001)", () => {
  it("derives a NON-NULL formType when the modal is OPEN for the wired doc type (the bug: it was null on open)", () => {
    const r = resolveOnbaseModalFormType({
      open: true,
      showOnbaseDocType: true,
      onbaseDocType: ONBASE_EMERGENCY_CONTACT_DOC_TYPE,
    });
    assert.equal(r.apply, true, "open onbase modal must apply a formType so Run can submit");
    assert.equal(
      r.formType,
      "onbase-emergency-contact",
      "open + Emergency Contact doc type must resolve the wired formType (else handleSubmit's !formType guard makes Run a no-op)",
    );
  });

  it("is a no-op while the modal is CLOSED (the reset owns formType when closed)", () => {
    const r = resolveOnbaseModalFormType({
      open: false,
      showOnbaseDocType: true,
      onbaseDocType: ONBASE_EMERGENCY_CONTACT_DOC_TYPE,
    });
    assert.equal(r.apply, false, "closed modal must not set formType — that is the reset's job");
  });

  it("is a no-op for a non-onbase-doctype modal (other modals own their own formType)", () => {
    const r = resolveOnbaseModalFormType({
      open: true,
      showOnbaseDocType: false,
      onbaseDocType: ONBASE_EMERGENCY_CONTACT_DOC_TYPE,
    });
    assert.equal(r.apply, false);
  });

  it("applies a null formType for an UNWIRED doc type while open (Run stays guarded, no crash)", () => {
    const r = resolveOnbaseModalFormType({
      open: true,
      showOnbaseDocType: true,
      onbaseDocType: "X_HR_Salary",
    });
    assert.equal(r.apply, true);
    assert.equal(r.formType, null, "unwired doc type -> null formType (submit stays blocked, by design)");
  });
});
