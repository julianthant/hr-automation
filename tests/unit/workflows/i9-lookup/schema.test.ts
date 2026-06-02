import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { I9LookupInputSchema } from "../../../../src/workflows/i9-lookup/schema.js";

describe("I9LookupInputSchema", () => {
  it("accepts a minimal valid input (last + first name only)", () => {
    const parsed = I9LookupInputSchema.parse({ lastName: "Smith", firstName: "Jane" });
    assert.equal(parsed.lastName, "Smith");
    assert.equal(parsed.firstName, "Jane");
    assert.equal(parsed.ssn, undefined);
    assert.equal(parsed.parentSubject, undefined);
  });

  it("accepts optional ssn", () => {
    const parsed = I9LookupInputSchema.parse({
      lastName: "Doe",
      firstName: "John",
      ssn: "123-45-6789",
    });
    assert.equal(parsed.ssn, "123-45-6789");
  });

  it("accepts optional parentSubject", () => {
    const parsed = I9LookupInputSchema.parse({
      lastName: "Doe",
      firstName: "John",
      parentSubject: "OCR ou-143012-a3f1",
    });
    assert.equal(parsed.parentSubject, "OCR ou-143012-a3f1");
  });

  it("rejects missing lastName", () => {
    assert.throws(
      () => I9LookupInputSchema.parse({ firstName: "Jane" }),
      (err: unknown) => err instanceof Error && /last.*name|lastName/i.test(err.message),
    );
  });

  it("rejects empty lastName", () => {
    assert.throws(
      () => I9LookupInputSchema.parse({ lastName: "", firstName: "Jane" }),
      (err: unknown) => err instanceof Error && /last.*name|required/i.test(err.message),
    );
  });

  it("rejects missing firstName", () => {
    assert.throws(
      () => I9LookupInputSchema.parse({ lastName: "Smith" }),
      (err: unknown) => err instanceof Error && /first.*name|firstName/i.test(err.message),
    );
  });

  it("rejects empty firstName", () => {
    assert.throws(
      () => I9LookupInputSchema.parse({ lastName: "Smith", firstName: "" }),
      (err: unknown) => err instanceof Error && /first.*name|required/i.test(err.message),
    );
  });
});
