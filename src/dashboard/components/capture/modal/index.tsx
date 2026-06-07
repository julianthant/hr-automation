import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { toast } from "sonner";
import { CapturePhotoLightbox } from "../CapturePhotoLightbox.js";
import { useCaptureSession } from "../../hooks/useCaptureSession.js";
import { setSessionOwnedByModal } from "../../hooks/useCaptureToasts.js";
import type {
  CaptureSessionInfo,
  CaptureStartResponse,
  CaptureState,
  CaptureValidation,
} from "../capture-types.js";
import { ModalChrome } from "./ModalChrome.js";
import { useConfirm } from "@/components/shared/useConfirm";
import { LeftColumn } from "./LeftColumn.js";
import { RightColumn } from "./RightColumn.js";
import { ValidationBanner } from "./ValidationBanner.js";
import { CaptureStatusBlock } from "./CaptureStatusBlock.js";
import { CAPTURE_MODAL_GRID_COLS } from "./capture-modal-layout.js";

/**
 * Operator-side capture modal — wider 2-column layout.
 *
 * Left column (auto):  QR square sized to the photo grid + action row height.
 * Right column (1fr):   live thumbnail mirror grid · actions · validation
 *                       on the row below.
 *
 * State machine (8 states from visual direction §3):
 *   starting | error | open (waiting) | open (phone connected) |
 *   finalizing | finalized | finalize_failed | expired
 *
 * SSE-driven via `useCaptureSession` — the modal opens an EventSource
 * for the duration of the dialog, and `findSession(sessionId)` exposes
 * the live snapshot that the reducer keeps current. The previous 1s
 * polling loop is gone.
 */

export interface CaptureModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflow: string;
  /** From the registry — shown in the dialog title. */
  workflowLabel?: string;
  /** Optional per-invocation hint (free-text) bubbled to the phone. */
  contextHint?: string;
}

export interface StartedSession {
  sessionId: string;
  token: string;
  captureUrl: string;
  qrSvg: string;
  expiresAt: number;
}

export function CaptureModal({
  open,
  onOpenChange,
  workflow,
  workflowLabel,
  contextHint,
}: CaptureModalProps) {
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

  // SSE stream — only open while dialog is open.
  const { sessions, lastEvent, connected: sseConnected, findSession } = useCaptureSession({
    enabled: open,
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

  // ── Lifecycle: reset on open, register-with-toast-hook, unregister
  useEffect(() => {
    if (!open) {
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
  }, [open, phase]);

  useEffect(() => {
    if (!started) return;
    setSessionOwnedByModal(started.sessionId, true);
    return () => setSessionOwnedByModal(started.sessionId, false);
  }, [started]);

  // ── Auto-start on dialog open
  useEffect(() => {
    if (!open || started || phase !== "starting") return;
    let cancelled = false;
    (async () => {
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
  }, [open, started, phase, workflow, contextHint]);

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
    const t = window.setTimeout(() => onOpenChange(false), 2_000);
    return () => window.clearTimeout(t);
  }, [info?.state, onOpenChange]);

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

  const handleDiscard = useCallback(async () => {
    if (!started) return;
    const photoCount = info?.photos.length ?? 0;
    if (photoCount > 0) {
      const ok = await confirm({
        tone: "destructive",
        title: `Discard ${photoCount} photo${photoCount === 1 ? "" : "s"}?`,
        description: "They’ll be deleted.",
        confirmLabel: "Discard",
      });
      if (!ok) return;
    }
    try {
      await fetch("/api/capture/discard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: started.sessionId, reason: "operator closed modal" }),
      });
    } catch {
      /* best effort */
    }
    onOpenChange(false);
  }, [started, info?.photos.length, onOpenChange, confirm]);

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

  // Discard-and-close on dialog X / Esc
  const handleClose = useCallback(() => {
    if (started && info && info.state === "open") {
      handleDiscard();
      return;
    }
    onOpenChange(false);
  }, [started, info, handleDiscard, onOpenChange]);

  return (
    <>
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : handleClose())}>
      <DialogContent
        hideClose
        className="overflow-hidden p-0 sm:max-w-[760px] gap-0"
        // Override shadcn's default surface so capture tokens take over.
        style={{
          backgroundColor: "var(--capture-bg-modal)",
          borderColor: "var(--capture-border-subtle)",
          color: "var(--capture-fg-primary)",
        }}
        onEscapeKeyDown={(e) => {
          // Always preventDefault; we orchestrate close manually so Esc
          // can step out of the lightbox before stepping out of the modal.
          e.preventDefault();
          if (lightboxIndex >= 0) {
            setLightboxIndex(-1);
            return;
          }
          handleClose();
        }}
      >
        <ModalChrome
          state={effectiveState}
          workflow={workflow}
          workflowLabel={workflowLabel}
          contextHint={info?.contextHint ?? contextHint}
          onClose={handleClose}
        />
        <div
          ref={modalBodyRef}
          className="px-[38px] pt-[28px] pb-[26px]"
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
              onCloseAndStartNew={() => onOpenChange(false)}
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
              onDiscard={handleDiscard}
              onCloseAndStartNew={() => onOpenChange(false)}
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
      </DialogContent>

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
    </Dialog>
    {confirmDialog}
    </>
  );
}
