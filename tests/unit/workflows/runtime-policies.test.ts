import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { activeCheckWorkflow } from "../../../src/workflows/active-check/workflow.js";
import { crmDocDownloadWorkflow } from "../../../src/workflows/crm-doc-download/workflow.js";
import { eidLookupCrmWorkflow } from "../../../src/workflows/eid-lookup/workflow.js";
import { emergencyContactWorkflow } from "../../../src/workflows/emergency-contact/workflow.js";
import { oathSignatureWorkflow } from "../../../src/workflows/oath-signature/workflow.js";
import { oathUploadWorkflow } from "../../../src/workflows/oath-upload/workflow.js";
import { ocrWorkflow } from "../../../src/workflows/ocr/workflow.js";
import { onboardingWorkflow } from "../../../src/workflows/onboarding/workflow.js";
import { kronosReportsWorkflow } from "../../../src/workflows/old-kronos-reports/workflow.js";
import { separationsWorkflow } from "../../../src/workflows/separations/workflow.js";
import { sharepointDownloadWorkflow } from "../../../src/workflows/sharepoint-download/workflow.js";
import { workStudyWorkflow } from "../../../src/workflows/work-study/workflow.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../../src/domain/workflow-runtime/default-policy.js";

const ALL_WORKFLOWS = [
  ["active-check", activeCheckWorkflow],
  ["crm-doc-download", crmDocDownloadWorkflow],
  ["eid-lookup", eidLookupCrmWorkflow],
  ["emergency-contact", emergencyContactWorkflow],
  ["oath-signature", oathSignatureWorkflow],
  ["oath-upload", oathUploadWorkflow],
  ["ocr", ocrWorkflow],
  ["onboarding", onboardingWorkflow],
  ["old-kronos-reports", kronosReportsWorkflow],
  ["separations", separationsWorkflow],
  ["sharepoint-download", sharepointDownloadWorkflow],
  ["work-study", workStudyWorkflow],
] as const;

describe("workflow runtime policies", () => {
  for (const [name, workflow] of ALL_WORKFLOWS) {
    it(`${name} registers runtimePolicy metadata`, () => {
      assert.ok(workflow.metadata.runtimePolicy, `${name} missing runtimePolicy`);
    });
  }

  it("registers OCR file-scope prep and utility child rules", () => {
    const policy = ocrWorkflow.metadata.runtimePolicy;
    assert.equal(policy?.preview?.rowTypeLabelSuffix, "Preview");
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

  it("registers Oath Upload blocking dependency and tree cancel", () => {
    const policy = oathUploadWorkflow.metadata.runtimePolicy;
    assert.equal(policy?.delegation?.rootRowPersistsThroughChildren, true);
    assert.equal(policy?.delegation?.failedChildBlocksParent, true);
    assert.equal(policy?.rowActions.find((action) => action.kind === "cancel")?.scope, "tree");
  });

  it("registers Emergency Contact OCR-prep and member-row rules", () => {
    const policy = emergencyContactWorkflow.metadata.runtimePolicy;
    assert.equal(policy?.prepRow?.titleSource, "pdf-original-name");
    assert.equal(policy?.memberRow?.titleSource, "person");
  });

  it("standard workflows do not override rowActions", () => {
    for (const [name, workflow] of ALL_WORKFLOWS) {
      if (name === "ocr" || name === "oath-upload" || name === "oath-signature" || name === "emergency-contact") {
        continue;
      }
      const policy = workflow.metadata.runtimePolicy!;
      assert.deepEqual(
        policy.rowActions,
        DEFAULT_WORKFLOW_RUNTIME_POLICY.rowActions,
        `${name} should inherit the default rowActions, not declare a custom set`,
      );
    }
  });
});
