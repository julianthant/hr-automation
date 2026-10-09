/**
 * CRM search orchestration for EID Lookup cross-verification.
 *
 * Owns which query strategies to try and which resulting CRM record to
 * prefer — the raw Playwright search/scrape and record-page navigation +
 * extraction (incl. the post-navigation identity sanity check) live in
 * `src/systems/crm/onboarding-records.ts` (promoted there 2026-07-08 so this
 * workflow file stops owning selectors, per `src/systems/CLAUDE.md`).
 */

import type { Page } from "playwright";
import {
  searchCrmOnboardingResultRows,
  extractCrmOnboardingRecord,
  type CrmOnboardingRecord,
  type CrmOnboardingSearchRow,
} from "../../systems/crm/index.js";
import { log } from "../../utils/log.js";

export type CrmRecord = CrmOnboardingRecord;

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
    onAfterSearch?: (query: string, rows: CrmOnboardingSearchRow[]) => Promise<void>;
  } = {},
): Promise<CrmRecord[]> {
  const records: CrmRecord[] = [];
  const requiredTokens = `${lastName} ${firstName}`
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z]/g, "").toLowerCase())
    .filter((token) => token.length >= 2);
  const selected = new Map<string, CrmOnboardingSearchRow>();

  for (const query of buildCrmNameSearchQueries(lastName, firstName)) {
    const rows = await searchCrmOnboardingResultRows(page, query);
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
    records.push(await extractCrmOnboardingRecord(page, row.recordUrl));
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
    onAfterSearch?: (query: string, rows: CrmOnboardingSearchRow[]) => Promise<void>;
  } = {},
): Promise<CrmRecord[]> {
  const rows = await searchCrmOnboardingResultRows(page, emplId);
  await options.onAfterSearch?.(emplId, rows);

  const records: CrmRecord[] = [];
  for (const row of rows) {
    if (!row.recordUrl) continue;
    const record = await extractCrmOnboardingRecord(page, row.recordUrl);
    if (record.ucpathEmployeeId.trim() === emplId) records.push(record);
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
    onAfterSearch?: (query: string, rows: CrmOnboardingSearchRow[]) => Promise<void>;
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
 * When an EID is supplied, ONLY a record whose UCPath Employee ID matches it
 * qualifies — a CRM name search can return records for a DIFFERENT,
 * similarly-named person, so silently falling back to the first record on a
 * mismatch would read that other person's Start Date / Title (root
 * CLAUDE.md "Fail loud"). Falls back to the sole record only when no EID was
 * supplied to check against and there is exactly one candidate; returns
 * undefined (no confident pick) when the EID doesn't match any record, or
 * none was supplied and multiple records leave the choice ambiguous, or
 * there are no records at all.
 */
export function pickCrmRecord(records: CrmRecord[], emplId?: string): CrmRecord | undefined {
  if (records.length === 0) return undefined;
  const eid = emplId?.trim();
  if (eid) return records.find((r) => r.ucpathEmployeeId.trim() === eid);
  return records.length === 1 ? records[0] : undefined;
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
