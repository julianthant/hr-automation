import type { Page, Locator } from "playwright";
import { log } from "../../utils/log.js";
import { errorMessage, classifyPlaywrightError } from "../../utils/errors.js";
import { jobSummary } from "./selectors.js";
import { waitForPeopleSoftProcessing } from "./navigate.js";
import { dismissPeopleSoftModalMask } from "../common/modal.js";
import { lookupJobInfoByEidFromPersonOrgSummary } from "./person-org-summary-fallback.js";
import { lookupEmplIdByName } from "./employee-search.js";

/** Direct URL — skips sidebar, no iframe wrapper. */
const JOB_SUMMARY_URL =
  "https://ucphrprdpub.universityofcalifornia.edu/psc/ucphrprd/EMPLOYEE/HRMS/c/ADMINISTER_WORKFORCE_(GBL).WF_JOB_SUMMARY.GBL";

export interface JobSummaryData {
  deptId: string;
  departmentDescription: string;
  jobCode: string;
  jobDescription: string;
  /**
   * The EID that actually resolved. Matches the input `emplId` unless the
   * name-based fallback fired (tier 3 of the cascade — see
   * `getJobSummaryData` jsdoc). Callers that downstream fill the EID onto
   * UCPath Smart HR forms should use this value, not the input — it may
   * correct an upstream typo.
   */
  emplIdUsed: string;
}

export interface GetJobSummaryOpts {
  /**
   * Employee name hint ("Last, First Middle" or "First Last") used as a
   * last-resort fallback when tiers 1 and 2 return empty. Pass this when
   * you have both an EID and a name from different upstream systems; the
   * name will cross-check the EID when UCPath doesn't recognize it.
   */
  nameHint?: string;
}

/**
 * Get the correct locator root — handles both iframe and direct URL cases.
 * When accessed via sidebar (activity guide), content is inside #main_target_win0.
 * When accessed via direct URL, content is directly in the page.
 */
async function getFormRoot(page: Page): Promise<Locator> {
  // Check if content is in an iframe
  const iframe = jobSummary.mainTargetIframeProbe(page);
  if ((await iframe.count()) > 0) {
    log.step("[Job Summary] Content is inside iframe");
    return page.frameLocator("#main_target_win0").locator("body"); // allow-inline-selector -- iframe root + body descent
  }
  // Direct URL — no iframe
  return page.locator("body"); // allow-inline-selector -- plain body root
}

/**
 * Navigate directly to Workforce Job Summary via URL.
 * No sidebar clicking needed.
 */
