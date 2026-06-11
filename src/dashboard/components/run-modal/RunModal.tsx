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
import { cn } from "@/lib/utils";
import { DuplicateBanner } from "@/components/oath-upload";
import type { PriorRunSummary } from "@/components/shared/types";
import {
  getRunModalConfig,
  resolveTargetWorkflow,
  type RunModalSubmitResponse,
} from "@/lib/run-modal-registry";
import { useRosters, refreshRosters, type RosterListing } from "@/components/hooks/useRosters";
import { useFormTypes, refreshFormTypes, type FormTypeOption } from "@/components/hooks/useFormTypes";
import { AUTO_WORKERS, workerChoiceToParam, type WorkerChoice } from "@/lib/run-settings";
import { MODAL_FOOTER_CONTROL_HEIGHT, WorkerStepper } from "@/components/shared/WorkerStepper";
import { useSharePointStatus } from "@/components/hooks/useSharePointStatus";

type RosterMode = "download" | "existing" | "wait";

async function sha256OfFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * File-upload "Run" modal — drives every workflow whose Run affordance
 * uploads a PDF (emergency-contact, oath-signature, ocr, oath-upload as of
 * writing).
 *
 * Per-workflow behavior (title, submit URL, which sections
 * to render, success-toast shape) is declared in
 * `src/dashboard/lib/run-modal-registry.ts`. Adding a new file-upload
 * workflow needs only an entry there — this component does not change.
 */
interface RunModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Active workflow — must be a key of `RUN_MODAL_REGISTRY`. */
  workflow: string;
  /** When set, the modal is in "reupload" mode for the given session. */
  reuploadFor?: { sessionId: string; previousRunId: string };
}

