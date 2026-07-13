import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  I9OcrRecordSchema,
  applyPersonMatchToI9Record,
  buildI9Checks,
  buildI9DisplayName,
  buildI9PersonMatchInput,
  corroborateI9Records,
  i9NamesShareToken,
  i9OcrFormSpec,
  i9SecondOpinionRank,
  isI9SecondOpinionSuspect,
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
    illegible: [],
    corroboration: "unavailable",
    disputedFields: [],
    orphanSection2: false,
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

describe("i9SecondOpinionRank / isI9SecondOpinionSuspect", () => {
  it("ranks by UCPath searchability: 1 = unsearchable, 2 = DOB-only, 3 = SSN", () => {
    assert.equal(i9SecondOpinionRank(makeRecord()), 3, "full SSN present");
    assert.equal(
      i9SecondOpinionRank(makeRecord({ ssn: null })),
      2,
      "no SSN but a mm/dd/yyyy DOB is still searchable",
    );
    assert.equal(
      i9SecondOpinionRank(makeRecord({ ssn: "123-45-67", dateOfBirth: "04/01/98" })),
      1,
      "partial SSN + 2-digit-year DOB are both unusable",
    );
    assert.equal(
      i9SecondOpinionRank(makeRecord({ firstName: null })),
      1,
      "a record without a full name cannot be searched at all",
    );
  });

  it("suspect = an i9-classified page whose read is unsearchable", () => {
    assert.equal(isI9SecondOpinionSuspect(makeRecord()), false, "searchable record is fine");
    assert.equal(
      isI9SecondOpinionSuspect(makeRecord({ ssn: "12-34", dateOfBirth: "4/1/98" })),
      true,
      "i9 page with garbled identifiers is the misread signature",
    );
    assert.equal(
      isI9SecondOpinionSuspect(
        makeRecord({ formKind: "unknown", lastName: null, firstName: null, ssn: null, dateOfBirth: null }),
      ),
      false,
      "a non-Section-1 page is expected to carry nothing — not a suspect",
    );
  });

  it("the spec wires the second-opinion policy (roster-less tier-1 re-read guard)", () => {
    const so = i9OcrFormSpec.secondOpinion;
    assert.ok(so, "i9 declares spec.secondOpinion — without it the roster-gated phase never runs");
    const garbled = makeRecord({ ssn: "12-34", dateOfBirth: "4/1/98" });
    assert.equal(so!.isSuspect(garbled), true);
    assert.equal(so!.rank(garbled), 1);
    assert.equal(so!.readName(garbled), "Doe, Jane A");
    assert.match(so!.reason(garbled), /no usable SSN or mm\/dd\/yyyy date of birth/);
    const nameless = makeRecord({ lastName: null, name: "" });
    assert.match(so!.reason(nameless), /name is missing or unreadable/);
    assert.equal(so!.readName(nameless), "Jane A", "blank stamped name falls back to the Section 1 fields");
  });
});

// ─── Section 2 corroboration ─────────────────────────────────
//
// These cases are REPLAYS of the real misreads from the 2026-07-13 separations
// I-9 check, where 17 of 29 Section 1 reads were wrong and every wrong one was
// reported to the operator as a confident UCPath "not found".

