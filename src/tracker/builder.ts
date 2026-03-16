import type { TrackerRow } from "./spreadsheet.js";
import type { EmployeeData } from "../workflows/onboarding/schema.js";

export interface TrackerStatus {
  crmExtraction: string;
  personSearch: string;
  rehire: string;
  i9Record: string;
  transaction: string;
  pdfDownload: string;
  i9ProfileId: string;
  status: string;
  error: string;
}

/**
 * Build a TrackerRow from extracted employee data and workflow status.
 * Timestamp is set automatically to the current ISO time.
 */
export function buildTrackerRow(data: EmployeeData, status: TrackerStatus): TrackerRow {
  return {
    firstName: data.firstName,
    middleName: data.middleName ?? "",
    lastName: data.lastName,
    ssn: data.ssn ?? "",
    dob: data.dob ?? "",
    phone: data.phone ?? "",
    email: data.email ?? "",
    address: data.address,
    city: data.city,
    state: data.state,
    postalCode: data.postalCode,
    departmentNumber: data.departmentNumber ?? "",
    recruitmentNumber: data.recruitmentNumber ?? "",
    positionNumber: data.positionNumber,
    wage: data.wage,
    effectiveDate: data.effectiveDate,
    appointment: data.appointment ?? "",
    crmExtraction: status.crmExtraction,
    personSearch: status.personSearch,
    rehire: status.rehire,
    i9Record: status.i9Record,
    transaction: status.transaction,
    pdfDownload: status.pdfDownload,
    i9ProfileId: status.i9ProfileId,
    status: status.status,
    error: status.error,
    timestamp: new Date().toISOString(),
  };
}
