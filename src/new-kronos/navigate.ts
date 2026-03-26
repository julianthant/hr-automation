import type { Page } from "playwright";
import { log } from "../utils/log.js";

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

  // Click the Employee Search button in the navbar
  log.step("[New Kronos] Opening Employee Search sidebar...");
  await page.getByRole("button", { name: "Employee Search" }).click({ timeout: 10_000 });
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
