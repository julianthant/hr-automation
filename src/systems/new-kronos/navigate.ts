import type { Page, Locator } from "playwright";
import { log } from "../../utils/log.js";
import { debugScreenshot } from "../../utils/screenshot.js";
import {
  searchFrame,
  loadingOverlay,
  navbar,
  search as searchSelectors,
  goToMenu,
  timecard,
  type SearchRoot,
} from "./selectors.js";
import { clickIfPresent, safeClick, safeFill } from "../common/index.js";
import {
  formatTimecardDate,
  runTimecardCheck,
  type TimecardDriver,
} from "../../services/timecard/index.js";

export const NEW_KRONOS_URL = "https://ucsd-sso.prd.mykronos.com/wfd/home";

/**
 * The WFD Employee Search sidebar renders its input/results either INSIDE the
 * portal-frame iframe (fresh page load) or TOP-LEVEL on the page (e.g. when
 * reached after a timecard navigation). Probe the iframe first; fall back to
 * the top-level page so search works in BOTH contexts. (2026-06-18: the
 * iframe-only assumption caused `locator.fill: Timeout` on the top-level
 * variant — EID 10602099.)
 */
async function resolveSearchRoot(page: Page): Promise<SearchRoot> {
  const frame = searchFrame(page);
  try {
    await searchSelectors.searchInput(frame).waitFor({ state: "visible", timeout: 4_000 });
    return frame;
  } catch {
    // Not in the iframe — fall back to the top-level page. Best-effort wait so
    // the caller's safeFill gets a present element (or surfaces a clear error).
    try {
      await searchSelectors.searchInput(page).waitFor({ state: "visible", timeout: 4_000 });
    } catch {
      /* Neither context shows it yet — return the page; safeFill will report. */
    }
    return page;
  }
}

/**
 * Search for an employee by ID in the new Kronos (WFD) system.
 * Clicks the "Employee Search" button in the navbar, fills the search input,
 * and checks if results are found.
 *
 * The search sidebar is inside an iframe named "portal-frame-*".
 *
 * @param page - Playwright page (already authenticated to new Kronos)
 * @param employeeId - Employee ID to search for
 * @returns true if employee was found, false if "There are no items to display"
 */
export async function searchEmployee(
  page: Page,
  employeeId: string,
): Promise<boolean> {
  log.step(`[New Kronos] Searching for employee ${employeeId}...`);

  // Close any existing search sidebar first (prevents "2 elements" error between docs)
  await closeEmployeeSearch(page);
  await page.waitForTimeout(1_000);

  // Wait for the WFD loading overlay to clear before clicking Employee Search.
  // When the overlay is present it intercepts pointer events and the click fails
  // with "Another element intercepted the click (modal/overlay)" (2026-06-17).
  // The selector is best-effort and NEEDS LIVE RE-VERIFY — if none of the CSS
  // classes match the live Dayforce build the waitFor resolves immediately via
  // the hidden/detached check in the catch, which is safe.
  try {
    await loadingOverlay.overlay(page).waitFor({ state: "hidden", timeout: 5_000 });
  } catch {
    // Overlay absent or selector doesn't match — proceed without waiting.
  }

  // Click the Employee Search button in the navbar
  log.step("[New Kronos] Opening Employee Search sidebar...");
  await safeClick(navbar.employeeSearchButton(page), {
    timeout: 10_000,
    label: "new kronos employee search button",
  });
  await page.waitForTimeout(2_000);

  // Resolve whether the search sidebar rendered inside the portal-frame iframe
  // or top-level on the page, then target that context for fill/submit/results.
  const root = await resolveSearchRoot(page);

  // Fill the search input
  log.step(`[New Kronos] Filling search: ${employeeId}`);
  await safeFill(searchSelectors.searchInput(root), employeeId, {
    timeout: 5_000,
    label: "new kronos employee search input",
  });
  await page.waitForTimeout(500);

  // Click the Search button
  log.step("[New Kronos] Clicking Search...");
  await safeClick(searchSelectors.searchSubmitButton(root), {
    timeout: 5_000,
    label: "new kronos search submit button",
  });

  const checkbox = searchSelectors.firstResultCheckbox(root);
  const noResults = searchSelectors.noResultsText(root);
  const searchResultTimeout = 15_000;

  let found: boolean;
  try {
    found = await Promise.race([
      checkbox.first().waitFor({ state: "visible", timeout: searchResultTimeout }).then(() => true),
      noResults.waitFor({ state: "visible", timeout: searchResultTimeout }).then(() => false),
    ]);
  } catch {
    throw new Error(
      `[New Kronos] Timed out waiting for search results for ${employeeId}`,
    );
  }

  if (found) {
    log.success(`[New Kronos] Employee ${employeeId} found`);
  } else {
    log.step(`[New Kronos] Employee ${employeeId} NOT found`);
  }

  return found;
}

