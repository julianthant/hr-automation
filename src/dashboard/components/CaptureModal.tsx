import { useEffect, useState } from "react";
import { CheckCircle2, Copy, Loader2, Smartphone } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Mobile-photo capture modal. Calls `/api/capture/start` with the current
 * workflow, shows the returned QR + URL, polls `/api/capture/sessions`
 * once a second to track photos uploaded + state. Auto-closes a few
 * seconds after the session reaches `finalized`.
 *
 * One instance per click — `open` cycle resets all state.
 */

interface CaptureSessionInfo {
  sessionId: string;
  token: string;
  workflow: string;
  contextHint?: string;
  state: "open" | "finalizing" | "finalized" | "discarded" | "expired";
  photos: Array<{ filename: string; bytes: number }>;
}

interface StartResponse {
  ok: boolean;
  sessionId?: string;
  token?: string;
  captureUrl?: string;
  qrSvg?: string;
  error?: string;
}

interface CaptureModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflow: string;
  /** Free-text hint shown above the photo list on mobile. */
  contextHint?: string;
}

export function CaptureModal({ open, onOpenChange, workflow, contextHint }: CaptureModalProps) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<{
    sessionId: string;
    token: string;
    captureUrl: string;
    qrSvg: string;
  } | null>(null);
  const [info, setInfo] = useState<CaptureSessionInfo | null>(null);

  // Reset on open.
  useEffect(() => {
    if (open) {
      setStarting(false);
      setError(null);
      setSession(null);
      setInfo(null);
    }
  }, [open]);

  // Auto-start on open.
  useEffect(() => {
    if (!open || session || starting) return;
    let cancelled = false;
    (async () => {
      setStarting(true);
      setError(null);
      try {
        const resp = await fetch("/api/capture/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workflow, contextHint }),
        });
        const data = (await resp.json()) as StartResponse;
        if (cancelled) return;
        if (!data.ok || !data.sessionId || !data.token || !data.captureUrl || !data.qrSvg) {
          throw new Error(data.error ?? "capture start failed");
        }
        setSession({
          sessionId: data.sessionId,
          token: data.token,
          captureUrl: data.captureUrl,
          qrSvg: data.qrSvg,
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setStarting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, session, starting, workflow, contextHint]);

  // Poll session state once a second while the modal is open.
  useEffect(() => {
    if (!open || !session) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const resp = await fetch("/api/capture/sessions");
        if (!resp.ok) return;
        const list = (await resp.json()) as CaptureSessionInfo[];
        if (cancelled) return;
        const me = list.find((s) => s.sessionId === session.sessionId);
        if (me) setInfo(me);
      } catch {
        /* network blip — next tick recovers */
      }
    };
    poll();
    const id = setInterval(poll, 1_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open, session]);

  // When the session finalizes, toast + auto-close after 2s so the
  // operator sees the success state but doesn't have to click a button.
  useEffect(() => {
    if (!info) return;
    if (info.state === "finalized") {
      toast.success("Photos uploaded", {
        description: `${info.photos.length} photo${info.photos.length === 1 ? "" : "s"} bundled — prep flow started`,
      });
      const t = setTimeout(() => onOpenChange(false), 2_000);
      return () => clearTimeout(t);
    }
    if (info.state === "discarded") {
      toast.error("Capture discarded", {
        description: "The session was cancelled or bundling failed",
      });
    }
    if (info.state === "expired") {
      toast.warning("Capture expired", {
        description: "The 15-minute window passed without finalization",
      });
    }
  }, [info, onOpenChange]);

  // Discard on explicit close (only if not already terminal).
  const handleClose = async () => {
    if (session && (!info || info.state === "open")) {
      try {
        await fetch("/api/capture/discard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: session.sessionId, reason: "operator closed modal" }),
        });
      } catch {
        /* best-effort */
      }
    }
    onOpenChange(false);
  };

  const photoCount = info?.photos.length ?? 0;
  const stateLabel = info?.state ?? "open";

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : handleClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-4 w-4" aria-hidden />
            Capture from phone
          </DialogTitle>
          <DialogDescription>
            Scan the QR with your phone to upload photos. Tap Done on the phone
            when finished — bundling and OCR start automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {starting && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Starting capture session…
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {session && (
            <>
              <div
                className="mx-auto rounded-md border border-border bg-white p-3"
                aria-label="QR code for capture URL"
                // The QR comes from `qrcode` already validated by the server;
                // dangerouslySetInnerHTML is acceptable here because the
                // payload is a controlled SVG string we generated, not user
                // input.
                dangerouslySetInnerHTML={{ __html: session.qrSvg }}
              />

              <div className="flex flex-col gap-1">
                <span className="text-xs font-mono text-muted-foreground">URL</span>
                <div className="flex items-center gap-2 rounded-md border border-border bg-secondary px-2 py-1.5">
                  <code className="flex-1 truncate font-mono text-xs">
                    {session.captureUrl}
                  </code>
                  <button
                    type="button"
                    aria-label="Copy capture URL"
                    onClick={() => {
                      navigator.clipboard.writeText(session.captureUrl).then(
                        () => toast.info("URL copied"),
                        () => toast.error("Copy failed"),
                      );
                    }}
                    className="rounded p-1 hover:bg-accent"
                  >
                    <Copy className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-md bg-secondary/50 px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  {stateLabel === "finalized" ? (
                    <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
                  ) : (
                    <span
                      className={cn(
                        "inline-block h-2 w-2 rounded-full",
                        stateLabel === "open" && "bg-primary animate-pulse",
                        stateLabel === "finalizing" && "bg-warning animate-pulse",
                        (stateLabel === "discarded" || stateLabel === "expired") &&
                          "bg-destructive",
                      )}
                      aria-hidden
                    />
                  )}
                  <span className="font-mono text-xs uppercase tracking-wider">
                    {stateLabel}
                  </span>
                </div>
                <span className="font-mono text-xs">
                  {photoCount} photo{photoCount === 1 ? "" : "s"}
                </span>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={handleClose}
            className={cn(
              "h-9 rounded-md border border-border px-3 text-sm",
              "hover:bg-accent transition-colors",
            )}
          >
            {info?.state === "finalized" ? "Close" : "Cancel"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
