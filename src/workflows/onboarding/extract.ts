import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { extractField } from "../../crm/extract.js";
import { parseDepartmentNumber } from "../../tracker/index.js";

/**
 * Maps each EmployeeData field name to an array of possible label strings
 * found on the UCPath Entry Sheet. Ordered by likelihood.
 */
/**
 * SELECTOR: adjusted from live testing on ONB_PPSEntrySheet page.
 * Labels on the UCPath Entry Sheet end with colons and some have
 * parenthetical clarifications. Order: exact live label first, then fallbacks.
 */
const FIELD_MAP: Record<string, string[]> = {
  positionNumber: ["Position Number", "Position #", "Position No"],
  firstName: ["First Name", "Legal First Name"],
  lastName: ["Last Name", "Legal Last Name"],
  middleName: ["Middle Name", "Middle Initial"],
  ssn: ["SSN (National ID)", "SSN", "Social Security Number"],
  address: ["Address Line 1", "Address", "Street Address"],
  city: ["City"],
  state: ["State"],
  postalCode: ["Postal Code", "Zip Code", "ZIP"],
  wage: ["Compensation rate", "Compensation Rate", "Wage", "Pay Rate"],
  dob: ["Date of Birth", "DOB", "Birth Date"],
  phone: ["Cell Phone", "Mobile Phone", "Phone", "Phone Number"],
  email: ["Email", "Email Address", "Personal Email"],
  appointment: ["Appointment", "Appointment Number", "Appt"],
  effectiveDate: [
    "First Day of Service (Effective Date)",
    "First Day of Service",
    "Effective Date",
    "Start Date",
  ],
};

/**
 * Extract all employee data fields from the current page.
 * Uses FIELD_MAP to try multiple label variants for each field.
 *
 * IMPORTANT: Logs field names only -- NEVER logs extracted values (PII).
 */
export async function extractRawFields(
  page: Page,
): Promise<Record<string, string | null>> {
  const raw: Record<string, string | null> = {};

  for (const [field, labels] of Object.entries(FIELD_MAP)) {
    log.step(`Extracting ${field}...`);
    let value: string | null = null;

    for (const label of labels) {
      value = await extractField(page, label);
      if (value) break;
    }

    // Appointment: extract just the number (e.g. "Casual/Restricted 5" → "5")
    if (field === "appointment" && value) {
      const numMatch = value.match(/(\d+)/);
      value = numMatch?.[1] ?? value;
    }

    raw[field] = value;
  }

  return raw;
}

/**
 * Extract department number and recruitment number from the CRM record page
 * (ONB_ViewOnboarding). MUST be called AFTER selectLatestResult() and BEFORE
 * navigateToSection("UCPath Entry Sheet").
 *
 * Department number is parsed from parenthesized text in the department field
 * (e.g., "Computer Science (000412)" -> "000412").
 *
 * IMPORTANT: Logs field names only -- NEVER logs extracted values (PII).
 */
export async function extractRecordPageFields(
  page: Page,
): Promise<{ departmentNumber: string | null; recruitmentNumber: string | null }> {
  log.step("Extracting record page fields (dept#, recruitment#)...");

  // SELECTOR: best-guess labels -- need live verification
  const DEPT_LABELS = ["Department", "Department Name", "Dept"];
  const RECRUIT_LABELS = ["Recruitment Number", "Recruitment #", "Recruitment No", "Req Number"];

  let deptText: string | null = null;
  for (const label of DEPT_LABELS) {
    deptText = await extractField(page, label);
    if (deptText) break;
  }

  let recruitmentNumber: string | null = null;
  for (const label of RECRUIT_LABELS) {
    recruitmentNumber = await extractField(page, label);
    if (recruitmentNumber) break;
  }

  // Parse department number from parenthesized text
  const departmentNumber = deptText ? parseDepartmentNumber(deptText) : null;

  log.step(`Record page extraction complete (dept#: ${departmentNumber ? "found" : "not found"}, recruitment#: ${recruitmentNumber ? "found" : "not found"})`);

  return { departmentNumber, recruitmentNumber };
}
