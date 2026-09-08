import type { Page, Locator } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";
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
  emplRecord?: string;
  positionNumber?: string;
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
export async function searchJobSummary(page: Page, emplId: string, jobCode?: string): Promise<boolean> {
  const root = await getFormRoot(page);

  log.step(`[Job Summary] Searching for Empl ID: ${emplId}`);
  await safeFill(jobSummary.emplIdInput(root), emplId, {
    timeout: 10_000,
    label: "ucpath job summary empl id",
  });
  if (jobCode) {
    if (!/^\d{6}$/.test(jobCode)) throw new Error(`Invalid Kuali job code: ${jobCode}`);
    await safeFill(jobSummary.jobCodeSearchInput(root), jobCode, { timeout: 10_000, label: "job-summary job code" });
  }
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
 *
 * Multiple NON-terminated rows (2+ concurrent jobs for one EID — see the
 * "concurrent jobs" case above) are a GENUINE ambiguity, not a rehire: a rehire
 * leaves old rows Terminated and only the new one active, but concurrent jobs
 * are simultaneously active. Picking "the first" would silently choose which
 * job's Work Location/Job Information gets read/separated. Rows are scanned
 * for status BEFORE any click, and 2+ non-terminated rows throws rather than
 * drilling into an arbitrary one.
 */
async function ensureJobSummaryDetailPage(
  page: Page,
  root: Locator,
  emplId: string,
): Promise<void> {
  // Single-result auto-redirect (the common case): already on the detail page.
  if (await waitForDetailPage(page, 3_000)) return;

  // Not on the detail page → find the non-terminated result row. Scan EVERY
  // row's status first (no click yet) so a 2+-concurrent-job ambiguity is
  // caught before committing to a row.
  const scopedRows = jobSummary.searchResultRows(root);
  const scopedTotal = await scopedRows.count().catch(() => 0);
  if (scopedTotal > 0) {
    log.step(`[Job Summary] Search-results grid for EID ${emplId} (${scopedTotal} row(s)) — scanning row statuses`);
    const statuses: string[] = [];
    const nonTerminated: number[] = [];
    for (let i = 0; i < scopedTotal; i++) {
      const row = scopedRows.nth(i);
      const statusText = (
        await jobSummary.rowHrStatusCell(row).textContent({ timeout: 2_000 }).catch(() => "")
      )?.trim() ?? "";
      statuses.push(statusText || "unknown");
      if (/terminat/i.test(statusText)) {
        log.debug(`[Job Summary] Row ${i + 1}/${scopedTotal} terminated — skipping`);
        continue;
      }
      nonTerminated.push(i);
    }
    if (nonTerminated.length === 0) {
      throw new Error(
        `[Job Summary] Multi-row grid for EID ${emplId}: all ${scopedTotal} rows were Terminated — no actionable row to drill into. Verify the EID in Kuali Build, or the employee may already be fully separated.`,
      );
    }
    if (nonTerminated.length > 1) {
      throw new Error(
        `[Job Summary] Multi-row grid for EID ${emplId}: ${nonTerminated.length} non-terminated rows found `
        + `(concurrent jobs) — row statuses: ${statuses.join(", ")}. Cannot determine which job is being `
        + `separated without disambiguation; resolve the correct position/job manually before re-running.`,
      );
    }
    const rowIndex = nonTerminated[0];
    const row = scopedRows.nth(rowIndex);
    log.step(`[Job Summary] Drilling into row ${rowIndex + 1}/${scopedTotal} (status='${statuses[rowIndex]}')`);
    await safeClick(jobSummary.rowDrillInLink(row), {
      timeout: 10_000,
      label: "ucpath job summary row drill-in link",
    });
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

// ─── Frozen-column grid reading (Workforce Job Summary) ──────────────────────

/**
 * Raw dump of a PeopleSoft FROZEN-COLUMN grid. PeopleSoft renders such a grid as
 * TWO row-aligned data tables: `tdgbl<GRID>` (LEFT, the frozen columns —
 * Organizational Relationship · Empl Record · Effective Date · Seq) and
 * `tdgbr<GRID>` (RIGHT, the active tab's columns: Job Information → Job Code ·
 * Description · … · Expected Job End Date; Work Location → Position Number ·
 * Description · Company · Dept ID · Department Description · …). One `<tr>` per
 * job row in EACH table, same count, same order. Live-verified 2026-08-20 on
 * `WF_JOB_SUMM` (`tdgblWF_JOB_SUMM$0` / `tdgbrWF_JOB_SUMM$0`, 16–17 rows).
 */
export interface FrozenGridDump {
  left: Array<{ id: string; rows: string[][] }>;
  right: Array<{ id: string; rows: string[][] }>;
}

/** One paired frozen-grid row: the LEFT table's Effective Date + the RIGHT table's cells. */
export interface FrozenGridRow {
  effectiveDate: string;
  cells: string[];
}

const MMDDYYYY_CELL = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

/**
 * Dump the frozen-grid data tables of the current Workforce Job Summary tab.
 * Reads the PeopleSoft content document (the `#main_target_win0` iframe when
 * present, else the page itself — the direct `psc` URL has no iframe). Returns
 * empty arrays while the grid has not rendered yet (callers poll).
 */
async function readFrozenGridDump(page: Page): Promise<FrozenGridDump> {
  return page.evaluate(() => {
    // NOTE: no NAMED const helpers in here (tsx keepNames → `__name` is
    // undefined in the page context); anonymous callbacks only.
    const frame = document.querySelector<HTMLIFrameElement>("#main_target_win0");
    const doc = (frame && frame.contentDocument) || document;
    const tables = Array.from(doc.querySelectorAll("table"));
    return {
      left: tables
        .filter((t) => /^tdgbl/.test(t.id))
        .map((t) => ({
          id: t.id,
          rows: Array.from(t.rows).map((tr) =>
            Array.from(tr.cells).map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim()),
          ),
        })),
      right: tables
        .filter((t) => /^tdgbr/.test(t.id))
        .map((t) => ({
          id: t.id,
          rows: Array.from(t.rows).map((tr) =>
            Array.from(tr.cells).map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim()),
          ),
        })),
    };
  });
}

/**
 * Pair the LEFT (frozen) and RIGHT data tables of a Workforce Job Summary grid
 * row-by-row and read each row's Effective Date from the LEFT table. Pure +
 * unit-pinned against dumps captured from the live grid (2026-08-20).
 *
 * Why this exists: the right-table row carries its own date column(s) —
 * "Expected Job End Date" on Job Information — and a "first date-looking cell
 * in the row" read mistook that for the Effective Date (separations docs
 * 4540/4541, 2026-08-20: every STDT 3 row read as eff 06/30/2026 — its END
 * date — so the picker fell back to an older STDT 2 row and Kuali got the wrong
 * Payroll Title Code/Title). The ONLY source of truth for a row's Effective Date
 * is the frozen left table, zipped by index.
 *
 * Fail-loud contract (a wrong row must never reach the HDH gate or Kuali):
 *   - no left table, or a left table with no rows → `[]` (grid not rendered
 *     yet — callers poll; an empty final scan is judged by the caller).
 *   - more than one populated left table → THROW (ambiguous grid).
 *   - no right table with the matching `<GRID>` id suffix → `[]` (half-rendered
 *     grid — keep polling; a persistent miss surfaces as the caller's empty-scan
 *     failure).
 *   - left/right row counts differ → THROW (misaligned zip would pair a date
 *     with the wrong job row).
 *   - the left table has no single all-dates column → THROW (Effective Date
 *     column not where the frozen layout puts it — re-map, don't guess).
 */
export function pairFrozenGridRows(dump: FrozenGridDump): FrozenGridRow[] {
  const lefts = dump.left.filter((t) => t.rows.length > 0);
  if (lefts.length === 0) return [];
  if (lefts.length > 1) {
    throw new Error(
      `pairFrozenGridRows: expected ONE frozen-left grid table, found ${lefts.length} ` +
        `(${lefts.map((t) => t.id).join(", ")}) — ambiguous Workforce Job Summary grid; re-map before trusting any row.`,
    );
  }
  const left = lefts[0];
  const suffix = left.id.replace(/^tdgbl/, "");
  const right = dump.right.find((t) => t.id.replace(/^tdgbr/, "") === suffix);
  if (!right || right.rows.length === 0) return [];
  if (right.rows.length !== left.rows.length) {
    throw new Error(
      `pairFrozenGridRows: frozen-left table '${left.id}' has ${left.rows.length} row(s) but right table ` +
        `'${right.id}' has ${right.rows.length} — cannot zip Effective Dates onto job rows; refusing to guess.`,
    );
  }
  const width = Math.max(...left.rows.map((r) => r.length));
  const dateCols: number[] = [];
  for (let c = 0; c < width; c++) {
    if (left.rows.every((r) => MMDDYYYY_CELL.test(r[c] ?? ""))) dateCols.push(c);
  }
  if (dateCols.length !== 1) {
    throw new Error(
      `pairFrozenGridRows: expected exactly ONE all-dates (Effective Date) column in frozen-left table ` +
        `'${left.id}', found ${dateCols.length} (first row: ${JSON.stringify(left.rows[0])}) — ` +
        `the frozen column layout moved; re-map before trusting any row.`,
    );
  }
  const dateCol = dateCols[0];
  return left.rows.map((l, i) => ({ effectiveDate: l[dateCol], cells: right.rows[i] }));
}

/**
 * Project paired frozen-grid rows of the WORK LOCATION tab onto
 * `WorkLocationRow`s. Each right row is anchored by its Position Number cell
 * (7–8 digits); Dept ID = +3, Department Description = +4 (proven offsets).
 * Throws when a row has no Position Number anchor — layout drift, not a row
 * to guess at.
 */
export function workLocationRowsFromGrid(rows: FrozenGridRow[]): WorkLocationRow[] {
  const POS = /^\d{7,8}$/;
  return rows.map((row, i) => {
    const p = row.cells.findIndex((c) => POS.test(c));
    if (p < 0 || row.cells.length < p + 5) {
      throw new Error(
        `workLocationRowsFromGrid: Work Location row ${i + 1} has no Position Number anchor ` +
          `(cells: ${JSON.stringify(row.cells)}) — grid layout drift; re-map before trusting any row.`,
      );
    }
    return {
      effectiveDate: row.effectiveDate,
      deptId: row.cells[p + 3] ?? "",
      departmentDescription: row.cells[p + 4] ?? "",
      positionNumber: row.cells[p],
    };
  });
}

/**
 * Project paired frozen-grid rows of the JOB INFORMATION tab onto
 * `JobInfoRow`s: Job Code = cells[0] (6 digits), Description = cells[1].
 * Throws when cells[0] is not a job code — layout drift, not a row to guess at.
 */
export function jobInfoRowsFromGrid(rows: FrozenGridRow[]): JobInfoRow[] {
  const JOBCODE = /^\d{6}$/;
  return rows.map((row, i) => {
    if (!JOBCODE.test(row.cells[0] ?? "")) {
      throw new Error(
        `jobInfoRowsFromGrid: Job Information row ${i + 1} does not start with a 6-digit Job Code ` +
          `(cells: ${JSON.stringify(row.cells)}) — grid layout drift; re-map before trusting any row.`,
      );
    }
    return {
      effectiveDate: row.effectiveDate,
      jobCode: row.cells[0],
      jobDescription: row.cells[1] ?? "",
    };
  });
}

/**
 * Generic poll for a lazily rendered grid scan: re-run `scan` until `ready`
 * accepts the result or the attempt budget is spent (returns the last scan).
 * `pollForJobInfoScan` is the Job Information specialisation.
 */
export async function pollForGridScan<T>(
  scan: () => Promise<T>,
  ready: (scan: T) => boolean,
  opts: { attempts: number; intervalMs: number; sleep: (ms: number) => Promise<void> },
): Promise<T> {
  let last = await scan();
  for (let attempt = 1; attempt < opts.attempts && !ready(last); attempt++) {
    await opts.sleep(opts.intervalMs);
    last = await scan();
  }
  return last;
}

/** One effective-dated row of the Workforce Job Summary Work Location grid. */
export interface WorkLocationRow {
  /** Effective Date as MM/DD/YYYY (from the frozen LEFT grid table). */
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
 *   - No row carries a usable date  → THROWS. A total date-parse miss (every
 *     row's Effective Date failed both the in-row read and the frozen-column
 *     zip) means there is no basis to pick ANY row — silently returning
 *     `rows[0]` would ship an arbitrary row's department/job-code to the
 *     HDH gate / Kuali. Fail loud so the grid/selector gets fixed instead.
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

  if (dated.length === 0) {
    throw new Error(
      `pickEffectiveDatedRow: none of the ${rows.length} row(s) had a parseable Effective Date `
      + `(expected MM/DD/YYYY) — cannot determine which row is in effect. Row effectiveDate values: `
      + `${rows.map((r) => JSON.stringify(r.effectiveDate)).join(", ")}. `
      + `The Work Location/Job Information grid or its frozen-column date zip likely needs re-mapping.`,
    );
  }

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
 * dates. If NEITHER yields a date for ANY row, `pickWorkLocationRow` (via
 * `pickEffectiveDatedRow`) throws rather than guessing a row — a blank/wrong
 * department must not silently reach the HDH gate or Kuali.
 *
 * NEEDS LIVE VERIFY: confirm the Effective Date is read (logs show a non-empty
 * date per row). If every row logs effectiveDate="" on a live multi-state
 * employee, the dates live in a frozen column that neither the in-row read nor
 * the count-exact zip recovered — map that column explicitly then.
 */
export async function extractWorkLocation(
  page: Page,
  opts: { separationDate?: string } = {},
): Promise<{ deptId: string; departmentDescription: string; positionNumber?: string }> {
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
  // first), so we can pick the one in effect as of the separation date. The
  // grid is a PeopleSoft FROZEN-COLUMN grid: the Effective Date lives in the
  // LEFT table (`tdgbl…`), the Position/Dept cells in the row-aligned RIGHT
  // table (`tdgbr…`) — see `pairFrozenGridRows`. Each right row is anchored by
  // its Position Number cell; Dept ID = +3, Dept Description = +4 (proven
  // offsets, live-verified 2026-08-20). The tab's grid renders lazily, so the
  // scan is polled (same budget as the Job Information scan).
  log.step("[Job Summary] Extracting department (all Work Location rows)...");

  const rows: WorkLocationRow[] = await pollForGridScan(
    async () => workLocationRowsFromGrid(pairFrozenGridRows(await readFrozenGridDump(page))),
    (scan) => scan.length > 0,
    {
      attempts: JOB_INFO_POLL_ATTEMPTS,
      intervalMs: JOB_INFO_POLL_INTERVAL_MS,
      sleep: (ms) => sleep(ms),
    },
  );

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
  return { deptId: picked.deptId, departmentDescription: picked.departmentDescription, positionNumber: picked.positionNumber };
}

/** The Job Information data the separation needs (Job Code + its Description). */
export interface JobInfoScan {
  jobCode: string;
  jobDescription: string;
}

/** One effective-dated row of the Job Information grid. */
export interface JobInfoRow extends JobInfoScan {
  /** Effective Date as MM/DD/YYYY (from the frozen LEFT grid table). */
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
  return pollForGridScan(scan, (rows) => rows.some((r) => r.jobCode), opts);
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
 * table, so a count-exact zip recovers the per-row dates. If NEITHER yields a
 * date for ANY row, `pickEffectiveDatedRow` throws rather than guessing a
 * job-coded row — a wrong Payroll Title Code/Title must not silently reach
 * Kuali.
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
  // the picker can choose the one in effect as of the separation date. Same
  // frozen-grid pairing as Work Location: Effective Date from the LEFT table,
  // Job Code(0) + Description(1) from the row-aligned RIGHT table. NEVER read a
  // date out of the right-table row — its only in-row date is "Expected Job
  // End Date", which is what the pre-2026-08-20 scan mistook for the Effective
  // Date (separations docs 4540/4541 → STDT 2 filled where STDT 3 was in effect).
  const rows = await pollForJobInfoScan(
    async () => jobInfoRowsFromGrid(pairFrozenGridRows(await readFrozenGridDump(page))),
    {
      attempts: JOB_INFO_POLL_ATTEMPTS,
      intervalMs: JOB_INFO_POLL_INTERVAL_MS,
      sleep: (ms) => sleep(ms),
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
  opts: { separationDate?: string; jobCode?: string; resolveJob?: boolean } = {},
): Promise<JobSummaryIdentity> {
  await navigateToWorkforceJobSummary(page);
  const found = await searchJobSummary(page, emplId, opts.jobCode);
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

  // A found, active employee always has a Dept ID + Department Description on
  // the Work Location tab. Blank ones after extraction are a GENUINE
  // extraction failure on a found record (no Work Location rows rendered, or
  // none matched the separation date) — not a valid state, since a blank
  // department would silently ship to the HDH/non-HDH kronos-skip gate and the
  // Kuali department fill. Fail loud rather than returning incomplete data,
  // same contract as the jobCode check below.
  if (!workLocation.deptId || !workLocation.departmentDescription) {
    throw new Error(
      `Workforce Job Summary found EID '${emplId}' but could not extract a Department ID / Description `
      + `from the Work Location tab (deptId='${workLocation.deptId || "<empty>"}', departmentDescription='${workLocation.departmentDescription || "<empty>"}'). `
      + `The Work Location grid likely did not render in time, or no row matched the separation date. `
      + `Re-run; if it recurs, re-verify the Work Location tab selector / grid layout on the live page.`,
    );
  }

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

  let emplRecord: string | undefined;
  if (opts.resolveJob) {
    const dump = await readFrozenGridDump(page);
    const grids = dump.left.filter((grid) => grid.rows.length > 0);
    if (grids.length !== 1) throw new Error(`Cannot identify the employment-record grid for ${emplId}`);
    const records = new Set(grids[0].rows.map((row) => row[1]));
    if (records.size !== 1 || !/^\d+$/.test([...records][0])) throw new Error(`Cannot identify one employment record for ${emplId}`);
    emplRecord = [...records][0];
    if (!workLocation.positionNumber) throw new Error(`No position number for ${emplId}, record ${emplRecord}`);
    if (opts.jobCode && jobInfo.jobCode !== opts.jobCode) throw new Error(`Kuali job ${opts.jobCode} does not match UCPath job ${jobInfo.jobCode}`);
  }
  return {
    found: true,
    name,
    data: {
      ...(opts.resolveJob ? { emplRecord, positionNumber: workLocation.positionNumber } : {}),
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
