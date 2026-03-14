import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { extractField } from "../../crm/extract.js";

/**
 * Maps each EmployeeData field name to an array of possible label strings
 * found on the UCPath Entry Sheet. Ordered by likelihood.
 */
const FIELD_MAP: Record<string, string[]> = {
  positionNumber: ["Position Number", "Position #", "Position No"],
  firstName: ["First Name", "Legal First Name"],
  lastName: ["Last Name", "Legal Last Name"],
  ssn: ["SSN", "Social Security", "Social Security Number"],
  address: ["Address", "Street Address", "Address Line 1"],
  city: ["City"],
  state: ["State"],
  postalCode: ["Postal Code", "Zip Code", "ZIP"],
  wage: ["Wage", "Pay Rate", "Salary", "Compensation"],
  effectiveDate: ["Effective Date", "Start Date", "Hire Date"],
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

    raw[field] = value;
  }

  return raw;
}
