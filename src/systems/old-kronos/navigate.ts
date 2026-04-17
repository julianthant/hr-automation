import type { Page, Frame } from "playwright";
import { log } from "../../utils/log.js";
import { UKGError } from "./types.js";
import { debugScreenshot } from "../../utils/screenshot.js";
import { loginToUKG } from "../../auth/login.js";
import {
  ssoProbe,
  employeeGrid,
  modalDismiss,
  dateRange,
  goToMenu,
  timecard,
  workspace,
} from "./selectors.js";

/**
 * Dismiss any OK/Close modal dialog in the iframe.
 * UKG often pops up modals that block interaction.
 */
export async function dismissModal(page: Page, iframe: Frame): Promise<void> {
  await page.waitForTimeout(1_000);

  // Try OK button
  const okBtn = modalDismiss.okButton(iframe);
  if (await okBtn.count() > 0) {
    try {
      await okBtn.first().click({ timeout: 3_000 });
      log.step("Dismissed modal (OK)");
      await page.waitForTimeout(2_000);
    } catch {
      // Modal may have closed on its own
    }
  }

  // Try Close button
  const closeBtn = modalDismiss.closeButton(iframe);
  if (await closeBtn.count() > 0) {
    try {
      await closeBtn.first().click({ timeout: 3_000 });
      log.step("Dismissed modal (Close)");
      await page.waitForTimeout(2_000);
    } catch {
      // Modal may have closed on its own
    }
  }
}

/**
 * Locate the Genies iframe (main employee grid) in UKG.
 * The frame is named `widgetFrame804` but falls back to any `widgetFrame*`.
 */
export async function getGeniesIframe(page: Page): Promise<Frame> {
  for (let attempt = 0; attempt < 15; attempt++) {
    // Check if page redirected to SSO login (session expired after refresh)
    const ssoField = await ssoProbe.ssoField(page).count().catch(() => 0);
    if (ssoField > 0) {
      log.step("SSO login page detected — re-authenticating to UKG...");
      const reAuthOk = await loginToUKG(page);
      if (!reAuthOk) throw new UKGError("Re-authentication to UKG failed", "getGeniesIframe");
      log.success("UKG re-authenticated after session expiry");
      await page.waitForTimeout(5_000);
      continue;
    }

    // Try exact name first
    const iframe = page.frame({ name: "widgetFrame804" });
    if (iframe) {
      // Check for "network change detected" error inside iframe — reload if found
      const hasNetworkError = await employeeGrid.networkChangeError(iframe).count().catch(() => 0);
      if (hasNetworkError > 0) {
        log.step("Network change detected in iframe — reloading page...");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(10_000);
        continue;
      }
      return iframe;
    }

    // Fallback: any genies frame
    for (const f of page.frames()) {
      if (f.url().toLowerCase().includes("genies")) return f;
    }

    // Fallback: any widgetFrame
    for (const f of page.frames()) {
      if (f.name().startsWith("widgetFrame")) {
        // Also check this frame for network error
        const hasNetworkError = await employeeGrid.networkChangeError(f).count().catch(() => 0);
        if (hasNetworkError > 0) {
          log.step("Network change detected in widget frame — reloading page...");
          await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
          await page.waitForTimeout(10_000);
          break; // restart the loop
        }
        log.step(`Found widget frame: ${f.name()} -> ${f.url().slice(0, 80)}`);
        return f;
      }
    }

    if (attempt === 0) {
      log.step("Waiting for Genies iframe to load...");
    }
    await page.waitForTimeout(2_000);
  }

  // Last resort: reload and retry
  log.step("Reloading page and retrying (final attempt)...");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(15_000);

  const iframe = page.frame({ name: "widgetFrame804" });
  if (iframe) return iframe;

  for (const f of page.frames()) {
    if (f.name().startsWith("widgetFrame")) return f;
  }

  throw new UKGError("Cannot find Genies iframe after reload", "getGeniesIframe");
}

/**
 * Set the date range on the UKG dashboard.
 * Opens the calendar dialog and fills start/end dates.
 */
