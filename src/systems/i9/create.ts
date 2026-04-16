import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import type { I9EmployeeInput, I9Result } from "./types.js";

/**
 * Create a new I-9 employee record in I9 Complete.
 *
 * Flow (mapped via playwright-cli on 2026-03-16):
 *   1. Click "Create New I-9 : New Employee" on dashboard
 *   2. Fill Employee Profile form (name, SSN, DOB, email, worksite)
 *   3. Click "Save & Continue" → OK on confirmation dialog
 *   4. Grab profile ID from URL (/employee/profile/{profileId})
 *   5. Select "Remote - Section 1 Only" radio
 *   6. Fill Start Date, verify email pre-filled
 *   7. Click "Create I-9" → OK on confirmation dialog
 *
 * @param page - Playwright page, must be authenticated and on I9 dashboard
 * @param input - Employee data from CRM extraction
 * @returns I9Result with profileId on success
 */
export async function createI9Employee(
  page: Page,
  input: I9EmployeeInput,
): Promise<I9Result> {
  try {
    // Step 1: Navigate to new employee profile
    log.step("Clicking 'Create New I-9 : New Employee'...");
    await page.getByRole("link", { name: "create new I9: new employee" }).click({ timeout: 10_000 });
    await page.waitForURL("**/employee/profile", { timeout: 10_000 });
    log.step("Employee Profile form loaded");

    // Step 2: Fill employee information
    await fillEmployeeProfile(page, input);

    // Step 3: Save profile
    log.step("Clicking Save & Continue...");
    await page.getByRole("button", { name: "Save & Continue" }).click({ timeout: 10_000 });

    // Handle validation errors
    const errorSummary = page.getByRole("heading", { name: "Error Summary:" });
    const hasError = await errorSummary.isVisible({ timeout: 2_000 }).catch(() => false);
    if (hasError) {
      const errorText = await errorSummary.locator("..").locator("div").textContent().catch(() => "Unknown validation error");
      return { success: false, profileId: null, error: `Validation error: ${errorText}` };
    }

    // Confirm save dialog
    await page.getByRole("button", { name: "OK" }).click({ timeout: 5_000 });
    await page.waitForURL("**/employee/profile/*", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
    log.step("Profile saved");

    // Step 4: Grab profile ID from URL
    const profileId = extractProfileId(page.url());
    if (!profileId) {
      return { success: false, profileId: null, error: "Could not extract profile ID from URL" };
    }
    log.step(`Profile ID: ${profileId}`);

    // Step 5: Select Remote - Section 1 Only
    log.step("Selecting 'Remote - Section 1 Only'...");
    await page.getByRole("radio", { name: "Remote - Section 1 Only" }).click({ timeout: 5_000 });

    // Step 6: Fill start date (email is pre-filled from profile)
    log.step("Filling start date...");
    await page.getByRole("textbox", { name: "Start Date*" }).fill(input.startDate, { timeout: 5_000 });

    // Step 7: Create I-9
    log.step("Clicking Create I-9...");
    await page.getByRole("button", { name: "Create I-9" }).click({ timeout: 10_000 });

    // Confirm creation dialog
    await page.getByRole("button", { name: "OK" }).click({ timeout: 10_000 });
    log.success(`I-9 created for profile ${profileId}`);

    return { success: true, profileId };
  } catch (error) {
    const msg = errorMessage(error);
    log.error(`I-9 creation failed: ${msg}`);
    return { success: false, profileId: null, error: msg };
  }
}

/**
 * Fill the Employee Profile form fields.
 */
async function fillEmployeeProfile(page: Page, input: I9EmployeeInput): Promise<void> {
  await page.getByRole("textbox", { name: "First Name (Given Name)*" }).fill(input.firstName, { timeout: 5_000 });
  log.step(`First Name: filled`);

  if (input.middleName) {
    await page.getByRole("textbox", { name: "Middle Name" }).fill(input.middleName, { timeout: 5_000 });
    log.step(`Middle Name: filled`);
  }

  await page.getByRole("textbox", { name: "Last Name (Family Name)*" }).fill(input.lastName, { timeout: 5_000 });
  log.step(`Last Name: filled`);

  // SSN: 9 digits, no dashes
  const ssnDigits = input.ssn.replace(/-/g, "");
  await page.getByRole("textbox", { name: "U.S. Social Security Number" }).fill(ssnDigits, { timeout: 5_000 });
  log.step(`SSN: filled`);

  await page.getByRole("textbox", { name: "Date of Birth" }).fill(input.dob, { timeout: 5_000 });
  log.step(`DOB: filled`);

  // Dismiss the jQuery datepicker that opens after DOB fill — it overlays the Worksite dropdown.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await page.getByRole("textbox", { name: "Employee's Email Address" }).fill(input.email, { timeout: 5_000 });
  log.step(`Email: filled`);

  // Wait for loading overlay to clear before interacting with the dropdown.
  await page.locator(".mobile-responsive-loader").waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});

  // Select worksite by department number (format: "6-{deptNum} DESCRIPTION")
  await selectWorksite(page, input.departmentNumber);
}

/**
 * Select worksite from dropdown by matching department number.
 * Worksite options are formatted as "6-{deptNum} DESCRIPTION".
 */
async function selectWorksite(page: Page, departmentNumber: string): Promise<void> {
  const worksiteDropdown = page.getByRole("listbox", { name: "Worksite *" });
  await worksiteDropdown.click({ timeout: 5_000 });

  // Find and click the option matching the department number prefix
  const optionPattern = new RegExp(`6-${departmentNumber}`);
  const option = page.getByRole("option", { name: optionPattern });

  const optionCount = await option.count();
  if (optionCount === 0) {
    // Close dropdown and throw
    await page.keyboard.press("Escape");
    throw new Error(`No worksite found matching department number: ${departmentNumber}`);
  }

  await option.first().click({ timeout: 5_000 });
  log.step(`Worksite selected: dept ${departmentNumber}`);
}

/**
 * Extract profile ID from the URL path.
 * URL format: /employee/profile/{profileId}?saveAndContinue=true
 */
function extractProfileId(url: string): string | null {
  const match = url.match(/\/employee\/profile\/(\d+)/);
  return match ? match[1] : null;
}
