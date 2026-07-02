/**
 * Frontend-only type definitions for the capture feature.
 *
 * These mirror the server-side shapes documented in the structural spec
 * (`docs/superpowers/specs/2026-04-28-capture-redesign-design.md` §"API
 * surface" and §"TypeScript interfaces"). The backend is the source of
 * truth — this file exists so the dashboard surfaces don't each redeclare
 * the same shapes inline.
 */

/** Operator-visible state of a capture session. */
export type CaptureState =
  | "starting"          // client-side phase: POST /api/capture/start in flight
  | "error"             // client-side phase: start failed
  | "open"              // server-side: session active, awaiting / accepting photos
  | "finalizing"        // server-side: bundling PDF + running finalize handler
  | "finalized"         // terminal: handler succeeded
  | "finalize_failed"   // terminal: bundle ok but handler threw — retry available
  | "discarded"         // terminal: operator or system cancelled
  | "expired";          // terminal: idle 15 min

/** Per-photo metadata pushed to the dashboard via session-event SSE. */
export interface CapturePhotoSummary {
  index: number;
  filename: string;
  sizeBytes: number;
  mime: string;
  uploadedAt: number;
  blurScore?: number;
  blurFlagged?: boolean;
}

/** Snapshot of a session as the dashboard understands it. */
export interface CaptureSessionInfo {
  sessionId: string;
  workflow: string;
  contextHint?: string;
  state: CaptureState;
  createdAt: number;
  expiresAt: number;
  /** Set when the phone first GETs /api/capture/manifest/:token. */
  phoneConnectedAt: number | null;
  photos: CapturePhotoSummary[];
  pdfPath?: string;
  parentRunId?: string;
  /** Populated when state === "finalize_failed" or transient error events. */
  errorMessage?: string;
}

/**
 * One JSONL line worth of mutation. Subscribers reduce these into the
 * session list locally; the server may also push a fresh snapshot.
 */
export interface CaptureSessionEvent {
  ts: number;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
}

/** Frontend-visible registration entry from GET /api/capture/registry. */
export interface CaptureRegistration {
  workflow: string;
  label: string;
  contextHints?: string[];
}

/** Result of POST /api/capture/validate — gates the Finalize CTA. */
export interface CaptureValidation {
  ok: boolean;
  warnings?: string[];
  blockers?: string[];
}

/** Response shape from POST /api/capture/start. */
export interface CaptureStartResponse {
  ok: boolean;
  sessionId?: string;
  token?: string;
  captureUrl?: string;
  qrSvg?: string;
  shortcode?: string;
  expiresAt?: number;
  error?: string;
}