export async function setDateRange(
  page: Page,
  iframe: Frame,
  startDate: string,
  endDate: string,
): Promise<void> {
  log.step("Setting date range...");

  // Click calendar icon (2-way .or() fallback)
  const calBtn = dateRange.calendarButton(iframe);
  await calBtn.first().click();
  await page.waitForTimeout(3_000);
  await debugScreenshot(page, "ukg-date-01-popup");

  // Date inputs in the timeframeSelection dialog
  const dateInputs = dateRange.dateInputs(iframe);
  const count = await dateInputs.count();
  log.step(`Found ${count} date inputs in dialog`);

  if (count < 2) {
    log.error("Could not find date input fields");
    await debugScreenshot(page, "ukg-date-ERROR");
    return;
  }

  // Fill start and end dates by typing digits (MMDDYYYY format, zero-padded)
  const toDigits = (dateStr: string): string => {
    const [m, d, y] = dateStr.split("/");
    return m.padStart(2, "0") + d.padStart(2, "0") + y;
  };
  const dates = [
    { index: 0, digits: toDigits(startDate) },
    { index: 1, digits: toDigits(endDate) },
  ];

  for (const { index, digits } of dates) {
    const inp = dateInputs.nth(index);
    await inp.click({ clickCount: 3, force: true });
    await page.waitForTimeout(500);
    await inp.press("Delete");
    await page.waitForTimeout(500);
    await inp.press("Home");
    await page.waitForTimeout(500);
    for (const char of digits) {
      await inp.press(char);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(500);
  }

  const startVal = await dateInputs.nth(0).inputValue();
  const endVal = await dateInputs.nth(1).inputValue();
  log.step(`Start: ${startVal}, End: ${endVal}`);

  // Click Apply (2-way .or() fallback)
  await dateRange.applyButton(iframe).first().click();
  await page.waitForTimeout(5_000);
  log.step("Date range applied");
  await dismissModal(page, iframe);
}

/**
 * Search for an employee by ID using QuickFind.
 */
export async function searchEmployee(
  page: Page,
  iframe: Frame,
  employeeId: string,
): Promise<void> {
  log.step(`Searching for employee ${employeeId}...`);
  await dismissModal(page, iframe);

  const searchInput = employeeGrid.quickFindInput(iframe);
  await searchInput.click();
  await searchInput.fill(employeeId);
  await page.waitForTimeout(1_000);
  await employeeGrid.quickFindSubmitButton(iframe).click();
  await page.waitForTimeout(5_000);
  await dismissModal(page, iframe);
}

/**
 * Extract the employee name from the first grid row after search.
 */
export async function getEmployeeName(
  iframe: Frame,
  employeeId: string,
): Promise<string | null> {
  const firstRow = employeeGrid.firstRow(iframe);
  if (await firstRow.count() > 0) {
    const rowText = (await firstRow.innerText()).trim();
    log.step(`Row text: ${rowText}`);
    const parts = rowText
      .replace(/\t/g, "\n")
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);
    for (const part of parts) {
      if (part !== employeeId && /[a-zA-Z]/.test(part)) {
        return part;
      }
    }
  }
  return null;
}

/**
 * Click the employee row in the jqx grid to select it.
 * Returns the employee name, or false if row not found.
 */
export async function clickEmployeeRow(
  page: Page,
  iframe: Frame,
  employeeId: string,
): Promise<string | null | false> {
  log.step("Clicking on employee row...");

  // Strategy 1: #row0genieGrid
  const firstRow = employeeGrid.firstRow(iframe);
  if (await firstRow.count() > 0) {
    const empName = await getEmployeeName(iframe, employeeId);
    await firstRow.click();
    await page.waitForTimeout(2_000);
    log.step(`Row selected. Employee name: ${empName}`);
    return empName;
  }

  // Strategy 2: Search by role=row containing employee ID
  const gridRows = employeeGrid.allRowsByRole(iframe);
  const rowCount = await gridRows.count();
  for (let i = 0; i < rowCount; i++) {
    const text = (await gridRows.nth(i).innerText()).trim();
    if (text.includes(employeeId)) {
      await gridRows.nth(i).click();
      await page.waitForTimeout(2_000);
      return text.includes("\t") ? text.split("\t")[0].trim() : null;
    }
  }

  // Strategy 3: gridcell containing employee ID
  const cell = employeeGrid.cellByEmployeeId(iframe, employeeId);
  if (await cell.count() > 0) {
    await cell.click();
    await page.waitForTimeout(2_000);
    return null;
  }

  log.error(`Could not find row for ${employeeId}`);
  return false;
}

