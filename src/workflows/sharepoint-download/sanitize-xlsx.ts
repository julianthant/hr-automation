import JSZip from "jszip";
import { readFile, writeFile } from "node:fs/promises";

import { log } from "../../utils/log.js";

/**
 * Autofilter elements that Excel Online writes but ExcelJS's table parser does
 * not implement. `FilterColumnXform.parseOpen` throws
 * `Unexpected xml node in parseOpen: {"name":"colorFilter",...}` on the first
 * one it meets, which aborts `wb.xlsx.readFile` for the WHOLE workbook.
 *
 * Every entry here is a saved FILTER-UI state (which colour / icon the user last
 * filtered a column by). None of them carries cell data, so removing them
 * changes what a human sees in the filter dropdown and nothing else.
 */
const UNSUPPORTED_FILTER_ELEMENTS = ["colorFilter", "iconFilter", "extLst"] as const;

/** Matches `<name .../>`, `<name ...>...</name>`, and `<name></name>`. */
function buildElementPattern(name: string): RegExp {
  return new RegExp(`<${name}\\b[^>]*(?:/>|>[\\s\\S]*?</${name}>)`, "g");
}

export interface XlsxSanitizeResult {
  /** True when the file was rewritten (at least one element was removed). */
  changed: boolean;
  /** Per-element removal counts, for logging. Only non-zero entries. */
  removed: Record<string, number>;
}

/**
 * Strip table-filter elements ExcelJS cannot parse, IN PLACE.
 *
 * Why this exists: the onboarding roster is maintained in Excel Online, where
 * colour-filtering a column is routine. The resulting `xl/tables/tableN.xml`
 * makes the downloaded workbook unreadable by `roster-loader.ts` (which is the
 * same `wb.xlsx.readFile` call), so a perfectly good download landed on disk as
 * an unusable file and somebody had to hand-repair it in Excel. Sanitising at
 * download time means the artifact on disk is always readable.
 *
 * Deliberately NOT a silent fallback: it only removes elements from this
 * explicit allowlist, it reports exactly what it removed, and any failure to
 * read/rewrite the archive propagates rather than leaving a half-written file.
 *
 * @param filePath - path to the `.xlsx` written by the download step
 */
export async function sanitizeDownloadedXlsx(filePath: string): Promise<XlsxSanitizeResult> {
  const original = await readFile(filePath);
  const zip = await JSZip.loadAsync(original);

  const tableParts = Object.keys(zip.files).filter(
    (name) => name.startsWith("xl/tables/") && name.endsWith(".xml"),
  );
  if (tableParts.length === 0) return { changed: false, removed: {} };

  const removed: Record<string, number> = {};
  let changed = false;

  for (const part of tableParts) {
    const file = zip.file(part);
    if (!file) continue;
    const xml = await file.async("string");
    let next = xml;
    for (const element of UNSUPPORTED_FILTER_ELEMENTS) {
      const pattern = buildElementPattern(element);
      const matches = next.match(pattern);
      if (!matches || matches.length === 0) continue;
      next = next.replace(pattern, "");
      removed[element] = (removed[element] ?? 0) + matches.length;
    }
    if (next !== xml) {
      zip.file(part, next);
      changed = true;
    }
  }

  if (!changed) return { changed: false, removed: {} };

  const rebuilt = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await writeFile(filePath, rebuilt);

  const summary = Object.entries(removed)
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");
  log.warn(
    `Sanitized ${filePath}: removed ${summary} from xl/tables/*.xml. These are saved filter-UI `
    + `states that ExcelJS cannot parse; no cell data was touched.`,
  );
  return { changed: true, removed };
}
