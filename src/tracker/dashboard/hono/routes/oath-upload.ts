import { createHash, randomUUID } from "node:crypto";
import type { Hono } from "hono";

import {
  buildOathUploadCancelHandler,
  buildOathUploadDuplicateCheckHandler,
  buildOathUploadStartHandler,
  saveUploadedPdf,
} from "../../oath-upload/http.js";
import { registerLocalFile } from "../../../files/files.js";
import { ensurePdfPageCache } from "../../../files/pdf-cache.js";
import { getProjectionDb, type DashboardHonoDeps } from "../context.js";
import { readMultipartRequest } from "../multipart.js";
import { oathUploadCancelBody, readValidatedJson } from "../request-schemas.js";
import { jsonResponse } from "../responses.js";

export function registerOathUploadRoutes(app: Hono, deps: DashboardHonoDeps): void {
  const handlers = {
    duplicateCheck: buildOathUploadDuplicateCheckHandler({ trackerDir: deps.dir }),
    start: buildOathUploadStartHandler({ trackerDir: deps.dir }),
    cancel: buildOathUploadCancelHandler({ trackerDir: deps.dir }),
  };

  app.get("/api/oath-upload/check-duplicate", async (c) => {
    const hash = c.req.query("hash") ?? "";
    const lookbackDays = c.req.query("lookbackDays")
      ? Number(c.req.query("lookbackDays"))
      : undefined;
    const result = await handlers.duplicateCheck({ hash, lookbackDays });
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/oath-upload/cancel", async (c) => {
    const parsed = await readValidatedJson(c.req.raw, oathUploadCancelBody);
    if (!parsed.ok) return parsed.response;
    const result = await handlers.cancel(parsed.body);
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/oath-upload/start", async (c) => {
    const multipart = await readMultipartRequest(c.req.raw, 50 * 1024 * 1024);
    if (!multipart.ok) return jsonResponse({ ok: false, error: multipart.error }, 400);
    const file = multipart.parsed.files.pdf;
    if (!file) return jsonResponse({ ok: false, error: "missing 'pdf' file part" }, 400);

    const pdfOriginalName = file.filename ?? "upload.pdf";
    const pdfPath = await saveUploadedPdf(file.data, pdfOriginalName, deps.dir);
    const pdfHash = createHash("sha256").update(file.data).digest("hex");
    const sessionId = multipart.parsed.fields.sessionId?.trim() || randomUUID();
    // Resolve the projection DB handle per-request (mirrors the OCR route — see
    // ocr.ts and context.ts:getProjectionDb). The cached `deps.stateDb` can
    // outlive a `.tracker/state.db` delete/recreate or a `controlDb.close()`
    // call from `watch-child-runs`; using it directly throws "database is not
    // open" on the next write, which Hono surfaces as a plain-text 500.
    const stateDb = getProjectionDb(deps);
    const registered = stateDb
      ? registerLocalFile(stateDb, {
          trackerDir: deps.dir,
          kind: "pdf",
          mimeType: "application/pdf",
          path: pdfPath,
          originalName: pdfOriginalName,
          source: "oath-upload",
          workflow: "oath-upload",
          itemId: sessionId,
        })
      : null;
    if (registered && stateDb) {
      void ensurePdfPageCache(stateDb, {
        trackerDir: deps.dir,
        fileId: registered.fileId,
        pdfPath,
      }).catch(() => undefined);
    }

    // `rosterMode`/`rosterPath` parsing was removed (E2E-006): the start
    // handler 400s full mode (full runs go via /api/ocr/prepare, which owns
    // roster choice), upload-only never uses a roster, and the old resolution
    // scanned the REAL .tracker (no deps.dir) picking a lexicographic-latest
    // file. The oath-upload input schema no longer carries the fields.
    const mode = (multipart.parsed.fields.mode?.trim() ?? "full") as "full" | "upload-only";
    const dryRun = multipart.parsed.fields.dryRun === "true" || multipart.parsed.fields.dryRun === "1";

    const result = await handlers.start({
      pdfPath,
      pdfOriginalName,
      pdfFileId: registered?.fileId,
      pdfHash,
      sessionId,
      mode,
      dryRun,
    });
    return jsonResponse(result.body, result.status);
  });
}
