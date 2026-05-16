import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { debugScreenshot } from "../../utils/screenshot.js";
import {
  searchFrame,
  navbar,
  search as searchSelectors,
  goToMenu,
  timecard,
} from "./selectors.js";
import { clickIfPresent, safeClick, safeFill } from "../common/index.js";
import {
  formatTimecardDate,
  runTimecardCheck,
  type TimecardDriver,
} from "../../services/timecard/index.js";

export const NEW_KRONOS_URL = "https://ucsd-sso.prd.mykronos.com/wfd/home";

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

  // Click the Employee Search button in the navbar
  log.step("[New Kronos] Opening Employee Search sidebar...");
  await safeClick(navbar.employeeSearchButton(page), {
    timeout: 10_000,
    label: "new kronos employee search button",
  });
  await page.waitForTimeout(2_000);

  const frame = searchFrame(page);

  // Fill the search input
  log.step(`[New Kronos] Filling search: ${employeeId}`);
  await safeFill(searchSelectors.searchInput(frame), employeeId, {
    timeout: 5_000,
    label: "new kronos employee search input",
  });
  await page.waitForTimeout(500);

  // Click the Search button (inside the iframe)
  log.step("[New Kronos] Clicking Search...");
  await safeClick(searchSelectors.searchSubmitButton(frame), {
    timeout: 5_000,
    label: "new kronos search submit button",
  });
  await page.waitForTimeout(3_000);

  // Check for "There are no items to display" — means not found
  const noResults = searchSelectors.noResultsText(frame);
  const notFound = (await noResults.count()) > 0;

  if (notFound) {
    log.step(`[New Kronos] Employee ${employeeId} NOT found`);
  } else {
    log.success(`[New Kronos] Employee ${employeeId} found`);
  }

  return !notFound;
}

/**
 * Click the checkbox on the first employee search result to select them.
 */
export async function selectEmployeeResult(page: Page): Promise<boolean> {
  log.step("[New Kronos] Selecting employee from search results...");
  const frame = searchFrame(page);

  // Click the checkbox on the first result row
  const checkbox = searchSelectors.firstResultCheckbox(frame);
  if ((await checkbox.count()) > 0) {
    await checkbox.check({ timeout: 5_000 });
    await page.waitForTimeout(1_000);
    log.step("[New Kronos] Employee checkbox checked");
    return true;
  }

  // Fallback: click the employee name/row directly
  const resultRow = searchSelectors.firstResultRow(frame);
  if (await clickIfPresent(resultRow, { timeout: 5_000, label: "new kronos search result row" })) {
    await page.waitForTimeout(1_000);
    log.step("[New Kronos] Employee row clicked");
    return true;
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

  // Try Go To button in the search frame first, fall back to top-level page
  const gotoInFrame = goToMenu.goToButtonInFrame(frame);
  const gotoOnPage = goToMenu.goToButtonOnPage(page);

  let clicked = false;
  if (await clickIfPresent(gotoInFrame, { timeout: 5_000, label: "new kronos go to button in frame" })) {
    clicked = true;
  } else if (await clickIfPresent(gotoOnPage, { timeout: 5_000, label: "new kronos go to button" })) {
    clicked = true;
  }

  if (!clicked) {
    log.error("[New Kronos] Go To button not found");
    return false;
  }

  await page.waitForTimeout(2_000);

  // Click Timecard/Timecards in the dropdown menu (6-deep fallback)
  const timecardItem = goToMenu.timecardItem(page);

  if (await clickIfPresent(timecardItem, { timeout: 5_000, label: "new kronos timecard menu item" })) {
    await page.waitForTimeout(5_000);
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
 * (MM/DD/YYYY) is the topmost visible row. Used to position the
 * browser before an audit screenshot so the human can verify:
 *   (a) the workflow picked the correct last day, and
 *   (b) whether any later dates exist below it.
 *
 * When the target date is near the end of the loaded rows and there
 * aren't enough rows below to fill the viewport, the browser's native
 * scroll clamps at the bottom — which is exactly what we want: the
 * operator sees the target row plus everything after it, and the
 * empty space below proves there's nothing later.
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
        (row as HTMLElement).scrollIntoView({ block: "start", behavior: "instant" as ScrollBehavior });
        return true;
      }
    }
    return false;
  }, md).catch(() => false);

  if (scrolled) {
    log.step(`[New Kronos] Scrolled timecard to ${targetDate} at top of view`);
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
 * Set a custom date range on the New Kronos timecard view.
 * Must be called after navigating to the Timecards page.
 *
 * Mapped via playwright-cli 2026-04-06:
 *   1. Click "Current Pay Period" button → opens timeframe dropdown
 *   2. Click "Select range" button → opens date range inputs
 *   3. Fill "Start date" and "End date" textboxes (MM/DD/YYYY)
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

  // Step 3: Fill start date
  await safeFill(timecard.startDateInput(page), startDate, {
    timeout: 5_000,
    label: "new kronos start date",
  });
  await page.waitForTimeout(500);

  // Step 4: Fill end date
  await safeFill(timecard.endDateInput(page), endDate, {
    timeout: 5_000,
    label: "new kronos end date",
  });
  await page.waitForTimeout(500);

  // Step 5: Click Apply
  await safeClick(timecard.applyButton(page), {
    timeout: 5_000,
    label: "new kronos date range apply button",
  });
  await page.waitForTimeout(5_000);
  log.step("[New Kronos] Date range applied");
}

/**
 * Close the Employee Search sidebar if it's open.
 */
export async function closeEmployeeSearch(page: Page): Promise<void> {
  try {
    const frame = searchFrame(page);
    const closeBtn = searchSelectors.closeButton(frame);
    if (await clickIfPresent(closeBtn, { timeout: 3_000, label: "new kronos search sidebar close button" })) {
      log.step("[New Kronos] Search sidebar closed");
    }
  } catch {
    // Sidebar may not be open
  }
}
