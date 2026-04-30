import { useEffect, useRef, useState } from "react";
import { AlertCircle, FileText, Loader2, UploadCloud, X } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSharePointDownload } from "./hooks/useSharePointDownload";
import { cn } from "@/lib/utils";

/**
 * Modal for the emergency-contact "Run" flow. Two inputs:
 *   1. PDF (drag-drop or click-to-browse)
 *   2. Roster mode — use latest local roster, or download a fresh one.
 *
 * On submit: POST multipart/form-data to /api/emergency-contact/prepare,
 * which fire-and-forgets `runPrepare` and returns `{ok, parentRunId}`.
 * The dashboard's normal SSE loop picks up the prep tracker row and the
 * QueuePanel renders it via PreviewRow.
 */
interface RosterListing {
  filename: string;
  path: string;
  bytes: number;
  modifiedAt: string;
}

interface RunModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RunModal({ open, onOpenChange }: RunModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [rosterMode, setRosterMode] = useState<"download" | "existing">("existing");
  const [rosters, setRosters] = useState<RosterListing[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLLabelElement>(null);
  const sharePoint = useSharePointDownload("ONBOARDING_ROSTER");

  // Fetch rosters on open. Refresh every time the modal opens so a
  // SharePoint download that finished while the modal was closed is
  // reflected.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/rosters");
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as RosterListing[];
        if (cancelled) return;
        setRosters(data);
        // Auto-flip to download if no roster is on disk.
        if (data.length === 0) setRosterMode("download");
      } catch (err) {
        if (!cancelled) {
          setRosters([]);
          setRosterMode("download");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset form state on close.
  useEffect(() => {
    if (open) return;
    setFile(null);
    setSubmitting(false);
    setProgress(null);
    setError(null);
  }, [open]);

  function handleFileSelect(picked: File | null): void {
    setError(null);
    if (!picked) return setFile(null);
    if (!picked.name.toLowerCase().endsWith(".pdf") && picked.type !== "application/pdf") {
      setError("PDF rejected: file is not a valid application/pdf.");
      return;
    }
    if (picked.size > 50 * 1024 * 1024) {
      setError("File too large (max 50 MB).");
      return;
    }
    setFile(picked);
  }

  function handleDrop(e: React.DragEvent<HTMLLabelElement>): void {
    e.preventDefault();
    e.stopPropagation();
    dropRef.current?.classList.remove("bg-primary/5", "border-primary");
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) handleFileSelect(dropped);
  }

  async function handleSubmit(): Promise<void> {
    if (!file || submitting) return;
    setSubmitting(true);
    setProgress(0);
    setError(null);

    // If the operator picked "Download fresh from SharePoint", fire the
    // download FIRST and wait for it to complete before uploading the
    // PDF. Re-fetch /api/rosters afterward so the next prep run sees the
    // freshly-saved file.
    if (rosterMode === "download") {
      const path = await sharePoint.start();
      if (!path) {
        setError(sharePoint.error ?? "SharePoint download failed");
        setSubmitting(false);
        return;
      }
      try {
        const r = await fetch("/api/rosters");
        if (r.ok) setRosters((await r.json()) as RosterListing[]);
      } catch {
        /* re-fetch is best-effort */
      }
    }

    const fd = new FormData();
    fd.append("pdf", file, file.name);
    // The backend's prep flow uses the latest roster on disk regardless
    // of rosterMode. We pass "existing" here so the parent row records
    // the chosen mode honestly (the download already happened above).
    fd.append("rosterMode", rosterMode === "download" ? "existing" : rosterMode);

    // Use XHR so we get progress events. Fetch's upload progress is still
    // not widely supported across browsers as of 2026.
    try {
      const result = await new Promise<{ ok: boolean; parentRunId?: string; error?: string }>(
        (resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/api/emergency-contact/prepare");
          xhr.upload.addEventListener("progress", (ev) => {
            if (ev.lengthComputable) {
              setProgress(Math.round((ev.loaded / ev.total) * 100));
            }
          });
          xhr.addEventListener("load", () => {
            try {
              const body = JSON.parse(xhr.responseText) as {
                ok: boolean;
                parentRunId?: string;
                error?: string;
              };
              resolve(body);
            } catch {
              reject(new Error(`Server returned non-JSON (status ${xhr.status})`));
            }
          });
          xhr.addEventListener("error", () => reject(new Error("Network error")));
          xhr.addEventListener("abort", () => reject(new Error("Upload aborted")));
          xhr.send(fd);
        },
      );

      if (!result.ok) {
        setError(result.error ?? "Server error — try again or check the dashboard logs.");
        setSubmitting(false);
        return;
      }
      toast.success("Preparation started", {
        description: file.name,
      });
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || "Server error — try again or check the dashboard logs.");
      setSubmitting(false);
      setProgress(null);
    }
  }

  const latestRoster = rosters?.[0];
  const hasRoster = (rosters?.length ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run Emergency Contact</DialogTitle>
          <DialogDescription>
            Upload a scanned PDF. We&apos;ll OCR it, match against the roster, then let you
            approve before queuing.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-5 space-y-5">
          {/* Dropzone */}
          {!file ? (
            <label
              ref={dropRef}
              htmlFor="ec-pdf-input"
              onDragOver={(e) => {
                e.preventDefault();
                dropRef.current?.classList.add("bg-primary/5", "border-primary");
              }}
              onDragLeave={() => {
                dropRef.current?.classList.remove("bg-primary/5", "border-primary");
              }}
              onDrop={handleDrop}
              className={cn(
                "flex flex-col items-center justify-center gap-2",
                "rounded-md border-2 border-dashed border-border bg-muted/20",
                "px-6 py-8 cursor-pointer transition-colors",
                "hover:bg-muted/40 hover:border-primary/50",
                "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ring-offset-card",
              )}
            >
              <input
                ref={fileInputRef}
                id="ec-pdf-input"
                type="file"
                accept="application/pdf,.pdf"
                className="sr-only"
                onChange={(e) => handleFileSelect(e.target.files?.[0] ?? null)}
              />
              <UploadCloud aria-hidden className="h-7 w-7 text-muted-foreground" />
              <div className="text-sm text-foreground">
                Drag PDF here or click to browse
              </div>
              <div className="text-xs text-muted-foreground font-mono">
                PDF only · max 50MB
              </div>
            </label>
          ) : progress !== null && submitting ? (
            <div className="rounded-md border border-border bg-muted/30 px-4 py-3 space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm truncate">{file.name}</span>
                <span className="text-xs font-mono text-muted-foreground">{progress}%</span>
              </div>
              <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all motion-reduce:transition-none"
                  style={{ width: `${progress}%` }}
                  aria-hidden
                />
              </div>
              <div
                className="text-xs text-muted-foreground"
                aria-live="polite"
                role="status"
              >
                Uploading {formatBytes((file.size * progress) / 100)} of {formatBytes(file.size)}…
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-border bg-muted/30 px-4 py-3 flex items-center gap-3">
              <FileText aria-hidden className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{file.name}</div>
                <div className="text-xs text-muted-foreground font-mono">
                  {formatBytes(file.size)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setFile(null)}
                aria-label="Remove file"
                title="Remove file"
                className={cn(
                  "h-7 w-7 inline-flex items-center justify-center rounded-md",
                  "text-muted-foreground hover:bg-muted hover:text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "cursor-pointer",
                )}
              >
                <X aria-hidden className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {/* Roster picker */}
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
              Roster
            </div>
            <RosterOption
              checked={rosterMode === "existing"}
              disabled={!hasRoster || submitting}
              onSelect={() => setRosterMode("existing")}
              label="Use latest roster"
              hint={
                hasRoster && latestRoster
                  ? `Latest: ${latestRoster.filename} · ${formatBytes(latestRoster.bytes)}`
                  : "No roster on disk — pick the other option to fetch one."
              }
            />
            <RosterOption
              checked={rosterMode === "download"}
              disabled={submitting}
              onSelect={() => setRosterMode("download")}
              label="Download fresh from SharePoint"
              hint={
                sharePoint.downloading
                  ? "Downloading roster from SharePoint…"
                  : sharePoint.error
                    ? `Error: ${sharePoint.error}`
                    : "Adds ~20s but guarantees current data."
              }
            />
          </div>

          {error && (
            <div
              role="alert"
              aria-live="polite"
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle aria-hidden className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className={cn(
              "h-8 px-3 inline-flex items-center justify-center rounded-md",
              "text-sm font-medium text-muted-foreground",
              "hover:bg-muted hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!file || submitting}
            className={cn(
              "h-8 px-3 inline-flex items-center gap-1.5 rounded-md",
              "text-sm font-medium",
              "bg-primary text-primary-foreground border border-primary",
              "hover:bg-primary/90 hover:border-primary/90",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
              "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
            )}
          >
            {submitting && progress !== null && progress < 100 ? (
              <>
                <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                Uploading…
              </>
            ) : submitting ? (
              <>
                <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                Starting…
              </>
            ) : (
              "Run"
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RosterOption({
  checked,
  disabled,
  onSelect,
  label,
  hint,
}: {
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  label: string;
  hint: string;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3 rounded-md border px-3 py-2.5 cursor-pointer transition-colors",
        checked
          ? "border-primary bg-primary/5"
          : "border-border hover:bg-muted/40",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <input
        type="radio"
        className="mt-1 cursor-pointer disabled:cursor-not-allowed accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={() => !disabled && onSelect()}
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground font-mono mt-0.5 truncate">{hint}</div>
      </div>
    </label>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
