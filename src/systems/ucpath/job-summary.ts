import type { Page, Locator } from "playwright";
import { log } from "../../utils/log.js";
import { errorMessage, classifyPlaywrightError } from "../../utils/errors.js";
import { jobSummary } from "./selectors.js";
import { waitForPeopleSoftProcessing } from "./navigate.js";
import { dismissPeopleSoftModalMask } from "../common/modal.js";
import { safeClick, safeFill } from "../common/index.js";

/** Direct URL — skips sidebar, no iframe wrapper. */
const JOB_SUMMARY_URL =
  "https://ucphrprdpub.universityofcalifornia.edu/psc/ucphrprd/EMPLOYEE/HRMS/c/ADMINISTER_WORKFORCE_(GBL).WF_JOB_SUMMARY.GBL";

export interface JobSummaryData {
  deptId: string;
  departmentDescription: string;
  jobCode: string;
  jobDescription: string;
}

/**
 * Identity-aware Workforce Job Summary result. Unlike `getJobSummaryData`
 * (which throws when the EID resolves to nothing), this shape lets the caller
 * branch on `found`:
 *
 * - `found: false` → the search returned "No matching values" for the EID. The
 *   caller decides what to do (e.g. separations only falls back to person-lookup
 *   when the typed EID is also short / incomplete).
 * - `found: true`  → `name` is the employee NAME read from the detail-page
 *   header (`jobSummary.personName`, rendered "First Last") and `data` carries
 *   the dept/payroll extraction. The name lets the caller confirm the EID
 *   resolved to the expected person before trusting the data.
 */
