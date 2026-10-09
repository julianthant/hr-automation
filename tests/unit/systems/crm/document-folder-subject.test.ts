import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { folderSubjectFromLegalLived } from "../../../../src/systems/crm/document-folder-subject.js";
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
    const subject = folderSubjectFromLegalLived("Fucaniw Yo", "Cero Yo");
    assert.deepEqual(subject, {
      firstName: "Fucaniw",
      lastName: "Yo",
      livedName: "Cero",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Yo, Fucaniw (Cero) EID");
  });

  test("treats middle tokens of Legal Name as the middle initial source", () => {
    const subject = folderSubjectFromLegalLived("Aoburo Genep Yeletunuc", "Aoburo Yeletunuc");
    assert.deepEqual(subject, {
      firstName: "Aoburo",
      lastName: "Yeletunuc",
      middleName: "Genep",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Yeletunuc, Aoburo G. EID");
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
