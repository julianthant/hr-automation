import type { EmergencyContactRecord } from "./schema.js";

const SAME_AS_EMPLOYEE_LABEL = "(same as employee)";

/**
 * Overlay dashboard edit-data / prefilled tracker fields onto the daemon
 * input record so a rerun uses operator-corrected values without re-OCR.
 */
export function applyPrefilledToEmergencyContactRecord(
  record: EmergencyContactRecord,
  data: Record<string, unknown>,
): EmergencyContactRecord {
  const employee = { ...record.employee };
  const emergencyContact = { ...record.emergencyContact };

  if (typeof data.emplId === "string" && data.emplId.trim().length > 0) {
    employee.employeeId = data.emplId.trim();
  }
  if (typeof data.employeeName === "string" && data.employeeName.trim().length > 0) {
    employee.name = data.employeeName.trim();
  }
  if (typeof data.contactName === "string" && data.contactName.trim().length > 0) {
    emergencyContact.name = data.contactName.trim();
  }
  if (typeof data.relationship === "string" && data.relationship.trim().length > 0) {
    emergencyContact.relationship = data.relationship.trim();
  }
  if (typeof data.contactPhone === "string" && data.contactPhone.trim().length > 0) {
    const phone = data.contactPhone.trim();
    emergencyContact.cellPhone = phone;
    emergencyContact.homePhone = null;
    emergencyContact.workPhone = null;
  }

  if (typeof data.contactAddress === "string") {
    const addr = data.contactAddress.trim();
    if (addr === SAME_AS_EMPLOYEE_LABEL) {
      emergencyContact.sameAddressAsEmployee = true;
      emergencyContact.address = null;
    } else if (addr.length > 0 && addr !== "(none)") {
      emergencyContact.sameAddressAsEmployee = false;
      emergencyContact.address = { street: addr };
    }
  }

  return {
    ...record,
    employee,
    emergencyContact,
  };
}

/** True when edit-data prefilled any identity/contact field before the handler runs. */
export function hasEmergencyContactPrefilledOverrides(
  record: EmergencyContactRecord,
  data: Record<string, unknown>,
): boolean {
  const effective = applyPrefilledToEmergencyContactRecord(record, data);
  return (
    effective.employee.employeeId !== record.employee.employeeId
    || effective.employee.name !== record.employee.name
    || effective.emergencyContact.name !== record.emergencyContact.name
    || effective.emergencyContact.relationship !== record.emergencyContact.relationship
    || effective.emergencyContact.cellPhone !== record.emergencyContact.cellPhone
    || effective.emergencyContact.sameAddressAsEmployee !== record.emergencyContact.sameAddressAsEmployee
    || JSON.stringify(effective.emergencyContact.address ?? null)
      !== JSON.stringify(record.emergencyContact.address ?? null)
  );
}