export async function navigateToWorkforceJobSummary(page: Page): Promise<void> {
  // Check current URL — skip nav if already there
  if (page.url().includes("WF_JOB_SUMMARY")) {
    log.step("[Job Summary] Already on Workforce Job Summary page");
    return;
  }

  log.step("[Job Summary] Navigating via direct URL...");
  await page.goto(JOB_SUMMARY_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(3_000);

  // Handle campus discovery redirect
  if (page.url().includes("ucpathdiscovery")) {
    log.step("[Job Summary] Campus discovery page — selecting UCSD...");
    await jobSummary.campusDiscoveryUcsdLink(page).click({ timeout: 10_000 });
    await page.waitForTimeout(5_000);
  }

  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  log.success("[Job Summary] Page loaded");
}

/**
 * Search for an employee by Empl ID. Returns `true` if results were found,
 * `false` if the page shows "No matching values were found." — a common
 * state for certain employee types (non-UCSD Business Unit, historical
 * records, etc.) that Workforce Job Summary's default filters exclude.
 *
 * Callers should fall back to `lookupJobInfoByEidFromPersonOrgSummary`
 * when this returns `false`.
 */
export async function searchJobSummary(page: Page, emplId: string): Promise<boolean> {
  const root = await getFormRoot(page);

  log.step(`[Job Summary] Searching for Empl ID: ${emplId}`);
  await jobSummary.emplIdInput(root).fill(emplId, { timeout: 10_000 });
  await jobSummary.searchButton(root).click({ timeout: 10_000 });

  await page.waitForTimeout(5_000);

  // Detect the "no results" state. PeopleSoft shows literal text:
  //   "No matching values were found."
  // when the search criteria match zero rows. Without this check the
  // subsequent Work Location tab click waits 15–30s before timing out
  // on a phantom locator.
  const noResults = await root
    .getByText("No matching values were found.") // allow-inline-selector -- literal PeopleSoft empty-results sentinel
    .count()
    .catch(() => 0);
  if (noResults > 0) {
    log.warn(`[Job Summary] No matching values for Empl ID ${emplId} — Workforce Job Summary search returned empty.`);
    return false;
  }
  log.success(`[Job Summary] Results loaded for ${emplId}`);
  return true;
}

/**
 * Extract department from the Work Location tab.
 * Uses cell indices: cells[3] = Dept ID, cells[4] = Department Description.
 */
export async function extractWorkLocation(
  page: Page,
): Promise<{ deptId: string; departmentDescription: string }> {
  const root = await getFormRoot(page);

  log.step("[Job Summary] Clicking Work Location tab...");
  // Today's run on doc 3917 saw this click flake while same-day sibling docs
  // succeeded — transient PeopleSoft processing state, not a selector issue.
  // Wait for any in-flight processing before the tab click, then retry once.
  const psFrame = page.frameLocator("#main_target_win0"); // allow-inline-selector -- iframe FrameLocator for PS processing probe

  // Pre-click page health dump — when Work Location flakes we want to know
  // from logs alone whether the iframe was present, the URL drifted, or the
  // selector simply had no matches. `page.frames()` is sync in Playwright.
  const frameCount = page.frames().length;
  const url = page.url();
  const rootCountCheck = await root.count().catch(() => -1);
  log.debug(
    `[Job Summary] pre-click state: url=${url} frames=${frameCount} root-matches=${rootCountCheck}`,
  );

  await waitForPeopleSoftProcessing(psFrame, 15_000).catch(() => {});

  const clickOnce = async (): Promise<void> => {
    // Dismiss PeopleSoft's transparent modal mask before every attempt — it
    // leaks across tab switches and "subtree intercepts pointer events" the
    // click. Re-probe the form root because direct-URL navigation can inject
    // the iframe late (first probe runs at function entry, before the
    // iframe loads).
    await dismissPeopleSoftModalMask(page);
    const attemptRoot = await getFormRoot(page);
    await jobSummary.workLocationTab(attemptRoot).click({ timeout: 15_000 });
  };

  try {
    await clickOnce();
  } catch (e) {
    const classified = classifyPlaywrightError(e);
    log.warn(
      `[Job Summary] Work Location tab click flaked (${classified.kind}) — retrying once. url=${page.url()}: ${errorMessage(e)}`,
    );
    await page.waitForTimeout(2_000);
    await waitForPeopleSoftProcessing(psFrame, 15_000).catch(() => {});
    await clickOnce();
  }
  await page.waitForTimeout(3_000);

  // Extract first data row using PeopleSoft grid IDs
  // Work Location grid columns: Position Number(0), Description(1), Company(2),
  // Dept ID(3), Department Description(4), Location(5), Business Unit(6), ...
  log.step("[Job Summary] Extracting department...");

  const result = await page.evaluate(() => {
    // Find all rows that contain a position number (8-digit pattern)
    const rows = document.querySelectorAll("tr");
    for (const row of rows) {
      const cells = row.querySelectorAll("td");
      if (cells.length >= 5) {
        const posNum = cells[0]?.textContent?.trim() ?? "";
        // Position numbers are 8 digits
        if (/^\d{7,8}$/.test(posNum)) {
          return {
            deptId: cells[3]?.textContent?.trim() ?? "",
            departmentDescription: cells[4]?.textContent?.trim() ?? "",
          };
        }
      }
    }
    return { deptId: "", departmentDescription: "" };
  });

  log.step(`  Dept ID: ${result.deptId}`);
  log.step(`  Department: ${result.departmentDescription}`);
  return result;
}

/**
 * Extract job code and description from the Job Information tab.
 * Uses cell indices: cells[0] = Job Code, cells[1] = Description.
 */
export async function extractJobInfo(
  page: Page,
): Promise<{ jobCode: string; jobDescription: string }> {
  log.step("[Job Summary] Clicking Job Information tab...");
  // Same modal-mask + re-probe pattern as extractWorkLocation — the tab
  // click can flake on the same transparent overlay.
  await dismissPeopleSoftModalMask(page);
  const root = await getFormRoot(page);
  await jobSummary.jobInformationTab(root).click({ timeout: 10_000 });
  await page.waitForTimeout(3_000);

  // Job Information grid columns: Job Code(0), Description(1), Classified Ind(2),
  // Empl Status(3), Full/Part Time(4), Standard Hours(5), FTE(6), ...
  log.step("[Job Summary] Extracting job code...");

  const result = await page.evaluate(() => {
    const rows = document.querySelectorAll("tr");
    for (const row of rows) {
      const cells = row.querySelectorAll("td");
      if (cells.length >= 2) {
        const jobCode = cells[0]?.textContent?.trim() ?? "";
        // Job codes are 6 digits
        if (/^\d{6}$/.test(jobCode)) {
          return {
            jobCode,
            jobDescription: cells[1]?.textContent?.trim() ?? "",
          };
        }
      }
    }
    return { jobCode: "", jobDescription: "" };
  });

  log.step(`  Job Code: ${result.jobCode}`);
  log.step(`  Description: ${result.jobDescription}`);
  return result;
}

/**
 * Full flow: navigate, search, extract all data.
 *
 * Three-tier cascade (each tier only runs if the prior returned empty):
 *
 * 1. **Workforce Job Summary by EID** — the primary path. Default filters
 *    (Business Unit, HR Status, Organizational Relationship) exclude
 *    historical records and non-SDCMP BUs, so sometimes this returns
 *    empty even for a valid EID.
 * 2. **Person Organizational Summary by EID** — broader coverage, fixed
 *    iframe layout. Shipped 2026-04-23 (840280e). Handles the
 *    "employee exists but Workforce filters hid them" case.
 * 3. **Name-based EID lookup** (opt-in via `opts.nameHint`) — when BOTH
 *    EID-based tiers fail AND a name hint was provided, search Person
 *    Org Summary by name to find the correct EID, then retry tier 2
 *    with that EID. Catches upstream typos (e.g. HR admin entered
 *    `1058653` for an employee whose real EID is `10586530`).
 *
 * Returns `emplIdUsed` in the result so callers can detect when tier 3
 * changed the EID and thread the corrected value into downstream steps.
 */
export async function getJobSummaryData(
  page: Page,
  emplId: string,
  opts?: GetJobSummaryOpts,
): Promise<JobSummaryData> {
  await navigateToWorkforceJobSummary(page);
  const found = await searchJobSummary(page, emplId);

  if (found) {
    const workLocation = await extractWorkLocation(page);
    const jobInfo = await extractJobInfo(page);
    return {
      deptId: workLocation.deptId,
      departmentDescription: workLocation.departmentDescription,
      jobCode: jobInfo.jobCode,
      jobDescription: jobInfo.jobDescription,
      emplIdUsed: emplId,
    };
  }

  // Tier 2: Person Org Summary by EID.
  log.warn(`[Job Summary] Workforce Job Summary returned no results for EID ${emplId}. Falling back to Person Organizational Summary.`);
  const tier2 = await lookupJobInfoByEidFromPersonOrgSummary(page, emplId);
  if (tier2) return { ...tier2, emplIdUsed: emplId };

  // Tier 3: name-based fallback (only when caller supplied a name hint).
  if (opts?.nameHint) {
    log.warn(`[Job Summary] Tier 2 also empty for EID ${emplId}. Attempting name-based fallback with hint='${opts.nameHint}'.`);
    const nameResult = await lookupEmplIdByName(page, opts.nameHint);
    if (nameResult && nameResult.emplId && nameResult.emplId !== emplId) {
      log.warn(
        `[Job Summary] Name fallback resolved '${opts.nameHint}' to EID ${nameResult.emplId} (input EID was ${emplId}). Retrying Person Org Summary with corrected EID.`,
      );
      const tier3 = await lookupJobInfoByEidFromPersonOrgSummary(page, nameResult.emplId);
      if (tier3) {
        log.success(`[Job Summary] Recovered via name fallback: emplIdUsed=${nameResult.emplId} (input was ${emplId}).`);
        return { ...tier3, emplIdUsed: nameResult.emplId };
      }
      log.warn(
        `[Job Summary] Name fallback found EID ${nameResult.emplId} but Person Org Summary still returned no job data for it.`,
      );
    } else if (nameResult && nameResult.emplId === emplId) {
      log.warn(
        `[Job Summary] Name fallback resolved to the same EID ${emplId} that already failed — no corrective action possible.`,
      );
    } else {
      log.warn(`[Job Summary] Name fallback exhausted — no match for '${opts.nameHint}'.`);
    }
  }

  throw new Error(
    `Job Summary lookup failed for EID ${emplId}: `
    + `neither Workforce Job Summary nor Person Organizational Summary returned results`
    + (opts?.nameHint ? ` (name fallback with hint '${opts.nameHint}' also failed)` : ""),
  );
}
