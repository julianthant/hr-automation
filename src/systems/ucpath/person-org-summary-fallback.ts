import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { getContentFrame } from "./navigate.js";
import { dismissPeopleSoftModalMask } from "../common/modal.js";

// Structural type — identical shape to job-summary.ts's JobSummaryData.
// Inlined to avoid circular import (job-summary.ts imports this file).
export interface PersonOrgSummaryLookupResult {
  deptId: string;
  departmentDescription: string;
  jobCode: string;
  jobDescription: string;
}

/**
 * Fallback for `getJobSummaryData` when Workforce Job Summary returns zero
 * results. Person Organizational Summary has broader coverage — some
 * employees (non-SDCMP Business Unit, historical records, certain HR
 * Statuses) don't surface in Workforce Job Summary's default-filtered
 * search but DO appear on Person Org Summary's by-Empl-ID search.
 *
 * We search by EID (exact match, unique) to avoid the name-ambiguity the
 * eid-lookup workflow handles. On single-result redirect, scrape the
 * assignment table for dept ID / department / job code / job description
 * — the same 4 fields `extractWorkLocation` + `extractJobInfo` produce
 * for Workforce Job Summary.
 *
 * Returns `null` if Person Org Summary also comes up empty, or if the
 * page structure doesn't match expectations. Callers should treat `null`
 * as "gave up — no data"; the separations workflow already handles this
 * path (kronos-search's jobSummary becomes a PromiseSettledResult.rejected
 * and `resolveJobSummaryResult` throws with a clean error).
 */

/** Direct URL — same constant as eid-lookup uses. */
const PERSON_ORG_SUMMARY_URL =
  "https://ucphrprdpub.universityofcalifornia.edu/psc/ucphrprd/EMPLOYEE/HRMS/c/NUI_FRAMEWORK.PT_AGSTARTPAGE_NUI.GBL?CONTEXTIDPARAMS=TEMPLATE_ID%3aPTPPNAVCOL&scname=ADMN_UC_ADMIN_LOC_HIRE_NAVCOLL&PanelCollapsible=Y&PTPPB_GROUPLET_ID=UC_HIRE_TASKS_TILE_FL&CRefName=UC_HIRE_TASKS_TILE_FL&AJAXTRANSFER=Y";

/** PeopleSoft iframe search button id (shared with eid-lookup). */
const SEARCH_BTN_ID = "PTS_CFG_CL_WRK_PTS_SRCH_BTN";

/**
 * Navigate to Person Org Summary, search by EID, and extract the same
 * 4 fields that `getJobSummaryData` returns. Best-effort — returns null
 * on any failure rather than throwing, because this is already a fallback
 * path and callers rely on PromiseSettledResult semantics upstream.
 */
export async function lookupJobInfoByEidFromPersonOrgSummary(
  page: Page,
  emplId: string,
): Promise<PersonOrgSummaryLookupResult | null> {
  try {
    log.step(`[Person Org Summary] Fallback lookup for EID ${emplId}...`);
    await page.goto(PERSON_ORG_SUMMARY_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(5_000);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    // Click the sidebar link — Person Org Summary is nested in HR Tasks.
    // Inline selector because this is a one-shot fallback link click; no
    // registry home for it yet.
    const posLink = page.getByRole("link", { name: "Person Organizational Summary" }); // allow-inline-selector -- fallback-only sidebar nav
    await posLink.click({ timeout: 10_000 });
    await page.waitForTimeout(3_000);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    // Collapse sidebar so modal mask + iframe buttons are clickable.
    try {
      const navBtn = page.getByRole("button", { name: "Navigation Area" }); // allow-inline-selector -- fallback-only sidebar collapse
      if ((await navBtn.getAttribute("aria-expanded")) === "true") {
        await navBtn.click({ timeout: 5_000 });
        await page.waitForTimeout(1_000);
      }
    } catch {
      // Sidebar may already be collapsed.
    }

    await dismissPeopleSoftModalMask(page);
    const frame = getContentFrame(page);

    log.step(`[Person Org Summary] Filling Empl ID: ${emplId}`);
    const emplIdInput = frame.getByRole("textbox", { name: "Empl ID" }); // allow-inline-selector -- fallback-only form input
    await emplIdInput.fill(emplId, { timeout: 10_000 });
    await frame.locator(`#${SEARCH_BTN_ID}`).click({ timeout: 10_000 }); // allow-inline-selector -- fallback-only search button id
    await page.waitForTimeout(5_000);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    // PeopleSoft may either (a) redirect to a detail page for the single
    // matching EID, or (b) show "No matching values were found." We detect
    // no-results and bail early; otherwise proceed to scrape the
    // assignment table.
    const noResults = await frame
      .getByText("No matching values were found.") // allow-inline-selector -- literal PeopleSoft empty-results sentinel
      .count()
      .catch(() => 0);
    if (noResults > 0) {
      log.warn(`[Person Org Summary] No results for Empl ID ${emplId}. Fallback exhausted.`);
      return null;
    }

    // Scrape the assignment table — same shape as eid-lookup's
    // drill-in extractor. First row with 12+ cells where cell[3] is a
    // Business Unit code and cell[6] is a department description.
    const assignment = await frame.locator("body").evaluate((body) => { // allow-inline-selector -- fallback-only body scan for assignment row
      const tables = body.querySelectorAll("table");
      for (const table of Array.from(tables)) {
        for (const row of Array.from(table.rows)) {
          const cells = Array.from(row.cells);
          if (cells.length >= 12) {
            const buCell = cells[3]?.textContent?.trim() ?? "";
            const deptCell = cells[6]?.textContent?.trim() ?? "";
            if (/^[A-Z]{4,5}\d?$/.test(buCell) && deptCell && deptCell !== "Department Description") {
              return {
                deptId: cells[5]?.textContent?.trim() ?? "",
                department: deptCell,
                jobCode: cells[7]?.textContent?.trim() ?? "",
                jobCodeDescription: cells[8]?.textContent?.trim() ?? "",
              };
            }
          }
        }
      }
      return null;
    }).catch(() => null);

    if (!assignment) {
      log.warn(`[Person Org Summary] Could not locate assignment row for EID ${emplId}. Fallback exhausted.`);
      return null;
    }

    log.success(
      `[Person Org Summary] Recovered for EID ${emplId}: `
      + `deptId=${assignment.deptId} dept='${assignment.department}' `
      + `jobCode=${assignment.jobCode} jobDesc='${assignment.jobCodeDescription}'`,
    );
    return {
      deptId: assignment.deptId,
      departmentDescription: assignment.department,
      jobCode: assignment.jobCode,
      jobDescription: assignment.jobCodeDescription,
    };
  } catch (e) {
    log.warn(`[Person Org Summary] Fallback lookup threw: ${errorMessage(e)}`);
    return null;
  }
}
