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

  await ensureJobSummaryDetailPage(page, root, emplId);
  return true;
}

/**
 * Is the Workforce Job Summary DETAIL page up? Signalled by the person-name
 * header OR the Work Location tab being present in `root` (the SAME getFormRoot
 * the extraction uses, so this gate exactly tracks extraction success — a doc
 * whose `extractEmployeeName` would read a real name passes here too, and a doc
 * that would read `<none>` does not; no false-negative regression).
 */
async function isOnJobSummaryDetailPage(root: Locator): Promise<boolean> {
  const [nameCount, tabCount] = await Promise.all([
    jobSummary.personName(root).count().catch(() => 0),
    jobSummary.workLocationTab(root).count().catch(() => 0),
  ]);
  return nameCount > 0 || tabCount > 0;
}

/** Poll `isOnJobSummaryDetailPage`, re-probing getFormRoot (iframe can load late). */
async function waitForDetailPage(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isOnJobSummaryDetailPage(await getFormRoot(page))) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(400);
  }
}

/**
 * Ensure we're on the Workforce Job Summary DETAIL page after a non-empty
 * search, so the downstream tab clicks (Work Location / Job Information) have a
 * detail page to act on. Driven by detail-page PRESENCE, not a grid-id probe:
 *
 * A single unambiguous result auto-redirects to the detail page; multiple rows
 * (rehires / concurrent jobs) stay on a search-results grid that must be drilled
 * into. The old `handleMultiRowGrid` decided "are we on a grid?" via
 * `searchResultsGrid`'s id/class probe, which returned 0 for some live result
 * layouts — so it assumed auto-redirect, never drilled in, and the later Work
 * Location tab click timed out 15s on a tab-less results page ("Detail-page
 * name: <none>", EID 10641172, 2026-06-24). This version drills whenever the
 * detail page ISN'T up, trying the scoped rows first, then a grid-independent
 * fallback, then failing LOUD with a precise message (vs the opaque tab timeout).
 *
 * VERIFIED LIVE 2026-06-24 (EID 10615924, Claudia Bran — 2 empl records): the
 * modern PeopleSoft Fluid "Find an Existing Value" results grid renders rows as
 * clickable `tr[id^="trPTS_CFG_CL_STD_RSL"]` whose own `onclick`
 * (`submitAction_win0(..,'#ICRow<n>')`) drills to the detail page — there is NO
 * `<a>` drill-in link and the page has NO `#main_target_win0` iframe (content is
 * native to the page body). The prior `searchResultRows`/`resultDrillLinks`
 * selectors guessed classic `SEARCH_RESULT`/`PSLEVEL1GRID`/`a[id*=EMPLID]` ids
 * that the Fluid layout never emits, so BOTH returned 0 and this threw for every
 * multi-row EID (6 EIDs on 2026-06-24). Selectors re-mapped against the live grid.
 */
async function ensureJobSummaryDetailPage(
  page: Page,
  root: Locator,
  emplId: string,
): Promise<void> {
  // Single-result auto-redirect (the common case): already on the detail page.
  if (await waitForDetailPage(page, 3_000)) return;

  // Not on the detail page → drill into the first non-terminated result row.
  const scopedRows = jobSummary.searchResultRows(root);
  const scopedTotal = await scopedRows.count().catch(() => 0);
  if (scopedTotal > 0) {
    log.step(`[Job Summary] Search-results grid for EID ${emplId} (${scopedTotal} row(s)) — drilling into the first non-terminated row`);
    let drilled = false;
    for (let i = 0; i < scopedTotal; i++) {
      const row = scopedRows.nth(i);
      const statusText = (
        await jobSummary.rowHrStatusCell(row).textContent({ timeout: 2_000 }).catch(() => "")
      )?.trim() ?? "";
      if (/terminat/i.test(statusText)) {
        log.debug(`[Job Summary] Row ${i + 1}/${scopedTotal} terminated — skipping`);
        continue;
      }
      log.step(`[Job Summary] Drilling into row ${i + 1}/${scopedTotal} (status='${statusText || "unknown"}')`);
      await safeClick(jobSummary.rowDrillInLink(row), {
        timeout: 10_000,
        label: "ucpath job summary row drill-in link",
      });
      drilled = true;
      break;
    }
    if (!drilled) {
      throw new Error(
        `[Job Summary] Multi-row grid for EID ${emplId}: all ${scopedTotal} rows were Terminated — no actionable row to drill into. Verify the EID in Kuali Build, or the employee may already be fully separated.`,
      );
    }
    if (await waitForDetailPage(page, 10_000)) return;
  }

  // The scoped grid probe missed the layout (count 0) but we're still not on the
  // detail page → grid-independent drill via the EMPLID hyperlink each result row
  // carries. Click the first and wait for the detail page.
  const drillLinks = jobSummary.resultDrillLinks(root);
  const linkCount = await drillLinks.count().catch(() => 0);
  if (linkCount > 0) {
    log.step(`[Job Summary] Results layout not matched by the grid probe — drilling via the first of ${linkCount} EMPLID link(s) for EID ${emplId}`);
    await safeClick(drillLinks.first(), {
      timeout: 10_000,
      label: "ucpath job summary results emplid drill link",
    });
    if (await waitForDetailPage(page, 10_000)) return;
  }

  throw new Error(
    `[Job Summary] Could not reach the Workforce Job Summary detail page for EID ${emplId} after searching — ` +
    `the search returned results but neither the detail header/tabs nor a drillable result row resolved ` +
    `(scoped rows=${scopedTotal}, EMPLID links=${linkCount}). The live results layout likely needs its ` +
    `grid / drill-in selectors re-mapped against the real page.`,
  );
}

