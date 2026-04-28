import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CaptureSession, CaptureSessionStore } from "./sessions.js";
import { qrSvgFor } from "./qr.js";
import { bundlePhotosToPdf } from "./pdf-bundle.js";

export interface RouteResult {
  status: number;
  body: unknown;
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_EXTEND_MS = 5 * 60 * 1_000;

// Crockford-style alphabet (no 0/O/I/L confusables) so an operator can
// read the shortcode aloud without ambiguity.
const SHORTCODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function genShortcode(): string {
  const bytes = randomBytes(4);
  let out = "";
  for (const b of bytes) out += SHORTCODE_ALPHABET[b % SHORTCODE_ALPHABET.length];
  return `${out.slice(0, 2)}-${out.slice(2, 4)}`;
}

function mimeFromExt(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i);
  if (!m) return "application/octet-stream";
  switch (m[1].toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    default:
      return "application/octet-stream";
  }
}

function extFromMime(mime: string, fallback: string): string {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/heic":
      return ".heic";
    case "image/heif":
      return ".heif";
    default:
      return fallback;
  }
}

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
  const shortcode = genShortcode();

  return {
    status: 200,
    body: {
      ok: true,
      sessionId: session.sessionId,
      token: session.token,
      captureUrl,
      qrSvg,
      shortcode,
      expiresAt: session.expiresAt,
    },
  };
}

// ─── handleManifest ─────────────────────────────────────────

export interface HandleManifestContext {
  store: CaptureSessionStore;
  /** When supplied, the manifest GET marks the phone as connected. */
  phoneInfo?: { userAgent?: string; ip?: string };
}

