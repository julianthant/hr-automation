import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildOperatorSubject,
  operatorSubjectData,
  resolveOperatorSubjectFromData,
} from "../../../src/domain/operator-subject.js";
import { getAll } from "../../../src/core/registry.js";
import "../../../src/workflows/onboarding/index.js";
import "../../../src/workflows/separations/index.js";
import "../../../src/workflows/old-kronos-reports/index.js";
import "../../../src/workflows/work-study/index.js";
import "../../../src/workflows/emergency-contact/index.js";
import "../../../src/workflows/eid-lookup/index.js";
import "../../../src/workflows/oath-signature/index.js";
import "../../../src/workflows/oath-upload/index.js";
import "../../../src/workflows/ocr/index.js";
import "../../../src/workflows/sharepoint-download/index.js";

describe("operator subject", () => {
  it("builds a person subject with normalized name", () => {
    assert.deepEqual(buildOperatorSubject({ kind: "person", value: "zaw, hein thant" }), {
      kind: "person",
      label: "Zaw, Hein Thant",
    });
  });

  it("builds an EID subject with an EID prefix", () => {
    assert.deepEqual(buildOperatorSubject({ kind: "eid", value: "00123456" }), {
      kind: "eid",
      label: "EID 00123456",
    });
  });

  it("serializes subject fields into tracker data", () => {
    assert.deepEqual(operatorSubjectData({ kind: "document", label: "Separation 3930" }), {
      __subject: "Separation 3930",
      __subjectKind: "document",
    });
  });

  it("resolves subject from tracker data before falling back to id", () => {
    assert.equal(resolveOperatorSubjectFromData({ __subject: "EID 00123456" }, "raw-id"), "EID 00123456");
    assert.equal(resolveOperatorSubjectFromData({}, "raw-id"), "raw-id");
  });
});

describe("registered workflow subject coverage", () => {
  it("declares operator subjects for every current workflow", () => {
    const required = new Set([
      "onboarding",
      "separations",
      "kronos-reports",
      "work-study",
      "emergency-contact",
      "eid-lookup",
      "oath-signature",
      "oath-upload",
      "ocr",
      "sharepoint-download",
    ]);
    const missing = getAll()
      .filter((metadata) => required.has(metadata.name))
      .filter((metadata) => !metadata.hasOperatorSubject)
      .map((metadata) => metadata.name)
      .sort();
    assert.deepEqual(missing, []);
  });
});
