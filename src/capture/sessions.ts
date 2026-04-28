import { randomBytes, randomUUID } from "node:crypto";

export type CaptureSessionState =
  | "open"
  | "finalizing"
  | "finalized"
  | "discarded"
  | "expired";

export interface CapturedPhoto {
  filename: string;
  bytes: number;
  uploadedAt?: number;
}

export interface CaptureSession {
  sessionId: string;
  token: string;
  workflow: string;
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
  addPhoto(sessionId: string, photo: CapturedPhoto): void;
  removePhoto(sessionId: string, index: number): void;
  setState(sessionId: string, state: CaptureSessionState): void;
  setPdfPath(sessionId: string, path: string): void;
  sweepExpired(): number;
  listAll(): CaptureSession[];
}

export interface CreateStoreOptions {
  now?: () => number;
}

export function createSessionStore(opts: CreateStoreOptions = {}): CaptureSessionStore {
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, CaptureSession>();
  const tokenIndex = new Map<string, string>(); // token → sessionId

  function genToken(): string {
    return randomBytes(12).toString("base64url");
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
      return session;
    },

    getById(sessionId): CaptureSession | undefined {
      return sessions.get(sessionId);
    },

    getByToken(token): CaptureSession | undefined {
      const id = tokenIndex.get(token);
      return id ? sessions.get(id) : undefined;
    },

    addPhoto(sessionId, photo): void {
      const s = sessions.get(sessionId);
      if (!s || TERMINAL_STATES.has(s.state)) return;
      s.photos.push({ ...photo, uploadedAt: now() });
      s.expiresAt = now() + SESSION_TTL_MS;
    },

    removePhoto(sessionId, index): void {
      const s = sessions.get(sessionId);
      if (!s || TERMINAL_STATES.has(s.state)) return;
      if (index < 0 || index >= s.photos.length) return;
      s.photos.splice(index, 1);
    },

    setState(sessionId, state): void {
      const s = sessions.get(sessionId);
      if (!s) return;
      if (TERMINAL_STATES.has(s.state)) return;
      s.state = state;
    },

    setPdfPath(sessionId, p): void {
      const s = sessions.get(sessionId);
      if (!s) return;
      s.pdfPath = p;
    },

    sweepExpired(): number {
      const t = now();
      let count = 0;
      for (const s of sessions.values()) {
        if (TERMINAL_STATES.has(s.state)) continue;
        if (t >= s.expiresAt) {
          s.state = "expired";
          count += 1;
        }
      }
      return count;
    },

    listAll(): CaptureSession[] {
      return [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
    },
  };
}
