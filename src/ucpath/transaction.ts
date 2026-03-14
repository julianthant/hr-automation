import type { FrameLocator } from "playwright";
import type { TransactionResult } from "./types.js";
import { waitForPeopleSoftProcessing } from "./navigate.js";
import { log } from "../utils/log.js";

/**
 * Select a template from the PeopleSoft template dropdown/lookup.
 *
 * Tries native <select> first, then falls back to PeopleSoft lookup dialog.
 *
 * @param frame - PeopleSoft content iframe FrameLocator
 * @param templateId - Template name to select (e.g., "UC_FULL_HIRE")
 */
export async function selectTemplate(
  frame: FrameLocator,
  templateId: string,
): Promise<void> {
  log.step(`Selecting template: ${templateId}`);

  // SELECTOR: Template dropdown -- native <select> element. Adjust after live testing.
  try {
    const templateSelect = frame
      .locator("select")
      .filter({ hasText: /template/i })
      .or(frame.getByLabel(/template/i));

    await templateSelect.first().selectOption(
      { label: templateId },
      { timeout: 5_000 },
    );

    log.step("Template selected via native dropdown");
  } catch {
    // SELECTOR: PeopleSoft lookup-based template selection -- adjust after live testing
    log.step("Trying lookup-based template selection...");

    // SELECTOR: Lookup icon next to template field -- adjust after live testing
    const lookupIcon = frame.locator(
      "[id*='TEMPLATE'] + a, [id*='TMPL'] + a, img[alt*='lookup']",
    );
    await lookupIcon.first().click({ timeout: 5_000 });

    // SELECTOR: Search field in PeopleSoft lookup dialog -- adjust after live testing
    const searchField = frame.getByRole("textbox").first();
    await searchField.fill(templateId, { timeout: 5_000 });

    // SELECTOR: Search/Look Up button in lookup dialog -- adjust after live testing
    const searchBtn = frame
      .getByRole("button", { name: /look up|search/i })
      .first();
    await searchBtn.click({ timeout: 5_000 });

    // SELECTOR: Result link in lookup dialog -- adjust after live testing
    const resultLink = frame.getByText(templateId).first();
    await resultLink.click({ timeout: 5_000 });

    log.step("Template selected via lookup dialog");
  }

  await waitForPeopleSoftProcessing(frame);
  log.success(`Template "${templateId}" selected`);
}

/**
 * Fill the effective date field and press Tab to trigger PeopleSoft server validation.
 *
 * @param frame - PeopleSoft content iframe FrameLocator
 * @param date - Date string in MM/DD/YYYY format
 */
export async function enterEffectiveDate(
  frame: FrameLocator,
  date: string,
): Promise<void> {
  log.step(`Entering effective date: ${date}`);

  // SELECTOR: Effective date input field -- adjust after live testing
  const dateField = frame
    .getByLabel(/effective date/i)
    .or(frame.getByLabel(/job effective date/i))
    .or(frame.locator('input[id*="EFFDT"]'));

  await dateField.first().fill(date, { timeout: 5_000 });

  // Press Tab to trigger PeopleSoft server validation
  await dateField.first().press("Tab");
  log.step("Tab pressed -- waiting for PeopleSoft validation...");

  await waitForPeopleSoftProcessing(frame);
  log.success("Effective date entered and validated");
}

/**
 * Click the Create Transaction button and check for errors.
 *
 * @param frame - PeopleSoft content iframe FrameLocator
 * @returns TransactionResult indicating success or failure with error message
 */
export async function clickCreateTransaction(
  frame: FrameLocator,
): Promise<TransactionResult> {
  log.step("Clicking Create Transaction...");

  // SELECTOR: Create Transaction button -- adjust after live testing
  const createBtn = frame
    .getByRole("button", { name: /create transaction/i })
    .or(frame.locator('input[value="Create Transaction"]'))
    .or(frame.getByText("Create Transaction"));

  await createBtn.first().click({ timeout: 10_000 });

  // Wait for PeopleSoft server round-trip (can be slow)
  log.step("Waiting for PeopleSoft to process transaction...");
  await waitForPeopleSoftProcessing(frame, 30_000);

  // SELECTOR: PeopleSoft error indicators -- adjust after live testing
  const errorLocator = frame.locator(
    ".PSERROR, #ALERTMSG, .ps_alert-error",
  );

  try {
    const errorCount = await errorLocator.count();
    if (errorCount > 0) {
      const errorText = await errorLocator.first().textContent({ timeout: 5_000 });
      log.error(`Transaction error: ${errorText ?? "Unknown error"}`);
      return { success: false, error: errorText ?? "Unknown error" };
    }
  } catch {
    // No error elements found -- that is good
  }

  log.success("Transaction created successfully");
  return { success: true };
}
