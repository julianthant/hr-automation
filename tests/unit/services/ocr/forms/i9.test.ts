import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  I9OcrRecordSchema,
  applyPersonMatchToI9Record,
  buildI9Checks,
  buildI9DisplayName,
  buildI9PersonMatchInput,
  corroborateI9Records,
  i9NamePairScore,
  i9NamesShareToken,
  i9OcrFormSpec,
  pairI9Section2Sheets,
  i9SecondOpinionRank,
  isI9SecondOpinionSuspect,
  normalizeI9Dob,
  normalizeI9Ssn,
  type I9PreviewRecord,
} from "../../../../../src/services/ocr/forms/i9.js";

function makeRecord(overrides: Partial<I9PreviewRecord> = {}): I9PreviewRecord {
  return {
    formKind: "i9 section 1",
    sourcePage: 1,
    lastName: "Doe",
    firstName: "Jane",
    middleInitial: "A",
    dateOfBirth: "04/01/1998",
    ssn: "000-00-0000",
    documentType: "expected",
    originallyMissing: [],
    illegible: [],
    corroboration: "unavailable",
    disputedFields: [],
    orphanSection2: false,
    notes: [],
    name: "Person 905 A",
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
      formKind: "i9 section 1",
      sourcePage: 1,
      lastName: "Doe",
      firstName: "Jane",
      middleInitial: "A",
      dateOfBirth: "04/01/1998",
      ssn: "000-00-0000",
      documentType: "expected",
    });
    assert.equal(parsed.formKind, "i9 section 1");
    assert.equal(parsed.ssn, "000-00-0000");
  });

  it("parses a Section 2 sheet with the UNIFORM fields (name/ssn/hireDate on the sheet itself)", () => {
    const parsed = I9OcrRecordSchema.parse({
      formKind: "i9 section 2",
      sourcePage: 2,
      lastName: "Doe",
      firstName: "Jane",
      middleInitial: "A",
      dateOfBirth: null,
      ssn: "000-00-0000",
      hireDate: "04/17/2018",
      documentType: "expected",
    });
    assert.equal(parsed.formKind, "i9 section 2");
    assert.equal(parsed.hireDate, "04/17/2018");
  });

  it("coerces the LEGACY 2-way kind: \"i9\" normalizes to \"i9 section 1\"", () => {
    const parsed = I9OcrRecordSchema.parse({ formKind: "i9", sourcePage: 1 });
    assert.equal(parsed.formKind, "i9 section 1");
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
    assert.equal(normalizeI9Ssn("000-00-0000"), "123456789");
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
      "Person 905 A",
    );
    assert.equal(buildI9DisplayName({ lastName: "Doe", firstName: "Jane" }), "Person 905");
    assert.equal(buildI9DisplayName({ lastName: "Doe" }), "Doe");
    assert.equal(buildI9DisplayName({}), "");
  });
});