export function RunModal({ open, onOpenChange, workflow, reuploadFor }: RunModalProps) {
  const config = getRunModalConfig(workflow);
  // The workflow's registry entry can lock the form type so the modal hides
  // the picker and force-injects the value on submit (emergency-contact →
  // emergency-contact, oath-signature → oath).
  const effectiveLockedFormType = config?.lockedFormType;
  const showRoster = config?.sections.roster ?? false;
  // When the registry locks the form type, the OCR backend still needs the
  // formType field on the FormData — flip the section flag on so submit
  // sends it, but the picker UI is hidden via the `effectiveLockedFormType`
  // gate further down.
  const showFormType = (config?.sections.formType ?? false) || Boolean(effectiveLockedFormType);
  const showDuplicateCheck = config?.sections.duplicateCheck ?? false;
  const showDryRun = config?.sections.dryRun ?? false;
  const showOathUploadMode = config?.sections.oathUploadMode ?? false;
  const showWorkers = config?.sections.workers ?? false;
  const allowMultipleFiles = Boolean(config?.allowMultipleFiles && !reuploadFor);

  const [files, setFiles] = useState<File[]>([]);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [rosterMode, setRosterMode] = useState<RosterMode>("existing");
  const rosters = useRosters();
  const seenSharePointCompletionTs = useRef<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formType, setFormType] = useState<string | null>(effectiveLockedFormType ?? null);
  const formOptionsCache = useFormTypes();
  const formOptions: FormTypeOption[] = formOptionsCache ?? [];
  // Per-file duplicate-check results. Each entry is a picked file whose hash
  // matched at least one prior run; `fileName` lets the banner say WHICH file is
  // a duplicate in a multi-file upload. Single-file uploads still produce a
  // one-entry array (the banner omits the filename header for a lone file).
  const [duplicateGroups, setDuplicateGroups] = useState<
    Array<{ fileName: string; priorRuns: PriorRunSummary[] }>
  >([]);
  const [dryRun, setDryRun] = useState(false);
  const [oathUploadMode, setOathUploadMode] = useState<"full" | "upload-only">("full");
  const [workerChoice, setWorkerChoice] = useState<WorkerChoice>(AUTO_WORKERS);
  const effectiveShowRoster = showRoster && oathUploadMode === "full";
  // Workers only matter for the OCR-hub fan-out path. Upload-only oath-upload is
  // a single ServiceNow ticket row with nothing to parallelize, so the section
  // self-hides there (it stays hidden, not just disabled).
  const effectiveShowWorkers = showWorkers && !(showOathUploadMode && oathUploadMode === "upload-only");
  const ctx = { reuploadFor, lockedFormType: effectiveLockedFormType, oathUploadMode };
  // Poll SharePoint download status only while the roster picker is showing.
  // The hook gates its shared 2.5s poll on `enabled` and shallow-compares
  // payloads so an unchanged status doesn't re-render the modal every tick.
  const sharePointStatus = useSharePointStatus(open && effectiveShowRoster);
  const file = files[0] ?? null;
  // Stable identity signature for the picked files — used as an effect dep so
  // the duplicate check re-runs only when the actual selection changes (not on
  // every render). File objects are referentially unstable across renders.
  const filesSignature = files
    .map((f) => `${f.name}:${f.size}:${f.lastModified}`)
    .join("|");

  useEffect(() => {
    if (open && effectiveLockedFormType) setFormType(effectiveLockedFormType);
  }, [open, effectiveLockedFormType]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLLabelElement>(null);

  // Best-effort PDF page count via pdf-lib. Lazy-imported on first pick
  // so the chunk is split out of the main bundle. Spec §4.3: falls back
  // to bytes-only when unknown.
  useEffect(() => {
    if (!file || files.length !== 1) {
      setPageCount(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const buf = await file.arrayBuffer();
        const { PDFDocument } = await import("pdf-lib");
        const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
        if (!cancelled) setPageCount(doc.getPageCount());
      } catch {
        if (!cancelled) setPageCount(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, files.length]);

  // Refresh rosters cache each time the modal opens so a SharePoint download
  // that finished while the modal was closed is reflected. The cache hook
  // (`useRosters`) already serves any pre-warmed data instantly — this is
  // belt-and-braces for staleness.
  useEffect(() => {
    if (!open || !effectiveShowRoster) return;
    refreshRosters();
  }, [open, effectiveShowRoster]);

  // When the polled status reports a NEW completion (a download finished while
  // the modal was open), refresh the rosters cache so the freshly-downloaded
  // file appears as "Use latest roster." The seen-completion ref dedupes so we
  // refresh once per completion, not every poll tick.
  useEffect(() => {
    const completionTs = sharePointStatus?.lastCompletion?.ts ?? null;
    if (completionTs && completionTs !== seenSharePointCompletionTs.current) {
      seenSharePointCompletionTs.current = completionTs;
      refreshRosters();
    }
  }, [sharePointStatus]);

  const sharePointWaitAvailable =
    Boolean(sharePointStatus?.inFlight) || Boolean(sharePointStatus?.queued.length);

  // Auto-flip away from invalid roster choices as local files/queue state changes.
  useEffect(() => {
    if (!rosters) return;
    if (rosters.length === 0 && rosterMode === "existing") {
      setRosterMode(sharePointWaitAvailable ? "wait" : "download");
      return;
    }
    if (rosterMode === "wait" && !sharePointWaitAvailable) {
      setRosterMode(rosters.length > 0 ? "existing" : "download");
    }
  }, [rosters, rosterMode, sharePointWaitAvailable]);

  // Duplicate-check effect — hash EACH picked PDF and ask the server whether
  // we've seen it before. Runs per-file so a bulk (multi-file) upload doesn't
  // silently skip the heads-up: oath-upload declares both `duplicateCheck` and
  // `allowMultipleFiles`. Best-effort: failures surface as an inline error but
  // don't block submit (the operator may genuinely want to re-run).
  useEffect(() => {
    if (!showDuplicateCheck || files.length === 0) {
      setDuplicateGroups([]);
      return;
    }
    let cancelled = false;
    const checkedFiles = files;
    (async () => {
      try {
        const results = await Promise.all(
          checkedFiles.map(async (candidate) => {
            const hash = await sha256OfFile(candidate);
            const r = await fetch(
              `/api/oath-upload/check-duplicate?hash=${encodeURIComponent(hash)}`,
            );
            const j = (await r.json()) as
              | { ok: true; priorRuns: PriorRunSummary[] }
              | { ok: false; error: string };
            return { fileName: candidate.name, priorRuns: j.ok ? j.priorRuns ?? [] : [] };
          }),
        );
        if (cancelled) return;
        // Only files with at least one prior run make the banner.
        setDuplicateGroups(results.filter((g) => g.priorRuns.length > 0));
      } catch (err) {
        if (!cancelled) {
          setError(
            `Duplicate check failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `filesSignature` captures the selection identity; the `files` array read
    // inside is referentially unstable across renders, so the signature is the
    // real dependency that gates a re-check.
  }, [filesSignature, showDuplicateCheck]);

  // Refresh form-types cache each time the modal opens so a backend update
  // (rare) is reflected. The hook (`useFormTypes`) already serves any
  // pre-warmed data instantly — this is belt-and-braces for staleness.
  useEffect(() => {
    if (!open || !showFormType || effectiveLockedFormType) return;
    refreshFormTypes();
  }, [open, showFormType, effectiveLockedFormType]);

  // Default-select the first form type once options arrive (and no caller
  // already locked one). Tracks `formOptions` so a late cache fill still
  // populates the radio.
  useEffect(() => {
    if (formType || effectiveLockedFormType) return;
    if (formOptions.length > 0) setFormType(formOptions[0].formType);
  }, [formOptions, formType, effectiveLockedFormType]);

  // Reset form state on close. Rosters cache is module-global (see
  // useRosters) so we don't reset it here — it's reused across opens.
  useEffect(() => {
    if (open) return;
    setFiles([]);
    setPageCount(null);
    setSubmitting(false);
    setProgress(null);
    setError(null);
    setDuplicateGroups([]);
    setRosterMode("existing");
    setDryRun(false);
    setOathUploadMode("full");
    setWorkerChoice(AUTO_WORKERS);
    // Reset the form-type pick so the standalone-OCR modal re-defaults on the
    // next open (the default-select effect is gated on `!formType`); a locked
    // form-type re-injects via the `open && effectiveLockedFormType` effect.
    setFormType(effectiveLockedFormType ?? null);
    // Drop the seen-SharePoint-completion marker so reopening after a completed
    // download re-fires the roster-refresh side-effect on the next poll instead
    // of treating that completion as already handled.
    seenSharePointCompletionTs.current = null;
  }, [open, effectiveLockedFormType]);

  if (!config) {
    return null;
  }

  function validatePdf(picked: File): string | null {
    if (!picked.name.toLowerCase().endsWith(".pdf") && picked.type !== "application/pdf") {
      return `PDF rejected: ${picked.name} is not a valid application/pdf.`;
    }
    if (picked.size > 50 * 1024 * 1024) {
      return `File too large: ${picked.name} exceeds 50 MB.`;
    }
    return null;
  }

  function handleFilesSelect(picked: FileList | File[] | null): void {
    setError(null);
    const next = Array.from(picked ?? []);
    if (next.length === 0) return setFiles([]);
    if (!allowMultipleFiles && next.length > 1) {
      setError("Select one PDF for this workflow.");
      return;
    }
    for (const candidate of next) {
      const validationError = validatePdf(candidate);
      if (validationError) {
        setError(validationError);
        return;
      }
    }
    setFiles(next);
  }

  function handleFilesAdd(picked: FileList | null): void {
    setError(null);
    const additions = Array.from(picked ?? []);
    if (additions.length === 0) return;
    if (!allowMultipleFiles) {
      handleFilesSelect(additions);
      return;
    }
    const next = [...files, ...additions];
    for (const candidate of next) {
      const validationError = validatePdf(candidate);
      if (validationError) {
        setError(validationError);
        return;
      }
    }
    setFiles(next);
  }

  function handleDrop(e: React.DragEvent<HTMLLabelElement>): void {
    e.preventDefault();
    e.stopPropagation();
    dropRef.current?.classList.remove("bg-primary/5", "border-primary");
    if (allowMultipleFiles) {
      handleFilesAdd(e.dataTransfer.files ?? null);
    } else {
      handleFilesSelect(e.dataTransfer.files ?? null);
    }
  }

  async function handleSubmit(): Promise<void> {
    if (!config || files.length === 0 || submitting) return;
    if (showFormType && !formType) return;
    setSubmitting(true);
    setProgress(0);
    setError(null);

    const submitUrl = config.submitUrl(ctx);

    // Route uploads to the dashboard's dedicated upload port (3839 by
    // default — see `uploadPort` in `startDashboard`). Different port =
    // different browser origin = separate HTTP/1.1 connection pool, so
    // a multi-second upload never competes with the dashboard's ~6
    // long-lived SSE streams for Chrome's 6-connection-per-origin
    // budget. CORS is wildcard on the backend; cross-origin POST works
    // without preflight gymnastics. Same behavior in dev (page on
    // :5173) and prod (page on :3838) — both reroute to :3839.
    const fullSubmitUrl =
      typeof window !== "undefined"
        ? `${window.location.protocol}//${window.location.hostname}:3839${submitUrl}`
        : submitUrl;

    // Use XHR so we get progress events. Fetch's upload progress is still
    // not widely supported across browsers as of 2026.
    const totalBytes = files.reduce((sum, nextFile) => sum + nextFile.size, 0);
    const uploadedByIndex = new Map<number, number>();

    const uploadOne = (nextFile: File, index: number) =>
      new Promise<RunModalSubmitResponse>(
        (resolve, reject) => {
          const fd = new FormData();
          fd.append("pdf", nextFile, nextFile.name);
          if (showOathUploadMode) fd.append("mode", oathUploadMode);
          if (effectiveShowRoster) {
            fd.append("rosterMode", rosterMode);
            if (rosterMode === "existing" && latestRoster) {
              fd.append("rosterPath", latestRoster.path);
            }
          }
          if (showFormType && formType) fd.append("formType", formType);
          // Target-workflow operation intent — lets the backend tell an
          // oath-signature PDF run from an oath-upload full run (both
          // formType=oath). The registry decides when to send it (only on the
          // shared OCR-prep submit path); no endpoint-string branching here.
          {
            const target = resolveTargetWorkflow(config, ctx);
            if (target) {
              fd.append("targetWorkflow", target);
            }
          }
          if (showDryRun && dryRun) fd.append("dryRun", "true");
          // Automation-workers run setting — only for the OCR-backed prepare
          // path, and only when the operator picked an explicit count (Auto
          // sends nothing → backend reuses-or-spawns-one).
          {
            const parallelWorkers = workerChoiceToParam(workerChoice);
            if (effectiveShowWorkers && parallelWorkers !== undefined) {
              fd.append("parallelWorkers", String(parallelWorkers));
            }
          }
          if (reuploadFor) {
            fd.append("sessionId", reuploadFor.sessionId);
            fd.append("previousRunId", reuploadFor.previousRunId);
          }
          const xhr = new XMLHttpRequest();
          xhr.open("POST", fullSubmitUrl);
          xhr.upload.addEventListener("progress", (ev) => {
            if (ev.lengthComputable) {
              uploadedByIndex.set(index, ev.loaded);
              const uploaded = Array.from(uploadedByIndex.values()).reduce((sum, n) => sum + n, 0);
              const denominator = totalBytes > 0 ? totalBytes : ev.total;
              setProgress(Math.min(100, Math.round((uploaded / denominator) * 100)));
            }
          });
          xhr.addEventListener("load", () => {
            try {
              const body = JSON.parse(xhr.responseText) as RunModalSubmitResponse;
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

    try {
      const results: RunModalSubmitResponse[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const result = await uploadOne(files[i]!, i);
        if (!result.ok) {
          setError(result.error ?? "Server error — try again or check the dashboard logs.");
          setSubmitting(false);
          return;
        }
        uploadedByIndex.set(i, files[i]!.size);
        results.push(result);
      }
      const t = config.buildSuccessToast(results[0]!, files[0]!);
      toast.success(
        files.length > 1 ? `${files.length} preparations started` : t.title,
        files.length > 1
          ? { description: files.map((nextFile) => nextFile.name).join(", ") }
          : t.description ? { description: t.description } : undefined,
      );
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
  const sharePointQueueHint = sharePointStatus?.queued.length
    ? `${sharePointStatus.queued.length} download${sharePointStatus.queued.length === 1 ? "" : "s"} queued. This run will use the newest queued result.`
    : sharePointStatus?.current
      ? `${sharePointStatus.current.label} is running. This run will use it when it finishes.`
      : "Use the currently queued SharePoint download when it finishes.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        className="overflow-hidden p-0 sm:max-w-[640px] gap-0"
        style={
          {
            "--background": "var(--capture-bg-page)",
            "--card": "var(--capture-bg-modal)",
            "--muted": "var(--capture-bg-raised)",
            "--border": "var(--capture-border-subtle)",
            "--foreground": "var(--capture-fg-primary)",
            "--muted-foreground": "var(--capture-fg-muted)",
            "--ring": "var(--capture-focus-ring)",
          } as React.CSSProperties
        }
      >
        <DialogHeader className="relative grid gap-3 px-[38px] pt-[36px] pb-0 space-y-0 border-b-0">
          <div className="flex flex-col" style={{ maxWidth: 360 }}>
            <DialogTitle className="text-[15px] font-normal tracking-[-0.005em]">
              {config.title(ctx)}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {config.srDescription(ctx)}
            </DialogDescription>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => !submitting && onOpenChange(false)}
            disabled={submitting}
            className={cn(
              "absolute right-[14px] top-[14px] inline-flex h-7 w-7 items-center justify-center rounded-md",
              "border border-transparent bg-transparent text-muted-foreground transition-colors",
              "hover:border-border hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border",
              "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
            )}
          >
            <X aria-hidden className="h-3.5 w-3.5" />
          </button>
          <hr aria-hidden className="m-0 border-0 border-t border-border/60" />
        </DialogHeader>

        <div className="px-[38px] pt-[24px] pb-0 space-y-6">
          {showOathUploadMode && (
            <section>
              <div className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-2 text-muted-foreground">
                Mode
              </div>
              <div className="grid grid-cols-2 gap-2">
                <ModeButton
                  active={oathUploadMode === "full"}
                  disabled={submitting}
                  label="Full process"
                  hint="Dispatch OCR + signatures into Oath Signature, then file HR ticket"
                  onClick={() => setOathUploadMode("full")}
                />
                <ModeButton
                  active={oathUploadMode === "upload-only"}
                  disabled={submitting}
                  label="Upload only"
                  hint="Skip OCR and signatures — file HR ticket only"
                  onClick={() => setOathUploadMode("upload-only")}
                />
              </div>
            </section>
          )}

          {showFormType && !effectiveLockedFormType && !reuploadFor && formOptions.length > 0 && (
            <section>
              <div className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-2 text-muted-foreground">
                Form type
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                {formOptions.map((opt) => (
                  <label key={opt.formType} className="flex shrink-0 items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="formType"
                      value={opt.formType}
                      checked={formType === opt.formType}
                      onChange={() => setFormType(opt.formType)}
                      disabled={submitting}
                      className="accent-primary"
                    />
                    <span className="text-[13px] font-medium">{opt.label}</span>
                  </label>
                ))}
              </div>
            </section>
          )}
          <section>
            <div className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-2 text-muted-foreground/70">
              PDF
            </div>
            {progress !== null && submitting ? (
              <UploadProgress
                fileName={files.length === 1 ? file.name : `${files.length} PDFs`}
                fileSize={files.reduce((sum, nextFile) => sum + nextFile.size, 0)}
                progress={progress}
              />
            ) : allowMultipleFiles ? (
              <div className="grid gap-2.5">
                <Dropzone
                  fileInputRef={fileInputRef}
                  dropRef={dropRef}
                  onDrop={handleDrop}
                  onPick={handleFilesAdd}
                  multiple
                  compact={files.length > 0}
                />
                {files.length > 0 ? (
                  <FileRows
                    files={files}
                    pageCount={pageCount}
                    onRemoveAt={(index) => setFiles((current) => current.filter((_, i) => i !== index))}
                  />
                ) : null}
              </div>
            ) : !file ? (
              <Dropzone
                fileInputRef={fileInputRef}
                dropRef={dropRef}
                onDrop={handleDrop}
                onPick={handleFilesSelect}
                multiple={false}
              />
            ) : (
              <FileRows
                files={files}
                pageCount={pageCount}
                onRemoveAt={() => setFiles([])}
              />
            )}
          </section>

          {effectiveShowRoster && (
            <section>
              <div className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-1 text-muted-foreground">
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
                      : rosters === null
                        ? "Loading rosters…"
                        : "No roster on disk — pick the other option to fetch one."
                  }
                />
                {sharePointWaitAvailable ? (
                  <RosterRow
                    checked={rosterMode === "wait"}
                    disabled={submitting}
                    onSelect={() => setRosterMode("wait")}
                    label="Wait for queued SharePoint"
                    hint={sharePointQueueHint}
                  />
                ) : null}
                <RosterRow
                  checked={rosterMode === "download"}
                  disabled={submitting}
                  onSelect={() => setRosterMode("download")}
                  label="Download fresh from SharePoint"
                  hint={
                    sharePointWaitAvailable
                      ? "Queues a new SharePoint download after the current queue."
                      : "The OCR orchestrator will handle the download automatically."
                  }
                  last
                />
              </div>
            </section>
          )}

          {showDuplicateCheck && duplicateGroups.length > 0 && (
            <div className="space-y-2.5">
              {duplicateGroups.map((group) => (
                <DuplicateBanner
                  key={group.fileName}
                  priorRuns={group.priorRuns}
                  // Show WHICH file is a duplicate only when more than one file
                  // is in play; a lone file keeps the original header-less banner.
                  fileLabel={duplicateGroups.length > 1 ? group.fileName : undefined}
                />
              ))}
            </div>
          )}

          {showDryRun && (
            <section>
              <label
                className={cn(
                  "flex min-h-11 cursor-pointer items-start gap-3 rounded-[10px] px-3.5 py-3",
                  "border border-border/70 bg-transparent transition-colors",
                  "hover:bg-muted/20",
                )}
              >
                <input
                  type="checkbox"
                  checked={dryRun}
                  disabled={submitting}
                  onChange={(e) => setDryRun(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-primary"
                />
                <span className="grid gap-0.5">
                  <span className="text-[13px] font-medium text-foreground">Dry run</span>
                  <span className="text-[11px] leading-[1.45] text-muted-foreground">
                    Fill live pages, capture proof, then skip UCPath Save or ServiceNow Submit.
                  </span>
                </span>
              </label>
            </section>
          )}

          {error && (
            <div
              role="alert"
              aria-live="polite"
              className="flex items-start gap-2 rounded-md p-3"
              style={{
                border: "1px solid var(--border)",
                borderLeft: "2px solid var(--capture-error)",
                backgroundColor: "transparent",
              }}
            >
              <AlertCircle aria-hidden className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
              <span className="text-[13px] text-foreground">{error}</span>
            </div>
          )}
        </div>

        <DialogFooter className="flex flex-row items-center gap-2.5 border-t border-border/60 px-[38px] py-[18px] mt-[24px] [&_button]:box-border">
          {effectiveShowWorkers && (
            <WorkerStepper
              value={workerChoice}
              onChange={setWorkerChoice}
              disabled={submitting}
              variant="footer"
              className="shrink-0"
            />
          )}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={files.length === 0 || submitting}
            className={cn(
              MODAL_FOOTER_CONTROL_HEIGHT,
              "flex-1 inline-flex items-center justify-center gap-1.5 rounded-[7px] px-3.5",
              "text-[12.5px] font-medium",
              "bg-transparent transition-colors",
              "border",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border",
              "disabled:cursor-not-allowed",
              "cursor-pointer",
            )}
            style={{
              borderColor: files.length === 0 || submitting
                ? "var(--capture-border-subtle)"
                : "var(--capture-border-cta)",
              color: files.length === 0 || submitting
                ? "var(--capture-fg-faint)"
                : "var(--capture-fg-primary)",
            }}
            onMouseOver={(e) => {
              if (!(files.length === 0 || submitting)) {
                e.currentTarget.style.borderColor = "var(--capture-border-cta-strong)";
              }
            }}
            onMouseOut={(e) => {
              if (!(files.length === 0 || submitting)) {
                e.currentTarget.style.borderColor = "var(--capture-border-cta)";
              }
            }}
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
              MODAL_FOOTER_CONTROL_HEIGHT,
              "shrink-0 inline-flex items-center justify-center rounded-[7px] px-5",
              "text-[12.5px] font-medium",
              "bg-transparent transition-colors",
              "border",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border",
              "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
            )}
            style={{
              borderColor: "var(--capture-border-subtle)",
              color: "var(--capture-fg-muted)",
            }}
            onMouseOver={(e) => {
              if (!submitting) {
                e.currentTarget.style.borderColor = "var(--capture-border-cta)";
              }
            }}
            onMouseOut={(e) => {
              if (!submitting) {
                e.currentTarget.style.borderColor = "var(--capture-border-subtle)";
              }
            }}
          >
            Cancel
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModeButton({
  active,
  disabled,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid min-h-16 gap-0.5 rounded-[8px] border px-3 py-2.5 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border",
        "disabled:cursor-not-allowed disabled:opacity-60",
        disabled ? "" : "cursor-pointer hover:bg-muted/25",
      )}
      style={{
        borderColor: active ? "var(--capture-border-cta)" : "var(--capture-border-subtle)",
        backgroundColor: active ? "var(--capture-bg-raised)" : "transparent",
      }}
    >
      <span className="text-[13px] font-medium text-foreground">{label}</span>
      <span className="text-[11px] leading-[1.35] text-muted-foreground">{hint}</span>
    </button>
  );
}

function Dropzone({
  fileInputRef,
  dropRef,
  onDrop,
  onPick,
  multiple,
  compact = false,
}: {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  dropRef: React.RefObject<HTMLLabelElement | null>;
  onDrop: (e: React.DragEvent<HTMLLabelElement>) => void;
  onPick: (files: FileList | null) => void;
  multiple: boolean;
  compact?: boolean;
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
        compact
          ? "flex items-center gap-3.5"
          : "flex flex-col items-center justify-center gap-2.5",
        "rounded-[10px] border border-dashed border-border/80 bg-transparent",
        compact ? "px-4 py-3.5" : "px-6 py-9",
        "cursor-pointer transition-colors",
        "hover:bg-muted/30 hover:border-border",
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 ring-offset-card",
      )}
    >
      <input
        id="ec-pdf-input"
        type="file"
        accept="application/pdf,.pdf"
        multiple={multiple}
        className="sr-only"
        onChange={(e) => onPick(e.target.files ?? null)}
      />
      <span
        className={cn(
          "inline-flex items-center justify-center shrink-0",
          compact ? "rounded-md" : "rounded-full",
        )}
        style={{
          width: compact ? 32 : 38,
          height: compact ? 32 : 38,
          border: "1px solid var(--border)",
          color: "var(--muted-foreground)",
        }}
      >
        <UploadCloud aria-hidden className="h-4 w-4" />
      </span>
      <div className={cn(compact ? "grid gap-0.5 min-w-0" : "contents")}>
        <div className="text-[13px] text-foreground/90">
          {multiple ? "Drag PDFs here, or click to browse" : "Drag PDF here, or click to browse"}
        </div>
        <div className="text-[10.5px] text-muted-foreground/70 font-mono tracking-wide">
          PDF only · max 50 MB
        </div>
      </div>
    </label>
  );
}

function FileRows({
  files,
  pageCount,
  onRemoveAt,
}: {
  files: File[];
  pageCount: number | null;
  onRemoveAt: (index: number) => void;
}) {
  return (
    <div className="grid gap-2">
      {files.map((file, index) => {
        const meta =
          files.length === 1 && pageCount != null
            ? `${formatBytes(file.size)} · ${pageCount} page${pageCount === 1 ? "" : "s"}`
            : formatBytes(file.size);
        return (
          <div
            key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
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
                {meta}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onRemoveAt(index)}
              aria-label={`Remove ${file.name}`}
              title="Remove file"
              className={cn(
                "h-7 w-7 inline-flex items-center justify-center rounded-md",
                "text-muted-foreground hover:bg-muted hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border",
                "cursor-pointer",
              )}
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
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
