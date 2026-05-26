/**
 * HTTP handler for /api/oath-signature/start.
 *
 * Under Plan A Commit 3, an operator uploading a PDF from the
 * Run Oath Signature modal enqueues a single `{ kind: "pdf" }`
 * oath-signature daemon item; that item's kernel handler delegates to the
 * `ocr` workflow (which suspends until operator approval) and then fans
 * out one `kind: "signer"` child per approved record back into this
 * workflow via `ctx.delegateToAll`.
 *
 * Mirrors `oath-upload/http.ts` — multipart save → fire-and-forget
 * `runOathSignatureCli`. The shared "enqueue oath-signature PDF" helper
 * `enqueueOathSignaturePdf` is also exported for `capture-state.ts` so
 * the mobile-photo capture finalize path uses one implementation.
 */
import { randomUUID } from "node:crypto";

import { errorMessage } from "../../../utils/errors.js";
import { log } from "../../../utils/log.js";
import type { OathPdfInput } from "../../../workflows/oath-signature/schema.js";

export interface OathSignaturePdfEnqueueOpts {
  pdfPath: string;
  pdfOriginalName: string;
  pdfFileId?: string;
  pdfHash?: string;
  sessionId?: string;
  rosterMode?: "existing" | "download";
  rosterPath?: string;
  dryRun?: boolean;
  /**
   * Override the dispatcher (tests + capture-state plumb). Defaults to the
   * real `runOathSignatureCli` adapter resolved via dynamic import to
   * avoid pulling the workflow tree into the dashboard bundle at module
   * load time.
   */
  enqueue?: (inputs: OathPdfInput[]) => Promise<void>;
}

export interface OathSignaturePdfEnqueueResult {
  sessionId: string;
}

/**
 * Shape the PDF input + fire-and-forget enqueue. Used by the HTTP route AND
 * the capture finalize path so both paths produce identical queue rows.
 *
 * Returns the resolved sessionId so the HTTP handler can echo it back to the
 * client. Throws synchronously on missing required fields — the async
 * enqueue is `void`'d and any failure inside it is logged but never
 * surfaces back to the caller (matching the oath-upload route's contract).
 */
export async function enqueueOathSignaturePdf(
  args: OathSignaturePdfEnqueueOpts,
): Promise<OathSignaturePdfEnqueueResult> {
  if (!args.pdfPath || !args.pdfOriginalName) {
    throw new Error("enqueueOathSignaturePdf: missing pdfPath/pdfOriginalName");
  }
  const sessionId = args.sessionId ?? randomUUID();
  const input: OathPdfInput = {
    kind: "pdf",
    pdfPath: args.pdfPath,
    pdfOriginalName: args.pdfOriginalName,
    sessionId,
    ...(args.pdfFileId ? { pdfFileId: args.pdfFileId } : {}),
    ...(args.pdfHash ? { pdfHash: args.pdfHash } : {}),
    ...(args.rosterMode ? { rosterMode: args.rosterMode } : {}),
    ...(args.rosterPath ? { rosterPath: args.rosterPath } : {}),
    ...(args.dryRun ? { dryRun: args.dryRun } : {}),
  };
  const enqueue =
    args.enqueue ??
    (async (inputs) => {
      const { runOathSignatureCli } = await import(
        "../../../workflows/oath-signature/index.js"
      );
      await runOathSignatureCli(inputs);
    });
  void enqueue([input]).catch((err) =>
    log.error(`[oath-signature-http] runOathSignatureCli threw: ${errorMessage(err)}`),
  );
  return { sessionId };
}

export interface OathSignatureStartInput {
  pdfPath: string;
  pdfOriginalName: string;
  pdfFileId?: string;
  pdfHash?: string;
  sessionId?: string;
  rosterMode?: "existing" | "download";
  rosterPath?: string;
  dryRun?: boolean;
}

export interface OathSignatureStartResponse {
  status: 202 | 400 | 500;
  body:
    | { ok: true; sessionId: string }
    | { ok: false; error: string };
}

export interface OathSignatureStartHandlerOpts {
  trackerDir?: string;
  /** Test escape hatch — same shape as the production dynamic import path. */
  enqueueOathSignaturePdf?: typeof enqueueOathSignaturePdf;
}

export function buildOathSignatureStartHandler(
  opts: OathSignatureStartHandlerOpts = {},
): (input: OathSignatureStartInput) => Promise<OathSignatureStartResponse> {
  const enqueue = opts.enqueueOathSignaturePdf ?? enqueueOathSignaturePdf;
  return async (input) => {
    if (!input.pdfPath || !input.pdfOriginalName) {
      return {
        status: 400,
        body: { ok: false, error: "Missing pdfPath/pdfOriginalName" },
      };
    }
    if (input.pdfHash && !/^[0-9a-f]{64}$/.test(input.pdfHash)) {
      return { status: 400, body: { ok: false, error: "invalid pdfHash" } };
    }
    if (input.rosterMode === "existing" && !input.rosterPath) {
      return {
        status: 400,
        body: { ok: false, error: 'rosterMode="existing" requires rosterPath' },
      };
    }
    try {
      const { sessionId } = await enqueue({
        pdfPath: input.pdfPath,
        pdfOriginalName: input.pdfOriginalName,
        ...(input.pdfFileId ? { pdfFileId: input.pdfFileId } : {}),
        ...(input.pdfHash ? { pdfHash: input.pdfHash } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.rosterMode ? { rosterMode: input.rosterMode } : {}),
        ...(input.rosterPath ? { rosterPath: input.rosterPath } : {}),
        ...(input.dryRun ? { dryRun: input.dryRun } : {}),
      });
      return { status: 202, body: { ok: true, sessionId } };
    } catch (err) {
      return {
        status: 500,
        body: { ok: false, error: errorMessage(err) },
      };
    }
  };
}
