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
   * Search box inside an open Select2 dropdown, scoped to ONE field by the
   * drop search input's accessible name (`Select Specifically:` /
   * `Select Category:` — note the `Select ` prefix, distinct from the choice
   * anchor's `Specifically:` / `Category:`). Pass the bare field label
   * (`"Specifically"` | `"Category"`).
   *
   * Why scoped, not `.select2-drop-active`: this ServiceNow build does NOT
   * remove `select2-drop-active` from a drop once another opens, and it keeps
   * each closed drop's search input in the DOM. So
   * `.select2-drop-active input.select2-input` resolves to BOTH fields' inputs
   * and `fill` dies on a strict-mode violation. The per-field accessible name
   * is unambiguous regardless of how many drops linger. See LESSONS.md
   * (2026-06-04).
   */
  // verified 2026-06-04
  select2DropSearch: (page: Page, fieldLabel: string): Locator =>
    page.getByRole("combobox", { name: `Select ${fieldLabel}:` }),

  /**
   * A result row in a specific field's open Select2 dropdown, matched by
   * visible label. Scoped to the field's own `.select2-drop` (via its search
   * input's accessible name) so it never picks a row out of a sibling field's
   * lingering-active drop. Pass the bare field label + the option text.
   */
  // verified 2026-06-04
  select2ResultOption: (page: Page, fieldLabel: string, label: string): Locator =>
    page
      .getByRole("combobox", { name: `Select ${fieldLabel}:` })
      .locator(
        'xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," select2-drop ")][1]//*[contains(concat(" ",normalize-space(@class)," ")," select2-result-label ")]',
      )
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
