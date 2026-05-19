import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { FileScan, Loader2, RotateCw, UploadCloud } from "lucide-react";
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
import type { TrackerEntry } from "@/components/shared/types";
import {
  type PreviewRecord,
  type Verification,
  type FailedPage,
} from "./types";
import { type OathPreviewRecord } from "./types";
import { FailedPageCard } from "./FailedPageCard";
import { PrepReviewPair } from "./PrepReviewPair";
import { PrepReviewMultiPair } from "./PrepReviewMultiPair";
import {
  PrepReviewFormCard,
  PrepReviewRecordNav,
  type PrepRecordWorkflowPhase,
} from "./PrepReviewFormCard";
import { EmptyPagePlaceholder } from "./EmptyPagePlaceholder";
import { EcRecordView } from "./EcRecordView";
import { OathRecordView } from "./OathRecordView";
import { PdfPagePreview } from "@/components/shared/PdfPagePreview";
import { usePrepCursor } from "@/components/hooks/usePrepCursor";
import {
  useTaskDependencies,
  type TaskDependencyChild,
} from "@/components/hooks/useTaskDependencies";
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

export interface OcrReviewPrepProviderProps {
  /** When false, hooks stay idle and toolbar/body render nothing (single provider instance for the dashboard). */
  active: boolean;
  entry: TrackerEntry | null;
  onClose: () => void;
  onReupload?: OcrReviewPaneProps["onReupload"];
  children: ReactNode;
}

export type OcrReviewPrepApiSnapshot = {
  active: boolean;
  toolbar: ReactNode;
  body: ReactNode;
};

const OcrReviewPrepApiContext = createContext<OcrReviewPrepApiSnapshot | null>(null);

export function OcrReviewPrepProvider({
  active,
  entry,
  onClose,
  onReupload,
  children,
}: OcrReviewPrepProviderProps) {
  const api = useOcrReviewPrepApi(active, entry, onClose, onReupload);
  return (
    <OcrReviewPrepApiContext.Provider value={api}>
      {children}
    </OcrReviewPrepApiContext.Provider>
  );
}

/** OCR prep chrome row — rendered in {@link LogPanel}'s Preview header slot (below tabs). */
export function OcrReviewPrepToolbar() {
  const api = useContext(OcrReviewPrepApiContext);
  if (!api?.active || api.toolbar === null) return null;
  return api.toolbar;
}

/** OCR prep two-column scroll body — {@link LogPanel} Preview tab slot. */
export function OcrReviewPrepBody() {
  const api = useContext(OcrReviewPrepApiContext);
  if (!api?.active || api.body === null) return null;
  return api.body;
}

type AnyPreviewRecord = AnyOcrPreviewRecord;

type PrepStorageV1 = {
  v: 1;
  edits: Record<number, AnyPreviewRecord>;
  removed?: number[];
};

type MergedPrepRecordRow = {
  originalIndex: number;
  record: AnyPreviewRecord;
};

/** Continuation/server patches win over stale localStorage prep snapshots — operator edits keep form fields only. */
function overlayServerOwnedPrepFields(
  baseRecord: AnyPreviewRecord | undefined,
  local: AnyPreviewRecord,
): AnyPreviewRecord {
  if (!baseRecord) return local;
  if (baseRecord.formKind !== local.formKind) {
    console.warn(
      "[OcrReviewPane] overlayServerOwnedPrepFields: variant mismatch",
      { baseKind: baseRecord.formKind, localKind: local.formKind },
    );
    return local;
  }
  if (local.formKind === "oath" && baseRecord.formKind === "oath") {
    return {
      ...local,
      verification: baseRecord.verification,
      matchState: baseRecord.matchState,
      matchSource: baseRecord.matchSource,
      warnings: baseRecord.warnings,
    };
  }
  if (local.formKind === "emergency-contact" && baseRecord.formKind === "emergency-contact") {
    return {
      ...local,
      verification: baseRecord.verification,
      matchState: baseRecord.matchState,
      matchSource: baseRecord.matchSource,
      warnings: baseRecord.warnings,
    };
  }
  return local;
}

