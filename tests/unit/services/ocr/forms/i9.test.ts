import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  I9OcrRecordSchema,
  applyPersonMatchToI9Record,
  buildI9Checks,
  buildI9DisplayName,
  buildI9PersonMatchInput,
  i9OcrFormSpec,
  normalizeI9Dob,
  normalizeI9Ssn,
  type I9PreviewRecord,
} from "../../../../../src/services/ocr/forms/i9.js";

function makeRecord(overrides: Partial<I9PreviewRecord> = {}): I9PreviewRecord {
  return {
    formKind: "i9",
    sourcePage: 1,
    lastName: "Doe",
    firstName: "Jane",
    middleInitial: "A",
    dateOfBirth: "04/01/1998",
    ssn: "123-45-6789",
    documentType: "expected",
    originallyMissing: [],
    notes: [],
    name: "Doe, Jane A",
    matchState: "extracted",
    selected: true,
    warnings: [],
    checks: [],
    ...overrides,
  };
}

describe("I9OcrRecordSchema", () => {
  it("parses a full Section 1 record", () => {
    const parsed = I9OcrRecordSchema.parse({
      formKind: "i9",
      sourcePage: 1,
      lastName: "Doe",
      firstName: "Jane",
      middleInitial: "A",
      dateOfBirth: "04/01/1998",
      ssn: "123-45-6789",
      documentType: "expected",
    });
    assert.equal(parsed.formKind, "i9");
    assert.equal(parsed.ssn, "123-45-6789");
  });

  it("tolerates explicit nulls on a non-Section-1 page (record must not drop)", () => {
    const result = I9OcrRecordSchema.safeParse({
      formKind: "unknown",
      sourcePage: 2,
      lastName: null,
      firstName: null,
      middleInitial: null,
      dateOfBirth: null,
      ssn: null,
      documentType: "unknown",
    });
    assert.equal(result.success, true);
  });

  it("coerces an unrecognized formKind to unknown instead of dropping the record", () => {
    const result = I9OcrRecordSchema.safeParse({
      formKind: "form-i9",
      sourcePage: 1,
      lastName: "Doe",
      firstName: "Jane",
    });
    assert.equal(result.success, true);
    if (result.success) assert.equal(result.data.formKind, "unknown");
  });
});

describe("normalizeI9Ssn", () => {
  it("strips dashes/spaces to 9 bare digits", () => {
    assert.equal(normalizeI9Ssn("123-45-6789"), "123456789");
    assert.equal(normalizeI9Ssn("123 45 6789"), "123456789");
  });

  it("rejects partial, masked, or garbled reads", () => {
    assert.equal(normalizeI9Ssn("6789"), null);
    assert.equal(normalizeI9Ssn("XXX-XX-6789"), null);
    assert.equal(normalizeI9Ssn("1234567890"), null);
    assert.equal(normalizeI9Ssn(null), null);
    assert.equal(normalizeI9Ssn(""), null);
  });
});

describe("normalizeI9Dob", () => {
  it("pads to MM/DD/YYYY across separators", () => {
    assert.equal(normalizeI9Dob("4/1/1998"), "04/01/1998");
    assert.equal(normalizeI9Dob("04-01-1998"), "04/01/1998");
    assert.equal(normalizeI9Dob("4.1.1998"), "04/01/1998");
  });

  it("rejects 2-digit years (century would be a guess) and impossible dates", () => {
    assert.equal(normalizeI9Dob("4/1/98"), null);
    assert.equal(normalizeI9Dob("13/01/1998"), null);
    assert.equal(normalizeI9Dob("04/32/1998"), null);
    assert.equal(normalizeI9Dob("April 1 1998"), null);
    assert.equal(normalizeI9Dob(null), null);
  });
});

describe("buildI9DisplayName", () => {
  it("builds Last, First M", () => {
    assert.equal(
      buildI9DisplayName({ lastName: "Doe", firstName: "Jane", middleInitial: "A" }),
      "Doe, Jane A",
    );
    assert.equal(buildI9DisplayName({ lastName: "Doe", firstName: "Jane" }), "Doe, Jane");
    assert.equal(buildI9DisplayName({ lastName: "Doe" }), "Doe");
    assert.equal(buildI9DisplayName({}), "");
  });
});

describe("buildI9PersonMatchInput", () => {
  it("builds a full input with normalized ssn + dob", () => {
    assert.deepEqual(
      buildI9PersonMatchInput(
        { lastName: "Doe", firstName: "Jane", ssn: "123-45-6789", dateOfBirth: "4/1/1998" },
        { parentSubject: "I9.pdf" },
      ),
      {
        lastName: "Doe",
        firstName: "Jane",
        ssn: "123456789",
        dob: "04/01/1998",
        parentSubject: "I9.pdf",
      },
    );
  });

  it("drops an unusable ssn but keeps a good dob", () => {
    assert.deepEqual(
      buildI9PersonMatchInput(
        { lastName: "Doe", firstName: "Jane", ssn: "XXX-XX-6789", dateOfBirth: "4/1/1998" },
        {},
      ),
      { lastName: "Doe", firstName: "Jane", dob: "04/01/1998" },
    );
  });

  it("returns null when the name or BOTH identifiers are missing", () => {
    assert.equal(
      buildI9PersonMatchInput(
        { lastName: null, firstName: "Jane", ssn: "123-45-6789", dateOfBirth: null },
        {},
      ),
      null,
    );
    assert.equal(
      buildI9PersonMatchInput(
        { lastName: "Doe", firstName: "Jane", ssn: "678", dateOfBirth: "4/1/98" },
        {},
      ),
      null,
    );
  });
});

