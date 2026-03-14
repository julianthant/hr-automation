import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateEmployeeData, EmployeeDataSchema } from "../../src/workflows/onboarding/schema.js";
import { ExtractionError } from "../../src/crm/types.js";

const VALID_DATA: Record<string, string> = {
  positionNumber: "40695231",
  firstName: "Jane",
  lastName: "Doe",
  ssn: "123-45-6789",
  address: "9500 Gilman Dr",
  city: "La Jolla",
  state: "CA",
  postalCode: "92093",
  wage: "$17.75 per hour",
  effectiveDate: "01/15/2026",
};

describe("EmployeeDataSchema", () => {
  it("accepts valid employee data with all 10 fields", () => {
    const result = validateEmployeeData(VALID_DATA);

    assert.equal(result.positionNumber, "40695231");
    assert.equal(result.firstName, "Jane");
    assert.equal(result.lastName, "Doe");
    assert.equal(result.ssn, "123-45-6789");
    assert.equal(result.address, "9500 Gilman Dr");
    assert.equal(result.city, "La Jolla");
    assert.equal(result.state, "CA");
    assert.equal(result.postalCode, "92093");
    assert.equal(result.wage, "$17.75 per hour");
    assert.equal(result.effectiveDate, "01/15/2026");
  });

  it("rejects missing required field with error listing field name", () => {
    const data = { ...VALID_DATA };
    delete (data as Record<string, string | undefined>).firstName;

    assert.throws(
      () => validateEmployeeData(data),
      (err: unknown) => {
        assert.ok(err instanceof ExtractionError);
        assert.ok(err.failedFields?.includes("firstName"));
        return true;
      },
    );
  });

  it("rejects empty string field via min(1) constraint", () => {
    const data = { ...VALID_DATA, ssn: "" };

    assert.throws(
      () => validateEmployeeData(data),
      (err: unknown) => {
        assert.ok(err instanceof ExtractionError);
        assert.ok(err.failedFields?.includes("ssn"));
        return true;
      },
    );
  });

  it("rejects malformed SSN with format error", () => {
    const data = { ...VALID_DATA, ssn: "12345" };

    assert.throws(
      () => validateEmployeeData(data),
      (err: unknown) => {
        assert.ok(err instanceof ExtractionError);
        assert.ok(err.failedFields?.includes("ssn"));
        assert.ok(err.message.includes("XXX-XX-XXXX"));
        return true;
      },
    );
  });

  it("rejects malformed postal code with format error", () => {
    const data = { ...VALID_DATA, postalCode: "ABCDE" };

    assert.throws(
      () => validateEmployeeData(data),
      (err: unknown) => {
        assert.ok(err instanceof ExtractionError);
        assert.ok(err.failedFields?.includes("postalCode"));
        assert.ok(err.message.includes("XXXXX"));
        return true;
      },
    );
  });

  it("reports ALL failing field names when multiple fields are missing", () => {
    const data = { ...VALID_DATA };
    const mutable = data as Record<string, string | undefined>;
    delete mutable.firstName;
    delete mutable.lastName;
    delete mutable.wage;

    assert.throws(
      () => validateEmployeeData(data),
      (err: unknown) => {
        assert.ok(err instanceof ExtractionError);
        assert.ok(err.failedFields?.includes("firstName"));
        assert.ok(err.failedFields?.includes("lastName"));
        assert.ok(err.failedFields?.includes("wage"));
        assert.equal(err.failedFields?.length, 3);
        return true;
      },
    );
  });

  it("ExtractionError has name 'ExtractionError' and carries failedFields", () => {
    const err = new ExtractionError("test error", ["field1", "field2"]);
    assert.equal(err.name, "ExtractionError");
    assert.deepEqual(err.failedFields, ["field1", "field2"]);
    assert.ok(err instanceof Error);
    assert.equal(err.message, "test error");
  });

  it("rejects non-2-letter state code", () => {
    const data = { ...VALID_DATA, state: "California" };

    assert.throws(
      () => validateEmployeeData(data),
      (err: unknown) => {
        assert.ok(err instanceof ExtractionError);
        assert.ok(err.failedFields?.includes("state"));
        return true;
      },
    );
  });

  it("rejects effectiveDate not in MM/DD/YYYY format", () => {
    const data = { ...VALID_DATA, effectiveDate: "2026-03-14" };

    assert.throws(
      () => validateEmployeeData(data),
      (err: unknown) => {
        assert.ok(err instanceof ExtractionError);
        assert.ok(err.failedFields?.includes("effectiveDate"));
        return true;
      },
    );
  });

  it("rejects wage without dollar sign prefix", () => {
    const data = { ...VALID_DATA, wage: "17.75 per hour" };

    assert.throws(
      () => validateEmployeeData(data),
      (err: unknown) => {
        assert.ok(err instanceof ExtractionError);
        assert.ok(err.failedFields?.includes("wage"));
        return true;
      },
    );
  });

  it("accepts missing SSN (international students may not have one)", () => {
    const data = { ...VALID_DATA };
    delete (data as Record<string, string | undefined>).ssn;

    const result = validateEmployeeData(data);
    assert.equal(result.ssn, undefined);
    assert.equal(result.firstName, "Jane");
  });

  it("accepts null SSN (extracted as null from page)", () => {
    const data: Record<string, string | null> = {
      ...VALID_DATA,
      ssn: null,
    };

    const result = validateEmployeeData(data);
    assert.equal(result.ssn, undefined);
  });

  it("handles null values by treating them as missing fields", () => {
    const data: Record<string, string | null> = {
      ...VALID_DATA,
      city: null,
    };

    assert.throws(
      () => validateEmployeeData(data),
      (err: unknown) => {
        assert.ok(err instanceof ExtractionError);
        assert.ok(err.failedFields?.includes("city"));
        return true;
      },
    );
  });
});
