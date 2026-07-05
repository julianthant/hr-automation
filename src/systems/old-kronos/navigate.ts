import type { Page, Frame } from "playwright";
import { log } from "../../utils/log.js";
import { UKGError } from "./types.js";
import { debugScreenshot } from "../../utils/screenshot.js";
import { loginToUKG } from "../../infra/auth/login.js";
import { UKG_URL } from "../../config.js";
import {
  ssoProbe,
  employeeGrid,
  modalDismiss,
  dateRange,
  goToMenu,
  timecard,
  workspace,
} from "./selectors.js";
import { clickIfPresent, safeClick, safeFill } from "../common/index.js";
import {
  formatTimecardDate,
  runTimecardCheck,
  type TimecardDriver,
} from "../../services/timecard/index.js";

/**
 * Dismiss any OK/Close modal dialog in the iframe.
 * UKG often pops up modals that block interaction.
 */
export async function dismissModal(page: Page, iframe: Frame): Promise<void> {
  // Short wait for any pending modal to appear before probing.
  // Reduced from 1s — clickIfPresent already polls for up to 3s.
  await page.waitForTimeout(300);

  // Try OK button (1.5s timeout — modals appear quickly; 3s was overkill for the
  // common absent-modal case that runs 5+ times per doc, 2026-06-17)
  const okBtn = modalDismiss.okButton(iframe);
  if (await clickIfPresent(okBtn, { timeout: 1_500, label: "old kronos modal ok button" })) {
    log.step("Dismissed modal (OK)");
    // Short settle — modal dismissal is near-instant on click.
    await page.waitForTimeout(500);
  }

  // Try Close button
  const closeBtn = modalDismiss.closeButton(iframe);
  if (await clickIfPresent(closeBtn, { timeout: 1_500, label: "old kronos modal close button" })) {
    log.step("Dismissed modal (Close)");
    await page.waitForTimeout(500);
  }
}

/**
 * Locate the Genies iframe (main employee grid) in UKG.
 * The frame is named `widgetFrame804` but falls back to any `widgetFrame*`.
 */