describe("buildI9PersonMatchInput", () => {
  it("builds a full input with normalized ssn + dob", () => {
    assert.deepEqual(
      buildI9PersonMatchInput(
        { lastName: "Doe", firstName: "Jane", ssn: "000-00-0000", dateOfBirth: "4/1/1998" },
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
        { lastName: null, firstName: "Jane", ssn: "000-00-0000", dateOfBirth: null },
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
      matchedEmplId: "10090307",
      matchedName: "Person 905",
    });
    assert.equal(rec.ucpathFound, true);
    assert.equal(rec.matchedEmplId, "10090307");
    assert.equal(rec.matchedName, "Person 905");
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
  it("marks paper + roster fields and the roster name-match as Yes when matched", () => {
    const rec = makeRecord({
      ppsEid: "39549",
      rosterEmplId: "10090307",
      hireDate: "4/17/2018",
      i9SeparationDate: "8/6/2021",
    });
    const checks = buildI9Checks(rec);
    assert.deepEqual(
      checks.map((c) => [c.key, c.status]),
      [
        ["name", "present"],
        ["ppsEid", "found"],
        ["ucpathEmplId", "found"],
        ["hireDate", "present"],
        ["i9SeparationDate", "found"],
        ["rosterNameMatch", "found"],
        ["dob", "present"],
        ["ssn", "present"],
        // Document provenance: which of the person's two pages backed this row.
        ["section1Present", "present"],
        ["section2Present", "missing"],
        ["corroboration", "missing"],
      ],
    );
    const roster = checks.find((c) => c.key === "rosterNameMatch")!;
    assert.equal(roster.foundValue, "Yes");
    assert.equal(roster.label, "On Action History roster (by name)?");
    assert.equal(roster.source, "roster");
    assert.equal(checks.find((c) => c.key === "ppsEid")!.foundValue, "39549");
    assert.equal(checks.find((c) => c.key === "hireDate")!.paperValue, "4/17/2018");
  });

  it("no roster name-match reads 'UCPath check runs next' — never a UCPath verdict", () => {
    const checks = buildI9Checks(makeRecord());
    const roster = checks.find((c) => c.key === "rosterNameMatch")!;
    assert.equal(roster.status, "missing");
    assert.equal(roster.missingLabel, "No name match — UCPath check runs next");
    // The UCPath verdict itself belongs to the separations member row now —
    // no check in the OCR preview may claim a found/not-found answer.
    assert.equal(checks.find((c) => c.key === "ucpathPerson"), undefined);
  });

  it("ucpathEmplId reads the ROSTER EID only (live matchedEmplId is deprecated)", () => {
    const withDeprecatedStamp = buildI9Checks(
      makeRecord({ matchedEmplId: "10999999" }),
    );
    assert.equal(
      withDeprecatedStamp.find((c) => c.key === "ucpathEmplId")!.status,
      "missing",
      "a historical matchedEmplId stamp must not surface as a roster EID",
    );
    const withRoster = buildI9Checks(makeRecord({ rosterEmplId: "10090307" }));
    assert.equal(withRoster.find((c) => c.key === "ucpathEmplId")!.foundValue, "10090307");
  });

  it("blank paper fields are missing; roster gaps say Not on Action History", () => {
    const checks = buildI9Checks(
      makeRecord({ name: "", lastName: null, firstName: null, dateOfBirth: null, ssn: null }),
    );
    assert.equal(checks.find((c) => c.key === "name")!.status, "missing");
    assert.equal(checks.find((c) => c.key === "ppsEid")!.missingLabel, "Not on Action History");
    assert.equal(checks.find((c) => c.key === "dob")!.status, "missing");
    assert.equal(checks.find((c) => c.key === "ssn")!.status, "missing");
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
        ssn: "000-00-0000",
      }),
      roster: [],
    });
    assert.equal(rec.name, "Person 905 A");
    assert.equal(rec.selected, true);
    assert.equal(rec.matchState, "extracted");
    // name/ppsEid/ucpathEmplId/hireDate/i9SeparationDate/rosterNameMatch/dob/ssn
    // + section1Present/section2Present/corroboration.
    assert.equal(rec.checks.length, 11);
  });

  it("carry-forward keeps the FRESH read (enrichment re-runs the search)", () => {
    const v1 = makeRecord({ ucpathFound: true, matchedEmplId: "10090307" });
    const v2 = makeRecord({ ssn: "000-00-0000" });
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
    assert.equal(so!.readName(garbled), "Person 905 A");
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
  // A Section 2 sheet record in the CURRENT contract: its own uniform
  // name/ssn/hireDate fields (the old section2* side-fields are retired).
  const sheet = (over: { sourcePage: number; name: string; ssn?: string | null; hireDate?: string | null; formKind?: I9PreviewRecord["formKind"] }): I9PreviewRecord =>
    makeRecord({
      formKind: over.formKind ?? "i9 section 2",
      sourcePage: over.sourcePage,
      lastName: null,
      firstName: null,
      middleInitial: null,
      dateOfBirth: null,
      ssn: over.ssn ?? null,
      hireDate: over.hireDate ?? null,
      name: over.name,
      documentType: "expected",
    });

  it("a Section 1 the employer's Section 2 agrees with is CONFIRMED", () => {
    const s1 = makeRecord({ sourcePage: 4, lastName: "Wivasa", firstName: "Tefoz", name: "Wivasa, Tefoz D", ssn: "000-00-0000" });
    const s2 = sheet({ sourcePage: 3, name: "Wivasa, Tefoz D", ssn: "000-00-0000", hireDate: "03/10/2019" });
    corroborateI9Records([s2, s1]);
    assert.equal(s1.corroboration, "confirmed");
    assert.deepEqual(s1.disputedFields, []);
    assert.equal(s1.warnings.length, 0);
    assert.equal(s1.hireDate, "03/10/2019", "Section 2 First Day of Employment copies onto Section 1");
  });

  it("REAL CASE (Wivasa, p55): a one-digit SSN misread is caught by Section 2 and never searched", () => {
    // OCR read 000-00-0000; the employer's List C says 000-00-0000. UCPath
    // answers "no results" for the wrong digit — a false "not in UCPath".
    const s1 = makeRecord({ sourcePage: 55, lastName: "Wivasa", firstName: "Tefoz", name: "Wivasa, Tefoz D", ssn: "000-00-0000" });
    const s2 = sheet({ sourcePage: 54, name: "Wivasa, Tefoz D", ssn: "000-00-0000" });
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

  it("REAL CASE (Wezewap, p53): a truncated first name still PAIRS (shared token) and the surname dispute surfaces", () => {
    // OCR read "Kan"; the paper says "Kegi". The names still share "wezewap",
    // so the sheet is paired and the SSN cross-check still runs.
    const s1 = makeRecord({ sourcePage: 53, lastName: "Wezewap", firstName: "Kan", name: "Wezewap, Kan J", ssn: "000-00-0000" });
    const s2 = sheet({ sourcePage: 52, name: "Wezewap, Kegi J.", ssn: "000-00-0000" });
    corroborateI9Records([s2, s1]);
    assert.equal(s1.corroboration, "disputed");
    assert.deepEqual(s1.disputedFields, ["ssn"]);
  });

  it("REAL CASE (Muketof, p4): a misread SURNAME is caught even though the given name matches", () => {
    const s1 = makeRecord({ sourcePage: 4, lastName: "Muzetof", firstName: "Jobava", name: "Muzetof, Jobava A", ssn: "000-00-0000" });
    const s2 = sheet({ sourcePage: 3, name: "Muketof, Jobava A", ssn: "000-00-0000" });
    corroborateI9Records([s2, s1]);
    assert.equal(s1.corroboration, "disputed");
    assert.deepEqual(s1.disputedFields, ["lastName"]);
    assert.match(s1.warnings[0], /Last name disagrees.*"Muzetof".*"Muketof, Jobava A"/s);
  });

  it("a Section 1 with no Section 2 sheet is UNAVAILABLE, not confirmed", () => {
    const s1 = makeRecord({ sourcePage: 9, lastName: "Solo", firstName: "Haf", name: "Solo, Haf" });
    corroborateI9Records([s1]);
    assert.equal(s1.corroboration, "unavailable");
    assert.deepEqual(s1.disputedFields, []);
  });

  it("REAL CASE (Satur, p24): a Section 2 with NO Section 1 page is flagged as an orphan", () => {
    const s1 = makeRecord({ sourcePage: 4, lastName: "Wivasa", firstName: "Tefoz", name: "Wivasa, Tefoz D" });
    const orphan = sheet({ sourcePage: 24, name: "Satur, Aufetaz P" });
    corroborateI9Records([s1, orphan]);
    assert.equal(orphan.orphanSection2, true);
    assert.match(orphan.warnings[0], /Section 1 page is NOT/);
    assert.equal(s1.orphanSection2, false);
  });

  it("stamps the REVERSE link: the claimed sheet points back at its Section 1 page", () => {
    const s1 = makeRecord({ sourcePage: 9, lastName: "Simaruz", firstName: "Geloton", name: "Simaruz, Geloton", ssn: "000-00-0000" });
    const s2 = sheet({ sourcePage: 1, name: "Simaruz, Geloton", ssn: "000-00-0000", hireDate: "04/25/2016" });
    corroborateI9Records([s2, s1]);
    assert.equal(s1.section2Page, 1);
    assert.equal(s2.section1Page, 9, "the sheet records which Section 1 claimed it");
  });

  it("an \"i9 ssn\" supplemental sheet pairs by name, stamps ssnPage, and supplies the hire date", () => {
    // The UCRS 419 case: Siv has NO Section 2 anywhere — the SSN statement is
    // his only corroborating document.
    const s1 = makeRecord({ sourcePage: 37, lastName: "Siv", firstName: "Sizil", name: "Siv, Sizil B", ssn: "000-00-0000", hireDate: null });
    const ssnSheet = sheet({ formKind: "i9 ssn", sourcePage: 36, name: "Siv, Sizil B", ssn: "000-00-0000", hireDate: "02/25/2016" });
    corroborateI9Records([ssnSheet, s1]);
    assert.equal(s1.ssnPage, 36);
    assert.equal(ssnSheet.section1Page, 37);
    assert.equal(s1.corroboration, "confirmed");
    assert.equal(s1.hireDate, "02/25/2016", "the SSN sheet's date of hire fills a missing hire date");
  });

  it("an \"i9 ssn\" sheet contradicting the Section 1 SSN disputes it (independent oracle)", () => {
    const s1 = makeRecord({ sourcePage: 37, lastName: "Siv", firstName: "Sizil", name: "Siv, Sizil B", ssn: "000-00-0000" });
    const ssnSheet = sheet({ formKind: "i9 ssn", sourcePage: 36, name: "Siv, Sizil B", ssn: "000-00-0000" });
    corroborateI9Records([ssnSheet, s1]);
    assert.equal(s1.corroboration, "disputed");
    assert.deepEqual(s1.disputedFields, ["ssn"]);
    assert.equal(buildI9PersonMatchInput(s1, {})?.ssn, undefined, "the contradicted SSN never searches UCPath");
  });

  it("one Section 2 sheet is claimed by only ONE Section 1 (no double-pairing)", () => {
    const a = makeRecord({ sourcePage: 2, lastName: "Tus", firstName: "Jipar", name: "Tus, Jipar", ssn: "000-00-0000" });
    const b = makeRecord({ sourcePage: 4, lastName: "Tus", firstName: "Jipar", name: "Tus, Jipar", ssn: "000-00-0000" });
    const s2 = sheet({ sourcePage: 1, name: "Tus, Jipar", ssn: "000-00-0000" });
    corroborateI9Records([s2, a, b]);
    assert.equal(a.corroboration, "confirmed", "the first Section 1 claims the sheet");
    assert.equal(b.corroboration, "unavailable", "the second cannot re-use it");
  });
});

describe("i9NamesShareToken", () => {
  it("pairs a partial misread with the true name", () => {
    assert.equal(i9NamesShareToken("Muzetof, Jobava A", "Muketof, Jobava A"), true);
    assert.equal(i9NamesShareToken("Wezewap, Kan J", "Wezewap, Kegi J."), true);
  });
  it("does not pair two different people", () => {
    assert.equal(i9NamesShareToken("Tus, Jipar", "Satur, Aufetaz P"), false);
  });
  it("ignores single-character tokens (a middle initial is not an identity)", () => {
    assert.equal(i9NamesShareToken("Person 905 A", "Roe, Rick A"), false);
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

/**
 * Every employee has BOTH a Section 1 and a Section 2 page, filed apart in a
 * scanned packet. Pairing used to be first-fit on ANY shared name token, in
 * page order, so a coincidental token collision stole the sheet an exact match
 * needed. Live 2026-07-16: `Tsai, Nipu Citi` and `Weme, Nipu-Citi` both contain
 * "nipu" — Weme's Section 1 was paired to Tsai's sheet (phantom last-name
 * dispute) while Weme's real sheet on page 50 was reported an orphan.
 */
describe("pairI9Section2Sheets — global best-first pairing", () => {
  // Keep the name PARTS consistent with the display name — the last-name
  // dispute check reads `lastName`, not the assembled `name`.
  const s1 = (name: string, page: number): I9PreviewRecord => {
    const [last, rest] = name.split(",");
    const [first, middle] = rest.trim().split(" ");
    return makeRecord({
      name,
      lastName: last.trim(),
      firstName: first ?? null,
      middleInitial: middle ?? null,
      sourcePage: page,
      formKind: "i9 section 1",
    });
  };
  const s2 = (sheetName: string, page: number): I9PreviewRecord =>
    makeRecord({
      formKind: "i9 section 2",
      sourcePage: page,
      name: sheetName,
      lastName: null,
      firstName: null,
      middleInitial: null,
      dateOfBirth: null,
      ssn: null,
    });

  it("gives each sheet to its BEST claimant, not the first token collision", () => {
    const tsai = s1("Tsai, Nipu Citi", 45);
    const weng = s1("Weme, Nipu-Citi", 51);
    const tsaiSheet = s2("Tsai, Nipu Citi", 44);
    const wengSheet = s2("Weme, Nipu-Citi", 50);

    const paired = pairI9Section2Sheets([tsai, weng], [tsaiSheet, wengSheet]);
    assert.equal(paired.get(tsai)?.sourcePage, 44, "Tsai keeps its own sheet");
    assert.equal(paired.get(weng)?.sourcePage, 50, "Weme gets its own sheet, not Tsai's");
  });

  it("still pairs through a real OCR misread on BOTH pages", () => {
    // "Shung, Marin Chianq" (sheet) vs "Shang, Martin C" (Section 1) — same person.
    const shung = s1("Shang, Martin C", 11);
    const sheet = s2("Shung, Marin Chianq", 10);
    const paired = pairI9Section2Sheets([shung], [sheet]);
    assert.equal(paired.get(shung)?.sourcePage, 10);
  });

  it("does NOT pair two genuinely different people", () => {
    const a = s1("Tus, Jipar", 3);
    const sheet = s2("Satur, Aufetaz P", 4);
    assert.equal(pairI9Section2Sheets([a], [sheet]).size, 0);
  });

  it("scores an exact name above a shared-token coincidence", () => {
    const exact = i9NamePairScore("Weme, Nipu-Citi", "Weme, Nipu-Citi");
    const coincidence = i9NamePairScore("Weme, Nipu-Citi", "Tsai, Nipu Citi");
    assert.equal(exact, 1);
    assert.ok(coincidence < exact, `coincidence ${coincidence} must rank below exact ${exact}`);
  });

  it("corroborate: the mispairing no longer invents a last-name dispute", () => {
    const tsai = s1("Tsai, Nipu Citi", 45);
    const weng = s1("Weme, Nipu-Citi", 51);
    const out = corroborateI9Records([
      tsai,
      weng,
      s2("Tsai, Nipu Citi", 44),
      s2("Weme, Nipu-Citi", 50),
    ]);
    const wengOut = out.find((r) => r.name === "Weme, Nipu-Citi")!;
    assert.equal(wengOut.corroboration, "confirmed");
    assert.deepEqual(wengOut.disputedFields, []);
    assert.equal(wengOut.section2Page, 50, "records which page corroborated it");
    assert.ok(!out.some((r) => r.orphanSection2), "no phantom orphans");
  });
});
