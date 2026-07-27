import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { dsFocus, dsIcon, dsLayer, dsMotion, dsRadius, dsText } from "./tokens";

/**
 * DEV-ONLY — data display primitives: Table, ProgressBar, TimelineSteps.
 *
 * Density is the point. These render a lot of rows in a little space without
 * becoming a wall: hairline separators instead of zebra stripes, tabular
 * numerals everywhere a value can change, and one accent per row at most.
 */

/* =========================================================================
 * Table
 * ====================================================================== */

/**
 * ```tsx
 * <Table label="Queued runs">
 *   <THead><TR><TH>Person</TH><TH align="right">Elapsed</TH></TR></THead>
 *   <TBody><TR><TD>…</TD><TD align="right" numeric>2m 14s</TD></TR></TBody>
 * </Table>
 * ```
 * `label` is required: a table without an accessible name is a grid of
 * mystery to anyone not looking at it.
 */
export function Table({
  label,
  layout = "auto",
  className,
  children,
}: {
  label: string;
  /**
   * `fixed` sizes the columns from the first row (or a `<colgroup>`) and never
   * re-measures. Reach for it whenever the BODY IS WINDOWED: an `auto` table
   * measures whatever rows are currently mounted, so a virtualised list
   * re-computes its columns on every scroll and the whole grid shivers. It is
   * also what lets a section header span the row without dragging the columns
   * around with it.
   */
  layout?: "auto" | "fixed";
  className?: string;
  children: ReactNode;
}) {
  return (
    <table
      aria-label={label}
      className={cn(
        "w-full border-separate border-spacing-0 text-left",
        layout === "fixed" && "table-fixed",
        dsText.body,
        className,
      )}
    >
      {children}
    </table>
  );
}

/** Sticky by default — the header must survive scrolling a long queue. */
export function THead({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <thead className={cn("sticky top-0", dsLayer.sticky, "bg-[var(--ds-surface-2)]", className)}>
      {children}
    </thead>
  );
}

export function TBody({ className, children }: { className?: string; children: ReactNode }) {
  return <tbody className={className}>{children}</tbody>;
}

export function TR({
  selected,
  interactive,
  className,
  children,
  ...props
}: {
  selected?: boolean;
  interactive?: boolean;
  className?: string;
  children: ReactNode;
} & HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      aria-selected={selected}
      className={cn(
        "h-[var(--ds-h-row)]",
        dsMotion.base,
        interactive && "cursor-pointer hover:bg-[var(--ds-surface-2)]",
        selected && "bg-[var(--ds-surface-selected)]",
        className,
      )}
      {...props}
    >
      {children}
    </tr>
  );
}

export type DsSortDirection = "ascending" | "descending" | "none";

