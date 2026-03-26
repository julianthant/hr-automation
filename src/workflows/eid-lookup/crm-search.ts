/**
 * CRM search for EID Lookup cross-verification.
 *
 * Searches ACT CRM by name (last name, then first name) and extracts
 * key fields from the record page for cross-referencing with UCPath.
 *
 * Reuses existing CRM modules: loginToACTCrm, extractField.
 */

import type { Page } from "playwright";
import { CRM_SEARCH_URL } from "../../config.js";
import { extractField } from "../../crm/extract.js";
import { log } from "../../utils/log.js";

export interface CrmRecord {
  name: string;
  ppsId: string;
  ucpathEmployeeId: string;
  firstDayOfService: string;
  appointmentEndDate: string;
  dateSigned: string;
  department: string;
  titleCode: string;
  ucsdEmail: string;
  personalEmail: string;
  hireType: string;
  recordUrl: string;
}

/**
 * Search CRM by query string and return matching result rows.
 * Each row has: name, offerSentOn, processStage, recordUrl.
 */
async function searchCrm(
  page: Page,
  query: string,
): Promise<Array<{ name: string; offerSentOn: string; processStage: string; recordUrl: string }>> {
  log.step(`CRM: Searching for "${query}"...`);
  const searchUrl = `${CRM_SEARCH_URL}?q=${encodeURIComponent(query)}`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  const rows = page.locator("table tbody tr");
  const count = await rows.count();

  if (count === 0) {
    log.step(`CRM: No results for "${query}"`);
    return [];
  }

  log.step(`CRM: Found ${count} result(s) for "${query}"`);

  const results: Array<{ name: string; offerSentOn: string; processStage: string; recordUrl: string }> = [];
  for (let i = 0; i < count; i++) {
    const cells = rows.nth(i).locator("td");
    const nameCell = cells.nth(0);
    const name = (await nameCell.textContent())?.trim() ?? "";
    const offerSentOn = (await cells.nth(1).textContent())?.trim() ?? "";
    const processStage = (await cells.nth(4).textContent())?.trim() ?? "";
    const link = nameCell.locator("a");
    const href = (await link.count()) > 0 ? (await link.getAttribute("href")) ?? "" : "";
    const recordUrl = href.startsWith("http") ? href : href ? `https://act-crm.my.site.com${href}` : "";

    results.push({ name, offerSentOn, processStage, recordUrl });
  }

  return results;
}

/**
 * Extract key fields from a CRM record page.
 *
 * SELECTORS: verified via playwright-cli v1.1 — record page uses
 * rowheader/cell table layout. extractField() handles both th and td labels.
 */
async function extractCrmRecord(page: Page, recordUrl: string): Promise<CrmRecord | null> {
  await page.goto(recordUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  const firstName = await extractField(page, "Employee First Name") ?? "";
  const lastName = await extractField(page, "Employee Last Name") ?? "";
  const name = `${lastName}, ${firstName}`.trim();

  const ppsId = await extractField(page, "PPS ID") ?? "";
  const ucpathEmployeeId = await extractField(page, "UCPath Employee ID") ?? "";
  const firstDayOfService = await extractField(page, "First Day of Service (Effective Date)")
    ?? await extractField(page, "First Day of Service") ?? "";
  const appointmentEndDate = await extractField(page, "Appointment (Expected Job) End Date")
    ?? await extractField(page, "Appointment End Date") ?? "";
  const dateSigned = await extractField(page, "Date Signed") ?? "";
  const department = await extractField(page, "Department") ?? "";
  const titleCode = await extractField(page, "Title Code/Payroll Title") ?? "";
  const ucsdEmail = await extractField(page, "UCSD Email Address") ?? "";
  const personalEmail = await extractField(page, "Personal Email Address") ?? "";
  const hireType = await extractField(page, "Hire Type") ?? "";

  log.step(`CRM: Extracted record for ${name}`);
  log.step(`  PPS ID: ${ppsId} | UCPath EID: ${ucpathEmployeeId || "(empty)"}`);
  log.step(`  First Day: ${firstDayOfService} | Appt End: ${appointmentEndDate} | Signed: ${dateSigned}`);
  log.step(`  Dept: ${department}`);

  return {
    name,
    ppsId,
    ucpathEmployeeId,
    firstDayOfService,
    appointmentEndDate,
    dateSigned,
    department,
    titleCode,
    ucsdEmail,
    personalEmail,
    hireType,
    recordUrl,
  };
}

/**
 * Search CRM by name parts: first search by last name, then find rows
 * matching the first name. Returns all matching CRM records with extracted fields.
 *
 * Strategy:
 *   1. Search by last name → find rows where name contains first name
 *   2. If no match, search by first name → find rows where name contains last name
 *   3. Click into each match and extract fields
 */
export async function searchCrmByName(
  page: Page,
  lastName: string,
  firstName: string,
): Promise<CrmRecord[]> {
  const records: CrmRecord[] = [];

  // Strategy 1: Search by last name, find matching first name
  const lastNameResults = await searchCrm(page, lastName);
  const firstNameLower = firstName.toLowerCase();
  const lastNameLower = lastName.toLowerCase();

  const matchingRows = lastNameResults.filter((r) => {
    const nameLower = r.name.toLowerCase();
    return nameLower.includes(firstNameLower) && nameLower.includes(lastNameLower);
  });

  if (matchingRows.length > 0) {
    log.step(`CRM: ${matchingRows.length} name match(es) found`);
    for (const row of matchingRows) {
      if (!row.recordUrl) continue;
      const record = await extractCrmRecord(page, row.recordUrl);
      if (record) records.push(record);
    }
    return records;
  }

  // Strategy 2: Search by first name, find matching last name
  log.step(`CRM: No match by last name, trying first name...`);
  const firstNameResults = await searchCrm(page, firstName);
  const matchingRows2 = firstNameResults.filter((r) => {
    const nameLower = r.name.toLowerCase();
    return nameLower.includes(firstNameLower) && nameLower.includes(lastNameLower);
  });

  if (matchingRows2.length > 0) {
    log.step(`CRM: ${matchingRows2.length} name match(es) found via first name search`);
    for (const row of matchingRows2) {
      if (!row.recordUrl) continue;
      const record = await extractCrmRecord(page, row.recordUrl);
      if (record) records.push(record);
    }
    return records;
  }

  log.step(`CRM: No matching records found for "${lastName}, ${firstName}"`);
  return records;
}

/**
 * Check if two dates are within N days of each other.
 * Parses MM/DD/YYYY or "Month D, YYYY" formats.
 */
export function datesWithinDays(date1: string, date2: string, days: number): boolean {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  if (isNaN(d1.getTime()) || isNaN(d2.getTime())) return false;
  const diffMs = Math.abs(d1.getTime() - d2.getTime());
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays <= days;
}