/** One effective-dated row of the Workforce Job Summary Work Location grid. */
export interface WorkLocationRow {
  /** Effective Date as MM/DD/YYYY, or "" when it could not be read in-row. */
  effectiveDate: string;
  /** Dept ID, e.g. "000414". */
  deptId: string;
  /** Department Description, e.g. "Bookstore". */
  departmentDescription: string;
  /** Position number that anchored the row (logging/debug only). */
  positionNumber: string;
}

/** MM/DD/YYYY → comparable YYYYMMDD integer, or null when malformed. Pure. */
export function effectiveDateKey(mmddyyyy: string): number | null {
  const m = mmddyyyy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return Number(m[3]) * 10000 + Number(m[1]) * 100 + Number(m[2]);
}

/** @deprecated Renamed to `effectiveDateKey`; kept as an alias for callers/tests. */
export const workLocationDateKey = effectiveDateKey;

/**
 * Pick the effective-dated row that describes the state in effect AS OF the
 * separation date: the row with the LATEST Effective Date that is at-or-before
 * the separation date. Generic over ANY Workforce Job Summary grid row that
 * carries an `effectiveDate` (Work Location, Job Information, …) so EVERY tab we
 * read selects the row for the job actually being separated, not a later
 * (post-separation) promotion/transfer row. Pure + unit-pinned so the selection
 * logic is testable independent of the live PeopleSoft grid.
 *
 * Fallbacks (in order):
 *   - No rows                       → null.
 *   - No row carries a usable date  → the FIRST row (legacy behavior; the in-row
 *     date scan found nothing — see the per-tab frozen-column note).
 *   - No `separationDate` supplied  → the row with the LATEST effective date
 *     (= the current state), for non-separations callers.
 *   - Every row is AFTER the sep date → the EARLIEST row (sep date precedes the
 *     first job state — unusual; the earliest is the best available match).
 */
export function pickEffectiveDatedRow<T extends { effectiveDate: string }>(
  rows: T[],
  separationDate?: string,
): T | null {
  if (rows.length === 0) return null;
  const dated = rows
    .map((r) => ({ r, key: effectiveDateKey(r.effectiveDate) }))
    .filter((x): x is { r: T; key: number } => x.key !== null);

  if (dated.length === 0) return rows[0];

  const sepKey = separationDate ? effectiveDateKey(separationDate) : null;
  if (sepKey === null) {
    return dated.reduce((a, b) => (b.key >= a.key ? b : a)).r;
  }

  const atOrBefore = dated.filter((x) => x.key <= sepKey);
  if (atOrBefore.length > 0) {
    return atOrBefore.reduce((a, b) => (b.key >= a.key ? b : a)).r;
  }
  return dated.reduce((a, b) => (b.key <= a.key ? b : a)).r;
}

/**
 * Work Location convenience wrapper over `pickEffectiveDatedRow` — picks the
 * department for the job actually being separated (latest Effective Date ≤ the
 * separation date), which also makes the HDH/non-HDH kronos-skip gate correct
 * for a transfer.
 */
export function pickWorkLocationRow(
  rows: WorkLocationRow[],
  separationDate?: string,
): WorkLocationRow | null {
  return pickEffectiveDatedRow(rows, separationDate);
}

