import { test } from "node:test";
import assert from "node:assert";
import {
  EidLookupEidInputSchema,
  EidLookupNameInputSchema,
  EidLookupItemSchema,
  isEidInput,
} from "../../../../src/workflows/eid-lookup/schema.js";

test("EidLookupEidInputSchema: rejects non-numeric Empl ID", () => {
  assert.throws(() => EidLookupEidInputSchema.parse({ emplId: "abc" }));
  assert.throws(() => EidLookupEidInputSchema.parse({ emplId: "" }));
  assert.throws(() => EidLookupEidInputSchema.parse({ emplId: "1234" })); // 4 digits — too short
  assert.throws(() => EidLookupEidInputSchema.parse({ emplId: "10x06431" })); // mixed
  assert.throws(() => EidLookupEidInputSchema.parse({}));
});

test("EidLookupEidInputSchema: accepts 5+ digit Empl ID", () => {
  assert.doesNotThrow(() => EidLookupEidInputSchema.parse({ emplId: "10706431" }));
  assert.doesNotThrow(() => EidLookupEidInputSchema.parse({ emplId: "12345" }));
  assert.doesNotThrow(() =>
    EidLookupEidInputSchema.parse({ emplId: "10706431", keepNonHdh: true }),
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
  const eidInput = EidLookupItemSchema.parse({ emplId: "10706431" });
  assert.ok("emplId" in eidInput);
  const nameInput = EidLookupItemSchema.parse({ name: "Smith, John" });
  assert.ok("name" in nameInput);
});

test("isEidInput: returns true only for EID-shape inputs", () => {
  assert.equal(isEidInput({ emplId: "10706431" }), true);
  assert.equal(isEidInput({ emplId: "10706431", keepNonHdh: true }), true);
  assert.equal(isEidInput({ name: "Smith, John" }), false);
  assert.equal(isEidInput({ name: "Smith, John", keepNonHdh: true }), false);
});
