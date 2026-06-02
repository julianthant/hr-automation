import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  verifyOcrFormSpec,
  VerifyOcrRecordSchema,
  VerifyPreviewRecordSchema,
  buildVerifyChecks,
  applyPersonLookupToVerifyRecord,
  applyI9ToVerifyRecord,
  type VerifyPreviewRecord,
  type VerifyCheck,
} from "../../../../../src/services/ocr/forms/verify.js";

function findCheck(checks: VerifyCheck[], key: string): VerifyCheck {
  const c = checks.find((x) => x.key === key);
  assert.ok(c, `expected a "${key}" check`);
  return c;
}

function makePreview(over: Partial<VerifyPreviewRecord> = {}): VerifyPreviewRecord {
  return {
    formKind: "oath",
    sourcePage: 1,
    printedName: null,
    employeeId: "",
    paperEmploymentDate: null,
    paperDateSigned: null,
    employeeSigned: null,
    officerSigned: null,
    paperOfficialName: null,
    documentType: "expected",
    originallyMissing: [],
    notes: [],
    name: "",
    matchState: "extracted",
    selected: true,
    warnings: [],
    checks: [],
    ...over,
  };
}

describe("VerifyOcrRecordSchema", () => {
  it("parses a valid oath record", () => {
    const parsed = VerifyOcrRecordSchema.parse({
      formKind: "oath",
      sourcePage: 1,
      printedName: "Doe, Jane A",
      employeeId: "10000001",
      paperEmploymentDate: "4-1-26",
      paperDateSigned: "4-23-26",
      employeeSigned: true,
      officerSigned: true,
      paperOfficialName: "Smith, John",
    });
    assert.equal(parsed.formKind, "oath");
    assert.equal(parsed.printedName, "Doe, Jane A");
    assert.equal(parsed.officerSigned, true);
    // defaults applied
    assert.deepEqual(parsed.originallyMissing, []);
    assert.deepEqual(parsed.notes, []);
    assert.equal(parsed.documentType, "expected");
  });

  it("parses a valid emergency-contact record", () => {
    const parsed = VerifyOcrRecordSchema.parse({
      formKind: "emergency-contact",
      sourcePage: 2,
      printedName: "Roe, Sam",
      employeeId: null,
      originallyMissing: ["employeeId"],
    });
    assert.equal(parsed.formKind, "emergency-contact");
    assert.equal(parsed.employeeId, null);
    assert.deepEqual(parsed.originallyMissing, ["employeeId"]);
  });

  it("defaults formKind to unknown when omitted", () => {
    const parsed = VerifyOcrRecordSchema.parse({ sourcePage: 3 });
    assert.equal(parsed.formKind, "unknown");
  });
});

describe("VerifyPreviewRecordSchema", () => {
  it("extends the OCR record with resolved + enrichment fields", () => {
    const parsed = VerifyPreviewRecordSchema.parse({
      formKind: "oath",
      sourcePage: 1,
      name: "Jane Doe",
      employeeId: "10000001",
      matchState: "resolved",
      selected: true,
      warnings: [],
    });
    assert.equal(parsed.name, "Jane Doe");
    assert.equal(parsed.matchState, "resolved");
    // checks defaults to []
    assert.deepEqual(parsed.checks, []);
  });
});

describe("buildVerifyChecks", () => {
  it("oath record with all paper fields → all checks present except activeStatus", () => {
    const rec = makePreview({
      formKind: "oath",
      printedName: "Doe, Jane A",
      employeeId: "10000001",
      name: "Jane Doe",
      paperEmploymentDate: "4-1-26",
      paperDateSigned: "4-23-26",
      paperOfficialName: "Smith, John",
      officerSigned: true,
    });
    const checks = buildVerifyChecks(rec);
    assert.equal(checks.length, 6);
    assert.equal(findCheck(checks, "name").status, "present");
    assert.equal(findCheck(checks, "eid").status, "present");
    assert.equal(findCheck(checks, "employmentDate").status, "present");
    assert.equal(findCheck(checks, "oathDate").status, "present");
    assert.equal(findCheck(checks, "officialSigner").status, "present");
    // activeStatus is never on paper, nothing looked up yet → missing
    assert.equal(findCheck(checks, "activeStatus").status, "missing");
    assert.equal(findCheck(checks, "activeStatus").onPaper, false);
  });

  it("oath record with blanks + enriched values → found", () => {
    const rec = makePreview({
      formKind: "oath",
      printedName: null,
      employeeId: "10000002",
      name: "Jane Doe",
      paperEmploymentDate: null,
      paperDateSigned: null,
      paperOfficialName: null,
      officerSigned: false,
      employmentDate: "2026-04-01",
      oathDate: "2026-04-23",
      officialSigner: "Smith, John",
      activeStatus: "active",
    });
    const checks = buildVerifyChecks(rec);
    // name is blank on paper but resolved via lookup → found
    assert.equal(findCheck(checks, "name").status, "found");
    assert.equal(findCheck(checks, "name").source, "ucpath");
    // eid present on paper (carried into employeeId) → present
    assert.equal(findCheck(checks, "eid").status, "present");
    assert.equal(findCheck(checks, "employmentDate").status, "found");
    assert.equal(findCheck(checks, "employmentDate").source, "crm");
    assert.equal(findCheck(checks, "oathDate").status, "found");
    assert.equal(findCheck(checks, "oathDate").source, "crm");
    assert.equal(findCheck(checks, "officialSigner").status, "found");
    assert.equal(findCheck(checks, "officialSigner").source, "i9");
    assert.equal(findCheck(checks, "activeStatus").status, "found");
  });

  it("oath record with blanks + nothing found → missing", () => {
    const rec = makePreview({
      formKind: "oath",
      printedName: null,
      employeeId: "",
      name: "",
      paperEmploymentDate: null,
      paperDateSigned: null,
      paperOfficialName: null,
      officerSigned: false,
    });
    const checks = buildVerifyChecks(rec);
    for (const key of ["name", "eid", "employmentDate", "oathDate", "officialSigner", "activeStatus"]) {
      assert.equal(findCheck(checks, key).status, "missing", `${key} should be missing`);
    }
  });

  it("officerSigned===true with no printed name still counts the signer as present", () => {
    const rec = makePreview({
      formKind: "oath",
      paperOfficialName: null,
      officerSigned: true,
    });
    const checks = buildVerifyChecks(rec);
    const signer = findCheck(checks, "officialSigner");
    assert.equal(signer.status, "present");
    assert.equal(signer.paperValue, "signed");
  });

  it("emergency-contact record → exactly 3 checks (name, eid, activeStatus)", () => {
    const rec = makePreview({
      formKind: "emergency-contact",
      printedName: "Roe, Sam",
      employeeId: "",
      name: "Sam Roe",
    });
    const checks = buildVerifyChecks(rec);
    assert.equal(checks.length, 3);
    assert.deepEqual(
      checks.map((c) => c.key),
      ["name", "eid", "activeStatus"],
    );
    assert.equal(findCheck(checks, "name").status, "present");
    assert.equal(findCheck(checks, "eid").status, "missing");
    assert.equal(findCheck(checks, "activeStatus").status, "missing");
  });
});

