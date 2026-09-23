import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { folderSubjectFromLegalLived } from "../../../../src/systems/crm/document-folder-subject.js";
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
    const subject = folderSubjectFromLegalLived("Person 686", "Person 450");
    assert.deepEqual(subject, {
      firstName: "Fangjie",
      lastName: "Yu",
      livedName: "Cici",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Person 686 (Cici) EID");
  });

  test("treats middle tokens of Legal Name as the middle initial source", () => {
    const subject = folderSubjectFromLegalLived("Aditya Gowda Yogananda", "Person 30");
    assert.deepEqual(subject, {
      firstName: "Aditya",
      lastName: "Yogananda",
      middleName: "Gowda",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Person 30 G. EID");
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
