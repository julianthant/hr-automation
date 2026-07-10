import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { PersonMatchInputSchema } from "../../../../src/workflows/person-match/schema.js";

describe("PersonMatchInputSchema", () => {
  it("accepts a name plus an SSN", () => {
    const parsed = PersonMatchInputSchema.parse({
      lastName: "Doe",
      firstName: "Jane",
      ssn: "123456789",
    });
    assert.equal(parsed.lastName, "Doe");
    assert.equal(parsed.ssn, "123456789");
  });

  it("accepts a name plus a DOB", () => {
    const parsed = PersonMatchInputSchema.parse({
      lastName: "Doe",
      firstName: "Jane",
      dob: "04/01/1998",
    });
    assert.equal(parsed.dob, "04/01/1998");
  });

  it("rejects an input with neither SSN nor DOB (UCPath search cannot run)", () => {
    const result = PersonMatchInputSchema.safeParse({
      lastName: "Doe",
      firstName: "Jane",
    });
    assert.equal(result.success, false);
  });

  it("rejects whitespace-only identifiers", () => {
    const result = PersonMatchInputSchema.safeParse({
      lastName: "Doe",
      firstName: "Jane",
      ssn: "  ",
      dob: "",
    });
    assert.equal(result.success, false);
  });

  it("rejects a missing name", () => {
    const result = PersonMatchInputSchema.safeParse({
      lastName: "",
      firstName: "Jane",
      ssn: "123456789",
    });
    assert.equal(result.success, false);
  });

  it("carries parentSubject through", () => {
    const parsed = PersonMatchInputSchema.parse({
      lastName: "Doe",
      firstName: "Jane",
      dob: "01/02/2000",
      parentSubject: "I9_Packet.pdf",
    });
    assert.equal(parsed.parentSubject, "I9_Packet.pdf");
  });
});
