import type { Hono } from "hono";

import {
  buildSharePointRosterDownloadHandler,
  buildSharePointListHandler,
  getSharePointDownloadStatus,
} from "../../../../workflows/sharepoint-download/index.js";
import { errorMessage } from "../../../../utils/errors.js";
import { jsonResponse, readJsonRequest } from "../responses.js";

export function registerSharePointRoutes(app: Hono): void {
  app.get("/api/sharepoint-download/list", () => {
    return jsonResponse(buildSharePointListHandler()());
  });

  app.get("/api/sharepoint-download/status", () => {
    return jsonResponse(getSharePointDownloadStatus());
  });

  app.post("/api/sharepoint-download/run", async (c) => {
    const handler = buildSharePointRosterDownloadHandler();
    try {
      const parsed = await readJsonRequest(c.req.raw, 4096);
      if (!parsed.ok) {
        return jsonResponse({ ok: false, error: parsed.error }, 400);
      }
      const { status, body } = await handler(parsed.body);
      return jsonResponse(body, status);
    } catch (err) {
      return jsonResponse({ ok: false, error: errorMessage(err) }, 500);
    }
  });
}
