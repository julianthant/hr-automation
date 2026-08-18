import type { Page } from "playwright";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import { basename, join } from "node:path";
import { PATHS } from "../../config.js";
import { log } from "../../utils/log.js";
import { tryRegisterDownloadedFile } from "../../tracker/files/register-download.js";
import { titleCasePersonToken } from "../../domain/identity/person-name.js";

const IDOCS_VIEWER_HOST = "crickportal-ext.bfs.ucsd.edu";
const IDOCS_VIEWER_PATH = "/iDocsForSalesforce/Content/pdfjs/web/PDFjsViewer.aspx";
const IDOCS_DOC_PATH = "/iDocsForSalesforce/iDocsForSalesforceDocumentServer";

export const DEFAULT_CRM_DOC_INDICES = [0, 2] as const;

/**
 * Position-based default names for the CRM onboarding documents. The iDocs
 * document server rarely sends a usable Content-Disposition filename, so the
 * downloaded file falls back to the document's known identity by position:
 * doc 1 (index 0) is the signed offer letter, doc 3 (index 2) is the EE data
 * gathering form. Indices without a known identity fall back to `document-N`.
 */
export const CRM_DOC_DEFAULT_NAMES: Readonly<Record<number, string>> = {
  0: "Signed Offer Letter",
  2: "EE Data Gathering Form",
};

/** Fallback filename (with `.pdf`) used when CRM sends no usable filename. */
export function defaultCrmDocumentName(index: number): string {
  return `${CRM_DOC_DEFAULT_NAMES[index] ?? `document-${index + 1}`}.pdf`;
}

export interface CrmDocumentDownloadSubject {
  firstName: string;
  lastName: string;
  middleName?: string | null;
  /** UCSD lived/preferred name, rendered parenthetically when present. */
  livedName?: string | null;
}

export interface DownloadedCrmDocument {
  index: number;
  filename: string;
  path: string;
  bytes: number;
}

export interface CrmDocumentArchive {
  /** Absolute path to the written `.zip`. */
  path: string;
  /** `Last, First Middle EID.zip`. */
  filename: string;
  bytes: number;
  /** Names of the documents inside, in archive order. */
  entries: string[];
}

export interface CrmIdocsDownloadOptions {
  docIndices?: readonly number[];
  logPrefix?: string;
  workflow?: string;
  itemId?: string;
  runId?: string;
  parentRunId?: string;
  trackerDir?: string;
  /**
   * Viewer hash captured EARLIER, while the CRM record page was still open.
   *
   * The iDocs PDF.js iframe only exists on the onboarding RECORD page. Callers
   * that navigate away before downloading (onboarding navigates to the UCPath
   * Entry Sheet via a full `page.goto`, which tears the iframe down) must
   * capture this with `readCrmIdocsViewerInfo` while the record page is still
   * loaded and pass it here. When omitted, the hash is discovered from the
   * current page as before.
   *
   * Only hash DISCOVERY needs the record page — the document fetch itself is a
   * cookie-authenticated `request.get()` that is independent of what the page
   * is currently showing.
   */
  viewerInfo?: CrmIdocsViewerInfo;
}

export interface CrmIdocsViewerInfo {
  hash: string;
  totalDocs: number;
}

/**
 * The per-person onboarding folder NAME (no directory), formatted as
 * `Last, First (Lived) Middle EID`. The lived-name parenthetical and the
 * middle name are each included only when present. "EID" is a literal trailing
 * token (the operator's onboarding-folder convention), NOT the numeric employee
 * id — a pre-hire often has none yet.
 */
export function buildCrmDocumentFolderName(subject: CrmDocumentDownloadSubject): string {
  // CRM stores some records fully capitalised ("ALI ALNASSER") and others in
  // ordinary case ("Jaden Campos"), so the raw values produce inconsistent
  // folder names. Title-case every name component so the output is uniform —
  // `Alnasser, Ali Anwar EID`, never `ALNASSER, ALI ANWAR EID` (2026-08-18).
  const tc = (value: string): string =>
    value.trim().split(/\s+/).filter(Boolean).map(titleCasePersonToken).join(" ");
  const livedRaw = subject.livedName?.trim();
  const middleRaw = subject.middleName?.trim();
  const lived = livedRaw ? ` (${tc(livedRaw)})` : "";
  const middle = middleRaw ? ` ${tc(middleRaw)}` : "";
  const raw = `${tc(subject.lastName)}, ${tc(subject.firstName)}${lived}${middle} EID`;
  return sanitizeOnboardingFolderName(raw);
}

