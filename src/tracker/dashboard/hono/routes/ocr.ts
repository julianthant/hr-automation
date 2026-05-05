import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Hono } from "hono";

import {
  buildOcrApproveHandler,
  buildOcrDiscardHandler,
  buildOcrForceResearchHandler,
  buildOcrFormsHandler,
  buildOcrPrepareHandler,
  buildOcrReocrWholePdfHandler,
  buildOcrRetryPageHandler,
} from "../../../ocr-http.js";
import { registerLocalFile } from "../../../files.js";
import { ensurePdfPageCache } from "../../../pdf-cache.js";
import type { DashboardHonoDeps } from "../context.js";
import { readMultipartRequest } from "../multipart.js";
import { jsonResponse, readJsonRequest } from "../responses.js";

export function registerOcrRoutes(app: Hono, deps: DashboardHonoDeps): void {
  const handlers = {
    forms: buildOcrFormsHandler(),
    prepare: buildOcrPrepareHandler({ trackerDir: deps.dir }),
    approve: buildOcrApproveHandler({ trackerDir: deps.dir }),
    discard: buildOcrDiscardHandler({ trackerDir: deps.dir }),
    forceResearch: buildOcrForceResearchHandler({ trackerDir: deps.dir }),
    retryPage: buildOcrRetryPageHandler({ trackerDir: deps.dir }),
    reocrWholePdf: buildOcrReocrWholePdfHandler({ trackerDir: deps.dir }),
  };

  app.get("/api/ocr/forms", () => jsonResponse(handlers.forms()));

  app.post("/api/ocr/prepare", (c) => handlePrepare(c.req.raw, deps, handlers.prepare, false));
  app.post("/api/ocr/reupload", (c) => handlePrepare(c.req.raw, deps, handlers.prepare, true));

  app.post("/api/ocr/approve-batch", async (c) => {
    const parsed = await readJsonRequest(c.req.raw, 1024 * 1024);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = await handlers.approve({
      sessionId: String(parsed.body.sessionId ?? ""),
      runId: String(parsed.body.runId ?? ""),
      records: Array.isArray(parsed.body.records) ? parsed.body.records : [],
    });
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/ocr/discard-prepare", async (c) => {
    const parsed = await readJsonRequest(c.req.raw, 4096);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = await handlers.discard({
      sessionId: String(parsed.body.sessionId ?? ""),
      runId: String(parsed.body.runId ?? ""),
      reason: parsed.body.reason ? String(parsed.body.reason) : undefined,
    });
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/ocr/force-research", async (c) => {
    const parsed = await readJsonRequest(c.req.raw, 4096);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = await handlers.forceResearch({
      sessionId: String(parsed.body.sessionId ?? ""),
      runId: String(parsed.body.runId ?? ""),
      recordIndices: Array.isArray(parsed.body.recordIndices)
        ? parsed.body.recordIndices.map(Number)
        : [],
    });
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/ocr/retry-page", async (c) => {
    const parsed = await readJsonRequest(c.req.raw, 4096);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = await handlers.retryPage({
      sessionId: String(parsed.body.sessionId ?? ""),
      runId: String(parsed.body.runId ?? ""),
      pageNum: Number(parsed.body.pageNum ?? 0),
    });
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/ocr/reocr-whole-pdf", async (c) => {
    const parsed = await readJsonRequest(c.req.raw, 4096);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const result = await handlers.reocrWholePdf({
      sessionId: String(parsed.body.sessionId ?? ""),
      runId: String(parsed.body.runId ?? ""),
    });
    return jsonResponse(result.body, result.status);
  });
}

async function handlePrepare(
  request: Request,
  deps: DashboardHonoDeps,
  prepare: ReturnType<typeof buildOcrPrepareHandler>,
  isReupload: boolean,
): Promise<Response> {
  const multipart = await readMultipartRequest(request, 50 * 1024 * 1024);
  if (!multipart.ok) return jsonResponse({ ok: false, error: multipart.error }, 400);
  const file = multipart.parsed.files.pdf;
  if (!file) return jsonResponse({ ok: false, error: "missing 'pdf' file part" }, 400);

  const uploadsDir = join(deps.dir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const pdfFilename = `${randomUUID()}.pdf`;
  const pdfPath = join(uploadsDir, pdfFilename);
  writeFileSync(pdfPath, file.data);

  const fields = multipart.parsed.fields;
  const formType = fields.formType?.trim() ?? "";
  const rosterMode = (fields.rosterMode?.trim() ?? "existing") as "existing" | "download";
  const rosterPath = fields.rosterPath?.trim() || undefined;
  const requestedSessionId = fields.sessionId?.trim() || undefined;
  const sessionId = requestedSessionId ?? (isReupload ? undefined : randomUUID());
  const previousRunId = fields.previousRunId?.trim() || undefined;
  const originWorkflow = fields.originWorkflow?.trim() || undefined;
  const pdfOriginalName = file.filename ?? pdfFilename;
  let pdfFileId: string | undefined;
  if (deps.stateDb && sessionId) {
    const registered = registerLocalFile(deps.stateDb, {
      kind: "pdf",
      mimeType: "application/pdf",
      path: pdfPath,
      originalName: pdfOriginalName,
      source: isReupload ? "ocr-reupload" : "ocr-upload",
      workflow: "ocr",
      itemId: sessionId,
    });
    pdfFileId = registered.fileId;
    void ensurePdfPageCache(deps.stateDb, {
      trackerDir: deps.dir,
      fileId: registered.fileId,
      pdfPath,
    }).catch(() => undefined);
  }

  const result = await prepare({
    pdfPath,
    pdfOriginalName,
    pdfFileId,
    formType,
    rosterMode,
    rosterPath,
    sessionId,
    previousRunId,
    isReupload,
    originWorkflow,
  });
  return jsonResponse(result.body, result.status);
}
