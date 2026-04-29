import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clock,
  Copy,
  Loader2,
  RefreshCw,
  Smartphone,
  Wifi,
  WifiOff,
  XOctagon,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CapturePhotoTile } from "./CapturePhotoTile";
import { CapturePhotoLightbox } from "./CapturePhotoLightbox";
import { useCaptureSession } from "./hooks/useCaptureSession";
import { setSessionOwnedByModal } from "./hooks/useCaptureToasts";
import type {
  CapturePhotoSummary,
  CaptureSessionInfo,
  CaptureStartResponse,
  CaptureState,
  CaptureValidation,
} from "./capture-types";

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

interface StartedSession {
  sessionId: string;
  token: string;
  captureUrl: string;
  qrSvg: string;
  shortcode: string;
  expiresAt: number;
}

const photoSrc = (sessionId: string, index: number) =>
  `/api/capture/photos/${encodeURIComponent(sessionId)}/${index}`;

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

  const info = started ? findSession(started.sessionId) ?? null : null;

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
        className="overflow-hidden p-0 sm:max-w-[760px]"
        // Override shadcn's default surface so capture tokens take over.
        style={{
          backgroundColor: "var(--capture-bg-modal)",
          borderColor: "var(--capture-border-strong)",
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
        />
        <div
          className="grid gap-5 p-6 pt-3"
          style={{ gridTemplateColumns: "240px 1fr" }}
        >
          {/* ───────── Left column ───────── */}
          <LeftColumn
            state={effectiveState}
            started={started}
            error={error}
            info={info}
            now={now}
            sseConnected={sseConnected}
            validation={validation}
            validating={validating}
            retrying={retrying}
            extending={extending}
            onCopy={handleCopy}
            onFinalize={handleFinalize}
            onRetryHandoff={handleRetryHandoff}
            onDiscard={handleDiscard}
            onExtend={handleExtend}
            onCloseAndStartNew={() => onOpenChange(false)}
          />

          {/* ───────── Right column ───────── */}
          <RightColumn
            state={effectiveState}
            started={started}
            info={info}
            validation={validation}
            arrivedIndex={arrivedIndex}
            onPhotoView={(idx) => {
              if (!info) return;
              const arr = info.photos.findIndex((p) => p.index === idx);
              setLightboxIndex(arr);
            }}
            onPhotoDelete={(idx) => handleDeletePhoto(idx)}
          />
        </div>
      </DialogContent>

      {info && (
        <CapturePhotoLightbox
          photos={info.photos}
          activeIndex={lightboxIndex}
          resolveSrc={(p) =>
            started ? photoSrc(started.sessionId, p.index) : ""
          }
          onClose={() => setLightboxIndex(-1)}
          onNavigate={(next) => setLightboxIndex(next)}
        />
      )}
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Modal chrome (header + accent rail per state)
// ─────────────────────────────────────────────────────────────────────────

interface ModalChromeProps {
  state: CaptureState;
  workflow: string;
  workflowLabel?: string;
  contextHint?: string;
}

function ModalChrome({ state, workflow, workflowLabel, contextHint }: ModalChromeProps) {
  const accent = chromAccentColor(state);
  return (
    <>
      {/* Top accent rail */}
      <div
        aria-hidden
        className="h-[3px] w-full transition-colors"
        style={{
          backgroundColor: accent ?? "transparent",
          transitionDuration: "200ms",
          transitionTimingFunction: "var(--cap-ease-smooth)",
        }}
      />
      <DialogHeader className="px-6 pt-5">
        <DialogTitle className="flex items-center gap-2 text-base font-semibold">
          <Smartphone aria-hidden className="h-4 w-4" />
          <span style={{ color: "var(--capture-fg-primary)" }}>
            Capture session
            <span className="px-1" style={{ color: "var(--capture-fg-faint)" }}>
              ·
            </span>
            <span className="font-mono text-sm" style={{ color: "var(--capture-fg-secondary)" }}>
              {workflowLabel ?? workflow}
            </span>
            {contextHint && (
              <>
                <span className="px-1" style={{ color: "var(--capture-fg-faint)" }}>
                  ·
                </span>
                <span className="text-sm" style={{ color: "var(--capture-fg-secondary)" }}>
                  {contextHint}
                </span>
              </>
            )}
          </span>
        </DialogTitle>
        <DialogDescription style={{ color: "var(--capture-fg-muted)" }}>
          Scan the QR with your phone, capture pages, then tap Done. Photos
          mirror here in real time.
        </DialogDescription>
      </DialogHeader>
    </>
  );
}

function chromAccentColor(state: CaptureState): string | null {
  switch (state) {
    case "error":
    case "finalize_failed":
      return "var(--capture-error)";
    case "finalizing":
      return "var(--capture-warn)";
    case "finalized":
      return "var(--capture-success)";
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Left column
// ─────────────────────────────────────────────────────────────────────────

interface LeftColumnProps {
  state: CaptureState;
  started: StartedSession | null;
  error: string | null;
  info: CaptureSessionInfo | null;
  now: number;
  sseConnected: boolean;
  validation: CaptureValidation | null;
  validating: boolean;
  retrying: boolean;
  extending: boolean;
  onCopy: () => void;
  onFinalize: () => void;
  onRetryHandoff: () => void;
  onDiscard: () => void;
  onExtend: () => void;
  onCloseAndStartNew: () => void;
}

function LeftColumn({
  state,
  started,
  error,
  info,
  now,
  sseConnected,
  validation,
  validating,
  retrying,
  extending,
  onCopy,
  onFinalize,
  onRetryHandoff,
  onDiscard,
  onExtend,
  onCloseAndStartNew,
}: LeftColumnProps) {
  if (state === "starting") return <StartingPanel />;
  if (state === "error") return <ErrorPanel message={error ?? "Couldn't start"} onRetry={onCloseAndStartNew} />;
  if (!started) return null;

  const phoneConnected = info?.phoneConnectedAt != null;
  const photoCount = info?.photos.length ?? 0;
  const blockers = validation?.blockers ?? [];
  const finalizeDisabled =
    state !== "open" || validating || blockers.length > 0 || photoCount === 0;

  return (
    <div className="flex flex-col gap-3">
      {/* QR card */}
      <div
        className="mx-auto rounded-md p-3"
        style={{ backgroundColor: "#FFFFFF" }}
        aria-label="QR code for capture URL"
        // dangerouslySetInnerHTML is acceptable: qrSvg is server-generated
        // SVG (we control the input), not user input.
        dangerouslySetInnerHTML={{ __html: started.qrSvg }}
      />
      <div
        className="text-center font-sans text-[11px]"
        style={{ color: "var(--capture-fg-muted)" }}
      >
        Scan with phone camera
      </div>

      {/* URL row */}
      <div className="flex flex-col gap-1">
        <span
          className="font-sans text-[11px] uppercase tracking-wider"
          style={{ color: "var(--capture-fg-faint)" }}
        >
          URL
        </span>
        <div
          className="flex items-center gap-2 rounded-md px-2 py-1.5"
          style={{
            backgroundColor: "var(--capture-bg-raised)",
            borderColor: "var(--capture-border-subtle)",
            borderWidth: 1,
          }}
        >
          <code
            className="flex-1 truncate font-mono text-[12px]"
            style={{ color: "var(--capture-fg-secondary)" }}
            title={started.captureUrl}
          >
            {started.captureUrl}
          </code>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Copy URL"
                onClick={onCopy}
                className="rounded p-1 transition-colors focus-visible:outline-none focus-visible:ring-2"
                style={{
                  color: "var(--capture-fg-muted)",
                  ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
                }}
              >
                <Copy aria-hidden className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Copy URL</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Shortcode */}
      <div className="flex items-baseline gap-2">
        <span
          className="font-sans text-[11px] uppercase tracking-wider"
          style={{ color: "var(--capture-fg-faint)" }}
        >
          Shortcode
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="font-mono text-base font-bold"
              style={{
                color: "var(--capture-fg-primary)",
                letterSpacing: "0.08em",
              }}
            >
              {started.shortcode}
            </span>
          </TooltipTrigger>
          <TooltipContent>Manual entry fallback if QR scan fails</TooltipContent>
        </Tooltip>
      </div>

      {/* Phone status pill */}
      <PhoneStatusPill
        state={state}
        phoneConnected={phoneConnected}
        photoCount={photoCount}
        sseConnected={sseConnected}
      />

      {/* Action row */}
      <ActionRow
        state={state}
        retrying={retrying}
        finalizeDisabled={finalizeDisabled}
        photoCount={photoCount}
        onFinalize={onFinalize}
        onRetryHandoff={onRetryHandoff}
        onDiscard={onDiscard}
        onCloseAndStartNew={onCloseAndStartNew}
      />

      {/* Expiry */}
      <ExpiryFooter
        expiresAt={started.expiresAt}
        currentExpiresAt={info?.expiresAt ?? started.expiresAt}
        now={now}
        extending={extending}
        onExtend={onExtend}
        terminal={isTerminal(state)}
      />
    </div>
  );
}

function StartingPanel() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12">
      <Loader2 aria-hidden className="h-6 w-6 animate-spin" style={{ color: "var(--capture-fg-muted)" }} />
      <span className="font-sans text-sm" style={{ color: "var(--capture-fg-muted)" }}>
        Generating QR code…
      </span>
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-md p-3"
      style={{
        backgroundColor: "var(--capture-error-bg)",
        borderLeft: "2px solid var(--capture-error)",
      }}
    >
      <div className="flex items-center gap-1.5 font-sans text-[11px] uppercase tracking-wider" style={{ color: "var(--capture-error-fg)" }}>
        <XOctagon aria-hidden className="h-3.5 w-3.5" />
        Error
      </div>
      <code
        className="font-mono text-xs leading-relaxed"
        style={{ color: "var(--capture-fg-secondary)" }}
      >
        {message}
      </code>
      <div className="flex gap-2">
        <CtaButton variant="primary" onClick={onRetry}>
          <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          Close
        </CtaButton>
      </div>
    </div>
  );
}

function PhoneStatusPill({
  state,
  phoneConnected,
  photoCount,
  sseConnected,
}: {
  state: CaptureState;
  phoneConnected: boolean;
  photoCount: number;
  sseConnected: boolean;
}) {
  if (isTerminal(state)) return null;

  const tone = pillToneForState(state, phoneConnected);
  const pulse = state === "open" && phoneConnected && photoCount === 0;
  const Icon =
    !sseConnected ? WifiOff
      : state === "finalizing" ? Loader2
      : phoneConnected ? Wifi
      : Smartphone;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-2 rounded-md px-2.5 py-1.5",
        pulse && "capture-anim-connected-pulse",
      )}
      style={{
        backgroundColor: tone.bg,
        color: tone.fg,
        borderLeft: `2px solid ${tone.border}`,
      }}
    >
      <Icon
        aria-hidden
        className={cn("h-4 w-4", state === "finalizing" && "animate-spin")}
      />
      <span className="font-sans text-xs">
        {!sseConnected
          ? "Reconnecting…"
          : state === "finalizing"
            ? "Bundling photos…"
            : phoneConnected
              ? photoCount === 0
                ? "Phone connected · awaiting photos"
                : `Phone connected · ${photoCount} photo${photoCount === 1 ? "" : "s"}`
              : "Waiting for phone to scan QR"}
      </span>
    </div>
  );
}