export interface JobSummaryIdentity {
  found: boolean;
  /** Detail-page header name when `found`; "" otherwise. */
  name: string;
  /** Dept/payroll extraction when `found`; null otherwise. */
  data: JobSummaryData | null;
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
 * Decide whether `navigateToWorkforceJobSummary` may skip re-navigation.
 *
 * Skipping is safe ONLY when BOTH hold: the URL is on the Workforce Job Summary
 * component AND the Empl ID search box is present. The URL alone is NOT enough —
 * after a prior document drills into the Work Location / Job Information detail
 * tabs, PeopleSoft keeps `WF_JOB_SUMMARY` in the URL (same component) but the
 * search form is gone. A URL-only check therefore wedged every 2nd+ document of
 * a sequential separations batch on a detail view, so the next `searchJobSummary`
 * Empl ID fill timed out (ISS-B02, 2026-06-22). There is no ucpath `resetUrl`
 * that restores the search page between docs, so the step must detect the
 * missing search box and re-navigate itself.
 */
export function canSkipJobSummaryNavigation(state: {
  urlOnComponent: boolean;
  searchBoxPresent: boolean;
}): boolean {
  return state.urlOnComponent && state.searchBoxPresent;
}

/**
 * Navigate directly to Workforce Job Summary via URL.
 * No sidebar clicking needed.
 */
export async function navigateToWorkforceJobSummary(page: Page): Promise<void> {
  // Skip nav only when we are on a USABLE search page — URL on the component AND
  // the Empl ID search box actually present. URL alone is a trap across docs in
  // a batch (see canSkipJobSummaryNavigation / ISS-B02).
  const urlOnComponent = page.url().includes("WF_JOB_SUMMARY");
  if (urlOnComponent) {
    const root = await getFormRoot(page);
    const searchBoxPresent =
      (await jobSummary.emplIdInput(root).count().catch(() => 0)) > 0;
    if (canSkipJobSummaryNavigation({ urlOnComponent, searchBoxPresent })) {
      log.step("[Job Summary] Already on Workforce Job Summary search page");
      return;
    }
    log.step(
      "[Job Summary] On WF_JOB_SUMMARY but the Empl ID search box is absent "
      + "(detail view left by a prior document) — re-navigating to reset search state",
    );
  }

  log.step("[Job Summary] Navigating via direct URL...");
  await page.goto(JOB_SUMMARY_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  // networkidle guards the page load; sleep was redundant.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // Handle campus discovery redirect
  if (page.url().includes("ucpathdiscovery")) {
    log.step("[Job Summary] Campus discovery page — selecting UCSD...");
    await safeClick(jobSummary.campusDiscoveryUcsdLink(page), {
      timeout: 10_000,
      label: "ucpath job summary campus discovery ucsd link",
    });
    // networkidle guards the redirect after campus selection.
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    // Selecting the campus redirects to the campus UCPath portal HOME, not the
    // deep-linked Workforce Job Summary component — so the Empl ID search box is
    // absent and the next `searchJobSummary` fill times out. EVERY doc that hit
    // campus discovery in the 2026-06-22 live separations batch failed this way
    // (9/9, ISS-B04). Re-navigate to the deep link now that the campus cookie is
    // set; this second goto resolves the component without redirecting back to
    // discovery.
    if (!page.url().includes("WF_JOB_SUMMARY")) {
      log.step("[Job Summary] Re-navigating to Job Summary after campus selection...");
      await page.goto(JOB_SUMMARY_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    }
  }
  log.success("[Job Summary] Page loaded");
}

/**
 * Search for an employee by Empl ID. Returns `true` if results were found,
 * `false` if the page shows "No matching values were found." — a state
 * Workforce Job Summary's default filters (Business Unit, HR Status,
 * Organizational Relationship) can produce for valid employees.
 *
 * When UCPath returns multiple rows (rehires, multiple concurrent jobs),
 * PeopleSoft stays on a search-results grid rather than auto-redirecting to
 * the detail page. This function detects the grid, filters out terminated
 * rows, and drills into the first active row so downstream tabs (Work
 * Location / Job Information) find the detail view. Throws if every row is
 * terminated — that's a data problem for the caller, not a retry case.
 *
 * Callers treat `false` as a terminal no-results error. Cross-source
 * auto-fallback was removed intentionally; upstream data needs to be
 * corrected rather than silently worked around.
 */
export async function searchJobSummary(page: Page, emplId: string): Promise<boolean> {
  const root = await getFormRoot(page);

  log.step(`[Job Summary] Searching for Empl ID: ${emplId}`);
  await safeFill(jobSummary.emplIdInput(root), emplId, {
    timeout: 10_000,
    label: "ucpath job summary empl id",
  });
  await safeClick(jobSummary.searchButton(root), {
    timeout: 10_000,
    label: "ucpath job summary search button",
  });

  // Wait for PeopleSoft to process the search and render results (or no-results).
  const psFrame = page.frameLocator("#main_target_win0"); // allow-inline-selector -- iframe FrameLocator for PS processing probe
  await waitForPeopleSoftProcessing(psFrame, 15_000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

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

  await handleMultiRowGrid(page, root, emplId);
  return true;
}

/**
 * Multi-row grid branch. Runs after a non-empty search. If PeopleSoft rendered
 * the search-results grid (2+ rows) rather than auto-redirecting to the
 * detail page, pick the first non-terminated row and drill in. If the grid
 * is not present, the search auto-redirected — nothing to do.
 */
async function handleMultiRowGrid(
  page: Page,
  root: Locator,
  emplId: string,
): Promise<void> {
  const gridCount = await jobSummary
    .searchResultsGrid(root)
    .count()
    .catch(() => 0);
  if (gridCount === 0) {
    // Auto-redirected to detail page; caller proceeds with tab clicks.
    return;
  }

  const rows = jobSummary.searchResultRows(root);
  const total = await rows.count();
  log.step(`[Job Summary] Multi-row grid detected (${total} rows) for EID ${emplId} — filtering for non-terminated`);

  for (let i = 0; i < total; i++) {
    const row = rows.nth(i);
    const statusText = (
      await jobSummary
        .rowHrStatusCell(row)
        .textContent({ timeout: 2_000 })
        .catch(() => "")
    )?.trim() ?? "";
    const isTerminated = /terminat/i.test(statusText);
    log.debug(`[Job Summary] Row ${i + 1}/${total}: status='${statusText}' terminated=${isTerminated}`);
    if (isTerminated) continue;

    log.step(`[Job Summary] Drilling into row ${i + 1}/${total} (status='${statusText || "unknown"}')`);
    await safeClick(jobSummary.rowDrillInLink(row), {
      timeout: 10_000,
      label: "ucpath job summary row drill-in link",
    });
    await page.waitForTimeout(2_000);
    return;
  }

  throw new Error(
    `[Job Summary] Multi-row grid for EID ${emplId}: all ${total} rows were Terminated — no actionable row to drill into. Verify the EID in Kuali Build, or the employee may already be fully separated.`,
  );
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
    await safeClick(jobSummary.workLocationTab(attemptRoot), {
      timeout: 15_000,
      label: "ucpath job summary work location tab",
    });
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
  // Wait for the tab panel to load after click.
  await waitForPeopleSoftProcessing(psFrame, 15_000);

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

/** One scan of the Job Information grid (Job Code + its Description). */
export interface JobInfoScan {
  jobCode: string;
  jobDescription: string;
}

/**
 * Production polling budget for the Job Information grid render: up to ~10s
 * (20 × 500ms) of re-scans after the tab click before giving up.
 */
const JOB_INFO_POLL_ATTEMPTS = 20;
const JOB_INFO_POLL_INTERVAL_MS = 500;

/**
 * Re-run a Job Information DOM scan until it yields a non-empty job code or the
 * attempt budget is spent.
 *
 * Why poll: clicking the Job Information tab loads its grid LAZILY and does not
 * reliably raise the PeopleSoft processing spinner, so `waitForPeopleSoftProcessing`
 * returns on its 2s "spinner never appeared" timeout while the grid rows are
 * still rendering. A single scan right after the click then reads a half-rendered
 * grid, finds no 6-digit job code, and returns empty — which silently shipped a
 * blank Payroll Title Code / Payroll Title to Kuali (separations doc 4290,
 * 2026-06-22). The prior fixed `waitForTimeout(3_000)` (removed by 84beeef7)
 * masked the race; this condition-based wait replaces it.
 *
 * Returns the first non-empty scan, or the last (still-empty) scan once the
 * attempts are exhausted — the caller decides whether empty is fatal. `sleep` is
 * injected so the wall-clock dependency is unit-testable.
 */
export async function pollForJobInfoScan(
  scan: () => Promise<JobInfoScan>,
  opts: {
    attempts: number;
    intervalMs: number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<JobInfoScan> {
  let last: JobInfoScan = { jobCode: "", jobDescription: "" };
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    last = await scan();
    if (last.jobCode) return last;
    if (attempt < opts.attempts - 1) await opts.sleep(opts.intervalMs);
  }
  return last;
}

/**
 * Extract job code and description from the Job Information tab.
 * Uses cell indices: cells[0] = Job Code, cells[1] = Description.
 *
 * The grid loads lazily on tab activation, so the DOM scan is POLLED (see
 * `pollForJobInfoScan`) rather than run once — a single post-click scan raced
 * the render and returned empty, shipping a blank Payroll Title to Kuali
 * (separations doc 4290, 2026-06-22). Returns possibly-empty (symmetric with
 * `extractWorkLocation`); `getJobSummaryIdentity` decides that empty on a found
 * record is fatal.
 */
export async function extractJobInfo(page: Page): Promise<JobInfoScan> {
  log.step("[Job Summary] Clicking Job Information tab...");
  // Same modal-mask + re-probe pattern as extractWorkLocation — the tab
  // click can flake on the same transparent overlay.
  await dismissPeopleSoftModalMask(page);
  const root = await getFormRoot(page);
  await safeClick(jobSummary.jobInformationTab(root), {
    timeout: 10_000,
    label: "ucpath job summary job information tab",
  });
  // Clear any PeopleSoft processing spinner from the tab click. This is NOT a
  // sufficient gate for the grid render — the tab does not always raise a
  // spinner, so this can return ~2s before the rows exist; the poll below is
  // what actually waits for the grid.
  const psFrame2 = page.frameLocator("#main_target_win0"); // allow-inline-selector -- iframe FrameLocator for PS processing probe
  await waitForPeopleSoftProcessing(psFrame2, 15_000);

  log.step("[Job Summary] Extracting job code...");

  // Job Information grid columns: Job Code(0), Description(1), Classified Ind(2),
  // Empl Status(3), Full/Part Time(4), Standard Hours(5), FTE(6), ...
  const result = await pollForJobInfoScan(
    () =>
      page.evaluate(() => {
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
      }),
    {
      attempts: JOB_INFO_POLL_ATTEMPTS,
      intervalMs: JOB_INFO_POLL_INTERVAL_MS,
      sleep: (ms) => page.waitForTimeout(ms),
    },
  );

  log.step(`  Job Code: ${result.jobCode || "<none>"}`);
  log.step(`  Description: ${result.jobDescription || "<none>"}`);
  return result;
}

/**
 * Read the employee display name from the Workforce Job Summary detail-page
 * header (`jobSummary.personName` → `#DERIVED_NAME_DISPLAY_NAME`, rendered
 * "First Last"). Returns "" if the header element is missing — best-effort, so
 * an absent name never throws (the caller treats "" as "no name to compare").
 * Call only after a successful `searchJobSummary` (the detail page must be up).
 */
export async function extractEmployeeName(page: Page): Promise<string> {
  const root = await getFormRoot(page);
  const name = (
    await jobSummary
      .personName(root)
      .textContent({ timeout: 5_000 })
      .catch(() => "")
  )?.trim() ?? "";
  log.step(`[Job Summary] Detail-page name: ${name || "<none>"}`);
  return name;
}

/**
 * Identity-aware Workforce Job Summary fetch. Navigates, searches by EID, and:
 *
 * - returns `{ found: false, name: "", data: null }` when the search returns
 *   "No matching values" — a non-throwing branch the caller acts on (e.g.
 *   separations decides whether to fall back to person-lookup);
 * - returns `{ found: true, name, data }` otherwise, reading the detail-page
 *   header NAME and extracting Work Location + Job Information.
 *
 * Genuine failures (selector/nav timeouts on a found record) still throw — only
 * the "no results" state is converted to `found: false`. No cross-source
 * fallback happens here; the caller owns any name-based EID correction.
 */
export async function getJobSummaryIdentity(
  page: Page,
  emplId: string,
): Promise<JobSummaryIdentity> {
  await navigateToWorkforceJobSummary(page);
  const found = await searchJobSummary(page, emplId);
  if (!found) {
    return { found: false, name: "", data: null };
  }

  const name = await extractEmployeeName(page);
  const workLocation = await extractWorkLocation(page);
  const jobInfo = await extractJobInfo(page);

  // A found, active employee always has a job code on the Job Information tab.
  // An empty one after polling is a GENUINE extraction failure on a found
  // record — the grid never rendered, or the job code isn't the expected
  // 6-digit format. Fail loud rather than returning incomplete data: a
  // found-but-empty result previously let separations fill only the department
  // and ship a blank Payroll Title Code / Payroll Title to Kuali while logging
  // success (doc 4290, 2026-06-22). Per this module's contract, only the
  // "no matching values" state is a soft `found: false`; this is not that —
  // it throws directly (the inline getJobSummaryIdentity caller fails loud).
  if (!jobInfo.jobCode) {
    throw new Error(
      `Workforce Job Summary found EID '${emplId}' but could not extract a Payroll Title Code `
      + `from the Job Information tab (job code empty after polling the grid). The Job Information `
      + `grid likely did not render in time, or the job code is not the expected 6-digit format. `
      + `Re-run; if it recurs, re-verify the Job Information tab selector / grid layout on the live page.`,
    );
  }

  return {
    found: true,
    name,
    data: {
      deptId: workLocation.deptId,
      departmentDescription: workLocation.departmentDescription,
      jobCode: jobInfo.jobCode,
      jobDescription: jobInfo.jobDescription,
    },
  };
}

/**
 * Full flow: navigate, search, extract Work Location + Job Information.
 *
 * Throws if Workforce Job Summary returns no results for the given EID.
 * No cross-source fallback — upstream data (e.g. a wrong EID in Kuali
 * Build) needs to be corrected rather than silently worked around.
 * Callers should surface the error verbatim so the user can fix the
 * upstream record. Built on `getJobSummaryIdentity`; use that directly when
 * you need the non-throwing `found` branch (and the detail-page name).
 */
export async function getJobSummaryData(
  page: Page,
  emplId: string,
): Promise<JobSummaryData> {
  const identity = await getJobSummaryIdentity(page, emplId);
  if (!identity.found || !identity.data) {
    throw new Error(
      `Workforce Job Summary returned no results for EID '${emplId}'. `
      + `Verify the EID in the upstream record (e.g. Kuali Build) is correct — `
      + `this workflow does not auto-correct via cross-source fallbacks.`,
    );
  }
  return identity.data;
}
