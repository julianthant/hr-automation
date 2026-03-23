export interface I9EmployeeInput {
  firstName: string;
  middleName?: string;
  lastName: string;
  ssn: string;        // 9 digits, no dashes
  dob: string;        // MM/DD/YYYY
  email: string;
  departmentNumber: string; // 6-digit dept number, e.g. "000412"
  startDate: string;  // MM/DD/YYYY (effective date from CRM)
}

export interface I9Result {
  success: boolean;
  profileId: string | null;
  error?: string;
}

/**
 * Search criteria for finding an existing I9 employee.
 * At least one field must be provided.
 */
export interface I9SearchCriteria {
  lastName?: string;
  firstName?: string;
  ssn?: string;          // XXX-XX-XXXX format (with dashes for search)
  profileId?: string;
  employeeId?: string;
}

export interface I9SearchResult {
  lastName: string;
  firstName: string;
  employer: string;
  worksite: string;
  profileId: string;
  i9Id: string;
  nextAction: string;
  startDate: string;
  navUrl: string;
}
