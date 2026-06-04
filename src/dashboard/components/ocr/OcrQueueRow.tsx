import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  UploadCloud,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "@/components/shared/types";
import { resolveOcrConfigForEntry } from "@/lib/ocr-downstream-registry";

/**
 * Unified bento prep row for the QueuePanel. Replaces the separate
 * `PreviewRow` (EC) + `OathPreviewRow` (oath) shapes — same visual
 * language, just different data parsers + endpoint URLs.
 *
 * Click anywhere on the card body → opens the right-pane PrepReviewPane
 * (handled by `onOpenReview`). Foot action buttons stop propagation
 * so they don't fire the body click.
 *
 * Visual: matches EntryItem's bento shape with a 3-px left accent bar
 * keyed to state (preparing/ready/reviewing/failed).
 */
export interface OcrQueueRowProps {
  entry: TrackerEntry;
  isReviewing: boolean;
  onOpenReview: (runId: string) => void;
  /** Called when operator clicks Reupload — opens RunModal in reupload mode. */
  onReupload?: (reuploadFor: { sessionId: string; previousRunId: string }) => void;
}

const STAGES = [
  { key: "loading-roster", label: "Roster" },
  { key: "ocr", label: "OCR" },
  { key: "matching", label: "Match" },
  { key: "person-lookup", label: "Person lookup" },
  { key: "verify", label: "Verify" },
] as const;

interface DerivedState {
  stateKey: "preparing" | "ready" | "reviewing" | "failed";
  Icon: LucideIcon;
  iconClass: string;
  iconColor: string;
  badge: string;
  badgeText: string;
  accent: string;
}

export function OcrQueueRow({ entry, isReviewing, onOpenReview, onReupload }: OcrQueueRowProps) {
  const cfg = resolveOcrConfigForEntry(entry);
  const data = cfg?.parseRow(entry.data) ?? null;

  if (!cfg || !data) return null;
  const runId = entry.runId ?? entry.id;

  const state = deriveState(entry, isReviewing);

  const recordCount = data.records.length;
  const toRemoveCount = data.records.filter((r) => r.documentType === "unknown").length;

  const subline = renderSubline(state.stateKey, entry, data, {
    toRemoveCount,
    recordCount,
  });

  const clickable = state.stateKey === "ready" || state.stateKey === "reviewing";

  return (
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : -1}
      aria-pressed={isReviewing}
      onClick={() => clickable && onOpenReview(runId)}
      onKeyDown={(e) => {
        if (!clickable) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenReview(runId);
        }
      }}
      className={cn(
        "group relative flex flex-col rounded-md border border-border bg-card transition-shadow",
        clickable && "cursor-pointer hover:shadow-md hover:border-primary/40",
        isReviewing && "ring-2 ring-primary",
      )}
    >
      {/* 3-px accent bar */}
      <div
        className={cn(
          "absolute left-0 top-0 h-full w-[3px] rounded-l-md",
          state.accent,
        )}
        aria-hidden
      />

      {/* Head zone */}
      <div className="flex items-center justify-between gap-2 px-3 pl-4 pt-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <state.Icon
            className={cn("h-3.5 w-3.5 shrink-0", state.iconClass, state.iconColor)}
            aria-hidden
          />
          <span className="truncate text-sm font-medium">
            {data.pdfOriginalName || "Prep upload"}
          </span>
        </div>
        <span
          className={cn(
            "rounded-md border px-1.5 py-px font-mono text-[10px] uppercase",
            state.badge,
          )}
        >
          {state.badgeText}
        </span>
      </div>

      {subline && (
        <div className="px-4 pb-1 pt-0.5 text-xs text-muted-foreground">{subline}</div>
      )}

      {/* Foot zone */}
      <div className="mt-1 flex items-center justify-between gap-2 border-t border-border px-3 pb-2 pl-4 pt-1.5">
        <span className="font-mono text-[10px] text-muted-foreground">
          {formatTime(entry.timestamp)} · prep#{shortRun(runId)}
        </span>
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-secondary px-1.5 py-px font-mono text-[10px] text-muted-foreground">
            {recordCount} rec
          </span>
          {onReupload && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onReupload({ sessionId: entry.id, previousRunId: entry.runId ?? entry.id });
              }}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-md border border-border px-1.5 text-[11px] text-muted-foreground hover:bg-muted",
              )}
              title="Re-upload corrected PDF — carries forward resolved EIDs from this run"
            >
              <UploadCloud className="h-3 w-3" /> Reupload
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function deriveState(entry: TrackerEntry, isReviewing: boolean): DerivedState {
  const failed = entry.status === "failed";
  const done = entry.status === "done";
  if (failed) {
    return {
      stateKey: "failed",
      Icon: AlertTriangle,
      iconClass: "",
      iconColor: "text-destructive",
      badge: "bg-destructive/10 text-destructive border-destructive/40",
      badgeText: "Failed",
      accent: "bg-destructive",
    };
  }
  if (isReviewing) {
    return {
      stateKey: "reviewing",
      Icon: CheckCircle2,
      iconClass: "",
      iconColor: "text-primary",
      badge: "bg-primary/10 text-primary border-primary/30",
      badgeText: "Reviewing",
      accent: "bg-primary",
    };
  }
  if (done) {
    return {
      stateKey: "ready",
      Icon: Clock,
      iconClass: "",
      iconColor: "text-warning",
      badge: "bg-warning/10 text-warning border-warning/40",
      badgeText: "Ready",
      accent: "bg-warning",
    };
  }
  return {
    stateKey: "preparing",
    Icon: Loader2,
    iconClass: "animate-spin motion-reduce:animate-none",
    iconColor: "text-primary",
    badge: "bg-primary/10 text-primary border-primary/30",
    badgeText: stageBadge(entry.step),
    accent: "bg-primary",
  };
}

function stageBadge(step: string | undefined): string {
  if (!step) return "Preparing…";
  const stage = STAGES.find((s) => s.key === step);
  return stage ? `${stage.label} · running` : step;
}

function renderSubline(
  stateKey: DerivedState["stateKey"],
  entry: TrackerEntry,
  _data: { records: unknown[] },
  counts: {
    toRemoveCount: number;
    recordCount: number;
  },
): ReactNode {
  if (stateKey === "failed") {
    return (
      <span className="text-destructive">
        {entry.error ?? "Prep failed — see logs"}
      </span>
    );
  }
  if (stateKey === "preparing") {
    const currentIdx = STAGES.findIndex((s) => s.key === entry.step);
    return (
      <div className="flex items-center gap-1.5 font-mono text-[10px]">
        {STAGES.map((s, i) => (
          <span
            key={s.key}
            className={cn(
              "rounded px-1.5 py-px",
              currentIdx === i
                ? "bg-primary/15 text-primary"
                : i < currentIdx
                  ? "text-success"
                  : "text-muted-foreground",
            )}
          >
            {s.label}
          </span>
        ))}
      </div>
    );
  }
  const parts: string[] = [`${counts.recordCount} records`];
  if (counts.toRemoveCount > 0) parts.push(`${counts.toRemoveCount} to remove`);
  return <span>{parts.join(" · ")}</span>;
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return ts.slice(11, 16);
  }
}

function shortRun(runId: string): string {
  // Use last 4 chars; runIds are typically UUIDs or `<id>#N`
  return runId.slice(-4);
}
