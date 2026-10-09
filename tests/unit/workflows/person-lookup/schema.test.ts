import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  buildPersonLookupCliInput,
  derivePersonLookupItemId,
  normalizeName,
  PersonLookupItemSchema,
  PersonLookupNameInputSchema,
  PersonLookupEidInputSchema,
  PersonLookupMatchInputSchema,
  isEidInput,
  isMatchInput,
  parsePersonLookupMatchLine,
  resolvePersonLookupCrmCheck,
} from "../../../../src/workflows/person-lookup/schema.js";

describe("normalizeName", () => {
  it("title-cases all-lowercase input", () => {
    assert.equal(normalizeName("zun, haki tuwom"), "Zun, Haki Tuwom");
  });

  it("title-cases all-uppercase input", () => {
    assert.equal(normalizeName("SMITH, JOHN MEPAFIC"), "Smith, John Mepafic");
  });

  it("title-cases mixed-case input", () => {
    assert.equal(normalizeName("mCdOnAlD, BoB"), "Mcdonald, Bob");
  });

  it("preserves hyphenated last names", () => {
    assert.equal(normalizeName("o'brien-smith, jane"), "O'Brien-Smith, Jane");
  });

  it("trims surrounding whitespace and collapses internal spaces", () => {
    assert.equal(normalizeName("  smith  ,   john   mepafic  "), "Smith, John Mepafic");
  });

  it("normalizes separator to ', ' (comma + single space)", () => {
    assert.equal(normalizeName("smith ,john"), "Smith, John");
    assert.equal(normalizeName("smith,john"), "Smith, John");
  });

  it("handles single-word first name (no middle)", () => {
    assert.equal(normalizeName("smith, john"), "Smith, John");
  });

  it("is idempotent", () => {
    const once = normalizeName("zun, haki tuwom");
    const twice = normalizeName(once);
    assert.equal(once, twice);
  });

  it("display-normalizes names without a comma", () => {
    assert.equal(normalizeName("plain string"), "Plain String");
  });

  it("returns input unchanged if only last name given", () => {
    assert.equal(normalizeName("smith,"), "smith,");
    assert.equal(normalizeName(",john"), ",john");
  });
});

