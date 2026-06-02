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
   * "Specifically:" combobox — ServiceNow **Select2 v3** typeahead. The
   * accessible combobox is an OFFSCREEN focusser (`input.select2-focusser`)
   * that cannot be clicked (the visible `a.select2-choice` overlay intercepts
   * pointer events). Kept only as the accessible-name anchor for
   * `specificallyChoice`; to interact, click `specificallyChoice` to open the
   * drop, type into `select2DropSearch`, then pick `select2ResultOption`.
   */
  // verified 2026-06-02
  specificallyInput: (page: Page): Locator =>
    page.getByRole("combobox", { name: "Specifically:" }),

  /**
   * Visible Select2 anchor (`a.select2-choice`) for the "Specifically:" field.
   * Clicking it opens the dropdown. Scoped to the correct field via its shared
   * `.select2-container` ancestor of the offscreen focusser, so it never
   * collides with the Category Select2.
   */
  // verified 2026-06-02
  specificallyChoice: (page: Page): Locator =>
    page
      .getByRole("combobox", { name: "Specifically:" })
      .locator(
        'xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," select2-container ")][1]//a[contains(concat(" ",normalize-space(@class)," ")," select2-choice ")]',
      ),

  /**
   * "Category:" combobox — Select2 v3, placeholder "-- None --". Same offscreen
   * focusser caveat as Specifically; `selectOption` is tried first (works if
   * ServiceNow renders a native `<select>`), then `categoryChoice` as the
   * Select2 fallback.
   */
  // verified 2026-06-02
  categoryInput: (page: Page): Locator =>
    page.getByRole("combobox", { name: "Category:" }),

  /** Visible Select2 anchor (`a.select2-choice`) for the "Category:" field. */
  // verified 2026-06-02
  categoryChoice: (page: Page): Locator =>
    page
      .getByRole("combobox", { name: "Category:" })
      .locator(
        'xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," select2-container ")][1]//a[contains(concat(" ",normalize-space(@class)," ")," select2-choice ")]',
      ),

  /**
   * Search box inside the currently-open Select2 dropdown. Select2 v3 appends a
   * single `.select2-drop.select2-drop-active` to `<body>`; only one dropdown
   * is open at a time, so this is unambiguous across the form's comboboxes.
   */
  // verified 2026-06-02
  select2DropSearch: (page: Page): Locator =>
    page.locator(".select2-drop-active input.select2-input"),

  /** A result row in the open Select2 dropdown, matched by visible label. */
  // verified 2026-06-02
  select2ResultOption: (page: Page, label: string): Locator =>
    page
      .locator(".select2-drop-active .select2-result-label")
      .filter({ hasText: label })
      .first(),

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
