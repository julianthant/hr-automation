import type { Page, Locator } from "playwright";
import { log } from "../utils/log.js";

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
 * Try to extract a single field value from the page using multiple strategies.
 * Returns the trimmed text value or null if not found.
 *
 * Strategies:
 * 1. Label-based: find the label text, go to parent, get value from span/dd/td
 * 2. ARIA: use getByLabel for accessibility-associated elements
 * 3. Table cell: find a td containing the label, get the next sibling td
 */
async function extractField(
  page: Page,
  label: string,
): Promise<string | null> {
  // SELECTOR: Strategy 1 -- label-based (Salesforce dt/dd, label/span pairs)
  const byLabel: Locator = page
    .locator(`text="${label}"`)
    .locator("xpath=..")
    .locator("span, dd, td")
    .last();

  // SELECTOR: Strategy 2 -- ARIA label association
  const byAria: Locator = page.getByLabel(label);

  // SELECTOR: Strategy 3 -- table cell lookup (label in one cell, value in next)
  const byTableCell: Locator = page
    .locator(`td:has-text("${label}")`)
    .locator("xpath=following-sibling::td[1]");

  for (const locator of [byLabel, byAria, byTableCell]) {
    try {
      const text = await locator.first().textContent({ timeout: 3_000 });
      if (text && text.trim()) {
        return text.trim();
      }
    } catch {
      continue;
    }
  }

  return null;
}

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