async function reloadOnNetworkError(page: Page, frame: Frame, label: string): Promise<boolean> {
  const hasNetworkError = await employeeGrid.networkChangeError(frame).count().catch(() => 0);
  if (hasNetworkError === 0) return false;
  log.step(`Network change detected in ${label} — reloading page...`);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  // Let UKG finish re-initializing its SPA. The outer getGeniesIframe retry loop
  // provides additional tolerance if the frame isn't ready yet after this wait.
  await page.waitForTimeout(5_000);
  return true;
}

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
      if (await reloadOnNetworkError(page, iframe, "iframe")) continue;
      return iframe;
    }

    // Fallback: any genies frame
    for (const f of page.frames()) {
      if (f.url().toLowerCase().includes("genies")) return f;
    }

    // Fallback: any widgetFrame
    for (const f of page.frames()) {
      if (f.name().startsWith("widgetFrame")) {
        if (await reloadOnNetworkError(page, f, "widget frame")) break;
        log.step(`Found widget frame: ${f.name()} -> ${f.url().slice(0, 80)}`);
        return f;
      }
    }

    if (attempt === 0) {
      log.step("Waiting for Genies iframe to load...");
    }
    // Reduced from 2s — 15 attempts × 1s = 15s max before the last-resort reload.
    await page.waitForTimeout(1_000);
  }

  // Last resort: reload and retry
  log.step("Reloading page and retrying (final attempt)...");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  // Keep 15s — UKG's SPA fully re-initializes on reload; too short risks missing the frame.
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
  await safeClick(calBtn.first(), { label: "old kronos date range calendar button" });
  // Wait for the date-picker dialog to render (reduced from 3s).
  await page.waitForTimeout(1_500);
  await debugScreenshot(page, "ukg-date-01-popup");

  // Date inputs in the timeframeSelection dialog
  const dateInputs = dateRange.dateInputs(iframe);
  const count = await dateInputs.count();
  log.step(`Found ${count} date inputs in dialog`);

  if (count < 2) {
    await debugScreenshot(page, "ukg-date-ERROR");
    throw new UKGError(
      `Could not find date input fields in the date-range dialog (expected 2, found ${count}) — date range ${startDate} to ${endDate} was NOT set`,
      "setDateRange",
    );
  }

  // Fill start and end dates by typing digits (MMDDYYYY format, zero-padded)
  const toDigits = (dateStr: string): string => {
    const parts = dateStr.split("/");
    if (parts.length !== 3) {
      throw new Error(
        `toDigits: expected MM/DD/YYYY, got ${JSON.stringify(dateStr)}`,
      );
    }
    const [m, d, y] = parts;
    if (!m || !d || !y) {
      throw new Error(
        `toDigits: expected non-empty MM/DD/YYYY parts, got ${JSON.stringify(dateStr)}`,
      );
    }
    return m.padStart(2, "0") + d.padStart(2, "0") + y;
  };
  const dates = [
    { index: 0, digits: toDigits(startDate) },
    { index: 1, digits: toDigits(endDate) },
  ];

  for (const { index, digits } of dates) {
    const inp = dateInputs.nth(index);
    await inp.click({ clickCount: 3, force: true });
    await page.waitForTimeout(200);
    await inp.press("Delete");
    await page.waitForTimeout(200);
    await inp.press("Home");
    await page.waitForTimeout(200);
    // Per LESSONS.md 2026-03-16: JQX date widget requires digit-by-digit typing
    // (fill() is rejected). Keep per-char dispatch; 80ms is the minimum that
    // reliably commits mid-type without the widget dropping digits.
    for (const char of digits) {
      await inp.press(char);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(200);
  }

  const startVal = await dateInputs.nth(0).inputValue();
  const endVal = await dateInputs.nth(1).inputValue();
  log.step(`Start: ${startVal}, End: ${endVal}`);

  // Readback check: compare digits actually in the fields (ignoring the
  // widget's own display formatting, e.g. inserted "/") against what we typed.
  const expectedStartDigits = toDigits(startDate);
  const expectedEndDigits = toDigits(endDate);
  const startValDigits = startVal.replace(/\D/g, "");
  const endValDigits = endVal.replace(/\D/g, "");
  if (startValDigits !== expectedStartDigits || endValDigits !== expectedEndDigits) {
    throw new UKGError(
      `Date range readback mismatch: expected start=${startDate} end=${endDate}, but dialog shows start="${startVal}" end="${endVal}"`,
      "setDateRange",
    );
  }

  // Click Apply (2-way .or() fallback)
  await safeClick(dateRange.applyButton(iframe).first(), {
    label: "old kronos date range apply button",
  });
  // Wait for UKG to apply the filter and re-render the grid (reduced from 5s).
  await page.waitForTimeout(2_500);
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
  await safeClick(searchInput, { label: "old kronos quick find input" });
  await safeFill(searchInput, employeeId, { label: "old kronos quick find input" });
  // Brief pause to let the input value commit before submitting.
  await page.waitForTimeout(300);
  await safeClick(employeeGrid.quickFindSubmitButton(iframe), {
    label: "old kronos quick find submit button",
  });
  // Wait for jqxGrid search results to render. No stable readiness selector
  // exists for this custom JQX widget — conservative fixed wait retained.
  await page.waitForTimeout(3_000);
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
  const empName = await getEmployeeName(iframe, employeeId);
  if (await clickIfPresent(firstRow, { label: "old kronos first employee row" })) {
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
      await safeClick(gridRows.nth(i), { label: "old kronos employee grid row" });
      await page.waitForTimeout(2_000);
      return text.includes("\t") ? text.split("\t")[0].trim() : null;
    }
  }

  // Strategy 3: gridcell containing employee ID
  const cell = employeeGrid.cellByEmployeeId(iframe, employeeId);
  if (await clickIfPresent(cell, { label: "old kronos employee id cell" })) {
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
  if (await clickIfPresent(gotoEl, { label: "old kronos go to trigger" })) {
    // Wait for the dropdown menu to render (reduced from 3s — menu appears quickly).
    await page.waitForTimeout(1_500);
    const reportsItem = goToMenu.reportsItem(iframe);
    if (await clickIfPresent(reportsItem, { label: "old kronos reports menu item" })) {
      // Wait for the Reports page to load (reduced from 5s — frame navigation is fast).
      await page.waitForTimeout(2_000);
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
        await safeClick(dropdowns.nth(i), { label: "old kronos go to dropdown toggle" });
        await page.waitForTimeout(1_500);
        await safeClick(goToMenu.reportsItem(iframe), {
          label: "old kronos reports menu item fallback",
        });
        await page.waitForTimeout(2_000);
        return true;
      }
    } catch {
      // Continue to next dropdown
    }
  }

  // Strategy 3: Sidebar Reports link
  const sidebarReports = goToMenu.sidebarReports(page);
  if (await clickIfPresent(sidebarReports, { label: "old kronos sidebar reports link" })) {
    await page.waitForTimeout(2_000);
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
  if (await clickIfPresent(gotoEl, { label: "old kronos go to timecard trigger" })) {
    // Wait for dropdown to render (reduced from 3s).
    await page.waitForTimeout(1_500);

    // Menu item is "Timecards" (plural) — must use exact match to avoid "Approve Timecards"
    const timecardItem = goToMenu.timecardsItem(iframe);
    if (await clickIfPresent(timecardItem, { label: "old kronos timecards menu item" })) {
      await page.waitForTimeout(2_000);
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
      (input).click();
      return true;
    }).catch(() => false);

    if (!clicked) continue;

    log.step(`[Old Kronos] Opened period dropdown in frame: ${f.name()}`);
    await page.waitForTimeout(2_000);

    const prevLink = timecard.previousPayPeriodLink(f);
    if (await clickIfPresent(prevLink, { timeout: 5_000, label: "old kronos previous pay period link" })) {
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
): Promise<string | null> {
  log.step("[Old Kronos] Checking timecard for time entries...");

  // Old Kronos timecard: each row has 12+ gridcells in one row
  // cells[2]=Date ("Mon 3/16"), cells[4]=In, cells[5]=Out
  // Find the last date that has a non-empty In or Out value
  for (const f of page.frames()) {
    const result = await f
      .evaluate(() => {
        let lastParsed: { month: number; day: number } | null = null;
        const rows = document.querySelectorAll("[role='row']");

        for (const row of rows) {
          const cells = row.querySelectorAll("[role='gridcell']");
          if (cells.length < 10) continue;

          const dateText = (cells[2]?.textContent ?? "").trim();
          if (!/^[A-Z][a-z]{2}\s+\d+\/\d+$/.test(dateText)) continue;

          const inVal = (cells[4]?.textContent ?? "").trim();
          const outVal = (cells[5]?.textContent ?? "").trim();

          if (inVal || outVal) {
            const match = dateText.match(/(\d+)\/(\d+)/);
            if (match) {
              lastParsed = {
                month: parseInt(match[1], 10),
                day: parseInt(match[2], 10),
              };
            }
          }
        }

        return lastParsed;
      })
      .catch(() => null);

    if (result) {
      const formatted = formatTimecardDate(result.month, result.day);
      log.step(
        `[Old Kronos] Latest timecard date with In/Out: ${formatted} (frame: ${f.name()})`,
      );
      return formatted;
    }
  }

  log.step("[Old Kronos] No In/Out entries found in current pay period");
  return null;
}

/**
 * Scroll the Old Kronos timecard grid so the row for `targetDate`
 * (MM/DD/YYYY) is CENTERED in the view, before an audit screenshot — the
 * analog of New Kronos's `scrollTimecardToDate`. The timecard grid lives in
 * a nested iframe (not the top page), so this walks `page.frames()` and runs
 * the row search in each frame (same frame-hunt pattern as
 * `getTimecardLastDate`).
 *
 * Old Kronos rows render `cells[2]` as the date, formatted "Mon 3/16" — month +
 * day without leading zeros. We convert "03/16/2026" → "3/16" and match that
 * within the row's date cell text, then `scrollIntoView({ block: "center" })`
 * so the captured viewport shows the chosen day with its neighbours on both
 * sides (so the operator can spot a later date that should have won).
 *
 * Best-effort: a missing row logs + returns without throwing; a scroll failure
 * must never mask the real error the screenshot is being taken to capture.
 */
export async function scrollTimecardToDate(page: Page, targetDate: string): Promise<void> {
  const match = targetDate.match(/^(\d{2})\/(\d{2})\/\d{4}$/);
  if (!match) return;
  const md = `${parseInt(match[1], 10)}/${parseInt(match[2], 10)}`;

  let scrolled = false;
  for (const f of page.frames()) {
    // NEEDS LIVE RE-VERIFY 2026-06-17 — row/date-cell selector for the
    // Old Kronos timecard grid (rows: [role='row'] with ≥10 [role='gridcell'],
    // date in cells[2] as "Mon 3/16"). Mirrors getTimecardLastDate's parsing;
    // confirm against the live frame when the live phase runs.
    const ok = await f
      .evaluate((wantMd: string) => {
        const rows = document.querySelectorAll("[role='row']");
        for (const row of rows) {
          const cells = row.querySelectorAll("[role='gridcell']");
          if (cells.length < 10) continue;
          const dateText = (cells[2]?.textContent ?? "").trim();
          if (!/^[A-Z][a-z]{2}\s+\d+\/\d+$/.test(dateText)) continue;
          if (dateText.includes(` ${wantMd}`) || dateText.endsWith(wantMd)) {
            (row as HTMLElement).scrollIntoView({
              block: "center",
              behavior: "instant" as ScrollBehavior,
            });
            return true;
          }
        }
        return false;
      }, md)
      .catch(() => false);
    if (ok) {
      scrolled = true;
      log.step(`[Old Kronos] Scrolled timecard to ${targetDate} centered in view (frame: ${f.name()})`);
      break;
    }
  }

  if (!scrolled) {
    log.warn(`[Old Kronos] Could not locate ${targetDate} row in timecard — screenshot scroll unchanged`);
  }
  // Let the grid repaint before the caller captures a screenshot.
  await page.waitForTimeout(500);
}

/**
 * Full timecard check: Go To → Timecard, check current period, if empty check previous.
 * Returns the latest date with time entries, or null if nothing found.
 */
export async function checkTimecardDates(
  page: Page,
  iframe: Frame,
): Promise<string | null> {
  const driver: TimecardDriver = {
    goToTimecard: (p) => clickGoToTimecard(p, iframe),
    afterGoTo: async (p) => {
      await dismissModal(p, iframe);
      await debugScreenshot(p, "ukg-timecard-01-current");
    },
    switchPeriod: (p) => switchToPreviousPayPeriod(p),
    afterSwitch: async (p) => {
      await dismissModal(p, iframe);
      await debugScreenshot(p, "ukg-timecard-02-previous");
    },
    readLastDate: (p) => getTimecardLastDate(p),
  };
  return runTimecardCheck(page, driver);
}

/**
 * Navigate back to the Manage My Department dashboard.
 */
export async function goBackToMain(page: Page): Promise<void> {
  log.step("Going back to Manage My Department...");

  // Try tab first
  const tab = workspace.manageDeptTab(page);
  if (await clickIfPresent(tab, { label: "old kronos manage department tab" })) {
    await page.waitForTimeout(1_500);
    return;
  }

  // Fallback: li tab
  const liTab = workspace.manageDeptLi(page);
  if (await clickIfPresent(liTab, { label: "old kronos manage department li tab" })) {
    await page.waitForTimeout(1_500);
    return;
  }

  // Last resort: navigate directly
  await page.goto(UKG_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // Allow UKG SPA to re-initialize after full navigation.
  await page.waitForTimeout(3_000);
}
