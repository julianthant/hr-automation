import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { transaction, type Database } from "../../infra/sqlite/index.js";

import { renderPdfPagesToPngs } from "../../services/ocr/render-pages.js";
import { isFileAttachmentId } from "./file-id.js";

const PDF_PAGE_RENDER_VERSION = 2;

export interface EnsurePdfPageCacheOpts {
  trackerDir: string;
  fileId: string;
  pdfPath: string;
  render?: (pdfPath: string, outDir: string) => Promise<string[]>;
}

export interface CachedPage {
  fileId: string;
  page: number;
  status: "pending" | "ready" | "failed";
  imagePath?: string;
  mimeType?: string;
  bytes?: number;
  error?: string;
}

function cacheDir(trackerDir: string, fileId: string): string {
  if (!isFileAttachmentId(fileId)) throw new Error(`invalid file attachment id: ${fileId}`);
  const root = resolve(trackerDir, "pdf-cache");
  const candidate = resolve(root, fileId);
  if (!candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`PDF cache path escaped tracker root: ${fileId}`);
  }
  return candidate;
}

const inFlightRenders = new Map<string, Promise<CachedPage[]>>();

function pageNumberFromFilename(filename: string): number | null {
  const m = /^page-(\d+)\.png$/.exec(filename);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function ensurePdfPageCache(
  db: Database,
  opts: EnsurePdfPageCacheOpts,
): Promise<CachedPage[]> {
  if (!isFileAttachmentId(opts.fileId)) {
    throw new Error(`invalid file attachment id: ${opts.fileId}`);
  }
  const key = `${opts.trackerDir}\0${opts.fileId}\0${opts.pdfPath}`;
  const inFlight = inFlightRenders.get(key);
  if (inFlight) return inFlight;
  const promise = ensurePdfPageCacheInner(db, opts);
  inFlightRenders.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightRenders.delete(key);
  }
}

async function ensurePdfPageCacheInner(
  db: Database,
  opts: EnsurePdfPageCacheOpts,
): Promise<CachedPage[]> {
  const existing = db.prepare(`
    SELECT file_id, page, status, image_path, mime_type, bytes, error
    FROM file_pages
    WHERE file_id = ? AND render_version = ? AND status = 'ready'
    ORDER BY page
  `).all(opts.fileId, PDF_PAGE_RENDER_VERSION) as Array<{
    file_id: string;
    page: number;
    status: "ready";
    image_path: string;
    mime_type: string;
    bytes: number;
    error: string | null;
  }>;
  if (existing.length > 0 && existing.every((p) => p.image_path && existsSync(p.image_path))) {
    return existing.map((p) => ({
      fileId: p.file_id,
      page: p.page,
      status: p.status,
      imagePath: p.image_path,
      mimeType: p.mime_type,
      bytes: p.bytes,
      error: p.error ?? undefined,
    }));
  }

  const outDir = cacheDir(opts.trackerDir, opts.fileId);
  await mkdir(outDir, { recursive: true });
  const render = opts.render ?? ((pdfPath, outDir) => renderPdfPagesToPngs(pdfPath, outDir, { pad: 3 }));
  const filenames = await render(opts.pdfPath, outDir);
  const now = new Date().toISOString();
  if (filenames.length === 0) {
    db.prepare(`
      INSERT INTO file_pages (file_id, page, render_version, status, error, created_at, updated_at)
      VALUES (?, 1, ?, 'failed', 'PDF render returned no pages', ?, ?)
      ON CONFLICT(file_id, page, render_version) DO UPDATE SET
        status = 'failed',
        error = excluded.error,
        updated_at = excluded.updated_at
    `).run(opts.fileId, PDF_PAGE_RENDER_VERSION, now, now);
    return [{ fileId: opts.fileId, page: 1, status: "failed", error: "PDF render returned no pages" }];
  }

  const upsert = db.prepare(`
    INSERT INTO file_pages (
      file_id, page, render_version, status, image_path, mime_type, bytes, created_at, updated_at
    ) VALUES (
      @fileId, @page, @renderVersion, 'ready', @imagePath, 'image/png', @bytes, @createdAt, @updatedAt
    )
    ON CONFLICT(file_id, page, render_version) DO UPDATE SET
      status = 'ready',
      image_path = excluded.image_path,
      mime_type = excluded.mime_type,
      bytes = excluded.bytes,
      error = NULL,
      updated_at = excluded.updated_at
  `);
  const pages: CachedPage[] = [];
  transaction(db, () => {
    for (const filename of filenames) {
      const page = pageNumberFromFilename(filename);
      if (!page) continue;
      const imagePath = join(outDir, filename);
      const bytes = statSync(imagePath).size;
      upsert.run({
        fileId: opts.fileId,
        page,
        renderVersion: PDF_PAGE_RENDER_VERSION,
        imagePath,
        bytes,
        createdAt: now,
        updatedAt: now,
      });
      pages.push({ fileId: opts.fileId, page, status: "ready", imagePath, mimeType: "image/png", bytes });
    }
  });
  return pages;
}

export function getCachedPage(
  db: Database,
  fileId: string,
  page: number,
): CachedPage | null {
  if (!isFileAttachmentId(fileId)) return null;
  if (!Number.isInteger(page) || page < 1 || page > 9999) return null;
  const row = db.prepare(`
    SELECT file_id, page, status, image_path, mime_type, bytes, error
    FROM file_pages
    WHERE file_id = ? AND page = ? AND render_version = ?
  `).get(fileId, page, PDF_PAGE_RENDER_VERSION) as {
    file_id: string;
    page: number;
    status: "pending" | "ready" | "failed";
    image_path: string | null;
    mime_type: string | null;
    bytes: number | null;
    error: string | null;
  } | undefined;
  if (!row) return null;
  return {
    fileId: row.file_id,
    page: row.page,
    status: row.status,
    imagePath: row.image_path ?? undefined,
    mimeType: row.mime_type ?? undefined,
    bytes: row.bytes ?? undefined,
    error: row.error ?? undefined,
  };
}