describe("applyPersonMatchToI9Record", () => {
  it("stamps found=true with match identity", () => {
    const rec = makeRecord();
    applyPersonMatchToI9Record(rec, {
      found: "true",
      matchedEmplId: "10874100",
      matchedName: "Jane Doe",
    });
    assert.equal(rec.ucpathFound, true);
    assert.equal(rec.matchedEmplId, "10874100");
    assert.equal(rec.matchedName, "Jane Doe");
  });

  it("stamps found=false and leaves match fields absent", () => {
    const rec = makeRecord();
    applyPersonMatchToI9Record(rec, { found: "false", matchedEmplId: "", matchedName: "" });
    assert.equal(rec.ucpathFound, false);
    assert.equal(rec.matchedEmplId, undefined);
  });

  it("leaves ucpathFound undefined when the outcome carried no answer", () => {
    const rec = makeRecord();
    applyPersonMatchToI9Record(rec, undefined);
    assert.equal(rec.ucpathFound, undefined);
  });
});

describe("buildI9Checks", () => {
  it("marks paper fields present and the UCPath check found with EID + name", () => {
    const rec = makeRecord({
      ucpathFound: true,
      matchedEmplId: "10874100",
      matchedName: "Jane Doe",
      personMatchStatus: "completed",
    });
    const checks = buildI9Checks(rec);
    assert.deepEqual(
      checks.map((c) => [c.key, c.status]),
      [
        ["name", "present"],
        ["dob", "present"],
        ["ssn", "present"],
        ["ucpathPerson", "found"],
      ],
    );
    const ucpath = checks[3]!;
    assert.equal(ucpath.foundValue, "EID 10874100 — Jane Doe");
    assert.equal(ucpath.source, "ucpath");
  });

  it("a definitive not-found keeps the default missing rendering (no missingLabel)", () => {
    const checks = buildI9Checks(
      makeRecord({ ucpathFound: false, personMatchStatus: "completed" }),
    );
    const ucpath = checks[3]!;
    assert.equal(ucpath.status, "missing");
    assert.equal(ucpath.missingLabel, undefined);
  });

  it("a FAILED match never reads as not-found — explicit unknown label", () => {
    const checks = buildI9Checks(makeRecord({ personMatchStatus: "failed" }));
    assert.equal(checks[3]!.missingLabel, "Search failed — result unknown");
  });

  it("an unanswered record reads Not checked (mid-prep / re-OCR'd page)", () => {
    const checks = buildI9Checks(makeRecord());
    assert.equal(checks[3]!.missingLabel, "Not checked");
  });

  it("blank paper fields are missing", () => {
    const checks = buildI9Checks(
      makeRecord({ name: "", lastName: null, firstName: null, dateOfBirth: null, ssn: null }),
    );
    assert.deepEqual(
      checks.map((c) => [c.key, c.status]),
      [
        ["name", "missing"],
        ["dob", "missing"],
        ["ssn", "missing"],
        ["ucpathPerson", "missing"],
      ],
    );
  });
});

describe("i9OcrFormSpec", () => {
  it("is read-only: no approve targets, optional roster, no generic lookup", () => {
    assert.equal(i9OcrFormSpec.approveTo, undefined);
    assert.equal(i9OcrFormSpec.approveDocumentTo, undefined);
    assert.equal(i9OcrFormSpec.rosterMode, "optional");
    assert.equal(i9OcrFormSpec.needsLookup(makeRecord()), null);
  });

  it("matchRecord assembles the display name and seeds checks", async () => {
    const rec = await i9OcrFormSpec.matchRecord({
      record: I9OcrRecordSchema.parse({
        formKind: "i9",
        sourcePage: 1,
        lastName: "Doe",
        firstName: "Jane",
        middleInitial: "A",
        dateOfBirth: "04/01/1998",
        ssn: "123-45-6789",
      }),
      roster: [],
    });
    assert.equal(rec.name, "Doe, Jane A");
    assert.equal(rec.selected, true);
    assert.equal(rec.matchState, "extracted");
    assert.equal(rec.checks.length, 4);
  });

  it("carry-forward keeps the FRESH read (enrichment re-runs the search)", () => {
    const v1 = makeRecord({ ucpathFound: true, matchedEmplId: "10874100" });
    const v2 = makeRecord({ ssn: "987-65-4321" });
    assert.deepEqual(i9OcrFormSpec.applyCarryForward({ v2, v1 }), v2);
  });

  it("placeholder fields are i9-shaped", () => {
    const fields = i9OcrFormSpec.placeholderFields?.();
    assert.ok(fields);
    assert.equal(fields!.name, "");
    assert.deepEqual(fields!.checks, []);
    assert.equal(fields!.formKind, "unknown");
  });
});