/**
 * Click the checkbox on the first employee search result to select them.
 */
export async function selectEmployeeResult(page: Page): Promise<boolean> {
  log.step("[New Kronos] Selecting employee from search results...");

  // The results render in the portal-frame iframe OR top-level. After a search
  // the search INPUT collapses to "Show Search", so `resolveSearchRoot` (which
  // probes the input) can mis-detect the context here — try the result CHECKBOX
  // directly in BOTH contexts. Checking the "Select Item" checkbox is what
  // registers the slat selection that ENABLES the Go To button. (2026-06-18: the
  // daemon resolved to the wrong context and left Selected[0] / Go To disabled.)
  const contexts: SearchRoot[] = [searchFrame(page), page];
  for (const root of contexts) {
    const checkbox = searchSelectors.firstResultCheckbox(root);
    try {
      if ((await checkbox.count()) > 0) {
        await checkbox.check({ timeout: 5_000 });
        await page.waitForTimeout(1_000);
        log.step("[New Kronos] Employee checkbox checked");
        return true;
      }
    } catch {
      log.warn("[New Kronos] Result checkbox present but not checkable in this context — trying the next");
    }
  }

  // Fallback: click the result row (the `menuitemradio`) directly, in either context.
  for (const root of contexts) {
    const resultRow = searchSelectors.firstResultRow(root);
    if (await clickIfPresent(resultRow, { timeout: 3_000, label: "new kronos search result row" })) {
      await page.waitForTimeout(1_000);
      log.step("[New Kronos] Employee row clicked");
      return true;
    }
  }

  log.error("[New Kronos] Could not select employee from results");
  return false;
}

/**
 * Click Go To dropdown and select Timecard.
 * Go To may be on the main page or inside the search iframe.
 */
export async function clickGoToTimecard(page: Page): Promise<boolean> {
  log.step("[New Kronos] Clicking Go To → Timecard...");

  const frame = searchFrame(page);
  // Go To may render in the search frame OR top-level. The button is
  // `ng-disabled` until an employee is selected, so clicking it while disabled
  // just times out — poll for whichever context's button is visible AND ENABLED
  // (up to 15s for the Angular selection from selectEmployeeResult to land).
  const candidates = [
    goToMenu.goToButtonInFrame(frame).first(),
    goToMenu.goToButtonOnPage(page).first(),
  ];
  let gotoButton: Locator | null = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !gotoButton) {
    for (const loc of candidates) {
      try {
        if ((await loc.isVisible()) && (await loc.isEnabled())) {
          gotoButton = loc;
          break;
        }
      } catch {
        // Not present in this context — try the next candidate.
      }
    }
    if (!gotoButton) await page.waitForTimeout(500);
  }

  if (!gotoButton) {
    log.error(
      "[New Kronos] Go To button never became enabled — the employee selection " +
      "did not register (no slat selected), so the timecard cannot be opened",
    );
    return false;
  }

  await gotoButton.click({ timeout: 5_000 });
  await page.waitForTimeout(2_000);

  // Click Timecard/Timecards in the dropdown menu (6-deep fallback)
  const timecardItem = goToMenu.timecardItem(page);

  if (await clickIfPresent(timecardItem, { timeout: 5_000, label: "new kronos timecard menu item" })) {
    // Wait for the Timecard view to render (reduced from 5s).
    await page.waitForTimeout(2_500);
    log.success("[New Kronos] Navigated to Timecard");
    return true;
  }

  log.error("[New Kronos] Timecard option not found in Go To menu");
  return false;
}

/**
 * Switch the pay period dropdown to previous pay period.
 */
export async function switchToPreviousPayPeriod(page: Page): Promise<boolean> {
  log.step("[New Kronos] Switching to previous pay period...");

  // Use payPeriodTriggerButton (regex-based) so it matches regardless of whether
  // the button shows "Current Pay Period" or a date range after setDateRange runs.
  const periodBtn = timecard.payPeriodTriggerButton(page);
  if (await clickIfPresent(periodBtn, { timeout: 5_000, label: "new kronos pay period trigger button" })) {
    await page.waitForTimeout(2_000);

    const prevOption = timecard.previousPayPeriodOption(page);
    if (await clickIfPresent(prevOption, { timeout: 5_000, label: "new kronos previous pay period option" })) {
      await page.waitForTimeout(5_000);
      log.step("[New Kronos] Switched to Previous Pay Period");
      return true;
    }
  }

  log.error("[New Kronos] Could not find pay period controls");
  return false;
}

