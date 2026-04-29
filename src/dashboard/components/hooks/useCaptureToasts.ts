import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Camera, AlertTriangle, CheckCircle2, XOctagon, Clock } from "lucide-react";
import { createElement } from "react";
import type { CaptureSessionEvent } from "../capture-types";

/**
 * Companion to `useTelegramToasts` for capture lifecycle events. Mounted
 * once at the App root so capture activity surfaces toasts even when the
 * modal isn't open.
 *
 * Two suppression rules so toasts don't double up with the modal's own
 * inline UI:
 *
 *   1. Modal-ownership: when the capture modal mounts, it calls
 *      `setSessionOwnedByModal(sessionId, true)` so this hook ignores
 *      photo_added / expired events for THAT session (the modal already
 *      surfaces them inline). Terminal handoff events (finalized /
 *      finalize_failed) still fire — those are post-close notifications.
 *
 *   2. Per-event timestamp dedupe (`lastSeenTsRef`): the backend's
 *      session-event SSE stream doesn't currently replay individual
 *      events on reconnect (only the `session-list` snapshot is
 *      re-broadcast), but the watermark is cheap insurance against
 *      future backend changes. Any event with `ts <= lastSeen` is
 *      treated as a replay and skipped silently.
 *
 * Note: the previous `firstEventRef` defence was unconditional — it
 * dropped the very first session-event of every connection regardless
 * of provenance. That silently swallowed legitimate live events when
 * the dashboard was opened mid-capture. The dedupe-by-timestamp scheme
 * supersedes it: replays are filtered by their (already-seen) ts, while
 * live events pass through unconditionally.
 */

const ownedSessionIds = new Set<string>();

/** Modal entry point — call with `true` on session start, `false` on close. */
export function setSessionOwnedByModal(sessionId: string, owned: boolean): void {
  if (owned) ownedSessionIds.add(sessionId);
  else ownedSessionIds.delete(sessionId);
}

interface CaptureToastsOptions {
  /** Resolve a workflow name to a human label, e.g. "oath-signature" → "Oath signature". */
  workflowLabel?: (workflow: string) => string;
}

export function useCaptureToasts(opts: CaptureToastsOptions = {}): void {
  const labelFn = opts.workflowLabel ?? ((w) => w);
  // Stash workflow → label for events whose own payload doesn't carry the
  // workflow name. session_created carries it; photo events carry only the
  // sessionId. We learn the mapping when session_created arrives.
  const workflowBySessionRef = useRef<Map<string, string>>(new Map());
  // High-water mark of event timestamps (epoch ms) seen by THIS hook
  // lifetime. Filters duplicates from any reconnect snapshot replay
  // (defensive — the current backend doesn't replay individual events,
  // but the cost of one numeric compare per event is trivial).
  const lastSeenTsRef = useRef<number>(0);

  useEffect(() => {
    const es = new EventSource("/api/capture/sessions/stream");

    const remember = (sessionId: string, workflow: string) => {
      if (sessionId && workflow) workflowBySessionRef.current.set(sessionId, workflow);
    };

    const onSnapshot = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { sessions?: Array<{ sessionId: string; workflow: string }> };
        (data.sessions ?? []).forEach((s) => remember(s.sessionId, s.workflow));
      } catch {
        /* ignore */
      }
    };

    const onEvent = (e: MessageEvent) => {
      let ev: CaptureSessionEvent;
      try {
        ev = JSON.parse(e.data) as CaptureSessionEvent;
      } catch {
        return;
      }

      // session_created teaches us the workflow for later events.
      if (ev.type === "session_created") {
        const wf = (ev.payload as { workflow?: string }).workflow;
        if (wf) remember(ev.sessionId, wf);
      }

      // Replay-safe dedupe — skip any event we've already considered.
      if (ev.ts && ev.ts <= lastSeenTsRef.current) return;
      if (ev.ts) lastSeenTsRef.current = ev.ts;

      const isOwned = ownedSessionIds.has(ev.sessionId);
      const workflow = workflowBySessionRef.current.get(ev.sessionId) ?? "capture";
      const label = labelFn(workflow);

      switch (ev.type) {
        case "photo_added": {
          if (isOwned) return;
          const blurFlagged = (ev.payload as { blurFlagged?: boolean }).blurFlagged;
          const photoIndex = (ev.payload as { photoIndex?: number }).photoIndex ?? 0;
          if (blurFlagged) {
            toast.warning("Blurry photo detected", {
              description: `Photo ${photoIndex + 1} in ${label} may need a retake`,
              icon: createElement(AlertTriangle, { "aria-hidden": true, className: "h-4 w-4" }),
            });
          } else {
            toast.info("Photo added", {
              description: `${label} · photo ${photoIndex + 1}`,
              icon: createElement(Camera, { "aria-hidden": true, className: "h-4 w-4" }),
            });
          }
          return;
        }
        case "finalized": {
          const parentRunId = (ev.payload as { parentRunId?: string }).parentRunId;
          toast.success("Capture complete", {
            description: `${label} · bundle saved`,
            icon: createElement(CheckCircle2, { "aria-hidden": true, className: "h-4 w-4" }),
            action: parentRunId
              ? {
                  label: "View",
                  onClick: () => {
                    /* Deep-link is handled by the workflow row; toast just
                       acknowledges. */
                  },
                }
              : undefined,
          });
          return;
        }
        case "finalize_failed": {
          const stage = (ev.payload as { stage?: string }).stage ?? "handler";
          toast.error("Capture handoff failed", {
            description: `${label}: ${stage} failed — retry from the capture modal`,
            icon: createElement(XOctagon, { "aria-hidden": true, className: "h-4 w-4" }),
          });
          return;
        }
        case "expired": {
          if (isOwned) return; // modal will surface it inline
          toast.info("Capture session expired", {
            description: `${label} session timed out after 15 min of inactivity`,
            icon: createElement(Clock, { "aria-hidden": true, className: "h-4 w-4" }),
          });
          return;
        }
        // discarded: no toast — that's a direct user action, no surprise.
        default:
          return;
      }
    };

    const onHeartbeat = () => {
      /* keep-alive only */
    };

    es.addEventListener("session-list", onSnapshot as EventListener);
    es.addEventListener("session-event", onEvent as EventListener);
    es.addEventListener("heartbeat", onHeartbeat);

    es.onerror = () => {
      // EventSource browser default reconnects automatically.
    };

    return () => {
      es.removeEventListener("session-list", onSnapshot as EventListener);
      es.removeEventListener("session-event", onEvent as EventListener);
      es.removeEventListener("heartbeat", onHeartbeat);
      es.close();
    };
  }, [labelFn]);
}