/**
 * Absolute path to the per-person onboarding folder under
 * `PATHS.onboardingDocsDir` (`data/onboarding` by default).
 */
export function buildCrmDocumentDownloadPath(subject: CrmDocumentDownloadSubject): string {
  return join(PATHS.onboardingDocsDir, buildCrmDocumentFolderName(subject));
}

/**
 * Make a name safe to use as a single path segment: drop reserved path
 * characters (incl. separators) and collapse the resulting whitespace. A name
 * like `O'Brien` survives unchanged; a stray `/` does not become a subdir.
 */
export function sanitizeOnboardingFolderName(name: string): string {
  return name
    .split("")
    .filter((ch) => !RESERVED_FILENAME_CHARS.has(ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export async function ensureCrmDocumentDownloadFolder(folderPath: string): Promise<void> {
  await mkdir(folderPath, { recursive: true });
  log.step(`Download folder ready: ${folderPath}`);
}

const RESERVED_FILENAME_CHARS = new Set('<>:"/\\|?*'.split(""));
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Read the iDocs PDF.js viewer hash + document count off the CRM ONBOARDING
 * RECORD page.
 *
 * MUST be called while the record page is open. The viewer is a Salesforce
 * Canvas iframe that only exists there; any full navigation away (e.g.
 * `navigateToSection` -> UCPath Entry Sheet) destroys it, after which this
 * throws. Capture the result and hand it to `downloadCrmIdocsDocuments` via
 * `options.viewerInfo` when the download happens later in the run.
 *
 * verified 2026-08-18
 */
export async function readCrmIdocsViewerInfo(page: Page, timeoutMs = 30_000): Promise<CrmIdocsViewerInfo> {
  return findCrmIdocsViewerInfo(page, timeoutMs);
}

async function findCrmIdocsViewerInfo(page: Page, timeoutMs = 30_000): Promise<CrmIdocsViewerInfo> {
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
  // Name what we DID see. The overwhelmingly common cause is being on the wrong
  // page (the viewer iframe lives only on the onboarding record page), and a
  // bare timeout message hid that for a long time.
  const seen = page.frames().map((f) => f.url()).filter(Boolean);
  throw new Error(
    `iDocs PDF.js viewer did not load within ${timeoutMs}ms. `
    + `Current page: ${page.url()}. `
    + `Expected an iframe on ${IDOCS_VIEWER_HOST}${IDOCS_VIEWER_PATH}; `
    + `saw ${seen.length} frame(s): ${seen.slice(0, 8).join(" | ") || "<none>"}. `
    + `If the run already navigated off the record page, capture the hash there with `
    + `readCrmIdocsViewerInfo() and pass it as options.viewerInfo.`,
  );
}

export function parseCrmDocumentFilename(header: string | null, fallback: string): string {
  if (!header) return fallback;

  const params = parseContentDispositionParams(header);
  const encoded = params.get("filename*");
  if (encoded) {
    const value = decodeRfc5987Filename(encoded);
    if (value) return value;
  }

  const filename = params.get("filename");
  if (!filename) return fallback;
  try {
    return decodeURIComponent(filename);
  } catch {
    return filename;
  }
}

export function sanitizeCrmDocumentFilename(filename: string, fallback: string): string {
  const base = basename(filename.replace(/\\/g, "/"));
  const sanitized = base
    .split("")
    .map((char) => RESERVED_FILENAME_CHARS.has(char) || char.charCodeAt(0) <= 31 ? "_" : char)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. ]+|[. ]+$/g, "");
  if (!sanitized || RESERVED_WINDOWS_NAMES.test(sanitized)) {
    return sanitizeCrmDocumentFilename(fallback, "document.pdf");
  }
  return sanitized;
}

export function isCrmPdfResponse(headers: Record<string, string>, body: Buffer): boolean {
  if (looksLikeHtml(body)) return false;
  const contentType = headers["content-type"] ?? headers["Content-Type"] ?? "";
  return /\bapplication\/pdf\b/i.test(contentType) || hasPdfMagicBytes(body);
}

function parseContentDispositionParams(header: string): Map<string, string> {
  const params = new Map<string, string>();
  let index = 0;
  while (index < header.length) {
    while (index < header.length && (header[index] === ";" || /\s/.test(header[index]))) index++;

    const keyStart = index;
    while (index < header.length && header[index] !== "=" && header[index] !== ";") index++;
    if (index >= header.length || header[index] !== "=") {
      while (index < header.length && header[index] !== ";") index++;
      continue;
    }

    const key = header.slice(keyStart, index).trim().toLowerCase();
    index++;

    let value = "";
    if (header[index] === '"') {
      index++;
      while (index < header.length) {
        const char = header[index];
        if (char === "\\" && index + 1 < header.length) {
          value += header[index + 1];
          index += 2;
          continue;
        }
        if (char === '"') {
          index++;
          break;
        }
        value += char;
        index++;
      }
    } else {
      const valueStart = index;
      while (index < header.length && header[index] !== ";") index++;
      value = header.slice(valueStart, index).trim();
    }

    if (key) params.set(key, value);
  }
  return params;
}

function decodeRfc5987Filename(value: string): string | null {
  const match = value.match(/^([^']*)'[^']*'(.*)$/);
  const encoded = match ? match[2] : value;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded || null;
  }
}

function hasPdfMagicBytes(body: Buffer): boolean {
  return body.subarray(0, 5).toString("latin1") === "%PDF-";
}

function looksLikeHtml(body: Buffer): boolean {
  const prefix = body.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return prefix.startsWith("<!doctype html") || prefix.startsWith("<html");
}

/**
 * Pack the per-person document folder into a sibling `.zip` and REMOVE the
 * folder, so `data/onboarding/` holds one archive per person rather than a
 * directory tree (operator preference, 2026-08-18).
 *
 * The archive is named after the folder (`Alnasser, Ali Anwar EID.zip`) and
 * stores the documents at the archive ROOT — unzipping yields the PDFs
 * directly, not a nested folder.
 *
 * Throws if the archive would be empty; an empty zip beside a deleted folder
 * would be silent data loss.
 */
export async function zipCrmDocumentFolder(
  folderPath: string,
  documents: readonly DownloadedCrmDocument[],
): Promise<CrmDocumentArchive> {
  if (documents.length === 0) {
    throw new Error(`Refusing to zip ${folderPath}: no documents were saved.`);
  }

  const zip = new JSZip();
  const entries: string[] = [];
  for (const doc of documents) {
    zip.file(doc.filename, await readFile(doc.path));
    entries.push(doc.filename);
  }

  const zipPath = `${folderPath}.zip`;
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await writeFile(zipPath, buffer);
  await rm(folderPath, { recursive: true, force: true });

  log.success(`Zipped ${entries.length} document(s) -> ${zipPath} (${buffer.length} bytes)`);
  return {
    path: zipPath,
    filename: basename(zipPath),
    bytes: buffer.length,
    entries,
  };
}

export async function downloadCrmIdocsDocuments(
  page: Page,
  folderPath: string,
  options: CrmIdocsDownloadOptions = {},
): Promise<DownloadedCrmDocument[]> {
  const p = options.logPrefix;
  const msg = (s: string) => (p ? `${p} ${s}` : s);
  const indices = options.docIndices ?? DEFAULT_CRM_DOC_INDICES;

  // Already-archived check. Since 2026-08-18 a completed download is a sibling
  // `.zip` (the folder is removed), so the presence of that archive — not loose
  // PDFs — is what "already done" looks like.
  if (existsSync(`${folderPath}.zip`)) {
    log.warn(msg(`Archive already on disk (${folderPath}.zip) -- skipping re-download`));
    return [];
  }

  if (existsSync(folderPath)) {
    const entries = readdirSync(folderPath);
    const found: DownloadedCrmDocument[] = [];
    for (const idx of indices) {
      const expected = CRM_DOC_DEFAULT_NAMES[idx] ? `${CRM_DOC_DEFAULT_NAMES[idx]}.pdf` : null;
      const match = expected
        ? entries.find((f) => f === expected)
        : entries.find((f) => new RegExp(`^Doc${idx + 1}-.+\\.pdf$`).test(f));
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
      log.warn(msg(`All ${indices.length} PDFs already on disk -- skipping re-download`));
      return found;
    }
  }

  await ensureCrmDocumentDownloadFolder(folderPath);

  let hash: string;
  let totalDocs: number;
  if (options.viewerInfo) {
    // Hash captured on the record page earlier in the run — no frame lookup
    // needed, and the current page is irrelevant to the fetches below.
    ({ hash, totalDocs } = options.viewerInfo);
    log.step(msg(`iDocs viewer hash supplied by caller: totalDocs=${totalDocs}`));
  } else {
    log.step(msg("Locating iDocs PDF viewer for document hash..."));
    ({ hash, totalDocs } = await findCrmIdocsViewerInfo(page));
    log.step(msg(`iDocs viewer ready: totalDocs=${totalDocs}`));
  }

  const saved: DownloadedCrmDocument[] = [];
  for (const idx of indices) {
    if (totalDocs > 0 && idx >= totalDocs) {
      log.error(msg(`Document ${idx + 1} not present (only ${totalDocs} docs on record) -- skipping`));
      continue;
    }

    const url = `https://${IDOCS_VIEWER_HOST}${IDOCS_DOC_PATH}?i=${idx}&h=${hash}`;
    log.step(msg(`Fetching Document ${idx + 1} (i=${idx})...`));
    const response = await page.context().request.get(url);
    if (!response.ok()) {
      throw new Error(`Document ${idx + 1} fetch failed: HTTP ${response.status()}`);
    }

    const body = await response.body();
    const headers = response.headers();
    if (!isCrmPdfResponse(headers, body)) {
      throw new Error(`Document ${idx + 1} fetch did not return a PDF`);
    }

    // CRM's Content-Disposition name is an opaque internal id
    // ("iDocs-2026-6-49682.pdf") that tells the operator nothing. The document's
    // IDENTITY is its position on the record, which `CRM_DOC_DEFAULT_NAMES`
    // already encodes — so name the file that (2026-08-18). Only a position with
    // no known identity falls back to the CRM-supplied name.
    const fallbackName = defaultCrmDocumentName(idx);
    const canonical = CRM_DOC_DEFAULT_NAMES[idx];
    const filename = canonical
      ? `${canonical}.pdf`
      : sanitizeCrmDocumentFilename(
          parseCrmDocumentFilename(headers["content-disposition"] ?? null, fallbackName),
          fallbackName,
        );
    const savedName = filename;
    const savedPath = join(folderPath, savedName);
    await writeFile(savedPath, body);
    registerDownloadedCrmDocument({
      path: savedPath,
      originalName: savedName,
      workflow: options.workflow ?? "crm-doc-download",
      itemId: options.itemId,
      runId: options.runId,
      parentRunId: options.parentRunId,
      trackerDir: options.trackerDir ?? ".tracker",
    });
    log.step(msg(`Document ${idx + 1} saved: ${savedPath} (${body.length} bytes)`));
    saved.push({ index: idx, filename: savedName, path: savedPath, bytes: body.length });
  }

  if (indices.length > 0 && saved.length === 0) {
    const allSkipped = indices.every((idx) => totalDocs > 0 && idx >= totalDocs);
    throw new Error(
      allSkipped
        ? `No CRM documents saved — every requested document index is out of range for this record (totalDocs=${totalDocs}).`
        : "No CRM documents saved — downloads produced no PDF files.",
    );
  }

  log.success(msg(`CRM document download complete: ${saved.length} file(s)`));
  return saved;
}

function registerDownloadedCrmDocument(input: {
  path: string;
  originalName: string;
  workflow: string;
  itemId?: string;
  runId?: string;
  parentRunId?: string;
  trackerDir: string;
}): void {
  tryRegisterDownloadedFile({ kind: "crm-document", ...input });
}
