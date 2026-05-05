import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DashboardRoute } from "../route-types.js";
import { readJsonBody, writeJson } from "../http.js";
import { readMultipart } from "../../multipart-helper.js";
import {
  buildOcrFormsHandler,
  buildOcrPrepareHandler,
  buildOcrApproveHandler,
  buildOcrDiscardHandler,
  buildOcrForceResearchHandler,
  buildOcrRetryPageHandler,
  buildOcrReocrWholePdfHandler,
} from "../../ocr-http.js";
import { errorMessage } from "../../../utils/errors.js";

function createOcrHandlers(dir: string) {
  return {
    forms: buildOcrFormsHandler(),
    prepare: buildOcrPrepareHandler({ trackerDir: dir }),
    approve: buildOcrApproveHandler({ trackerDir: dir }),
    discard: buildOcrDiscardHandler({ trackerDir: dir }),
    forceResearch: buildOcrForceResearchHandler({ trackerDir: dir }),
    retryPage: buildOcrRetryPageHandler({ trackerDir: dir }),
    reocrWholePdf: buildOcrReocrWholePdfHandler({ trackerDir: dir }),
  };
}

export function createOcrRoutes(): DashboardRoute {
  let initializedForDir: string | null = null;
  let handlers: ReturnType<typeof createOcrHandlers> | null = null;

  return async (req, res, url, ctx) => {
    if (!url.pathname.startsWith("/api/ocr/")) return false;
    if (initializedForDir !== ctx.dir || !handlers) {
      handlers = createOcrHandlers(ctx.dir);
      initializedForDir = ctx.dir;
    }

    if (req.method === "GET" && url.pathname === "/api/ocr/forms") {
      try {
        writeJson(res, 200, handlers.forms());
      } catch (e) {
        writeJson(res, 500, { ok: false, error: errorMessage(e) });
      }
      return true;
    }

    if (req.method === "POST" && (url.pathname === "/api/ocr/prepare" || url.pathname === "/api/ocr/reupload")) {
      const isReupload = url.pathname === "/api/ocr/reupload";
      const mp = await readMultipart(req, 50 * 1024 * 1024);
      if (!mp.ok) {
        writeJson(res, 400, { ok: false, error: mp.error });
        return true;
      }
      const file = mp.parsed.files["pdf"];
      if (!file) {
        writeJson(res, 400, { ok: false, error: "missing 'pdf' file part" });
        return true;
      }

      const uploadsDir = join(ctx.dir, "uploads");
      mkdirSync(uploadsDir, { recursive: true });
      const pdfFilename = `${randomUUID()}.pdf`;
      const pdfPath = join(uploadsDir, pdfFilename);
      writeFileSync(pdfPath, file.data);

      const fields = mp.parsed.fields;
      const formType = fields["formType"]?.trim() ?? "";
      const rosterMode = (fields["rosterMode"]?.trim() ?? "existing") as "existing" | "download";
      const rosterPath = fields["rosterPath"]?.trim() || undefined;
      const sessionId = fields["sessionId"]?.trim() || undefined;
      const previousRunId = fields["previousRunId"]?.trim() || undefined;
      const originWorkflow = fields["originWorkflow"]?.trim() || undefined;

      const result = await handlers.prepare({
        pdfPath,
        pdfOriginalName: file.filename ?? pdfFilename,
        formType,
        rosterMode,
        rosterPath,
        sessionId,
        previousRunId,
        isReupload,
        originWorkflow,
      });
      writeJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/ocr/approve-batch") {
      const parsedBody = await readJsonBody(req, 1024 * 1024);
      if (!parsedBody.ok) {
        writeJson(res, 400, { ok: false, error: parsedBody.error });
        return true;
      }
      const result = await handlers.approve({
        sessionId: String(parsedBody.body.sessionId ?? ""),
        runId: String(parsedBody.body.runId ?? ""),
        records: Array.isArray(parsedBody.body.records) ? parsedBody.body.records : [],
      });
      writeJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/ocr/discard-prepare") {
      const parsedBody = await readJsonBody(req, 4096);
      if (!parsedBody.ok) {
        writeJson(res, 400, { ok: false, error: parsedBody.error });
        return true;
      }
      const result = await handlers.discard({
        sessionId: String(parsedBody.body.sessionId ?? ""),
        runId: String(parsedBody.body.runId ?? ""),
        reason: parsedBody.body.reason ? String(parsedBody.body.reason) : undefined,
      });
      writeJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/ocr/force-research") {
      const parsedBody = await readJsonBody(req, 4096);
      if (!parsedBody.ok) {
        writeJson(res, 400, { ok: false, error: parsedBody.error });
        return true;
      }
      const result = await handlers.forceResearch({
        sessionId: String(parsedBody.body.sessionId ?? ""),
        runId: String(parsedBody.body.runId ?? ""),
        recordIndices: Array.isArray(parsedBody.body.recordIndices)
          ? parsedBody.body.recordIndices.map(Number)
          : [],
      });
      writeJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/ocr/retry-page") {
      const parsedBody = await readJsonBody(req, 4096);
      if (!parsedBody.ok) {
        writeJson(res, 400, { ok: false, error: parsedBody.error });
        return true;
      }
      const result = await handlers.retryPage({
        sessionId: String(parsedBody.body.sessionId ?? ""),
        runId: String(parsedBody.body.runId ?? ""),
        pageNum: Number(parsedBody.body.pageNum ?? 0),
      });
      writeJson(res, result.status, result.body);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/ocr/reocr-whole-pdf") {
      const parsedBody = await readJsonBody(req, 4096);
      if (!parsedBody.ok) {
        writeJson(res, 400, { ok: false, error: parsedBody.error });
        return true;
      }
      const result = await handlers.reocrWholePdf({
        sessionId: String(parsedBody.body.sessionId ?? ""),
        runId: String(parsedBody.body.runId ?? ""),
      });
      writeJson(res, result.status, result.body);
      return true;
    }

    return false;
  };
}
