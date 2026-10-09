import { test } from "vitest";
import assert from "node:assert";
import {
  PersonLookupEidInputSchema as EidLookupEidInputSchema,
  PersonLookupNameInputSchema as EidLookupNameInputSchema,
  PersonLookupItemSchema as EidLookupItemSchema,
  isEidInput,
} from "../../../../src/workflows/person-lookup/schema.js";
import { buildPersonOrgNameSearchAttempts } from "../../../../src/systems/ucpath/person-org-summary.js";
import { buildCrmNameSearchQueries } from "../../../../src/workflows/person-lookup/crm-search.js";

test("EidLookupEidInputSchema: rejects non-numeric Empl ID", () => {
  assert.throws(() => EidLookupEidInputSchema.parse({ emplId: "abc" }));
  assert.throws(() => EidLookupEidInputSchema.parse({ emplId: "" }));
  assert.throws(() => EidLookupEidInputSchema.parse({ emplId: "1234" })); // too short
  assert.throws(() => EidLookupEidInputSchema.parse({ emplId: "12345" })); // not a UCPath EID
  assert.throws(() => EidLookupEidInputSchema.parse({ emplId: "20090002" })); // wrong prefix
  assert.throws(() => EidLookupEidInputSchema.parse({ emplId: "10x06431" })); // mixed
  assert.throws(() => EidLookupEidInputSchema.parse({}));
});

test("EidLookupEidInputSchema: accepts UCPath Empl IDs", () => {
  assert.doesNotThrow(() => EidLookupEidInputSchema.parse({ emplId: "10090175" }));
  assert.deepEqual(EidLookupEidInputSchema.parse({ emplId: "10-090175" }), {
    emplId: "10090175",
    mode: "search",
  });
  assert.doesNotThrow(() =>
    EidLookupEidInputSchema.parse({ emplId: "10090175", keepNonHdh: true }),
  );
});

test("EidLookupNameInputSchema: requires non-empty name", () => {
  assert.throws(() => EidLookupNameInputSchema.parse({ name: "" }));
  assert.throws(() => EidLookupNameInputSchema.parse({}));
  assert.doesNotThrow(() => EidLookupNameInputSchema.parse({ name: "Smith, John" }));
  assert.doesNotThrow(() =>
    EidLookupNameInputSchema.parse({ name: "Smith, John", keepNonHdh: true }),
  );
});

test("EidLookupItemSchema: discriminated union accepts both shapes", () => {
  const eidInput = EidLookupItemSchema.parse({ emplId: "10090175" });
  assert.ok("emplId" in eidInput);
  const nameInput = EidLookupItemSchema.parse({ name: "Smith, John" });
  assert.ok("name" in nameInput);
});

test("isEidInput: returns true only for EID-shape inputs", () => {
  assert.equal(isEidInput({ emplId: "10090175" }), true);
  assert.equal(isEidInput({ emplId: "10090175", keepNonHdh: true }), true);
  assert.equal(isEidInput({ name: "Smith, John" }), false);
  assert.equal(isEidInput({ name: "Smith, John", keepNonHdh: true }), false);
});

test("buildPersonOrgNameSearchAttempts includes compound-last splits but not token-as-solo-last-name", () => {
  const attempts = buildPersonOrgNameSearchAttempts({
    lastName: "Bemidipu Mirofaw",
    first: "Cugiti",
    middle: "D.",
  });
  assert.deepEqual(attempts.slice(0, 3), [
    { lastName: "Bemidipu Mirofaw", name: "Cugiti D." },
    { lastName: "Bemidipu Mirofaw", name: "Cugiti" },
    { lastName: "Bemidipu Mirofaw", name: "D." },
  ]);
  assert.ok(attempts.some((attempt) => attempt.lastName === "Bemidipu" && attempt.name === "Cugiti"));
  assert.ok(attempts.some((attempt) => attempt.lastName === "Mirofaw" && attempt.name === "Cugiti"));
  assert.ok(!attempts.some((attempt) => attempt.name === ""));
});

test("buildPersonOrgNameSearchAttempts: middle name is not searched as standalone Last Name (regression)", () => {
  const attempts = buildPersonOrgNameSearchAttempts({
    lastName: "Mirofaw",
    first: "Cugiti",
    middle: "Bemidipu",
  });
  assert.ok(!attempts.some((a) => a.name === ""));
  assert.ok(!attempts.some((a) => a.lastName.toLowerCase() === "bemidipu" && a.name === ""));
  assert.deepEqual(
    attempts.map((a) => `${a.lastName}|${a.name}`),
    ["Mirofaw|Cugiti Bemidipu", "Mirofaw|Cugiti", "Mirofaw|Bemidipu"],
  );
});

test("buildCrmNameSearchQueries includes deduped significant name-token fallbacks", () => {
  assert.deepEqual(
    buildCrmNameSearchQueries("Bemidipu Mirofaw", "Cugiti D."),
    ["Bemidipu Mirofaw", "Cugiti D.", "Bemidipu", "Mirofaw", "Cugiti"],
  );
});
