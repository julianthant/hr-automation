import type { DashboardRoute } from "../route-types.js";
import { readJsonBody, writeJson } from "../http.js";
import { errorMessage } from "../../../utils/errors.js";
import {
  buildSharePointRosterDownloadHandler,
  buildSharePointListHandler,
  getSharePointDownloadStatus,
} from "../../../workflows/sharepoint-download/index.js";

export function createSharePointRoutes(): DashboardRoute {
  return async (req, res, url) => {
    if (
      req.method === "GET" &&
      url.pathname === "/api/sharepoint-download/list"
    ) {
      const list = buildSharePointListHandler()();
      writeJson(res, 200, list);
      return true;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/sharepoint-download/status"
    ) {
      writeJson(res, 200, getSharePointDownloadStatus());
      return true;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/sharepoint-download/run"
    ) {
      const handler = buildSharePointRosterDownloadHandler();
      try {
        const parsed = await readJsonBody(req, 4096);
        if (!parsed.ok) {
          if (parsed.error === "Invalid JSON body") {
            writeJson(res, 400, { ok: false, error: "Invalid JSON body" });
          } else {
            writeJson(res, 500, { ok: false, error: parsed.error });
          }
          return true;
        }
        const { status, body } = await handler(parsed.body as { id?: string });
        writeJson(res, status, body);
      } catch (e) {
        writeJson(res, 500, { ok: false, error: errorMessage(e) });
      }
      return true;
    }

    return false;
  };
}
