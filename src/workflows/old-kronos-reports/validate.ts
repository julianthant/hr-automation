import { createRequire } from "module";
import { readFile, stat, unlink } from "fs/promises";
import { log } from "../../utils/log.js";

const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse");

/**
 * Validate a downloaded PDF report.
 * Checks that the file exists, has content, and doesn't contain
 * the "No Data Returned" placeholder.
 *
 * @returns true if PDF contains actual report data
 */
export async function validatePdf(filepath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filepath);
    if (fileStat.size === 0) return false;

    const buffer = await readFile(filepath);
    const text = buffer.toString("utf-8");

    // PyPDF2 equivalent: check for the "No Data Returned" placeholder
    if (text.includes("No Data Returned")) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the employee name and ID from the first page of a PDF using pdf-parse.
 * The Time Detail report starts with: "LastName, FirstName ID: 12345678"
 */
export async function extractPdfIdentity(
  filepath: string,
): Promise<{ pdfName: string; pdfId: string }> {
  try {
    const parser = new PDFParse({ url: filepath });
    await parser.load();
    const result = await parser.getText();
    const text: string = result.pages?.[0]?.text ?? "";

    // First line format: "Maley, Gwendolyn ID: 10421911 Time Zone: Pacific"
    const match = text.match(/^(.+?)\s+ID:\s*(\d+)/);
    if (match) {
      return { pdfName: match[1].trim(), pdfId: match[2] };
    }
    return { pdfName: "", pdfId: "" };
  } catch {
    return { pdfName: "", pdfId: "" };
  }
}

/**
 * Verify that a PDF's internal name/ID matches the filename.
 * Returns "x" if matched, mismatch description if not, empty if can't read.
 */
export async function verifyPdfMatch(
  filepath: string,
  expectedName: string,
  expectedId: string,
): Promise<string> {
  const { pdfName, pdfId } = await extractPdfIdentity(filepath);

  if (!pdfName && !pdfId) return "Could not read PDF";

  const nameMatch = pdfName === expectedName;
  const idMatch = pdfId === expectedId;

  if (nameMatch && idMatch) return "x";

  const mismatches: string[] = [];
  if (!nameMatch) mismatches.push(`name: '${pdfName}' vs '${expectedName}'`);
  if (!idMatch) mismatches.push(`id: '${pdfId}' vs '${expectedId}'`);
  return mismatches.join("; ");
}

/**
 * Validate a PDF and delete it if it contains no data.
 * Returns validation result.
 */
export async function validateAndClean(
  filepath: string,
  employeeId: string,
): Promise<{ valid: boolean }> {
  const valid = await validatePdf(filepath);

  if (!valid) {
    log.step(`[${employeeId}] PDF contains no data — deleting`);
    try {
      await unlink(filepath);
    } catch {
      // File may not exist
    }
  }

  return { valid };
}
