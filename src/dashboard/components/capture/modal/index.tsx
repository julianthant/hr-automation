import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "@/lib/notify";
import { CapturePhotoLightbox } from "../CapturePhotoLightbox.js";
import { useCaptureSession } from "../../hooks/useCaptureSession.js";
import { setSessionOwnedByModal } from "../../hooks/useCaptureToasts.js";
import type {
  CaptureSessionInfo,
  CaptureStartResponse,
  CaptureState,
  CaptureValidation,
} from "../capture-types.js";
import { useConfirm } from "@/components/shared/useConfirm";
import { LeftColumn } from "./LeftColumn.js";
import { RightColumn } from "./RightColumn.js";
import { ValidationBanner } from "./ValidationBanner.js";
import { CaptureStatusBlock } from "./CaptureStatusBlock.js";
import { CAPTURE_MODAL_GRID_COLS } from "./capture-modal-layout.js";

/**
 * Operator-side capture PANEL — the mobile-photo → PDF → handoff flow,
 * rendered INLINE inside the shared {@link RunModal} as the "Capture photos"
 * upload method (the standalone capture modal + its toolbar camera button were
 * retired 2026-06-29 — capture is now one of two methods the operator picks
 * inside the single Run modal).
 *
 * Layout (wide 2-column):
 *   Left column (auto):  QR square sized to the photo grid + action row height.
 *   Right column (1fr):  live thumbnail mirror grid · actions · validation.
 *
 * State machine (8 states):
 *   starting | error | open (waiting) | open (phone connected) |
 *   finalizing | finalized | finalize_failed | expired
 *
 * SSE-driven via `useCaptureSession` — the panel opens an EventSource while
 * `active` (the Run modal is open AND Capture is the selected method), and
 * `findSession(sessionId)` exposes the live snapshot the reducer keeps current.
 *
 * The panel owns NO chrome (no Dialog, header, or close button) — the host Run
 * modal supplies all of that. The host drives leave/close decisions through the
 * imperative {@link CapturePanelHandle} so an in-flight session is discarded
 * (with a photo-loss confirm) before the operator switches back to file upload
 * or closes the modal.
 */

export interface CapturePanelProps {
  /**
   * Gate: the SSE stream + auto-start run only while active — the Run modal is
   * open AND Capture is the selected upload method. Flipping it false resets the
   * panel and best-effort discards a still-open session.
   */
  active: boolean;
  workflow: string;
  /** From the registry — used for capture toasts/notifications. */
  workflowLabel?: string;
  /** Optional per-invocation hint (free-text) bubbled to the phone. */
  contextHint?: string;
  /** Called when the panel has finished its flow and the host should dismiss. */
  onClosed: () => void;
  /** Mirror lightbox open/closed so the host can guard Esc (lightbox first). */
  onLightboxOpenChange?: (open: boolean) => void;
}

export interface CapturePanelHandle {
  /**
   * Discard-aware "leave capture": when a session is still `open` with photos,
   * prompts the operator before discarding. Returns `true` once it is safe to
   * leave (session discarded / nothing to lose), or `false` if the operator
   * cancelled — the host then stays in capture mode. A finalized/finalizing
   * session is never discarded.
   */
  leaveCapture: () => Promise<boolean>;
}

export interface StartedSession {
  sessionId: string;
  token: string;
  captureUrl: string;
  qrSvg: string;
  expiresAt: number;
}

const discardSession = (sessionId: string, reason: string): void => {
  void fetch("/api/capture/discard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, reason }),
  }).catch(() => {
    /* best effort — server expires the session anyway */
  });
};

