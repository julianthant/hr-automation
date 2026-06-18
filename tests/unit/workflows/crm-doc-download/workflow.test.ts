import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { join, dirname, basename } from "node:path";
import {
  CrmDocDownloadInputSchema,
  crmDocDownloadWorkflow,
} from "../../../../src/workflows/crm-doc-download/index.js";
import { resolveArchivePath } from "../../../../src/workflows/crm-doc-download/workflow.js";
import { PATHS } from "../../../../src/config.js";

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

test("crm-doc-download schema accepts a lived name override", () => {
  const parsed = CrmDocDownloadInputSchema.parse({
    emplId: "10873698",
    firstName: "John",
    lastName: "Smith",
    livedName: "Johnny",
  });
  assert.equal(parsed.livedName, "Johnny");
});

test("crm-doc-download workflow is a utility workflow with CRM auth", () => {
  assert.equal(crmDocDownloadWorkflow.config.name, "crm-doc-download");
  assert.deepEqual(crmDocDownloadWorkflow.config.systems.map((s) => s.id), ["crm"]);
  assert.equal(crmDocDownloadWorkflow.config.authSteps, true);
  assert.deepEqual(crmDocDownloadWorkflow.config.steps, ["search-record", "download", "archive"]);
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

describe("resolveArchivePath", () => {
  const folder = join(PATHS.onboardingDocsDir, "Smith, John (Johnny) Michael EID");

  test("standalone run → its own zip next to and named after the folder", () => {
    const archive = resolveArchivePath(folder, undefined);
    assert.equal(dirname(archive), PATHS.onboardingDocsDir);
    assert.equal(basename(archive), "Smith, John (Johnny) Michael EID.zip");
  });

  test("batched run → one combined zip in the onboarding dir, keyed by the batch run id", () => {
    const archive = resolveArchivePath(folder, "a3f10b2c-9d4e-4f6a-8b1c-1122334455ff");
    assert.equal(dirname(archive), PATHS.onboardingDocsDir);
    assert.match(basename(archive), /^Onboarding Docs \d{4}-\d{2}-\d{2} a3f10b2c\.zip$/);
  });

  test("all members of one batch resolve the SAME archive path", () => {
    const parentRunId = "ffffffff-0000-1111-2222-333344445555";
    const a = resolveArchivePath(join(PATHS.onboardingDocsDir, "Doe, Jane EID"), parentRunId);
    const b = resolveArchivePath(join(PATHS.onboardingDocsDir, "Roe, Rick EID"), parentRunId);
    assert.equal(a, b);
  });
});
