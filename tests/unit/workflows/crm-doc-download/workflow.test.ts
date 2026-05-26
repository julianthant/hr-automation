import { test } from "vitest";
import assert from "node:assert/strict";
import {
  CrmDocDownloadInputSchema,
  crmDocDownloadWorkflow,
} from "../../../../src/workflows/crm-doc-download/index.js";

test("crm-doc-download schema accepts email-only utility runs", () => {
  const parsed = CrmDocDownloadInputSchema.parse({ email: "jane@example.edu" });
  assert.equal(parsed.email, "jane@example.edu");
  assert.deepEqual(parsed.docIndices, undefined);
});

test("crm-doc-download schema accepts EID-only utility runs", () => {
  const parsed = CrmDocDownloadInputSchema.parse({ emplId: "10873698" });
  assert.equal(parsed.emplId, "10873698");
  assert.deepEqual(parsed.docIndices, undefined);
});

test("crm-doc-download schema accepts delegated display fields", () => {
  const parsed = CrmDocDownloadInputSchema.parse({
    email: "jane@example.edu",
    firstName: "Jane",
    lastName: "Doe",
    middleName: "A",
    parentSubject: "Onboarding: jane@example.edu",
    taskGroupId: "parent-run-1",
    docIndices: [0, 2],
  });
  assert.equal(parsed.lastName, "Doe");
  assert.deepEqual(parsed.docIndices, [0, 2]);
});

test("crm-doc-download workflow is a utility workflow with CRM auth", () => {
  assert.equal(crmDocDownloadWorkflow.config.name, "crm-doc-download");
  assert.deepEqual(crmDocDownloadWorkflow.config.systems.map((s) => s.id), ["crm"]);
  assert.equal(crmDocDownloadWorkflow.config.authSteps, true);
  assert.equal(
    crmDocDownloadWorkflow.config.getId?.({ email: "jane@example.edu" }),
    "jane@example.edu",
  );
  assert.equal(
    crmDocDownloadWorkflow.config.getId?.({ emplId: "10873698" }),
    "10873698",
  );
  assert.equal(
    crmDocDownloadWorkflow.config.deriveItemId?.({ emplId: "10873698" }),
    "10873698",
  );
});
