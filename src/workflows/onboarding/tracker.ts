import { appendRow } from "../../tracker/index.js";
import type { ColumnDef } from "../../tracker/index.js";
import { trackEvent } from "../../tracker/jsonl.js";
import type { EmployeeData } from "./schema.js";

const TRACKER_PATH = "./src/workflows/onboarding/onboarding-tracker.xlsx";

const COLUMNS: ColumnDef[] = [
  { header: "First Name", key: "firstName", width: 15 },
  { header: "Middle Name", key: "middleName", width: 15 },
  { header: "Last Name", key: "lastName", width: 15 },
  { header: "SSN", key: "ssn", width: 15 },
  { header: "DOB", key: "dob", width: 12 },
  { header: "Phone", key: "phone", width: 15 },
  { header: "Email", key: "email", width: 25 },
  { header: "Address", key: "address", width: 25 },
  { header: "City", key: "city", width: 15 },
  { header: "State", key: "state", width: 8 },
  { header: "Postal Code", key: "postalCode", width: 12 },
  { header: "Dept #", key: "departmentNumber", width: 10 },
  { header: "Recruitment #", key: "recruitmentNumber", width: 15 },
  { header: "Position #", key: "positionNumber", width: 12 },
  { header: "Wage", key: "wage", width: 15 },
  { header: "Effective Date", key: "effectiveDate", width: 14 },
  { header: "Appointment", key: "appointment", width: 12 },
  { header: "CRM Extraction", key: "crmExtraction", width: 14 },
  { header: "Person Search", key: "personSearch", width: 14 },
  { header: "Rehire", key: "rehire", width: 8 },
  { header: "I9 Record", key: "i9Record", width: 12 },
  { header: "Transaction", key: "transaction", width: 14 },
  { header: "PDF Download", key: "pdfDownload", width: 14 },
  { header: "I9 Profile ID", key: "i9ProfileId", width: 14 },
  { header: "Status", key: "status", width: 12 },
  { header: "Error", key: "error", width: 30 },
  { header: "Timestamp", key: "timestamp", width: 22 },
];

export interface OnboardingTrackerRow {
  firstName: string;
  middleName: string;
  lastName: string;
  ssn: string;
  dob: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  departmentNumber: string;
  recruitmentNumber: string;
  positionNumber: string;
  wage: string;
  effectiveDate: string;
  appointment: string;
  crmExtraction: string;
  personSearch: string;
  rehire: string;
  i9Record: string;
  transaction: string;
  pdfDownload: string;
  i9ProfileId: string;
  status: string;
  error: string;
  timestamp: string;
}

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
 * Build an OnboardingTrackerRow from extracted employee data and workflow status.
 * Timestamp is set automatically to the current ISO time.
 */
export function buildTrackerRow(data: EmployeeData, status: TrackerStatus): OnboardingTrackerRow {
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

/** Onboarding tracker file path. */
export { TRACKER_PATH };

/** Onboarding tracker columns (for tests). */
export { COLUMNS as ONBOARDING_TRACKER_COLUMNS };

/**
 * Append a row to the onboarding tracker .xlsx file.
 * Uses daily worksheet tabs named YYYY-MM-DD.
 */
export async function updateOnboardingTracker(filePath: string, data: OnboardingTrackerRow): Promise<void> {
  await appendRow(filePath, COLUMNS, data as unknown as Record<string, string>);
  trackEvent({
    workflow: "onboarding",
    timestamp: data.timestamp || new Date().toISOString(),
    id: data.email || `${data.lastName}, ${data.firstName}`,
    status: data.status === "Done" ? "done" : data.status === "Failed" ? "failed" : "running",
    step: data.crmExtraction === "Done" ? "transaction" : "extraction",
    data: { firstName: data.firstName ?? "", lastName: data.lastName ?? "" },
    error: data.error || undefined,
  });
}