/**
 * Click Go To dropdown and select Reports.
 */
export async function clickGoToReports(
  page: Page,
  iframe: Frame,
): Promise<boolean> {
  log.step("Clicking Go To...");

  // Strategy 1: Direct text match
  const gotoEl = goToMenu.goToTrigger(iframe);
  if (await gotoEl.count() > 0) {
    await gotoEl.click();
    await page.waitForTimeout(3_000);
    const reportsItem = goToMenu.reportsItem(iframe);
    if (await reportsItem.count() > 0) {
      await reportsItem.click();
      await page.waitForTimeout(5_000);
      log.step("Navigated to Reports");
      return true;
    }
  }

  // Strategy 2: Dropdown toggle
  const dropdowns = goToMenu.dropdownToggles(iframe);
  const dropdownCount = await dropdowns.count();
  for (let i = 0; i < dropdownCount; i++) {
    try {
      const parentText: string = await dropdowns.nth(i).evaluate(
        (el) => (el as HTMLElement).parentElement?.innerText?.trim() ?? "",
      );
      if (parentText.toLowerCase().includes("go to")) {
        await dropdowns.nth(i).click();
        await page.waitForTimeout(3_000);
        await goToMenu.reportsItem(iframe).click();
        await page.waitForTimeout(5_000);
        return true;
      }
    } catch {
      // Continue to next dropdown
    }
  }

  // Strategy 3: Sidebar Reports link
  const sidebarReports = goToMenu.sidebarReports(page);
  if (await sidebarReports.count() > 0) {
    await sidebarReports.first().click();
    await page.waitForTimeout(5_000);
    return true;
  }

  log.error("Could not find Go To -> Reports");
  return false;
}

/**
 * Click Go To dropdown and select Timecard.
 */
export async function clickGoToTimecard(
  page: Page,
  iframe: Frame,
): Promise<boolean> {
  log.step("[Old Kronos] Clicking Go To → Timecards...");

  const gotoEl = goToMenu.goToTrigger(iframe);
  if (await gotoEl.count() > 0) {
    await gotoEl.click();
    await page.waitForTimeout(3_000);

    // Menu item is "Timecards" (plural) — must use exact match to avoid "Approve Timecards"
    const timecardItem = goToMenu.timecardsItem(iframe);
    if (await timecardItem.count() > 0) {
      await timecardItem.click();
      await page.waitForTimeout(5_000);
      log.success("[Old Kronos] Navigated to Timecards");
      return true;
    }
  }

  log.error("[Old Kronos] Could not find Go To → Timecards");
  return false;
}

/**
 * Switch the pay period dropdown to previous pay period.
 * Returns true if switched, false if already on the last option or dropdown not found.
 */
export async function switchToPreviousPayPeriod(
  page: Page,
  iframe: Frame,
): Promise<boolean> {
  log.step("[Old Kronos] Switching to previous pay period...");

  // Mapped via playwright-cli 2026-04-01:
  // The timecard frame (widgetFrame808 or similar) has a readonly input
  // id="timeframe-selector-input" that opens a dropdown when clicked.
  // Playwright's actionability checks block normal clicks on readonly inputs,
  // so we use JS click directly. Then click the "Previous Pay Period" link.
  for (const f of page.frames()) {
    // Use JS to find and click the timeframe selector — bypasses readonly checks
    const clicked = await f.evaluate(() => {
      const input = document.getElementById("timeframe-selector-input");
      if (!input) return false;
      (input as HTMLElement).click();
      return true;
    }).catch(() => false);

    if (!clicked) continue;

    log.step(`[Old Kronos] Opened period dropdown in frame: ${f.name()}`);
    await page.waitForTimeout(2_000);

    const prevLink = timecard.previousPayPeriodLink(f);
    if (await prevLink.count() > 0) {
      await prevLink.click({ timeout: 5_000 });
      await page.waitForTimeout(5_000);
      log.step("[Old Kronos] Switched to Previous Pay Period");
      return true;
    }
  }

  log.error("[Old Kronos] Could not find period dropdown");
  return false;
}

