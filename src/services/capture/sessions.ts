import { randomBytes, randomUUID } from "node:crypto";

export type CaptureSessionState =
  | "open"
  | "finalizing"
  | "finalized"
  | "discarded"
  | "expired";

/**
 * Per-photo metadata. `index` is a stable, monotonically increasing
 * identifier within a session — assigned at upload time and never reused
 * even after delete or reorder. Routes that operate on a specific photo
 * (delete, replace, photo serving) reference it by `index`. Drag-reorder
 * uses array positions, not `index`, so reordering is independent of id
 * stability.
 */
export interface CapturedPhoto {
  index: number;
  filename: string;
  sizeBytes: number;
  mime: string;
  uploadedAt: number;
  blurScore?: number;
  blurFlagged?: boolean;
}

/** Inbound shape used by upload + replace handlers. The store assigns
 * `index` and `uploadedAt` itself — callers only supply file metadata. */
export interface CapturedPhotoInput {
  filename: string;
  sizeBytes: number;
  mime: string;
  blurScore?: number;
  blurFlagged?: boolean;
}

export interface CaptureSession {
  sessionId: string;
  token: string;
  workflow: string;
  /** When workflow === "ocr", specifies the form type (e.g. "oath", "emergency-contact"). */
  formType?: string;
  contextHint?: string;
  createdAt: number;
  /**
   * Last activity + 15 min. Refreshed on each upload so an in-progress
   * upload session stays alive past the original 15-min window.
   */
  expiresAt: number;
  state: CaptureSessionState;
  photos: CapturedPhoto[];
  onFinalize: (session: CaptureSession) => Promise<void>;
  /** PDF path populated after finalize bundles photos. */
  pdfPath?: string;
  /** Set on first GET /api/capture/manifest/:token. */
  phoneConnectedAt?: number;
  phoneUserAgent?: string;
  phoneIp?: string;
}

/** One mutation. Subscribers (the SSE channel) consume these. */
export interface CaptureSessionEvent {
  ts: number;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
}

const TERMINAL_STATES: ReadonlySet<CaptureSessionState> = new Set([
  "finalized",
  "discarded",
  "expired",
]);

const SESSION_TTL_MS = 15 * 60 * 1_000;

export interface CreateSessionInput {
  workflow: string;
  contextHint?: string;
  onFinalize: CaptureSession["onFinalize"];
}

export interface CaptureSessionStore {
  create(input: CreateSessionInput): CaptureSession;
  getById(sessionId: string): CaptureSession | undefined;
  getByToken(token: string): CaptureSession | undefined;
  /** Append a photo with a freshly-assigned stable index. */
  addPhoto(sessionId: string, input: CapturedPhotoInput): CapturedPhoto | undefined;
  /** Remove the photo with stable id `photoIndex`. Returns the removed
   * record so the caller can unlink the file from disk. */
  removePhoto(sessionId: string, photoIndex: number): CapturedPhoto | undefined;
  /**
   * Replace the photo whose stable id matches `photoIndex` with a fresh
   * file. The id is preserved; uploadedAt is bumped. Returns both the
   * old and the new record (caller owns disposing the old file).
   */
  replacePhoto(
    sessionId: string,
    photoIndex: number,
    input: CapturedPhotoInput,
  ): { old: CapturedPhoto; replaced: CapturedPhoto } | undefined;
  /**
   * Move the photo at array position `fromIndex` to position `toIndex`.
   * `fromIndex`/`toIndex` are POSITIONS, not stable ids — drag-reorder
   * naturally thinks in positions ("drop here") and stable ids are
   * orthogonal.
   */
  reorderPhotos(sessionId: string, fromIndex: number, toIndex: number): boolean;
  setState(sessionId: string, state: CaptureSessionState): void;
  setPdfPath(sessionId: string, path: string): void;
  /** Bump expiresAt by `byMs`. Returns the new expiresAt. */
  extend(sessionId: string, byMs: number): number | undefined;
  /** First manifest hit from the phone — idempotent. */
  markPhoneConnected(
    sessionId: string,
    info?: { userAgent?: string; ip?: string },
  ): boolean;
  sweepExpired(): number;
  listAll(): CaptureSession[];
  /** Subscribe to every store mutation. Returns the unsubscribe fn. */
  subscribe(fn: (event: CaptureSessionEvent) => void): () => void;
}

