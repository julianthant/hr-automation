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
    const subject = folderSubjectFromLegalLived("Iobub Minecuci", "Iobub Minecuci");
    assert.deepEqual(subject, {
      firstName: "Iobub",
      lastName: "Minecuci",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Minecuci, Iobub EID");
  });

  test("keeps legal first and adds lived first when they differ", () => {
    const subject = folderSubjectFromLegalLived("Euzife Beremu", "Eak Beremu");
    assert.deepEqual(subject, {
      firstName: "Euzife",
      lastName: "Beremu",
      livedName: "Eak",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Beremu, Euzife (Eak) EID");
  });

  test("treats middle tokens of Legal Name as the middle initial source", () => {
    const subject = folderSubjectFromLegalLived("Jisuzi Risq Bagabone", "Jisuzi Risq Bagabone");
    assert.deepEqual(subject, {
      firstName: "Jisuzi",
      lastName: "Bagabone",
      middleName: "Risq",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Bagabone, Jisuzi R. EID");
  });

  test("combines a differing lived first name with a legal middle name", () => {
    const subject = folderSubjectFromLegalLived("Vatudake Zuwilo Yuc", "Lefaz Yuc");
    assert.deepEqual(subject, {
      firstName: "Vatudake",
      lastName: "Yuc",
      middleName: "Zuwilo",
      livedName: "Lefaz",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Yuc, Vatudake (Lefaz) Z. EID");
  });
});

describe("parseOnboardingLegalLivedCsv", () => {
  test("finds Email in column 0 (the onboarding roster header layout)", () => {
    const csv = [
      ",,,,,",
      "Email,Legal Name,Lived Name",
      "fixture019@example.edu,Euzife Beremu,Eak Beremu",
      "fixture043@example.edu,Iobub Minecuci,Iobub Minecuci",
    ].join("\n");
    const entries = parseOnboardingLegalLivedCsv(csv);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      email: "fixture019@example.edu",
      legalName: "Euzife Beremu",
      livedName: "Eak Beremu",
    });
  });
});

describe("lookupLegalLivedEntry", () => {
  test("matches email case-insensitively", () => {
    const found = lookupLegalLivedEntry(
      [{ email: "fixture019@example.edu", legalName: "Euzife Beremu", livedName: "Eak Beremu" }],
      "fixture019@example.edu",
    );
    assert.equal(found?.legalName, "Euzife Beremu");
  });
});

describe("resolveCrmDocDownloadNameFields", () => {
  const roster = [
    { email: "fixture019@example.edu", legalName: "Euzife Beremu", livedName: "Eak Beremu" },
    { email: "fixture043@example.edu", legalName: "Iobub Minecuci", livedName: "Iobub Minecuci" },
  ];

  test("keeps explicit first/last on the input (operator override)", () => {
    const named = resolveCrmDocDownloadNameFields(
      { email: "fixture019@example.edu", firstName: "Euzife", lastName: "Beremu", livedName: "Eak" },
      roster,
    );
    assert.deepEqual(named, {
      firstName: "Euzife",
      lastName: "Beremu",
      livedName: "Eak",
    });
  });

  test("fills legal vs lived from the roster when the dashboard run has only email", () => {
    const named = resolveCrmDocDownloadNameFields({ email: "fixture019@example.edu" }, roster);
    assert.deepEqual(named, {
      firstName: "Euzife",
      lastName: "Beremu",
      livedName: "Eak",
    });
  });

  test("throws when the email is not on the roster rather than falling back to CRM", () => {
    assert.throws(
      () => resolveCrmDocDownloadNameFields({ email: "fixture036@example.edu" }, roster),
      /fixture036@example.edu.*onboarding roster/i,
    );
  });

  test("returns null for an EID-only run so the caller can match after extracting CRM emails", () => {
    assert.equal(
      resolveCrmDocDownloadNameFields({ emplId: "10090305" }, roster),
      null,
    );
  });
});

describe("resolveFolderSubjectFromRecordEmails", () => {
  const roster = [
    { email: "fixture019@example.edu", legalName: "Euzife Beremu", livedName: "Eak Beremu" },
  ];

  test("matches the personal email on the CRM record to the roster", () => {
    const subject = resolveFolderSubjectFromRecordEmails(
      [null, "fixture019@example.edu"],
      roster,
      "10090305",
    );
    assert.equal(subject.livedName, "Eak");
  });

  test("throws when none of the record emails are on the roster", () => {
    assert.throws(
      () => resolveFolderSubjectFromRecordEmails(["fixture046@example.edu"], roster, "10090305"),
      /EID 10090305.*fixture046@example.edu/i,
    );
  });
});

describe("loadOnboardingLegalLivedEntries", () => {
  test("reads a latin-1 CSV whose Email column is first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-doc-roster-"));
    const path = join(dir, "onboarding-roster.csv");
    try {
      const body = "Email,Legal Name,Lived Name\r\nfixture019@example.edu,Euzife Beremu,Eak Beremu\r\n";
      await writeFile(path, Buffer.from(body + "\xa0", "latin1"));
      const entries = await loadOnboardingLegalLivedEntries(path);
      assert.equal(entries[0]?.legalName, "Euzife Beremu");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("findOnboardingLegalLivedRosterPath", () => {
  test("prefers a file whose name contains onboarding", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-doc-roster-find-"));
    try {
      await writeFile(join(dir, "action-history.csv"), "Email,Legal Name,Lived Name\nfixture001@example.edu,A B,A B\n");
      await writeFile(join(dir, "onboarding-sept.csv"), "Email,Legal Name,Lived Name\nfixture013@example.edu,C D,C D\n");
      const found = findOnboardingLegalLivedRosterPath(dir);
      assert.equal(found, join(dir, "onboarding-sept.csv"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
