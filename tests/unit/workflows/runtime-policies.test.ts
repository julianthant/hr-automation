import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ocrWorkflow } from "../../../src/workflows/ocr/workflow.js";
import { oathSignatureWorkflow } from "../../../src/workflows/oath-signature/workflow.js";
import { oathUploadWorkflow } from "../../../src/workflows/oath-upload/workflow.js";
import { emergencyContactWorkflow } from "../../../src/workflows/emergency-contact/workflow.js";

describe("Phase 4 workflow runtime policies", () => {
  it("registers OCR file-scope prep and utility child rules in workflow metadata", () => {
    const policy = ocrWorkflow.metadata.runtimePolicy;

    assert.equal(policy?.preview?.rowTypeLabelSuffix, "Preview");
    assert.equal(policy?.delegation?.fileScopeCancelKind, "ocr-discard");
    assert.equal(policy?.delegation?.utilityChildSurface, "delegation-member");
    assert.deepEqual(policy?.delegation?.utilityChildWorkflows, ["eid-lookup", "active-check"]);
  });

  it("registers Oath Signature file prep and person member rules", () => {
    const policy = oathSignatureWorkflow.metadata.runtimePolicy;

    assert.equal(policy?.prepRow?.titleSource, "pdf-original-name");
    assert.equal(policy?.prepRow?.subtitleTemplate, "Oath · <last4 run id>");
    assert.equal(policy?.memberRow?.titleSource, "person");
    assert.equal(policy?.rowActions.find((action) => action.kind === "cancel")?.scope, "row");
  });

  it("registers Oath Upload blocking dependency and explicit tree cancel rules", () => {
    const policy = oathUploadWorkflow.metadata.runtimePolicy;

    assert.equal(policy?.delegation?.rootRowPersistsThroughChildren, true);
    assert.equal(policy?.delegation?.failedChildBlocksParent, true);
    assert.equal(policy?.rowActions.find((action) => action.kind === "cancel")?.scope, "tree");
  });

  it("registers Emergency Contact OCR-prep and member-row rules", () => {
    const policy = emergencyContactWorkflow.metadata.runtimePolicy;

    assert.equal(policy?.prepRow?.titleSource, "pdf-original-name");
    assert.equal(policy?.memberRow?.titleSource, "person");
    assert.equal(policy?.delegation?.cancelScope, "row");
  });
});
