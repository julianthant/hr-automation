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
    const subject = folderSubjectFromLegalLived("Ineza Marekani", "Ineza Marekani");
    assert.deepEqual(subject, {
      firstName: "Ineza",
      lastName: "Marekani",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Marekani, Ineza EID");
  });

  test("keeps legal first and adds lived first when they differ", () => {
    const subject = folderSubjectFromLegalLived("Elijah Breuer", "Eli Breuer");
    assert.deepEqual(subject, {
      firstName: "Elijah",
      lastName: "Breuer",
      livedName: "Eli",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Breuer, Elijah (Eli) EID");
  });

  test("treats middle tokens of Legal Name as the middle initial source", () => {
    const subject = folderSubjectFromLegalLived("Joanna Ruiz Bustillo", "Joanna Ruiz Bustillo");
    assert.deepEqual(subject, {
      firstName: "Joanna",
      lastName: "Bustillo",
      middleName: "Ruiz",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Bustillo, Joanna R. EID");
  });

  test("combines a differing lived first name with a legal middle name", () => {
    const subject = folderSubjectFromLegalLived("Victoria Ziling Yin", "Linda Yin");
    assert.deepEqual(subject, {
      firstName: "Victoria",
      lastName: "Yin",
      middleName: "Ziling",
      livedName: "Linda",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Yin, Victoria (Linda) Z. EID");
  });
});

describe("parseOnboardingLegalLivedCsv", () => {
  test("finds Email in column 0 (the onboarding roster header layout)", () => {
    const csv = [
      ",,,,,",
      "Email,Legal Name,Lived Name",
      "elikb06@gmail.com,Elijah Breuer,Eli Breuer",
      "nezamar76@gmail.com,Ineza Marekani,Ineza Marekani",
    ].join("\n");
    const entries = parseOnboardingLegalLivedCsv(csv);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      email: "elikb06@gmail.com",
      legalName: "Elijah Breuer",
      livedName: "Eli Breuer",
    });
  });
});

describe("lookupLegalLivedEntry", () => {
  test("matches email case-insensitively", () => {
    const found = lookupLegalLivedEntry(
      [{ email: "EliKB06@gmail.com", legalName: "Elijah Breuer", livedName: "Eli Breuer" }],
      "elikb06@gmail.com",
    );
    assert.equal(found?.legalName, "Elijah Breuer");
  });
});

describe("resolveCrmDocDownloadNameFields", () => {
  const roster = [
    { email: "elikb06@gmail.com", legalName: "Elijah Breuer", livedName: "Eli Breuer" },
    { email: "nezamar76@gmail.com", legalName: "Ineza Marekani", livedName: "Ineza Marekani" },
  ];

  test("keeps explicit first/last on the input (operator override)", () => {
    const named = resolveCrmDocDownloadNameFields(
      { email: "elikb06@gmail.com", firstName: "Elijah", lastName: "Breuer", livedName: "Eli" },
      roster,
    );
    assert.deepEqual(named, {
      firstName: "Elijah",
      lastName: "Breuer",
      livedName: "Eli",
    });
  });

  test("fills legal vs lived from the roster when the dashboard run has only email", () => {
    const named = resolveCrmDocDownloadNameFields({ email: "elikb06@gmail.com" }, roster);
    assert.deepEqual(named, {
      firstName: "Elijah",
      lastName: "Breuer",
      livedName: "Eli",
    });
  });

  test("throws when the email is not on the roster rather than falling back to CRM", () => {
    assert.throws(
      () => resolveCrmDocDownloadNameFields({ email: "missing@ucsd.edu" }, roster),
      /missing@ucsd.edu.*onboarding roster/i,
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
    { email: "elikb06@gmail.com", legalName: "Elijah Breuer", livedName: "Eli Breuer" },
  ];

  test("matches the personal email on the CRM record to the roster", () => {
    const subject = resolveFolderSubjectFromRecordEmails(
      [null, "elikb06@gmail.com"],
      roster,
      "10873698",
    );
    assert.equal(subject.livedName, "Eli");
  });

  test("throws when none of the record emails are on the roster", () => {
    assert.throws(
      () => resolveFolderSubjectFromRecordEmails(["other@ucsd.edu"], roster, "10873698"),
      /EID 10873698.*other@ucsd.edu/i,
    );
  });
});

describe("loadOnboardingLegalLivedEntries", () => {
  test("reads a latin-1 CSV whose Email column is first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-doc-roster-"));
    const path = join(dir, "onboarding-roster.csv");
    try {
      const body = "Email,Legal Name,Lived Name\r\nelikb06@gmail.com,Elijah Breuer,Eli Breuer\r\n";
      await writeFile(path, Buffer.from(body + "\xa0", "latin1"));
      const entries = await loadOnboardingLegalLivedEntries(path);
      assert.equal(entries[0]?.legalName, "Elijah Breuer");
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
