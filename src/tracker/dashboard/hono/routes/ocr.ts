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
import {
  ocrApproveBatchBody,
  ocrDiscardBody,
  ocrForceResearchBody,
  ocrRetryPageBody,
  ocrSessionBody,
  ocrVerifyRelookupBody,
  readValidatedJson,
} from "../request-schemas.js";
import { jsonResponse } from "../responses.js";
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
    const parsed = await readValidatedJson(c.req.raw, ocrApproveBatchBody, 1024 * 1024);
    if (!parsed.ok) return parsed.response;
    const result = await handlers.approve(parsed.body);
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/ocr/discard-prepare", async (c) => {
    const parsed = await readValidatedJson(c.req.raw, ocrDiscardBody);
    if (!parsed.ok) return parsed.response;
    const result = await handlers.discard(parsed.body);
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/ocr/force-research", async (c) => {
    const parsed = await readValidatedJson(c.req.raw, ocrForceResearchBody);
    if (!parsed.ok) return parsed.response;
    const result = await handlers.forceResearch(parsed.body);
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/ocr/verify-relookup", async (c) => {
    const parsed = await readValidatedJson(c.req.raw, ocrVerifyRelookupBody);
    if (!parsed.ok) return parsed.response;
    const result = await handlers.verifyRelookup(parsed.body);
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/ocr/retry-page", async (c) => {
    const parsed = await readValidatedJson(c.req.raw, ocrRetryPageBody);
    if (!parsed.ok) return parsed.response;
    const result = await handlers.retryPage(parsed.body);
    return jsonResponse(result.body, result.status);
  });

  app.post("/api/ocr/reocr-whole-pdf", async (c) => {
    const parsed = await readValidatedJson(c.req.raw, ocrSessionBody);
    if (!parsed.ok) return parsed.response;
    const result = await handlers.reocrWholePdf(parsed.body);
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
  // Strict roster-mode check — an unrecognized value must not masquerade as a
  // valid mode via a type-assertion.
  const rosterModeRaw = fields.rosterMode?.trim() || "existing";
  if (rosterModeRaw !== "existing" && rosterModeRaw !== "download" && rosterModeRaw !== "wait") {
    return jsonResponse(
      { ok: false, error: `rosterMode: "${rosterModeRaw}" is not one of existing | download | wait` },
      400,
    );
  }
  const rosterMode = rosterModeRaw;
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