describe("PersonLookupItemSchema", () => {
  it("PersonLookupNameInputSchema accepts a name string", () => {
    const parsed = PersonLookupNameInputSchema.parse({ name: "Coizmib, Ruwem" });
    assert.equal(parsed.name, "Coizmib, Ruwem");
  });

  it("PersonLookupNameInputSchema rejects empty name", () => {
    assert.throws(() => PersonLookupNameInputSchema.parse({ name: "" }));
  });

  it("PersonLookupEidInputSchema accepts a UCPath EID", () => {
    const parsed = PersonLookupEidInputSchema.parse({ emplId: "10090175" });
    assert.equal(parsed.emplId, "10090175");
  });

  it("PersonLookupEidInputSchema rejects non-numeric Empl ID", () => {
    assert.throws(() => PersonLookupEidInputSchema.parse({ emplId: "abc" }));
  });

  it("PersonLookupEidInputSchema rejects too-short Empl ID", () => {
    assert.throws(() => PersonLookupEidInputSchema.parse({ emplId: "1234" }));
  });

  it("PersonLookupItemSchema accepts all three shapes via union", () => {
    PersonLookupItemSchema.parse({ name: "Smith, Bob" });
    PersonLookupItemSchema.parse({ emplId: "10090225" });
    PersonLookupItemSchema.parse({
      mode: "match",
      lastName: "Smith",
      firstName: "Bob",
      dob: "01/02/2000",
    });
  });

  it("isEidInput discriminates the union", () => {
    assert.equal(isEidInput(PersonLookupItemSchema.parse({ name: "Smith, Bob" })), false);
    assert.equal(isEidInput(PersonLookupItemSchema.parse({ emplId: "10090175" })), true);
  });

  it("defaults mode to search for legacy name and EID callers", () => {
    assert.equal(PersonLookupItemSchema.parse({ name: "Smith, Bob" }).mode, "search");
    assert.equal(PersonLookupItemSchema.parse({ emplId: "10090175" }).mode, "search");
  });

  it("defaults CRM on for search and off for match, with explicit overrides", () => {
    assert.equal(resolvePersonLookupCrmCheck({ name: "Smith, Bob" }), true);
    assert.equal(
      resolvePersonLookupCrmCheck({
        mode: "match",
        lastName: "Smith",
        firstName: "Bob",
        dob: "01/02/2000",
      }),
      false,
    );
    assert.equal(resolvePersonLookupCrmCheck({ name: "Smith, Bob", crmCheck: false }), false);
    assert.equal(
      resolvePersonLookupCrmCheck({
        mode: "match",
        crmCheck: true,
        lastName: "Smith",
        firstName: "Bob",
        dob: "01/02/2000",
      }),
      true,
    );
  });

  it("keepNonHdh flag carries through both shapes", () => {
    const n = PersonLookupNameInputSchema.parse({
      name: "Coizmib, Ruwem",
      keepNonHdh: true,
    });
    const e = PersonLookupEidInputSchema.parse({
      emplId: "10090175",
      keepNonHdh: true,
    });
    assert.equal(n.keepNonHdh, true);
    assert.equal(e.keepNonHdh, true);
  });

  it("includeCrmDates is optional — omitting it still parses both shapes", () => {
    const n = PersonLookupNameInputSchema.parse({ name: "Coizmib, Ruwem" });
    const e = PersonLookupEidInputSchema.parse({ emplId: "10090175" });
    assert.equal(n.includeCrmDates, undefined);
    assert.equal(e.includeCrmDates, undefined);
  });

  it("includeCrmDates: true is accepted on name input", () => {
    const n = PersonLookupNameInputSchema.parse({
      name: "Coizmib, Ruwem",
      includeCrmDates: true,
    });
    assert.equal(n.includeCrmDates, true);
  });

  it("includeCrmDates: true is accepted on EID input", () => {
    const e = PersonLookupEidInputSchema.parse({
      emplId: "10090175",
      includeCrmDates: true,
    });
    assert.equal(e.includeCrmDates, true);
  });

  it("includeCrmDates: false is accepted on both shapes", () => {
    const n = PersonLookupNameInputSchema.parse({
      name: "Coizmib, Ruwem",
      includeCrmDates: false,
    });
    const e = PersonLookupEidInputSchema.parse({
      emplId: "10090175",
      includeCrmDates: false,
    });
    assert.equal(n.includeCrmDates, false);
    assert.equal(e.includeCrmDates, false);
  });

  it("includeCrmDates carries through the union schema", () => {
    const n = PersonLookupItemSchema.parse({ name: "Smith, Bob", includeCrmDates: true });
    const e = PersonLookupItemSchema.parse({ emplId: "10090225", includeCrmDates: true });
    assert.equal("includeCrmDates" in n ? n.includeCrmDates : undefined, true);
    assert.equal("includeCrmDates" in e ? e.includeCrmDates : undefined, true);
  });
});

describe("PersonLookupMatchInputSchema", () => {
  it("accepts a legal name with either SSN or DOB", () => {
    assert.equal(
      PersonLookupMatchInputSchema.parse({
        mode: "match",
        lastName: "Doe",
        firstName: "Jane",
        ssn: "123456789",
      }).ssn,
      "123456789",
    );
    assert.equal(
      PersonLookupMatchInputSchema.parse({
        mode: "match",
        lastName: "Doe",
        firstName: "Jane",
        dob: "04/01/1998",
      }).dob,
      "04/01/1998",
    );
  });

  it("rejects missing or whitespace-only hard identifiers", () => {
    assert.equal(
      PersonLookupMatchInputSchema.safeParse({
        mode: "match",
        lastName: "Doe",
        firstName: "Jane",
      }).success,
      false,
    );
    assert.equal(
      PersonLookupMatchInputSchema.safeParse({
        mode: "match",
        lastName: "Doe",
        firstName: "Jane",
        ssn: "  ",
        dob: "",
      }).success,
      false,
    );
  });
});

