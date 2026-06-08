import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Check, FileScan, Loader2, RotateCw, UploadCloud } from "lucide-react";
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
  type FailedPage,
} from "./types";
import { type OathPreviewRecord } from "./types";
import { FailedPageCard } from "./FailedPageCard";
import { PrepReviewPair } from "./PrepReviewPair";
import { PrepReviewMultiPair } from "./PrepReviewMultiPair";
import {
  PrepReviewFormCard,
  PrepReviewRecordNav,
} from "./PrepReviewFormCard";
import { EmptyPagePlaceholder } from "./EmptyPagePlaceholder";
import { EcRecordView } from "./EcRecordView";
import { OathRecordView } from "./OathRecordView";
import { VerifyRecordView } from "./VerifyRecordView";
import { toReadonlyVerifyRecord } from "./readonly-record";
import {
  deriveOcrRecordLookupTracker,
  deriveRecordWorkflowPhase,
  lookupTrackerClassName,
  type OcrRecordLookupTracker,
} from "./lookup-status";
import { RecordScreenshotStrip } from "./RecordScreenshotStrip";
import type { VerifyLookupKind, VerifyPreviewRecord } from "./types";
import { PdfPagePreview } from "@/components/shared/PdfPagePreview";
import { useConfirm } from "@/components/shared/useConfirm";
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
// Narrow on record.formKind so the unknown-formType fallthrough in
// resolveOcrConfigForEntry (which defaults to the EC config when
// data.formType is missing or unrecognized) doesn't route an oath-shaped
// record into EcRecordView and crash on record.employee.name. The
// "ocr" registration is the fallback used by direct OCR-workflow rows;
// the per-variant registrations are picked when the OCR row has a known
// downstream workflow.
setOcrDownstreamRenderer("ocr", ({ record, onChange, onForceResearch, isResearching }) => {
  if (record.formKind === "oath") {
    return (
      <OathRecordView
        record={record}
        onChange={(next) => onChange(next)}
        onForceResearch={onForceResearch ? (rec) => onForceResearch(rec) : undefined}
        isResearching={isResearching}
      />
    );
  }
  return (
    <EcRecordView
      record={record}
      onChange={(next) => onChange(next)}
      onForceResearch={onForceResearch ? (rec) => onForceResearch(rec) : undefined}
      isResearching={isResearching}
    />
  );
});
setOcrDownstreamRenderer("emergency-contact", ({ record, onChange, onForceResearch, isResearching }) => {
  if (record.formKind !== "emergency-contact") {
    console.error(
      "[OcrReviewPane] emergency-contact renderer received non-EC record",
      { formKind: record.formKind },
    );
    return null;
  }
  return (
    <EcRecordView
      record={record}
      onChange={(next) => onChange(next)}
      onForceResearch={onForceResearch ? (rec) => onForceResearch(rec) : undefined}
      isResearching={isResearching}
    />
  );
});
setOcrDownstreamRenderer("oath-signature", ({ record, onChange, onForceResearch, isResearching }) => {
  if (record.formKind !== "oath") {
    console.error(
      "[OcrReviewPane] oath-signature renderer received non-oath record",
      { formKind: record.formKind },
    );
    return null;
  }
  return (
    <OathRecordView
      record={record}
      onChange={(next) => onChange(next)}
      onForceResearch={onForceResearch ? (rec) => onForceResearch(rec) : undefined}
      isResearching={isResearching}
    />
  );
});
setOcrDownstreamRenderer("verify", ({ record, onRelookup, relookupPending, lookupTracker }) =>
  "checks" in record ? (
    <VerifyRecordView
      record={record as VerifyPreviewRecord}
      onRelookup={onRelookup}
      relookupPending={relookupPending}
      lookupTracker={lookupTracker}
    />
  ) : null,
);

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
  // Show Approve ONLY when the OCR row is a DELEGATION — a target workflow
  // (oath-signature / oath-upload / emergency-contact) ran OCR as a sub-step and
  // set `parentRunId`, so downstream steps consume the approved data. A
  // STANDALONE OCR run (operator uploaded straight to the OCR panel, no
  // `parentRunId`) is inspect-and-discard only: nothing downstream consumes its
  // output, so there is nothing to approve — the operator reads the extraction
  // and ×-discards. Real fan-out (signers / EC fills / tickets) is reached
  // exclusively through a target panel, never a standalone OCR approve. (This is
  // the form-spec-agnostic rule: approval ≡ delegation, not `hasApproveFanOut`.)
  const isDelegation = Boolean(prepActive && entry && entry.parentRunId);
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
  useEffect(() => { setSubmitting(false); }, [sessionId, runId]);
  const [researchingIndices, setResearchingIndices] = useState<Set<number>>(new Set());
  // verify per-check relookup pending — keyed `${recordIndex}:${lookup}`.
  const [relookupPending, setRelookupPending] = useState<Set<string>>(new Set());
  useEffect(() => { setRelookupPending(new Set()); }, [sessionId, runId]);
  const [markedBlankPages, setMarkedBlankPages] = useState<Set<number>>(new Set());
  const { summary: dependencySummary, children: dependencyChildren } = useTaskDependencies(
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

  const { confirm, confirmDialog } = useConfirm();

  const removeRecord = useCallback(async (originalIndex: number) => {
    const ok = await confirm({
      tone: "destructive",
      title: "Remove this record?",
      description: "It will be dropped from this batch before approval.",
      confirmLabel: "Remove",
    });
    if (!ok) return;
    setRemovedRecordIndices((prev) => new Set(prev).add(originalIndex));
    setLocalEdits((prev) => {
      if (!(originalIndex in prev)) return prev;
      const next = { ...prev };
      delete next[originalIndex];
      return next;
    });
  }, [confirm]);

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
  const selectedCount = useMemo(
    () => approvableRecords.filter((r) => r.selected).length,
    [approvableRecords],
  );
  const hasPendingDependencies = (dependencySummary?.pending ?? 0) > 0;

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

  // verify: re-run ONE background lookup (person | i9) for ONE record. The
  // request stays open for the whole lookup; the row re-emits with patched
  // `data.records` when it resolves, so the spinner clears as the new value
  // streams back in. Keyed by `${recordIndex}:${lookup}` so person + i9 (and
  // distinct records) track independently.
  const handleRelookup = useCallback(
    async (recordIndex: number, lookup: VerifyLookupKind): Promise<void> => {
      const key = `${recordIndex}:${lookup}`;
      setRelookupPending((prev) => new Set(prev).add(key));
      try {
        const r = await fetch("/api/ocr/verify-relookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, runId, recordIndex, lookup }),
        });
        if (!r.ok) {
          const body = (await r.json()) as { error?: string };
          toast.error("Re-lookup failed", { description: body.error });
        } else {
          toast.success(lookup === "i9" ? "Re-ran I-9 signer lookup" : "Re-ran person lookup");
        }
      } catch (err) {
        toast.error("Re-lookup failed", {
          description: err instanceof Error ? err.message : "Network error",
        });
      } finally {
        setRelookupPending((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [sessionId, runId],
  );

  function addBlankRow(page: number): void {
    if (!cfg) return;
    if (cfg.formKind === "verify") return;
    const onPageCount = recordRows.filter(
      (e) => e.record.sourcePage === page,
    ).length;
    const indexSet = new Set<number>();
    baseRecords.forEach((_, i) => indexSet.add(i));
    for (const k of Object.keys(localEdits)) {
      const i = Number.parseInt(k, 10);
      if (Number.isFinite(i)) indexSet.add(i);
    }
    const nextIndex = Math.max(-1, ...indexSet) + 1;
    // Per-variant blank: oath rows expect printedName / employeeSigned / etc.;
    // EC rows expect employee / emergencyContact subtrees. Mixing them
    // (the pre-2026-05-18 single-shape blank) injected oath-shaped rows into
    // EC sessions and the server then rejected the approve. `satisfies` here
    // forces TS to verify each branch against its variant's full required
    // field set — do NOT downgrade to `as` if a future field is added.
    let blank: AnyPreviewRecord;
    if (cfg.formKind === "oath") {
      blank = {
        formKind: "oath",
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
      } satisfies OathPreviewRecord;
    } else {
      // EC's PreviewRecord.matchSource union excludes "manual" / "form-eid"
      // (backend Zod is `z.enum(["form", "roster", "eid-lookup", "llm"])`),
      // so leave matchSource undefined on operator-added blanks — the
      // operator fills the EID/name and the next eid-lookup or approve
      // path sets the real matchSource.
      blank = {
        formKind: "emergency-contact",
        sourcePage: page,
        employee: { name: "", employeeId: "" },
        emergencyContact: {
          name: "",
          relationship: "",
          primary: true,
          sameAddressAsEmployee: true,
        },
        notes: [],
        matchState: "lookup-pending",
        selected: false,
        warnings: [],
        documentType: "expected",
        originallyMissing: [],
      } satisfies PreviewRecord;
    }
    setLocalEdits((prev) => ({ ...prev, [nextIndex]: blank }));
  }

  async function handleApprove() {
    if (submitting || !cfg) return;
    if (hasPendingDependencies) {
      toast.error("OCR lookup retry is still running. Wait for the preview data to update before approving.");
      return;
    }
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
            {/* Variant B — "connected segmented group": one cohesive pill binds
                the secondary Reupload control to a hairline-divided, filled-primary
                Approve segment, so the cluster reads as a single deliberate control.
                Read-only (standalone OCR) shows just Reupload; delegated adds the
                divider + Approve. No standalone record-count chip. */}
            {(onReupload || isDelegation) && (
              <div className="inline-flex h-8 shrink-0 items-center rounded-lg border border-border bg-secondary/40 p-0.5">
                {onReupload && (
                  <button
                    type="button"
                    onClick={() =>
                      onReupload({ sessionId: entry.id, previousRunId: entry.runId ?? entry.id })
                    }
                    disabled={submitting}
                    aria-label="Reupload corrected PDF"
                    title="Re-upload corrected PDF — carries forward resolved EIDs from this run"
                    className={cn(
                      "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium leading-none text-muted-foreground",
                      "transition-colors duration-150 hover:bg-secondary hover:text-foreground",
                      "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    )}
                  >
                    <UploadCloud className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    Reupload
                  </button>
                )}

                {isDelegation && (
                  <>
                    {onReupload && (
                      <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />
                    )}
                    <button
                      type="button"
                      onClick={handleApprove}
                      disabled={submitting || selectedCount <= 0 || hasPendingDependencies}
                      aria-label={`Approve ${selectedCount} ${selectedCount === 1 ? "record" : "records"}`}
                      title={
                        hasPendingDependencies
                          ? "Wait for OCR lookup retries to finish before approving."
                          : selectedCount <= 0
                            ? "Select at least one approvable record (checkbox)."
                            : undefined
                      }
                      className={cn(
                        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold leading-none text-primary-foreground",
                        "transition-[background-color,transform] duration-150 ease-out",
                        "hover:bg-primary/90 active:translate-y-[0.5px]",
                        // Disabled (no selection / pending deps) → dim. Submitting keeps full
                        // saturation so the spinner reads as "working" not "dead".
                        "disabled:cursor-not-allowed",
                        !submitting && "disabled:opacity-50 disabled:active:translate-y-0",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                      )}
                    >
                      {submitting ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
                      ) : (
                        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      )}
                      <span className="tabular-nums">Approve {selectedCount}</span>
                    </button>
                  </>
                )}
              </div>
            )}
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
                      screenshotStrip={
                        !isDelegation
                          ? recordScreenshotStrip({
                              ocrRunId: runId,
                              recordIndex: originalIndex,
                              recordFormKind: record.formKind,
                              runFormType: cfg.formKind,
                              relookupPendingKeys: relookupPending,
                            })
                          : undefined
                      }
                      formCard={renderFormCard({
                        record,
                        cfg,
                        totalPages,
                        originalIndex,
                        rowOrdinal,
                        ocrRunId: runId,
                        entryStatus: entry.status,
                        entryStep: entry.step,
                        dependencyChildren,
                        researchingIndices,
                        onForceResearchSingle: cfg.supportsForceResearch ? triggerForceResearchForIndex : undefined,
                        onRelookup: handleRelookup,
                        relookupPendingKeys: relookupPending,
                        onRemoveRecord: removeRecord,
                        removeBusy: submitting,
                        hideHeader: true,
                        readOnly: !isDelegation,
                        // Strip is lifted to the pair block above — don't render it in the card.
                        omitScreenshotStrip: true,
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
                  ocrRunId: runId,
                  entryStatus: entry.status,
                  entryStep: entry.step,
                  dependencyChildren,
                  researchingIndices,
                  onForceResearchSingle: cfg.supportsForceResearch ? triggerForceResearchForIndex : undefined,
                  onRelookup: handleRelookup,
                  relookupPendingKeys: relookupPending,
                  onRemoveRecord: removeRecord,
                  removeBusy: submitting,
                  rowOnPage: rowIdx + 1,
                  totalRowsOnPage: group.length,
                  readOnly: !isDelegation,
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

  return {
    active: true,
    toolbar,
    body: (
      <>
        {body}
        {confirmDialog}
      </>
    ),
  };
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
            {busy && <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />}
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

/**
 * Returns the subset of `["person", "i9"]` lookup kinds that are currently
 * pending for `idx` inside the global `${idx}:${kind}` pending set.
 * Single source for the kind list used by both `renderFormCard` and
 * `recordScreenshotStrip`.
 */
function pendingLookupKeysFor(keys: ReadonlySet<string>, idx: number): VerifyLookupKind[] {
  return (["person", "i9"] as VerifyLookupKind[]).filter((lk) => keys.has(`${idx}:${lk}`));
}

function renderFormCard(args: {
  record: AnyPreviewRecord;
  cfg: OcrDownstreamConfigType;
  totalPages: number;
  originalIndex: number;
  rowOrdinal: number;
  /** OCR prep run id — addresses the per-record lookup screenshots (verify). */
  ocrRunId: string;
  entryStatus: string;
  entryStep?: string;
  dependencyChildren: TaskDependencyChild[];
  researchingIndices: ReadonlySet<number>;
  onForceResearchSingle?: (index: number) => void;
  /** verify: re-run ONE lookup for this record. */
  onRelookup?: (index: number, lookup: VerifyLookupKind) => void;
  /** verify: pending relookup keys (`${index}:${lookup}`) across all records. */
  relookupPendingKeys?: ReadonlySet<string>;
  onRemoveRecord: (index: number) => void;
  removeBusy: boolean;
  hideHeader?: boolean;
  rowOnPage?: number;
  totalRowsOnPage?: number;
  /** Standalone (non-delegated) run → render the read-only ✓/✗ checklist, not the editable form. */
  readOnly: boolean;
  /** Single-record pair lifts the screenshot strip to the pair block — don't render it in the card. */
  omitScreenshotStrip?: boolean;
  onChange: (r: AnyPreviewRecord) => void;
}): ReactNode {
  const r = args.record;
  const sourcePage = (r as { sourcePage: number }).sourcePage;
  const pageLocation = args.totalRowsOnPage
    ? `Page ${sourcePage} of ${args.totalPages}, Row ${args.rowOnPage} of ${args.totalRowsOnPage} in pile`
    : `Page ${sourcePage} of ${args.totalPages} in pile`;
  const recordName = args.cfg.recordName(r);

  const lookupTracker = deriveOcrRecordLookupTracker({
    record: r,
    originalIndex: args.originalIndex,
    entryStatus: args.entryStatus,
    entryStep: args.entryStep,
    dependencyChildren: args.dependencyChildren,
  });
  const workflowStatusPhase = deriveRecordWorkflowPhase(lookupTracker);
  const matchStateBadge = renderLookupTrackerBadge(lookupTracker);
  const isUnknown = r.documentType === "unknown";
  const isResearching = args.researchingIndices.has(args.originalIndex);
  // verify: which lookups are re-running for THIS record (derived from the
  // global `${index}:${lookup}` pending set).
  const recordRelookupPending: ReadonlySet<VerifyLookupKind> | undefined =
    args.relookupPendingKeys
      ? new Set(pendingLookupKeysFor(args.relookupPendingKeys, args.originalIndex))
      : undefined;

  const removeFromPileBanner = isUnknown ? (
    <span>
      Page {sourcePage} doesn't match the expected form template — REMOVE
      FROM PILE.
    </span>
  ) : undefined;
  const signatureBanner = renderOathSignatureBanner(r, args.cfg.hasSignature);

  // verify: the footer "retry" re-runs PERSON LOOKUP for this one record,
  // reusing the run (no new row) via /api/ocr/verify-relookup; oath/EC keep the
  // force-research button. The screenshot strip (verify only) renders the
  // record's per-lookup PNGs between the header and the body.
  const isVerify = args.cfg.formKind === "verify";
  const personRelookupPending = recordRelookupPending?.has("person") ?? false;
  const footerActionNode: ReactNode = isVerify
    ? args.onRelookup
      ? (
        <button
          type="button"
          onClick={() => args.onRelookup!(args.originalIndex, "person")}
          disabled={personRelookupPending}
          title="Re-run person lookup for this record"
          aria-label="Re-run person lookup for this record"
          className={cn(
            "inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground outline-none transition-colors",
            "hover:border-primary/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card",
            "disabled:cursor-wait disabled:opacity-60",
          )}
        >
          <RotateCw className={cn("h-3.5 w-3.5", personRelookupPending && "animate-spin motion-reduce:animate-none")} aria-hidden />
        </button>
      )
      : undefined
    : args.onForceResearchSingle
      ? (
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
          <RotateCw className={cn("h-3.5 w-3.5", isResearching && "animate-spin motion-reduce:animate-none")} aria-hidden />
        </button>
      )
      : undefined;
  // Read-only review rows (verify + standalone oath/EC) get the lookup
  // screenshot strip. In the single-record pair it is LIFTED to its own
  // full-width block (omitScreenshotStrip) so only the multi-record card renders
  // it inline here.
  const screenshotStripNode: ReactNode =
    args.readOnly && !args.omitScreenshotStrip ? (
      <RecordScreenshotStrip
        ocrRunId={args.ocrRunId}
        recordIndex={args.originalIndex}
        formKind={r.formKind}
        runFormType={args.cfg.formKind}
        refreshKey={recordRelookupPending ? recordRelookupPending.size : 0}
      />
    ) : undefined;

  // The body: a standalone oath/EC run is READ-ONLY (no downstream consumer, so
  // nothing to edit) — render the same ✓/✗ completeness checklist as a verify
  // card via `VerifyRecordView`. A delegated run keeps the editable form (its
  // edits feed the downstream write), and `verify` uses its own read-only
  // renderer (which also wires the per-check relookup).
  const recordBody: ReactNode =
    args.readOnly && !isVerify ? (
      <VerifyRecordView
        record={toReadonlyVerifyRecord(r as OathPreviewRecord | PreviewRecord)}
        lookupTracker={lookupTracker}
      />
    ) : (
      args.cfg.renderEditor({
        record: r,
        onChange: (next) => args.onChange(next),
        isResearching,
        onRelookup: args.onRelookup
          ? (lookup) => args.onRelookup!(args.originalIndex, lookup)
          : undefined,
        relookupPending: recordRelookupPending,
        lookupTracker,
      })
    );

  return (
    <PrepReviewFormCard
      pageLocation={pageLocation}
      recordName={recordName}
      rowOrdinal={args.rowOrdinal}
      workflowStatusPhase={workflowStatusPhase}
      matchStateBadge={matchStateBadge}
      footerAction={footerActionNode}
      screenshotStrip={screenshotStripNode}
      onDeleteRecord={() => {
        if (args.removeBusy) return;
        // Confirm happens inside onRemoveRecord (useConfirm dialog).
        void args.onRemoveRecord(args.originalIndex);
      }}
      deleteDisabled={args.removeBusy}
      documentKindChip={renderDocumentKindChip(r.formKind)}
      documentTypeBadge={
        isUnknown ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-px font-mono text-[10px] uppercase text-destructive">
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden /> unknown
          </span>
        ) : undefined
      }
      removeFromPileBanner={removeFromPileBanner}
      signatureBanner={signatureBanner}
      selected={r.selected}
      selectedDisabled={isUnknown}
      hideHeader={args.hideHeader}
      onSelectedChange={(next) =>
        args.onChange({ ...r, selected: next } as AnyPreviewRecord)
      }
    >
      {recordBody}
    </PrepReviewFormCard>
  );
}

/**
 * Build the lookup-screenshot strip for a read-only review record. Lifted to its
 * own full-width block in the single-record pair (between the header and the
 * PDF/checklist columns); self-hides when the record has no captured shots.
 */
function recordScreenshotStrip(args: {
  ocrRunId: string;
  recordIndex: number;
  recordFormKind: string;
  runFormType: OcrDownstreamConfigType["formKind"];
  relookupPendingKeys?: ReadonlySet<string>;
}): ReactNode {
  const refreshKey = args.relookupPendingKeys
    ? pendingLookupKeysFor(args.relookupPendingKeys, args.recordIndex).length
    : 0;
  return (
    <RecordScreenshotStrip
      ocrRunId={args.ocrRunId}
      recordIndex={args.recordIndex}
      formKind={args.recordFormKind}
      runFormType={args.runFormType}
      refreshKey={refreshKey}
    />
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
      workflowStatusPhase={deriveRecordWorkflowPhase(
        deriveOcrRecordLookupTracker({
          record: args.record,
          originalIndex: args.originalIndex,
          entryStatus: args.entryStatus,
          entryStep: args.entryStep,
          dependencyChildren: args.dependencyChildren,
        }),
      )}
      documentKindChip={renderDocumentKindChip(args.record.formKind)}
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

function renderLookupTrackerBadge(tracker: OcrRecordLookupTracker): ReactNode {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-px font-mono text-[10px] uppercase",
        lookupTrackerClassName(tracker.phase),
      )}
    >
      <span className="truncate">{tracker.label}</span>
      {tracker.traceId ? (
        <span className="shrink-0 text-current/70">{tracker.traceId}</span>
      ) : null}
    </span>
  );
}

/**
 * Document-kind chip (Oath / Emergency Contact) rendered at the head of the row
 * title in place of the `#ordinal` badge. Returns undefined for an `unknown`
 * page so the nav falls back to the ordinal — the destructive "unknown"
 * `documentTypeBadge` already flags those pages, so a second "Unknown" chip
 * would be redundant.
 *
 * (The former `renderSignatureBadge` header chip — "employee unsigned" /
 * "officer unsigned" — was removed: the same state is conveyed by the body's
 * signature banner (`renderOathSignatureBanner`) and the read-only checklist's
 * "Employee Signed / Officer Signed" rows, so the header chip was redundant.)
 */
function renderDocumentKindChip(formKind: string): ReactNode {
  if (formKind === "oath") {
    return (
      <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wide text-primary">
        Oath
      </span>
    );
  }
  if (formKind === "emergency-contact") {
    return (
      <span className="rounded border border-border bg-muted px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Emergency Contact
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
  if (r.formKind !== "oath") return null;
  const oath = r;
  if (oath.employeeSigned === false) {
    return <span>Signature missing — employee did not sign.</span>;
  }
  if (oath.officerSigned === false) {
    return <span>Signature missing — authorized officer did not sign.</span>;
  }
  return undefined;
}
