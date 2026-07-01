import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import type { I9EmployeeInput, I9Result } from "./types.js";
import { profile, remoteI9, dashboard } from "./selectors.js";
import {
  clickWithKendoRecovery,
  closeAllKendoWindows,
  snapshotKendoWindows,
} from "./navigate.js";
import { I9_APP_URL } from "../../config.js";
import { safeClick, safeFill } from "../common/index.js";

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
    await closeAllKendoWindows(page);
    log.debug(`I9 create — pre-click state: ${await snapshotKendoWindows(page)}`);
    await clickWithKendoRecovery(page, dashboard.createNewI9Link(page), "create new I-9");
    await page.waitForURL("**/employee/profile", { timeout: 10_000 });
    log.step("Employee Profile form loaded");

    // Step 2: Fill employee information
    await fillEmployeeProfile(page, input);

    // Step 3: Save profile and handle post-save dialog
    log.step("Clicking Save & Continue...");
    await safeClick(profile.saveContinueButton(page), {
      timeout: 10_000,
      label: "i9 save and continue button",
    });

    await profile
      .loaderOverlay(page)
      .waitFor({ state: "hidden", timeout: 15_000 })
      .catch(() => {});
    await page.waitForTimeout(1_000);

    // Handle validation errors
    const errorSummary = profile.errorSummary(page);
    const hasError = await errorSummary.isVisible({ timeout: 3_000 }).catch(() => false);
    if (hasError) {
      const errorText = await errorSummary.locator("..").locator("div").textContent().catch(() => "Unknown validation error"); // allow-inline-selector -- DOM traversal for error readback
      return { success: false, profileId: null, error: `Validation error: ${errorText}` };
    }

    // Two possible post-save flows:
    // Path 1 (new employee): OK confirmation dialog → URL becomes /employee/profile/{id}?saveAndContinue=true
    // Path 2 (duplicate found): Duplicate Employee Record dialog → select existing row → View/Edit Selected Record
    const okBtn = profile.okButtonFirst(page);
    const duplicateDialog = profile.duplicateDialog(page);

    const isOk = await okBtn.isVisible({ timeout: 5_000 }).catch(() => false);
    const isDuplicate = await duplicateDialog.isVisible({ timeout: 2_000 }).catch(() => false);

    let profileId: string | null = null;

    if (isDuplicate) {
      log.step("Duplicate employee found — selecting existing record...");
      await safeClick(profile.duplicateFirstRow(page), {
        timeout: 5_000,
        label: "i9 duplicate first row",
      });
      await safeClick(profile.viewEditSelectedButton(page), {
        timeout: 5_000,
        label: "i9 view edit selected button",
      });
      await page.waitForURL("**/employee/profile/*", { timeout: 10_000 });
      profileId = extractProfileId(page.url());
      if (!profileId) {
        return { success: false, profileId: null, error: "Could not extract profile ID after duplicate selection" };
      }
      // Navigate with saveAndContinue param to reveal the Create I-9 radio section
      await page.goto(`${I9_APP_URL}/employee/profile/${profileId}?saveAndContinue=true`, { timeout: 10_000 });
      await page.waitForTimeout(1_000);
      log.step(`Using existing profile: ${profileId}`);
    } else if (isOk) {
      await safeClick(okBtn, { timeout: 5_000, label: "i9 profile ok button" });
      await page.waitForURL("**/employee/profile/*", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
      profileId = extractProfileId(page.url());
      if (!profileId) {
        return { success: false, profileId: null, error: "Could not extract profile ID from URL" };
      }
      log.step(`Profile saved: ${profileId}`);
    } else {
      return { success: false, profileId: null, error: "No confirmation dialog found after Save & Continue" };
    }

    // Step 5: Select Remote - Section 1 Only
    log.step("Selecting 'Remote - Section 1 Only'...");
    await safeClick(remoteI9.remoteSection1OnlyRadio(page), {
      timeout: 5_000,
      label: "i9 remote section 1 only radio",
    });

    // Step 6: Fill start date (email is pre-filled from profile)
    log.step("Filling start date...");
    await safeFill(remoteI9.startDateInput(page), input.startDate, {
      timeout: 5_000,
      label: "i9 start date",
    });

    // Step 7: Create I-9
    log.step("Clicking Create I-9...");
    await safeClick(remoteI9.createI9Button(page), {
      timeout: 10_000,
      label: "i9 create i9 button",
    });

    // Confirm creation dialog
    await safeClick(remoteI9.createI9OkButton(page), {
      timeout: 10_000,
      label: "i9 create i9 ok button",
    });
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
  await safeFill(profile.firstName(page), input.firstName, {
    timeout: 5_000,
    label: "i9 first name",
  });
  log.step(`First Name: filled`);

  if (input.middleName) {
    await safeFill(profile.middleName(page), input.middleName, {
      timeout: 5_000,
      label: "i9 middle name",
    });
    log.step(`Middle Name: filled`);
  }

  await safeFill(profile.lastName(page), input.lastName, {
    timeout: 5_000,
    label: "i9 last name",
  });
  log.step(`Last Name: filled`);

  // SSN: 9 digits, no dashes
  const ssnDigits = input.ssn.replace(/-/g, "");
  await safeFill(profile.ssn(page), ssnDigits, {
    timeout: 5_000,
    label: "i9 ssn",
  });
  log.step(`SSN: filled`);

  await safeFill(profile.dob(page), input.dob, {
    timeout: 5_000,
    label: "i9 dob",
  });
  log.step(`DOB: filled`);

  // Hide the jQuery datepicker that opens after DOB fill — Escape doesn't dismiss it,
  // so we force-hide via JS. Without this, the datepicker overlay intercepts Worksite clicks.
  await page.evaluate(() => {
    const dp = document.getElementById("ui-datepicker-div");
    if (dp) dp.style.display = "none";
  });

  await safeFill(profile.email(page), input.email, {
    timeout: 5_000,
    label: "i9 email",
  });
  log.step(`Email: filled`);

  // Select worksite by department number (format: "6-{deptNum} DESCRIPTION")
  await selectWorksite(page, input.departmentNumber);
}

/**
 * Select worksite from dropdown by matching department number.
 * Worksite options are formatted as "6-{deptNum} DESCRIPTION".
 */
async function selectWorksite(page: Page, departmentNumber: string): Promise<void> {
  const worksiteDropdown = profile.worksiteListbox(page);
  await safeClick(worksiteDropdown, { timeout: 5_000, label: "i9 worksite dropdown" });

  // Find and click the option matching the department number prefix
  const optionPattern = new RegExp(`6-${departmentNumber}`);
  const option = profile.worksiteOption(page, optionPattern);

  const optionCount = await option.count();
  if (optionCount === 0) {
    // Close dropdown and throw
    await page.keyboard.press("Escape");
    throw new Error(`No worksite found matching department number: ${departmentNumber}`);
  }

  await safeClick(option.first(), {
    timeout: 5_000,
    label: "i9 worksite option",
  });
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
