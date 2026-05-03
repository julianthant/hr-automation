import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileText, FileScan, Loader2, UploadCloud, X as XIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { TrackerEntry } from "../types";
import {
  type PreviewRecord,
  type Verification,
  type FailedPage,
} from "./types";
import { type OathPreviewRecord } from "./types";
import { FailedPageCard } from "./FailedPageCard";
import { PrepReviewPair } from "./PrepReviewPair";
import { PrepReviewMultiPair } from "./PrepReviewMultiPair";
import { PrepReviewFormCard } from "./PrepReviewFormCard";
import { EmptyPagePlaceholder } from "./EmptyPagePlaceholder";
import { EcRecordView } from "./EcRecordView";
import { OathRecordView } from "./OathRecordView";
import { PdfPagePreview } from "../PdfPagePreview";
import { usePrepCursor } from "../hooks/usePrepCursor";
import {
  resolveOcrConfigForEntry,
  setOcrDownstreamRenderer,
  type AnyOcrPreviewRecord,
  type OcrDownstreamConfig as OcrDownstreamConfigType,
} from "@/lib/ocr-downstream-registry";
import { cn } from "@/lib/utils";

export interface OcrReviewPaneProps {
  entry: TrackerEntry;
  /** Operator dismissed the pane (only used by the legacy back-button path). */
  onClose: () => void;
  /** Open the reupload modal carrying forward this row's resolved EIDs. */
  onReupload?: (args: { sessionId: string; previousRunId: string }) => void;
}

type AnyPreviewRecord = AnyOcrPreviewRecord;

// Wire the per-record editor renderers into the registry once at module
// load. Done here (not in the registry file) so the registry stays a plain
// `.ts` and avoids a circular dep on `components/ocr/`.
setOcrDownstreamRenderer("ocr", ({ record, onChange }) => (
  <EcRecordView
    record={record as PreviewRecord}
    onChange={(next) => onChange(next)}
  />
));
setOcrDownstreamRenderer("emergency-contact", ({ record, onChange }) => (
  <EcRecordView
    record={record as PreviewRecord}
    onChange={(next) => onChange(next)}
  />
));
setOcrDownstreamRenderer("oath-signature", ({ record, onChange }) => (
  <OathRecordView
    record={record as OathPreviewRecord}
    onChange={(next) => onChange(next)}
  />
));

/**
 * Replaces the LogPanel for the active prep row. Owns the header
 * (Back arrow, filename, Cancel, Approve N), the scroll body grouped
 * by sourcePage (single → PrepReviewPair, multi → PrepReviewMultiPair),
 * per-record edit state mirrored to localStorage, and the approve POST.
 *
 * Closing the pane (Back arrow, Cancel, or selecting another queue
 * entry) preserves localStorage edits — Approve / Discard clear them.
 */