/**
 * Check if the current timecard view has any time entries.
 * Returns the latest date with time, or null if no time found.
 */
export async function getTimecardLastDate(page: Page): Promise<string | null> {
  log.step("[New Kronos] Checking timecard for time entries...");

  // New Kronos (WFD) uses a split grid:
  // - ui-grid-pinned-container has date rows ("Mon 3/16")
  // - ui-grid-viewport (last one) has data rows (In/Out/Daily values)
  // Rows are aligned by index. Check if data row has AM/PM timestamps (In/Out punches).
  const result = await page.evaluate(() => {
    const viewports = document.querySelectorAll(".ui-grid-viewport");
    if (viewports.length < 2) return null;

    // First viewport is the left pinned column (dates)
    // Last viewport is the right scrollable data column (punches)
    const dateVp = viewports[0];
    const dataVp = viewports[viewports.length - 1];

    const dateRows: string[] = [];
    let lastSeenDate = "";
    dateVp.querySelectorAll("[role='row']").forEach((r) => {
      const t = r.textContent?.trim().replace(/[^\w\s/]/g, "").trim() ?? "";
      if (/^[A-Z][a-z]{2}\s+\d+\/\d+$/.test(t)) {
        lastSeenDate = t;
      }
      dateRows.push(lastSeenDate);
    });

    const dataRows = dataVp.querySelectorAll("[role='row']");

    // Find last date with In/Out punches (AM/PM timestamps)
    let lastParsed: { month: number; day: number } | null = null;
    for (let i = 0; i < dateRows.length && i < dataRows.length; i++) {
      const cells = dataRows[i].querySelectorAll("[role='gridcell']");
      const hasInOut = Array.from(cells).some((c) =>
        /\d+:\d+\s*(AM|PM)/.test(c.textContent?.trim() ?? ""),
      );
      if (hasInOut) {
        const match = dateRows[i].match(/(\d+)\/(\d+)/);
        if (match) {
          lastParsed = { month: parseInt(match[1], 10), day: parseInt(match[2], 10) };
        }
      }
    }

    return lastParsed;
  });

  if (result) {
    const formatted = formatTimecardDate(result.month, result.day);
    log.step(`[New Kronos] Latest timecard date with In/Out: ${formatted}`);
    return formatted;
  } else {
    log.step("[New Kronos] No In/Out entries found in current pay period");
  }

  return null;
}

/**
 * Scroll the New Kronos timecard grid so the row for `targetDate`
 * (MM/DD/YYYY) is CENTERED in the view. Used to position the browser
 * before an audit screenshot so the human can verify:
 *   (a) the workflow picked the correct last day (centered = easy to read), and
 *   (b) whether any later dates exist below it (visible above and below center).
 *
 * `block: "center"` keeps surrounding rows in frame on both sides; when the
 * target is near the top/bottom of the loaded rows the browser's native scroll
 * clamps at the edge, which is fine — the operator still sees the target row
 * plus its neighbors.
 *
 * Best-effort: a missing row logs + returns without throwing. Callers
 * wrap screenshots around this; a scroll failure must not mask the
 * real error the screenshot is being taken to capture.
 */
