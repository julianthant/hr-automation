import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { dismissPeopleSoftModalMask as hidePeopleSoftModalMask } from "../common/modal.js";
import { emergencyContact } from "./selectors.js";

/**
 * UCPath standalone Emergency Contact component.
 *
 * Using `uc_deep_link=1` opens the page WITHOUT the HR Tasks Activity Guide
 * iframe wrapper — form refs land at the page's top level, so no
 * `getContentFrame()` is needed.
 */
export const EMERGENCY_CONTACT_URL =
  "https://ucphrprdpub.universityofcalifornia.edu/psc/ucphrprd/EMPLOYEE/HRMS/c/ADMINISTER_WORKFORCE_(GBL).EMERGENCY_CONTACT.GBL?NavColl=true&uc_deep_link=1";

/**
 * Open the Emergency Contact editor for a specific employee.
 *
 * Verified 2026-04-14 (EID 10872384 Kelsey Bauer):
 *   - Direct URL with uc_deep_link=1 loads outside the HR Tasks iframe
 *   - Empl ID textbox + Search button live at top-level `page`
 *   - After Search, the editor renders in-place showing row 1 of N contacts
 *
 * Returns the Page — all subsequent field interactions use `page.getByRole(...)`.
 */
export async function navigateToEmergencyContact(
  page: Page,
  emplId: string,
): Promise<void> {
  log.step("Opening Emergency Contact component...");
  await page.goto(EMERGENCY_CONTACT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  await hidePeopleSoftModalMask(page);

  log.step(`Filling Empl ID ${emplId} and searching...`);
  await emergencyContact
    .emplIdInput(page)
    .fill(emplId, { timeout: 10_000 });

  await hidePeopleSoftModalMask(page);
  await emergencyContact.searchButton(page).click({ timeout: 10_000 });

  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // If the employee has no emergency contact AND no record at all,
  // PeopleSoft shows "No matching values were found."
  const noMatch = emergencyContact.noMatchMessage(page);
  if ((await noMatch.count().catch(() => 0)) > 0) {
    throw new NoExistingContactError(emplId);
  }

  // Multi-result grid may show a "Drill in" link per row; follow it.
  const drillIn = emergencyContact.drillInLink(page);
  if ((await drillIn.count().catch(() => 0)) > 0) {
    log.step("Clicking Drill in...");
    await drillIn.first().click({ timeout: 10_000 });
    await page.waitForTimeout(3_000);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  }

  log.success(`Emergency Contact editor loaded for Empl ID ${emplId}`);
}

// Re-export under the legacy name so existing callers still resolve.
// Implementation lives in src/systems/common/modal.ts.
export { hidePeopleSoftModalMask };

/**
 * Read every existing Contact Name textbox on the currently loaded editor.
 * Used to skip records whose batch contact already exists in UCPath
 * (duplicate guard).
 */
export async function readExistingContactNames(page: Page): Promise<string[]> {
  try {
    const names = await emergencyContact.contactNameInputs(page).all();
    const out: string[] = [];
    for (const n of names) {
      const v = await n.inputValue({ timeout: 2_000 }).catch(() => "");
      if (v.trim()) out.push(v.trim());
    }
    return out;
  } catch {
    return [];
  }
}

export class NoExistingContactError extends Error {
  constructor(public readonly emplId: string) {
    super(`No existing emergency contact record for Empl ID ${emplId}`);
    this.name = "NoExistingContactError";
  }
}

/**
 * Demote an existing emergency contact by unchecking its Primary Contact
 * checkbox, then save. Used by the emergency-contact workflow's fuzzy-
 * duplicate path: when an existing record's name fuzzily matches the new
 * contact (e.g. historical typo "Tomako Langley" vs new "Tomoko Longley"),
 * we demote the historical entry and add the new contact as primary.
 *
 * Idempotent: if the primary is already unchecked, just saves.
 * Throws if `existingName` doesn't match any row's Contact Name input.
 *
 * Caller is expected to be on the Emergency Contact editor (post
 * `navigateToEmergencyContact`). After the save settles, callers usually
 * re-navigate via `navigateToEmergencyContact(page, emplId)` so the
 * subsequent "Add a new row" plan starts from a clean editor state.
 */
export async function demoteExistingContact(
  page: Page,
  existingName: string,
): Promise<void> {
  log.step(`Demoting existing contact "${existingName}"...`);

  await hidePeopleSoftModalMask(page);

  const nameInputs = await emergencyContact.contactNameInputs(page).all();
  let targetIndex = -1;
  for (let i = 0; i < nameInputs.length; i++) {
    const v = await nameInputs[i].inputValue({ timeout: 2_000 }).catch(() => "");
    if (v.trim() === existingName.trim()) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === -1) {
    throw new Error(
      `demoteExistingContact: no Contact Name row matched "${existingName}". ` +
        `Existing rows: [${nameInputs.length} found]`,
    );
  }

  const primaryCheckboxes = emergencyContact.primaryContactCheckboxes(page);
  const cb = primaryCheckboxes.nth(targetIndex);
  const checked = await cb.isChecked({ timeout: 5_000 }).catch(() => false);
  if (checked) {
    await cb.uncheck({ timeout: 5_000 });
    await page.waitForTimeout(500);
    log.step(`Unchecked Primary Contact on row ${targetIndex + 1}`);
  } else {
    log.step(`Row ${targetIndex + 1} already non-primary — skipping uncheck`);
  }

  await hidePeopleSoftModalMask(page);
  await emergencyContact.saveButton(page).click({ timeout: 10_000 });
  await page.waitForTimeout(2_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  log.success(`Demoted "${existingName}" — Primary Contact unchecked + saved`);
}
