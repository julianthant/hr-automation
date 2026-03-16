import type { Page } from "playwright";
import { mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { log } from "../../utils/log.js";

/**
 * Build the employee download folder path.
 * Format: {Downloads}/onboarding/{Last Name, First Name Middle Name EID}/
 */
export function buildDownloadPath(firstName: string, lastName: string, middleName?: string): string {
  const downloads = join(homedir(), "Downloads");
  const middle = middleName ? ` ${middleName}` : "";
  const folderName = `${lastName}, ${firstName}${middle} EID`;
  return join(downloads, "onboarding", folderName);
}

/**
 * Ensure the employee download folder exists (creates recursively if needed).
 */
export async function ensureDownloadFolder(folderPath: string): Promise<void> {
  await mkdir(folderPath, { recursive: true });
  log.step(`Download folder ready: ${folderPath}`);
}

/**
 * Download CRM documents 1 and 3 from the record page PDF viewer.
 *
 * Must be called while on the main CRM record page, BEFORE navigating
 * to UCPath Entry Sheet.
 *
 * SELECTOR: TODO — requires playwright-cli discovery to identify:
 *   - Document selector control
 *   - PDF viewer element
 *   - Scroll mechanism
 *   - Download trigger
 *
 * @param page - CRM browser page (on record page)
 * @param folderPath - Destination folder for downloaded PDFs
 * @param prefix - Optional log prefix for worker identification
 */
export async function downloadCrmDocuments(
  page: Page,
  folderPath: string,
  prefix?: string,
): Promise<void> {
  const p = prefix;
  const msg = (s: string) => (p ? `${p} ${s}` : s);

  await ensureDownloadFolder(folderPath);

  // Download Document 1
  log.step(msg("Downloading CRM Document 1..."));
  await downloadDocument(page, 1, folderPath);
  log.step(msg("Document 1 downloaded"));

  // Download Document 3
  log.step(msg("Downloading CRM Document 3..."));
  await downloadDocument(page, 3, folderPath);
  log.step(msg("Document 3 downloaded"));

  log.success(msg("CRM document download complete"));
}

/**
 * Download a single document by number from the CRM document viewer.
 *
 * SELECTOR: TODO — all selectors in this function require playwright-cli
 * investigation. The implementation below is a structural placeholder.
 */
async function downloadDocument(
  page: Page,
  documentNumber: number,
  folderPath: string,
): Promise<void> {
  // SELECTOR: TODO — select document from dropdown/list
  // Example (placeholder): await page.selectOption('#documentSelector', `${documentNumber}`);
  // await page.waitForTimeout(2_000);

  // SELECTOR: TODO — scroll PDF viewer to end to ensure all pages load
  // Example (placeholder): await page.evaluate(() => { pdfViewer.scrollTo(0, pdfViewer.scrollHeight) });
  // await page.waitForTimeout(2_000);

  // SELECTOR: TODO — trigger download
  // Likely approach: intercept PDF URL from network, or click download button
  // const download = await page.waitForEvent('download');
  // await download.saveAs(join(folderPath, `document-${documentNumber}.pdf`));

  log.step(`Document ${documentNumber} download: TODO — awaiting playwright-cli selector discovery`);
}
