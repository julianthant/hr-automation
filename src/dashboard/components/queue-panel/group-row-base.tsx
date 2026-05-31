import { Loader2, Clock, CheckCircle2, AlertTriangle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "@/components/shared/types";
import { useElapsed, formatDuration } from "@/components/hooks/useElapsed";
import { formatEntryTime, getRunNumber } from "@/components/shared/entry-display";
import {
  aggregateBatchCounts,
  pickPreviewChildren,
  computeBatchElapsed,
  resolveBatchAccent,
  type BatchAccent,
} from "@/components/ocr/delegation-row-helpers";

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

export type GroupRowVariant = "preview" | "batch";

export interface GroupRowBaseProps {
  /** Exposed as data-queue-group-kind for visual/debug inspection. */
  variant: GroupRowVariant;
  title: string;
  parentRunId: string;
  members: TrackerEntry[];
  countTone: "warning" | "neutral";
  footerRunOrdinal?: number;
  footerSecondaryId?: string;
  firstTimestamp?: string;
  /** Rows used for footer elapsed time; defaults to {@link members}. */
  elapsedEntries?: TrackerEntry[];
  isFocused: boolean;
  drillInEnabled?: boolean;
  onEnter: (parentRunId: string) => void;
  footerActions?: ReactNode;
}

export function GroupRowBase({
  variant,
  title,
  parentRunId,
  members,
  countTone,
  footerRunOrdinal,
  footerSecondaryId,
  firstTimestamp,
  elapsedEntries,
  isFocused,
  drillInEnabled = true,
  onEnter,
  footerActions,
}: GroupRowBaseProps) {
  const counts = aggregateBatchCounts(members);
  const accent = resolveBatchAccent(counts);
  const previewKids = pickPreviewChildren(members, PREVIEW_KIDS);
  const elapsed = computeBatchElapsed(elapsedEntries ?? members);

  const elapsedLabel = useBatchElapsedLabel(elapsed);

  const rowTime = firstTimestamp ? formatEntryTime(firstTimestamp) : "";
  const runNumber = footerRunOrdinal && footerRunOrdinal > 0
    ? footerRunOrdinal
    : getRunNumber(members[0] ?? ({ id: parentRunId, workflow: "", timestamp: "", status: "pending" } as TrackerEntry));
  const segs = computeProgressSegments(counts);
  const interactive = drillInEnabled;
  const drillInProps = interactive
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-pressed": isFocused,
        "aria-label": `${title} - ${counts.done} of ${counts.total} done`,
        onClick: () => onEnter(parentRunId),
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onEnter(parentRunId);
          }
        },
      }
    : {};

  return (
    <div className="px-3 pt-2 first:pt-3">
      <div
        data-queue-group-kind={variant}
        className={cn(
          "group bg-card border border-border border-l-[3px] rounded-lg outline-none overflow-hidden",
          "transition-all duration-200",
          interactive &&
            "hover:border-primary/40 hover:shadow-lg hover:shadow-black/20",
          !interactive && "cursor-default",
          ACCENT_BORDER[accent],
          isFocused && "ring-2 ring-primary",
        )}
      >
        <div
          {...drillInProps}
          className={cn(
            "outline-none",
            interactive &&
              "cursor-pointer focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
          )}
        >
          <div className="px-3.5 py-2.5 flex items-center justify-between gap-2 min-w-0">
            <span className="font-semibold text-[14px] text-foreground truncate min-w-0 flex-1">
              {title}
            </span>
            <span
              className={cn(
                "text-[10px] font-medium px-2 py-0.5 rounded-md font-sans tracking-wide flex-shrink-0",
                countTone === "warning"
                  ? "bg-warning/12 text-warning border border-warning/40"
                  : "bg-secondary/80 text-secondary-foreground border border-border",
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
                {previewKids.map((kid) => {
                  const cfg = STATUS_ICON[kid.status] ?? STATUS_ICON.pending;
                  const Icon = cfg.Icon;
                  return (
                    <div key={kid.id} className="flex items-center gap-2 min-w-0">
                      <Icon
                        className={cn(
                          "w-3 h-3 flex-shrink-0",
                          cfg.color,
                          cfg.spin && "animate-spin motion-reduce:animate-none",
                        )}
                        aria-hidden
                      />
                      <span className="text-foreground/90 truncate flex-1 min-w-0">
                        {kid.name}
                      </span>
                      {kid.emplId && (
                        <span className="text-muted-foreground text-[9.5px] flex-shrink-0 tabular-nums">
                          {kid.emplId}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="border-t border-border/60" />
            </>
          )}
        </div>

        <div className="px-3.5 py-1.5 bg-secondary/20 flex items-center gap-2 text-[11px] font-mono text-muted-foreground min-w-0">
          <div
            {...drillInProps}
            className={cn(
              "flex items-center gap-2 min-w-0 flex-1 outline-none",
              interactive &&
                "cursor-pointer focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset rounded-sm",
            )}
          >
            <span className="tabular-nums flex-shrink-0">{rowTime}</span>
            <span className="bg-secondary/80 px-1.5 py-px rounded font-medium flex-shrink-0 tabular-nums">
              #{runNumber}
            </span>
            {footerSecondaryId && (
              <span
                className="truncate text-foreground/80 flex-shrink min-w-0 tabular-nums"
                title={footerSecondaryId}
              >
                {footerSecondaryId}
              </span>
            )}
            <span className="flex-1" />
            {elapsedLabel && (
              <span
                className={cn(
                  "tabular-nums flex-shrink-0",
                  elapsed?.frozen ? "" : "text-primary",
                )}
              >
                {elapsedLabel}
              </span>
            )}
          </div>
          {footerActions ? (
            <div className="flex items-center gap-1 flex-shrink-0">{footerActions}</div>
          ) : null}
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

function useBatchElapsedLabel(elapsed: ReturnType<typeof computeBatchElapsed>): string {
  const liveTick = useElapsed(
    elapsed && !elapsed.frozen ? new Date(elapsed.startMs).toISOString() : null,
  );
  if (!elapsed) return "";
  if (elapsed.frozen) {
    return formatDuration(
      new Date(elapsed.startMs).toISOString(),
      new Date(elapsed.endMs).toISOString(),
    );
  }
  return liveTick;
}
