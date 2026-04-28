import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaptureSession, CaptureSessionStore } from "./sessions.js";
import { qrSvgFor } from "./qr.js";
import { bundlePhotosToPdf } from "./pdf-bundle.js";

export interface RouteResult {
  status: number;
  body: unknown;
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB

// ─── handleStart ────────────────────────────────────────────

export interface HandleStartInput {
  workflow: string;
  contextHint?: string;
}

export interface HandleStartContext {
  store: CaptureSessionStore;
  /** LAN IP for the QR URL. Undefined → 503. */
  lanIp: string | undefined;
  /** Server port, e.g. 3838. */
  port: number;
  /**
   * Called once after photo upload completes and the user finalizes. The
   * handler bundles the PDF + invokes this callback in the background; HTTP
   * response returns immediately on finalize.
   */
  onFinalize: CaptureSession["onFinalize"];
}

export async function handleStart(
  input: HandleStartInput,
  ctx: HandleStartContext,
): Promise<RouteResult> {
  if (!input.workflow || typeof input.workflow !== "string") {
    return { status: 400, body: { ok: false, error: "workflow is required" } };
  }
  if (!ctx.lanIp) {
    return {
      status: 503,
      body: {
        ok: false,
        error:
          "no LAN IPv4 detected — dashboard host is offline or not on a network",
      },
    };
  }

  const session = ctx.store.create({
    workflow: input.workflow,
    contextHint: input.contextHint,
    onFinalize: ctx.onFinalize,
  });

  const captureUrl = `http://${ctx.lanIp}:${ctx.port}/capture/${session.token}`;
  const qrSvg = await qrSvgFor(captureUrl);

  return {
    status: 200,
    body: {
      ok: true,
      sessionId: session.sessionId,
      token: session.token,
      captureUrl,
      qrSvg,
    },
  };
}

// ─── handleManifest ─────────────────────────────────────────

export interface HandleManifestContext {
  store: CaptureSessionStore;
}

export function handleManifest(
  token: string,
  ctx: HandleManifestContext,
): RouteResult {
  const session = ctx.store.getByToken(token);
  if (!session) {
    return { status: 404, body: { ok: false, error: "session not found" } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      state: session.state,
      photos: session.photos.length,
      contextHint: session.contextHint,
      expiresAt: session.expiresAt,
    },
  };
}

// ─── handleUpload ───────────────────────────────────────────

export interface HandleUploadInput {
  token: string;
  bytes: Buffer;
  originalName: string;
}

export interface HandleUploadContext {
  store: CaptureSessionStore;
  /** Directory under which photos are written: <photosDir>/<sessionId>/<N>.jpg */
  photosDir: string;
}

export async function handleUpload(
  input: HandleUploadInput,
  ctx: HandleUploadContext,
): Promise<RouteResult> {
  const session = ctx.store.getByToken(input.token);
  if (!session) {
    return { status: 404, body: { ok: false, error: "session not found" } };
  }
  if (session.state !== "open") {
    return {
      status: 409,
      body: { ok: false, error: `session is ${session.state}` },
    };
  }
  if (input.bytes.length === 0) {
    return { status: 400, body: { ok: false, error: "photo is empty" } };
  }
  if (input.bytes.length > MAX_PHOTO_BYTES) {
    return { status: 413, body: { ok: false, error: "photo too large (>10 MB)" } };
  }

  const dir = join(ctx.photosDir, session.sessionId);
  mkdirSync(dir, { recursive: true });
  const index = session.photos.length;
  const ext =
    input.originalName.match(/\.(jpe?g|png)$/i)?.[0]?.toLowerCase() ?? ".jpg";
  const filename = `${String(index).padStart(3, "0")}${ext}`;
  const fullPath = join(dir, filename);
  writeFileSync(fullPath, input.bytes);

  ctx.store.addPhoto(session.sessionId, {
    filename,
    bytes: input.bytes.length,
  });

  return {
    status: 200,
    body: {
      ok: true,
      photoIndex: index,
      totalPhotos: session.photos.length,
    },
  };
}

// ─── handleDeletePhoto ──────────────────────────────────────

export interface HandleDeletePhotoInput {
  token: string;
  index: number;
}

export function handleDeletePhoto(
  input: HandleDeletePhotoInput,
  ctx: HandleUploadContext,
): RouteResult {
  const session = ctx.store.getByToken(input.token);
  if (!session) {
    return { status: 404, body: { ok: false, error: "session not found" } };
  }
  if (input.index < 0 || input.index >= session.photos.length) {
    return { status: 400, body: { ok: false, error: "index out of range" } };
  }
  const photo = session.photos[input.index];
  ctx.store.removePhoto(session.sessionId, input.index);
  try {
    unlinkSync(join(ctx.photosDir, session.sessionId, photo.filename));
  } catch {
    /* best-effort */
  }
  return {
    status: 200,
    body: { ok: true, totalPhotos: session.photos.length },
  };
}

// ─── handleFinalize ─────────────────────────────────────────

export interface HandleFinalizeInput {
  token: string;
}

export interface HandleFinalizeContext {
  store: CaptureSessionStore;
  photosDir: string;
  uploadsDir: string;
}

export async function handleFinalize(
  input: HandleFinalizeInput,
  ctx: HandleFinalizeContext,
): Promise<RouteResult> {
  const session = ctx.store.getByToken(input.token);
  if (!session) {
    return { status: 404, body: { ok: false, error: "session not found" } };
  }
  if (session.state !== "open") {
    return {
      status: 409,
      body: { ok: false, error: `session is ${session.state}` },
    };
  }

  ctx.store.setState(session.sessionId, "finalizing");

  // Background: bundle PDF + run onFinalize. HTTP returns immediately so
  // the mobile UI doesn't hang on a slow OCR pipeline.
  void (async () => {
    try {
      const photoPaths = session.photos.map((p) =>
        join(ctx.photosDir, session.sessionId, p.filename),
      );
      const pdfPath = join(ctx.uploadsDir, `${session.sessionId}.pdf`);
      await bundlePhotosToPdf(photoPaths, pdfPath);
      ctx.store.setPdfPath(session.sessionId, pdfPath);
      ctx.store.setState(session.sessionId, "finalized");
      const updated = ctx.store.getById(session.sessionId);
      if (updated) {
        try {
          await updated.onFinalize(updated);
        } catch {
          // Caller's pipeline failure isn't the session's failure.
        }
      }
    } catch {
      ctx.store.setState(session.sessionId, "discarded");
    }
  })();

  return { status: 200, body: { ok: true, sessionId: session.sessionId } };
}

// ─── handleDiscard ──────────────────────────────────────────

export interface HandleDiscardInput {
  sessionId: string;
  reason?: string;
}

export interface HandleDiscardContext {
  store: CaptureSessionStore;
  photosDir: string;
}

export function handleDiscard(
  input: HandleDiscardInput,
  ctx: HandleDiscardContext,
): RouteResult {
  const session = ctx.store.getById(input.sessionId);
  if (!session) {
    return { status: 404, body: { ok: false, error: "session not found" } };
  }
  ctx.store.setState(session.sessionId, "discarded");
  try {
    rmSync(join(ctx.photosDir, session.sessionId), {
      recursive: true,
      force: true,
    });
  } catch {
    /* best-effort */
  }
  return { status: 200, body: { ok: true } };
}
