import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { AddressSchema, EmployeeSchema, EmergencyContactSchema, RecordSchema } from "../../../../src/workflows/emergency-contact/schema.js";

// ISS-004 (e2e run 20260618-2146): OCR routinely emits a PARTIAL address with a
// null `street`. A non-null `homeAddress` object with a null `street` must NOT
// reject the whole approve-batch — before the fix, AddressSchema.street =
// z.string().min(1) threw "expected string, received null" and the ENTIRE batch
// failed (operation stuck at awaiting-review, raw Zod dump surfaced).
describe("AddressSchema — null street tolerance (ISS-004)", () => {
  it("accepts a partial address with null street + present siblings", () => {
    assert.equal(AddressSchema.safeParse({ street: null, city: "UCSD", state: null, zip: "ERC" }).success, true);
  });
  it("EmployeeSchema accepts a record whose homeAddress has a null street", () => {
    assert.equal(
      EmployeeSchema.safeParse({
        name: "Renee Coleman",
        employeeId: "10706431",
        homeAddress: { street: null, city: "UCSD", state: null, zip: "ERC" },
      }).success,
      true,
    );
  });
  it("RecordSchema parses a full EC record with a null employee.homeAddress.street", () => {
    assert.equal(
      RecordSchema.safeParse({
        sourcePage: 1,
        employee: { name: "Renee Coleman", employeeId: "10706431", homeAddress: { street: null, city: "UCSD", state: null, zip: "ERC" } },
        emergencyContact: { name: "Rod Coleman", relationship: "Dad", primary: true, sameAddressAsEmployee: false, address: { street: "3449 Invictus Way", city: "San Jose", state: "CA", zip: "95118" }, cellPhone: "(408) 759-7353" },
        notes: [],
      }).success,
      true,
    );
  });
  it("still rejects a present-but-empty street (min(1) holds when non-null)", () => {
    assert.equal(AddressSchema.safeParse({ street: "", city: "X" }).success, false);
  });
});

describe("EmergencyContactSchema — same-address-when-null transform", () => {
  it("rewrites sameAddressAsEmployee=false + address=null to sameAddressAsEmployee=true", () => {
    const parsed = EmergencyContactSchema.parse({
      name: "Jane Doe",
      relationship: "Mother",
      primary: true,
      sameAddressAsEmployee: false,
      address: null,
      cellPhone: "(555) 123-4567",
      homePhone: null,
      workPhone: null,
    });
    assert.equal(parsed.sameAddressAsEmployee, true);
    assert.equal(parsed.address, null);
  });

  it("rewrites sameAddressAsEmployee=false + address omitted to sameAddressAsEmployee=true", () => {
    const parsed = EmergencyContactSchema.parse({
      name: "Jane Doe",
      relationship: "Mother",
      primary: true,
      sameAddressAsEmployee: false,
      cellPhone: null,
      homePhone: null,
      workPhone: null,
    });
    assert.equal(parsed.sameAddressAsEmployee, true);
  });

  it("leaves sameAddressAsEmployee=false alone when address is present", () => {
    const parsed = EmergencyContactSchema.parse({
      name: "Jane Doe",
      relationship: "Mother",
      primary: true,
      sameAddressAsEmployee: false,
      address: { street: "123 Main", city: "Denver", state: "CO", zip: "80201" },
      cellPhone: null,
      homePhone: null,
      workPhone: null,
    });
    assert.equal(parsed.sameAddressAsEmployee, false);
    assert.equal(parsed.address?.street, "123 Main");
  });

  it("leaves sameAddressAsEmployee=true alone (with null address)", () => {
    const parsed = EmergencyContactSchema.parse({
      name: "Jane Doe",
      relationship: "Mother",
      primary: true,
      sameAddressAsEmployee: true,
      address: null,
      cellPhone: null,
      homePhone: null,
      workPhone: null,
    });
    assert.equal(parsed.sameAddressAsEmployee, true);
  });

  it("transform also fires when nested under RecordSchema", () => {
    const parsed = RecordSchema.parse({
      sourcePage: 1,
      dryRun: true,
      employee: { name: "Test", employeeId: "12345" },
      emergencyContact: {
        name: "Friend",
        relationship: "Friend",
        primary: true,
        sameAddressAsEmployee: false,
        address: null,
        cellPhone: "(555) 000-0000",
        homePhone: null,
        workPhone: null,
      },
      notes: [],
    });
    assert.equal(parsed.emergencyContact.sameAddressAsEmployee, true);
    assert.equal(parsed.dryRun, true);
  });
});
