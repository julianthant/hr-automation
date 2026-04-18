import type { Page, Frame } from "playwright";
import { writeFile, mkdir } from "fs/promises";
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "../../utils/log.js";

const IDOCS_VIEWER_HOST = "crickportal-ext.bfs.ucsd.edu";
const IDOCS_VIEWER_PATH = "/iDocsForSalesforce/Content/pdfjs/web/PDFjsViewer.aspx";
const IDOCS_DOC_PATH = "/iDocsForSalesforce/iDocsForSalesforceDocumentServer";

/** Documents we download by default: index 0 = Doc 1 (offer letter), index 2 = Doc 3. */
export const DEFAULT_DOC_INDICES = [0, 2];

export interface DownloadedDoc {
  index: number;
  filename: string;
  path: string;
  bytes: number;
}

export function buildDownloadPath(firstName: string, lastName: string, middleName?: string): string {
  const downloads = join(homedir(), "Downloads");
  const middle = middleName ? ` ${middleName}` : "";
  const folderName = `${lastName}, ${firstName}${middle} EID`;
  return join(downloads, "onboarding", folderName);
}

export async function ensureDownloadFolder(folderPath: string): Promise<void> {
  await mkdir(folderPath, { recursive: true });
  log.step(`Download folder ready: ${folderPath}`);
}

interface ViewerInfo {
  hash: string;
  totalDocs: number;
}

async function findViewerInfo(page: Page, timeoutMs = 30_000): Promise<ViewerInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((f) => {
      const url = f.url();
      return url.includes(IDOCS_VIEWER_HOST) && url.includes(IDOCS_VIEWER_PATH);
    });
    if (frame) {
      const url = new URL(frame.url());
      const hash = url.searchParams.get("h");
      const count = Number(url.searchParams.get("c") ?? "0");
      if (hash) return { hash, totalDocs: count };
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`iDocs PDF.js viewer did not load within ${timeoutMs}ms`);
}

function parseFilenameFromHeader(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const match = header.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (!match) return fallback;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export async function downloadCrmDocuments(
  page: Page,
  folderPath: string,
  options: { docIndices?: number[]; logPrefix?: string } = {},
): Promise<DownloadedDoc[]> {
  const p = options.logPrefix;
  const msg = (s: string) => (p ? `${p} ${s}` : s);
  const indices = options.docIndices ?? DEFAULT_DOC_INDICES;

  // Skip-if-already-downloaded: reconstruct DownloadedDoc[] from on-disk files
  // only if ALL expected docs are present. Files land as `Doc{N}-<filename>.pdf`.
  // A partial prior run (Doc1 present, Doc3 missing) falls through to the full
  // download branch — strict check is conservative in the right direction.
  if (existsSync(folderPath)) {
    const entries = readdirSync(folderPath);
    const found: DownloadedDoc[] = [];
    for (const idx of indices) {
      const pattern = new RegExp(`^Doc${idx + 1}-.+\\.pdf$`);
      const match = entries.find((f) => pattern.test(f));
      if (!match) break;
      const filePath = join(folderPath, match);
      found.push({
        index: idx,
        filename: match,
        path: filePath,
        bytes: statSync(filePath).size,
      });
    }
    if (found.length === indices.length) {
      log.warn(msg(`All ${indices.length} PDFs already on disk — skipping re-download`));
      return found;
    }
  }

  await ensureDownloadFolder(folderPath);

  log.step(msg("Locating iDocs PDF viewer for document hash..."));
  const { hash, totalDocs } = await findViewerInfo(page);
  log.step(msg(`iDocs viewer ready: hash=${hash}, totalDocs=${totalDocs}`));

  const saved: DownloadedDoc[] = [];
  for (const idx of indices) {
    if (totalDocs > 0 && idx >= totalDocs) {
      log.error(msg(`Document ${idx + 1} not present (only ${totalDocs} docs on record) — skipping`));
      continue;
    }
    const url = `https://${IDOCS_VIEWER_HOST}${IDOCS_DOC_PATH}?i=${idx}&h=${hash}`;
    log.step(msg(`Fetching Document ${idx + 1} (i=${idx})...`));
    const response = await page.context().request.get(url);
    if (!response.ok()) {
      throw new Error(`Document ${idx + 1} fetch failed: HTTP ${response.status()}`);
    }
    const body = await response.body();
    const fallback = `document-${idx + 1}.pdf`;
    const filename = parseFilenameFromHeader(response.headers()["content-disposition"] ?? null, fallback);
    const savedName = `Doc${idx + 1}-${filename}`;
    const savedPath = join(folderPath, savedName);
    await writeFile(savedPath, body);
    log.step(msg(`Document ${idx + 1} saved: ${savedPath} (${body.length} bytes)`));
    saved.push({ index: idx, filename: savedName, path: savedPath, bytes: body.length });
  }

  log.success(msg(`CRM document download complete: ${saved.length} file(s)`));
  return saved;
}

export async function downloadCrmDocumentsFromFrame(
  frame: Frame,
  folderPath: string,
  options: { docIndices?: number[]; logPrefix?: string } = {},
): Promise<DownloadedDoc[]> {
  return downloadCrmDocuments(frame.page(), folderPath, options);
}