export async function scrollTimecardToDate(page: Page, targetDate: string): Promise<void> {
  const match = targetDate.match(/^(\d{2})\/(\d{2})\/\d{4}$/);
  if (!match) return;
  // Kronos date cells render as "Mon 3/23" — month + day without
  // leading zeros. Convert "03/23/2026" → "3/23" for a substring match
  // against the row text.
  const md = `${parseInt(match[1], 10)}/${parseInt(match[2], 10)}`;

  const scrolled = await page.evaluate((wantMd: string) => {
    const viewports = document.querySelectorAll(".ui-grid-viewport");
    if (viewports.length === 0) return false;
    // Column 0 is the pinned date column; both viewports scroll in
    // lockstep because ui-grid syncs them on scroll events.
    const dateVp = viewports[0];
    const rows = dateVp.querySelectorAll("[role='row']");
    for (const row of Array.from(rows)) {
      const text = (row.textContent ?? "").replace(/\s+/g, " ").trim();
      // Match the "/" form ("Mon 3/23" contains "3/23") to avoid
      // false-positive matches like "3/23" inside a different cell.
      if (text.includes(` ${wantMd}`) || text.endsWith(wantMd)) {
        (row as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
        return true;
      }
    }
    return false;
  }, md).catch(() => false);

  if (scrolled) {
    log.step(`[New Kronos] Scrolled timecard to ${targetDate} centered in view`);
  } else {
    log.warn(`[New Kronos] Could not locate ${targetDate} row in timecard — screenshot scroll unchanged`);
  }
  // Let the grid repaint before the caller captures a screenshot.
  await page.waitForTimeout(500);
}

/**
 * Full timecard check: select employee, Go To → Timecard, check current then previous period.
 * Returns the latest date with time entries, or null if nothing found.
 */
export async function checkTimecardDates(page: Page): Promise<string | null> {
  await selectEmployeeResult(page);

  const driver: TimecardDriver = {
    goToTimecard: (p) => clickGoToTimecard(p),
    afterGoTo: async (p) => {
      await debugScreenshot(p, "new-kronos-timecard-01-current");
    },
    switchPeriod: (p) => switchToPreviousPayPeriod(p),
    afterSwitch: async (p) => {
      await debugScreenshot(p, "new-kronos-timecard-02-previous");
    },
    readLastDate: (p) => getTimecardLastDate(p),
  };
  return runTimecardCheck(page, driver);
}

/**
 * Timecard data extracted for use during separations: the last punch date,
 * any days with a Sick pay code, and any days with a Holiday pay code.
 */
export interface SeparationTimecardData {
  /** MM/DD/YYYY — latest day with an In/Out punch (the "Last Day Worked"), or null if none found. */
  lastPunchDate: string | null;
  /** MM/DD/YYYY[], chronological — days with a Sick pay code (e.g. "Sick - Hourly"). */
  sickDates: string[];
  /** MM/DD/YYYY[], chronological — days with a Holiday pay code (e.g. "Holiday - Hourly"). */
  holidayDates: string[];
}

/**
 * Parse the New Kronos (WFD) timecard grid to extract:
 * - last day with an In/Out punch
 * - all days with a Sick pay code (matches /sick/i, e.g. "Sick - Hourly")
 * - all days with a Holiday pay code (matches /holiday/i, e.g. "Holiday - Hourly")
 *
 * Grid structure: `document.querySelectorAll(".ui-grid-viewport")` →
 *   [0] = pinned date column (rows like "Thu 4/23")
 *   [last] = data column; per-row cell indices:
 *     [0]=Schedule [1]=In [2]=Out [3]=Transfer [4]=Pay code [5]=Amount
 *     [6]=Shift [7]=Daily [8]=Period [9]=Absence
 *
 * Verified live 2026-06-18 against EIDs 10776990 (holiday) and 10776013 (sick).
 * Multiple data rows can share one date; the date column shows the date once,
 * so the last-seen date is carried forward across rows.
 *
 * NOTE: keep `getTimecardLastDate` as-is — it is still used by `checkTimecardDates`.
 */
export async function getSeparationTimecardData(
  page: Page,
): Promise<SeparationTimecardData> {
  log.step("[New Kronos] Parsing timecard for separation data (last punch, sick, holiday)...");

  const raw = await page.evaluate(() => {
    const vps = document.querySelectorAll(".ui-grid-viewport");
    if (vps.length < 2) return { lastPunch: null, sick: [] as { mon: number; day: number }[], holiday: [] as { mon: number; day: number }[] };
    const dateVp = vps[0];
    const dataVp = vps[vps.length - 1];
    const dRows = [...dateVp.querySelectorAll("[role=row]")];
    const xRows = [...dataVp.querySelectorAll("[role=row]")];
    let cur: { mon: number; day: number } | null = null;
    let lastPunch: { mon: number; day: number } | null = null;
    const sick: { mon: number; day: number }[] = [];
    const holiday: { mon: number; day: number }[] = [];
    for (let i = 0; i < Math.max(dRows.length, xRows.length); i++) {
      const dt = dRows[i] ? dRows[i].textContent!.replace(/\s+/g, " ").trim() : "";
      const m = dt.match(/([A-Za-z]{3})\s+(\d+)\/(\d+)/);
      if (m) cur = { mon: +m[2], day: +m[3] };
      const cells = xRows[i]
        ? [...xRows[i].querySelectorAll("[role=gridcell]")].map((c) =>
            c.textContent!.replace(/\s+/g, " ").trim(),
          )
        : [];
      const inOut = (cells[1] ?? "") + " " + (cells[2] ?? "");
      if (cur && /\d+:\d+\s*(AM|PM)/.test(inOut)) lastPunch = cur;
      const pay = cells[4] ?? "";
      if (cur && /sick/i.test(pay)) sick.push(cur);
      if (cur && /holiday/i.test(pay)) holiday.push(cur);
    }
    return { lastPunch, sick, holiday };
  });

  const lastPunchDate = raw.lastPunch
    ? formatTimecardDate(raw.lastPunch.mon, raw.lastPunch.day)
    : null;
  const sickDates = raw.sick.map((d) => formatTimecardDate(d.mon, d.day));
  const holidayDates = raw.holiday.map((d) => formatTimecardDate(d.mon, d.day));

  log.step(
    `[New Kronos] Timecard parse: lastPunch=${lastPunchDate ?? "none"}, sick=${sickDates.length}, holiday=${holidayDates.length}`,
  );

  return { lastPunchDate, sickDates, holidayDates };
}

/**
 * Set a custom date range on the New Kronos timecard view.
 * Must be called after navigating to the Timecards page.
 *
 * Mapped via playwright-cli 2026-04-06, keystroke fix verified 2026-06-18:
 *   1. Click "Current Pay Period" button → opens timeframe dropdown
 *   2. Click "Select range" button → opens date range inputs
 *   3. Type "Start date" and "End date" via real keystrokes (MM/DD/YYYY)
 *      NOTE: these <input type=text> controls silently reject Playwright
 *      fill() — the value reverts to today. Use click → CtrlOrMeta+a →
 *      pressSequentially to drive real per-char keystrokes. (OBS-006)
 *   4. Click "Apply" button
 *
 * After applying, the button text changes from "Current Pay Period"
 * to the date range string (e.g., "3/01/2026 - 4/15/2026").
 */
export async function setDateRange(
  page: Page,
  startDate: string,
  endDate: string,
): Promise<void> {
  log.step(`[New Kronos] Setting date range: ${startDate} – ${endDate}`);

  // Step 1: Click the timeframe button to open the dropdown
  // The button text varies: "Current Pay Period", "Previous Pay Period", or a date range string
  await safeClick(timecard.payPeriodTriggerButton(page), {
    timeout: 10_000,
    label: "new kronos pay period trigger button",
  });
  await page.waitForTimeout(2_000);

  // Step 2: Click "Select range" to switch to custom date range mode
  await safeClick(timecard.selectRangeButton(page), {
    timeout: 5_000,
    label: "new kronos select range button",
  });
  await page.waitForTimeout(1_000);

  // Step 3: Type start date via real keystrokes.
  // fill() silently reverts these inputs to today's date (OBS-006, verified 2026-06-18).
  // Real per-char keystrokes (pressSequentially) correctly set the value.
  const startLoc = timecard.startDateInput(page);
  await startLoc.click({ timeout: 5_000 });
  await startLoc.press("ControlOrMeta+a");
  await startLoc.pressSequentially(startDate, { delay: 20 });
  await page.waitForTimeout(300);

  // Step 4: Type end date via real keystrokes (same reason as start date).
  const endLoc = timecard.endDateInput(page);
  await endLoc.click({ timeout: 5_000 });
  await endLoc.press("ControlOrMeta+a");
  await endLoc.pressSequentially(endDate, { delay: 20 });
  await page.waitForTimeout(300);

  // Step 5: Click Apply
  await safeClick(timecard.applyButton(page), {
    timeout: 5_000,
    label: "new kronos date range apply button",
  });
  // Wait for WFD to reload the timecard grid with the new range (reduced from 5s).
  await page.waitForTimeout(2_500);
  log.step("[New Kronos] Date range applied");
}

/**
 * Close the Employee Search sidebar if it's open.
 */
export async function closeEmployeeSearch(page: Page): Promise<void> {
  // The sidebar may be in the portal-frame iframe OR top-level — try both
  // close buttons (best-effort; the sidebar may simply not be open).
  for (const root of [searchFrame(page), page] as SearchRoot[]) {
    try {
      const closeBtn = searchSelectors.closeButton(root);
      if (await clickIfPresent(closeBtn, { timeout: 2_000, label: "new kronos search sidebar close button" })) {
        log.step("[New Kronos] Search sidebar closed");
        return;
      }
    } catch {
      // Not in this context — try the next.
    }
  }
}
