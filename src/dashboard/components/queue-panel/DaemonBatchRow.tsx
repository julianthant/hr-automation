import { cn } from "@/lib/utils";
import { useState, type MouseEvent } from "react";
import { toast } from "sonner";
import type { TrackerEntry } from "@/components/shared/types";
import { useElapsed, formatDuration } from "@/components/hooks/useElapsed";
import {
  aggregateBatchCounts,
  pickPreviewChildren,
  computeBatchElapsed,
  resolveBatchAccent,
  type BatchAccent,
} from "@/components/ocr/delegation-row-helpers";
import { resolveDaemonBatchQueueTitle } from "./batch-queue-view";
import { Loader2, Clock, CheckCircle2, AlertTriangle, Trash2, RotateCcw } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const PREVIEW_KIDS = 3;

const ACCENT_BORDER: Record<BatchAccent, string> = {
  warning: "border-l-warning",
  success: "border-l-success",
  destructive: "border-l-destructive",
};

const STATUS_ICON: Record<string, { Icon: LucideIcon; color: string; spin: boolean }> = {
  running: { Icon: Loader2, color: "text-primary", spin: true },
  pending: { Icon: Clock, color: "text-warning", spin: false },
  done: { Icon: CheckCircle2, color: "text-success", spin: false },
  skipped: { Icon: CheckCircle2, color: "text-success", spin: false },
  failed: { Icon: AlertTriangle, color: "text-destructive", spin: false },
};

export interface DaemonBatchRowProps {
  workflow: string;
  /** Tracker date — required for bulk delete API. */
  date?: string;
  /** Shared `parentRunId` / dashboard batch id for all members. */
  batchParentRunId: string;
  /** Workflow label for display (kernel registry). */
  workflowLabel: string;
  memberEntries: TrackerEntry[];
  isBatchQueueFocused: boolean;
  onEnterBatchQueue: (batchParentRunId: string) => void;
  /**
   * When false, the row is display-only (no drill-in). Use inside surfaces
   * where nested batch navigation is forbidden.
   */
  batchDrillInEnabled?: boolean;
  /** Called after bulk-delete removes rows so the parent can clear selection. */
  onDeletedIds?: (ids: string[]) => void;
}

/**
 * Summary card for a **daemon / dashboard batch**: multiple queue items that
 * share the same `parentRunId` from one multi-enqueue or batch-context run.
 */