function loadPrepStorage(rawKey: string): { edits: Record<number, AnyPreviewRecord>; removed: Set<number> } {
  if (!rawKey) return { edits: {}, removed: new Set() };
  try {
    const raw = window.localStorage.getItem(rawKey);
    if (!raw) return { edits: {}, removed: new Set() };
    const p = JSON.parse(raw) as PrepStorageV1 | Record<string, AnyPreviewRecord>;
    if (p && typeof p === "object" && "v" in p && (p as PrepStorageV1).v === 1) {
      const v1 = p as PrepStorageV1;
      return { edits: v1.edits ?? {}, removed: new Set(v1.removed ?? []) };
    }
    return { edits: p as Record<number, AnyPreviewRecord>, removed: new Set() };
  } catch {
    return { edits: {}, removed: new Set() };
  }
}

function mergePrepRecordRows(
  baseRecords: AnyPreviewRecord[],
  edits: Record<number, AnyPreviewRecord>,
  removed: ReadonlySet<number>,
): MergedPrepRecordRow[] {
  const indexSet = new Set<number>();
  baseRecords.forEach((_, i) => indexSet.add(i));
  for (const k of Object.keys(edits)) {
    const i = Number.parseInt(k, 10);
    if (Number.isFinite(i)) indexSet.add(i);
  }
  const out: MergedPrepRecordRow[] = [];
  const sortedIndices = Array.from(indexSet);
  sortedIndices.sort((a, b) => a - b);
  for (const originalIndex of sortedIndices) {
    if (removed.has(originalIndex)) continue;
    const baseRow = baseRecords[originalIndex];
    const edited = edits[originalIndex];
    const record =
      edited !== undefined
        ? overlayServerOwnedPrepFields(baseRow, edited)
        : baseRow;
    if (record === undefined) continue;
    out.push({ originalIndex, record });
  }
  return out;
}

// Wire the per-record editor renderers into the registry once at module
// load. Done here (not in the registry file) so the registry stays a plain
// `.ts` and avoids a circular dep on `components/ocr/`.
setOcrDownstreamRenderer("ocr", ({ record, onChange, onForceResearch, isResearching }) => (
  <EcRecordView
    record={record as PreviewRecord}
    onChange={(next) => onChange(next)}
    onForceResearch={
      onForceResearch ? (rec) => onForceResearch(rec as AnyOcrPreviewRecord) : undefined
    }
    isResearching={isResearching}
  />
));
setOcrDownstreamRenderer("emergency-contact", ({ record, onChange, onForceResearch, isResearching }) => (
  <EcRecordView
    record={record as PreviewRecord}
    onChange={(next) => onChange(next)}
    onForceResearch={
      onForceResearch ? (rec) => onForceResearch(rec as AnyOcrPreviewRecord) : undefined
    }
    isResearching={isResearching}
  />
));
setOcrDownstreamRenderer("oath-signature", ({ record, onChange, onForceResearch, isResearching }) => (
  <OathRecordView
    record={record as OathPreviewRecord}
    onChange={(next) => onChange(next)}
    onForceResearch={
      onForceResearch ? (rec) => onForceResearch(rec as AnyOcrPreviewRecord) : undefined
    }
    isResearching={isResearching}
  />
));

/**
 * Legacy stacked layout (toolbar + body). Prefer {@link OcrReviewPrepProvider} +
 * {@link OcrReviewPrepToolbar} / {@link OcrReviewPrepBody} so the toolbar can sit in LogPanel's Preview header.
 */
export function OcrReviewPane({ entry, onClose, onReupload }: OcrReviewPaneProps) {
  const api = useOcrReviewPrepApi(true, entry, onClose, onReupload);
  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-card">
      {api.toolbar}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{api.body}</div>
    </div>
  );
}

