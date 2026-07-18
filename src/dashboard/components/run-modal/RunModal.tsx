import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Camera, FileText, Loader2, UploadCloud, X } from "lucide-react";
import { toast } from "@/lib/notify";
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
import { CapturePanel, type CapturePanelHandle } from "@/components/capture/modal/index.js";
import { useCaptureRegistration } from "@/components/hooks/useCaptureRegistration";
import type { PriorRunSummary } from "@/components/shared/types";
import {
  getRunModalConfig,
  isRunModalCaptureCapable,
  resolveTargetWorkflow,
  type RunModalSubmitResponse,
} from "@/lib/run-modal-registry";
import { useRosters, useRostersError, refreshRosters } from "@/components/hooks/useRosters";
import { useFormTypes, refreshFormTypes, type FormTypeOption } from "@/components/hooks/useFormTypes";
import {
  ONBASE_DOCUMENT_TYPES,
  ONBASE_EMERGENCY_CONTACT_DOC_TYPE,
  isOnbaseDocTypeWired,
  onbaseDocTypeLabel,
} from "@/lib/onbase-document-types";
import { resolveOnbaseModalFormType } from "@/components/run-modal/onbase-form-type";
import { AUTO_WORKERS, workerChoiceToParam, type WorkerChoice } from "@/lib/run-settings";
import { getOperatorSession } from "@/lib/operator-auth";
import { MODAL_FOOTER_CONTROL_HEIGHT, WorkerStepper } from "@/components/shared/WorkerStepper";
import { useSharePointStatus } from "@/components/hooks/useSharePointStatus";

type RosterMode = "download" | "existing" | "wait" | "none";

async function sha256OfFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Merge multiple selected PDFs into one combined PDF (page order preserved),
 * returned as a single File. Used when a workflow sets `mergeMultipleFiles`
 * (OnBase: one page → one person, so the whole upload is one document).
 */