export function OcrReviewPane({ entry, onClose, onReupload }: OcrReviewPaneProps) {
  const sessionId = entry.id;
  const runId = entry.runId ?? entry.id;
  const cfg = resolveOcrConfigForEntry(entry);
  const data = useMemo(
    () => cfg?.parseRow(entry.data) ?? null,
    [entry.data, cfg],
  );
  const baseRecords = useMemo(() => data?.records ?? [], [data]);
  const storageKey = cfg ? cfg.editsKey({ sessionId, runId }) : "";

  const [localEdits, setLocalEdits] = useState<Record<number, AnyPreviewRecord>>(
    () => {
      try {
        const raw = window.localStorage.getItem(storageKey);
        return raw ? (JSON.parse(raw) as Record<number, AnyPreviewRecord>) : {};
      } catch {
        return {};
      }
    },
  );
  const [submitting, setSubmitting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [researchingIndices, setResearchingIndices] = useState<Set<number>>(new Set());
  const [markedBlankPages, setMarkedBlankPages] = useState<Set<number>>(new Set());

  async function handleDiscard(): Promise<void> {
    if (!cfg) return;
    if (!window.confirm("Discard this prep row? Per-record edits will be lost.")) return;
    setDiscarding(true);
    try {
      const r = await fetch(cfg.discardUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentRunId: runId }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        toast.error("Couldn't discard", { description: body.error ?? `HTTP ${r.status}` });
      } else {
        toast.success("Discarded");
        window.localStorage.removeItem(storageKey);
      }
    } catch (err) {
      toast.error("Couldn't discard", { description: err instanceof Error ? err.message : "Network error" });
    } finally {
      setDiscarding(false);
    }
  }

  // Persist edits — debounced via React's state batching is enough here.
  useEffect(() => {
    if (Object.keys(localEdits).length === 0) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(localEdits));
    } catch {
      /* localStorage full / disabled — silently drop */
    }
  }, [localEdits, storageKey]);

  const records: AnyPreviewRecord[] = useMemo(
    () => baseRecords.map((r, i) => localEdits[i] ?? r),
    [baseRecords, localEdits],
  );

  const setRecord = (index: number, next: AnyPreviewRecord): void => {
    setLocalEdits((prev) => ({ ...prev, [index]: next }));
  };

  const cursorKey = cfg ? cfg.cursorKey({ sessionId, runId }) : "";
  const { containerRef, onPairVisible, clear: clearCursor } = usePrepCursor({
    storageKey: cursorKey,
    enabled: cfg !== null,
    recordCount: records.length,
  });

  // IntersectionObserver: track which pair is currently most-visible in the
  // scroll viewport and report it to usePrepCursor for localStorage
  // persistence. Replaces an earlier onMouseEnter wiring that only fired
  // when the operator actively hovered — keyboard / trackpad / scrollbar
  // scrolling all silently failed to update the cursor under that scheme.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        let bestRatio = 0;
        let bestIndex: number | null = null;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          if (e.intersectionRatio > bestRatio) {
            bestRatio = e.intersectionRatio;
            const attr = (e.target as HTMLElement).dataset.pairIndex;
            if (attr) bestIndex = Number(attr);
          }
        }
        if (bestIndex !== null && Number.isFinite(bestIndex)) {
          onPairVisible(bestIndex);
        }
      },
      { root, threshold: [0.25, 0.5, 0.75, 1] },
    );
    const targets = root.querySelectorAll<HTMLElement>("[data-pair-index]");
    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
  }, [containerRef, onPairVisible, records.length]);

  // Group records by sourcePage, interleaved with failed pages, sorted by page number.
  type PageRender =
    | { kind: "records"; page: number; group: Array<{ record: AnyPreviewRecord; originalIndex: number }> }
    | { kind: "failed"; page: number; failedPage: FailedPage }
    | { kind: "empty"; page: number };

  const failedPages = data?.failedPages ?? [];
  const emptyPages = data?.emptyPages ?? [];

  const renderList = useMemo<PageRender[]>(() => {
    const recordsByPage = new Map<number, Array<{ record: AnyPreviewRecord; originalIndex: number }>>();
    records.forEach((r, originalIndex) => {
      const page = (r as { sourcePage: number }).sourcePage;
      if (!recordsByPage.has(page)) recordsByPage.set(page, []);
      recordsByPage.get(page)!.push({ record: r, originalIndex });
    });
    const list: PageRender[] = [];
    for (const [page, group] of recordsByPage) list.push({ kind: "records", page, group });
    for (const fp of failedPages) list.push({ kind: "failed", page: fp.page, failedPage: fp });
    // Empty pages: orchestrator's emptyPages is "OCR succeeded, 0 records".
    // Skip if the operator added a manual row for that page or marked blank.
    for (const p of emptyPages) {
      if (recordsByPage.has(p)) continue;
      if (markedBlankPages.has(p)) continue;
      list.push({ kind: "empty", page: p });
    }
    list.sort((a, b) => a.page - b.page);
    return list;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, failedPages, emptyPages, markedBlankPages]);

  const totalPages = data?.pageStatusSummary?.total ?? renderList.length;
  const approvableRecords = useMemo(
    () => records.filter((r) => isApprovable(r)),
    [records],
  );
  const selectedCount = approvableRecords.filter((r) => r.selected).length;
  const summary = describeSummary(records, failedPages.length);

  async function handleForceResearch(indices: number[]) {
    setResearchingIndices(new Set(indices));
    try {
      const r = await fetch("/api/ocr/force-research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: entry.id, runId, recordIndices: indices }),
      });
      if (!r.ok) {
        const body = await r.json() as { error?: string };
        toast.error("Re-research failed", { description: body.error });
      } else {
        toast.success("Re-research started");
      }
    } finally {
      setResearchingIndices(new Set());
    }
  }

  function addBlankRow(page: number): void {
    if (!cfg) return;
    // Synthesize a blank record matching the workflow's preview shape. The
    // matchSource "manual" + selected: false keeps it out of approve fan-out
    // until the operator types an EID.
    const nextRecords = [...records];
    const blank = {
      sourcePage: page,
      rowIndex: nextRecords.filter((r) => (r as { sourcePage: number }).sourcePage === page).length,
      printedName: "",
      employeeId: "",
      matchState: "lookup-pending",
      matchSource: "manual",
      selected: false,
      employeeSigned: true,
      officerSigned: null,
      dateSigned: null,
      notes: [],
      documentType: "expected",
      originallyMissing: [],
      warnings: [],
    } as unknown as AnyPreviewRecord;
    setLocalEdits((prev) => ({ ...prev, [nextRecords.length]: blank }));
  }

  async function handleApprove() {
    if (submitting || !cfg) return;
    setSubmitting(true);
    try {
      const resp = await fetch(cfg.approveUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentRunId: runId, records }),
      });
      const body = (await resp.json()) as { ok?: boolean; error?: string; enqueued?: number };
      if (!resp.ok || !body.ok) {
        toast.error("Couldn't approve batch", {
          description: body.error ?? "Server error",
        });
        setSubmitting(false);
        return;
      }
      toast.success(
        `Queued ${body.enqueued ?? selectedCount} record${(body.enqueued ?? selectedCount) === 1 ? "" : "s"}`,
      );
      clearCursor();
      window.localStorage.removeItem(storageKey);
      onClose();
    } catch (err) {
      toast.error("Couldn't approve batch", {
        description: err instanceof Error ? err.message : "Network error",
      });
      setSubmitting(false);
    }
  }

  if (!cfg) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        No OCR review config registered for workflow="{entry.workflow}".
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Couldn't parse prep row data.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border bg-card p-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="truncate text-sm font-semibold">
            {data.pdfOriginalName || "Prep review"}
          </span>
          <span className="rounded-full border border-border bg-secondary px-1.5 py-px font-mono text-[10px] text-muted-foreground">
            Review
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">{summary}</span>
          {failedPages.length > 0 && (
            <ReocrWholePdfButton
              sessionId={sessionId}
              runId={runId}
              storageKey={storageKey}
              onSuccess={() => setLocalEdits({})}
            />
          )}
          {onReupload && (
            <button
              type="button"
              onClick={() =>
                onReupload({ sessionId: entry.id, previousRunId: entry.runId ?? entry.id })
              }
              disabled={submitting || discarding}
              title="Re-upload corrected PDF — carries forward resolved EIDs from this run"
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <UploadCloud className="h-3 w-3" /> Reupload
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleDiscard()}
            disabled={submitting || discarding}
            title="Discard this prep row"
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            {discarding ? <Loader2 className="h-3 w-3 animate-spin" /> : <XIcon className="h-3 w-3" />}
            Discard
          </button>
          <button
            onClick={handleApprove}
            disabled={submitting || discarding || selectedCount === 0}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md border border-primary bg-primary px-3 text-xs font-semibold text-primary-foreground",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
            Approve {selectedCount}
          </button>
        </div>
      </div>

      {/* Force-research toolbar (registry-gated; OCR is the only workflow that opts in today). */}
      {cfg.supportsForceResearch && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border/60 bg-secondary/10">
          <button
            type="button"
            disabled={researchingIndices.size > 0 || records.length === 0}
            onClick={() => handleForceResearch(records.map((_, i) => i))}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
          >
            ↻ Re-research all
          </button>
          {researchingIndices.size > 0 && (
            <span className="text-[11px] text-muted-foreground">
              Researching {researchingIndices.size} record{researchingIndices.size !== 1 ? "s" : ""}…
            </span>
          )}
        </div>
      )}

      {/* Scroll body */}
      <div ref={containerRef} className="flex-1 overflow-y-auto bg-secondary/30">
        {renderList.map((renderEntry) => {
          if (renderEntry.kind === "failed") {
            return (
              <FailedPageCard
                key={`failed-${renderEntry.page}`}
                failedPage={renderEntry.failedPage}
                totalPages={totalPages}
                sessionId={sessionId}
                runId={runId}
              />
            );
          }
          if (renderEntry.kind === "empty") {
            return (
              <div key={`empty-${renderEntry.page}`} className="grid grid-cols-2 gap-4 border-b border-border p-4">
                <div className="self-start">
                  <PdfPagePreview workflow={entry.workflow} parentRunId={sessionId} page={renderEntry.page} />
                </div>
                <div>
                  <EmptyPagePlaceholder
                    page={renderEntry.page}
                    totalPages={totalPages}
                    onAddRow={() => addBlankRow(renderEntry.page)}
                    onMarkBlank={() => setMarkedBlankPages((prev) => new Set(prev).add(renderEntry.page))}
                    marked={markedBlankPages.has(renderEntry.page)}
                  />
                </div>
              </div>
            );
          }
          // records branch — preserve IntersectionObserver data-pair-index instrumentation
          const { page, group } = renderEntry;
          if (group.length === 1) {
            const { record, originalIndex } = group[0];
            return (
              <div
                key={page}
                data-pair-index={originalIndex}
              >
                <PrepReviewPair
                  workflow={entry.workflow}
                  parentRunId={sessionId}
                  page={page}
                  formCard={renderFormCard({
                    record,
                    cfg,
                    totalPages,
                    onChange: (next) => setRecord(originalIndex, next),
                  })}
                />
              </div>
            );
          }
          // Multi-pair (sign-in sheet)
          const cards = group.map(({ record, originalIndex }, rowIdx) => (
            <div
              key={originalIndex}
              data-pair-index={originalIndex}
            >
              {renderFormCard({
                record,
                cfg,
                totalPages,
                rowOnPage: rowIdx + 1,
                totalRowsOnPage: group.length,
                onChange: (next) => setRecord(originalIndex, next),
              })}
            </div>
          ));
          return (
            <PrepReviewMultiPair
              key={page}
              workflow={entry.workflow}
              parentRunId={sessionId}
              page={page}
              formCards={cards}
              onAddRow={addBlankRow}
            />
          );
        })}
      </div>
    </div>
  );
}

