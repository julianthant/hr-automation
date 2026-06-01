import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { BumpButton } from "@/components/shared/BumpButton";
import { RetryButton } from "@/components/shared/RetryButton";
import { RowCancelButton } from "@/components/shared/RowCancelButton";
import { DeleteButton } from "@/components/shared/DeleteButton";
import type { TrackerEntry } from "@/components/shared/types";
import type { WorkflowActionDescriptor } from "../../../domain/workflow-runtime/types.js";

/** Standard single-row action target. Footer buttons self-hide per descriptor. */
export interface RowFooterRowAction {
  workflow: string;
  id: string;
  runId?: string;
  date?: string;
  actions?: WorkflowActionDescriptor[];
  /** The row's tracker entry — lets cancel detect OCR-prep + read row status. */
  entry?: TrackerEntry;
  /** Display subject for action toasts (falls back to id). */
  subject?: string;
  onDelete?: (id: string) => void;
}

/**
 * The ONE footer shared by every queue row, rendered inside {@link QueueRowCard}
 * so single / preview / batch can't drift. Owns the uniform footer contract:
 *
 *   time · #run · id · ⟨spacer⟩ · elapsed|duration · retry · delete
 *
 * The action cluster lives HERE. A flat row passes `rowAction`; a batch card
 * passes a custom `actions` cluster (bulk) which overrides `rowAction`. Either
 * way the slot + layout are identical. Timing is one muted value — `elapsed`
 * (running) else `duration` (terminal); status is conveyed by the badge, never
 * the timer color.
 *
 * Flat-row buttons follow one schema, status-gated by the kernel projection
 * (`rowActionEnabledForStatus`). Each button self-hides on its descriptor's
 * `enabled` flag, so the visible cluster is purely status-driven:
 *   running → ×  ·  queued → ▲ ×  ·  done/failed → ↻ 🗑
 */
export interface RowFooterProps {
  time: string;
  runNumber: number;
  /** Footer secondary id (EID / trace id). */
  secondaryId?: string;
  /** Hide `secondaryId` when it equals this (e.g. the row title). */
  suppressIdWhenEquals?: string;
  elapsed?: string | null;
  duration?: string | null;
  /**
   * Props spread onto the meta region (time/#run/id/timing). Group cards pass
   * their drill-in handlers here so the footer meta is clickable; flat rows
   * omit it and let clicks bubble to the card's own `onSelect`.
   */
  metaProps?: HTMLAttributes<HTMLDivElement>;
  /** Standard single retry+delete cluster. Used when `actions` is not given. */
  rowAction?: RowFooterRowAction;
  /** Custom action cluster (batch bulk) — overrides `rowAction`. */
  actions?: ReactNode;
}

export function RowFooter({
  time,
  runNumber,
  secondaryId,
  suppressIdWhenEquals,
  elapsed,
  duration,
  metaProps,
  rowAction,
  actions,
}: RowFooterProps) {
  const showId = secondaryId && secondaryId !== suppressIdWhenEquals;
  // One status-gated schema: bump · retry · cancel · delete, ordered. Every
  // button self-hides when its kernel descriptor is disabled, so the visible
  // set is decided entirely by the projection's per-status `enabled` flags —
  // never a client-side `isRunning/isPending/isDone` branch.
  const actionCluster =
    actions ??
    (rowAction ? (
      <>
        <BumpButton
          workflow={rowAction.workflow}
          id={rowAction.id}
          runId={rowAction.runId}
          subject={rowAction.subject}
          actions={rowAction.actions}
        />
        <RetryButton
          workflow={rowAction.workflow}
          id={rowAction.id}
          runId={rowAction.runId}
          date={rowAction.date}
          actions={rowAction.actions}
        />
        <RowCancelButton
          workflow={rowAction.workflow}
          id={rowAction.id}
          runId={rowAction.runId}
          date={rowAction.date}
          subject={rowAction.subject}
          entry={rowAction.entry}
          actions={rowAction.actions}
        />
        {rowAction.onDelete && rowAction.date && (
          <DeleteButton
            workflow={rowAction.workflow}
            id={rowAction.id}
            date={rowAction.date}
            actions={rowAction.actions}
            onDeleted={rowAction.onDelete}
          />
        )}
      </>
    ) : null);

  return (
    <>
      <div className="border-t border-border/60" />
      <div className="px-3.5 py-1.5 bg-secondary/20 flex items-center gap-2 text-[11px] font-mono text-muted-foreground min-w-0">
        <div
          {...metaProps}
          className={cn("flex items-center gap-2 min-w-0 flex-1 outline-none", metaProps?.className)}
        >
          <span className="tabular-nums shrink-0">{time}</span>
          <span className="bg-secondary/80 px-1.5 py-px rounded font-medium shrink-0 tabular-nums">
            #{runNumber}
          </span>
          {showId && (
            <span
              className="truncate text-foreground/80 flex-shrink min-w-0 tabular-nums"
              title={secondaryId}
            >
              {secondaryId}
            </span>
          )}
          <span className="flex-1" />
          {(elapsed || duration) && (
            <span className="tabular-nums shrink-0">{elapsed || duration}</span>
          )}
        </div>
        {actionCluster ? (
          <div className="flex items-center gap-1 shrink-0">{actionCluster}</div>
        ) : null}
      </div>
    </>
  );
}
