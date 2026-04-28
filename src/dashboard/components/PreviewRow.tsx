import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  FileText,
  ListChecks,
  Loader2,
  X as XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "./types";
import {
  parsePrepareRowData,
  type PreviewRecord,
  type PrepareRowData,
} from "./preview-types";
import { PreviewRecordRow } from "./PreviewRecordRow";

/**
 * The "preview" parent row for an emergency-contact prep batch. Lives at the
 * top of the QueuePanel above the regular list. Two states:
 *
 *  1. In progress (entry.status pending/running): shows a stage progress
 *     strip (loading-roster → ocr → matching → eid-lookup) and a Discard
 *     button. No records list.
 *
 *  2. Ready for review (entry.status running step!=eid-lookup with all
 *     records terminal, OR done before approve): shows a records summary
 *     line + Review & approve button. Clicking Review expands an inline
 *     records list with per-row checkboxes + edit forms; the user clicks
 *     Approve to fan out to daemon kernel items.
 *
 * Persistence: per-record edits are mirrored to localStorage keyed by
 * `ec-prep-edits:<runId>` so a reload restores in-progress edits.
 */
export interface PreviewRowProps {
  entry: TrackerEntry;
}

const STAGE_KEYS = ["loading-roster", "ocr", "matching", "eid-lookup"] as const;
const STAGE_LABELS: Record<(typeof STAGE_KEYS)[number], string> = {
  "loading-roster": "Loading roster",
  ocr: "OCR",
  matching: "Matching",
  "eid-lookup": "EID lookup",
};