export function DaemonBatchRow({
  workflow,
  date,
  batchParentRunId,
  workflowLabel,
  memberEntries,
  isBatchQueueFocused,
  onEnterBatchQueue,
  batchDrillInEnabled = true,
  onDeletedIds,
}: DaemonBatchRowProps) {
  const counts = aggregateBatchCounts(memberEntries);
  const accent = resolveBatchAccent(counts);
  const previewKids = pickPreviewChildren(memberEntries, PREVIEW_KIDS);
  const elapsed = computeBatchElapsed(memberEntries);

  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const memberDeleteItems = memberEntries.map((e) => ({
    id: e.id,
    ...(e.runId ? { runId: e.runId } : {}),
  }));
  const memberIds = memberDeleteItems.map((e) => e.id);

  const liveTick = useElapsed(
    elapsed && !elapsed.frozen ? new Date(elapsed.startMs).toISOString() : null,
  );
  const elapsedLabel = elapsed
    ? elapsed.frozen
      ? formatDuration(
          new Date(elapsed.startMs).toISOString(),
          new Date(elapsed.endMs).toISOString(),
        )
      : liveTick
    : "";

  const firstTs = [...memberEntries].sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0]
    ?.timestamp;
  const batchTime = firstTs ? formatTime(firstTs) : "";

  const segs = computeProgressSegments(counts);
  const title = resolveDaemonBatchQueueTitle(workflowLabel, memberEntries, batchParentRunId);

  async function deleteEntireBatch(e: MouseEvent) {
    e.stopPropagation();
    if (deleting || memberIds.length === 0 || !date) return;
    const n = memberIds.length;
    if (
      !window.confirm(
        `Permanently delete all ${n} entr${n === 1 ? "y" : "ies"} in this batch? This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    const t = toast.loading(`Deleting ${n} ${n === 1 ? "entry" : "entries"}…`);
    try {
      const res = await fetch("/api/delete-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, date, items: memberDeleteItems }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        count?: number;
        errors?: Array<{ id: string; error: string }>;
        error?: string;
      };
      const errors = body.errors ?? [];
      if (!res.ok) {
        toast.error(res.status === 422 ? "Couldn't delete any entries" : "Couldn't delete entries", {
          id: t,
          description:
            errors.length > 0
              ? `${errors[0]!.error}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`
              : body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      if (errors.length === 0) {
        toast.success(`Deleted ${body.count} ${body.count === 1 ? "entry" : "entries"}`, { id: t });
        onDeletedIds?.(memberIds);
      } else {
        toast.warning(`Some deletes failed`, {
          id: t,
          description: `${body.count} removed · ${errors.length} failed (${errors[0]!.error})`,
        });
        const failed = new Set(errors.map((x) => x.id));
        onDeletedIds?.(memberIds.filter((id) => !failed.has(id)));
      }
    } catch (err) {
      toast.error(`Couldn't delete batch`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeleting(false);
    }
  }

  async function retryAllInBatch(ev: MouseEvent) {
    ev.stopPropagation();
    if (retrying || memberIds.length === 0) return;
    setRetrying(true);
    const t = toast.loading(`Retrying ${memberIds.length} items…`);
    try {
      const res = await fetch("/api/retry-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          ids: memberIds,
          parentRunId: batchParentRunId,
        }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        count: number;
        errors: Array<{ id: string; error: string }>;
      };
      if (body.errors.length === 0) {
        toast.success(`Retry scheduled`, {
          id: t,
          description: `${body.count} of ${memberIds.length} items re-added to queue`,
        });
      } else {
        toast.warning(`Some retries failed`, {
          id: t,
          description: `${body.count} succeeded · ${body.errors.length} failed (${body.errors[0]?.error})`,
        });
      }
    } catch (err) {
      toast.error(`Couldn't retry`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRetrying(false);
    }
  }

  const interactive = batchDrillInEnabled;

  return (
    <div className="px-3 pt-2 first:pt-3">
      <div
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-pressed={interactive ? isBatchQueueFocused : undefined}
        aria-label={`${title} — ${counts.done} of ${counts.total} done`}
        onClick={interactive ? () => onEnterBatchQueue(batchParentRunId) : undefined}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onEnterBatchQueue(batchParentRunId);
                }
              }
            : undefined
        }
        className={cn(
          "group bg-card border border-border border-l-[3px] rounded-lg outline-none overflow-hidden",
          "transition-all duration-200",
          interactive &&
            "cursor-pointer hover:border-primary/40 hover:shadow-lg hover:shadow-black/20 focus-visible:ring-2 focus-visible:ring-primary",
          !interactive && "cursor-default",
          ACCENT_BORDER[accent],
          isBatchQueueFocused && "ring-2 ring-primary",
        )}
      >
        <div className="px-3.5 py-2.5 flex items-center justify-between gap-2 min-w-0">
          <span className="font-semibold text-[14px] text-foreground truncate min-w-0 flex-1">
            {title}
          </span>
          <span
            className={cn(
              "text-[10px] font-medium px-2 py-0.5 rounded-md font-sans tracking-wide flex-shrink-0",
              "bg-secondary/80 text-secondary-foreground border border-border",
            )}
          >
            {counts.done} / {counts.total}
          </span>
        </div>

        <div className="border-t border-border/60" />

        <div className="px-3.5 pt-2 pb-2.5 bg-secondary/20">
          <div className="flex items-center gap-3 font-mono text-[10.5px] mb-1.5">
            <span className="text-success">● {counts.done} done</span>
            <span className="text-primary">● {counts.running} running</span>
            <span className="text-warning">● {counts.queued} queued</span>
            {counts.failed > 0 && (
              <span className="text-destructive">● {counts.failed} failed</span>
            )}
          </div>
          <div className="flex gap-[2px]">
            {segs.map((s, i) => (
              <div
                key={i}
                className={cn("h-[5px] rounded-[2px]", s.cls)}
                style={{ flex: s.flex }}
              />
            ))}
          </div>
        </div>

        <div className="border-t border-border/60" />

        {previewKids.length > 0 && (
          <>
            <div className="px-3.5 py-2 bg-card flex flex-col gap-1.5 font-mono text-[10.5px]">
              {previewKids.map((k) => {
                const cfg = STATUS_ICON[k.status] ?? STATUS_ICON.pending;
                const Icon = cfg.Icon;
                return (
                  <div key={k.id} className="flex items-center gap-2 min-w-0">
                    <Icon
                      className={cn(
                        "w-3 h-3 flex-shrink-0",
                        cfg.color,
                        cfg.spin && "animate-spin motion-reduce:animate-none",
                      )}
                      aria-hidden
                    />
                    <span className="text-foreground/90 truncate flex-1 min-w-0">{k.name}</span>
                    {k.emplId && (
                      <span className="text-muted-foreground text-[9.5px] flex-shrink-0 tabular-nums">
                        {k.emplId}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="border-t border-border/60" />
          </>
        )}

        <div className="px-3.5 py-1.5 bg-secondary/20 flex items-center gap-2 text-[11px] font-mono text-muted-foreground min-w-0">
          <span className="tabular-nums flex-shrink-0">{batchTime}</span>
          <span className="bg-secondary/80 px-1.5 py-px rounded font-medium flex-shrink-0">
            batch#{batchParentRunId.slice(-4)}
          </span>
          <span className="flex-1" />
          {elapsedLabel && (
            <span
              className={cn(
                "tabular-nums flex-shrink-0",
                elapsed.frozen ? "" : "text-primary",
              )}
            >
              {elapsedLabel}
            </span>
          )}
          <div
            className="flex items-center gap-1 flex-shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            {memberIds.length > 0 && (
              <button
                type="button"
                aria-label={`Retry all ${memberIds.length} ${memberIds.length === 1 ? "item" : "items"} in this batch`}
                title="Re-queue every row in this batch (any status)"
                disabled={retrying}
                onClick={retryAllInBatch}
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors outline-none",
                  "text-muted-foreground bg-transparent",
                  "hover:text-foreground hover:bg-muted",
                  "focus-visible:ring-2 focus-visible:ring-primary/40",
                  "disabled:opacity-60 disabled:cursor-wait",
                )}
              >
                {retrying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                )}
              </button>
            )}
            {memberIds.length > 0 && date ? (
              <button
                type="button"
                aria-label="Delete all entries in this batch"
                title="Delete entire batch"
                disabled={deleting}
                onClick={deleteEntireBatch}
                className={cn(
                  "inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors outline-none",
                  "text-muted-foreground bg-transparent",
                  "hover:text-destructive hover:bg-destructive/10",
                  "focus-visible:ring-2 focus-visible:ring-destructive/40",
                  "disabled:opacity-60 disabled:cursor-wait",
                )}
              >
                {deleting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                )}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function computeProgressSegments(counts: ReturnType<typeof aggregateBatchCounts>) {
  const segs: { cls: string; flex: number }[] = [];
  if (counts.done > 0) segs.push({ cls: "bg-success", flex: counts.done });
  if (counts.running > 0) segs.push({ cls: "bg-primary", flex: counts.running });
  if (counts.queued > 0) segs.push({ cls: "bg-warning", flex: counts.queued });
  if (counts.failed > 0) segs.push({ cls: "bg-destructive", flex: counts.failed });
  if (segs.length === 0) segs.push({ cls: "bg-secondary", flex: 1 });
  return segs;
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return ts.slice(11, 16);
  }
}