/**
 * Check if the current timecard view has any time entries (non-zero hours).
 * Returns the latest date with time, or null if no time found.
 * Date format: MM/DD/YYYY
 */
export async function getTimecardLastDate(
  page: Page,
  iframe: Frame,
): Promise<string | null> {
  log.step("[Old Kronos] Checking timecard for time entries...");

  // Old Kronos timecard: each row has 12+ gridcells in one row
  // cells[2]=Date ("Mon 3/16"), cells[4]=In, cells[5]=Out
  // Find the last date that has a non-empty In or Out value
  for (const f of page.frames()) {
    const result = await f.evaluate(() => {
      let lastDate: string | null = null;
      const year = new Date().getFullYear();
      const rows = document.querySelectorAll("[role='row']");

      for (const row of rows) {
        const cells = row.querySelectorAll("[role='gridcell']");
        if (cells.length < 10) continue;

        const dateText = (cells[2]?.textContent ?? "").trim();
        if (!/^[A-Z][a-z]{2}\s+\d+\/\d+$/.test(dateText)) continue;

        const inVal = (cells[4]?.textContent ?? "").trim();
        const outVal = (cells[5]?.textContent ?? "").trim();

        if (inVal || outVal) {
          // Extract M/D and format as MM/DD/YYYY
          const match = dateText.match(/(\d+)\/(\d+)/);
          if (match) {
            const mm = match[1].padStart(2, "0");
            const dd = match[2].padStart(2, "0");
            lastDate = `${mm}/${dd}/${year}`;
          }
        }
      }

      return lastDate;
    }).catch(() => null);

    if (result) {
      log.step(`[Old Kronos] Latest timecard date with In/Out: ${result} (frame: ${f.name()})`);
      return result;
    }
  }

  log.step("[Old Kronos] No In/Out entries found in current pay period");
  return null;
}

/**
 * Full timecard check: Go To → Timecard, check current period, if empty check previous.
 * Returns the latest date with time entries, or null if nothing found.
 */
export async function checkTimecardDates(
  page: Page,
  iframe: Frame,
): Promise<string | null> {
  const ok = await clickGoToTimecard(page, iframe);
  if (!ok) return null;

  await page.waitForTimeout(3_000);
  await dismissModal(page, iframe);
  await debugScreenshot(page, "ukg-timecard-01-current");

  // Check current pay period
  let lastDate = await getTimecardLastDate(page, iframe);
  if (lastDate) {
    log.step("[Old Kronos] Found entries in current period — no need to check previous");
    return lastDate;
  }

  // No entries in current — try previous pay period
  const switched = await switchToPreviousPayPeriod(page, iframe);
  if (switched) {
    await dismissModal(page, iframe);
    await debugScreenshot(page, "ukg-timecard-02-previous");
    lastDate = await getTimecardLastDate(page, iframe);
  }

  return lastDate;
}

/**
 * Navigate back to the Manage My Department dashboard.
 */
export async function goBackToMain(page: Page): Promise<void> {
  log.step("Going back to Manage My Department...");

  // Try tab first
  const tab = workspace.manageDeptTab(page);
  if (await tab.count() > 0) {
    await tab.first().click();
    await page.waitForTimeout(3_000);
    return;
  }

  // Fallback: li tab
  const liTab = workspace.manageDeptLi(page);
  if (await liTab.count() > 0) {
    await liTab.first().click();
    await page.waitForTimeout(3_000);
    return;
  }

  // Last resort: navigate directly
  const { UKG_URL } = await import("../../config.js");
  await page.goto(UKG_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(5_000);
}