export const CapturePanel = forwardRef<CapturePanelHandle, CapturePanelProps>(function CapturePanel(
  { active, workflow, workflowLabel, contextHint, onClosed, onLightboxOpenChange },
  ref,
) {
  void workflowLabel;
  const [phase, setPhase] = useState<"idle" | "starting" | "session" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<StartedSession | null>(null);
  const [validation, setValidation] = useState<CaptureValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [arrivedIndex, setArrivedIndex] = useState<number | null>(null);

  // Track previously-seen photo indices so we can flag the freshest one
  // for the thumb-enter animation without replaying it on every render.
  const seenIndicesRef = useRef<Set<number>>(new Set());
  const finalizedAtRef = useRef<number | null>(null);
  const modalBodyRef = useRef<HTMLDivElement>(null);
  const rightBandRef = useRef<HTMLDivElement>(null);

  // SSE stream — only open while the panel is active.
  const { sessions, lastEvent, connected: sseConnected, findSession } = useCaptureSession({
    enabled: active,
  });
  void sessions;
  void sseConnected;

  const info: CaptureSessionInfo | null = started ? findSession(started.sessionId) ?? null : null;

  const effectiveState: CaptureState = useMemo(() => {
    if (phase === "starting") return "starting";
    if (phase === "error") return "error";
    if (!info) return "open";
    return info.state;
  }, [phase, info]);

  // Live mirrors for the imperative leave/unmount paths (read latest without
  // re-subscribing). A started-but-not-yet-streamed session is server-side
  // `open`, so default to "open" when info hasn't arrived yet.
  const startedRef = useRef<StartedSession | null>(started);
  startedRef.current = started;
  const liveStateRef = useRef<CaptureState | undefined>(undefined);
  liveStateRef.current = info?.state ?? (started ? "open" : undefined);
  const photoCountRef = useRef(0);
  photoCountRef.current = info?.photos.length ?? 0;

  // Mirror lightbox open state to the host (so it can keep Esc from closing the
  // Run modal while a photo preview is open — the lightbox closes first).
  useEffect(() => {
    onLightboxOpenChange?.(lightboxIndex >= 0);
  }, [lightboxIndex, onLightboxOpenChange]);

  // QR is a square exactly as tall as the photo grid + action row (measured on the right).
  useLayoutEffect(() => {
    const band = rightBandRef.current;
    const body = modalBodyRef.current;
    if (!band || !body) return;
    let frame = 0;
    let cancelled = false;
    const sync = (): void => {
      window.cancelAnimationFrame(frame);
      let pass = 0;
      const settle = (): void => {
        if (cancelled) return;
        const h = band.getBoundingClientRect().height;
        if (h <= 0) return;
        const current = Number.parseFloat(body.style.getPropertyValue("--capture-band-h"));
        if (Number.isFinite(current) && Math.abs(current - h) <= 0.01) return;
        body.style.setProperty("--capture-band-h", `${h}px`);
        body.style.setProperty("--capture-qr-col", `${h}px`);
        if (pass < 8) {
          pass += 1;
          frame = window.requestAnimationFrame(settle);
        }
      };
      frame = window.requestAnimationFrame(settle);
    };
    const ro = new ResizeObserver(sync);
    ro.observe(band);
    sync();
    window.addEventListener("resize", sync);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", sync);
      ro.disconnect();
    };
  }, [effectiveState, info?.photos.length, started, validation]);

  // ── Lifecycle: reset when deactivated, kick off when activated
  useEffect(() => {
    if (!active) {
      setPhase("idle");
      setError(null);
      setStarted(null);
      setValidation(null);
      setLightboxIndex(-1);
      seenIndicesRef.current = new Set();
      finalizedAtRef.current = null;
      return;
    }
    if (phase === "idle") setPhase("starting");
  }, [active, phase]);

  // Best-effort discard of a still-open session if the panel unmounts (the host
  // workflow was switched mid-capture, etc.). The leave/close paths discard
  // explicitly first; this is belt-and-braces so a session is never orphaned.
  useEffect(() => {
    return () => {
      const s = startedRef.current;
      if (s && liveStateRef.current === "open") {
        discardSession(s.sessionId, "capture panel unmounted");
      }
    };
  }, []);

  useEffect(() => {
    if (!started) return;
    setSessionOwnedByModal(started.sessionId, true);
    return () => setSessionOwnedByModal(started.sessionId, false);
  }, [started]);

  // ── Auto-start once the panel is active
  useEffect(() => {
    if (!active || started || phase !== "starting") return;
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch("/api/capture/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workflow, contextHint }),
        });
        const data = (await resp.json()) as CaptureStartResponse;
        if (cancelled) return;
        if (
          !resp.ok ||
          !data.ok ||
          !data.sessionId ||
          !data.token ||
          !data.captureUrl ||
          !data.qrSvg ||
          !data.expiresAt
        ) {
          throw new Error(data.error ?? "Couldn't start capture session");
        }
        setStarted({
          sessionId: data.sessionId,
          token: data.token,
          captureUrl: data.captureUrl,
          qrSvg: data.qrSvg,
          expiresAt: data.expiresAt,
        });
        setPhase("session");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, started, phase, workflow, contextHint]);

  // ── Watch for newly-arrived photos via lastEvent so the bounce only
  //    plays for the new tile, not every existing one.
  useEffect(() => {
    if (!info) return;
    const seen = seenIndicesRef.current;
    let freshest: number | null = null;
    for (const p of info.photos) {
      if (!seen.has(p.index)) {
        seen.add(p.index);
        freshest = p.index;
      }
    }
    // Drop indices that were removed.
    const present = new Set(info.photos.map((p) => p.index));
    for (const idx of seen) if (!present.has(idx)) seen.delete(idx);

    if (freshest !== null) {
      setArrivedIndex(freshest);
      const t = window.setTimeout(() => setArrivedIndex(null), 400);
      return () => window.clearTimeout(t);
    }
  }, [info, lastEvent]);

  // ── Validate every time photo count or state changes (cheap server
  //    call; gates the Finalize button per the contracts in the spec).
  //    We deliberately depend on the photo count + state primitives, not
  //    the full info object, so SSE events that don't change either
  //    (e.g. extended) don't re-fire validation.
  const photoCountForValidate = info?.photos.length ?? 0;
  const stateForValidate = info?.state;
  useEffect(() => {
    if (!started || stateForValidate !== "open") {
      setValidation(null);
      return;
    }
    let cancelled = false;
    setValidating(true);
    fetch("/api/capture/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: started.sessionId }),
    })
      .then((r) => (r.ok ? r.json() : { ok: false, blockers: ["Validation request failed"] }))
      .then((data: CaptureValidation) => {
        if (!cancelled) setValidation(data);
      })
      .catch(() => {
        if (!cancelled) setValidation({ ok: false, blockers: ["Validation request failed"] });
      })
      .finally(() => {
        if (!cancelled) setValidating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [started, photoCountForValidate, stateForValidate]);

  // ── Auto-close 2s after finalized (visual direction §2.2)
  useEffect(() => {
    if (info?.state !== "finalized") return;
    if (finalizedAtRef.current !== null) return;
    finalizedAtRef.current = Date.now();
    const t = window.setTimeout(() => onClosed(), 2_000);
    return () => window.clearTimeout(t);
  }, [info?.state, onClosed]);

  // ── Actions
  const handleCopy = useCallback(() => {
    if (!started) return;
    navigator.clipboard.writeText(started.captureUrl).then(
      () => toast.info("URL copied", { description: started.captureUrl }),
      () => toast.error("Copy failed"),
    );
  }, [started]);

  const handleFinalize = useCallback(async () => {
    if (!started) return;
    if (validation && validation.blockers && validation.blockers.length > 0) return;
    try {
      const resp = await fetch("/api/capture/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: started.token }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { error?: string };
        toast.error("Couldn't finalize capture", { description: body.error ?? `HTTP ${resp.status}` });
      }
    } catch (err) {
      toast.error("Couldn't finalize capture", {
        description: err instanceof Error ? err.message : "Network error",
      });
    }
  }, [started, validation]);

  const handleRetryHandoff = useCallback(async () => {
    if (!started || retrying) return;
    setRetrying(true);
    try {
      const resp = await fetch("/api/capture/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: started.token }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { error?: string };
        toast.error("Retry failed", { description: body.error ?? `HTTP ${resp.status}` });
      }
    } finally {
      setRetrying(false);
    }
  }, [started, retrying]);

  const { confirm, confirmDialog } = useConfirm();

  // Single discard-aware "leave" path, shared by the host (switch to upload /
  // close modal) and the in-panel Discard button. Never discards a finalized or
  // finalizing session; confirms before dropping an open session with photos.
  const leaveCapture = useCallback(async (): Promise<boolean> => {
    const s = startedRef.current;
    const st = liveStateRef.current;
    if (!s) return true;
    if (st === "finalized" || st === "finalizing") return true;
    if (st === "open" && photoCountRef.current > 0) {
      const ok = await confirm({
        tone: "destructive",
        title: `Discard ${photoCountRef.current} photo${photoCountRef.current === 1 ? "" : "s"}?`,
        description: "They’ll be deleted.",
        confirmLabel: "Discard",
      });
      if (!ok) return false;
    }
    discardSession(s.sessionId, "operator left capture");
    return true;
  }, [confirm]);

  useImperativeHandle(ref, () => ({ leaveCapture }), [leaveCapture]);

  // Discard button (in-panel) and the expired/error "Close" CTAs both bail out
  // of the whole Run modal.
  const handleDiscardAndClose = useCallback(() => {
    void leaveCapture().then((left) => {
      if (left) onClosed();
    });
  }, [leaveCapture, onClosed]);

  const handleDeletePhoto = useCallback(
    async (index: number) => {
      if (!started) return;
      try {
        const resp = await fetch("/api/capture/delete-photo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: started.token, index }),
        });
        if (!resp.ok) {
          const body = (await resp.json().catch(() => ({}))) as { error?: string };
          toast.error("Couldn't delete photo", { description: body.error ?? `HTTP ${resp.status}` });
        }
      } catch (err) {
        toast.error("Couldn't delete photo", {
          description: err instanceof Error ? err.message : "Network error",
        });
      }
    },
    [started],
  );

  return (
    <>
      <div
        ref={modalBodyRef}
        className="px-[38px] pt-[18px] pb-[26px]"
        style={{
          ["--capture-band-h" as string]: "12rem",
          ["--capture-qr-col" as string]: "var(--capture-band-h)",
        }}
      >
        <div className="flex items-start gap-9">
          <LeftColumn
            state={effectiveState}
            started={started}
            error={error}
            onCopy={handleCopy}
            onCloseAndStartNew={onClosed}
          />

          <div ref={rightBandRef} className="min-w-0 flex-1">
            <RightColumn
              state={effectiveState}
              started={started}
              info={info}
              validation={validation}
              arrivedIndex={arrivedIndex}
              retrying={retrying}
              showValidation={false}
              finalizeDisabled={
                effectiveState !== "open" ||
                validating ||
                (validation?.blockers?.length ?? 0) > 0 ||
                (info?.photos.length ?? 0) === 0
              }
              photoCount={info?.photos.length ?? 0}
              onPhotoView={(idx) => {
                if (!info) return;
                const arr = info.photos.findIndex((p) => p.index === idx);
                setLightboxIndex(arr);
              }}
              onPhotoDelete={(idx) => handleDeletePhoto(idx)}
              onFinalize={handleFinalize}
              onRetryHandoff={handleRetryHandoff}
              onDiscard={handleDiscardAndClose}
              onCloseAndStartNew={onClosed}
            />
          </div>
        </div>

        {started && (
          <div className="mt-4 flex gap-9">
            <div className="shrink-0" style={{ width: "var(--capture-qr-col)" }} aria-hidden />
            <div className="min-w-0 flex-1">
              <ValidationBanner
                validation={validation}
                blurFlaggedCount={info?.photos.filter((p) => p.blurFlagged).length ?? 0}
                photoCount={info?.photos.length ?? 0}
                active={effectiveState === "open"}
              />
            </div>
          </div>
        )}

        {started && (
          <div
            className="mt-4 grid gap-x-9 gap-y-0"
            style={{ gridTemplateColumns: CAPTURE_MODAL_GRID_COLS }}
          >
            <CaptureStatusBlock
              className="min-w-0"
              state={effectiveState}
              phoneConnected={info?.phoneConnectedAt != null}
              photoCount={info?.photos.length ?? 0}
            />
            <div
              className="col-span-2 mt-3.5 border-t"
              style={{ borderColor: "var(--capture-border-subtle)" }}
            />

            <div className="col-span-2 flex min-w-0 items-baseline gap-3 pt-3.5">
              <code
                className="flex-1 truncate font-mono text-[11.5px]"
                style={{ color: "var(--capture-fg-body)" }}
                title={started.captureUrl}
              >
                {started.captureUrl}
              </code>
              <button
                type="button"
                aria-label="Copy URL"
                onClick={handleCopy}
                className="font-sans text-[10px] cursor-pointer hover:underline focus-visible:outline-none focus-visible:ring-2"
                style={{
                  color: "var(--capture-fg-muted)",
                  backgroundColor: "transparent",
                  border: 0,
                  padding: 0,
                  ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
                }}
              >
                Copy
              </button>
            </div>
          </div>
        )}
      </div>

      {info && (
        <CapturePhotoLightbox
          photos={info.photos}
          activeIndex={lightboxIndex}
          resolveSrc={(p) =>
            started ? `/api/capture/photos/${encodeURIComponent(started.sessionId)}/${p.index}` : ""
          }
          onClose={() => setLightboxIndex(-1)}
          onNavigate={(next) => setLightboxIndex(next)}
        />
      )}
      {confirmDialog}
    </>
  );
});
