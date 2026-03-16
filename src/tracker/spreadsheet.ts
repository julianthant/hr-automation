import { TRACKER_COLUMNS } from "./columns.js";

export interface TrackerRow {
  firstName: string;
  lastName: string;
  ssnMasked: string;
  dob: string;
  departmentNumber: string;
  recruitmentNumber: string;
  rehire: string;
  effectiveDate: string;
  crmExtracted: string;
  personSearch: string;
  transaction: string;
}

export function maskSsn(ssn: string | undefined): string {
  throw new Error("Not implemented");
}

export function parseDepartmentNumber(deptText: string): string | null {
  throw new Error("Not implemented");
}

export async function updateTracker(filePath: string, data: TrackerRow): Promise<void> {
  throw new Error("Not implemented");
}
