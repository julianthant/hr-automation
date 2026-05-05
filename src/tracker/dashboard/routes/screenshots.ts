import { stat as statAsync } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { DashboardRoute } from "../route-types.js";
import {
  SCREENSHOTS_DIR,
  buildScreenshotsHandler,
  resolveScreenshotPath,
} from "../screenshots.js";
import { streamPngFile } from "../static-files.js";

export function createScreenshotRoutes(): DashboardRoute {
  return async (_req, res, url, ctx) => {
    const { workflow, dir } = ctx;
    const req = _req;

    if (url.pathname === "/api/screenshots") {
      const wf = url.searchParams.get("workflow") ?? workflow;
      const id = url.searchParams.get("itemId") ?? url.searchParams.get("id") ?? "";
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      if (!wf || !id) {
        res.end(JSON.stringify([]));
        return true;
      }
      try {
        const groupedHandler = buildScreenshotsHandler({ dir, screenshotsDir: SCREENSHOTS_DIR });
        const list = await groupedHandler({ workflow: wf, itemId: id });
        res.end(JSON.stringify(list));
      } catch {
        res.end(JSON.stringify([]));
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/prep/pdf-page") {
      const wf = url.searchParams.get("workflow") ?? "";
      const parentRunId = url.searchParams.get("parentRunId") ?? "";
      const page = parseInt(url.searchParams.get("page") ?? "0", 10);

      if (!/^[a-z0-9-]+$/.test(wf) || wf.length > 64) {
        res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
        res.end("invalid workflow");
        return true;
      }
      if (!/^[A-Za-z0-9._@#-]+$/.test(parentRunId) || parentRunId.length > 256) {
        res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
        res.end("invalid parentRunId");
        return true;
      }
      if (!Number.isFinite(page) || page < 1 || page > 9999) {
        res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
        res.end("invalid page");
        return true;
      }

      const filename = `page-${String(page).padStart(2, "0")}.png`;
      // Two known locations for page images:
      //   - Legacy emergency-contact prep:  .tracker/uploads/<parentRunId>/
      //   - OCR workflow orchestrator:      .tracker/page-images/<sessionId>/
      // The frontend passes parentRunId, but for OCR-workflow rows the
      // sessionId (also passed via parentRunId param for compatibility) keys
      // the page-images dir. Try uploads first, fall back to page-images.
      const candidates = [
        resolve(process.cwd(), ".tracker", "uploads", parentRunId, filename),
        resolve(process.cwd(), ".tracker", "page-images", parentRunId, filename),
      ];
      const safeBaseUploads = resolve(process.cwd(), ".tracker", "uploads", parentRunId);
      const safeBasePageImages = resolve(process.cwd(), ".tracker", "page-images", parentRunId);
      if (
        !candidates[0].startsWith(safeBaseUploads + sep) ||
        !candidates[1].startsWith(safeBasePageImages + sep)
      ) {
        res.writeHead(400, { "Access-Control-Allow-Origin": "*" });
        res.end("path traversal");
        return true;
      }
      let foundPath: string | null = null;
      for (const p of candidates) {
        try {
          await statAsync(p);
          foundPath = p;
          break;
        } catch {
          /* try next */
        }
      }
      if (!foundPath) {
        res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
        res.end("not found");
        return true;
      }
      await streamPngFile(res, foundPath, {
        cacheControl: "public, max-age=31536000, immutable",
      });
      return true;
    }

    if (url.pathname.startsWith("/screenshots/")) {
      const filename = decodeURIComponent(url.pathname.slice("/screenshots/".length));
      const resolved = resolveScreenshotPath(filename);
      if (!resolved) {
        res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
        res.end("Not found");
        return true;
      }
      try {
        await streamPngFile(res, resolved, { cacheControl: "no-cache" });
      } catch {
        res.writeHead(500, { "Access-Control-Allow-Origin": "*" });
        res.end("Error reading file");
      }
      return true;
    }

    return false;
  };
}