export function TH({
  align = "left",
  sort,
  onSort,
  className,
  children,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & {
  align?: "left" | "right" | "center";
  /** present = sortable; drives `aria-sort` and the indicator glyph */
  sort?: DsSortDirection;
  onSort?: () => void;
}) {
  const SortIcon = sort === "ascending" ? ArrowUp : sort === "descending" ? ArrowDown : ChevronsUpDown;
  return (
    <th
      scope="col"
      aria-sort={sort}
      className={cn(
        "border-b border-[color:var(--ds-border)] px-[var(--ds-space-base)] py-[var(--ds-space-snug)]",
        dsText.caps,
        "text-[color:var(--ds-fg-muted)]",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
      {...props}
    >
      {onSort ? (
        <button
          type="button"
          onClick={onSort}
          className={cn(
            "inline-flex cursor-pointer items-center gap-[var(--ds-space-tight)]",
            dsFocus,
            dsMotion.fast,
            "hover:text-[color:var(--ds-fg)]",
            "active:translate-y-px",
          )}
        >
          {children}
          <SortIcon aria-hidden className={cn(dsIcon.sm, sort === "none" && "opacity-40")} />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function TD({
  align = "left",
  numeric,
  className,
  children,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & {
  align?: "left" | "right" | "center";
  /** monospace + tabular — use it for every id, count, duration and amount */
  numeric?: boolean;
}) {
  return (
    <td
      className={cn(
        "border-b border-[color:var(--ds-border-subtle)] px-[var(--ds-space-base)] py-[var(--ds-space-snug)]",
        "text-[color:var(--ds-fg-secondary)]",
        align === "right" && "text-right",
        align === "center" && "text-center",
        numeric && dsText.nums,
        className,
      )}
      {...props}
    >
      {children}
    </td>
  );
}

/* =========================================================================
 * ProgressBar
 * ====================================================================== */

/**
 * Determinate when you know the denominator (`value`/`max`), indeterminate
 * when you do not. Never fake a determinate bar — a progress bar that lies
 * about how far along a UCPath transaction is teaches the operator to ignore
 * every bar in the product.
 */
export function ProgressBar({
  value,
  max = 100,
  label,
  tone = "accent",
  showValue,
  className,
}: {
  /** omit for an indeterminate bar */
  value?: number;
  max?: number;
  /** accessible name — required */
  label: string;
  tone?: "accent" | "success" | "warning" | "danger";
  showValue?: boolean;
  className?: string;
}) {
  const indeterminate = typeof value !== "number";
  const pct = indeterminate ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const fill =
    tone === "success"
      ? "bg-[var(--ds-success-fg)]"
      : tone === "warning"
        ? "bg-[var(--ds-status-waiting-mark)]"
        : tone === "danger"
          ? "bg-[var(--ds-danger-solid)]"
          : "bg-[var(--ds-accent)]";

  return (
    <div className={cn("flex min-w-0 items-center gap-[var(--ds-space-base)]", className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : max}
        aria-valuenow={indeterminate ? undefined : value}
        className={cn("h-1 min-w-0 flex-1 overflow-hidden bg-[var(--ds-surface-3)]", dsRadius.pill)}
      >
        <div
          className={cn(
            "h-full",
            fill,
            dsRadius.pill,
            indeterminate
              ? "w-1/3 animate-pulse motion-reduce:animate-none"
              : "transition-[width] duration-[var(--ds-dur-3)] ease-[var(--ds-ease-standard)]",
          )}
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
      {showValue && !indeterminate && (
        <span className={cn(dsText.meta, dsText.nums, "shrink-0 text-[color:var(--ds-fg-muted)]")}>
          {Math.round(pct)}%
        </span>
      )}
    </div>
  );
}

/* =========================================================================
 * TimelineSteps
 * ====================================================================== */

export type DsStepState = "done" | "current" | "pending" | "failed" | "skipped";

export interface DsStep {
  label: string;
  state: DsStepState;
  /** a duration or a note shown under the label in the `full` variant */
  detail?: string;
}

const STEP_DOT: Record<DsStepState, string> = {
  done: "bg-[var(--ds-success-fg)] border-transparent",
  current: "bg-[var(--ds-status-running-mark)] border-transparent",
  pending: "bg-[var(--ds-surface-3)] border-[color:var(--ds-border-strong)]",
  failed: "bg-[var(--ds-status-failed-mark)] border-transparent",
  skipped: "bg-transparent border-[color:var(--ds-border-strong)]",
};

const STEP_TEXT: Record<DsStepState, string> = {
  done: "text-[color:var(--ds-fg-muted)]",
  current: "text-[color:var(--ds-fg)] font-medium",
  pending: "text-[color:var(--ds-fg-faint)]",
  failed: "text-[color:var(--ds-status-failed-fg)] font-medium",
  skipped: "text-[color:var(--ds-fg-faint)] line-through",
};

/**
 * Where a run is, without opening it.
 *
 * `compact` is the one-line dot rail for a card header — it is decorative, so
 * it carries an accessible summary instead of per-dot semantics. `full` is
 * the labelled list for a detail panel; the in-flight step is marked with
 * `aria-current="step"`.
 */
export function TimelineSteps({
  steps,
  variant = "compact",
  label = "Progress",
  className,
}: {
  steps: DsStep[];
  variant?: "compact" | "full";
  label?: string;
  className?: string;
}) {
  if (variant === "compact") {
    const current = steps.find((step) => step.state === "current");
    const done = steps.filter((step) => step.state === "done").length;
    return (
      <div
        role="img"
        aria-label={`${label}: ${done} of ${steps.length} steps done${current ? `, now ${current.label}` : ""}`}
        title={steps.map((step) => step.label).join(" · ")}
        className={cn("flex min-w-0 items-center", className)}
      >
        {steps.map((step, index) => (
          <span key={step.label} className="flex flex-1 items-center last:flex-none">
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full border", STEP_DOT[step.state])}
            />
            {index < steps.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "h-px min-w-[3px] flex-1",
                  step.state === "done"
                    ? "bg-[var(--ds-success-border)]"
                    : "bg-[var(--ds-border)]",
                )}
              />
            )}
          </span>
        ))}
      </div>
    );
  }

  return (
    <ol aria-label={label} className={cn("flex min-w-0 flex-col", className)}>
      {steps.map((step, index) => (
        <li
          key={step.label}
          aria-current={step.state === "current" ? "step" : undefined}
          className="flex min-w-0 gap-[var(--ds-space-base)]"
        >
          <span className="flex shrink-0 flex-col items-center">
            <span className={cn("mt-1 size-2 shrink-0 rounded-full border", STEP_DOT[step.state])} />
            {index < steps.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "w-px flex-1",
                  step.state === "done" ? "bg-[var(--ds-success-border)]" : "bg-[var(--ds-border)]",
                )}
              />
            )}
          </span>
          <span className="flex min-w-0 flex-col pb-[var(--ds-space-base)]">
            <span className={cn(dsText.ui, STEP_TEXT[step.state])}>{step.label}</span>
            {step.detail && (
              <span className={cn(dsText.meta, dsText.nums, "text-[color:var(--ds-fg-faint)]")}>
                {step.detail}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/* =========================================================================
 * KeyValue — the fact list under a run, a receipt or a record
 * ====================================================================== */

export function KeyValueList({
  items,
  className,
}: {
  items: { key: string; value: ReactNode; tone?: "default" | "warning" | "danger" }[];
  className?: string;
}) {
  return (
    <dl className={cn("grid grid-cols-[auto_1fr] gap-x-[var(--ds-space-cozy)] gap-y-[var(--ds-space-snug)]", className)}>
      {items.map((item) => (
        <div key={item.key} className="contents">
          <dt className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{item.key}</dt>
          <dd
            className={cn(
              dsText.body,
              dsText.nums,
              "min-w-0 truncate",
              item.tone === "warning"
                ? "text-[color:var(--ds-status-waiting-fg)]"
                : item.tone === "danger"
                  ? "text-[color:var(--ds-danger)]"
                  : "text-[color:var(--ds-fg)]",
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
