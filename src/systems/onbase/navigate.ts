import type { Page, FrameLocator } from "playwright";
import { log } from "../../utils/log.js";
import { safeClick, safeFill } from "../common/index.js";
import { onbaseSelectors } from "./selectors.js";

/** OnBase document type for Emergency Contact imports. */
export const ONBASE_EC_DOCUMENT_TYPE = "X_HR_Emergency Contact";
/** File Type option to select for PDF imports. */
export const ONBASE_PDF_FILE_TYPE = "PDF (.pdf)";
/** Keyset that autofills every keyword from the UCPath ID. */
export const ONBASE_EMPLOYEE_LOOKUP_KEYSET = "Employee Lookup";
/** Constant Document Name for Emergency Contact docs. */
export const ONBASE_EC_DOCUMENT_NAME = "EMERGENCY CONTACT INFORMATION";

/**
 * Required ("red") keyword labels on the Emergency Contact import. The
 * Employee Lookup keyset autofills all of these EXCEPT Document Name; the
 * handler verifies they are non-empty before enabling Import.
 */
export const ONBASE_REQUIRED_KEYWORDS = [
  "UCPath ID",
  "Last Name",
  "First Name",
  "Document Name",
  "Department Name",
  "Department Code",
  "Vice Chancellor",
  "Vice Chancellor Code",
] as const;

/** Keyword labels that are dataset-backed comboboxes (not plain textboxes). */
const COMBOBOX_KEYWORDS = new Set<string>([
  "Department Name",
  "Department Code",
  "Vice Chancellor",
  "Vice Chancellor Code",
]);

function importFrame(page: Page): FrameLocator {
  return onbaseSelectors.importForm.frame(page);
}

/**
 * Open the Import Document screen: nine-squares Main Menu → Import Document,
 * then wait for the import form (UCPath ID field) to render.
 */
export async function openImportDocument(page: Page): Promise<void> {
  log.step("OnBase: opening Import Document...");
  await safeClick(onbaseSelectors.nav.mainMenuButton(page), {
    label: "onbase.nav.mainMenuButton",
    timeout: 10_000,
  });
  await safeClick(onbaseSelectors.nav.importDocumentMenuItem(page), {
    label: "onbase.nav.importDocumentMenuItem",
    timeout: 10_000,
  });
  const frame = importFrame(page);
  await onbaseSelectors.importForm.ucpathIdInput(frame).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  log.step("OnBase: Import Document form ready");
}

/** Select the Document Types dropdown option (e.g. X_HR_Emergency Contact). */
export async function selectDocumentType(page: Page, label: string): Promise<void> {
  const frame = importFrame(page);
  await onbaseSelectors.importForm.documentTypesSelect(frame).selectOption({ label });
  log.step(`OnBase: document type → ${label}`);
}

/** Select the File Type dropdown option (e.g. PDF (.pdf)). */
export async function selectFileType(page: Page, label: string): Promise<void> {
  const frame = importFrame(page);
  await onbaseSelectors.importForm.fileTypeSelect(frame).selectOption({ label });
  log.step(`OnBase: file type → ${label}`);
}

/** Ensure the Keyset Lookup is the autofill keyset (idempotent). */
export async function ensureKeyset(
  page: Page,
  keyset: string = ONBASE_EMPLOYEE_LOOKUP_KEYSET,
): Promise<void> {
  const frame = importFrame(page);
  const select = onbaseSelectors.importForm.keysetLookupSelect(frame);
  const current = await select.inputValue().catch(() => "");
  // `<select>` inputValue is the option value; compare against the label too.
  if (current !== keyset) {
    await select.selectOption({ label: keyset }).catch(async () => {
      await select.selectOption(keyset);
    });
    log.step(`OnBase: keyset → ${keyset}`);
  }
}

/** Attach the file to import (the person's single-page PDF). */
export async function chooseFile(page: Page, filePath: string): Promise<void> {
  const frame = importFrame(page);
  await onbaseSelectors.importForm.fileInput(frame).setInputFiles(filePath);
  log.step(`OnBase: attached file ${filePath}`);
}

/**
 * Type the UCPath ID and Tab out to fire the Employee Lookup keyset autofill,
 * then poll for the lookup to populate (Last Name becomes non-empty).
 * Returns true if the keyset autofilled, false if it stayed empty (caller then
 * fills the required keywords from OCR / person-lookup fallback data).
 */
export async function enterUcpathIdAndTab(
  page: Page,
  ucpathId: string,
  timeoutMs = 12_000,
): Promise<boolean> {
  const frame = importFrame(page);
  await safeFill(onbaseSelectors.importForm.ucpathIdInput(frame), ucpathId, {
    label: "onbase.importForm.ucpathIdInput",
    timeout: 10_000,
  });
  await page.keyboard.press("Tab");
  log.step(`OnBase: UCPath ID ${ucpathId} entered — awaiting keyset autofill`);

  const lastName = onbaseSelectors.importForm.keywordInput(frame, "Last Name");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await lastName.inputValue().catch(() => "");
    if (v.trim()) {
      log.step(`OnBase: keyset autofilled (Last Name = ${v.trim()})`);
      return true;
    }
    await page.waitForTimeout(500);
  }
  log.warn(`OnBase: keyset did not autofill for UCPath ID ${ucpathId} — using fallback data`);
  return false;
}

/** Read the current value of each required ("red") keyword field. */
export async function readRequiredKeywordValues(
  page: Page,
): Promise<Record<string, string>> {
  const frame = importFrame(page);
  const out: Record<string, string> = {};
  for (const label of ONBASE_REQUIRED_KEYWORDS) {
    const locator = COMBOBOX_KEYWORDS.has(label)
      ? onbaseSelectors.importForm.keywordCombobox(frame, label)
      : onbaseSelectors.importForm.keywordInput(frame, label);
    out[label] = (await locator.inputValue().catch(() => "")).trim();
  }
  return out;
}

/** Fill a single keyword field (textbox or dataset combobox) by label. */
export async function fillKeyword(page: Page, label: string, value: string): Promise<void> {
  const frame = importFrame(page);
  const locator = COMBOBOX_KEYWORDS.has(label)
    ? onbaseSelectors.importForm.keywordCombobox(frame, label)
    : onbaseSelectors.importForm.keywordInput(frame, label);
  await safeFill(locator, value, {
    label: `onbase.importForm.keyword:${label}`,
    timeout: 10_000,
  });
}

/** Set the Document Name keyword (the one required field the keyset omits). */
export async function setDocumentName(
  page: Page,
  value: string = ONBASE_EC_DOCUMENT_NAME,
): Promise<void> {
  const frame = importFrame(page);
  await safeFill(onbaseSelectors.importForm.documentNameInput(frame), value, {
    label: "onbase.importForm.documentNameInput",
    timeout: 10_000,
  });
  log.step(`OnBase: document name → ${value}`);
}

/** True if the Import button is enabled (file + required keywords present). */
export async function isImportEnabled(page: Page): Promise<boolean> {
  const frame = importFrame(page);
  return onbaseSelectors.importForm.importButton(frame).isEnabled().catch(() => false);
}

/** Click the Import button to submit the document. */
export async function clickImport(page: Page): Promise<void> {
  const frame = importFrame(page);
  await safeClick(onbaseSelectors.importForm.importButton(frame), {
    label: "onbase.importForm.importButton",
    timeout: 15_000,
  });
  log.step("OnBase: Import clicked");
}
