import type { Page } from "playwright";
import { log } from "../utils/log.js";
import { debugScreenshot } from "../utils/screenshot.js";

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
  await page.getByRole("button", { name: "Employee Search" }).first().click({ timeout: 10_000 });
  await page.waitForTimeout(2_000);

  // The search sidebar opens inside an iframe named "portal-frame-*"
  // Find the iframe dynamically since the number suffix varies
  const searchFrame = page.frameLocator('iframe[name^="portal-frame-"]');

  // Fill the search input
  log.step(`[New Kronos] Filling search: ${employeeId}`);
  const searchInput = searchFrame.getByRole("textbox", { name: "Search by Employee Name or ID" });
  await searchInput.fill(employeeId, { timeout: 5_000 });
  await page.waitForTimeout(500);

  // Click the Search button (inside the iframe)
  log.step("[New Kronos] Clicking Search...");
  await searchFrame.getByRole("button", { name: "Search", exact: true }).click({ timeout: 5_000 });
  await page.waitForTimeout(3_000);

  // Check for "There are no items to display" — means not found
  const noResults = searchFrame.getByText("There are no items to display.");
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
  const searchFrame = page.frameLocator('iframe[name^="portal-frame-"]');

  // Click the checkbox on the first result row
  const checkbox = searchFrame.locator('input[type="checkbox"]').first();
  if ((await checkbox.count()) > 0) {
    await checkbox.check({ timeout: 5_000 });
    await page.waitForTimeout(1_000);
    log.step("[New Kronos] Employee checkbox checked");
    return true;
  }

  // Fallback: click the employee name/row directly
  const resultRow = searchFrame.locator('[role="row"]').first();
  if ((await resultRow.count()) > 0) {
    await resultRow.click({ timeout: 5_000 });
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

  const searchFrame = page.frameLocator('iframe[name^="portal-frame-"]');

  // Try Go To button in the search frame first
  const gotoInFrame = searchFrame.getByRole("button", { name: /go to/i })
    .or(searchFrame.locator("text=Go To"));
  const gotoOnPage = page.getByRole("button", { name: /go to/i })
    .or(page.locator("button:has-text('Go To')"));

  let clicked = false;
  if ((await gotoInFrame.count()) > 0) {
    await gotoInFrame.first().click({ timeout: 5_000 });
    clicked = true;
  } else if ((await gotoOnPage.count()) > 0) {
    await gotoOnPage.first().click({ timeout: 5_000 });
    clicked = true;
  }

  if (!clicked) {
    log.error("[New Kronos] Go To button not found");
    return false;
  }

  await page.waitForTimeout(2_000);

  // Click Timecard/Timecards in the dropdown menu
  const timecardItem = searchFrame.getByRole("menuitem", { name: /timecard/i })
    .or(searchFrame.locator("text=Timecards").first())
    .or(searchFrame.locator("text=Timecard").first())
    .or(page.getByRole("menuitem", { name: /timecard/i }))
    .or(page.locator("text=Timecards").first())
    .or(page.locator("text=Timecard").first());

  if ((await timecardItem.count()) > 0) {
    await timecardItem.first().click({ timeout: 5_000 });
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

  // Mapped via playwright-cli: click "Current Pay Period" button to open dropdown,
  // then click option "Previous Pay Period"
  const periodBtn = page.getByRole("button", { name: "Current Pay Period" }).first();
  if ((await periodBtn.count()) > 0) {
    await periodBtn.click({ timeout: 5_000 });
    await page.waitForTimeout(2_000);

    const prevOption = page.getByRole("option", { name: "Previous Pay Period" });
    if ((await prevOption.count()) > 0) {
      await prevOption.click({ timeout: 5_000 });
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
    const year = new Date().getFullYear();

    // Get date rows from pinned container
    const pinned = document.querySelector(".ui-grid-pinned-container");
    if (!pinned) return null;

    const dateRows: string[] = [];
    pinned.querySelectorAll("[role='row']").forEach((r) => {
      const t = r.textContent?.trim().replace(/[^\w\s/]/g, "").trim() ?? "";
      if (/^[A-Z][a-z]{2}\s+\d+\/\d+$/.test(t)) dateRows.push(t);
    });

    // Get data rows from viewport (last viewport has the scrollable data)
    const viewports = document.querySelectorAll(".ui-grid-viewport");
    const dataVp = viewports[viewports.length - 1];
    if (!dataVp) return null;

    const dataRows = dataVp.querySelectorAll("[role='row']");

    // Find last date with In/Out punches (AM/PM timestamps)
    let lastDate: string | null = null;
    for (let i = 0; i < dateRows.length && i < dataRows.length; i++) {
      const cells = dataRows[i].querySelectorAll("[role='gridcell']");
      const hasInOut = Array.from(cells).some((c) =>
        /\d+:\d+\s*(AM|PM)/.test(c.textContent?.trim() ?? ""),
      );
      if (hasInOut) {
        const match = dateRows[i].match(/(\d+)\/(\d+)/);
        if (match) {
          const mm = match[1].padStart(2, "0");
          const dd = match[2].padStart(2, "0");
          lastDate = `${mm}/${dd}/${year}`;
        }
      }
    }

    return lastDate;
  });

  if (result) {
    log.step(`[New Kronos] Latest timecard date with In/Out: ${result}`);
  } else {
    log.step("[New Kronos] No In/Out entries found in current pay period");
  }

  return result;
}

/**
 * Full timecard check: select employee, Go To → Timecard, check current then previous period.
 * Returns the latest date with time entries, or null if nothing found.
 */
export async function checkTimecardDates(page: Page): Promise<string | null> {
  await selectEmployeeResult(page);

  const ok = await clickGoToTimecard(page);
  if (!ok) return null;

  await page.waitForTimeout(3_000);
  await debugScreenshot(page, "new-kronos-timecard-01-current");

  // Check current pay period
  let lastDate = await getTimecardLastDate(page);
  if (lastDate) {
    log.step("[New Kronos] Found entries in current period — no need to check previous");
    return lastDate;
  }

  // No entries in current — try previous pay period
  const switched = await switchToPreviousPayPeriod(page);
  if (switched) {
    await page.waitForTimeout(3_000);
    await debugScreenshot(page, "new-kronos-timecard-02-previous");
    lastDate = await getTimecardLastDate(page);
  }

  return lastDate;
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
  const periodBtn = page.getByRole("button", { name: /Pay Period|Schedule Period|^\d+\/\d+\/\d+/ }).first();
  await periodBtn.click({ timeout: 10_000 });
  await page.waitForTimeout(2_000);

  // Step 2: Click "Select range" to switch to custom date range mode
  await page.getByRole("button", { name: "Select range" }).click({ timeout: 5_000 });
  await page.waitForTimeout(1_000);

  // Step 3: Fill start date
  const startInput = page.getByRole("textbox", { name: "Start date" });
  await startInput.fill(startDate, { timeout: 5_000 });
  await page.waitForTimeout(500);

  // Step 4: Fill end date
  const endInput = page.getByRole("textbox", { name: "End date" });
  await endInput.fill(endDate, { timeout: 5_000 });
  await page.waitForTimeout(500);

  // Step 5: Click Apply
  await page.getByRole("button", { name: "Apply" }).click({ timeout: 5_000 });
  await page.waitForTimeout(5_000);
  log.step("[New Kronos] Date range applied");
}

/**
 * Close the Employee Search sidebar if it's open.
 */
export async function closeEmployeeSearch(page: Page): Promise<void> {
  try {
    const searchFrame = page.frameLocator('iframe[name^="portal-frame-"]');
    const closeBtn = searchFrame.getByRole("button", { name: "Employee Search Close" });
    if ((await closeBtn.count()) > 0) {
      await closeBtn.click({ timeout: 3_000 });
      log.step("[New Kronos] Search sidebar closed");
    }
  } catch {
    // Sidebar may not be open
  }
}
