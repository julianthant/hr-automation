import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EmergencyContactSchema, RecordSchema } from "../../../../src/workflows/emergency-contact/schema.js";

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
  });
});
