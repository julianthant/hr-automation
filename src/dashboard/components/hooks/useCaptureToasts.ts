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
 *   1. The first SSE message is treated as history replay (the server
 *      pushes a snapshot on connect); we drop the lastEvent that arrives
 *      with it. Same pattern as useTelegramToasts.
 *
 *   2. When the capture modal mounts, it calls
 *      `setSessionOwnedByModal(sessionId, true)` so this hook ignores
 *      photo_added events for THAT session (the modal already shows them
 *      live in the thumbnail mirror). Terminal events (finalized /
 *      failed / expired) still fire — those are post-close notifications.
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
  const firstEventRef = useRef(true);
  const labelFn = opts.workflowLabel ?? ((w) => w);

  // Stash workflow → label for events whose own payload doesn't carry the
  // workflow name. session_created carries it; photo events carry only the
  // sessionId. We learn the mapping when session_created arrives.
  const workflowBySessionRef = useRef<Map<string, string>>(new Map());

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

      // Skip the first event — it's the snapshot's tail, not a live mutation.
      if (firstEventRef.current) {
        firstEventRef.current = false;
        return;
      }

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
