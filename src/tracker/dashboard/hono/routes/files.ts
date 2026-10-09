import { basename } from "node:path";
import { existsSync } from "node:fs";
import type { Hono } from "hono";

import { getRegisteredFile } from "../../../files/files.js";
import { ensurePdfPageCache, getCachedPage } from "../../../files/pdf-cache.js";
import type { DashboardHonoDeps } from "../context.js";
import { streamFileResponse, textResponse } from "../responses.js";

/**
 * Build a safe Content-Disposition header value for file downloads.
 *
 * Two-form per RFC 6266 / RFC 5987:
 * - filename="..."  ASCII-safe fallback: strips control chars (\x00-\x1f),
 *   double-quote, backslash, and non-ASCII to prevent CRLF header injection
 *   and encoding issues in legacy clients.
 * - filename*=UTF-8''... RFC 5987 percent-encoded form for the original name,
 *   preserving Unicode for modern clients.
 */
function buildContentDisposition(originalName: string): string {
  const base = basename(originalName);
  const safeAscii = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f"\\]/g, "_") // strip control chars + quotes + backslash
    .replace(/[^\x20-\x7e]/g, "_"); // strip non-ASCII
  const utf8Encoded = encodeURIComponent(base);
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${utf8Encoded}`;
}

function parsePdfPageParam(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const page = Number(raw);
  if (!Number.isInteger(page) || page < 1 || page > 9999) return null;
  return page;
}

export function registerFileRoutes(app: Hono, deps: DashboardHonoDeps): void {
  app.get("/api/files/:fileId/download", async (c) => {
    const file = getRegisteredFile(deps.stateDb, c.req.param("fileId"));
    if (!file || !existsSync(file.storagePath)) return textResponse("not found", 404);
    return await streamFileResponse(file.storagePath, {
      contentType: file.mimeType,
      cacheControl: "no-store",
      disposition: buildContentDisposition(file.originalName),
    });
  });

  app.get("/api/files/:fileId/original", async (c) => {
    const file = getRegisteredFile(deps.stateDb, c.req.param("fileId"));
    if (!file || !existsSync(file.storagePath)) return textResponse("not found", 404);
    return await streamFileResponse(file.storagePath, {
      contentType: file.mimeType,
      cacheControl: "no-store",
    });
  });

  app.get("/api/files/:fileId/pages/:page", async (c) => {
    const page = parsePdfPageParam(c.req.param("page"));
    if (page === null) return textResponse("invalid page", 400);
    const fileId = c.req.param("fileId");
    const file = getRegisteredFile(deps.stateDb, fileId);
    if (!file || !existsSync(file.storagePath)) return textResponse("not found", 404);
    let cached = getCachedPage(deps.stateDb, fileId, page);
    if (!cached || cached.status !== "ready" || !cached.imagePath || !existsSync(cached.imagePath)) {
      await ensurePdfPageCache(deps.stateDb, {
        trackerDir: deps.dir,
        fileId,
        pdfPath: file.storagePath,
      });
      cached = getCachedPage(deps.stateDb, fileId, page);
    }
    if (!cached || cached.status !== "ready" || !cached.imagePath || !existsSync(cached.imagePath)) {
      return textResponse("not found", 404);
    }
    return await streamFileResponse(cached.imagePath, {
      contentType: cached.mimeType ?? "image/png",
      cacheControl: "public, max-age=31536000, immutable",
    });
  });
}
