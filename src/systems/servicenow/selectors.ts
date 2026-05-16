import type { Page, Locator } from "playwright";

/**
 * Selectors for the UCSD HR General Inquiry form on support.ucsd.edu.
 *
 * Form URL: https://support.ucsd.edu/esc?id=sc_cat_item&table=sc_cat_item&sys_id=d8af3ae8db4fe510b3187d84f39619bf
 * Page title: "HR General Inquiry - Employee Center"
 *
 * Mapped 2026-05-01. Form lives in main DOM (no iframe), uses ARIA roles
 * with stable accessible names.
 *
 * @tags servicenow, hr-inquiry-form
 */

export const hrInquiry = {
  /** Subject textbox (required). */
  // verified 2026-05-01
  subjectInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Subject" }),

  /** Description textbox (required). */
  // verified 2026-05-01
  descriptionInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Description" }),

  /**
   * "Specifically:" combobox — ServiceNow typeahead. Implementation: type
   * search term, wait for suggestion list, click matching option.
   */
  // verified 2026-05-01
  specificallyInput: (page: Page): Locator =>
    page.getByRole("combobox", { name: "Specifically:" }),

  /**
   * "Category:" combobox — placeholder "-- None --".
   */
  // verified 2026-05-01
  categoryInput: (page: Page): Locator =>
    page.getByRole("combobox", { name: "Category:" }),

  /**
   * Native file input adjacent to the "Choose a file" button. Use
   * `setInputFiles` on this rather than clicking the visible button.
   */
  // verified 2026-05-01
  fileInput: (page: Page): Locator =>
    page.locator('input[type="file"]').first(),

  /** Submit the inquiry. */
  // verified 2026-05-01
  submitButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Submit" }),
};
