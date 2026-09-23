import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findOnboardingLegalLivedRosterPath,
  folderSubjectFromLegalLived,
  loadOnboardingLegalLivedEntries,
  lookupLegalLivedEntry,
  parseOnboardingLegalLivedCsv,
  resolveCrmDocDownloadNameFields,
  resolveFolderSubjectFromRecordEmails,
} from "../../../../src/workflows/crm-doc-download/folder-names.js";
import { buildCrmDocumentFolderName } from "../../../../src/systems/crm/idocs-download.js";

describe("folderSubjectFromLegalLived", () => {
  test("uses legal first/last and omits lived when the first names match", () => {
    const subject = folderSubjectFromLegalLived("Person 831", "Person 831");
    assert.deepEqual(subject, {
      firstName: "Ineza",
      lastName: "Marekani",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Person 831 EID");
  });

  test("keeps legal first and adds lived first when they differ", () => {
    const subject = folderSubjectFromLegalLived("Person 597", "Person 593");
    assert.deepEqual(subject, {
      firstName: "Elijah",
      lastName: "Breuer",
      livedName: "Eli",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Person 597 (Eli) EID");
  });

  test("treats middle tokens of Legal Name as the middle initial source", () => {
    const subject = folderSubjectFromLegalLived("Person 1005", "Person 1005");
    assert.deepEqual(subject, {
      firstName: "Joanna",
      lastName: "Bustillo",
      middleName: "Ruiz",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Person 1004 R. EID");
  });

  test("combines a differing lived first name with a legal middle name", () => {
    const subject = folderSubjectFromLegalLived("Person 2056", "Person 1322");
    assert.deepEqual(subject, {
      firstName: "Victoria",
      lastName: "Yin",
      middleName: "Ziling",
      livedName: "Linda",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Person 2055 (Linda) Z. EID");
  });
});

describe("parseOnboardingLegalLivedCsv", () => {
  test("finds Email in column 0 (the onboarding roster header layout)", () => {
    const csv = [
      ",,,,,",
      "Email,Legal Name,Lived Name",
      "person378@example.com,Person 597,Person 593",
      "person875@example.com,Person 831,Person 831",
    ].join("\n");
    const entries = parseOnboardingLegalLivedCsv(csv);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      email: "person378@example.com",
      legalName: "Person 597",
      livedName: "Person 593",
    });
  });
});

describe("lookupLegalLivedEntry", () => {
  test("matches email case-insensitively", () => {
    const found = lookupLegalLivedEntry(
      [{ email: "person378@example.com", legalName: "Person 597", livedName: "Person 593" }],
      "person378@example.com",
    );
    assert.equal(found?.legalName, "Person 597");
  });
});

describe("resolveCrmDocDownloadNameFields", () => {
  const roster = [
    { email: "person378@example.com", legalName: "Person 597", livedName: "Person 593" },
    { email: "person875@example.com", legalName: "Person 831", livedName: "Person 831" },
  ];

  test("keeps explicit first/last on the input (operator override)", () => {
    const named = resolveCrmDocDownloadNameFields(
      { email: "person378@example.com", firstName: "Elijah", lastName: "Breuer", livedName: "Eli" },
      roster,
    );
    assert.deepEqual(named, {
      firstName: "Elijah",
      lastName: "Breuer",
      livedName: "Eli",
    });
  });

  test("fills legal vs lived from the roster when the dashboard run has only email", () => {
    const named = resolveCrmDocDownloadNameFields({ email: "person378@example.com" }, roster);
    assert.deepEqual(named, {
      firstName: "Elijah",
      lastName: "Breuer",
      livedName: "Eli",
    });
  });

  test("throws when the email is not on the roster rather than falling back to CRM", () => {
    assert.throws(
      () => resolveCrmDocDownloadNameFields({ email: "person@example.edu" }, roster),
      /person@example.edu.*onboarding roster/i,
    );
  });

  test("returns null for an EID-only run so the caller can match after extracting CRM emails", () => {
    assert.equal(
      resolveCrmDocDownloadNameFields({ emplId: "10873698" }, roster),
      null,
    );
  });
});

describe("resolveFolderSubjectFromRecordEmails", () => {
  const roster = [
    { email: "person378@example.com", legalName: "Person 597", livedName: "Person 593" },
  ];

  test("matches the personal email on the CRM record to the roster", () => {
    const subject = resolveFolderSubjectFromRecordEmails(
      [null, "person378@example.com"],
      roster,
      "10873698",
    );
    assert.equal(subject.livedName, "Eli");
  });

  test("throws when none of the record emails are on the roster", () => {
    assert.throws(
      () => resolveFolderSubjectFromRecordEmails(["person@example.edu"], roster, "10873698"),
      /EID 10873698.*person@example.edu/i,
    );
  });
});

describe("loadOnboardingLegalLivedEntries", () => {
  test("reads a latin-1 CSV whose Email column is first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-doc-roster-"));
    const path = join(dir, "onboarding-roster.csv");
    try {
      const body = "Email,Legal Name,Lived Name\r\nelikb06@gmail.com,Person 597,Person 593\r\n";
      await writeFile(path, Buffer.from(body + "\xa0", "latin1"));
      const entries = await loadOnboardingLegalLivedEntries(path);
      assert.equal(entries[0]?.legalName, "Person 597");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("findOnboardingLegalLivedRosterPath", () => {
  test("prefers a file whose name contains onboarding", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-doc-roster-find-"));
    try {
      await writeFile(join(dir, "action-history.csv"), "Email,Legal Name,Lived Name\na@b.com,A B,A B\n");
      await writeFile(join(dir, "onboarding-sept.csv"), "Email,Legal Name,Lived Name\nc@d.com,C D,C D\n");
      const found = findOnboardingLegalLivedRosterPath(dir);
      assert.equal(found, join(dir, "onboarding-sept.csv"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
