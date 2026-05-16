import type { Page } from "playwright";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { log } from "../../utils/log.js";
import { tryRegisterDownloadedFile } from "../../tracker/files/register-download.js";

const IDOCS_VIEWER_HOST = "crickportal-ext.bfs.ucsd.edu";
const IDOCS_VIEWER_PATH = "/iDocsForSalesforce/Content/pdfjs/web/PDFjsViewer.aspx";
const IDOCS_DOC_PATH = "/iDocsForSalesforce/iDocsForSalesforceDocumentServer";

export const DEFAULT_CRM_DOC_INDICES = [0, 2] as const;

export interface CrmDocumentDownloadSubject {
  firstName: string;
  lastName: string;
  middleName?: string | null;
}

export interface DownloadedCrmDocument {
  index: number;
  filename: string;
  path: string;
  bytes: number;
}

export interface CrmIdocsDownloadOptions {
  docIndices?: readonly number[];
  logPrefix?: string;
  workflow?: string;
  itemId?: string;
  runId?: string;
  parentRunId?: string;
  trackerDir?: string;
}

interface ViewerInfo {
  hash: string;
  totalDocs: number;
}

export function buildCrmDocumentDownloadPath(subject: CrmDocumentDownloadSubject): string {
  const downloads = join(homedir(), "Downloads");
  const middle = subject.middleName ? ` ${subject.middleName}` : "";
  const folderName = `${subject.lastName}, ${subject.firstName}${middle} EID`;
  return join(downloads, "onboarding", folderName);
}

export async function ensureCrmDocumentDownloadFolder(folderPath: string): Promise<void> {
  await mkdir(folderPath, { recursive: true });
  log.step(`Download folder ready: ${folderPath}`);
}

const RESERVED_FILENAME_CHARS = new Set('<>:"/\\|?*'.split(""));
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

async function findCrmIdocsViewerInfo(page: Page, timeoutMs = 30_000): Promise<ViewerInfo> {
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

export async function downloadCrmIdocsDocuments(
  page: Page,
  folderPath: string,
  options: CrmIdocsDownloadOptions = {},
): Promise<DownloadedCrmDocument[]> {
  const p = options.logPrefix;
  const msg = (s: string) => (p ? `${p} ${s}` : s);
  const indices = options.docIndices ?? DEFAULT_CRM_DOC_INDICES;

  if (existsSync(folderPath)) {
    const entries = readdirSync(folderPath);
    const found: DownloadedCrmDocument[] = [];
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
      log.warn(msg(`All ${indices.length} PDFs already on disk -- skipping re-download`));
      return found;
    }
  }

  await ensureCrmDocumentDownloadFolder(folderPath);

  log.step(msg("Locating iDocs PDF viewer for document hash..."));
  const { hash, totalDocs } = await findCrmIdocsViewerInfo(page);
  log.step(msg(`iDocs viewer ready: totalDocs=${totalDocs}`));

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

    const filename = sanitizeCrmDocumentFilename(
      parseCrmDocumentFilename(headers["content-disposition"] ?? null, `document-${idx + 1}.pdf`),
      `document-${idx + 1}.pdf`,
    );
    const savedName = `Doc${idx + 1}-${filename}`;
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
