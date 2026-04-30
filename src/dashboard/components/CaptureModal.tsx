import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  X,
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

function describeStatus(state: CaptureState, phoneConnected: boolean, photoCount: number): string {
  if (state === "finalizing") return "Bundling photos for handoff…";
  if (state === "finalized") return "Sent to handler. Closing automatically…";
  if (state === "finalize_failed") return "Couldn't send to handler.";
  if (state === "expired") return "Session expired.";
  if (state === "discarded") return "Session discarded.";
  if (!phoneConnected) return "Waiting for phone to scan QR.";
  if (photoCount === 0) return "Phone connected — awaiting photos.";
  return `Phone connected — ${photoCount} photo${photoCount === 1 ? "" : "s"} received.`;
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
          className="grid gap-9 px-[38px] pb-[26px] pt-[28px]"
          style={{ gridTemplateColumns: "192px 1fr", alignItems: "start" }}
        >
          {/* ───────── Left column ───────── */}
          <LeftColumn
            state={effectiveState}
            started={started}
            error={error}
            onCopy={handleCopy}
            onCloseAndStartNew={() => onOpenChange(false)}
          />

          {/* ───────── Right column ───────── */}
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
            extending={extending}
            now={now}
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
            onExtend={handleExtend}
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
  onClose: () => void;
}

