import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  createSessionStore,
  type CaptureSessionStore,
} from "../../services/capture/index.js";
import { resolveRosterDirs } from "../../services/matching/roster-loader.js";
import type { CaptureSession } from "../../services/capture/sessions.js";
import { log } from "../../utils/log.js";
import { PATHS } from "../../config.js";
import { capturesDir, uploadsDir } from "../paths.js";
import { buildOcrPrepareHandler } from "./ocr/index.js";

export const captureStore: CaptureSessionStore = createSessionStore();
// Keyed off the active tracker root (HRAUTO_TRACKER_DIR via PATHS.trackerDir), NOT a
// hardcoded `.tracker/...` literal — otherwise an isolated tracker dir (e2e lane or any
// non-default deploy) leaks capture artifacts into the real `.tracker/` and breaks the
// capture->OCR handoff (the bundled PDF lands where OCR prepare can't see it).
export const CAPTURE_PHOTOS_DIR = capturesDir(PATHS.trackerDir);
export const CAPTURE_UPLOADS_DIR = uploadsDir(PATHS.trackerDir);

const captureMobileHtmlPath = join(import.meta.dirname ?? ".", "../../services/capture/mobile.html");
let captureMobileHtmlCache: string | undefined;

export function getCaptureMobileHtml(): string {
  if (!captureMobileHtmlCache) {
    try {
      captureMobileHtmlCache = readFileSync(captureMobileHtmlPath, "utf-8");
    } catch {
      captureMobileHtmlCache = "<!doctype html><html><body><h1>Capture client not found</h1></body></html>";
    }
  }
  return captureMobileHtmlCache;
}

const heic2anyAssetPath = join(import.meta.dirname ?? ".", "../../../node_modules/heic2any/dist/heic2any.min.js");
let heic2anyAssetCache: Buffer | undefined;

export function getHeic2anyAsset(): Buffer | undefined {
  if (heic2anyAssetCache) return heic2anyAssetCache;
  try {
    heic2anyAssetCache = readFileSync(heic2anyAssetPath);
    return heic2anyAssetCache;
  } catch {
    return undefined;
  }
}

/**
 * One declarative capture registration per workflow. Adding capture to a
 * workflow is a SINGLE entry here — no `makeCaptureFinalize` branch.
 *
 * - `label` — operator-facing button/modal title (also surfaced to the
 *   frontend via `GET /api/capture/registry`).
 * - `formType` — the OCR form type the bundled PDF is prepared as. This is
 *   what `makeCaptureFinalize` feeds to `buildOcrPrepareHandler`; it
 *   REPLACES the old per-workflow `if (workflow === ...)` mapping.
 * - `contextHints` — optional free-text hints surfaced on the phone.
 *
 * The `ocr` workflow is a special case: it carries its `formType` on the
 * capture session itself (operator-picked in the run modal), so it is NOT
 * listed here — `makeCaptureFinalize` falls back to `session.formType` when
 * the session's workflow has no registration entry.
 */
export interface CaptureRegistration {
  label: string;
  /** OCR form type for the bundled PDF (e.g. "oath", "emergency-contact"). */
  formType: string;
  contextHints?: string[];
}

export const captureRegistrations: Record<string, CaptureRegistration> = {
  "oath-signature": { label: "Capture paper roster", formType: "oath" },
  "emergency-contact": {
    label: "Capture emergency contact forms",
    formType: "emergency-contact",
  },
};

export function serializeCaptureSession(session: CaptureSession): {
  sessionId: string;
  workflow: string;
  contextHint?: string;
  state: CaptureSession["state"];
  createdAt: number;
  expiresAt: number;
  phoneConnectedAt?: number;
  photos: CaptureSession["photos"];
  pdfPath?: string;
} {
  return {
    sessionId: session.sessionId,
    workflow: session.workflow,
    ...(session.contextHint ? { contextHint: session.contextHint } : {}),
    state: session.state,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    ...(session.phoneConnectedAt ? { phoneConnectedAt: session.phoneConnectedAt } : {}),
    photos: session.photos,
    ...(session.pdfPath ? { pdfPath: session.pdfPath } : {}),
  };
}

export interface MakeCaptureFinalizeOpts {
  /**
   * Test seam — override the OCR prepare handler builder so a test can assert
   * which `formType` the declarative registration resolved to without running
   * the real OCR orchestrator. Production omits it (uses `buildOcrPrepareHandler`).
   */
  buildPrepareHandler?: typeof buildOcrPrepareHandler;
}

export function makeCaptureFinalize(trackerDir: string, opts: MakeCaptureFinalizeOpts = {}) {
  const buildPrepareHandler = opts.buildPrepareHandler ?? buildOcrPrepareHandler;
  return async (session: CaptureSession): Promise<void> => {
    if (!session.pdfPath) {
      log.warn(`[capture] finalized session ${session.sessionId} without pdfPath`);
      return;
    }

    // Resolve the roster against the ACTIVE tracker dir (not the `.tracker` default) —
    // otherwise a non-default tracker root finds no roster, falls back to rosterMode
    // "download", and the capture->OCR prepare throws (swallowed by onFinalize's catch),
    // so no OCR prep row ever appears. Same ISS-002 isolation bug as the artifact dirs.
    const rosterDirs = resolveRosterDirs(trackerDir);
    const rosterDir = rosterDirs.find((dir) => existsSync(dir)) ?? rosterDirs[0];
    let rosterPath: string | undefined;
    try {
      const files = readdirSync(rosterDir).filter((file) => file.endsWith(".xlsx"));
      if (files.length > 0) rosterPath = resolve(rosterDir, files.sort().at(-1)!);
    } catch {
      // Missing roster directories are normal on a first local run.
    }

    const pdfOriginalName = `capture-${session.sessionId.slice(0, 8)}.pdf`;
    const rosterMode: "existing" | "download" = rosterPath ? "existing" : "download";

    // All captures route through the shared OCR prepare path. The form type is
    // resolved DECLARATIVELY from the workflow's `captureRegistrations` entry —
    // adding capture to a workflow is one entry there, no branch here. The
    // `ocr` workflow is the lone exception: it has no registration entry and
    // carries its operator-picked `formType` on the session itself.
    const registration = captureRegistrations[session.workflow];
    const formType = registration?.formType ?? session.formType;
    if (!formType) {
      log.warn(`[capture] no OCR form type mapping for workflow ${session.workflow}`);
      return;
    }

    const handler = buildPrepareHandler({ trackerDir });
    const result = await handler({
      pdfPath: session.pdfPath,
      pdfOriginalName,
      formType,
      rosterMode,
      rosterPath,
      sessionId: session.sessionId,
    });
    if (result.status !== 202) {
      log.warn(`[capture] ocr prepare failed (status ${result.status}): ${JSON.stringify(result.body)}`);
    }
  };
}
