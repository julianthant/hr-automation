import { basename } from "node:path";
import { existsSync } from "node:fs";
import type { Hono } from "hono";

import { getRegisteredFile } from "../../../files.js";
import { getCachedPage } from "../../../pdf-cache.js";
import type { DashboardHonoDeps } from "../context.js";
import { streamFileResponse, textResponse } from "../responses.js";

export function registerFileRoutes(app: Hono, deps: DashboardHonoDeps): void {
  app.get("/api/files/:fileId/download", (c) => {
    const file = getRegisteredFile(deps.stateDb, c.req.param("fileId"));
    if (!file || !existsSync(file.storagePath)) return textResponse("not found", 404);
    return streamFileResponse(file.storagePath, {
      contentType: file.mimeType,
      cacheControl: "no-store",
      disposition: `attachment; filename="${basename(file.originalName).replace(/"/g, "")}"`,
    });
  });

  app.get("/api/files/:fileId/original", (c) => {
    const file = getRegisteredFile(deps.stateDb, c.req.param("fileId"));
    if (!file || !existsSync(file.storagePath)) return textResponse("not found", 404);
    return streamFileResponse(file.storagePath, {
      contentType: file.mimeType,
      cacheControl: "no-store",
    });
  });

  app.get("/api/files/:fileId/pages/:page", (c) => {
    const page = Number(c.req.param("page"));
    const cached = getCachedPage(deps.stateDb, c.req.param("fileId"), page);
    if (!cached || cached.status !== "ready" || !cached.imagePath || !existsSync(cached.imagePath)) {
      return textResponse("not found", 404);
    }
    return streamFileResponse(cached.imagePath, {
      contentType: cached.mimeType ?? "image/png",
      cacheControl: "public, max-age=31536000, immutable",
    });
  });
}
