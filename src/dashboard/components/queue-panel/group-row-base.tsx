import { Loader2, Clock, CheckCircle2, AlertTriangle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "@/components/shared/types";
import { formatEntryTime, getRunNumber } from "@/components/shared/entry-display";
import { QueueRowCard } from "./QueueRowCard";
import { StatusCounts } from "./StatusCounts";
import {
  aggregateBatchCounts,
  pickPreviewChildren,
  computeBatchElapsed,
  resolveBatchAccent,
  useBatchElapsedLabel,
} from "@/components/ocr/delegation-row-helpers";

const PREVIEW_KIDS = 3;

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
  // A person batch anchor carries no title — drop the empty header row and
  // move the count badge onto the status-counts line (right side, above the
  // bar). Titled cards (file batches, prep previews) keep the header row.
  const hasTitle = title.trim().length > 0;
  const countBadgeClass = cn(
    "text-[10px] font-medium px-2 py-0.5 rounded-md font-sans tracking-wide shrink-0",
    countTone === "warning"
      ? "bg-warning/12 text-warning border border-warning/40"
      : "bg-secondary/80 text-secondary-foreground border border-border",
  );
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
    <QueueRowCard
      accent={accent}
      selected={isFocused}
      interactive={interactive}
      rootProps={{ "data-queue-group-kind": variant }}
      footer={{
        time: rowTime,
        runNumber,
        secondaryId: footerSecondaryId,
        elapsed: elapsedLabel && !elapsed?.frozen ? elapsedLabel : null,
        duration: elapsedLabel && elapsed?.frozen ? elapsedLabel : null,
        metaProps: interactive
          ? {
              ...drillInProps,
              className:
                "cursor-pointer focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset rounded-sm",
            }
          : drillInProps,
        actions: footerActions,
      }}
    >
      {/* Body — header + status + member preview. Dividers lead each zone;
          the divider before the footer is owned by RowFooter. */}
      <div
        {...drillInProps}
        className={cn(
          "outline-none",
          interactive &&
            "cursor-pointer focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
        )}
      >
        {hasTitle && (
          <div className="px-3.5 py-2.5 flex items-center justify-between gap-2 min-w-0">
            <span className="font-semibold text-[14px] text-foreground truncate min-w-0 flex-1">
              {title}
            </span>
            <span className={countBadgeClass}>
              {counts.done} / {counts.total}
            </span>
          </div>
        )}

        {hasTitle && <div className="border-t border-border/60" />}

        <div className={cn("px-3.5 pb-2.5 bg-secondary/20", hasTitle ? "pt-2" : "pt-3")}>
          {/* Status counts stay on one line. When the count badge shares this
              row (no-title anchor), spans are nowrap + shrink-0 and the gap is
              tightened so 4 counts + badge don't wrap. */}
          <div className="flex flex-nowrap items-center gap-x-2.5 font-mono text-[10.5px] mb-1.5">
            <StatusCounts counts={counts} />
            {!hasTitle && (
              <span className={cn(countBadgeClass, "ml-auto")}>
                {counts.done} / {counts.total}
              </span>
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

        {previewKids.length > 0 && <div className="border-t border-border/60" />}

        {previewKids.length > 0 && (
          <div className="px-3.5 py-2 bg-card flex flex-col gap-1.5 font-mono text-[10.5px]">
            {previewKids.map((kid) => {
              const cfg = STATUS_ICON[kid.status] ?? STATUS_ICON.pending;
              const Icon = cfg.Icon;
              return (
                <div key={kid.id} className="flex items-center gap-2 min-w-0">
                  <Icon
                    className={cn(
                      "w-3 h-3 shrink-0",
                      cfg.color,
                      cfg.spin && "animate-spin motion-reduce:animate-none",
                    )}
                    aria-hidden
                  />
                  <span className="text-foreground/90 truncate flex-1 min-w-0">
                    {kid.name}
                  </span>
                  {kid.emplId && (
                    <span className="text-muted-foreground text-[9.5px] shrink-0 tabular-nums">
                      {kid.emplId}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </QueueRowCard>
  );
}

function computeProgressSegments(counts: ReturnType<typeof aggregateBatchCounts>) {
  const segs: { cls: string; flex: number }[] = [];
  if (counts.done > 0) segs.push({ cls: "bg-success", flex: counts.done });
  if (counts.running > 0) segs.push({ cls: "bg-primary", flex: counts.running });
  if (counts.queued > 0) segs.push({ cls: "bg-warning", flex: counts.queued });
  if (counts.failed > 0) segs.push({ cls: "bg-destructive", flex: counts.failed });
  // Cancelled members render amber (operator action, not a system failure).
  if ((counts.cancelled ?? 0) > 0) segs.push({ cls: "bg-warning/60", flex: counts.cancelled ?? 0 });
  if (segs.length === 0) segs.push({ cls: "bg-secondary", flex: 1 });
  return segs;
}