async function mergePdfFiles(files: File[]): Promise<File> {
  const { PDFDocument } = await import("pdf-lib");
  const merged = await PDFDocument.create();
  for (const f of files) {
    const src = await PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const p of pages) merged.addPage(p);
  }
  const bytes = await merged.save();
  const baseName = files[0]?.name.replace(/\.pdf$/i, "") ?? "combined";
  return new File([new Uint8Array(bytes)], `${baseName}-combined.pdf`, {
    type: "application/pdf",
  });
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
 *
 * Capture-photos is offered as an alternate upload METHOD inside the same run
 * flow: a workflow that declares `capture: true` in the registry AND has a
 * live capture registration (`GET /api/capture/registry`) shows an "Upload
 * file | Capture photos" switch. Picking Capture swaps the file UI for the
 * `CapturePanel` rendered INLINE in this same modal (no separate dialog) — the
 * same `/api/capture/*` flow produces the same OCR prep row as a file upload.
 * The standalone capture modal + its toolbar camera button were retired
 * 2026-06-29; the Run modal is the single entry point for both methods.
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
  // Capture-photos upload method. Declarative opt-in via the registry
  // (`config.capture`), gated additionally on a live capture registration so the
  // option only shows when the backend actually registered a capture handler.
  // Suppressed in reupload mode (reupload is file-specific). When the operator
  // picks Capture, the CapturePanel renders inline in place of the file UI.
  const captureRegistration = useCaptureRegistration(workflow);
  const captureCapable =
    !reuploadFor && isRunModalCaptureCapable(workflow) && captureRegistration !== null;
  // Which upload method is selected. "capture" renders the CapturePanel inline
  // (state machine reused, not forked) in place of the file UI; the footer and
  // upload sections hide. Resets to "upload" on close. The panel handle lets
  // this modal route its close affordances (X / Esc / overlay) through the
  // panel's discard-aware leave (so an open session with photos confirms first).
  const [mode, setMode] = useState<"upload" | "capture">("upload");
  const captureMode = captureCapable && mode === "capture";
  const captureRef = useRef<CapturePanelHandle>(null);
  const [captureLightboxOpen, setCaptureLightboxOpen] = useState(false);
  const closeModal = useCallback(() => onOpenChange(false), [onOpenChange]);
  // Close affordances (X / Esc / overlay) while capturing route through the
  // panel's discard-aware leave so an open session with photos confirms before
  // it's dropped. Falls straight to close if the panel isn't mounted.
  const requestCaptureClose = useCallback(() => {
    const leaving = captureRef.current?.leaveCapture();
    if (!leaving) {
      onOpenChange(false);
      return;
    }
    void leaving.then((left) => {
      if (left) onOpenChange(false);
    });
  }, [onOpenChange]);
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
  const showOnbaseDocType = config?.sections.onbaseDocType ?? false;
  const mergeMultipleFiles = Boolean(config?.mergeMultipleFiles);
  const allowMultipleFiles = Boolean(config?.allowMultipleFiles && !reuploadFor);

  const [files, setFiles] = useState<File[]>([]);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [rosterMode, setRosterMode] = useState<RosterMode>("existing");
  // Which local roster file to use when rosterMode is "existing". `null` means
  // "the latest" (the resolved pick tracks the top of the list as new rosters
  // land); a path pins a specific file. Resolution to a concrete listing is
  // `selectedRoster` below — a pinned path that vanished from the confirmed
  // list falls back to the latest, and the file dropdown always displays the
  // resolved file, so what's shown is always what's submitted.
  const [selectedRosterPath, setSelectedRosterPath] = useState<string | null>(null);
  // Whether the current rosterMode was picked by the OPERATOR (dropdown pick)
  // or auto-applied by the flip effect below. Only an auto-applied
  // download/wait may be flipped back to "existing" when rosters load —
  // overriding an operator's deliberate choice would be its own bug.
  const rosterModeSource = useRef<"auto" | "user">("auto");
  const rosters = useRosters();
  // Whether the LAST /api/rosters fetch attempt failed. `rosters` alone can't
  // distinguish "confirmed empty directory" from "the request errored" — both
  // read as an empty/`null` value — so a transient failure must not be treated
  // the same as a genuinely empty roster dir (fail-loud: see root CLAUDE.md).
  const rostersError = useRostersError();
  const seenSharePointCompletionTs = useRef<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formType, setFormType] = useState<string | null>(effectiveLockedFormType ?? null);
  const formOptionsCache = useFormTypes();
  const formOptions = useMemo<FormTypeOption[]>(() => formOptionsCache ?? [], [formOptionsCache]);
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
  const [onbaseDocType, setOnbaseDocType] = useState<string>(ONBASE_EMERGENCY_CONTACT_DOC_TYPE);
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
    void (async () => {
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
  // Safe to treat `rosters.length === 0` below as a CONFIRMED empty roster dir
  // (not a swallowed fetch error): the cache underlying `useRosters()` is only
  // ever populated from a successful response — a failed fetch leaves it as
  // `null` (caught by the early return here) or unchanged from its last
  // confirmed value, never collapsed to `[]` (see resource-factory.ts).
  useEffect(() => {
    if (!rosters) return;
    if (rosters.length === 0 && rosterMode === "existing") {
      rosterModeSource.current = "auto";
      setRosterMode(sharePointWaitAvailable ? "wait" : "download");
      return;
    }
    if (rosterMode === "wait" && !sharePointWaitAvailable) {
      rosterModeSource.current = "auto";
      setRosterMode(rosters.length > 0 ? "existing" : "download");
      return;
    }
    // Flip BACK to the local roster once rosters load, but only when the
    // current download/wait choice was auto-applied above (a momentarily
    // empty useRosters() on open used to strand the modal on a silent
    // SharePoint download while the operator believed "Use latest roster"
    // was in effect — E2E-006). An operator-clicked choice is never undone.
    if (rosters.length > 0 && rosterMode !== "existing" && rosterModeSource.current === "auto") {
      setRosterMode("existing");
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
    void (async () => {
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
            // A `{ok:false}` response is a genuine backend failure for THIS
            // file's duplicate check, not "no duplicates found" — silently
            // returning [] would let the operator upload a real duplicate
            // unwarned. Throw so the outer catch surfaces it as an error
            // banner instead of masking it as a clean check.
            if (!j.ok) throw new Error(j.error || `Duplicate check failed for ${candidate.name}`);
            return { fileName: candidate.name, priorRuns: j.priorRuns ?? [] };
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above: filesSignature IS the files identity
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
    if (formType || effectiveLockedFormType || showOnbaseDocType) return;
    if (formOptions.length > 0) setFormType(formOptions[0].formType);
  }, [formOptions, formType, effectiveLockedFormType, showOnbaseDocType]);

  // OnBase: the document-type dropdown drives the OCR formType. Keyed on `open`
  // (ISS-001, 2026-06-24) — the close-reset effect nulls formType and also runs
  // on initial mount while open=false; without re-deriving on open the modal
  // reopens with formType=null and handleSubmit's `!formType` guard makes Run a
  // silent no-op (the whole OnBase workflow was unstartable). The gating +
  // derivation live in `resolveOnbaseModalFormType` so they are unit-pinned.
  useEffect(() => {
    const resolved = resolveOnbaseModalFormType({ open, showOnbaseDocType, onbaseDocType });
    if (resolved.apply) setFormType(resolved.formType);
  }, [open, showOnbaseDocType, onbaseDocType]);

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
    setSelectedRosterPath(null);
    setDryRun(false);
    setOathUploadMode("full");
    setWorkerChoice(AUTO_WORKERS);
    // Reopen defaults to the file-upload method. The CapturePanel unmounts when
    // mode flips back to "upload"; its own unmount cleanup best-effort discards
    // any still-open session, so resetting here can't orphan a capture.
    setMode("upload");
    setCaptureLightboxOpen(false);
    // Reset the form-type pick so the standalone-OCR modal re-defaults on the
    // next open (the default-select effect is gated on `!formType`); a locked
    // form-type re-injects via the `open && effectiveLockedFormType` effect.
    setFormType(effectiveLockedFormType ?? null);
    // Drop the seen-SharePoint-completion marker so reopening after a completed
    // download re-fires the roster-refresh side-effect on the next poll instead
    // of treating that completion as already handled.
    seenSharePointCompletionTs.current = null;
  }, [open, effectiveLockedFormType]);

  // Never strand the modal in capture mode for a workflow that can't capture
  // (e.g. the live registration resolved null after a workflow switch).
  useEffect(() => {
    if (!captureCapable && mode === "capture") setMode("upload");
  }, [captureCapable, mode]);

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
    if ((showFormType || showOnbaseDocType) && !formType) return;
    // Fail loud: never submit "use the existing roster" without a confirmed
    // local roster to point at. A stuck default rosterMode of "existing" with
    // no `selectedRoster` means /api/rosters never confirmed one way or the
    // other (e.g. the fetch failed — see `rostersError`) — silently sending
    // rosterMode=existing with no rosterPath would leave the backend to guess.
    if (effectiveShowRoster && rosterMode === "existing" && !selectedRoster) {
      setError(
        rostersError
          ? "Couldn't confirm a local roster (the roster check failed) — retry, or choose Download fresh from SharePoint."
          : "No roster confirmed yet — wait for the roster check to finish, or choose Download fresh from SharePoint.",
      );
      return;
    }
    setSubmitting(true);
    setProgress(0);
    setError(null);

    // When the workflow merges multiple files (OnBase: one page → one person),
    // combine the selection into a single PDF and submit one upload.
    let uploadFiles = files;
    if (mergeMultipleFiles && files.length > 1) {
      try {
        uploadFiles = [await mergePdfFiles(files)];
      } catch (err) {
        setError(
          `Could not combine the selected PDFs: ${err instanceof Error ? err.message : String(err)}`,
        );
        setSubmitting(false);
        return;
      }
    }

    const submitUrl = config.submitUrl(ctx);

    // Same-origin relative URL — Vite proxies `/api` in dev; prod serves the
    // SPA from the API host. Do NOT post to `port + 1`: that listener is
    // phone Capture only (2026-07-15), and a cross-origin miss surfaces as a
    // bare XHR "Network error".
    //
    // XHR (needed for upload progress) bypasses the `fetch` operator-token
    // wrapper, so attach the session header explicitly.
    let operatorAuth: { header: string; token: string };
    try {
      operatorAuth = await getOperatorSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operator session unavailable");
      setSubmitting(false);
      return;
    }

    // Use XHR so we get progress events. Fetch's upload progress is still
    // not widely supported across browsers as of 2026.
    const totalBytes = uploadFiles.reduce((sum, nextFile) => sum + nextFile.size, 0);
    const uploadedByIndex = new Map<number, number>();

    const uploadOne = (nextFile: File, index: number) =>
      new Promise<RunModalSubmitResponse>(
        (resolve, reject) => {
          const fd = new FormData();
          fd.append("pdf", nextFile, nextFile.name);
          if (showOathUploadMode) fd.append("mode", oathUploadMode);
          if (effectiveShowRoster) {
            fd.append("rosterMode", rosterMode);
            if (rosterMode === "existing" && selectedRoster) {
              fd.append("rosterPath", selectedRoster.path);
            }
          }
          if ((showFormType || showOnbaseDocType) && formType) fd.append("formType", formType);
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
          xhr.open("POST", submitUrl);
          xhr.setRequestHeader(operatorAuth.header, operatorAuth.token);
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
      for (let i = 0; i < uploadFiles.length; i += 1) {
        const result = await uploadOne(uploadFiles[i], i);
        if (!result.ok) {
          setError(result.error ?? "Server error — try again or check the dashboard logs.");
          setSubmitting(false);
          return;
        }
        uploadedByIndex.set(i, uploadFiles[i].size);
        results.push(result);
      }
      const t = config.buildSuccessToast(results[0], uploadFiles[0]);
      toast.success(
        uploadFiles.length > 1 ? `${uploadFiles.length} preparations started` : t.title,
        uploadFiles.length > 1
          ? { description: uploadFiles.map((nextFile) => nextFile.name).join(", ") }
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

  const hasRoster = (rosters?.length ?? 0) > 0;
  // The roster file a rosterMode="existing" run will actually use: the pinned
  // pick when it's still on disk, else the latest listing. The file dropdown
  // renders `selectedRoster.path` as its value, so the visible pick and the
  // submitted `rosterPath` can never diverge.
  const selectedRoster =
    (selectedRosterPath ? rosters?.find((r) => r.path === selectedRosterPath) : undefined) ??
    rosters?.[0];
  const sharePointQueueHint = sharePointStatus?.queued.length
    ? `${sharePointStatus.queued.length} download${sharePointStatus.queued.length === 1 ? "" : "s"} queued. This run will use the newest queued result.`
    : sharePointStatus?.current
      ? `${sharePointStatus.current.label} is running. This run will use it when it finishes.`
      : "Use the currently queued SharePoint download when it finishes.";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          onOpenChange(true);
          return;
        }
        if (captureMode) {
          requestCaptureClose();
          return;
        }
        onOpenChange(false);
      }}
    >
      <DialogContent
        hideClose
        className={cn(
          "overflow-hidden p-0 gap-0",
          captureMode ? "sm:max-w-[760px]" : "sm:max-w-[640px]",
        )}
        onEscapeKeyDown={(e) => {
          // Esc closes an open photo lightbox first (it's a custom overlay whose
          // preventDefault doesn't stop Radix from also closing this dialog).
          if (captureMode && captureLightboxOpen) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          // The photo lightbox is portaled to <body> (to escape this dialog's
          // centering transform), so a click on it reads as "outside" this
          // dialog — Radix would otherwise dismiss the whole Run modal. Keep it
          // open while the lightbox is up; the lightbox handles its own dismiss.
          if (captureMode && captureLightboxOpen) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (captureMode && captureLightboxOpen) e.preventDefault();
        }}
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
            onClick={() => {
              if (captureMode) {
                requestCaptureClose();
                return;
              }
              if (!submitting) onOpenChange(false);
            }}
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
          {captureCapable && (
            <section>
              <div className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-2 text-muted-foreground">
                Upload method
              </div>
              <div className="grid grid-cols-2 gap-2">
                <ModeButton
                  active={mode === "upload"}
                  disabled={submitting}
                  label="Upload file"
                  hint="Pick a PDF from this computer"
                  onClick={() => {
                    // Leaving capture mid-session drops it (with a photo-loss
                    // confirm); staying put if the operator cancels.
                    if (mode !== "capture") return;
                    const leaving = captureRef.current?.leaveCapture();
                    if (!leaving) {
                      setMode("upload");
                      return;
                    }
                    void leaving.then((left) => {
                      if (left) setMode("upload");
                    });
                  }}
                />
                <ModeButton
                  active={mode === "capture"}
                  disabled={submitting}
                  label="Capture photos"
                  hint="Scan a QR on your phone, take photos, bundle to a PDF"
                  icon={<Camera aria-hidden className="h-3.5 w-3.5" />}
                  onClick={() => setMode("capture")}
                />
              </div>
            </section>
          )}
          {!captureMode && (
            <>
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

          {showOnbaseDocType && !reuploadFor && (
            <section>
              <label
                htmlFor="onbase-doc-type"
                className="block text-[9.5px] uppercase tracking-[0.10em] font-medium mb-2 text-muted-foreground"
              >
                Document type
              </label>
              <select
                id="onbase-doc-type"
                value={onbaseDocType}
                onChange={(e) => setOnbaseDocType(e.target.value)}
                disabled={submitting}
                className="w-full h-9 rounded-md border border-border bg-secondary/40 px-2.5 text-[13px] text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {(["Payroll Records", "Personnel Records"] as const).map((group) => (
                  <optgroup key={group} label={group}>
                    {ONBASE_DOCUMENT_TYPES.filter((d) => d.group === group).map((d) => {
                      const wired = isOnbaseDocTypeWired(d.docType);
                      return (
                        <option key={d.docType} value={d.docType} disabled={!wired}>
                          {onbaseDocTypeLabel(d.docType)}
                          {wired ? "" : " (coming soon)"}
                        </option>
                      );
                    })}
                  </optgroup>
                ))}
              </select>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Only Emergency Contact is wired today; it imports as the OnBase
                X_HR_Emergency Contact document type.
              </p>
            </section>
          )}

          {showFormType && !effectiveLockedFormType && !reuploadFor && formOptions.length > 0 && (
            <section>
              <label
                htmlFor="ocr-form-type"
                className="block text-[9.5px] uppercase tracking-[0.10em] font-medium mb-2 text-muted-foreground"
              >
                Form type
              </label>
              <select
                id="ocr-form-type"
                value={formType ?? ""}
                onChange={(e) => setFormType(e.target.value)}
                disabled={submitting}
                className="w-full h-9 rounded-md border border-border bg-secondary/40 px-2.5 text-[13px] text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {formOptions.map((opt) => (
                  <option key={opt.formType} value={opt.formType}>
                    {opt.label}
                  </option>
                ))}
              </select>
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
              <label
                htmlFor="roster-source"
                className="block text-[9.5px] uppercase tracking-[0.10em] font-medium mb-2 text-muted-foreground"
              >
                Roster
              </label>
              <div className="grid gap-2">
                <select
                  id="roster-source"
                  value={rosterMode}
                  onChange={(e) => {
                    rosterModeSource.current = "user";
                    setRosterMode(e.target.value as RosterMode);
                  }}
                  disabled={submitting}
                  className="w-full h-9 rounded-md border border-border bg-secondary/40 px-2.5 text-[13px] text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="existing" disabled={!hasRoster}>
                    Use a local roster file{hasRoster ? "" : " (none on disk)"}
                  </option>
                  {sharePointWaitAvailable ? (
                    <option value="wait">Wait for queued SharePoint download</option>
                  ) : null}
                  <option value="download">Download fresh from SharePoint</option>
                  <option value="none">No roster</option>
                </select>
                {rosterMode === "existing" && hasRoster && rosters ? (
                  <select
                    aria-label="Roster file"
                    value={selectedRoster?.path ?? ""}
                    onChange={(e) => setSelectedRosterPath(e.target.value)}
                    disabled={submitting}
                    className="w-full h-9 rounded-md border border-border bg-secondary/40 px-2.5 text-[13px] text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {rosters.map((roster, index) => (
                      <option key={roster.path} value={roster.path}>
                        {roster.filename} · {formatBytes(roster.bytes)}
                        {index === 0 ? " · latest" : ""}
                      </option>
                    ))}
                  </select>
                ) : null}
                <p className="text-[10.5px] text-muted-foreground/70 font-mono">
                  {rosterMode === "existing"
                    ? hasRoster && selectedRoster
                      ? `Modified ${formatRosterDate(selectedRoster.modifiedAt)}`
                      : rosters !== null
                        // A confirmed (possibly stale) fetch says the dir is
                        // genuinely empty — trust it even if a LATER refresh
                        // attempt has since failed (rostersError).
                        ? "No roster on disk — pick a SharePoint option to fetch one."
                        : rostersError
                          ? "Couldn't check for a local roster — the /api/rosters request failed. Retrying, or pick a SharePoint option."
                          : "Loading rosters…"
                    : rosterMode === "wait"
                      ? sharePointQueueHint
                      : rosterMode === "none"
                        ? "No roster matching — every person resolves via UCPath person lookup."
                        : sharePointWaitAvailable
                          ? "Queues a new SharePoint download after the current queue."
                          : "The OCR orchestrator will handle the download automatically."}
                </p>
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
            </>
          )}
        </div>

        {captureMode && (
          <CapturePanel
            ref={captureRef}
            active={open}
            workflow={workflow}
            workflowLabel={captureRegistration?.label}
            onClosed={closeModal}
            onLightboxOpenChange={setCaptureLightboxOpen}
          />
        )}

        {!captureMode && (
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
        )}
      </DialogContent>
    </Dialog>
  );
}

function ModeButton({
  active,
  disabled,
  label,
  hint,
  icon,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  hint: string;
  icon?: React.ReactNode;
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
      <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
        {icon}
        {label}
      </span>
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

/** Compact roster-file timestamp for the hint line, e.g. "Jul 8, 2:41 PM". */
function formatRosterDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
