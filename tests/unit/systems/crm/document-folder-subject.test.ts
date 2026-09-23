import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { folderSubjectFromLegalLived } from "../../../../src/systems/crm/document-folder-subject.js";
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
    const subject = folderSubjectFromLegalLived("Fangjie Yu", "Cici Yu");
    assert.deepEqual(subject, {
      firstName: "Fangjie",
      lastName: "Yu",
      livedName: "Cici",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Yu, Fangjie (Cici) EID");
  });

  test("treats middle tokens of Legal Name as the middle initial source", () => {
    const subject = folderSubjectFromLegalLived("Aditya Gowda Yogananda", "Aditya Yogananda");
    assert.deepEqual(subject, {
      firstName: "Aditya",
      lastName: "Yogananda",
      middleName: "Gowda",
    });
    assert.equal(buildCrmDocumentFolderName(subject), "Yogananda, Aditya G. EID");
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
