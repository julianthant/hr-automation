import { useEffect, useReducer, useRef } from "react";
import type {
  CapturePhotoSummary,
  CaptureSessionEvent,
  CaptureSessionInfo,
} from "@/components/capture/capture-types";
import { sseHub } from "@/lib/sse-hub";

/**
 * Subscribes to `/api/capture/sessions/stream` (SSE) and maintains a
 * locally-reduced list of capture sessions. Replaces the previous 1s
 * polling loop with sub-100ms event push.
 *
 * Three SSE event types per the structural spec:
 * - `session-list`  — full snapshot, replaces local state. Sent on
 *   connect AND any time the server wants to re-baseline.
 * - `session-event` — one mutation; reduced into local state.
 * - `heartbeat`     — keep-alive, ignored.
 *
 * Reducer mirrors the server's reduction rules. If the server pushes
 * an event for an unknown session, we no-op and wait for the next
 * snapshot to reconcile (defensive — an event-only stream with a
 * dropped reconnect could otherwise build phantom sessions).
 */

interface State {
  sessions: CaptureSessionInfo[];
  lastEvent: CaptureSessionEvent | null;
  connected: boolean;
}

type Action =
  | { type: "snapshot"; sessions: CaptureSessionInfo[] }
  | { type: "event"; event: CaptureSessionEvent }
  | { type: "open" }
  | { type: "close" };

const initialState: State = { sessions: [], lastEvent: null, connected: false };

function reduceSession(s: CaptureSessionInfo, ev: CaptureSessionEvent): CaptureSessionInfo {
  const p = ev.payload;
  switch (ev.type) {
    case "phone_connected":
      return {
        ...s,
        phoneConnectedAt: ev.ts,
        ...(
          typeof (p as { expiresAt?: unknown }).expiresAt === "number"
            ? { expiresAt: (p as { expiresAt: number }).expiresAt }
            : {}
        ),
      };
    case "photo_added": {
      const photo = p as unknown as CapturePhotoSummary;
      const existing = s.photos.findIndex((x) => x.index === photo.index);
      const photos = existing === -1 ? [...s.photos, photo] : s.photos.map((x, i) => (i === existing ? photo : x));
      return { ...s, photos };
    }
    case "photo_removed": {
      const idx = (p as { photoIndex?: number }).photoIndex;
      if (typeof idx !== "number") return s;
      return { ...s, photos: s.photos.filter((x) => x.index !== idx) };
    }
    case "photo_replaced": {
      const idx = (p as { photoIndex?: number }).photoIndex;
      if (typeof idx !== "number") return s;
      const photos = s.photos.map((x) => {
        if (x.index !== idx) return x;
        const blurFlagged = (p as { blurFlagged?: boolean }).blurFlagged;
        const blurScore = (p as { blurScore?: number }).blurScore;
        const newFilename = (p as { newFilename?: string }).newFilename;
        return {
          ...x,
          ...(typeof blurFlagged === "boolean" ? { blurFlagged } : {}),
          ...(typeof blurScore === "number" ? { blurScore } : {}),
          ...(newFilename ? { filename: newFilename, uploadedAt: ev.ts } : {}),
        };
      });
      return { ...s, photos };
    }
    case "finalize_requested":
      return { ...s, state: "finalizing" };
    case "pdf_built": {
      const pdfPath = (p as { pdfPath?: string }).pdfPath;
      return pdfPath ? { ...s, pdfPath } : s;
    }
    case "finalized": {
      const parentRunId = (p as { parentRunId?: string }).parentRunId;
      return {
        ...s,
        state: "finalized",
        ...(parentRunId ? { parentRunId } : {}),
      };
    }
    case "finalize_failed": {
      const error = (p as { error?: string }).error;
      return {
        ...s,
        state: "finalize_failed",
        ...(error ? { errorMessage: error } : {}),
      };
    }
    case "discarded":
      return { ...s, state: "discarded" };
    case "expired":
      return { ...s, state: "expired" };
    default:
      return s;
  }
}

function reduceState(state: State, action: Action): State {
  switch (action.type) {
    case "snapshot":
      return { ...state, sessions: action.sessions };
    case "open":
      return { ...state, connected: true };
    case "close":
      return { ...state, connected: false };
    case "event": {
      const ev = action.event;
      // session_created starts a new entry — payload contains all the
      // fields needed to construct a CaptureSessionInfo.
      if (ev.type === "session_created") {
        const p = ev.payload as Partial<CaptureSessionInfo> & {
          workflow?: string;
          expiresAt?: number;
          contextHint?: string;
        };
        const exists = state.sessions.some((s) => s.sessionId === ev.sessionId);
        if (exists) return { ...state, lastEvent: ev };
        const fresh: CaptureSessionInfo = {
          sessionId: ev.sessionId,
          workflow: p.workflow ?? "",
          contextHint: p.contextHint,
          state: "open",
          createdAt: ev.ts,
          expiresAt: p.expiresAt ?? ev.ts,
          phoneConnectedAt: null,
          photos: [],
        };
        return { ...state, lastEvent: ev, sessions: [...state.sessions, fresh] };
      }

      const idx = state.sessions.findIndex((s) => s.sessionId === ev.sessionId);
      if (idx === -1) return { ...state, lastEvent: ev };
      const next = [...state.sessions];
      next[idx] = reduceSession(next[idx], ev);
      return { ...state, lastEvent: ev, sessions: next };
    }
    default:
      return state;
  }
}

export interface UseCaptureSessionResult {
  sessions: CaptureSessionInfo[];
  lastEvent: CaptureSessionEvent | null;
  connected: boolean;
  /** Look up a single session by id. */
  findSession: (sessionId: string) => CaptureSessionInfo | undefined;
}

/**
 * Subscribes when `enabled` is true. The capture modal flips it on
 * when the dialog opens and off when it closes — the SSE connection
 * stays scoped to the surface that actually renders sessions.
 */
export function useCaptureSession(opts: { enabled?: boolean } = {}): UseCaptureSessionResult {
  const [state, dispatch] = useReducer(reduceState, initialState);
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const enabled = opts.enabled !== false;

  useEffect(() => {
    if (!enabled) return;

    const unsubscribe = sseHub.subscribe<unknown>(
      "captureSessions",
      {},
      (data, event) => {
        if (event === "session-list") {
          try {
            const snapshot = data as { sessions?: CaptureSessionInfo[] };
            dispatchRef.current({ type: "snapshot", sessions: snapshot.sessions ?? [] });
          } catch {
            /* malformed payload — ignore, snapshot is idempotent */
          }
          // First message also signals a successful connection.
          dispatchRef.current({ type: "open" });
          return;
        }

        if (event === "heartbeat") {
          /* keep-alive only */
          return;
        }

        if (event === "session-event") {
          try {
            const ev = data as CaptureSessionEvent;
            dispatchRef.current({ type: "event", event: ev });
          } catch {
            /* ignore */
          }
          return;
        }
      },
      () => dispatchRef.current({ type: "close" }),
    );

    return () => {
      unsubscribe();
    };
  }, [enabled]);

  return {
    sessions: state.sessions,
    lastEvent: state.lastEvent,
    connected: state.connected,
    findSession: (id) => state.sessions.find((s) => s.sessionId === id),
  };
}
