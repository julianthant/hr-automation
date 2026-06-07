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
import { extractField } from "../../systems/crm/extract.js";
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
    // Read total cell count once so we can safely skip columns that don't
    // exist on this row. The CRM search view occasionally renders rows with
    // fewer than the expected 5 columns (e.g. condensed layout when the user
    // has filters applied server-side); `cells.nth(4).textContent()` would
    // otherwise block for the full 30s auto-wait before throwing.
    const cellCount = await cells.count();
    const nameCell = cells.nth(0);
    const name = cellCount > 0 ? ((await nameCell.textContent())?.trim() ?? "") : "";
    const offerSentOn = cellCount > 1 ? ((await cells.nth(1).textContent())?.trim() ?? "") : "";
    const processStage = cellCount > 4 ? ((await cells.nth(4).textContent())?.trim() ?? "") : "";
    const link = nameCell.locator("a");
    const href = (await link.count()) > 0 ? (await link.getAttribute("href")) ?? "" : "";
    const recordUrl = href.startsWith("http") ? href : href ? `https://act-crm.my.site.com${href}` : "";

    results.push({ name, offerSentOn, processStage, recordUrl });
  }

  return results;
}

export function buildCrmNameSearchQueries(lastName: string, firstName: string): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  const add = (query: string): void => {
    const normalized = query.trim().replace(/\s+/g, " ");
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(normalized);
  };
  add(lastName);
  add(firstName);
  for (const token of `${lastName} ${firstName}`.split(/\s+/)) {
    const letters = token.replace(/[^A-Za-z]/g, "");
    if (letters.length < 2) continue;
    add(token);
  }
  return queries;
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
  options: {
    onAfterSearch?: (query: string, rows: Array<{ name: string; offerSentOn: string; processStage: string; recordUrl: string }>) => Promise<void>;
  } = {},
): Promise<CrmRecord[]> {
  const records: CrmRecord[] = [];
  const requiredTokens = `${lastName} ${firstName}`
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z]/g, "").toLowerCase())
    .filter((token) => token.length >= 2);
  const selected = new Map<string, { name: string; offerSentOn: string; processStage: string; recordUrl: string }>();

  for (const query of buildCrmNameSearchQueries(lastName, firstName)) {
    const rows = await searchCrm(page, query);
    await options.onAfterSearch?.(query, rows);
    const matchingRows = rows.filter((r) => {
      const nameLower = r.name.toLowerCase();
      return requiredTokens.every((token) => nameLower.includes(token));
    });
    if (matchingRows.length > 0) {
      log.step(`CRM: ${matchingRows.length} name match(es) found via query "${query}"`);
      for (const row of matchingRows) {
        const key = row.recordUrl || row.name;
        if (!selected.has(key)) selected.set(key, row);
      }
    }
    if (selected.size > 0) break;
  }

  for (const row of selected.values()) {
    if (!row.recordUrl) continue;
    const record = await extractCrmRecord(page, row.recordUrl);
    if (record) records.push(record);
  }
  if (records.length > 0) return records;

  log.step(`CRM: No matching records found for "${lastName}, ${firstName}"`);
  return records;
}

/**
 * Search CRM by Empl ID via the global `?q=` search, then extract each result
 * row and keep only records whose UCPath Employee ID matches `emplId`.
 *
 * CRM's onboarding search is global, so an EID query surfaces the person's
 * onboarding record directly — more precise than a name search when the EID is
 * known. Returns an empty array when the EID query yields nothing (callers fall
 * back to a name search).
 */
async function searchCrmByEid(
  page: Page,
  emplId: string,
  options: {
    onAfterSearch?: (query: string, rows: Array<{ name: string; offerSentOn: string; processStage: string; recordUrl: string }>) => Promise<void>;
  } = {},
): Promise<CrmRecord[]> {
  const rows = await searchCrm(page, emplId);
  await options.onAfterSearch?.(emplId, rows);

  const records: CrmRecord[] = [];
  for (const row of rows) {
    if (!row.recordUrl) continue;
    const record = await extractCrmRecord(page, row.recordUrl);
    if (record && record.ucpathEmployeeId.trim() === emplId) records.push(record);
  }
  if (records.length > 0) {
    log.step(`CRM: ${records.length} record(s) matched EID ${emplId}`);
    return records;
  }
  log.step(`CRM: no record matched EID ${emplId}`);
  return [];
}

/**
 * Resolve CRM records for a person by EID **or** name.
 *
 * When `emplId` is provided, search CRM by the EID first (precise) and fall
 * back to the name search only when the EID query returns no matching record.
 * EID-less inputs go straight to the name search. Used by Person Lookup to
 * source the operator-facing Start Date (CRM First Day of Service) for both
 * name-input and EID-input lookups.
 */
export async function searchCrmByEidOrName(
  page: Page,
  params: { emplId?: string; lastName: string; firstName: string },
  options: {
    onAfterSearch?: (query: string, rows: Array<{ name: string; offerSentOn: string; processStage: string; recordUrl: string }>) => Promise<void>;
  } = {},
): Promise<CrmRecord[]> {
  const emplId = params.emplId?.trim();
  if (emplId) {
    const byEid = await searchCrmByEid(page, emplId, options);
    if (byEid.length > 0) return byEid;
    log.step(`CRM: falling back to name search for "${params.lastName}, ${params.firstName}"`);
  }
  return searchCrmByName(page, params.lastName, params.firstName, options);
}

/**
 * Pick the single CRM record to read operator-facing fields from.
 *
 * Prefers the record whose UCPath Employee ID matches the resolved EID; falls
 * back to the first record. Returns undefined when there are no records.
 */
function pickCrmRecord(records: CrmRecord[], emplId?: string): CrmRecord | undefined {
  if (records.length === 0) return undefined;
  const eid = emplId?.trim();
  const matched = eid ? records.find((r) => r.ucpathEmployeeId.trim() === eid) : undefined;
  return matched ?? records[0];
}

/**
 * Pick the CRM First Day of Service to use as the operator-facing Start Date.
 *
 * Returns "" when there are no records or the chosen record has no First Day of
 * Service (Start Date is CRM-only — no UCPath fallback).
 */
export function pickCrmStartDate(records: CrmRecord[], emplId?: string): string {
  return pickCrmRecord(records, emplId)?.firstDayOfService?.trim() ?? "";
}

/**
 * Strip the leading PeopleSoft job code from a CRM "Title Code/Payroll Title"
 * value so the operator sees the payroll title alone: "4921 - STDT 2" →
 * "STDT 2". Returns the value unchanged (trimmed) when there's no "<code> - "
 * prefix.
 */
export function payrollTitleFromTitleCode(titleCode: string): string {
  return titleCode.replace(/^\s*\d+\s*-\s*/, "").trim();
}

/**
 * Pick the operator-facing payroll title (sans leading code) from the chosen
 * CRM record. Same record-selection rule as {@link pickCrmStartDate}; "" when
 * there are no records or the chosen record has no Title Code/Payroll Title.
 */
export function pickCrmPayrollTitle(records: CrmRecord[], emplId?: string): string {
  return payrollTitleFromTitleCode(pickCrmRecord(records, emplId)?.titleCode ?? "");
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
