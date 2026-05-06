import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { toast } from "sonner";
import { CapturePhotoLightbox } from "../CapturePhotoLightbox.js";
import { useCaptureSession } from "../hooks/useCaptureSession.js";
import { setSessionOwnedByModal } from "../hooks/useCaptureToasts.js";
import type {
  CaptureSessionInfo,
  CaptureStartResponse,
  CaptureState,
  CaptureValidation,
} from "../capture-types.js";
import { ModalChrome } from "./ModalChrome.js";
import { LeftColumn } from "./LeftColumn.js";
import { RightColumn } from "./RightColumn.js";
import { ExpiryFooter } from "./ExpiryFooter.js";
import { isTerminal } from "./utils.js";

/**
 * Operator-side capture modal — wider 2-column layout.
 *
 * Left column (240px):  QR card · LAN URL · shortcode · phone-status
 *                       pill · Finalize / Discard / Retry buttons ·
 *                       expiry timer with extend.
 * Right column (1fr):   live thumbnail mirror grid · validation banner.
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
  shortcode: string;
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
  const [extending, setExtending] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [now, setNow] = useState(() => Date.now());
  const [arrivedIndex, setArrivedIndex] = useState<number | null>(null);

  // Track previously-seen photo indices so we can flag the freshest one
  // for the thumb-enter animation without replaying it on every render.
  const seenIndicesRef = useRef<Set<number>>(new Set());
  const finalizedAtRef = useRef<number | null>(null);

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
          !data.shortcode ||
          !data.expiresAt
        ) {
          throw new Error(data.error ?? "Couldn't start capture session");
        }
        setStarted({
          sessionId: data.sessionId,
          token: data.token,
          captureUrl: data.captureUrl,
          qrSvg: data.qrSvg,
          shortcode: data.shortcode,
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

  // ── Tick clock for expiry display while modal is open
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [open]);

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

  const handleDiscard = useCallback(async () => {
    if (!started) return;
    const photoCount = info?.photos.length ?? 0;
    if (photoCount > 0) {
      const ok = window.confirm(
        `Discard ${photoCount} photo${photoCount === 1 ? "" : "s"}? They'll be deleted.`,
      );
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
  }, [started, info?.photos.length, onOpenChange]);

  const handleExtend = useCallback(async () => {
    if (!started || extending) return;
    setExtending(true);
    try {
      const resp = await fetch("/api/capture/extend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: started.sessionId, byMs: 5 * 60_000 }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { error?: string };
        toast.error("Couldn't extend session", { description: body.error ?? `HTTP ${resp.status}` });
      } else {
        toast.success("Session extended", { description: "+5 min" });
      }
    } finally {
      setExtending(false);
    }
  }, [started, extending]);

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
        <div className="px-[38px] pt-[28px]">
          {/* ───────── Two-column main content ───────── */}
          <div
            className="grid gap-9"
            style={{ gridTemplateColumns: "192px 1fr", alignItems: "start" }}
          >
            <LeftColumn
              state={effectiveState}
              started={started}
              error={error}
              onCopy={handleCopy}
              onCloseAndStartNew={() => onOpenChange(false)}
            />

            <RightColumn
              state={effectiveState}
              started={started}
              info={info}
              validation={validation}
              arrivedIndex={arrivedIndex}
              retrying={retrying}
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

          {/* ───────── Shared bottom row: URL (left) + Expiry (right) ───────── */}
          {started && (
            <div
              className="grid gap-9 mt-4 pb-[26px]"
              style={{ gridTemplateColumns: "192px 1fr", alignItems: "center" }}
            >
              {/* URL field */}
              <div className="w-full">
                <div
                  className="text-center font-sans text-[9.5px] uppercase tracking-[0.10em] mb-1.5 font-medium"
                  style={{ color: "var(--capture-fg-faint)" }}
                >
                  URL
                </div>
                <div
                  className="flex items-baseline gap-3 py-2"
                  style={{ borderBottom: "1px solid var(--capture-border-subtle)" }}
                >
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

              {/* Expiry footer */}
              <ExpiryFooter
                expiresAt={started.expiresAt}
                currentExpiresAt={info?.expiresAt ?? started.expiresAt}
                now={now}
                extending={extending}
                onExtend={handleExtend}
                terminal={isTerminal(effectiveState)}
              />
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
  );
}
