import { existsSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Hono } from "hono";

import {
  buildOathUploadCancelHandler,
  buildOathUploadDuplicateCheckHandler,
  buildOathUploadStartHandler,
  saveUploadedPdf,
} from "../../oath-upload/http.js";
import { registerLocalFile } from "../../../files/files.js";
import { ensurePdfPageCache } from "../../../files/pdf-cache.js";
import type { DashboardHonoDeps } from "../context.js";
import { readMultipartRequest } from "../multipart.js";
import { jsonResponse, readJsonRequest } from "../responses.js";

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
    const parsed = await readJsonRequest(c.req.raw, 4096);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = await handlers.cancel({
      sessionId: String(parsed.body.sessionId ?? ""),
      runId: parsed.body.runId ? String(parsed.body.runId) : undefined,
      reason: parsed.body.reason ? String(parsed.body.reason) : undefined,
    });
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
    const registered = deps.stateDb
      ? registerLocalFile(deps.stateDb, {
          kind: "pdf",
          mimeType: "application/pdf",
          path: pdfPath,
          originalName: pdfOriginalName,
          source: "oath-upload",
          workflow: "oath-upload",
          itemId: sessionId,
        })
      : null;
    if (registered && deps.stateDb) {
      void ensurePdfPageCache(deps.stateDb, {
        trackerDir: deps.dir,
        fileId: registered.fileId,
        pdfPath,
      }).catch(() => undefined);
    }

    const rosterMode = (multipart.parsed.fields.rosterMode?.trim() ?? "download") as "existing" | "download";
    const dryRun = multipart.parsed.fields.dryRun === "true" || multipart.parsed.fields.dryRun === "1";
    let rosterPath: string | undefined;
    if (rosterMode === "existing") {
      const rosterDirs = [
        resolve(process.cwd(), ".tracker/rosters"),
        resolve(process.cwd(), "src/data"),
      ];
      const rosterDir = rosterDirs.find((dir) => existsSync(dir)) ?? rosterDirs[0];
      try {
        const files = readdirSync(rosterDir).filter((fileName) => fileName.endsWith(".xlsx"));
        if (files.length > 0) rosterPath = resolve(rosterDir, files.sort().at(-1)!);
      } catch {
        /* tolerate */
      }
    }

    const result = await handlers.start({
      pdfPath,
      pdfOriginalName,
      pdfFileId: registered?.fileId,
      pdfHash,
      sessionId,
      rosterMode,
      rosterPath,
      dryRun,
    });
    return jsonResponse(result.body, result.status);
  });
}