export function handleManifest(
  token: string,
  ctx: HandleManifestContext,
): RouteResult {
  const session = ctx.store.getByToken(token);
  if (!session) {
    return { status: 404, body: { ok: false, error: "session not found" } };
  }
  // First manifest hit from the phone is treated as "phone connected" —
  // useful both for the dashboard UI and audit trail. Idempotent.
  ctx.store.markPhoneConnected(session.sessionId, ctx.phoneInfo);
  return {
    status: 200,
    body: {
      ok: true,
      state: session.state,
      // Spec says PhotoSummary[]; older callers tolerate either shape.
      // Phone uses .forEach, so the array is required.
      photos: session.photos,
      workflow: session.workflow,
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
  /** Optional client-side blur metric — surfaced as a UX hint, never
   * gates uploads. */
  blurScore?: number;
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
  // Read mime from the original name so the served file later carries
  // the right Content-Type. Phone may send heic; we keep the upload
  // exact and let the phone's polyfill convert before the bundle step.
  const mime = mimeFromExt(input.originalName);
  const ext = extFromMime(mime, ".jpg");
  // Write under the next-stable-index slot; replace-photo writes a
  // timestamp-suffixed name to keep both copies on disk.
  const provisionalIndex = session.photos.length;
  const filename = `${String(provisionalIndex).padStart(3, "0")}${ext}`;
  const fullPath = join(dir, filename);
  writeFileSync(fullPath, input.bytes);

  const blurFlagged =
    typeof input.blurScore === "number" ? input.blurScore < 80 : undefined;
  const photo = ctx.store.addPhoto(session.sessionId, {
    filename,
    sizeBytes: input.bytes.length,
    mime,
    ...(typeof input.blurScore === "number" ? { blurScore: input.blurScore } : {}),
    ...(blurFlagged !== undefined ? { blurFlagged } : {}),
  });

  if (!photo) {
    // Race: session went terminal between getByToken and addPhoto. Roll
    // back the file so we don't leave an orphan.
    try { unlinkSync(fullPath); } catch { /* best-effort */ }
    return {
      status: 409,
      body: { ok: false, error: "session no longer open" },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      photoIndex: photo.index,
      totalPhotos: session.photos.length,
      ...(typeof photo.blurScore === "number" ? { blurScore: photo.blurScore } : {}),
      ...(typeof photo.blurFlagged === "boolean"
        ? { blurFlagged: photo.blurFlagged }
        : {}),
    },
  };
}

// ─── handleDeletePhoto ──────────────────────────────────────

export interface HandleDeletePhotoInput {
  token: string;
  /** Stable photo id (CapturedPhoto.index). */
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
  if (!Number.isInteger(input.index) || input.index < 0) {
    return { status: 400, body: { ok: false, error: "index out of range" } };
  }
  const removed = ctx.store.removePhoto(session.sessionId, input.index);
  if (!removed) {
    return { status: 400, body: { ok: false, error: "index out of range" } };
  }
  try {
    unlinkSync(join(ctx.photosDir, session.sessionId, removed.filename));
  } catch {
    /* best-effort */
  }
  return {
    status: 200,
    body: { ok: true, totalPhotos: session.photos.length },
  };
}

// ─── handleReplacePhoto ─────────────────────────────────────

export interface HandleReplacePhotoInput {
  token: string;
  /** Stable photo id (CapturedPhoto.index). */
  index: number;
  bytes: Buffer;
  originalName: string;
  blurScore?: number;
}

/**
 * Replace the photo with stable id `index`. Writes a fresh file with a
 * timestamp suffix so the old copy is preserved on disk for forensics
 * (and so cache-busting Just Works — the URL changes implicitly when
 * the dashboard re-renders against the new filename).
 */
export async function handleReplacePhoto(
  input: HandleReplacePhotoInput,
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
  if (!Number.isInteger(input.index) || input.index < 0) {
    return { status: 400, body: { ok: false, error: "index out of range" } };
  }
  if (input.bytes.length === 0) {
    return { status: 400, body: { ok: false, error: "photo is empty" } };
  }
  if (input.bytes.length > MAX_PHOTO_BYTES) {
    return { status: 413, body: { ok: false, error: "photo too large (>10 MB)" } };
  }

  const existing = session.photos.find((p) => p.index === input.index);
  if (!existing) {
    return { status: 400, body: { ok: false, error: "index out of range" } };
  }

  const dir = join(ctx.photosDir, session.sessionId);
  mkdirSync(dir, { recursive: true });
  const mime = mimeFromExt(input.originalName);
  const ext = extFromMime(mime, ".jpg");
  // Stable id + timestamp keeps the new file distinct from the old one.
  // Old file stays on disk as a forensic record; the photo serving route
  // resolves through the store, not the directory, so it never serves
  // an orphaned old copy.
  const filename = `${String(input.index).padStart(3, "0")}-${Date.now()}${ext}`;
  const fullPath = join(dir, filename);
  writeFileSync(fullPath, input.bytes);

  const blurFlagged =
    typeof input.blurScore === "number" ? input.blurScore < 80 : undefined;
  const result = ctx.store.replacePhoto(session.sessionId, input.index, {
    filename,
    sizeBytes: input.bytes.length,
    mime,
    ...(typeof input.blurScore === "number" ? { blurScore: input.blurScore } : {}),
    ...(blurFlagged !== undefined ? { blurFlagged } : {}),
  });

  if (!result) {
    try { unlinkSync(fullPath); } catch { /* best-effort */ }
    return {
      status: 409,
      body: { ok: false, error: "session no longer open" },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      ...(typeof result.replaced.blurScore === "number"
        ? { blurScore: result.replaced.blurScore }
        : {}),
      ...(typeof result.replaced.blurFlagged === "boolean"
        ? { blurFlagged: result.replaced.blurFlagged }
        : {}),
    },
  };
}

// ─── handleReorder ──────────────────────────────────────────

export interface HandleReorderInput {
  token: string;
  /** Source array position (NOT a stable photo id). */
  fromIndex: number;
  /** Destination array position. */
  toIndex: number;
}

export function handleReorder(
  input: HandleReorderInput,
  ctx: { store: CaptureSessionStore },
): RouteResult {
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
  const ok = ctx.store.reorderPhotos(
    session.sessionId,
    input.fromIndex,
    input.toIndex,
  );
  if (!ok) {
    return { status: 400, body: { ok: false, error: "invalid reorder" } };
  }
  return {
    status: 200,
    body: { ok: true, order: session.photos.map((p) => p.index) },
  };
}

// ─── handleExtend ───────────────────────────────────────────

export interface HandleExtendInput {
  sessionId: string;
  /** Optional bump in milliseconds. Defaults to 5 minutes. */
  byMs?: number;
}

export function handleExtend(
  input: HandleExtendInput,
  ctx: { store: CaptureSessionStore },
): RouteResult {
  const session = ctx.store.getById(input.sessionId);
  if (!session) {
    return { status: 404, body: { ok: false, error: "session not found" } };
  }
  if (session.state !== "open") {
    return {
      status: 409,
      body: { ok: false, error: `session is ${session.state}` },
    };
  }
  const byMs =
    typeof input.byMs === "number" && input.byMs > 0 ? input.byMs : DEFAULT_EXTEND_MS;
  const newExpiresAt = ctx.store.extend(input.sessionId, byMs);
  if (newExpiresAt === undefined) {
    return { status: 400, body: { ok: false, error: "couldn't extend" } };
  }
  return { status: 200, body: { ok: true, newExpiresAt } };
}

// ─── handleValidate ─────────────────────────────────────────

export interface HandleValidateInput {
  sessionId: string;
}

/**
 * Default per-session validation. Workflows can register a richer
 * `validate` handler in the future; for now, the only universally-true
 * blocker is "no photos".
 */
export function handleValidate(
  input: HandleValidateInput,
  ctx: { store: CaptureSessionStore },
): RouteResult {
  const session = ctx.store.getById(input.sessionId);
  if (!session) {
    return { status: 404, body: { ok: false, error: "session not found" } };
  }
  const photoCount = session.photos.length;
  const totalBytes = session.photos.reduce((n, p) => n + p.sizeBytes, 0);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (photoCount === 0) blockers.push("No photos captured.");
  if (photoCount > 50) {
    warnings.push(`${photoCount} photos — bundle may be large.`);
  }
  if (totalBytes > 80 * 1024 * 1024) {
    warnings.push(
      `Bundle size ${(totalBytes / 1024 / 1024).toFixed(1)} MB — server PDF build may be slow.`,
    );
  }
  return {
    status: 200,
    body: {
      ok: blockers.length === 0,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(blockers.length > 0 ? { blockers } : {}),
    },
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