function ModalChrome({ state, workflow, workflowLabel, contextHint, onClose }: ModalChromeProps) {
  void state; // accent rail removed — state-driven color is gone in C system
  void workflowLabel;
  void contextHint;
  return (
    <DialogHeader className="relative grid gap-3 px-[38px] pt-[36px] pb-0 space-y-0 border-b-0">
      <div
        className="grid items-start gap-6"
        style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}
      >
        <div className="flex flex-col gap-1.5" style={{ maxWidth: 360 }}>
          <DialogTitle
            className="text-[15px] font-normal tracking-[-0.005em]"
            style={{ color: "var(--capture-fg-primary)" }}
          >
            Capture session
          </DialogTitle>
          <DialogDescription
            className="text-[12px] leading-[1.55]"
            style={{ color: "var(--capture-fg-muted)" }}
          >
            Scan the QR with your phone, capture pages, then tap Done.
          </DialogDescription>
        </div>
        <code
          className="font-mono text-[11px] whitespace-nowrap pt-[5px] pr-9"
          style={{ color: "var(--capture-fg-faint)" }}
        >
          {workflow}
        </code>
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute right-[14px] top-[14px] inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2"
        style={{
          backgroundColor: "transparent",
          color: "var(--capture-fg-muted)",
          border: "1px solid transparent",
          ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
        }}
        onMouseOver={(e) => {
          e.currentTarget.style.borderColor = "var(--capture-border-strong)";
          e.currentTarget.style.color = "var(--capture-fg-secondary)";
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.borderColor = "transparent";
          e.currentTarget.style.color = "var(--capture-fg-muted)";
        }}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
      <hr
        aria-hidden
        className="m-0 border-0"
        style={{ borderTop: "1px solid var(--capture-border-subtle)" }}
      />
    </DialogHeader>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Left column
// ─────────────────────────────────────────────────────────────────────────

interface LeftColumnProps {
  state: CaptureState;
  started: StartedSession | null;
  error: string | null;
  onCopy: () => void;
  onCloseAndStartNew: () => void;
}

function LeftColumn({
  state,
  started,
  error,
  onCopy,
  onCloseAndStartNew,
}: LeftColumnProps) {
  if (state === "starting") return <StartingPanel />;
  if (state === "error") return <ErrorPanel message={error ?? "Couldn't start"} onRetry={onCloseAndStartNew} />;
  if (!started) return null;

  return (
    <div className="flex flex-col items-center gap-4">
      {/* QR — server-generated SVG; we control the input.
          Inner SVG ships with width=200; the [&>svg] selector forces it
          to fit the 192px frame regardless of the baked-in attributes. */}
      <div
        className="rounded-[10px] p-[14px] [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
        style={{ backgroundColor: "#FFFFFF", width: 192, height: 192 }}
        aria-label="QR code for capture URL"
        dangerouslySetInnerHTML={{ __html: started.qrSvg }}
      />

      {/* Shortcode — manual fallback if the QR can't be scanned. */}
      <div
        className="font-mono text-[28px] font-light"
        style={{
          color: "var(--capture-fg-primary)",
          letterSpacing: "0.14em",
          lineHeight: 1.1,
        }}
        aria-label={`Manual entry shortcode ${started.shortcode}`}
      >
        {started.shortcode}
      </div>

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
            onClick={onCopy}
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
    </div>
  );
}

function StartingPanel() {
  return (
    <div className="flex w-full flex-col items-center justify-center gap-3 py-12">
      <Loader2 aria-hidden className="h-6 w-6 animate-spin" style={{ color: "var(--capture-fg-muted)" }} />
      <span className="font-sans text-[12px]" style={{ color: "var(--capture-fg-muted)" }}>
        Generating QR code…
      </span>
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex w-full flex-col gap-3 rounded-md p-3"
      style={{
        border: "1px solid var(--capture-border-subtle)",
        borderLeft: "2px solid var(--capture-error)",
        backgroundColor: "transparent",
      }}
    >
      <div
        className="flex items-center gap-1.5 font-sans text-[9.5px] uppercase tracking-[0.10em] font-medium"
        style={{ color: "var(--capture-fg-muted)" }}
      >
        <XOctagon aria-hidden className="h-3.5 w-3.5" />
        Error
      </div>
      <code className="font-mono text-xs leading-relaxed" style={{ color: "var(--capture-fg-body)" }}>
        {message}
      </code>
      <CtaButton variant="primary" onClick={onRetry}>
        <RefreshCw aria-hidden className="h-3.5 w-3.5" />
        Close
      </CtaButton>
    </div>
  );
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
  void photoCount; // reserved for a future "Finalize · N" UI if it returns.
  if (state === "open") {
    return (
      <div className="grid grid-cols-4 gap-2.5">
        <CtaButton
          variant="primary"
          onClick={onFinalize}
          disabled={finalizeDisabled}
          style={{ gridColumn: "span 3" }}
        >
          Finalize
        </CtaButton>
        <CtaButton variant="outline" onClick={onDiscard} style={{ gridColumn: "span 1" }}>
          Discard
        </CtaButton>
      </div>
    );
  }
  if (state === "finalizing") {
    return <FinalizingBar />;
  }
  if (state === "finalized") {
    return (
      <div
        className="flex flex-col gap-1.5 rounded-md p-3"
        style={{
          border: "1px solid var(--capture-border-subtle)",
          borderLeft: "2px solid var(--capture-border-cta-strong)",
          backgroundColor: "transparent",
        }}
      >
        <div
          className="flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.10em] font-medium"
          style={{ color: "var(--capture-fg-secondary)" }}
        >
          <CheckCircle2 aria-hidden className="h-4 w-4" />
          Done · sent to handler
        </div>
        <span className="font-mono text-xs" style={{ color: "var(--capture-fg-muted)" }}>
          Closing automatically…
        </span>
      </div>
    );
  }
  if (state === "finalize_failed") {
    return (
      <div className="grid grid-cols-4 gap-2.5">
        <CtaButton
          variant="primary"
          onClick={onRetryHandoff}
          disabled={retrying}
          style={{ gridColumn: "span 3" }}
        >
          {retrying ? (
            <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          )}
          Retry handoff
        </CtaButton>
        <CtaButton variant="outline" onClick={onDiscard} style={{ gridColumn: "span 1" }}>
          Discard
        </CtaButton>
      </div>
    );
  }
  if (state === "expired" || state === "discarded") {
    return (
      <div className="grid grid-cols-4 gap-2.5">
        <CtaButton
          variant="primary"
          onClick={onCloseAndStartNew}
          style={{ gridColumn: "span 4" }}
        >
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
      className="relative h-[1.5px] w-full overflow-hidden rounded-full"
      style={{ backgroundColor: "var(--capture-border-subtle)" }}
      role="progressbar"
      aria-label="Bundling photos"
      aria-busy="true"
    >
      <div
        className="absolute inset-y-0 left-0 w-1/2 rounded-full"
        style={{
          backgroundColor: "var(--capture-fg-body)",
          animation: "finalizing-strip 1.6s var(--cap-ease-smooth) infinite",
        }}
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
      className="flex items-center justify-between text-[11.5px] pt-3.5"
      style={{
        borderTop: "1px solid var(--capture-border-subtle)",
        color: "var(--capture-fg-muted)",
      }}
    >
      <span className="flex items-center gap-2">
        <span
          className={cn(
            "font-mono tabular-nums transition-colors",
            warning && "capture-anim-expiry-warn",
            critical && "capture-anim-expiry-critical",
          )}
          style={{ color: "var(--capture-fg-secondary)" }}
        >
          {mm}:{ss}
        </span>
        <span>remaining</span>
      </span>
      <button
        type="button"
        onClick={onExtend}
        disabled={extending}
        className="font-sans text-[11.5px] cursor-pointer hover:underline focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50"
        style={{
          color: "var(--capture-fg-secondary)",
          backgroundColor: "transparent",
          border: 0,
          padding: 0,
          ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
        }}
      >
        {extending ? "extending…" : "Extend"}
      </button>
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
  retrying: boolean;
  finalizeDisabled: boolean;
  photoCount: number;
  extending: boolean;
  now: number;
  onPhotoView: (photoIndex: number) => void;
  onPhotoDelete: (photoIndex: number) => void;
  onFinalize: () => void;
  onRetryHandoff: () => void;
  onDiscard: () => void;
  onCloseAndStartNew: () => void;
  onExtend: () => void;
}

function RightColumn({
  state,
  started,
  info,
  validation,
  arrivedIndex,
  retrying,
  finalizeDisabled,
  photoCount,
  extending,
  now,
  onPhotoView,
  onPhotoDelete,
  onFinalize,
  onRetryHandoff,
  onDiscard,
  onCloseAndStartNew,
  onExtend,
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
  const phoneConnected = info?.phoneConnectedAt != null;

  return (
    <div className="flex flex-col gap-[22px]">
      {/* STATUS */}
      <div>
        <div
          className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-1"
          style={{ color: "var(--capture-fg-faint)" }}
        >
          Status
        </div>
        <div
          className="flex items-center gap-2.5 py-1 text-[12px]"
          style={{ color: "var(--capture-fg-secondary)" }}
          aria-live="polite"
        >
          <span
            className="inline-block h-[5px] w-[5px] rounded-full shrink-0"
            style={{ backgroundColor: "var(--capture-fg-secondary)" }}
            aria-hidden
          />
          <span>{describeStatus(state, phoneConnected, photos.length)}</span>
        </div>
      </div>

      {/* PHOTOS */}
      <div>
        <div
          className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-2"
          style={{ color: "var(--capture-fg-faint)" }}
        >
          Live photos · <span className="font-mono tabular-nums" style={{ color: "var(--capture-fg-secondary)" }}>{photos.length}</span>
        </div>
        <div className="grid grid-cols-4 gap-2.5">
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
          {!sessionTerminal &&
            Array.from({ length: Math.max(0, 4 - photos.length) }).map((_, i) => (
              <PlaceholderTile key={`ph-${i}`} />
            ))}
        </div>
      </div>

      <ValidationBanner
        validation={validation}
        blurFlaggedCount={blurFlaggedCount}
        photoCount={photos.length}
        active={state === "open"}
      />

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

      <ExpiryFooter
        expiresAt={started?.expiresAt ?? 0}
        currentExpiresAt={info?.expiresAt ?? started?.expiresAt ?? 0}
        now={now}
        extending={extending}
        onExtend={onExtend}
        terminal={isTerminal(state)}
      />
    </div>
  );
}

function PlaceholderTile() {
  return (
    <div
      className="aspect-[3/4] rounded-md"
      style={{
        border: "1px solid var(--capture-border-subtle)",
        backgroundColor: "transparent",
      }}
      aria-hidden
    />
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

  if (blockers.length > 0) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md p-3"
        style={{
          border: "1px solid var(--capture-border-subtle)",
          borderLeft: "2px solid var(--capture-error)",
          backgroundColor: "transparent",
        }}
      >
        <XOctagon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--capture-fg-muted)" }} />
        <div className="flex flex-col gap-0.5">
          <span
            className="text-[9.5px] uppercase tracking-[0.10em] font-medium"
            style={{ color: "var(--capture-fg-muted)" }}
          >
            Can't finalize
          </span>
          <span className="font-sans text-[13px]" style={{ color: "var(--capture-fg-body)" }}>
            {blockers.join(" · ")}
          </span>
        </div>
      </div>
    );
  }

  const allWarnings = [
    ...warnings,
    ...(blurFlaggedCount > 0
      ? [`${blurFlaggedCount} photo${blurFlaggedCount === 1 ? "" : "s"} flagged as blurry — review before finalizing`]
      : []),
  ];
  if (allWarnings.length === 0 || photoCount === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-md p-3"
      style={{
        border: "1px solid var(--capture-border-subtle)",
        borderLeft: "2px solid var(--capture-warn)",
        backgroundColor: "transparent",
      }}
    >
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--capture-warn)" }} />
      <div className="flex flex-col gap-0.5">
        <span
          className="text-[9.5px] uppercase tracking-[0.10em] font-medium"
          style={{ color: "var(--capture-fg-muted)" }}
        >
          Heads up
        </span>
        <ul className="font-sans text-[13px] leading-relaxed" style={{ color: "var(--capture-fg-body)" }}>
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
  const isPrimary = variant === "primary";
  const base = cn(
    "inline-flex items-center justify-center gap-1.5 rounded-[7px] px-3.5 py-2.5 font-sans text-[12.5px] font-medium",
    "border transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
    "disabled:cursor-not-allowed",
    "cursor-pointer",
    className,
  );
  const variantStyle = isPrimary
    ? {
        backgroundColor: "transparent",
        color: "var(--capture-fg-primary)",
        borderColor: "var(--capture-border-cta)",
      }
    : {
        backgroundColor: "transparent",
        color: "var(--capture-fg-muted)",
        borderColor: "var(--capture-border-subtle)",
      };
  const disabledStyle = rest.disabled
    ? {
        color: "var(--capture-fg-faint)",
        borderColor: "var(--capture-border-subtle)",
        cursor: "not-allowed" as const,
      }
    : {};
  return (
    <button
      {...rest}
      className={base}
      style={{
        ...variantStyle,
        ...disabledStyle,
        ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
        ["--tw-ring-offset-color" as string]: "var(--capture-bg-modal)",
        ...style,
      }}
      onMouseOver={(e) => {
        if (!rest.disabled) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = isPrimary
            ? "var(--capture-border-cta-strong)"
            : "var(--capture-border-cta)";
        }
        rest.onMouseOver?.(e);
      }}
      onMouseOut={(e) => {
        if (!rest.disabled) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = isPrimary
            ? "var(--capture-border-cta)"
            : "var(--capture-border-subtle)";
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