/**
 * Extract department from the Work Location tab, selecting the row for the job
 * state in effect AS OF `opts.separationDate` (latest Effective Date ≤ the
 * separation date) — see `pickWorkLocationRow`. Without a separation date it
 * returns the current (latest effective-dated) row.
 *
 * Cell offsets relative to the Position Number cell (proven on the live grid):
 * Dept ID = +3, Department Description = +4. The Effective Date is read in-row
 * when present; if the grid renders its left columns (Effective Date) in a
 * parallel frozen table — common in PeopleSoft — a count-exact zip recovers the
 * dates, and if neither yields dates the picker falls back to the first row
 * (today's behavior — no regression).
 *
 * NEEDS LIVE VERIFY: confirm the Effective Date is read (logs show a non-empty
 * date per row). If every row logs effectiveDate="" on a live multi-state
 * employee, the dates live in a frozen column that neither the in-row read nor
 * the count-exact zip recovered — map that column explicitly then.
 */
export async function extractWorkLocation(
  page: Page,
  opts: { separationDate?: string } = {},
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

  // Scan EVERY effective-dated row of the Work Location grid (not just the
  // first), so we can pick the one in effect as of the separation date. Each
  // job row is anchored by its Position Number cell; Dept ID = +3, Dept
  // Description = +4 (proven offsets). The Effective Date is read in-row, with a
  // count-exact frozen-column zip as a fallback (see extractWorkLocation docs).
  log.step("[Job Summary] Extracting department (all Work Location rows)...");

  const rows: WorkLocationRow[] = await page.evaluate(() => {
    // NOTE: do NOT define a `const norm = (...) => ...` helper in here — tsx's
    // esbuild keepNames instruments named functions with `__name(...)`, which is
    // undefined in the browser page context → "ReferenceError: __name is not
    // defined" at runtime. Inline the whitespace-collapse instead (anonymous
    // callbacks passed to .map/.find are fine — only NAMED bindings get __name).
    const POS = /^\d{7,8}$/;
    const DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

    // Pass 1 — job rows (Position Number anchored), capturing an in-row date.
    const jobRows: Array<{
      effectiveDate: string;
      deptId: string;
      departmentDescription: string;
      positionNumber: string;
    }> = [];
    for (const tr of Array.from(document.querySelectorAll("tr"))) {
      const cells = Array.from(tr.querySelectorAll("td")).map((td) =>
        (td.textContent ?? "").replace(/\s+/g, " ").trim(),
      );
      const p = cells.findIndex((c) => POS.test(c));
      if (p < 0 || cells.length < p + 5) continue;
      let effectiveDate = "";
      if (p - 2 >= 0 && DATE.test(cells[p - 2])) effectiveDate = cells[p - 2];
      else {
        const d = cells.find((c) => DATE.test(c));
        if (d) effectiveDate = d;
      }
      jobRows.push({
        effectiveDate,
        deptId: cells[p + 3] ?? "",
        departmentDescription: cells[p + 4] ?? "",
        positionNumber: cells[p],
      });
    }

    // Pass 2 — frozen-column fallback. If no job row carried an in-row date,
    // PeopleSoft likely rendered the left columns (incl. Effective Date) in a
    // parallel, row-aligned table. Read an "Effective Date" column and zip by
    // index — but ONLY when its date count EXACTLY matches the job-row count, so
    // a mismatched/unrelated table can never produce a wrong date↔dept pairing.
    if (jobRows.length > 0 && !jobRows.some((r) => r.effectiveDate)) {
      for (const table of Array.from(document.querySelectorAll("table"))) {
        const trs = Array.from((table as HTMLTableElement).rows);
        let col = -1;
        for (const tr of trs) {
          const idx = Array.from(tr.cells).findIndex((c) =>
            /effective date/i.test((c.textContent ?? "").replace(/\s+/g, " ").trim()),
          );
          if (idx >= 0) { col = idx; break; }
        }
        if (col < 0) continue;
        const dates: string[] = [];
        for (const tr of trs) {
          const t = tr.cells[col] ? (tr.cells[col].textContent ?? "").replace(/\s+/g, " ").trim() : "";
          if (DATE.test(t)) dates.push(t);
        }
        if (dates.length === jobRows.length) {
          for (let i = 0; i < jobRows.length; i++) jobRows[i].effectiveDate = dates[i];
          break;
        }
      }
    }

    return jobRows;
  });

  for (const r of rows) {
    log.debug(
      `[Job Summary]   Work Location row: eff=${r.effectiveDate || "<none>"} ` +
      `deptId=${r.deptId || "<none>"} dept="${r.departmentDescription || "<none>"}" pos=${r.positionNumber}`,
    );
  }

  const picked = pickWorkLocationRow(rows, opts.separationDate);
  if (!picked) {
    log.warn("[Job Summary] No Work Location rows found — department blank");
    return { deptId: "", departmentDescription: "" };
  }
  log.step(
    `  Picked Work Location row (eff ${picked.effectiveDate || "<no date>"}` +
    (opts.separationDate ? `, latest ≤ separation ${opts.separationDate}` : ", latest") +
    `): Dept ID ${picked.deptId}, Department "${picked.departmentDescription}"`,
  );
  return { deptId: picked.deptId, departmentDescription: picked.departmentDescription };
}