describe("parsePersonLookupMatchLine", () => {
  it("uses the last two fields as DOB and SSN and rejoins the comma name", () => {
    assert.deepEqual(
      parsePersonLookupMatchLine("Bodukiwapet, Jabepik, 08/09/1986, 000000121"),
      {
        mode: "match",
        lastName: "Bodukiwapet",
        firstName: "Jabepik",
        dob: "08/09/1986",
        ssn: "000000121",
      },
    );
  });

  it("treats x case-insensitively as an absent DOB or SSN", () => {
    assert.deepEqual(parsePersonLookupMatchLine("Romag, Maczd, 05/06/1983, x"), {
      mode: "match",
      lastName: "Romag",
      firstName: "Maczd",
      dob: "05/06/1983",
    });
    assert.deepEqual(parsePersonLookupMatchLine("Romag, Maczd, X, 987654321"), {
      mode: "match",
      lastName: "Romag",
      firstName: "Maczd",
      ssn: "987654321",
    });
  });

  it("refuses both x fields and names the offending line", () => {
    assert.throws(
      () => parsePersonLookupMatchLine("Romag, Maczd, x, X"),
      /Romag, Maczd, x, X.*cannot use x for both DOB and SSN/,
    );
  });

  it("refuses fewer than three comma fields and names the offending line", () => {
    assert.throws(
      () => parsePersonLookupMatchLine("Romag, Maczd"),
      /Romag, Maczd.*must contain name, DOB, and SSN fields/,
    );
  });

  it("isMatchInput discriminates parsed Match inputs", () => {
    assert.equal(
      isMatchInput(parsePersonLookupMatchLine("Romag, Maczd, 05/06/1983, x")),
      true,
    );
  });
});

describe("derivePersonLookupItemId", () => {
  it("uses the EID as the stable item id for EID inputs", () => {
    assert.equal(derivePersonLookupItemId({ emplId: "10090175" }), "10090175");
  });

  it("uses the display name as the stable item id for name inputs", () => {
    assert.equal(derivePersonLookupItemId({ name: "zun, haki tuwom" }), "Zun, Haki Tuwom");
  });

  it("uses the legal name plus identifier-presence hint for match inputs", () => {
    assert.equal(
      derivePersonLookupItemId({
        mode: "match",
        lastName: "Romag",
        firstName: "Maczd",
        dob: "05/06/1983",
      }),
      "Romag, Maczd (DOB)",
    );
  });
});

describe("buildPersonLookupCliInput", () => {
  it("routes digit-only queries through EID validation only when they normalize to a UCPath EID", () => {
    assert.deepEqual(buildPersonLookupCliInput("10090175"), { emplId: "10090175" });
    assert.deepEqual(buildPersonLookupCliInput("10-090175"), { emplId: "10-090175" });
    assert.deepEqual(buildPersonLookupCliInput(" 10090295 "), { emplId: " 10090295 " });
  });

  it("treats short or non-10xxxxxx digit strings as name queries", () => {
    assert.deepEqual(buildPersonLookupCliInput("12345"), { name: "12345" });
    assert.deepEqual(buildPersonLookupCliInput("20090002"), { name: "20090002" });
  });

  it("never treats strings with letters as bare EID queries", () => {
    assert.deepEqual(buildPersonLookupCliInput("Room 101"), { name: "Room 101" });
    assert.deepEqual(buildPersonLookupCliInput("Zun, Haki Tuwom"), { name: "Zun, Haki Tuwom" });
  });
});
