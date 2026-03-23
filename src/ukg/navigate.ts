import type { Page, Frame } from "playwright";
import { mkdirSync } from "fs";
import { log } from "../utils/log.js";
import { UKGError } from "./types.js";

// Ensure screenshot directory exists
mkdirSync(".auth", { recursive: true });

/**
 * Take a debug screenshot for UKG automation.
 */
export async function ukgScreenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `.auth/ukg-${name}.png`, fullPage: false });
  log.step(`Screenshot: .auth/ukg-${name}.png`);
}

/**
 * Dismiss any OK/Close modal dialog in the iframe.
 * UKG often pops up modals that block interaction.
 */
export async function dismissModal(page: Page, iframe: Frame): Promise<void> {
  await page.waitForTimeout(1_000);

  // Try OK button
  const okBtn = iframe.locator("button:has-text('OK')");
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
  const closeBtn = iframe.locator(
    "button.close-handler, button:has-text('Close'), .jqx-window-close-button",
  );
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
    // Try exact name first
    const iframe = page.frame({ name: "widgetFrame804" });
    if (iframe) return iframe;

    // Fallback: any genies frame
    for (const f of page.frames()) {
      if (f.url().toLowerCase().includes("genies")) return f;
    }

    // Fallback: any widgetFrame
    for (const f of page.frames()) {
      if (f.name().startsWith("widgetFrame")) {
        log.step(`Found widget frame: ${f.name()} -> ${f.url().slice(0, 80)}`);
        return f;
      }
    }

    if (attempt === 0) {
      log.step("Waiting for Genies iframe to load...");
      log.step(`Current frames (${page.frames().length}):`);
      for (const f of page.frames()) {
        log.step(`  ${f.name()} -> ${f.url().slice(0, 100)}`);
      }
    }
    await page.waitForTimeout(2_000);
  }

  // Last resort: reload and retry
  log.step("Reloading page and retrying...");
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

  // Click calendar icon
  let calBtn = iframe.locator("button:has(i.icon-k-calendar)");
  if (await calBtn.count() === 0) {
    calBtn = iframe.locator("button.btn.i.dropdown-toggle[title='Select Dates']");
  }
  await calBtn.first().click();
  await page.waitForTimeout(3_000);
  await ukgScreenshot(page, "date-01-popup");

  // Date inputs in the timeframeSelection dialog
  const dateInputs = iframe.locator("div.timeframeSelection input.jqx-input-content");
  const count = await dateInputs.count();
  log.step(`Found ${count} date inputs in dialog`);

  if (count < 2) {
    log.error("Could not find date input fields");
    await ukgScreenshot(page, "date-ERROR");
    return;
  }

  // Fill start and end dates by typing digits
  const dates = [
    { index: 0, digits: startDate.replace(/\//g, "") },
    { index: 1, digits: endDate.replace(/\//g, "") },
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

  // Click Apply
  let applyBtn = iframe.locator("div.timeframeSelection button[title='Apply']");
  if (await applyBtn.count() === 0) {
    applyBtn = iframe.locator("div.timeframeSelection button:has-text('Apply')");
  }
  await applyBtn.first().click();
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

  const searchInput = iframe.locator("#searchQuery");
  await searchInput.click();
  await searchInput.fill(employeeId);
  await page.waitForTimeout(1_000);
  await iframe.locator("#quickfindsearch_btn").click();
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
  const firstRow = iframe.locator("#row0genieGrid");
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
  const firstRow = iframe.locator("#row0genieGrid");
  if (await firstRow.count() > 0) {
    const empName = await getEmployeeName(iframe, employeeId);
    await firstRow.click();
    await page.waitForTimeout(2_000);
    log.step(`Row selected. Employee name: ${empName}`);
    return empName;
  }

  // Strategy 2: Search by role=row containing employee ID
  const gridRows = iframe.locator("div[role='row']");
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
  const cell = iframe.locator(`div[role='gridcell']:has-text('${employeeId}')`).first();
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
  const gotoEl = iframe.locator("text=Go To").first();
  if (await gotoEl.count() > 0) {
    await gotoEl.click();
    await page.waitForTimeout(3_000);
    const reportsItem = iframe.locator("text=Reports").first();
    if (await reportsItem.count() > 0) {
      await reportsItem.click();
      await page.waitForTimeout(5_000);
      log.step("Navigated to Reports");
      return true;
    }
  }

  // Strategy 2: Dropdown toggle
  const dropdowns = iframe.locator(".dropdown-toggle");
  const dropdownCount = await dropdowns.count();
  for (let i = 0; i < dropdownCount; i++) {
    try {
      const parentText: string = await dropdowns.nth(i).evaluate(
        (el) => (el as HTMLElement).parentElement?.innerText?.trim() ?? "",
      );
      if (parentText.toLowerCase().includes("go to")) {
        await dropdowns.nth(i).click();
        await page.waitForTimeout(3_000);
        await iframe.locator("text=Reports").first().click();
        await page.waitForTimeout(5_000);
        return true;
      }
    } catch {
      // Continue to next dropdown
    }
  }

  // Strategy 3: Sidebar Reports link
  const sidebarReports = page.locator("div[title='Reports']");
  if (await sidebarReports.count() > 0) {
    await sidebarReports.first().click();
    await page.waitForTimeout(5_000);
    return true;
  }

  log.error("Could not find Go To -> Reports");
  return false;
}

/**
 * Navigate back to the Manage My Department dashboard.
 */
export async function goBackToMain(page: Page): Promise<void> {
  log.step("Going back to Manage My Department...");

  // Try tab first
  const tab = page.locator("span.krn-workspace-tabs__tab-title:has-text('Manage My Department')");
  if (await tab.count() > 0) {
    await tab.first().click();
    await page.waitForTimeout(3_000);
    return;
  }

  // Fallback: li tab
  const liTab = page.locator("li[title='Manage My Department']");
  if (await liTab.count() > 0) {
    await liTab.first().click();
    await page.waitForTimeout(3_000);
    return;
  }

  // Last resort: navigate directly
  const { UKG_URL } = await import("../config.js");
  await page.goto(UKG_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(5_000);
}
