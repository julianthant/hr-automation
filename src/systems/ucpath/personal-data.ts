import type { Page } from "playwright";
import { log } from "../../utils/log.js";
import { dismissPeopleSoftModalMask as hidePeopleSoftModalMask } from "../common/modal.js";

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
  await page
    .getByRole("textbox", { name: "Empl ID" })
    .first()
    .fill(emplId, { timeout: 10_000 });

  await hidePeopleSoftModalMask(page);
  await page
    .getByRole("button", { name: "Search", exact: true })
    .first()
    .click({ timeout: 10_000 });

  await page.waitForTimeout(3_000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

  // If the employee has no emergency contact AND no record at all,
  // PeopleSoft shows "No matching values were found."
  const noMatch = page.getByText("No matching values were found.");
  if ((await noMatch.count().catch(() => 0)) > 0) {
    throw new NoExistingContactError(emplId);
  }

  // Multi-result grid may show a "Drill in" link per row; follow it.
  const drillIn = page.getByRole("link", { name: /drill in/i });
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
    const names = await page
      .getByRole("textbox", { name: "Contact Name" })
      .all();
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
