import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { join, dirname, basename } from "node:path";
import {
  CrmDocDownloadInputSchema,
  crmDocDownloadWorkflow,
} from "../../../../src/workflows/crm-doc-download/index.js";
import {
  resolveArchivePath,
  emplIdMatchesIdentity,
  emailMatchesIdentity,
} from "../../../../src/workflows/crm-doc-download/workflow.js";
import { PATHS } from "../../../../src/config.js";

test("crm-doc-download schema accepts email-only utility runs", () => {
  const parsed = CrmDocDownloadInputSchema.parse({ email: "jane@example.edu" });
  assert.equal(parsed.email, "jane@example.edu");
  assert.deepEqual(parsed.docIndices, undefined);
});

test("crm-doc-download schema accepts EID-only utility runs", () => {
  const parsed = CrmDocDownloadInputSchema.parse({ emplId: "10090305" });
  assert.equal(parsed.emplId, "10090305");
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
    emplId: "10090305",
    firstName: "John",
    lastName: "Smith",
    livedName: "Jofipe",
  });
  assert.equal(parsed.livedName, "Jofipe");
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
    crmDocDownloadWorkflow.config.getId?.({ emplId: "10090305" }),
    "10090305",
  );
  assert.equal(
    crmDocDownloadWorkflow.config.deriveItemId?.({ emplId: "10090305" }),
    "10090305",
  );
});

describe("emplIdMatchesIdentity", () => {
  test("matches when the record EID equals the target EID", () => {
    assert.equal(emplIdMatchesIdentity("10090305", "10090305"), true);
  });

  test("matches through non-digit formatting on either side", () => {
    assert.equal(emplIdMatchesIdentity(" 100-90305 ", "10090305"), true);
  });

  test("rejects a different EID (the CRM fuzzy-search wrong-person case)", () => {
    assert.equal(emplIdMatchesIdentity("99999999", "10090305"), false);
  });

  test("rejects a null/empty record EID rather than treating it as a match", () => {
    assert.equal(emplIdMatchesIdentity(null, "10090305"), false);
    assert.equal(emplIdMatchesIdentity("", "10090305"), false);
  });
});

describe("emailMatchesIdentity", () => {
  test("matches when any candidate email equals the target, case-insensitively", () => {
    assert.equal(
      emailMatchesIdentity([null, "fixture022@example.edu"], "fixture022@example.edu"),
      true,
    );
  });

  test("matches on the first candidate even when others are null", () => {
    assert.equal(emailMatchesIdentity(["jane@example.edu", null], "jane@example.edu"), true);
  });

  test("rejects when no candidate matches (the wrong-person case)", () => {
    assert.equal(
      emailMatchesIdentity(["someone.else@example.edu", null], "jane@example.edu"),
      false,
    );
  });

  test("rejects when both candidates are absent", () => {
    assert.equal(emailMatchesIdentity([null, undefined], "jane@example.edu"), false);
  });
});

describe("resolveArchivePath", () => {
  const folder = join(PATHS.onboardingDocsDir, "Smith, John (Jofipe) Mepafic EID");

  test("standalone run → its own zip next to and named after the folder", () => {
    const archive = resolveArchivePath(folder, undefined);
    assert.equal(dirname(archive), PATHS.onboardingDocsDir);
    assert.equal(basename(archive), "Smith, John (Jofipe) Mepafic EID.zip");
  });

  test("batched run → one combined zip in the onboarding dir, keyed by the batch run id", () => {
    const archive = resolveArchivePath(folder, "a3f10b2c-9d4e-4f6a-8b1c-1122334455ff");
    assert.equal(dirname(archive), PATHS.onboardingDocsDir);
    assert.match(basename(archive), /^Onboarding Docs \d{4}-\d{2}-\d{2} a3f10b2c\.zip$/);
  });

  test("all members of one batch resolve the SAME archive path", () => {
    const parentRunId = "ffffffff-0000-1111-2222-333344445555";
    const a = resolveArchivePath(join(PATHS.onboardingDocsDir, "Person 905 EID"), parentRunId);
    const b = resolveArchivePath(join(PATHS.onboardingDocsDir, "Roe, Rick EID"), parentRunId);
    assert.equal(a, b);
  });
});
