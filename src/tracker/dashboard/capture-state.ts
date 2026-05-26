import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  createSessionStore,
  type CaptureSessionStore,
} from "../../services/capture/index.js";
import type { CaptureSession } from "../../services/capture/sessions.js";
import { log } from "../../utils/log.js";
import { buildOcrPrepareHandler } from "./ocr/index.js";
import { enqueueOathSignaturePdf } from "./oath-signature/http.js";

export const captureStore: CaptureSessionStore = createSessionStore();
export const CAPTURE_PHOTOS_DIR = ".tracker/captures";
export const CAPTURE_UPLOADS_DIR = ".tracker/uploads";

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

export const captureRegistrations: Record<string, { label: string; contextHints?: string[] }> = {
  "oath-signature": { label: "Capture paper roster" },
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

export function makeCaptureFinalize(trackerDir: string) {
  return async (session: CaptureSession): Promise<void> => {
    if (!session.pdfPath) {
      log.warn(`[capture] finalized session ${session.sessionId} without pdfPath`);
      return;
    }

    const rosterDirs = [
      resolve(process.cwd(), ".tracker/rosters"),
      resolve(process.cwd(), "src/data"),
    ];
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

    // Plan A Commit 3: oath-signature captures enqueue directly into the
    // oath-signature daemon as a `{ kind: "pdf" }` item. Emergency-contact
    // and standalone OCR captures still go through the OCR prepare path.
    if (session.workflow === "oath-signature") {
      try {
        await enqueueOathSignaturePdf({
          pdfPath: session.pdfPath,
          pdfOriginalName,
          sessionId: session.sessionId,
          rosterMode,
          ...(rosterPath ? { rosterPath } : {}),
        });
      } catch (err) {
        log.warn(
          `[capture] oath-signature enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    let formType: string;
    if (session.workflow === "emergency-contact") {
      formType = "emergency-contact";
    } else if (session.workflow === "ocr" && session.formType) {
      formType = session.formType;
    } else {
      log.warn(`[capture] no OCR form type mapping for workflow ${session.workflow}`);
      return;
    }

    const handler = buildOcrPrepareHandler({ trackerDir });
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
