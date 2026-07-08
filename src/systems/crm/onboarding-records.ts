import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { TIMEOUTS, CRM_SEARCH_URL } from "../../config.js";
import { search as searchSelectors } from "./selectors.js";
import { extractField } from "./extract.js";

/**
 * CRM onboarding search + record extraction — the low-level Playwright
 * driver for ACT CRM's `?q=` search grid and the `ONB_ViewOnboarding` record
 * page. Promoted out of `src/workflows/person-lookup/crm-search.ts` (2026-07-08)
 * so the workflow layer stops owning selectors/scrape logic — orchestration
 * (which query to try, which record to prefer) stays in person-lookup;
 * navigation + extraction belongs here per `src/systems/CLAUDE.md`.
 */

export interface CrmOnboardingSearchRow {
  name: string;
  offerSentOn: string;
  processStage: string;
  recordUrl: string;
}

export interface CrmOnboardingRecord {
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
 * Search the ACT CRM onboarding portal by query string (name token or EID)
 * and scrape every result row's name / offer-sent-on / process-stage /
 * record link. Returns `[]` on a genuine zero-result search (a real outcome,
 * not an error — the `?q=` search is fuzzy, see `src/systems/crm/CLAUDE.md`).
 */
export async function searchCrmOnboardingResultRows(
  page: Page,
  query: string,
): Promise<CrmOnboardingSearchRow[]> {
  log.step(`CRM: Searching for "${query}"...`);
  const searchUrl = `${CRM_SEARCH_URL}?q=${encodeURIComponent(query)}`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.navigation });
  await page.waitForLoadState("networkidle", { timeout: TIMEOUTS.navigation }).catch(() => {});

  const rows = searchSelectors.resultRows(page);
  const count = await rows.count();

  if (count === 0) {
    log.step(`CRM: No results for "${query}"`);
    return [];
  }

  log.step(`CRM: Found ${count} result(s) for "${query}"`);

  const results: CrmOnboardingSearchRow[] = [];
  for (let i = 0; i < count; i++) {
    const cells = searchSelectors.resultRowCells(page, i);
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
    const link = searchSelectors.resultRowNameLink(page, i);
    const href = (await link.count()) > 0 ? (await link.getAttribute("href")) ?? "" : "";
    const recordUrl = href.startsWith("http") ? href : href ? `https://act-crm.my.site.com${href}` : "";

    results.push({ name, offerSentOn, processStage, recordUrl });
  }

  return results;
}

/**
 * True when a scraped/extracted onboarding record carries ANY identifying
 * data (a name, PPS ID, or UCPath Employee ID). Pure — used as the
 * post-navigation sanity gate in `extractCrmOnboardingRecord`.
 */
export function hasIdentifyingCrmData(
  record: Pick<CrmOnboardingRecord, "name" | "ppsId" | "ucpathEmployeeId">,
): boolean {
  const nameContent = record.name.replace(/[,\s]/g, "");
  return Boolean(nameContent || record.ppsId || record.ucpathEmployeeId);
}

/**
 * True when the page's current URL stayed on the same host as the record URL
 * we asked it to navigate to. A session timeout / re-auth redirect lands on a
 * different host (SSO/login), which this catches BEFORE extraction is even
 * attempted. Pure — takes plain strings so it's unit-testable without a page.
 */
export function navigatedToCrmRecordHost(actualUrl: string, expectedUrl: string): boolean {
  try {
    return new URL(actualUrl).hostname === new URL(expectedUrl).hostname;
  } catch {
    return false;
  }
}

/**
 * Navigate to a CRM onboarding record page and extract its key fields.
 *
 * SELECTORS: verified via playwright-cli v1.1 — record page uses
 * rowheader/cell table layout. extractField() handles both th and td labels.
 *
 * Post-navigation identity sanity check (fail loud, root CLAUDE.md): before
 * trusting the extracted fields, confirms (1) the browser actually landed on
 * the CRM host it was told to (not redirected to a login/session-timeout
 * page) and (2) the extraction produced SOME identifying data (name, PPS ID,
 * or UCPath Employee ID). A record with neither is evidence of a failed
 * navigation or a stale link — not a genuine blank record — so this throws
 * instead of returning an empty-ish record for the caller to silently act on
 * ("acting on whatever record loaded").
 */
export async function extractCrmOnboardingRecord(
  page: Page,
  recordUrl: string,
): Promise<CrmOnboardingRecord> {
  await page.goto(recordUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUTS.navigation });
  await page.waitForLoadState("networkidle", { timeout: TIMEOUTS.navigation }).catch(() => {});

  if (!navigatedToCrmRecordHost(page.url(), recordUrl)) {
    throw new Error(
      `CRM record navigation left the expected host — landed on "${page.url()}" instead of "${recordUrl}" (possible session timeout or redirect)`,
    );
  }

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

  const record: CrmOnboardingRecord = {
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

  if (!hasIdentifyingCrmData(record)) {
    throw new Error(
      `CRM record at "${recordUrl}" produced no identifying data (blank name/PPS ID/UCPath Employee ID) — likely a failed navigation or stale link; refusing to treat this as a valid record`,
    );
  }

  log.step(`CRM: Extracted record for ${name}`);
  log.step(`  PPS ID: ${ppsId} | UCPath EID: ${ucpathEmployeeId || "(empty)"}`);
  log.step(`  First Day: ${firstDayOfService} | Appt End: ${appointmentEndDate} | Signed: ${dateSigned}`);
  log.step(`  Dept: ${department}`);

  return record;
}