function useOcrReviewPrepApi(
  prepActive: boolean,
  entry: TrackerEntry | null,
  onClose: () => void,
  onReupload?: OcrReviewPaneProps["onReupload"],
): OcrReviewPrepApiSnapshot {
  const sessionId = prepActive && entry ? entry.id : "";
  const runId = prepActive && entry ? (entry.runId ?? entry.id) : "";
  const cfg = useMemo(() => {
    if (!prepActive || !entry) return null;
    return resolveOcrConfigForEntry(entry);
  }, [prepActive, entry]);
  // Dedicated OCR run = no parent row in a downstream workflow (operator
  // ran the OCR workflow directly to inspect results). Delegations from
  // oath-signature / emergency-contact / oath-upload set parentRunId on
  // the OCR row; for those we keep the Approve flow that fans out child
  // queue items. Standalone runs hide Approve since there's nothing to
  // dispatch.
  const isDelegation = Boolean(prepActive && entry?.parentRunId);
  const data = useMemo(
    () => (cfg && entry ? cfg.parseRow(entry.data) ?? null : null),
    [entry?.data, cfg, entry],
  );
  const baseRecords = useMemo(() => data?.records ?? [], [data]);
  const storageKey = cfg ? cfg.editsKey({ sessionId, runId }) : "";

  const [localEdits, setLocalEdits] = useState<Record<number, AnyPreviewRecord>>(() =>
    loadPrepStorage(storageKey).edits,
  );
  const [removedRecordIndices, setRemovedRecordIndices] = useState<Set<number>>(() =>
    loadPrepStorage(storageKey).removed,
  );

  useEffect(() => {
    if (!storageKey) return;
    const next = loadPrepStorage(storageKey);
    setLocalEdits(next.edits);
    setRemovedRecordIndices(next.removed);
  }, [storageKey]);

  const [submitting, setSubmitting] = useState(false);
  const [researchingIndices, setResearchingIndices] = useState<Set<number>>(new Set());
  const [markedBlankPages, setMarkedBlankPages] = useState<Set<number>>(new Set());
  const { children: dependencyChildren } = useTaskDependencies(
    prepActive && entry ? (entry.runId ?? entry.id) : undefined,
  );

  // Persist edits — debounced 300ms so rapid keystrokes don't hit localStorage
  // synchronously on every character. Final write still lands; intermediate
  // writes are dropped. A `pagehide` listener flushes the pending write so a
  // tab close within 300ms of the last keystroke doesn't lose it.
  useEffect(() => {
    let pendingFlush: (() => void) | null = null;

    const flush = (): void => {
      if (Object.keys(localEdits).length === 0 && removedRecordIndices.size === 0) {
        try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
        return;
      }
      try {
        const payload: PrepStorageV1 = {
          v: 1,
          edits: localEdits,
          removed: [...removedRecordIndices],
        };
        window.localStorage.setItem(storageKey, JSON.stringify(payload));
      } catch { /* quota / unavailable */ }
    };

    const handle = window.setTimeout(() => {
      pendingFlush = null;
      flush();
    }, 300);
    pendingFlush = flush;

    const onPageHide = (): void => {
      if (pendingFlush) {
        pendingFlush();
        pendingFlush = null;
      }
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.clearTimeout(handle);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [localEdits, removedRecordIndices, storageKey]);

  const recordRows = useMemo(
    () => mergePrepRecordRows(baseRecords, localEdits, removedRecordIndices),
    [baseRecords, localEdits, removedRecordIndices],
  );

  const records: AnyPreviewRecord[] = useMemo(
    () => recordRows.map((e) => e.record),
    [recordRows],
  );

  const setRecord = (index: number, next: AnyPreviewRecord): void => {
    setLocalEdits((prev) => ({ ...prev, [index]: next }));
  };

  const removeRecord = useCallback((originalIndex: number) => {
    setRemovedRecordIndices((prev) => new Set(prev).add(originalIndex));
    setLocalEdits((prev) => {
      if (!(originalIndex in prev)) return prev;
      const next = { ...prev };
      delete next[originalIndex];
      return next;
    });
  }, []);

  const cursorKey = cfg ? cfg.cursorKey({ sessionId, runId }) : "";
  const { containerRef, onPairVisible, clear: clearCursor } = usePrepCursor({
    storageKey: cursorKey,
    enabled: prepActive && cfg !== null,
    recordCount: recordRows.length,
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
  }, [containerRef, onPairVisible, recordRows.length]);

  // Group records by sourcePage, interleaved with failed pages, sorted by page number.
  type PageRender =
    | { kind: "records"; page: number; group: Array<{ record: AnyPreviewRecord; originalIndex: number }> }
    | { kind: "failed"; page: number; failedPage: FailedPage }
    | { kind: "empty"; page: number };

  const failedPages = data?.failedPages ?? [];
  const emptyPages = data?.emptyPages ?? [];

  type PageRenderWithOrdinals =
    | { kind: "records"; page: number; group: Array<{ record: AnyPreviewRecord; originalIndex: number }>; ordinals: number[] }
    | PageRender;

  const renderList = useMemo<PageRender[]>(() => {
    const recordsByPage = new Map<number, Array<{ record: AnyPreviewRecord; originalIndex: number }>>();
    recordRows.forEach(({ record: r, originalIndex }) => {
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
  }, [recordRows, failedPages, emptyPages, markedBlankPages]);

  const renderListWithOrdinals = useMemo<PageRenderWithOrdinals[]>(() => {
    let n = 0;
    return renderList.map((item): PageRenderWithOrdinals => {
      if (item.kind !== "records") return item;
      const ordinals = item.group.map(() => ++n);
      return { ...item, ordinals };
    });
  }, [renderList]);

  const totalPages = data?.pageStatusSummary?.total ?? renderList.length;
  const approvableRecords = useMemo(
    () => records.filter((r) => isApprovable(r)),
    [records],
  );
  const { selectedCount, unselectedApprovableCount } = useMemo(() => {
    const selected = approvableRecords.filter((r) => r.selected).length;
    return {
      selectedCount: selected,
      unselectedApprovableCount: approvableRecords.length - selected,
    };
  }, [approvableRecords]);

  function selectAllApprovable(): void {
    setLocalEdits((prev) => {
      const next = { ...prev };
      recordRows.forEach(({ record: r, originalIndex: idx }) => {
        if (!isApprovable(r)) return;
        if (r.selected) return;
        next[idx] = { ...r, selected: true } as AnyPreviewRecord;
      });
      return next;
    });
  }

  async function handleForceResearch(indices: number[]) {
    setResearchingIndices(new Set(indices));
    try {
      const r = await fetch("/api/ocr/force-research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, runId, recordIndices: indices }),
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

  function triggerForceResearchForIndex(originalIndex: number): void {
    void handleForceResearch([originalIndex]);
  }

  function addBlankRow(page: number): void {
    if (!cfg) return;
    const onPageCount = recordRows.filter(
      (e) => (e.record as { sourcePage: number }).sourcePage === page,
    ).length;
    const indexSet = new Set<number>();
    baseRecords.forEach((_, i) => indexSet.add(i));
    for (const k of Object.keys(localEdits)) {
      const i = Number.parseInt(k, 10);
      if (Number.isFinite(i)) indexSet.add(i);
    }
    const nextIndex = Math.max(-1, ...indexSet) + 1;
    const blank = {
      sourcePage: page,
      rowIndex: onPageCount,
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
    setLocalEdits((prev) => ({ ...prev, [nextIndex]: blank }));
  }

  async function handleApprove() {
    if (submitting || !cfg) return;
    if (selectedCount <= 0) {
      toast.error("Select at least one reviewed record before approving.");
      return;
    }
    setSubmitting(true);
    try {
      const resp = await fetch(cfg.approveUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          runId,
          records: recordRows.map((e) => e.record),
        }),
      });
      const body = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        enqueued?: number;
        fannedOut?: Array<{ workflow: string; itemId: string }>;
      };
      if (!resp.ok || !body.ok) {
        toast.error("Couldn't approve batch", {
          description: body.error ?? "Server error",
        });
        setSubmitting(false);
        return;
      }
      const queued = body.enqueued ?? body.fannedOut?.length ?? selectedCount;
      toast.success(
        `Queued ${queued} record${queued === 1 ? "" : "s"}`,
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

  if (!prepActive || !entry) {
    return { active: false, toolbar: null, body: null };
  }

  if (!cfg) {
    return {
      active: true,
      toolbar: null,
      body: (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-8 text-muted-foreground">
          No OCR review config registered for workflow="{entry.workflow}".
        </div>
      ),
    };
  }

  if (!data) {
    return {
      active: true,
      toolbar: null,
      body: (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-8 text-muted-foreground">
          Couldn't parse prep row data.
        </div>
      ),
    };
  }

  const toolbar = (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <FileScan className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <h2 className="min-w-0 max-w-[min(100%,28rem)] truncate text-sm font-semibold text-foreground">
            {data.pdfOriginalName || "Prep review"}
          </h2>
          <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            {failedPages.length > 0 && (
              <ReocrWholePdfButton
                sessionId={sessionId}
                runId={runId}
                storageKey={storageKey}
                onSuccess={() => {
                  setLocalEdits({});
                  setRemovedRecordIndices(new Set());
                }}
              />
            )}
            {onReupload && (
              <button
                type="button"
                onClick={() =>
                  onReupload({ sessionId: entry.id, previousRunId: entry.runId ?? entry.id })
                }
                disabled={submitting}
                title="Re-upload corrected PDF — carries forward resolved EIDs from this run"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium leading-none text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                <UploadCloud className="h-3 w-3" aria-hidden /> Reupload
              </button>
            )}
            {isDelegation && unselectedApprovableCount > 0 && (
              <button
                type="button"
                onClick={selectAllApprovable}
                disabled={submitting}
                title="Select every approvable record (matched/resolved with a valid EID, not inactive/non-HDH)"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium leading-none text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                Select all ({unselectedApprovableCount})
              </button>
            )}
            {isDelegation && (
              <button
                type="button"
                onClick={handleApprove}
                disabled={submitting || selectedCount <= 0}
                title={selectedCount <= 0 ? "Select at least one approvable record (checkbox)." : undefined}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-primary bg-primary px-2.5 text-xs font-medium text-primary-foreground",
                  "leading-none hover:bg-primary/90",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                {submitting && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
                Approve {selectedCount}
              </button>
            )}
            <span className="inline-flex h-8 shrink-0 items-center rounded-md border border-border bg-secondary/40 px-2.5 font-mono text-[11px] font-medium leading-none tabular-nums text-muted-foreground">
              {recordRows.length} records
            </span>
          </div>
        </div>
  );

  const body = (
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-secondary/30">
        <div className="space-y-5 px-6 py-5">
          {renderListWithOrdinals.map((renderEntry) => {
            if (renderEntry.kind === "failed") {
              return (
                <section
                  key={`failed-${renderEntry.page}`}
                  className="border-b border-border pb-5 last:border-b-0 last:pb-0"
                >
                  <FailedPageCard
                    failedPage={renderEntry.failedPage}
                    totalPages={totalPages}
                    sessionId={sessionId}
                    runId={runId}
                  />
                </section>
              );
            }
            if (renderEntry.kind === "empty") {
              return (
                <section
                  key={`empty-${renderEntry.page}`}
                  className="border-b border-border pb-5 last:border-b-0 last:pb-0"
                >
                  <div className="grid grid-cols-[minmax(420px,1.15fr)_minmax(360px,0.85fr)] gap-4 p-4">
                    <div className="self-start">
                      <PdfPagePreview
                        workflow={entry.workflow}
                        parentRunId={sessionId}
                        page={renderEntry.page}
                        fileId={data.pdfFileId}
                      />
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
                </section>
              );
            }
            const { page, group, ordinals } = renderEntry;
            if (group.length === 1) {
              const { record, originalIndex } = group[0];
              const rowOrdinal = ordinals[0];
              return (
                <section
                  key={page}
                  className="border-b border-border pb-5 last:border-b-0 last:pb-0"
                >
                  <div data-pair-index={originalIndex}>
                    <PrepReviewPair
                      workflow={entry.workflow}
                      parentRunId={sessionId}
                      page={page}
                      fileId={data.pdfFileId}
                      titleBar={renderFormCardNav({
                        record,
                        cfg,
                        totalPages,
                        originalIndex,
                        rowOrdinal,
                        entryStatus: entry.status,
                        entryStep: entry.step,
                        dependencyChildren,
                        onBatchSelectedChange: (selected) =>
                          setRecord(originalIndex, { ...record, selected } as AnyPreviewRecord),
                      })}
                      formCard={renderFormCard({
                        record,
                        cfg,
                        totalPages,
                        originalIndex,
                        rowOrdinal,
                        entryStatus: entry.status,
                        entryStep: entry.step,
                        dependencyChildren,
                        researchingIndices,
                        onForceResearchSingle: cfg.supportsForceResearch ? triggerForceResearchForIndex : undefined,
                        onRemoveRecord: removeRecord,
                        removeBusy: submitting,
                        hideHeader: true,
                        onChange: (next) => setRecord(originalIndex, next),
                      })}
                    />
                  </div>
                </section>
              );
            }
            const cards = group.map(({ record, originalIndex }, rowIdx) => (
              <div key={originalIndex} data-pair-index={originalIndex}>
                {renderFormCard({
                  record,
                  cfg,
                  totalPages,
                  originalIndex,
                  rowOrdinal: ordinals[rowIdx],
                  entryStatus: entry.status,
                  entryStep: entry.step,
                  dependencyChildren,
                  researchingIndices,
                  onForceResearchSingle: cfg.supportsForceResearch ? triggerForceResearchForIndex : undefined,
                  onRemoveRecord: removeRecord,
                  removeBusy: submitting,
                  rowOnPage: rowIdx + 1,
                  totalRowsOnPage: group.length,
                  onChange: (next) => setRecord(originalIndex, next),
                })}
              </div>
            ));
            return (
              <section
                key={page}
                className="border-b border-border pb-5 last:border-b-0 last:pb-0"
              >
                <PrepReviewMultiPair
                  workflow={entry.workflow}
                  parentRunId={sessionId}
                  page={page}
                  fileId={data.pdfFileId}
                  formCards={cards}
                  onAddRow={addBlankRow}
                />
              </section>
            );
          })}
        </div>
      </div>
  );

  return { active: true, toolbar, body };
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
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground hover:bg-muted"
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
  // Verification gate: only HARD-block inactive employees. Non-HDH is still
  // HR-active, so the operator can approve when the EID and form data are right.
  // `lookup-failed` (Person Org Summary returned nothing) and absent-yet
  // states fall through as approvable. An EID resolved by eid-lookup is enough
  // signal to dispatch — verification is auxiliary.
  const v = record.verification?.state;
  const verifyOk = v !== "inactive";
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

function renderFormCard(args: {
  record: AnyPreviewRecord;
  cfg: OcrDownstreamConfigType;
  totalPages: number;
  originalIndex: number;
  rowOrdinal: number;
  entryStatus: string;
  entryStep?: string;
  dependencyChildren: TaskDependencyChild[];
  researchingIndices: ReadonlySet<number>;
  onForceResearchSingle?: (index: number) => void;
  onRemoveRecord: (index: number) => void;
  removeBusy: boolean;
  hideHeader?: boolean;
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

  const workflowStatusPhase = deriveRecordWorkflowPhase({
    record: r,
    originalIndex: args.originalIndex,
    entryStatus: args.entryStatus,
    entryStep: args.entryStep,
    dependencyChildren: args.dependencyChildren,
  });
  const matchStateBadge = renderMatchBadge({ record: r });
  const isUnknown = r.documentType === "unknown";
  const isResearching = args.researchingIndices.has(args.originalIndex);

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
  const signatureBanner = renderOathSignatureBanner(r, args.cfg.hasSignature);

  return (
    <PrepReviewFormCard
      pageLocation={pageLocation}
      recordName={recordName}
      rowOrdinal={args.rowOrdinal}
      workflowStatusPhase={workflowStatusPhase}
      matchStateBadge={matchStateBadge}
      employmentStatusBadge={renderEmploymentStatusBadge(r.verification)}
      footerAction={
        args.onForceResearchSingle ? (
          <button
            type="button"
            onClick={() => args.onForceResearchSingle!(args.originalIndex)}
            disabled={isResearching}
            title="Re-run lookup for this record"
            aria-label="Re-run lookup for this record"
            className={cn(
              "inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground outline-none transition-colors",
              "hover:border-primary/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card",
              "disabled:cursor-wait disabled:opacity-60",
            )}
          >
            <RotateCw className={cn("h-3.5 w-3.5", isResearching && "animate-spin")} aria-hidden />
          </button>
        ) : undefined
      }
      onDeleteRecord={() => {
        if (args.removeBusy) return;
        if (!window.confirm("Remove this record from the batch?")) return;
        args.onRemoveRecord(args.originalIndex);
      }}
      deleteDisabled={args.removeBusy}
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
      signatureBanner={signatureBanner}
      selected={r.selected}
      selectedDisabled={isUnknown}
      hideHeader={args.hideHeader}
      onSelectedChange={(next) =>
        args.onChange({ ...r, selected: next } as AnyPreviewRecord)
      }
    >
      {args.cfg.renderEditor({
        record: r,
        onChange: (next) => args.onChange(next),
        isResearching,
      })}
    </PrepReviewFormCard>
  );
}

function renderFormCardNav(args: {
  record: AnyPreviewRecord;
  cfg: OcrDownstreamConfigType;
  totalPages: number;
  originalIndex: number;
  rowOrdinal: number;
  entryStatus: string;
  entryStep?: string;
  dependencyChildren: TaskDependencyChild[];
  rowOnPage?: number;
  totalRowsOnPage?: number;
  onBatchSelectedChange: (selected: boolean) => void;
}): ReactNode {
  const sourcePage = (args.record as { sourcePage: number }).sourcePage;
  const pageLocation = args.totalRowsOnPage
    ? `Page ${sourcePage} of ${args.totalPages}, Row ${args.rowOnPage} of ${args.totalRowsOnPage} in pile`
    : `Page ${sourcePage} of ${args.totalPages} in pile`;
  const isUnknown = args.record.documentType === "unknown";
  return (
    <PrepReviewRecordNav
      pageLocation={pageLocation}
      recordName={args.cfg.recordName(args.record)}
      rowOrdinal={args.rowOrdinal}
      workflowStatusPhase={deriveRecordWorkflowPhase({
        record: args.record,
        originalIndex: args.originalIndex,
        entryStatus: args.entryStatus,
        entryStep: args.entryStep,
        dependencyChildren: args.dependencyChildren,
      })}
      signatureBadge={renderSignatureBadge(args.record, args.cfg.hasSignature)}
      documentTypeBadge={
        isUnknown ? (
          <span className="rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-px font-mono text-[10px] uppercase text-destructive">
            unknown
          </span>
        ) : undefined
      }
      selected={args.record.selected}
      selectedDisabled={isUnknown}
      onSelectedChange={args.onBatchSelectedChange}
    />
  );
}

/** Person Org Summary outcome — orthogonal to roster/EID match (who this row is). */
function renderEmploymentStatusBadge(v: Verification | undefined): ReactNode {
  if (!v) return null;
  if (v.state === "verified") {
    return (
      <span
        className="font-mono text-[10px] font-semibold uppercase tracking-wide text-success"
        title={`HR status: ${v.hrStatus}`}
      >
        Active
      </span>
    );
  }
  if (v.state === "inactive") {
    return (
      <span
        className="font-mono text-[10px] font-semibold uppercase tracking-wide text-destructive"
        title={`HR status: ${v.hrStatus}`}
      >
        Inactive
      </span>
    );
  }
  if (v.state === "non-hdh") {
    return (
      <span
        className="font-mono text-[10px] font-semibold uppercase tracking-wide text-warning"
        title={v.department ? `HR status: ${v.hrStatus}; non-HDH dept: ${v.department}` : `HR status: ${v.hrStatus}; non-HDH dept`}
      >
        Active
      </span>
    );
  }
  if (v.state === "lookup-failed") {
    return (
      <span
        className="font-mono text-[10px] uppercase tracking-wide text-warning"
        title={v.error ?? "Lookup did not classify active status"}
      >
        Unverified
      </span>
    );
  }
  return (
    <span className="font-mono text-[10px] uppercase tracking-wide text-warning">
      Pending
    </span>
  );
}

function deriveRecordWorkflowPhase(args: {
  record: AnyPreviewRecord;
  originalIndex: number;
  entryStatus: string;
  entryStep?: string;
  dependencyChildren: TaskDependencyChild[];
}): PrepRecordWorkflowPhase {
  const childStatuses = args.dependencyChildren
    .filter((child) => child.metadata.recordIndex === args.originalIndex)
    .map((child) => child.status);
  if (childStatuses.some(isRunningChildStatus)) return "running";
  if (childStatuses.some(isPendingChildStatus)) return "pending";

  const lookupState = String(args.record.matchState ?? "");
  const step = args.entryStep ?? "";
  if (
    args.entryStatus === "running" &&
    (step === "matching" || step === "disambiguating" || step === "eid-lookup" || step === "verification") &&
    (lookupState === "extracted" || lookupState === "lookup-pending" || lookupState === "lookup-running")
  ) {
    return "running";
  }
  if (lookupState === "lookup-running") return "running";

  return "done";
}

function renderMatchBadge(args: { record: AnyPreviewRecord }): ReactNode {
  const display = getMatchSourceDisplay(args.record);
  return (
    <span
      className={cn(
        "rounded-md border px-1.5 py-px font-mono text-[10px] uppercase",
        display.className,
      )}
    >
      {display.label}
    </span>
  );
}

function getMatchSourceDisplay(record: AnyPreviewRecord): { label: string; className: string } {
  const source = String(record.matchSource ?? "");
  if (source === "roster") {
    return { label: "Match: roster", className: "border-success/40 bg-success/10 text-success" };
  }
  if (source === "form-eid") {
    return { label: "Match: EID on form", className: "border-success/40 bg-success/10 text-success" };
  }
  if (source === "llm") {
    return { label: "Match: LLM", className: "border-warning/40 bg-warning/10 text-warning" };
  }
  if (source === "eid-lookup") {
    return { label: "Match: eid-lookup", className: "border-primary/40 bg-primary/10 text-primary" };
  }
  if (source === "manual") {
    return { label: "Match: manual", className: "border-border bg-muted text-muted-foreground" };
  }
  return { label: "Match: pending", className: "border-border bg-muted text-muted-foreground" };
}

function isRunningChildStatus(status: string): boolean {
  return status === "running" || status === "in_progress" || status === "processing";
}

function isPendingChildStatus(status: string): boolean {
  return status === "queued" || status === "pending" || status === "ready";
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