/** The Job Information data the separation needs (Job Code + its Description). */
export interface JobInfoScan {
  jobCode: string;
  jobDescription: string;
}

/** One effective-dated row of the Job Information grid. */
export interface JobInfoRow extends JobInfoScan {
  /** Effective Date as MM/DD/YYYY, or "" when it could not be read in-row. */
  effectiveDate: string;
}

/**
 * Production polling budget for the Job Information grid render: up to ~10s
 * (20 × 500ms) of re-scans after the tab click before giving up.
 */
const JOB_INFO_POLL_ATTEMPTS = 20;
const JOB_INFO_POLL_INTERVAL_MS = 500;

/**
 * Re-run a Job Information DOM scan until it yields at least one row carrying a
 * job code or the attempt budget is spent.
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
 * Returns the first scan that has any job-coded row, or the last (still-empty)
 * scan once the attempts are exhausted — the caller decides whether empty is
 * fatal. `sleep` is injected so the wall-clock dependency is unit-testable.
 */
export async function pollForJobInfoScan(
  scan: () => Promise<JobInfoRow[]>,
  opts: {
    attempts: number;
    intervalMs: number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<JobInfoRow[]> {
  let last: JobInfoRow[] = [];
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    last = await scan();
    if (last.some((r) => r.jobCode)) return last;
    if (attempt < opts.attempts - 1) await opts.sleep(opts.intervalMs);
  }
  return last;
}

/**
 * Extract job code and description from the Job Information tab, selecting the
 * row for the job state in effect AS OF `opts.separationDate` (latest Effective
 * Date ≤ the separation date) — the SAME effective-date rule the Work Location
 * department uses (see `pickEffectiveDatedRow`). Without a separation date it
 * returns the current (latest effective-dated) job. This stops a promotion /
 * reclassification that took effect AFTER the separation from shipping a
 * post-separation Payroll Title Code / Payroll Title to Kuali.
 *
 * Uses cell indices: cells[0] = Job Code, cells[1] = Description. The Effective
 * Date is read in-row when present; otherwise — as on the Work Location tab —
 * the grid renders its left columns (incl. Effective Date) in a parallel frozen
 * table, so a count-exact zip recovers the per-row dates. If neither yields
 * dates the picker falls back to the first job-coded row (today's behavior — no
 * regression).
 *
 * The grid loads lazily on tab activation, so the DOM scan is POLLED (see
 * `pollForJobInfoScan`) rather than run once — a single post-click scan raced
 * the render and returned empty, shipping a blank Payroll Title to Kuali
 * (separations doc 4290, 2026-06-22). Returns possibly-empty (symmetric with
 * `extractWorkLocation`); `getJobSummaryIdentity` decides that empty on a found
 * record is fatal.
 *
 * NEEDS LIVE VERIFY: confirm a per-row Effective Date is read on the live Job
 * Information grid (logs show a non-empty `eff=` per row). If every row logs
 * effectiveDate="" for a multi-state employee, the dates live in a frozen
 * column that neither the in-row read nor the count-exact zip recovered — map
 * that column explicitly then.
 */
export async function extractJobInfo(
  page: Page,
  opts: { separationDate?: string } = {},
): Promise<JobInfoScan> {
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

  log.step("[Job Summary] Extracting job code (all Job Information rows)...");

  // Scan EVERY job-coded row (not just the first) with its effective date, so
  // the picker can choose the one in effect as of the separation date. Job
  // Information grid columns: Job Code(0), Description(1), Classified Ind(2),
  // Empl Status(3), Full/Part Time(4), Standard Hours(5), FTE(6), ... The
  // Effective Date is read in-row, with a count-exact frozen-column zip as a
  // fallback (mirrors extractWorkLocation — see its inline notes).
  const rows = await pollForJobInfoScan(
    () =>
      page.evaluate(() => {
        // Do NOT define a NAMED `const fn = () => ...` helper here — tsx's
        // esbuild keepNames adds `__name(...)` which is undefined in the page
        // context. Anonymous .map/.find callbacks are fine.
        const JOBCODE = /^\d{6}$/;
        const DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

        // Pass 1 — job-coded rows (cells[0] = job code), capturing an in-row date.
        const jobRows: Array<{
          jobCode: string;
          jobDescription: string;
          effectiveDate: string;
        }> = [];
        for (const tr of Array.from(document.querySelectorAll("tr"))) {
          const cells = Array.from(tr.querySelectorAll("td")).map((td) =>
            (td.textContent ?? "").replace(/\s+/g, " ").trim(),
          );
          if (cells.length < 2 || !JOBCODE.test(cells[0])) continue;
          const inRowDate = cells.find((c) => DATE.test(c)) ?? "";
          jobRows.push({
            jobCode: cells[0],
            jobDescription: cells[1] ?? "",
            effectiveDate: inRowDate,
          });
        }

        // Pass 2 — frozen-column fallback. If no job row carried an in-row date,
        // PeopleSoft likely rendered the left columns (incl. Effective Date) in a
        // parallel, row-aligned table. Read an "Effective Date" column and zip by
        // index — but ONLY when its date count EXACTLY matches the job-row count,
        // so a mismatched/unrelated table can never produce a wrong date↔job pairing.
        if (jobRows.length > 0 && !jobRows.some((r) => r.effectiveDate)) {
          for (const table of Array.from(document.querySelectorAll("table"))) {
            const trs = Array.from((table as HTMLTableElement).rows);
            let col = -1;
            for (const tr of trs) {
              const idx = Array.from(tr.cells).findIndex((c) =>
                /effective date/i.test((c.textContent ?? "").replace(/\s+/g, " ").trim()),
              );
              if (idx >= 0) { col = idx; break; }
            }
            if (col < 0) continue;
            const dates: string[] = [];
            for (const tr of trs) {
              const t = tr.cells[col] ? (tr.cells[col].textContent ?? "").replace(/\s+/g, " ").trim() : "";
              if (DATE.test(t)) dates.push(t);
            }
            if (dates.length === jobRows.length) {
              for (let i = 0; i < jobRows.length; i++) jobRows[i].effectiveDate = dates[i];
              break;
            }
          }
        }

        return jobRows;
      }),
    {
      attempts: JOB_INFO_POLL_ATTEMPTS,
      intervalMs: JOB_INFO_POLL_INTERVAL_MS,
      sleep: (ms) => page.waitForTimeout(ms),
    },
  );

  for (const r of rows) {
    log.debug(
      `[Job Summary]   Job Information row: eff=${r.effectiveDate || "<none>"} ` +
      `jobCode=${r.jobCode || "<none>"} desc="${r.jobDescription || "<none>"}"`,
    );
  }

  const picked = pickEffectiveDatedRow(rows, opts.separationDate);
  if (!picked) {
    log.step("  Job Code: <none>");
    log.step("  Description: <none>");
    return { jobCode: "", jobDescription: "" };
  }
  log.step(
    `  Picked Job Information row (eff ${picked.effectiveDate || "<no date>"}` +
    (opts.separationDate ? `, latest ≤ separation ${opts.separationDate}` : ", latest") +
    `): Job Code ${picked.jobCode || "<none>"}, Description "${picked.jobDescription || "<none>"}"`,
  );
  return { jobCode: picked.jobCode, jobDescription: picked.jobDescription };
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
  opts: { separationDate?: string } = {},
): Promise<JobSummaryIdentity> {
  await navigateToWorkforceJobSummary(page);
  const found = await searchJobSummary(page, emplId);
  if (!found) {
    return { found: false, name: "", data: null };
  }

  const name = await extractEmployeeName(page);
  // Pass the separation date so Work Location resolves to the job state in
  // effect AS OF the separation (latest Effective Date ≤ separation date) — see
  // pickWorkLocationRow. Drives the correct department for the separated job and
  // therefore the correct HDH/non-HDH kronos-skip decision.
  const workLocation = await extractWorkLocation(page, { separationDate: opts.separationDate });
  // Same effective-date rule as Work Location: pick the Job Information row in
  // effect AS OF the separation date, so a post-separation promotion /
  // reclassification never ships a wrong Payroll Title Code / Payroll Title.
  const jobInfo = await extractJobInfo(page, { separationDate: opts.separationDate });

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
