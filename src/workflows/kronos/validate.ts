import { readFile, stat, unlink } from "fs/promises";
import { log } from "../../utils/log.js";

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
 * Extract a likely employee name from the first page of a PDF.
 * Reads the raw text content and looks for name-like lines.
 */
export async function getPdfName(filepath: string): Promise<string> {
  try {
    const buffer = await readFile(filepath);
    const text = buffer.toString("utf-8");

    // Extract readable text chunks (PDF text objects often appear between parentheses or as plain text)
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const skipKeywords = [
      "time detail", "report", "date", "page", "***",
      "actual", "adjusted", "period",
    ];

    for (const line of lines.slice(0, 50)) {
      const lower = line.toLowerCase();
      if (skipKeywords.some((kw) => lower.includes(kw))) continue;
      // Name lines have alpha chars and aren't pure numbers
      if (/[a-zA-Z]/.test(line) && !/^\d+$/.test(line.replace(/[\s,.\-]/g, ""))) {
        // Only return if it looks like a name (reasonable length, has letters)
        if (line.length > 2 && line.length < 60) {
          return line;
        }
      }
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Validate a PDF and delete it if it contains no data.
 * Returns validation result with PDF name if valid.
 */
export async function validateAndClean(
  filepath: string,
  employeeId: string,
): Promise<{ valid: boolean; pdfName: string }> {
  const pdfName = await getPdfName(filepath);
  const valid = await validatePdf(filepath);

  if (!valid) {
    log.step(`[${employeeId}] PDF contains no data — deleting`);
    try {
      await unlink(filepath);
    } catch {
      // File may not exist
    }
  }

  return { valid, pdfName };
}
