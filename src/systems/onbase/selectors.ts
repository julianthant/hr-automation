import type { Page, FrameLocator, Locator } from "playwright";

/**
 * OnBase (Hyland) selector registry.
 *
 * OnBase renders Document Retrieval / Import Document inside nested iframes
 * off `NavPanel.aspx`. The **Import Document** form lives in the navigation-
 * panel iframe `iframe[name="NavPanelIFrame"]` (src `FileUploadEnhanced.aspx`);
 * the nine-squares Main Menu and its menu items live on the **top** page.
 *
 * So selectors split into two groups:
 *   - `nav` — top-page Main Menu + menu items (take a `Page`).
 *   - `importForm` — fields inside the import iframe (take a `FrameLocator`,
 *     resolved once via `importForm.frame(page)`).
 *
 * Field accessible-names map 1:1 to the OnBase Keyword labels (e.g.
 * "UCPath ID", "Document Name"). The `Employee Lookup` keyset autofills every
 * keyword from the UCPath ID + Tab — only "Document Name" is left to set.
 *
 * Every selector verified live 2026-06-22 against the production tenant.
 */

// ─── Top page: nine-squares Main Menu + menu items ────────────────────────

export const nav = {
  /**
   * Nine-squares "Main Menu" launcher in the top banner. verified 2026-06-22
   * @tags onbase, menu, main-menu, nine-squares, launcher, nav
   */
  mainMenuButton: (page: Page): Locator =>
    page.getByRole("navigation", { name: "Main Menu" }),

  /**
   * "Import Document" item in the Main Menu Document group. verified 2026-06-22
   * @tags onbase, menu, import, import-document, menuitem, nav
   */
  importDocumentMenuItem: (page: Page): Locator =>
    page.getByRole("menuitem", { name: "Import Document" }),

  /**
   * "Document Retrieval" item in the Main Menu Document group (search screen).
   * verified 2026-06-22
   * @tags onbase, menu, document-retrieval, search, menuitem, nav
   */
  documentRetrievalMenuItem: (page: Page): Locator =>
    page.getByRole("menuitem", { name: "Document Retrieval" }),
};

// ─── Import Document form (inside iframe[name="NavPanelIFrame"]) ───────────

export const importForm = {
  /**
   * The Import Document iframe (`FileUploadEnhanced.aspx`). Resolve once, then
   * pass the FrameLocator to the field selectors below. verified 2026-06-22
   * @tags onbase, import, iframe, frame, navpanel
   */
  frame: (page: Page): FrameLocator =>
    page.frameLocator('iframe[name="NavPanelIFrame"]'),

  /**
   * Hidden `<input type=file>` behind the "Choose File" button. Drive with
   * `.setInputFiles(path)`. verified 2026-06-22
   * @tags onbase, import, file, upload, choose-file
   */
  fileInput: (frame: FrameLocator): Locator =>
    frame.locator('input[type="file"]'),

  /**
   * "Document Type Groups" `<select>` (`<All>` / Payroll / Personnel).
   * verified 2026-06-22
   * @tags onbase, import, document-type-groups, select, dropdown
   */
  documentTypeGroupsSelect: (frame: FrameLocator): Locator =>
    frame.getByRole("combobox", { name: "Document Type Groups" }),

  /**
   * "Document Types" `<select>` (X_HR_* types incl. X_HR_Emergency Contact).
   * verified 2026-06-22
   * @tags onbase, import, document-types, select, dropdown, emergency-contact
   */
  documentTypesSelect: (frame: FrameLocator): Locator =>
    frame.getByRole("combobox", { name: "Document Types" }),

  /**
   * "File Type" `<select>` (pick `PDF (.pdf)`; defaults to Image File Format).
   * verified 2026-06-22
   * @tags onbase, import, file-type, select, dropdown, pdf
   */
  fileTypeSelect: (frame: FrameLocator): Locator =>
    frame.getByRole("combobox", { name: "File Type" }),

  /**
   * "Keyset Lookup" `<select>` (`Employee Lookup` is the autofill keyset).
   * verified 2026-06-22
   * @tags onbase, import, keyset, employee-lookup, select, dropdown
   */
  keysetLookupSelect: (frame: FrameLocator): Locator =>
    frame.getByRole("combobox", { name: "Keyset Lookup" }),

  /**
   * Apply-keyset (key icon) button beside the Keyset Lookup select.
   * verified 2026-06-22
   * @tags onbase, import, keyset, apply, button
   */
  keysetApplyButton: (frame: FrameLocator): Locator =>
    frame.getByRole("button", { name: "Keyset Lookup" }),

  /**
   * A keyword textbox by its OnBase label (e.g. "UCPath ID", "Last Name",
   * "First Name", "Middle Name", "Suffix", "Document Name"). verified 2026-06-22
   * @tags onbase, import, keyword, textbox, generic
   */
  keywordInput: (frame: FrameLocator, label: string): Locator =>
    frame.getByRole("textbox", { name: label, exact: true }),

  /**
   * A keyword combobox by its OnBase label (dataset-backed fields:
   * "Department Name", "Department Code", "Vice Chancellor",
   * "Vice Chancellor Code"). verified 2026-06-22
   * @tags onbase, import, keyword, combobox, dataset, department, vice-chancellor
   */
  keywordCombobox: (frame: FrameLocator, label: string): Locator =>
    frame.getByRole("combobox", { name: label, exact: true }),

  /**
   * The UCPath ID keyword textbox — the primary key; type it + Tab to fire the
   * Employee Lookup keyset autofill. verified 2026-06-22
   * @tags onbase, import, ucpath-id, keyword, primary, autofill
   */
  ucpathIdInput: (frame: FrameLocator): Locator =>
    frame.getByRole("textbox", { name: "UCPath ID", exact: true }),

  /**
   * The Document Name keyword textbox — the one required field the keyset does
   * NOT autofill (set the per-doc-type constant). verified 2026-06-22
   * @tags onbase, import, document-name, keyword, constant
   */
  documentNameInput: (frame: FrameLocator): Locator =>
    frame.getByRole("textbox", { name: "Document Name", exact: true }),

  /**
   * The "Import" submit button (disabled until a file + required keywords are
   * present). verified 2026-06-22
   * @tags onbase, import, submit, button
   */
  importButton: (frame: FrameLocator): Locator =>
    frame.getByRole("button", { name: "Import", exact: true }),

  /**
   * "Clear Keywords" button — reset keyword fields without losing the file.
   * verified 2026-06-22
   * @tags onbase, import, clear, keywords, button
   */
  clearKeywordsButton: (frame: FrameLocator): Locator =>
    frame.getByRole("button", { name: "Clear Keywords" }),

  /**
   * "Clear All" button — reset the whole import form. verified 2026-06-22
   * @tags onbase, import, clear, all, button, reset
   */
  clearAllButton: (frame: FrameLocator): Locator =>
    frame.getByRole("button", { name: "Clear All" }),
};

export const onbaseSelectors = { nav, importForm };
