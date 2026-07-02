import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  applyPrefilledToEmergencyContactRecord,
  hasEmergencyContactPrefilledOverrides,
} from "../../../../src/workflows/emergency-contact/prefilled-record.js";
import type { EmergencyContactRecord } from "../../../../src/workflows/emergency-contact/schema.js";

function baseRecord(): EmergencyContactRecord {
  return {
    sourcePage: 1,
    employee: {
      name: "Maria Garcia",
      employeeId: "10001234",
    },
    emergencyContact: {
      name: "Sara Garcia",
      relationship: "Sister",
      primary: true,
      sameAddressAsEmployee: true,
      address: null,
      cellPhone: "(555) 111-2222",
    },
    notes: [],
  };
}

describe("applyPrefilledToEmergencyContactRecord", () => {
  it("overlays emplId, employee name, and contact fields from tracker data", () => {
    const record = baseRecord();
    const effective = applyPrefilledToEmergencyContactRecord(record, {
      emplId: "10009999",
      employeeName: "Maria G. Garcia",
      contactName: "Sara G.",
      relationship: "Parent",
      contactPhone: "(555) 999-0000",
      contactAddress: "123 Main St, San Diego, CA 92101",
    });
    assert.equal(effective.employee.employeeId, "10009999");
    assert.equal(effective.employee.name, "Maria G. Garcia");
    assert.equal(effective.emergencyContact.name, "Sara G.");
    assert.equal(effective.emergencyContact.relationship, "Parent");
    assert.equal(effective.emergencyContact.cellPhone, "(555) 999-0000");
    assert.equal(effective.emergencyContact.sameAddressAsEmployee, false);
    assert.equal(effective.emergencyContact.address?.street, "123 Main St, San Diego, CA 92101");
  });

  it("sets same-as-employee when contactAddress is the sentinel label", () => {
    const record = {
      ...baseRecord(),
      emergencyContact: {
        ...baseRecord().emergencyContact,
        sameAddressAsEmployee: false,
        address: { street: "Old St" },
      },
    };
    const effective = applyPrefilledToEmergencyContactRecord(record, {
      contactAddress: "(same as employee)",
    });
    assert.equal(effective.emergencyContact.sameAddressAsEmployee, true);
    assert.equal(effective.emergencyContact.address, null);
  });
});

describe("hasEmergencyContactPrefilledOverrides", () => {
  it("returns false when tracker data matches the input record", () => {
    const record = baseRecord();
    assert.equal(
      hasEmergencyContactPrefilledOverrides(record, {
        emplId: record.employee.employeeId,
        employeeName: record.employee.name,
        contactName: record.emergencyContact.name,
        relationship: record.emergencyContact.relationship,
        contactPhone: record.emergencyContact.cellPhone,
        contactAddress: "(same as employee)",
      }),
      false,
    );
  });

  it("returns true when emplId was corrected", () => {
    const record = baseRecord();
    assert.equal(
      hasEmergencyContactPrefilledOverrides(record, { emplId: "10005678" }),
      true,
    );
  });
});
