import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Hono } from "hono";

import {
  buildOcrApproveHandler,
  buildOcrForceResearchHandler,
  buildOcrFormsHandler,
  buildOcrPrepareHandler,
  buildOcrReocrWholePdfHandler,
  buildOcrRetryPageHandler,
  buildOcrVerifyRelookupHandler,
} from "../../ocr/index.js";
import { buildOcrDiscardHandler } from "../../../../control/ocr/discard.js";
import { registerLocalFile } from "../../../files/files.js";
import { ensurePdfPageCache } from "../../../files/pdf-cache.js";
import { getProjectionDb, type DashboardHonoDeps } from "../context.js";
import { readMultipartRequest } from "../multipart.js";
import { jsonResponse, readJsonRequest } from "../responses.js";
import { log } from "../../../../utils/log.js";
import { getOcrKeyStatuses } from "../../../../services/ocr/key-status.js";
import { runtimeDir } from "../../../paths.js";
import { normalizeRunOptions } from "../../../../domain/run-options.js";

export function registerOcrRoutes(app: Hono, deps: DashboardHonoDeps): void {
  const handlers = {
    forms: buildOcrFormsHandler(),
    prepare: buildOcrPrepareHandler({ trackerDir: deps.dir }),
    approve: buildOcrApproveHandler({ trackerDir: deps.dir }),
    discard: buildOcrDiscardHandler({ trackerDir: deps.dir }),
    forceResearch: buildOcrForceResearchHandler({ trackerDir: deps.dir }),
    verifyRelookup: buildOcrVerifyRelookupHandler({ trackerDir: deps.dir }),
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
      records: (() => {
        const raw = Array.isArray(parsed.body.records) ? parsed.body.records : [];
        const filtered = raw.filter(
          (r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r),
        );
        const dropped = raw.length - filtered.length;
        if (dropped > 0) log.warn(`[ocr-http] approve-batch: dropped ${dropped} non-object element(s) from records`);
        return filtered;
      })(),
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
      parentWorkflow: parsed.body.parentWorkflow ? String(parsed.body.parentWorkflow) : undefined,
      parentRunId: parsed.body.parentRunId ? String(parsed.body.parentRunId) : undefined,
      parentItemId: parsed.body.parentItemId ? String(parsed.body.parentItemId) : undefined,
      formType: parsed.body.formType ? String(parsed.body.formType) : undefined,
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

  app.post("/api/ocr/verify-relookup", async (c) => {
    const parsed = await readJsonRequest(c.req.raw, 4096);
    if (!parsed.ok) return jsonResponse({ ok: false, error: parsed.error }, 400);
    const lookup = String(parsed.body.lookup ?? "");
    const result = await handlers.verifyRelookup({
      sessionId: String(parsed.body.sessionId ?? ""),
      runId: String(parsed.body.runId ?? ""),
      recordIndex: Number(parsed.body.recordIndex ?? -1),
      lookup: lookup === "i9" ? "i9" : "person",
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

  app.get("/api/ocr/key-status", () => jsonResponse(getOcrKeyStatuses(runtimeDir(deps.dir))));
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

  const fields = multipart.parsed.fields;
  const requestedSessionId = fields.sessionId?.trim() || undefined;
  if (isReupload && !requestedSessionId) {
    return jsonResponse({ ok: false, error: "sessionId required for reupload" }, 400);
  }

  const uploadsDir = join(deps.dir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const pdfFilename = `${randomUUID()}.pdf`;
  const pdfPath = join(uploadsDir, pdfFilename);
  writeFileSync(pdfPath, file.data);

  const formType = fields.formType?.trim() ?? "";
  const targetWorkflow = fields.targetWorkflow?.trim() || undefined;
  // Automation-workers run setting from the upload modal. Auto (absent/"auto")
  // → no run options; an invalid explicit value fails loud as a 400 here.
  let runOptions;
  try {
    runOptions = normalizeRunOptions({ parallelWorkers: fields.parallelWorkers });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      400,
    );
  }
  const rosterMode = (fields.rosterMode?.trim() ?? "existing") as "existing" | "download" | "wait";
  const rosterPath = fields.rosterPath?.trim() || undefined;
  const sessionId = requestedSessionId ?? (isReupload ? undefined : randomUUID());
  const previousRunId = fields.previousRunId?.trim() || undefined;
  const dryRun = fields.dryRun === "true" || fields.dryRun === "1";
  const pdfOriginalName = file.filename ?? pdfFilename;
  let pdfFileId: string | undefined;
  // Resolve the projection DB handle per-request (mirrors the projection
  // routes — see context.ts:getProjectionDb). The cached `deps.stateDb` can
  // outlive a `.tracker/state.db` delete/recreate; using it directly would
  // throw on the next write and Hono would return a plain-text 500 the
  // browser reports as "Network error".
  const stateDb = getProjectionDb(deps);
  if (stateDb && sessionId) {
    const registered = registerLocalFile(stateDb, {
      trackerDir: deps.dir,
      kind: "pdf",
      mimeType: "application/pdf",
      path: pdfPath,
      originalName: pdfOriginalName,
      source: isReupload ? "ocr-reupload" : "ocr-upload",
      workflow: "ocr",
      itemId: sessionId,
    });
    pdfFileId = registered.fileId;
    void ensurePdfPageCache(stateDb, {
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
    ...(targetWorkflow ? { targetWorkflow } : {}),
    ...(runOptions.parallelWorkers !== undefined ? { runOptions } : {}),
    rosterMode,
    rosterPath,
    sessionId,
    previousRunId,
    isReupload,
    dryRun,
  });
  return jsonResponse(result.body, result.status);
}
