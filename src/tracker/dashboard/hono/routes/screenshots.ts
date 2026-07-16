import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Hono } from "hono";

import {
  SCREENSHOTS_DIR,
  buildScreenshotsHandler,
  resolveScreenshotPath,
} from "../../screenshots.js";
import type { DashboardHonoDeps } from "../context.js";
import { getDefaultWorkflow } from "../context.js";
import { jsonResponse, streamFileResponse, textResponse } from "../responses.js";

export function registerScreenshotRoutes(app: Hono, deps: DashboardHonoDeps): void {
  const screenshotsDir = deps.screenshotsDir ?? SCREENSHOTS_DIR;

  app.get("/api/screenshots", async (c) => {
    const workflow = c.req.query("workflow") ?? getDefaultWorkflow(deps);
    const id = c.req.query("itemId") ?? c.req.query("id") ?? "";
    const runId = c.req.query("runId")?.trim() || undefined;
    const trackerDate = c.req.query("date")?.trim() || undefined;
    if (!workflow || !id) return jsonResponse([]);
    try {
      const groupedHandler = buildScreenshotsHandler({ dir: deps.dir, screenshotsDir });
      return jsonResponse(await groupedHandler({ workflow, itemId: id, runId, trackerDate }));
    } catch {
      return jsonResponse([]);
    }
  });

  app.get("/api/prep/pdf-page", async (c) => {
    const workflow = c.req.query("workflow") ?? "";
    const parentRunId = c.req.query("parentRunId") ?? "";
    const page = Number.parseInt(c.req.query("page") ?? "0", 10);

    if (!/^[a-z0-9-]+$/.test(workflow) || workflow.length > 64) {
      return textResponse("invalid workflow", 400);
    }
    if (!/^[A-Za-z0-9._@#-]+$/.test(parentRunId) || parentRunId.length > 256) {
      return textResponse("invalid parentRunId", 400);
    }
    if (!Number.isFinite(page) || page < 1 || page > 9999) {
      return textResponse("invalid page", 400);
    }

    const trackerRoot = resolve(deps.dir);
    const filename = `page-${String(page).padStart(2, "0")}.png`;
    const candidates = [
      resolve(trackerRoot, "uploads", parentRunId, filename),
      resolve(trackerRoot, "page-images", parentRunId, filename),
    ];
    const safeBaseUploads = resolve(trackerRoot, "uploads", parentRunId);
    const safeBasePageImages = resolve(trackerRoot, "page-images", parentRunId);
    if (
      !candidates[0].startsWith(safeBaseUploads + sep) ||
      !candidates[1].startsWith(safeBasePageImages + sep)
    ) {
      return textResponse("path traversal", 400);
    }

    const foundPath = candidates.find((candidate) => existsSync(candidate));
    if (!foundPath) return textResponse("not found", 404);
    return await streamFileResponse(foundPath, {
      contentType: "image/png",
      cacheControl: "public, max-age=31536000, immutable",
    });
  });

  app.get("/screenshots/:filename", async (c) => {
    const filename = c.req.param("filename");
    const resolved = resolveScreenshotPath(filename, screenshotsDir);
    if (!resolved) return textResponse("Not found", 404);
    try {
      return await streamFileResponse(resolved, {
        contentType: "image/png",
        cacheControl: "no-cache",
      });
    } catch {
      return textResponse("Error reading file", 500);
    }
  });
}