function pillToneForState(state: CaptureState, phoneConnected: boolean) {
  if (state === "finalizing") {
    return {
      bg: "var(--capture-warn-bg)",
      fg: "var(--capture-warn-fg)",
      border: "var(--capture-warn)",
    };
  }
  if (phoneConnected) {
    return {
      bg: "var(--capture-success-bg)",
      fg: "var(--capture-success-fg)",
      border: "var(--capture-success)",
    };
  }
  return {
    bg: "var(--capture-bg-raised)",
    fg: "var(--capture-fg-muted)",
    border: "var(--capture-border-strong)",
  };
}

function ActionRow({
  state,
  retrying,
  finalizeDisabled,
  photoCount,
  onFinalize,
  onRetryHandoff,
  onDiscard,
  onCloseAndStartNew,
}: {
  state: CaptureState;
  retrying: boolean;
  finalizeDisabled: boolean;
  photoCount: number;
  onFinalize: () => void;
  onRetryHandoff: () => void;
  onDiscard: () => void;
  onCloseAndStartNew: () => void;
}) {
  if (state === "open") {
    return (
      <div className="flex gap-2">
        <CtaButton
          variant="primary"
          onClick={onFinalize}
          disabled={finalizeDisabled}
          className="flex-1"
        >
          <CheckCircle2 aria-hidden className="h-3.5 w-3.5" />
          Finalize
          {photoCount > 0 && (
            <span className="font-mono tabular-nums">· {photoCount}</span>
          )}
        </CtaButton>
        <CtaButton variant="outline" onClick={onDiscard}>
          Discard
        </CtaButton>
      </div>
    );
  }
  if (state === "finalizing") {
    return (
      <div className="flex flex-col gap-2">
        <FinalizingBar />
      </div>
    );
  }
  if (state === "finalized") {
    return (
      <div
        className="flex flex-col gap-1.5 rounded-md p-3"
        style={{
          backgroundColor: "var(--capture-success-bg)",
          borderLeft: "2px solid var(--capture-success)",
          boxShadow: "var(--capture-glow-success)",
        }}
      >
        <div
          className="capture-anim-success-pop flex items-center gap-1.5 font-sans text-[11px] uppercase tracking-wider"
          style={{ color: "var(--capture-success-fg)" }}
        >
          <CheckCircle2 aria-hidden className="h-4 w-4" />
          Done · sent to handler
        </div>
        <span
          className="font-mono text-xs"
          style={{ color: "var(--capture-fg-muted)" }}
        >
          Closing automatically…
        </span>
      </div>
    );
  }
  if (state === "finalize_failed") {
    return (
      <div className="flex flex-col gap-2">
        <CtaButton variant="primary" onClick={onRetryHandoff} disabled={retrying}>
          {retrying ? (
            <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          )}
          Retry handoff
        </CtaButton>
        <CtaButton variant="outline" onClick={onDiscard}>
          Discard
        </CtaButton>
      </div>
    );
  }
  if (state === "expired" || state === "discarded") {
    return (
      <div className="flex gap-2">
        <CtaButton variant="primary" onClick={onCloseAndStartNew} className="flex-1">
          Close
        </CtaButton>
      </div>
    );
  }
  return null;
}

