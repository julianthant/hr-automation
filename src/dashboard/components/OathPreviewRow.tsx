import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  Loader2,
  ListChecks,
  X as XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "./types";
import {
  parseOathPrepareRowData,
  type OathPreviewRecord,
  type OathPrepareRowData,
} from "./oath-preview-types";

/**
 * Parent prep row for an oath-signature paper-roster batch. Mirrors
 * emergency-contact's PreviewRow but the per-record shape is simpler
 * (just printedName + signed + dateSigned + employeeId) so the inline
 * edit lives in the same component instead of a separate file.
 *
 * Per-record edits persist to localStorage at `oath-prep-edits:<runId>`
 * so a reload restores them. Cleared on Approve / Discard.
 */
export interface OathPreviewRowProps {
  entry: TrackerEntry;
}

const STAGE_KEYS = ["loading-roster", "ocr", "matching", "eid-lookup"] as const;
const STAGE_LABELS: Record<(typeof STAGE_KEYS)[number], string> = {
  "loading-roster": "Loading roster",
  ocr: "OCR",
  matching: "Matching",
  "eid-lookup": "EID lookup",
};

export function OathPreviewRow({ entry }: OathPreviewRowProps) {
  const data = useMemo(() => parseOathPrepareRowData(entry.data), [entry.data]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [localEdits, setLocalEdits] = useState<Record<number, OathPreviewRecord>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(`oath-prep-edits:${entry.runId ?? entry.id}`);
      return raw ? (JSON.parse(raw) as Record<number, OathPreviewRecord>) : {};
    } catch {
      return {};
    }
  });

  const records = useMemo<OathPreviewRecord[]>(() => {
    if (!data) return [];
    return data.records.map((r, i) => localEdits[i] ?? r);
  }, [data, localEdits]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = `oath-prep-edits:${entry.runId ?? entry.id}`;
    if (Object.keys(localEdits).length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    try {
      window.localStorage.setItem(key, JSON.stringify(localEdits));
    } catch {
      /* quota / private mode — ignore */
    }
  }, [localEdits, entry.runId, entry.id]);

  if (!data) return null;

  const isFailed = entry.status === "failed";
  const isDone = entry.status === "done";
  const allTerminal = records.every(
    (r) =>
      r.matchState === "matched" ||
      r.matchState === "resolved" ||
      r.matchState === "unresolved" ||
      r.matchState === "extracted",
  );
  const readyForReview = !isFailed && allTerminal && records.length > 0;
  const inProgress = !isFailed && !readyForReview;

  const accentColor = isFailed ? "bg-destructive" : readyForReview ? "bg-warning" : "bg-primary";

  const approvableCount = records.filter(
    (r) => r.matchState === "matched" || r.matchState === "resolved",
  ).length;
  const selectedCount = records.filter(
    (r) =>
      r.selected && (r.matchState === "matched" || r.matchState === "resolved"),
  ).length;

  function setRecord(i: number, next: OathPreviewRecord): void {
    setLocalEdits((prev) => ({ ...prev, [i]: next }));
  }

  function toggleSelectAllApprovable(checked: boolean): void {
    setLocalEdits((prev) => {
      const out = { ...prev };
      records.forEach((r, i) => {
        if (r.matchState === "matched" || r.matchState === "resolved") {
          out[i] = { ...(out[i] ?? r), selected: checked };
        }
      });
      return out;
    });
  }

  async function handleApprove(): Promise<void> {
    if (submitting || !data) return;
    setSubmitting(true);
    try {
      const resp = await fetch("/api/oath-signature/approve-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentRunId: entry.runId, records }),
      });
      const body = (await resp.json()) as { ok: boolean; enqueued?: number; error?: string };
      if (!resp.ok || !body.ok) {
        toast.error("Couldn't approve batch", { description: body.error ?? "Server error" });
        setSubmitting(false);
        return;
      }
      toast.success(
        `Queued ${body.enqueued ?? selectedCount} record${(body.enqueued ?? selectedCount) === 1 ? "" : "s"}`,
        { description: data.pdfOriginalName },
      );
      window.localStorage.removeItem(`oath-prep-edits:${entry.runId ?? entry.id}`);
      setLocalEdits({});
      setReviewOpen(false);
    } catch (err) {
      toast.error("Couldn't approve batch", {
        description: err instanceof Error ? err.message : "Network error",
      });
      setSubmitting(false);
    }
  }

  async function handleDiscard(): Promise<void> {
    if (submitting) return;
    if (!window.confirm("Discard this preparation? The PDF will be deleted.")) return;
    setSubmitting(true);
    try {
      const resp = await fetch("/api/oath-signature/discard-prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentRunId: entry.runId, reason: "User clicked discard" }),
      });
      const body = (await resp.json()) as { ok: boolean; error?: string };
      if (!resp.ok || !body.ok) {
        toast.error("Couldn't discard preparation", { description: body.error ?? "Server error" });
        setSubmitting(false);
        return;
      }
      toast.success("Preparation discarded");
      window.localStorage.removeItem(`oath-prep-edits:${entry.runId ?? entry.id}`);
      setLocalEdits({});
    } catch (err) {
      toast.error("Couldn't discard preparation", {
        description: err instanceof Error ? err.message : "Network error",
      });
      setSubmitting(false);
    }
  }

  return (
    <div className="relative rounded-md border border-border bg-card mx-2 mt-2 px-3 py-2.5">
      <span aria-hidden className={cn("absolute left-0 top-0 bottom-0 w-1 rounded-l-md", accentColor)} />
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <FileText aria-hidden className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate" title={data.pdfOriginalName}>
            {data.pdfOriginalName || "(unknown PDF)"}
          </span>
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            · {records.length} row{records.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {readyForReview && !reviewOpen && (
            <button
              type="button"
              onClick={() => setReviewOpen(true)}
              disabled={submitting || isDone}
              className={cn(
                "h-7 px-2.5 inline-flex items-center gap-1.5 rounded-md text-xs font-medium",
                "bg-primary text-primary-foreground border border-primary",
                "hover:bg-primary/90 hover:border-primary/90",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
                "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
              )}
            >
              <ListChecks aria-hidden className="h-3 w-3" />
              Review &amp; approve
            </button>
          )}
          <button
            type="button"
            onClick={handleDiscard}
            disabled={submitting || isDone}
            aria-label="Discard preparation"
            title="Discard preparation"
            className={cn(
              "h-7 w-7 inline-flex items-center justify-center rounded-md",
              "text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer",
            )}
          >
            <XIcon aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* In-progress body */}
      {inProgress && (
        <div className="mt-2 space-y-1.5">
          <StageStrip data={data} entryStep={entry.step} />
          <div className="text-xs font-mono text-muted-foreground truncate">
            {currentSubstep(entry, data)}
          </div>
        </div>
      )}

      {/* Ready-for-review summary (collapsed) */}
      {readyForReview && !reviewOpen && (
        <div className="mt-1.5 space-y-0.5">
          <div className="text-sm">
            <strong className="font-semibold">{records.length}</strong>{" "}
            <span className="text-muted-foreground">rows ·</span>{" "}
            <span className="text-success">{stateCount(records, ["matched", "resolved"])} approvable</span>
            {stateCount(records, ["unresolved"]) > 0 && (
              <>
                {" "}
                <span className="text-muted-foreground">·</span>{" "}
                <span className="text-destructive">
                  {stateCount(records, ["unresolved"])} need review
                </span>
              </>
            )}
            {stateCount(records, ["extracted"]) > 0 && (
              <>
                {" "}
                <span className="text-muted-foreground">·</span>{" "}
                <span className="text-muted-foreground">
                  {stateCount(records, ["extracted"])} unsigned
                </span>
              </>
            )}
          </div>
          <div className="text-xs text-muted-foreground font-mono truncate">
            Roster: {data.rosterPath}
            {data.ocrProvider && ` · OCR: ${data.ocrProvider}`}
            {data.ocrCached ? " · cached" : ""}
          </div>
        </div>
      )}

      {/* Failure */}
      {isFailed && (
        <div className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle aria-hidden className="h-3 w-3 mt-0.5 shrink-0" />
          <span className="font-mono break-words">
            {entry.error || "Preparation failed."}
          </span>
        </div>
      )}

      {/* Expanded review */}
      {reviewOpen && readyForReview && (
        <div className="mt-2.5 border-t border-border pt-2.5">
          <div className="flex items-center justify-between gap-2 mb-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 cursor-pointer accent-primary"
                checked={selectedCount > 0 && selectedCount === approvableCount}
                ref={(el) => {
                  if (!el) return;
                  el.indeterminate = selectedCount > 0 && selectedCount < approvableCount;
                }}
                onChange={(e) => toggleSelectAllApprovable(e.target.checked)}
              />
              <span className="text-xs text-muted-foreground font-mono">
                {selectedCount} of {approvableCount} selected
              </span>
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setReviewOpen(false)}
                disabled={submitting}
                className={cn(
                  "h-7 px-2.5 text-xs font-medium rounded-md cursor-pointer",
                  "text-muted-foreground hover:bg-muted hover:text-foreground",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                )}
              >
                Cancel review
              </button>
              <button
                type="button"
                onClick={handleApprove}
                disabled={submitting || selectedCount === 0}
                className={cn(
                  "h-7 px-2.5 inline-flex items-center gap-1.5 rounded-md text-xs font-medium",
                  "bg-primary text-primary-foreground border border-primary",
                  "hover:bg-primary/90",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
                  "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
                )}
              >
                {submitting && <Loader2 aria-hidden className="h-3 w-3 animate-spin" />}
                Approve {selectedCount}
              </button>
            </div>
          </div>
          <div className="max-h-[60vh] overflow-y-auto -mx-3 divide-y divide-border">
            {records.map((r, i) => (
              <OathRecordRow
                key={`${r.sourcePage}-${r.rowIndex}-${i}`}
                record={r}
                onChange={(next) => setRecord(i, next)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function OathRecordRow({
  record,
  onChange,
}: {
  record: OathPreviewRecord;
  onChange: (next: OathPreviewRecord) => void;
}) {
  const isApprovable = record.matchState === "matched" || record.matchState === "resolved";
  const stateBadge = (() => {
    switch (record.matchState) {
      case "matched":
        return { label: "matched", color: "bg-success/15 text-success border-success/30" };
      case "resolved":
        return { label: "resolved", color: "bg-success/15 text-success border-success/30" };
      case "unresolved":
        return { label: "no EID", color: "bg-destructive/15 text-destructive border-destructive/30" };
      case "extracted":
        return { label: "unsigned", color: "bg-muted text-muted-foreground border-border" };
      default:
        return { label: record.matchState, color: "bg-muted text-muted-foreground border-border" };
    }
  })();
  return (
    <div className="px-3 py-2 flex items-start gap-3">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 cursor-pointer accent-primary disabled:opacity-50"
        checked={record.selected}
        disabled={!isApprovable}
        onChange={(e) => onChange({ ...record, selected: e.target.checked })}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium truncate">{record.printedName}</span>
          <span
            className={cn(
              "text-[10px] font-mono uppercase tracking-wider px-1.5 py-px rounded border",
              stateBadge.color,
            )}
          >
            {stateBadge.label}
          </span>
          {record.matchSource && (
            <span className="text-[10px] font-mono text-muted-foreground">
              · {record.matchSource}
            </span>
          )}
          {typeof record.matchConfidence === "number" && record.matchConfidence < 1 && (
            <span className="text-[10px] font-mono text-muted-foreground">
              · {(record.matchConfidence * 100).toFixed(0)}%
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1">
            <span className="text-muted-foreground font-mono">EID</span>
            <input
              type="text"
              value={record.employeeId}
              onChange={(e) => onChange({ ...record, employeeId: e.target.value })}
              className={cn(
                "h-6 w-24 rounded border border-border bg-background px-1.5",
                "text-xs font-mono outline-none focus:border-primary",
              )}
              placeholder="—"
            />
          </label>
          <label className="flex items-center gap-1">
            <span className="text-muted-foreground font-mono">Date</span>
            <input
              type="text"
              value={record.dateSigned ?? ""}
              onChange={(e) => onChange({ ...record, dateSigned: e.target.value || null })}
              className={cn(
                "h-6 w-28 rounded border border-border bg-background px-1.5",
                "text-xs font-mono outline-none focus:border-primary",
              )}
              placeholder="MM/DD/YYYY"
            />
          </label>
          <span className="text-[10px] text-muted-foreground font-mono">
            page {record.sourcePage}
            {record.signed ? "" : " · unsigned"}
          </span>
        </div>
        {record.warnings.length > 0 && (
          <ul className="mt-1 text-[11px] text-warning font-mono space-y-0.5">
            {record.warnings.map((w, i) => (
              <li key={i}>• {w}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function currentSubstep(entry: TrackerEntry, data: OathPrepareRowData): string {
  if (entry.status === "running" && entry.step === "loading-roster") {
    return `Loading ${data.rosterPath || "roster"}…`;
  }
  if (entry.status === "running" && entry.step === "ocr") {
    return data.ocrProvider
      ? `OCR · ${data.ocrProvider}${data.ocrAttempts ? ` · attempt ${data.ocrAttempts}` : ""}`
      : "OCR in progress…";
  }
  if (entry.status === "running" && entry.step === "matching") {
    return `Matching ${data.records.length} row${data.records.length === 1 ? "" : "s"} against the roster…`;
  }
  if (entry.status === "running" && entry.step === "eid-lookup") {
    const pending = data.records.filter(
      (r) => r.matchState === "lookup-pending" || r.matchState === "lookup-running",
    ).length;
    return pending > 0
      ? `Looking up ${pending} missing EID${pending === 1 ? "" : "s"}…`
      : "Finalizing eid-lookup results…";
  }
  if (entry.status === "pending") return "Queued — starting up…";
  return entry.lastLogMessage || entry.step || "";
}

function stateCount(records: OathPreviewRecord[], states: string[]): number {
  return records.filter((r) => states.includes(r.matchState)).length;
}

function StageStrip({ data, entryStep }: { data: OathPrepareRowData; entryStep?: string }) {
  const stageIndex = STAGE_KEYS.findIndex((k) => k === entryStep);
  return (
    <div className="flex items-center gap-1.5">
      {STAGE_KEYS.map((stage, i) => {
        const isActive = stageIndex === i;
        const isComplete = stageIndex > i;
        const isPending = !isActive && !isComplete;
        const eidNeeded = data.records.some(
          (r) => r.matchState === "lookup-pending" || r.matchState === "lookup-running",
        );
        const isReallyActive = isActive && (stage !== "eid-lookup" || eidNeeded);
        return (
          <div key={stage} className="flex items-center gap-1.5 flex-1 last:flex-none">
            <div
              title={STAGE_LABELS[stage]}
              aria-label={`${STAGE_LABELS[stage]} — ${isComplete ? "done" : isReallyActive ? "in progress" : "pending"}`}
              className={cn(
                "h-2 w-2 rounded-full shrink-0 transition-colors",
                isComplete && "bg-success",
                isReallyActive && "bg-primary ring-2 ring-primary/30 motion-safe:animate-pulse",
                isPending && "bg-muted border border-border",
                isActive && !isReallyActive && "bg-success",
              )}
            />
            {i < STAGE_KEYS.length - 1 && (
              <div
                aria-hidden
                className={cn("flex-1 h-px", isComplete ? "bg-success" : "bg-border")}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// Suppress unused-import warning — CheckCircle2 is exported for future use.
void CheckCircle2;
