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

  it("keeps the structured address when contactAddress round-trips the record's own summary", () => {
    // EditDataTab submits untouched fields too: an unedited rerun sends back the
    // derived "[street, city, state, zip].join(', ')" display summary. That must
    // NOT collapse the structured address into street-only.
    const record = {
      ...baseRecord(),
      emergencyContact: {
        ...baseRecord().emergencyContact,
        sameAddressAsEmployee: false,
        address: { street: "123 Main St", city: "San Diego", state: "CA", zip: "92101" },
      },
    };
    const effective = applyPrefilledToEmergencyContactRecord(record, {
      contactAddress: "123 Main St, San Diego, CA, 92101",
    });
    assert.deepEqual(effective.emergencyContact.address, {
      street: "123 Main St",
      city: "San Diego",
      state: "CA",
      zip: "92101",
    });
    assert.equal(effective.emergencyContact.sameAddressAsEmployee, false);
  });

  it("still applies an actually-edited address string", () => {
    const record = {
      ...baseRecord(),
      emergencyContact: {
        ...baseRecord().emergencyContact,
        sameAddressAsEmployee: false,
        address: { street: "123 Main St", city: "San Diego", state: "CA", zip: "92101" },
      },
    };
    const effective = applyPrefilledToEmergencyContactRecord(record, {
      contactAddress: "456 Elm Ave, La Jolla, CA 92037",
    });
    assert.deepEqual(effective.emergencyContact.address, {
      street: "456 Elm Ave, La Jolla, CA 92037",
    });
    assert.equal(effective.emergencyContact.sameAddressAsEmployee, false);
  });

  it("keeps a home-only phone when contactPhone round-trips the record's own summary", () => {
    // The row's contactPhone is `cellPhone || homePhone || workPhone`; an unedited
    // round-trip must not reclassify a home/work-only phone as cellPhone.
    const record = {
      ...baseRecord(),
      emergencyContact: {
        ...baseRecord().emergencyContact,
        cellPhone: null,
        homePhone: "(555) 333-4444",
        workPhone: null,
      },
    };
    const effective = applyPrefilledToEmergencyContactRecord(record, {
      contactPhone: "(555) 333-4444",
    });
    assert.equal(effective.emergencyContact.cellPhone, null);
    assert.equal(effective.emergencyContact.homePhone, "(555) 333-4444");
    assert.equal(effective.emergencyContact.workPhone, null);
  });

  it("still applies an actually-edited phone as cellPhone", () => {
    const record = {
      ...baseRecord(),
      emergencyContact: {
        ...baseRecord().emergencyContact,
        cellPhone: null,
        homePhone: "(555) 333-4444",
        workPhone: null,
      },
    };
    const effective = applyPrefilledToEmergencyContactRecord(record, {
      contactPhone: "(555) 999-0000",
    });
    assert.equal(effective.emergencyContact.cellPhone, "(555) 999-0000");
    assert.equal(effective.emergencyContact.homePhone, null);
    assert.equal(effective.emergencyContact.workPhone, null);
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

  it("returns false when an unedited rerun round-trips derived phone + address summaries", () => {
    const record = {
      ...baseRecord(),
      emergencyContact: {
        ...baseRecord().emergencyContact,
        sameAddressAsEmployee: false,
        address: { street: "123 Main St", city: "San Diego", state: "CA", zip: "92101" },
        cellPhone: null,
        homePhone: "(555) 333-4444",
        workPhone: null,
      },
    };
    assert.equal(
      hasEmergencyContactPrefilledOverrides(record, {
        emplId: record.employee.employeeId,
        employeeName: record.employee.name,
        contactName: record.emergencyContact.name,
        relationship: record.emergencyContact.relationship,
        contactPhone: "(555) 333-4444",
        contactAddress: "123 Main St, San Diego, CA, 92101",
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
