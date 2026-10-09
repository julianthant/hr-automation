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
 * keyword via its MODAL search (`keysetLookup.*` below — NOT UCPath ID + Tab,
 * which does nothing) — only "Document Name" is left to set.
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
   * The UCPath ID keyword textbox — the primary key. Autofill runs through the
   * keyset MODAL (`keysetLookup.*`), not by typing here + Tab. verified 2026-07-02
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

// ─── Employee Lookup keyset MODAL (top-page dialog + nested iframe) ─────────
//
// The keyset is NOT an inline autofill on Tab (the old assumption). Clicking the
// key-icon (`importForm.keysetApplyButton`) opens an "Employee Lookup" dialog on
// the TOP page whose search form lives in a nested `ReverseKeysetLookup.aspx`
// iframe. You fill the modal's UCPath ID, click Find, and on a match the results
// row auto-selects and "Select Employee" (on the dialog) enables — clicking it
// closes the dialog and autofills every keyword on the import form. A miss shows
// a "No matching records were found" alert. Verified live 2026-07-02.

export const keysetLookup = {
  /**
   * The "Employee Lookup" modal dialog (top page), opened by the key-icon.
   * verified 2026-07-02
   * @tags onbase, keyset, employee-lookup, modal, dialog
   */
  dialog: (page: Page): Locator => page.getByRole("dialog", { name: "Employee Lookup" }),

  /**
   * The modal's search-form iframe (`ReverseKeysetLookup.aspx`). The OBToken in
   * the src varies, so match on the stable page path. verified 2026-07-02
   * @tags onbase, keyset, employee-lookup, modal, iframe, frame
   */
  frame: (page: Page): FrameLocator =>
    page.frameLocator('iframe[src*="ReverseKeysetLookup.aspx"]'),

  /**
   * The modal's OWN UCPath ID search field (distinct from the import form's).
   * verified 2026-07-02
   * @tags onbase, keyset, employee-lookup, modal, ucpath-id, search, textbox
   */
  ucpathIdInput: (frame: FrameLocator): Locator =>
    frame.getByRole("textbox", { name: "UCPath ID", exact: true }),

  /**
   * The modal's Find button (runs the employee search). verified 2026-07-02
   * @tags onbase, keyset, employee-lookup, modal, find, search, button
   */
  findButton: (frame: FrameLocator): Locator =>
    frame.getByRole("button", { name: "Find", exact: true }),

  /**
   * "Select Employee" — enabled once a result row is selected; clicking it
   * autofills the import form and closes the dialog. verified 2026-07-02
   * @tags onbase, keyset, employee-lookup, modal, select, button
   */
  selectEmployeeButton: (page: Page): Locator =>
    page.getByRole("dialog", { name: "Employee Lookup" }).getByRole("button", {
      name: "Select Employee",
    }),

  /**
   * "Close Dialog" — dismiss the Employee Lookup modal without selecting.
   * verified 2026-07-02
   * @tags onbase, keyset, employee-lookup, modal, close, cancel, button
   */
  closeButton: (page: Page): Locator =>
    page.getByRole("dialog", { name: "Employee Lookup" }).getByRole("button", {
      name: "Close Dialog",
    }),

  /**
   * The "No matching records were found" message (search returned nothing =
   * bad/unknown UCPath ID). verified 2026-07-02
   * @tags onbase, keyset, employee-lookup, modal, no-match, message
   */
  noMatchMessage: (page: Page): Locator =>
    page.getByText("No matching records were found"),

  /**
   * OK button on the no-match alert dialog. verified 2026-07-02
   * @tags onbase, keyset, employee-lookup, modal, no-match, ok, button
   */
  noMatchOkButton: (page: Page): Locator =>
    page.getByRole("alertdialog", { name: "Message" }).getByRole("button", { name: "OK" }),
};

// ─── Document Queue panel (sibling top-page iframe `frmViewer`) ─────────────
//
// After a file is attached, the right-hand "Document Queue (N)" panel lists it
// with status "Pending Import" — the authoritative attach confirmation. The
// panel lives in the `frmViewer` iframe (`FileUploadEnhancedRightPage.aspx`), a
// SIBLING of NavPanelIFrame on the top page, NOT nested inside the import form.
// Queue rows are page-scoped (a fresh Import Document load starts empty —
// verified live 2026-07-02) but they survive same-page retries, so leftover
// rows must be removed before attaching or Import would file duplicates.

export const documentQueue = {
  /**
   * The Document Queue iframe (`frmViewer`, src `FileUploadEnhancedRightPage.aspx`)
   * — a top-page sibling of NavPanelIFrame. verified 2026-07-02
   * @tags onbase, import, document-queue, iframe, frame, frmviewer
   */
  frame: (page: Page): FrameLocator =>
    page.frameLocator('iframe[name="frmViewer"]'),

  /**
   * A queued document's row by filename (cell text). Appearing with status
   * "Pending Import" confirms the attach landed. verified 2026-07-02
   * @tags onbase, import, document-queue, row, pending-import, attach, confirm
   */
  queuedRow: (frame: FrameLocator, fileName: string): Locator =>
    frame.getByRole("row", { name: new RegExp(escapeForRegExp(fileName), "i") }),

  /**
   * Every "Remove" button in the queue — used to clear leftover rows from a
   * failed prior attempt before attaching (duplicate-import defense).
   * verified 2026-07-02
   * @tags onbase, import, document-queue, remove, clear, button
   */
  removeButtons: (frame: FrameLocator): Locator =>
    frame.getByRole("button", { name: "Remove" }),
};

/** Escape a literal filename for use inside a RegExp accessible-name match. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const onbaseSelectors = { nav, importForm, keysetLookup, documentQueue };
