import { privateValue } from "../../../../src/private-data.js";
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { folderSubjectFromLegalLived } from "../../../../src/systems/crm/document-folder-subject.js";
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
    const subject = folderSubjectFromLegalLived(privateValue("name:37c0baf25a2d8b5b"), privateValue("name:32ffb91e7937fa26"));
    assert.deepEqual(subject, {
      firstName: "Fangjie",
      lastName: "Yu",
      livedName: "Cici",
    });
    assert.equal(buildCrmDocumentFolderName(subject), privateValue("name:ad568a5c6559e385") + " (Cici) EID");
  });

  test("treats middle tokens of Legal Name as the middle initial source", () => {
    const subject = folderSubjectFromLegalLived("Aditya Gowda Yogananda", privateValue("name:3e31b8d3f2aba742"));
    assert.deepEqual(subject, {
      firstName: "Aditya",
      lastName: "Yogananda",
      middleName: "Gowda",
    });
    assert.equal(buildCrmDocumentFolderName(subject), privateValue("name:65350f4643b6689e") + " G. EID");
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