function FinalizingBar() {
  return (
    <div
      className="relative h-1.5 overflow-hidden rounded-full"
      style={{ backgroundColor: "var(--capture-bg-raised)" }}
      role="progressbar"
      aria-label="Bundling photos"
      aria-busy="true"
    >
      <div
        className="capture-anim-finalizing-bar absolute inset-y-0 left-0 w-1/2 rounded-full"
        style={{ backgroundColor: "var(--capture-warn)" }}
      />
    </div>
  );
}

function ExpiryFooter({
  expiresAt,
  currentExpiresAt,
  now,
  extending,
  onExtend,
  terminal,
}: {
  expiresAt: number;
  currentExpiresAt: number;
  now: number;
  extending: boolean;
  onExtend: () => void;
  terminal: boolean;
}) {
  if (terminal) return null;
  const remaining = Math.max(0, currentExpiresAt - now);
  const seconds = Math.ceil(remaining / 1_000);
  const mm = Math.floor(seconds / 60).toString().padStart(2, "0");
  const ss = (seconds % 60).toString().padStart(2, "0");
  const critical = seconds <= 10;
  const warning = !critical && seconds <= 60;

  return (
    <div
      className="flex items-center justify-center gap-2 pt-1 font-mono text-[11px] tabular-nums"
      style={{ color: "var(--capture-fg-muted)" }}
    >
      <Clock aria-hidden className="h-3 w-3" />
      <span
        className={cn(
          "transition-colors",
          warning && "capture-anim-expiry-warn",
          critical && "capture-anim-expiry-critical",
        )}
      >
        {mm}:{ss}
      </span>
      <span style={{ color: "var(--capture-fg-faint)" }}>·</span>
      <button
        type="button"
        onClick={onExtend}
        disabled={extending}
        className="font-sans text-[11px] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50"
        style={{
          color: "var(--capture-fg-secondary)",
          ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
        }}
      >
        {extending ? "extending…" : "extend"}
      </button>
      {/* Hidden invariant: original expiresAt informs default — referenced
          for debugging/audit but not displayed. */}
      <span className="sr-only">Original expiry: {new Date(expiresAt).toLocaleTimeString()}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Right column
// ─────────────────────────────────────────────────────────────────────────

interface RightColumnProps {
  state: CaptureState;
  started: StartedSession | null;
  info: CaptureSessionInfo | null;
  validation: CaptureValidation | null;
  arrivedIndex: number | null;
  onPhotoView: (photoIndex: number) => void;
  onPhotoDelete: (photoIndex: number) => void;
}

function RightColumn({
  state,
  started,
  info,
  validation,
  arrivedIndex,
  onPhotoView,
  onPhotoDelete,
}: RightColumnProps) {
  if (state === "starting" || state === "error") {
    return (
      <div className="flex items-center justify-center" style={{ color: "var(--capture-fg-faint)" }}>
        <span className="font-mono text-xs">—</span>
      </div>
    );
  }

  const photos = info?.photos ?? [];
  const blurFlaggedCount = photos.filter((p) => p.blurFlagged).length;
  const sessionTerminal = isTerminal(state);

  return (
    <div className="flex flex-col gap-3">
      {/* Header strip */}
      <div className="flex items-baseline justify-between gap-2">
        <div
          className="flex items-center gap-2 font-sans text-[11px] uppercase tracking-wider"
          style={{ color: "var(--capture-fg-faint)" }}
          aria-live="polite"
        >
          <span style={{ color: "var(--capture-fg-muted)" }}>Live photos</span>
          <span
            className="font-mono text-[11px] tabular-nums"
            style={{ color: "var(--capture-fg-primary)" }}
          >
            · {photos.length}
          </span>
          <StatePill state={state} />
        </div>
        {photos.length > 0 && !sessionTerminal && (
          <span
            className="font-sans text-[10px]"
            style={{ color: "var(--capture-fg-faint)" }}
          >
            click ✕ to delete
          </span>
        )}
      </div>

      {/* Grid */}
      <div className="grid grid-cols-4 gap-3">
        {photos.map((p) => (
          <CapturePhotoTile
            key={`${p.index}-${p.uploadedAt}`}
            photo={p}
            imageSrc={started ? photoSrc(started.sessionId, p.index) : ""}
            onView={() => onPhotoView(p.index)}
            onDelete={sessionTerminal ? undefined : () => onPhotoDelete(p.index)}
            justArrived={p.index === arrivedIndex}
            disabled={sessionTerminal}
          />
        ))}
        {!sessionTerminal && photos.length < 4 && (
          <PlaceholderTile />
        )}
      </div>

      {/* Validation banner */}
      <ValidationBanner
        validation={validation}
        blurFlaggedCount={blurFlaggedCount}
        photoCount={photos.length}
        active={state === "open"}
      />
    </div>
  );
}

function StatePill({ state }: { state: CaptureState }) {
  const { label, bg, fg } = statePillTone(state);
  return (
    <span
      className="ml-2 inline-block rounded-sm px-1.5 py-0.5 font-sans text-[10px] font-bold uppercase"
      style={{
        backgroundColor: bg,
        color: fg,
        letterSpacing: "0.06em",
        transition: "background-color 200ms var(--cap-ease-smooth), color 200ms var(--cap-ease-smooth)",
      }}
      aria-live="polite"
    >
      {label}
    </span>
  );
}

function statePillTone(state: CaptureState) {
  switch (state) {
    case "starting":
      return { label: "Starting", bg: "var(--capture-bg-raised)", fg: "var(--capture-fg-secondary)" };
    case "error":
      return { label: "Error", bg: "var(--capture-error-bg)", fg: "var(--capture-error-fg)" };
    case "open":
      return { label: "Open", bg: "var(--capture-success-bg)", fg: "var(--capture-success-fg)" };
    case "finalizing":
      return { label: "Finalizing…", bg: "var(--capture-warn-bg)", fg: "var(--capture-warn-fg)" };
    case "finalized":
      return { label: "Done", bg: "var(--capture-success-bg)", fg: "var(--capture-success-fg)" };
    case "finalize_failed":
      return { label: "Handoff failed", bg: "var(--capture-error-bg)", fg: "var(--capture-error-fg)" };
    case "discarded":
      return { label: "Discarded", bg: "var(--capture-bg-raised)", fg: "var(--capture-fg-muted)" };
    case "expired":
      return { label: "Expired", bg: "var(--capture-bg-raised)", fg: "var(--capture-fg-muted)" };
  }
}

function PlaceholderTile() {
  return (
    <div
      className="flex aspect-[3/4] items-center justify-center rounded-md font-sans text-[11px]"
      style={{
        borderWidth: 1.5,
        borderStyle: "dashed",
        borderColor: "var(--capture-border-strong)",
        color: "var(--capture-fg-faint)",
      }}
      aria-hidden
    >
      awaiting…
    </div>
  );
}

function ValidationBanner({
  validation,
  blurFlaggedCount,
  photoCount,
  active,
}: {
  validation: CaptureValidation | null;
  blurFlaggedCount: number;
  photoCount: number;
  active: boolean;
}) {
  if (!active) return null;

  const blockers = validation?.blockers ?? [];
  const warnings = validation?.warnings ?? [];

  // Server-side blockers first.
  if (blockers.length > 0) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md p-3"
        style={{
          backgroundColor: "var(--capture-error-bg)",
          borderLeft: "2px solid var(--capture-error)",
        }}
      >
        <XOctagon
          aria-hidden
          className="mt-0.5 h-4 w-4 shrink-0"
          style={{ color: "var(--capture-error-fg)" }}
        />
        <div className="flex flex-col gap-0.5">
          <span
            className="font-sans text-[11px] uppercase tracking-wider"
            style={{ color: "var(--capture-error-fg)" }}
          >
            Can't finalize
          </span>
          <span className="font-sans text-[13px]" style={{ color: "var(--capture-fg-secondary)" }}>
            {blockers.join(" · ")}
          </span>
        </div>
      </div>
    );
  }

  const allWarnings = [
    ...warnings,
    ...(blurFlaggedCount > 0
      ? [
          `${blurFlaggedCount} photo${blurFlaggedCount === 1 ? "" : "s"} flagged as blurry — review before finalizing`,
        ]
      : []),
  ];

  if (allWarnings.length === 0 || photoCount === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-md p-3"
      style={{
        backgroundColor: "var(--capture-warn-bg)",
        borderLeft: "2px solid var(--capture-warn)",
      }}
    >
      <AlertTriangle
        aria-hidden
        className="mt-0.5 h-4 w-4 shrink-0"
        style={{ color: "var(--capture-warn-fg)" }}
      />
      <div className="flex flex-col gap-0.5">
        <span
          className="font-sans text-[11px] uppercase tracking-wider"
          style={{ color: "var(--capture-warn-fg)" }}
        >
          Heads up
        </span>
        <ul
          className="font-sans text-[13px] leading-relaxed"
          style={{ color: "var(--capture-fg-secondary)" }}
        >
          {allWarnings.map((w, i) => (
            <li key={i}>· {w}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Shared button
// ─────────────────────────────────────────────────────────────────────────

interface CtaButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant: "primary" | "outline";
  children: React.ReactNode;
}

function CtaButton({ variant, className, children, style, ...rest }: CtaButtonProps) {
  const base = cn(
    "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 font-sans text-[13px] transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "cursor-pointer",
    variant === "primary" ? "font-semibold" : "font-medium",
    className,
  );
  const variantStyle =
    variant === "primary"
      ? {
          backgroundColor: "var(--capture-success)",
          color: "hsl(150 80% 5%)",
        }
      : {
          backgroundColor: "transparent",
          color: "var(--capture-fg-secondary)",
          borderColor: "var(--capture-border-strong)",
          borderWidth: 1,
        };
  return (
    <button
      {...rest}
      className={base}
      style={{
        ...variantStyle,
        ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
        ["--tw-ring-offset-color" as string]: "var(--capture-bg-modal)",
        ...style,
      }}
      onMouseOver={(e) => {
        if (variant === "primary") {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--capture-success-hover)";
        } else {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--capture-bg-raised)";
        }
        rest.onMouseOver?.(e);
      }}
      onMouseOut={(e) => {
        if (variant === "primary") {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--capture-success)";
        } else {
          (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
        }
        rest.onMouseOut?.(e);
      }}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────

function isTerminal(state: CaptureState): boolean {
  return (
    state === "finalized" ||
    state === "finalize_failed" ||
    state === "discarded" ||
    state === "expired"
  );
}

// Suppress unused-import warnings — Camera is exported alongside icons in
// case a future variant needs the camera glyph (e.g. "no photos yet" empty state).
void Camera;
