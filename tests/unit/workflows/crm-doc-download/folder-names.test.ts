import { privateValue } from "../../../../src/private-data.js";
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
    const subject = folderSubjectFromLegalLived(privateValue("name:6168ff06af447daa"), privateValue("name:6168ff06af447daa"));
    assert.deepEqual(subject, {
      firstName: "Ineza",
      lastName: "Marekani",
    });
    assert.equal(buildCrmDocumentFolderName(subject), privateValue("name:f74ff45ebc16a356") + " EID");
  });

  test("keeps legal first and adds lived first when they differ", () => {
    const subject = folderSubjectFromLegalLived(privateValue("name:07b70263ba91e14d"), privateValue("name:fd6f43e30607c9b0"));
    assert.deepEqual(subject, {
      firstName: "Elijah",
      lastName: "Breuer",
      livedName: "Eli",
    });
    assert.equal(buildCrmDocumentFolderName(subject), privateValue("name:ce8a4c92791c9837") + " (Eli) EID");
  });

  test("treats middle tokens of Legal Name as the middle initial source", () => {
    const subject = folderSubjectFromLegalLived(privateValue("name:f49b5924cc2d3f1d"), privateValue("name:f49b5924cc2d3f1d"));
    assert.deepEqual(subject, {
      firstName: "Joanna",
      lastName: "Bustillo",
      middleName: "Ruiz",
    });
    assert.equal(buildCrmDocumentFolderName(subject), privateValue("name:6cd8db152049272d") + " R. EID");
  });

  test("combines a differing lived first name with a legal middle name", () => {
    const subject = folderSubjectFromLegalLived(privateValue("name:7f1fca2db867064b"), privateValue("name:68d9acf368143e55"));
    assert.deepEqual(subject, {
      firstName: "Victoria",
      lastName: "Yin",
      middleName: "Ziling",
      livedName: "Linda",
    });
    assert.equal(buildCrmDocumentFolderName(subject), privateValue("name:40dd44ffef62fd97") + " (Linda) Z. EID");
  });
});

describe("parseOnboardingLegalLivedCsv", () => {
  test("finds Email in column 0 (the onboarding roster header layout)", () => {
    const csv = [
      ",,,,,",
      "Email,Legal Name,Lived Name",
      privateValue("email:7b43427814742d74") + "," + privateValue("name:07b70263ba91e14d") + "," + privateValue("name:fd6f43e30607c9b0"),
      privateValue("email:6901c1a3302e3006") + "," + privateValue("name:6168ff06af447daa") + "," + privateValue("name:6168ff06af447daa"),
    ].join("\n");
    const entries = parseOnboardingLegalLivedCsv(csv);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      email: privateValue("email:7b43427814742d74"),
      legalName: privateValue("name:07b70263ba91e14d"),
      livedName: privateValue("name:fd6f43e30607c9b0"),
    });
  });
});

describe("lookupLegalLivedEntry", () => {
  test("matches email case-insensitively", () => {
    const found = lookupLegalLivedEntry(
      [{ email: privateValue("email:2543bb0ea3fa42b3"), legalName: privateValue("name:07b70263ba91e14d"), livedName: privateValue("name:fd6f43e30607c9b0") }],
      privateValue("email:7b43427814742d74"),
    );
    assert.equal(found?.legalName, privateValue("name:07b70263ba91e14d"));
  });
});

describe("resolveCrmDocDownloadNameFields", () => {
  const roster = [
    { email: privateValue("email:7b43427814742d74"), legalName: privateValue("name:07b70263ba91e14d"), livedName: privateValue("name:fd6f43e30607c9b0") },
    { email: privateValue("email:6901c1a3302e3006"), legalName: privateValue("name:6168ff06af447daa"), livedName: privateValue("name:6168ff06af447daa") },
  ];

  test("keeps explicit first/last on the input (operator override)", () => {
    const named = resolveCrmDocDownloadNameFields(
      { email: privateValue("email:7b43427814742d74"), firstName: "Elijah", lastName: "Breuer", livedName: "Eli" },
      roster,
    );
    assert.deepEqual(named, {
      firstName: "Elijah",
      lastName: "Breuer",
      livedName: "Eli",
    });
  });

  test("fills legal vs lived from the roster when the dashboard run has only email", () => {
    const named = resolveCrmDocDownloadNameFields({ email: privateValue("email:7b43427814742d74") }, roster);
    assert.deepEqual(named, {
      firstName: "Elijah",
      lastName: "Breuer",
      livedName: "Eli",
    });
  });

  test("throws when the email is not on the roster rather than falling back to CRM", () => {
    assert.throws(
      () => resolveCrmDocDownloadNameFields({ email: privateValue("ucsd:7a9fd24f1f91d1c6") }, roster),
      new RegExp(privateValue("ucsd:7a9fd24f1f91d1c6") + ".*onboarding roster", "i"),
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
    { email: privateValue("email:7b43427814742d74"), legalName: privateValue("name:07b70263ba91e14d"), livedName: privateValue("name:fd6f43e30607c9b0") },
  ];

  test("matches the personal email on the CRM record to the roster", () => {
    const subject = resolveFolderSubjectFromRecordEmails(
      [null, privateValue("email:7b43427814742d74")],
      roster,
      "10873698",
    );
    assert.equal(subject.livedName, "Eli");
  });

  test("throws when none of the record emails are on the roster", () => {
    assert.throws(
      () => resolveFolderSubjectFromRecordEmails([privateValue("ucsd:e667452e4d8f6226")], roster, "10873698"),
      new RegExp("EID 10873698.*" + privateValue("ucsd:e667452e4d8f6226"), "i"),
    );
  });
});

describe("loadOnboardingLegalLivedEntries", () => {
  test("reads a latin-1 CSV whose Email column is first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-doc-roster-"));
    const path = join(dir, "onboarding-roster.csv");
    try {
      const body = "Email,Legal Name,Lived Name\r\nelikb06@gmail.com," + privateValue("name:07b70263ba91e14d") + "," + privateValue("name:fd6f43e30607c9b0") + "\r\n";
      await writeFile(path, Buffer.from(body + "\xa0", "latin1"));
      const entries = await loadOnboardingLegalLivedEntries(path);
      assert.equal(entries[0]?.legalName, privateValue("name:07b70263ba91e14d"));
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
