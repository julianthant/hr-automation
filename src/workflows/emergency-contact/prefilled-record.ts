import type { EmergencyContactRecord } from "./schema.js";

const SAME_AS_EMPLOYEE_LABEL = "(same as employee)";
const NO_ADDRESS_LABEL = "(none)";

type EmergencyContactDetails = EmergencyContactRecord["emergencyContact"];

/**
 * Display summary for the contact address — exactly what the dashboard row's
 * `contactAddress` detail field shows (stamped by workflow.ts via
 * `ctx.updateData`). Shared so `applyPrefilledToEmergencyContactRecord` can
 * recognize an edit-data value that merely round-trips this summary.
 */
export function buildContactAddressSummary(contact: EmergencyContactDetails): string {
  if (contact.sameAddressAsEmployee) return SAME_AS_EMPLOYEE_LABEL;
  if (!contact.address) return NO_ADDRESS_LABEL;
  return [contact.address.street, contact.address.city, contact.address.state, contact.address.zip]
    .filter((s): s is string => Boolean(s))
    .join(", ");
}

/**
 * Display summary for the contact phone — exactly what the dashboard row's
 * `contactPhone` detail field shows (first of cell/home/work).
 */
export function buildContactPhoneSummary(contact: EmergencyContactDetails): string {
  return contact.cellPhone || contact.homePhone || contact.workPhone || "";
}

/**
 * Overlay dashboard edit-data / prefilled tracker fields onto the daemon
 * input record so a rerun uses operator-corrected values without re-OCR.
 *
 * `contactPhone` and `contactAddress` on the tracker row are DERIVED display
 * summaries (see the builders above), and EditDataTab submits every editable
 * field — untouched ones included. An unedited rerun therefore round-trips
 * those summaries back here; applying them anyway would cram the whole
 * address summary into `address.street` (blanking city/state/zip in the
 * UCPath fill) and reclassify a home/work-only phone as `cellPhone`. So each
 * of those overrides is skipped when the incoming value equals the record's
 * own derived summary — only a genuine operator edit applies.
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
    if (phone !== buildContactPhoneSummary(record.emergencyContact).trim()) {
      emergencyContact.cellPhone = phone;
      emergencyContact.homePhone = null;
      emergencyContact.workPhone = null;
    }
  }

  if (typeof data.contactAddress === "string") {
    const addr = data.contactAddress.trim();
    if (addr === SAME_AS_EMPLOYEE_LABEL) {
      emergencyContact.sameAddressAsEmployee = true;
      emergencyContact.address = null;
    } else if (
      addr.length > 0
      && addr !== NO_ADDRESS_LABEL
      && addr !== buildContactAddressSummary(record.emergencyContact).trim()
    ) {
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