describe("corroborateI9Records", () => {
  const sheet = (over: Partial<I9PreviewRecord>): I9PreviewRecord =>
    makeRecord({
      formKind: "unknown",
      lastName: null,
      firstName: null,
      middleInitial: null,
      dateOfBirth: null,
      ssn: null,
      name: "",
      documentType: "unknown",
      ...over,
    });

  it("a Section 1 the employer's Section 2 agrees with is CONFIRMED", () => {
    const s1 = makeRecord({ sourcePage: 4, lastName: "Werker", firstName: "Trent", name: "Werker, Trent D", ssn: "602-94-9554" });
    const s2 = sheet({ sourcePage: 3, section2Name: "Werker, Trent D", section2DocNumber: "602-94-9554" });
    corroborateI9Records([s2, s1]);
    assert.equal(s1.corroboration, "confirmed");
    assert.deepEqual(s1.disputedFields, []);
    assert.equal(s1.warnings.length, 0);
  });

  it("REAL CASE (Werker, p55): a one-digit SSN misread is caught by Section 2 and never searched", () => {
    // OCR read 602-44-9554; the employer's List C says 602-94-9554. UCPath
    // answers "no results" for the wrong digit — a false "not in UCPath".
    const s1 = makeRecord({ sourcePage: 55, lastName: "Werker", firstName: "Trent", name: "Werker, Trent D", ssn: "602-44-9554" });
    const s2 = sheet({ sourcePage: 54, section2Name: "Werker, Trent D", section2DocNumber: "602-94-9554" });
    corroborateI9Records([s2, s1]);

    assert.equal(s1.corroboration, "disputed");
    assert.deepEqual(s1.disputedFields, ["ssn"]);
    assert.match(s1.warnings[0], /SSN disagrees with the employer's Section 2/);
    assert.ok(!s1.warnings[0].includes("6024495 54".replace(" ", "")), "the warning must not print a whole SSN");

    // The disputed SSN is DROPPED from the search — we search on what still holds.
    const input = buildI9PersonMatchInput(s1, {});
    assert.equal(input?.ssn, undefined, "a contradicted SSN is never sent to UCPath");
    assert.equal(input?.dob, "04/01/1998", "the DOB still searches");
  });

  it("REAL CASE (Walters, p53): a truncated first name still PAIRS (shared token) and the surname dispute surfaces", () => {
    // OCR read "Kim"; the paper says "Kimi". The names still share "walters",
    // so the sheet is paired and the SSN cross-check still runs.
    const s1 = makeRecord({ sourcePage: 53, lastName: "Walters", firstName: "Kim", name: "Walters, Kim J", ssn: "211-85-2141" });
    const s2 = sheet({ sourcePage: 52, section2Name: "Walters, Kimi J.", section2DocNumber: "218-51-2141" });
    corroborateI9Records([s2, s1]);
    assert.equal(s1.corroboration, "disputed");
    assert.deepEqual(s1.disputedFields, ["ssn"]);
  });

  it("REAL CASE (Mihalik, p4): a misread SURNAME is caught even though the given name matches", () => {
    const s1 = makeRecord({ sourcePage: 4, lastName: "Miralik", firstName: "Joshua", name: "Miralik, Joshua A", ssn: "635-54-2434" });
    const s2 = sheet({ sourcePage: 3, section2Name: "Mihalik, Joshua A", section2DocNumber: "635-54-2434" });
    corroborateI9Records([s2, s1]);
    assert.equal(s1.corroboration, "disputed");
    assert.deepEqual(s1.disputedFields, ["lastName"]);
    assert.match(s1.warnings[0], /Last name disagrees.*"Miralik".*"Mihalik, Joshua A"/s);
  });

  it("a Section 1 with no Section 2 sheet is UNAVAILABLE, not confirmed", () => {
    const s1 = makeRecord({ sourcePage: 9, lastName: "Solo", firstName: "Han", name: "Solo, Han" });
    corroborateI9Records([s1]);
    assert.equal(s1.corroboration, "unavailable");
    assert.deepEqual(s1.disputedFields, []);
  });

  it("REAL CASE (Singh, p24): a Section 2 with NO Section 1 page is flagged as an orphan", () => {
    const s1 = makeRecord({ sourcePage: 4, lastName: "Werker", firstName: "Trent", name: "Werker, Trent D" });
    const orphan = sheet({ sourcePage: 24, section2Name: "Singh, Aryaman P" });
    corroborateI9Records([s1, orphan]);
    assert.equal(orphan.orphanSection2, true);
    assert.match(orphan.warnings[0], /Section 1 page is NOT/);
    assert.equal(s1.orphanSection2, false);
  });

  it("one Section 2 sheet is claimed by only ONE Section 1 (no double-pairing)", () => {
    const a = makeRecord({ sourcePage: 2, lastName: "Tan", firstName: "Jiayi", name: "Tan, Jiayi", ssn: "089-35-6758" });
    const b = makeRecord({ sourcePage: 4, lastName: "Tan", firstName: "Jiayi", name: "Tan, Jiayi", ssn: "089-35-6758" });
    const s2 = sheet({ sourcePage: 1, section2Name: "Tan, Jiayi", section2DocNumber: "089-35-6758" });
    corroborateI9Records([s2, a, b]);
    assert.equal(a.corroboration, "confirmed", "the first Section 1 claims the sheet");
    assert.equal(b.corroboration, "unavailable", "the second cannot re-use it");
  });
});

describe("i9NamesShareToken", () => {
  it("pairs a partial misread with the true name", () => {
    assert.equal(i9NamesShareToken("Miralik, Joshua A", "Mihalik, Joshua A"), true);
    assert.equal(i9NamesShareToken("Walters, Kim J", "Walters, Kimi J."), true);
  });
  it("does not pair two different people", () => {
    assert.equal(i9NamesShareToken("Tan, Jiayi", "Singh, Aryaman P"), false);
  });
  it("ignores single-character tokens (a middle initial is not an identity)", () => {
    assert.equal(i9NamesShareToken("Doe, Jane A", "Roe, Rick A"), false);
  });
});

describe("second opinion: an illegible field is suspect", () => {
  it("a field the model could not read triggers a tier-1 re-read, even when searchable", () => {
    // The old rule only re-read UNSEARCHABLE records, which is why none of the
    // 17 real misreads ever got a second opinion — they were all searchable.
    const rec = makeRecord({ ssn: null, illegible: ["ssn"] });
    assert.equal(i9SecondOpinionRank(rec), 2, "still searchable by DOB");
    assert.equal(isI9SecondOpinionSuspect(rec), true, "but the unread field makes it suspect");
    assert.match(i9OcrFormSpec.secondOpinion!.reason(rec), /could not read ssn/);
  });

  it("a clean, fully-legible record is NOT re-read", () => {
    assert.equal(isI9SecondOpinionSuspect(makeRecord()), false);
  });
});

describe("buildI9PersonMatchInput: a disputed field is never searched with", () => {
  it("drops a disputed SSN but keeps the DOB", () => {
    const rec = makeRecord({ disputedFields: ["ssn"] });
    const input = buildI9PersonMatchInput(rec, {});
    assert.equal(input?.ssn, undefined);
    assert.equal(input?.dob, "04/01/1998");
  });

  it("a record whose ONLY identifier is disputed becomes unsearchable, not wrongly searched", () => {
    const rec = makeRecord({ dateOfBirth: null, disputedFields: ["ssn"] });
    assert.equal(buildI9PersonMatchInput(rec, {}), null);
    assert.equal(i9SecondOpinionRank(rec), 1);
  });
});
