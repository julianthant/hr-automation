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
      <DialogContent className="overflow-hidden p-0 sm:max-w-[640px] gap-0">
        <DialogHeader className="grid gap-3 px-[38px] pt-[36px] pb-0 space-y-0">
          <div
            className="grid items-start gap-6"
            style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}
          >
            <div className="flex flex-col gap-1.5" style={{ maxWidth: 360 }}>
              <DialogTitle className="text-[15px] font-normal tracking-[-0.005em]">
                Run Emergency Contact
              </DialogTitle>
              <DialogDescription className="text-[12px] leading-[1.55] text-muted-foreground">
                Upload a scanned PDF. We&apos;ll OCR it, match against the roster, then approve before queuing.
              </DialogDescription>
            </div>
            <code className="font-mono text-[11px] whitespace-nowrap pt-[5px] text-muted-foreground/70">
              emergency-contact
            </code>
          </div>
          <hr aria-hidden className="m-0 border-0 border-t border-border/60" />
        </DialogHeader>

        <div className="px-[38px] pt-[24px] pb-0 space-y-6">
          <section>
            <div className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-2 text-muted-foreground/70">
              {file ? "PDF" : "Upload"}
            </div>
            {!file ? (
              <Dropzone
                fileInputRef={fileInputRef}
                dropRef={dropRef}
                onDrop={handleDrop}
                onPick={(p) => handleFileSelect(p)}
              />
            ) : progress !== null && submitting ? (
              <UploadProgress fileName={file.name} fileSize={file.size} progress={progress} />
            ) : (
              <FileRow file={file} onRemove={() => setFile(null)} />
            )}
          </section>

          <section>
            <div className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-1 text-muted-foreground/70">
              Roster
            </div>
            <div>
              <RosterRow
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
              <RosterRow
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
                last
              />
            </div>
          </section>

          {error && (
            <div
              role="alert"
              aria-live="polite"
              className="flex items-start gap-2 rounded-md p-3"
              style={{
                border: "1px solid var(--border)",
                borderLeft: "2px solid hsl(0 50% 56%)",
                backgroundColor: "transparent",
              }}
            >
              <AlertCircle aria-hidden className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
              <span className="text-[13px] text-foreground">{error}</span>
            </div>
          )}
        </div>

        <DialogFooter className="grid grid-cols-4 gap-2.5 border-t border-border/60 px-[38px] py-[18px] mt-[24px]">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!file || submitting}
            className={cn(
              "col-span-3 inline-flex items-center justify-center gap-1.5 rounded-[7px] px-3.5 py-2.5",
              "text-[12.5px] font-medium",
              "border border-border bg-transparent text-foreground",
              "hover:border-foreground/50",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              "disabled:cursor-not-allowed disabled:text-muted-foreground/40 disabled:border-border/60",
              "cursor-pointer",
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
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className={cn(
              "col-span-1 inline-flex items-center justify-center rounded-[7px] px-3 py-2.5",
              "text-[12.5px] font-medium",
              "border border-border/60 bg-transparent text-muted-foreground",
              "hover:border-border hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
            )}
          >
            Cancel
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Dropzone({
  fileInputRef,
  dropRef,
  onDrop,
  onPick,
}: {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  dropRef: React.RefObject<HTMLLabelElement | null>;
  onDrop: (e: React.DragEvent<HTMLLabelElement>) => void;
  onPick: (file: File | null) => void;
}) {
  void fileInputRef; // hidden input is selected by id; ref kept for parity with prior api
  return (
    <label
      ref={dropRef}
      htmlFor="ec-pdf-input"
      onDragOver={(e) => {
        e.preventDefault();
        dropRef.current?.classList.add("bg-muted/30");
      }}
      onDragLeave={() => {
        dropRef.current?.classList.remove("bg-muted/30");
      }}
      onDrop={onDrop}
      className={cn(
        "flex flex-col items-center justify-center gap-2.5",
        "rounded-[10px] border border-dashed border-border/80 bg-transparent",
        "px-6 py-9 cursor-pointer transition-colors",
        "hover:bg-muted/30 hover:border-border",
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 ring-offset-card",
      )}
    >
      <input
        id="ec-pdf-input"
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      <span
        className="inline-flex items-center justify-center rounded-full"
        style={{
          width: 38,
          height: 38,
          border: "1px solid var(--border)",
          color: "var(--muted-foreground)",
        }}
      >
        <UploadCloud aria-hidden className="h-4 w-4" />
      </span>
      <div className="text-[13px] text-foreground/90">Drag PDF here, or click to browse</div>
      <div className="text-[10.5px] text-muted-foreground/70 font-mono tracking-wide">
        PDF only · max 50 MB
      </div>
    </label>
  );
}

function FileRow({ file, onRemove }: { file: File; onRemove: () => void }) {
  return (
    <div
      className="flex items-center gap-3.5 rounded-[10px] px-4 py-3.5"
      style={{ border: "1px solid var(--border)", backgroundColor: "var(--muted)" }}
    >
      <span
        className="inline-flex items-center justify-center rounded-md shrink-0"
        style={{
          width: 32,
          height: 32,
          backgroundColor: "var(--background)",
          border: "1px solid var(--border)",
          color: "var(--foreground)",
        }}
      >
        <FileText aria-hidden className="h-4 w-4" />
      </span>
      <div className="flex-1 min-w-0 grid gap-0.5">
        <div className="text-[13px] truncate text-foreground">{file.name}</div>
        <div className="text-[10.5px] text-muted-foreground/70 font-mono">
          {formatBytes(file.size)}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
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
  );
}

function UploadProgress({
  fileName,
  fileSize,
  progress,
}: {
  fileName: string;
  fileSize: number;
  progress: number;
}) {
  return (
    <div
      className="rounded-[10px] px-4 py-3.5 space-y-2"
      style={{ border: "1px solid var(--border)", backgroundColor: "var(--muted)" }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] truncate">{fileName}</span>
        <span className="text-[11px] font-mono text-muted-foreground/80">{progress}%</span>
      </div>
      <div
        className="h-[1.5px] w-full overflow-hidden rounded-full"
        style={{ backgroundColor: "var(--border)" }}
      >
        <div
          className="h-full transition-[width] motion-reduce:transition-none"
          style={{ width: `${progress}%`, backgroundColor: "var(--foreground)" }}
          aria-hidden
        />
      </div>
      <div
        className="text-[11px] text-muted-foreground/80"
        aria-live="polite"
        role="status"
      >
        Uploading {formatBytes((fileSize * progress) / 100)} of {formatBytes(fileSize)}…
      </div>
    </div>
  );
}

function RosterRow({
  checked,
  disabled,
  onSelect,
  label,
  hint,
  last,
}: {
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  label: string;
  hint: string;
  last?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3.5 px-3.5 py-3 cursor-pointer transition-colors",
        !last && "border-b border-border/60",
        checked ? "bg-muted/40" : "hover:bg-muted/20",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <span
        className="mt-1 inline-flex items-center justify-center shrink-0 relative"
        style={{
          width: 14,
          height: 14,
          borderRadius: "50%",
          border: "1px solid var(--border)",
        }}
        aria-hidden
      >
        {checked && (
          <span
            className="block rounded-full"
            style={{ width: 6, height: 6, backgroundColor: "var(--foreground)" }}
          />
        )}
      </span>
      <input
        type="radio"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={() => !disabled && onSelect()}
      />
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] text-foreground">{label}</div>
        <div className="text-[10.5px] text-muted-foreground/70 font-mono mt-0.5 truncate">{hint}</div>
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