export function PreviewRow({ entry }: PreviewRowProps) {
  const data = useMemo(() => parsePrepareRowData(entry.data), [entry.data]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Load any locally-saved edits and merge over server records.
  const [localEdits, setLocalEdits] = useState<Record<number, PreviewRecord>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(`ec-prep-edits:${entry.runId ?? entry.id}`);
      return raw ? (JSON.parse(raw) as Record<number, PreviewRecord>) : {};
    } catch {
      return {};
    }
  });

  // Merge incoming server data with local edits, treating local edits as
  // overrides per-record by index.
  const records = useMemo<PreviewRecord[]>(() => {
    if (!data) return [];
    return data.records.map((r, i) => localEdits[i] ?? r);
  }, [data, localEdits]);

  // Persist edits whenever they change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = `ec-prep-edits:${entry.runId ?? entry.id}`;
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
      r.matchState === "unresolved",
  );
  const readyForReview = !isFailed && allTerminal && records.length > 0;
  const inProgress = !isFailed && !readyForReview;

  const accentColor = isFailed ? "bg-destructive" : readyForReview ? "bg-warning" : "bg-primary";

  // Selected count among approvable records.
  const selectedCount = records.filter(
    (r) =>
      r.selected && (r.matchState === "matched" || r.matchState === "resolved"),
  ).length;

  function setRecord(i: number, next: PreviewRecord): void {
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
    const pdfName = data.pdfOriginalName;
    try {
      const resp = await fetch("/api/emergency-contact/approve-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentRunId: entry.runId,
          records,
        }),
      });
      const body = (await resp.json()) as { ok: boolean; enqueued?: number; error?: string };
      if (!resp.ok || !body.ok) {
        toast.error("Approve failed", { description: body.error ?? "Server error" });
        setSubmitting(false);
        return;
      }
      toast.success(
        `Queued ${body.enqueued ?? selectedCount} record${(body.enqueued ?? selectedCount) === 1 ? "" : "s"}`,
        { description: pdfName },
      );
      // Clear local edits — backend now owns the records on the prep row.
      window.localStorage.removeItem(`ec-prep-edits:${entry.runId ?? entry.id}`);
      setLocalEdits({});
      setReviewOpen(false);
    } catch (err) {
      toast.error("Approve failed", {
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
      const resp = await fetch("/api/emergency-contact/discard-prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentRunId: entry.runId,
          reason: "User clicked discard",
        }),
      });
      const body = (await resp.json()) as { ok: boolean; error?: string };
      if (!resp.ok || !body.ok) {
        toast.error("Discard failed", { description: body.error ?? "Server error" });
        setSubmitting(false);
        return;
      }
      toast.success("Preparation discarded");
      window.localStorage.removeItem(`ec-prep-edits:${entry.runId ?? entry.id}`);
      setLocalEdits({});
    } catch (err) {
      toast.error("Discard failed", {
        description: err instanceof Error ? err.message : "Network error",
      });
      setSubmitting(false);
    }
  }

  return (
    <div
      className={cn(
        "relative rounded-md border border-border bg-card mx-2 mt-2 px-3 py-2.5",
        "before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:rounded-l-md",
        accentColor && `before:${accentColor}`,
      )}
      style={{
        // Tailwind dynamic class doesn't work for `before:bg-*` pseudo-class
        // backgrounds; wire via CSS custom property + inline style instead.
        ["--accent" as never]: undefined,
      }}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-0 bottom-0 w-1 rounded-l-md",
          accentColor,
        )}
      />
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <FileText aria-hidden className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate" title={data.pdfOriginalName}>
            {data.pdfOriginalName || "(unknown PDF)"}
          </span>
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            · {records.length} record{records.length === 1 ? "" : "s"}
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

      {/* Body */}
      {inProgress && (
        <div className="mt-2 space-y-1.5">
          <StageStrip data={data} entryStep={entry.step} />
          <div className="text-xs font-mono text-muted-foreground truncate">
            {currentSubstep(entry, data)}
          </div>
        </div>
      )}

      {readyForReview && !reviewOpen && (
        <div className="mt-1.5 space-y-0.5">
          <div className="text-sm">
            <strong className="font-semibold">{records.length}</strong>{" "}
            <span className="text-muted-foreground">records ·</span>{" "}
            <span className="text-success">{stateCount(records, ["matched", "resolved"])} matched</span>
            {stateCount(records, ["unresolved"]) > 0 && (
              <>
                {" "}
                <span className="text-muted-foreground">·</span>{" "}
                <span className="text-destructive">
                  {stateCount(records, ["unresolved"])} need review
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
                checked={
                  selectedCount > 0 &&
                  selectedCount ===
                    records.filter(
                      (r) =>
                        r.matchState === "matched" || r.matchState === "resolved",
                    ).length
                }
                ref={(el) => {
                  if (!el) return;
                  const approvable = records.filter(
                    (r) =>
                      r.matchState === "matched" || r.matchState === "resolved",
                  ).length;
                  el.indeterminate =
                    selectedCount > 0 && selectedCount < approvable;
                }}
                onChange={(e) => toggleSelectAllApprovable(e.target.checked)}
              />
              <span className="text-xs text-muted-foreground font-mono">
                {selectedCount} of{" "}
                {records.filter(
                  (r) => r.matchState === "matched" || r.matchState === "resolved",
                ).length}{" "}
                selected
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
                {submitting && (
                  <Loader2
                    aria-hidden
                    className="h-3 w-3 animate-spin motion-reduce:animate-none"
                  />
                )}
                Approve {selectedCount}
              </button>
            </div>
          </div>
          <div className="max-h-[60vh] overflow-y-auto -mx-3 divide-y divide-border">
            {records.map((r, i) => (
              <PreviewRecordRow
                key={`${r.sourcePage}-${r.employee.name}-${i}`}
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

function currentSubstep(entry: TrackerEntry, data: PrepareRowData): string {
  if (entry.status === "running" && entry.step === "loading-roster") {
    return `Loading ${data.rosterPath || "roster"}…`;
  }
  if (entry.status === "running" && entry.step === "ocr") {
    return data.ocrProvider
      ? `OCR · ${data.ocrProvider}${data.ocrAttempts ? ` · attempt ${data.ocrAttempts}` : ""}`
      : "OCR in progress…";
  }
  if (entry.status === "running" && entry.step === "matching") {
    return `Matching ${data.records.length} record${data.records.length === 1 ? "" : "s"} against the roster…`;
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

function stateCount(records: PreviewRecord[], states: string[]): number {
  return records.filter((r) => states.includes(r.matchState)).length;
}

function StageStrip({
  data,
  entryStep,
}: {
  data: PrepareRowData;
  entryStep?: string;
}) {
  // Determine which stage is active / completed.
  const stageIndex = STAGE_KEYS.findIndex((k) => k === entryStep);
  return (
    <div className="flex items-center gap-1.5">
      {STAGE_KEYS.map((stage, i) => {
        const isActive = stageIndex === i;
        const isComplete = stageIndex > i;
        const isPending = !isActive && !isComplete;
        // Special case: if we're in eid-lookup but no records actually need
        // it, treat the eid-lookup dot as "complete" not "active" so the
        // visual matches reality.
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
                className={cn(
                  "flex-1 h-px",
                  isComplete ? "bg-success" : "bg-border",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