function ReocrWholePdfButton({ sessionId, runId, storageKey, onSuccess }: { sessionId: string; runId: string; storageKey: string; onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    setBusy(true);
    try {
      const r = await fetch("/api/ocr/reocr-whole-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, runId }),
      });
      const body = await r.json() as { ok: boolean; recordCount?: number; error?: string };
      if (!r.ok || !body.ok) {
        toast.error("Re-OCR failed", { description: body.error ?? `HTTP ${r.status}` });
      } else {
        toast.success("Re-OCR complete", {
          description: `${body.recordCount} record${body.recordCount === 1 ? "" : "s"} extracted`,
        });
        window.localStorage.removeItem(storageKey);
        onSuccess();
        setOpen(false);
      }
    } catch (err) {
      toast.error("Re-OCR failed", { description: err instanceof Error ? err.message : "Network error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-muted"
        >
          <FileScan className="h-3 w-3" />
          Re-OCR whole PDF
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Re-OCR the whole PDF?</DialogTitle>
          <DialogDescription>
            This sends the full PDF to Gemini in one call and replaces the records on this row.
            All per-record edits will be discarded. Use only when many pages have failed and per-page retry isn't recovering.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={busy}
            className="h-8 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-primary bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {busy ? "Re-running…" : "Re-OCR whole PDF"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function isApprovable(record: AnyPreviewRecord): boolean {
  const matchOk = record.matchState === "matched" || record.matchState === "resolved";
  const notUnknown = record.documentType !== "unknown";
  // Strict gate: verification must have run AND landed on `verified`. An
  // absent verification means stage 5 (Person Org Summary lookup) hasn't
  // completed for this record yet — keep it out of the approve fan-out
  // until it has, so we never enqueue an unverified employee.
  const verifyOk = record.verification?.state === "verified";
  // Tighten: when selected, require a non-empty 5+ digit EID. Blocks
  // approving a manually-added row before the operator types an EID.
  const eid = String(
    (record as { employeeId?: string; employee?: { employeeId?: string } }).employeeId
      ?? (record as { employee?: { employeeId?: string } }).employee?.employeeId
      ?? "",
  ).trim();
  const eidOk = !record.selected || /^\d{5,}$/.test(eid);
  return matchOk && notUnknown && verifyOk && eidOk;
}

function describeSummary(records: AnyPreviewRecord[], failedPageCount = 0): string {
  let verified = 0;
  let needsReview = 0;
  let toRemove = 0;
  for (const r of records) {
    if (r.documentType === "unknown") { toRemove += 1; continue; }
    if (r.verification && r.verification.state !== "verified") { needsReview += 1; continue; }
    if (r.matchState !== "matched" && r.matchState !== "resolved") { needsReview += 1; continue; }
    verified += 1;
  }
  const parts: string[] = [`${verified} verified`];
  if (needsReview > 0) parts.push(`${needsReview} needs review`);
  if (toRemove > 0) parts.push(`${toRemove} to remove`);
  if (failedPageCount > 0) parts.push(`${failedPageCount} page${failedPageCount === 1 ? "" : "s"} failed`);
  return parts.join(" · ");
}

function renderFormCard(args: {
  record: AnyPreviewRecord;
  cfg: OcrDownstreamConfigType;
  totalPages: number;
  rowOnPage?: number;
  totalRowsOnPage?: number;
  onChange: (r: AnyPreviewRecord) => void;
}): ReactNode {
  const r = args.record;
  const sourcePage = (r as { sourcePage: number }).sourcePage;
  const pageLocation = args.totalRowsOnPage
    ? `Page ${sourcePage} of ${args.totalPages}, Row ${args.rowOnPage} of ${args.totalRowsOnPage} in pile`
    : `Page ${sourcePage} of ${args.totalPages} in pile`;
  const recordName = args.cfg.recordName(r);

  const matchStateBadge = (
    <span className="rounded-md border border-border bg-secondary px-1.5 py-px font-mono text-[10px] uppercase">
      {r.matchState}
    </span>
  );
  const verificationBadge = renderVerificationBadge(r);
  const isUnknown = r.documentType === "unknown";

  const removeFromPileBanner = isUnknown ? (
    <span>
      Page {sourcePage} doesn't match the expected form template — REMOVE
      FROM PILE.
    </span>
  ) : undefined;
  const addToPaperBanner =
    (r.originallyMissing?.length ?? 0) > 0 ? (
      <span>Add to paper: {r.originallyMissing!.join(", ")}</span>
    ) : undefined;
  const verificationBanner =
    r.verification && r.verification.state !== "verified"
      ? renderVerificationBanner(r.verification)
      : undefined;
  const signatureBanner = renderOathSignatureBanner(r, args.cfg.hasSignature);

  return (
    <PrepReviewFormCard
      pageLocation={pageLocation}
      recordName={recordName}
      matchStateBadge={matchStateBadge}
      verificationBadge={verificationBadge}
      signatureBadge={renderSignatureBadge(r, args.cfg.hasSignature)}
      documentTypeBadge={
        isUnknown ? (
          <span className="rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-px font-mono text-[10px] uppercase text-destructive">
            ⚠ unknown
          </span>
        ) : undefined
      }
      removeFromPileBanner={removeFromPileBanner}
      addToPaperBanner={addToPaperBanner}
      verificationBanner={verificationBanner}
      signatureBanner={signatureBanner}
      selected={r.selected}
      selectedDisabled={isUnknown}
      onSelectedChange={(next) =>
        args.onChange({ ...r, selected: next } as AnyPreviewRecord)
      }
    >
      {args.cfg.renderEditor({
        record: r,
        onChange: (next) => args.onChange(next),
      })}
    </PrepReviewFormCard>
  );
}

function renderVerificationBadge(r: { verification?: { state: string } }): ReactNode {
  if (!r.verification) return null;
  const palette: Record<string, string> = {
    verified: "border-success/40 bg-success/10 text-success",
    inactive: "border-destructive/40 bg-destructive/10 text-destructive",
    "non-hdh": "border-destructive/40 bg-destructive/10 text-destructive",
    "lookup-failed": "border-border bg-muted text-muted-foreground",
  };
  const label: Record<string, string> = {
    verified: "✓ HDH active",
    inactive: "⚠ inactive",
    "non-hdh": "⚠ non-HDH",
    "lookup-failed": "verify failed",
  };
  const cls = palette[r.verification.state] ?? palette["lookup-failed"];
  const text = label[r.verification.state] ?? r.verification.state;
  return (
    <span
      className={cn(
        "rounded-md border px-1.5 py-px font-mono text-[10px] uppercase",
        cls,
      )}
    >
      {text}
    </span>
  );
}

function renderVerificationBanner(v: Verification): ReactNode {
  const screenshotFilename = v.state !== "lookup-failed" ? v.screenshotFilename : "";
  const reason =
    v.state === "inactive"
      ? `Employee found but hrStatus = ${v.hrStatus} — auto-deselected.`
      : v.state === "non-hdh"
        ? `Employee found in ${v.department || "unknown dept"} — not HDH.`
        : v.state === "lookup-failed"
          ? `Person Org Summary lookup did not return a result: ${v.error}`
          : "";
  return (
    <span>
      Verification: {reason}
      {screenshotFilename && (
        <>
          {" "}
          <a
            href={`/screenshots/${encodeURIComponent(screenshotFilename)}`}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            View Person Org Summary screenshot
          </a>
        </>
      )}
    </span>
  );
}

function renderSignatureBadge(r: AnyPreviewRecord, hasSignature: boolean): ReactNode {
  if (!hasSignature) return undefined;
  const oath = r as OathPreviewRecord;
  if (oath.employeeSigned === false) {
    return (
      <span className="rounded-md border border-warning/40 bg-warning/10 px-1.5 py-px font-mono text-[10px] uppercase text-warning">
        ⚠ employee unsigned
      </span>
    );
  }
  if (oath.officerSigned === false) {
    return (
      <span className="rounded-md border border-warning/40 bg-warning/10 px-1.5 py-px font-mono text-[10px] uppercase text-warning">
        ⚠ officer unsigned
      </span>
    );
  }
  return undefined;
}

function renderOathSignatureBanner(
  r: AnyPreviewRecord,
  hasSignature: boolean,
): ReactNode {
  if (!hasSignature) return undefined;
  const oath = r as OathPreviewRecord;
  if (oath.employeeSigned === false) {
    return <span>Signature missing — employee did not sign.</span>;
  }
  if (oath.officerSigned === false) {
    return <span>Signature missing — authorized officer did not sign.</span>;
  }
  return undefined;
}