describe("applyPersonLookupToVerifyRecord", () => {
  it("stamps eid, activeStatus, employmentDate, oathDate, name", () => {
    const rec = makePreview({ formKind: "oath", name: "" });
    applyPersonLookupToVerifyRecord(rec, {
      emplId: "10000003",
      activeStatus: "active",
      employmentDate: "2026-04-01",
      oathDate: "2026-04-23",
      searchName: "Doe, Jane",
    });
    assert.equal(rec.employeeId, "10000003");
    assert.equal(rec.activeStatus, "active");
    assert.equal(rec.employmentDate, "2026-04-01");
    assert.equal(rec.oathDate, "2026-04-23");
    assert.equal(rec.name, "Doe, Jane");
  });

  it("falls back to printedName for name when no searchName", () => {
    const rec = makePreview({ formKind: "oath", name: "", printedName: "Roe, Sam" });
    applyPersonLookupToVerifyRecord(rec, { emplId: "10000004" });
    assert.equal(rec.name, "Roe, Sam");
  });

  it("tolerates undefined data", () => {
    const rec = makePreview({ formKind: "oath", name: "Jane Doe", employeeId: "10000005" });
    applyPersonLookupToVerifyRecord(rec, undefined);
    // unchanged
    assert.equal(rec.employeeId, "10000005");
    assert.equal(rec.name, "Jane Doe");
  });
});

describe("applyI9ToVerifyRecord", () => {
  it("stamps the official signer from signerName", () => {
    const rec = makePreview({ formKind: "oath" });
    applyI9ToVerifyRecord(rec, { signerName: "Smith, John", i9Status: "signed" });
    assert.equal(rec.officialSigner, "Smith, John");
  });

  it("leaves officialSigner unset for an empty signerName", () => {
    const rec = makePreview({ formKind: "oath" });
    applyI9ToVerifyRecord(rec, { signerName: "", i9Status: "unsigned" });
    assert.equal(rec.officialSigner, undefined);
  });
});

describe("verifyOcrFormSpec.matchRecord", () => {
  it("produces a preview record with name, eid, and checks (roster ignored)", async () => {
    const preview = await verifyOcrFormSpec.matchRecord({
      record: VerifyOcrRecordSchema.parse({
        formKind: "oath",
        sourcePage: 1,
        printedName: "Doe, Jane A",
        employeeId: "10000001",
        paperDateSigned: "4-23-26",
      }),
      roster: [],
    });
    assert.equal(preview.name, "Doe, Jane A");
    assert.equal(preview.employeeId, "10000001");
    assert.equal(preview.matchState, "extracted");
    assert.equal(preview.selected, true);
    assert.ok(preview.checks.length === 6, "oath preview has 6 checks");
    assert.equal(findCheck(preview.checks, "name").status, "present");
    assert.equal(findCheck(preview.checks, "oathDate").status, "present");
  });

  it("normalizes a malformed form EID to empty (eid check missing)", async () => {
    const preview = await verifyOcrFormSpec.matchRecord({
      record: VerifyOcrRecordSchema.parse({
        formKind: "emergency-contact",
        sourcePage: 2,
        printedName: "Roe, Sam",
        employeeId: "abc",
      }),
      roster: [],
    });
    assert.equal(preview.employeeId, "");
    assert.equal(preview.checks.length, 3);
    assert.equal(findCheck(preview.checks, "eid").status, "missing");
  });
});

describe("verifyOcrFormSpec spec fields", () => {
  it("is read-only: no approve fan-out targets", () => {
    assert.equal(verifyOcrFormSpec.approveTo, undefined);
    assert.equal(verifyOcrFormSpec.approveDocumentTo, undefined);
  });

  it("never requests an orchestrator eid-lookup pass", () => {
    assert.equal(verifyOcrFormSpec.needsLookup(makePreview()), null);
  });

  it("declares verify identity + optional roster", () => {
    assert.equal(verifyOcrFormSpec.formType, "verify");
    assert.equal(verifyOcrFormSpec.rosterMode, "optional");
    assert.equal(verifyOcrFormSpec.traceCode, "vf");
    assert.equal(verifyOcrFormSpec.recordRendererId, "VerifyRecordView");
  });
});