export interface CreateStoreOptions {
  now?: () => number;
}

export function createSessionStore(opts: CreateStoreOptions = {}): CaptureSessionStore {
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, CaptureSession>();
  const tokenIndex = new Map<string, string>(); // token → sessionId
  const subscribers = new Set<(e: CaptureSessionEvent) => void>();
  // Per-session monotonic counter so photo.index never reuses a slot
  // even after deletes.
  const nextPhotoIndex = new Map<string, number>();

  function emit(
    sessionId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    const ev: CaptureSessionEvent = { ts: now(), sessionId, type, payload };
    for (const fn of subscribers) {
      try {
        fn(ev);
      } catch {
        // A subscriber's failure must never poison the store.
      }
    }
  }

  function genToken(): string {
    return randomBytes(12).toString("base64url");
  }

  function bumpExpiry(s: CaptureSession): void {
    s.expiresAt = now() + SESSION_TTL_MS;
  }

  function buildPhoto(
    index: number,
    input: CapturedPhotoInput,
    ts: number,
  ): CapturedPhoto {
    return {
      index,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      mime: input.mime,
      uploadedAt: ts,
      ...(typeof input.blurScore === "number" ? { blurScore: input.blurScore } : {}),
      ...(typeof input.blurFlagged === "boolean"
        ? { blurFlagged: input.blurFlagged }
        : {}),
    };
  }

  return {
    create({ workflow, contextHint, onFinalize }): CaptureSession {
      const sessionId = randomUUID();
      let token = genToken();
      while (tokenIndex.has(token)) token = genToken();
      const t = now();
      const session: CaptureSession = {
        sessionId,
        token,
        workflow,
        contextHint,
        createdAt: t,
        expiresAt: t + SESSION_TTL_MS,
        state: "open",
        photos: [],
        onFinalize,
      };
      sessions.set(sessionId, session);
      tokenIndex.set(token, sessionId);
      nextPhotoIndex.set(sessionId, 0);
      // session_created carries the operator-side fields needed to
      // construct a fresh CaptureSessionInfo without a separate snapshot
      // round-trip — see the spec's "session_created payload invariant".
      emit(sessionId, "session_created", {
        workflow,
        contextHint,
        expiresAt: session.expiresAt,
      });
      return session;
    },

    getById(sessionId): CaptureSession | undefined {
      return sessions.get(sessionId);
    },

    getByToken(token): CaptureSession | undefined {
      const id = tokenIndex.get(token);
      return id ? sessions.get(id) : undefined;
    },

    addPhoto(sessionId, input): CapturedPhoto | undefined {
      const s = sessions.get(sessionId);
      if (!s || TERMINAL_STATES.has(s.state)) return undefined;
      const idx = nextPhotoIndex.get(sessionId) ?? 0;
      nextPhotoIndex.set(sessionId, idx + 1);
      const photo = buildPhoto(idx, input, now());
      s.photos.push(photo);
      bumpExpiry(s);
      // photo_added's payload IS the PhotoSummary itself — the dashboard
      // reducer in useCaptureSession.ts treats it as such.
      emit(sessionId, "photo_added", { ...photo });
      return photo;
    },

    removePhoto(sessionId, photoIndex): CapturedPhoto | undefined {
      const s = sessions.get(sessionId);
      if (!s || TERMINAL_STATES.has(s.state)) return undefined;
      const arrIdx = s.photos.findIndex((p) => p.index === photoIndex);
      if (arrIdx < 0) return undefined;
      const [removed] = s.photos.splice(arrIdx, 1);
      emit(sessionId, "photo_removed", { photoIndex, source: "phone" });
      return removed;
    },

    replacePhoto(sessionId, photoIndex, input):
      | { old: CapturedPhoto; replaced: CapturedPhoto }
      | undefined {
      const s = sessions.get(sessionId);
      if (!s || TERMINAL_STATES.has(s.state)) return undefined;
      const arrIdx = s.photos.findIndex((p) => p.index === photoIndex);
      if (arrIdx < 0) return undefined;
      const old = s.photos[arrIdx];
      const replaced = buildPhoto(old.index, input, now());
      s.photos[arrIdx] = replaced;
      bumpExpiry(s);
      emit(sessionId, "photo_replaced", {
        photoIndex,
        oldFilename: old.filename,
        newFilename: replaced.filename,
        ...(typeof replaced.blurScore === "number"
          ? { blurScore: replaced.blurScore }
          : {}),
        ...(typeof replaced.blurFlagged === "boolean"
          ? { blurFlagged: replaced.blurFlagged }
          : {}),
      });
      return { old, replaced };
    },

    reorderPhotos(sessionId, fromIndex, toIndex): boolean {
      const s = sessions.get(sessionId);
      if (!s || TERMINAL_STATES.has(s.state)) return false;
      const len = s.photos.length;
      if (
        !Number.isInteger(fromIndex) ||
        !Number.isInteger(toIndex) ||
        fromIndex < 0 ||
        fromIndex >= len ||
        toIndex < 0 ||
        toIndex >= len
      ) {
        return false;
      }
      if (fromIndex === toIndex) return true; // no-op
      const [moved] = s.photos.splice(fromIndex, 1);
      s.photos.splice(toIndex, 0, moved);
      bumpExpiry(s);
      emit(sessionId, "photos_reordered", {
        fromIndex,
        toIndex,
        order: s.photos.map((p) => p.index),
      });
      return true;
    },

    setState(sessionId, state): void {
      const s = sessions.get(sessionId);
      if (!s) return;
      if (TERMINAL_STATES.has(s.state)) return;
      const prev = s.state;
      s.state = state;
      // Map state transitions to spec-aligned event types so SSE
      // consumers see the same vocabulary (finalize_requested, finalized,
      // discarded, expired). Anything else falls back to a generic
      // state_changed event.
      switch (state) {
        case "finalizing":
          emit(sessionId, "finalize_requested", {
            photoCount: s.photos.length,
          });
          break;
        case "finalized":
          emit(sessionId, "finalized", {
            pdfPath: s.pdfPath,
            finalizeHandlerOk: true,
          });
          break;
        case "discarded":
          emit(sessionId, "discarded", { source: "system" });
          break;
        case "expired":
          emit(sessionId, "expired", {});
          break;
        default:
          emit(sessionId, "state_changed", { from: prev, to: state });
      }
    },

    setPdfPath(sessionId, p): void {
      const s = sessions.get(sessionId);
      if (!s) return;
      s.pdfPath = p;
      emit(sessionId, "pdf_built", { pdfPath: p });
    },

    extend(sessionId, byMs): number | undefined {
      const s = sessions.get(sessionId);
      if (!s || TERMINAL_STATES.has(s.state)) return undefined;
      if (!Number.isFinite(byMs) || byMs <= 0) return undefined;
      s.expiresAt = s.expiresAt + byMs;
      emit(sessionId, "extended", { byMs, newExpiresAt: s.expiresAt });
      return s.expiresAt;
    },

    markPhoneConnected(sessionId, info): boolean {
      const s = sessions.get(sessionId);
      if (!s) return false;
      if (s.phoneConnectedAt != null) return true;
      s.phoneConnectedAt = now();
      if (info?.userAgent) s.phoneUserAgent = info.userAgent;
      if (info?.ip) s.phoneIp = info.ip;
      emit(sessionId, "phone_connected", {
        userAgent: info?.userAgent,
        ip: info?.ip,
      });
      return true;
    },

    sweepExpired(): number {
      const t = now();
      let count = 0;
      for (const s of sessions.values()) {
        if (TERMINAL_STATES.has(s.state)) continue;
        if (t >= s.expiresAt) {
          s.state = "expired";
          emit(s.sessionId, "expired", {});
          count += 1;
        }
      }
      return count;
    },

    listAll(): CaptureSession[] {
      return [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
    },

    subscribe(fn): () => void {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
}
