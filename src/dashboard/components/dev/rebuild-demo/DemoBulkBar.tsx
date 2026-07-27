import { useMemo, type ReactNode } from "react";
import { AlertTriangle, ArrowUpDown, Ban, CheckCircle2, CheckSquare, ChevronsUp, RotateCcw, Square, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { submitDemoCommand, type DemoCommandResult } from "./demo-commands";
import { actionsAt, type DemoCommandKey } from "./demo-wire";
import { DEMO_SORTS, type DemoRow, type DemoSortKey } from "./demo-data";
import { Button, IconButton, dsBorder, dsFocus, dsIcon, dsMotion, dsRadius, dsSize, dsText } from "./demo-ui";

/**
 * DEV-ONLY — the queue's ACTION BAR: what goes into the queue, and what you do
 * to what is already in it — panel toggle, run starters, sort, select, bulk.
 *
 * It carried only the second half of that until the shell's chrome was
 * measured: a run-start band sat directly above it, so two 36px rows, one
 * hairline apart, split a single idea — the things you do TO this queue — in
 * half. They are one row now; the `leading` and `runStart` slots are where the
 * shell hands over the controls it owns (the Workflow Panel toggle, the three
 * start surfaces) so this file still owns nothing but sort/select/bulk.
 *
 * The row never wraps: a fixed `--ds-h-bar` with `flex-wrap` silently CLIPS the
 * second line, so with select mode on and four bulk commands out, the bar
 * scrolls sideways the way the Status Bar does. A control you cannot reach is
 * worse than one you have to scroll to.
 *
 * The interesting part of a bulk command is not the happy path, it is the
 * partial one. Retrying four rows can come back "2 applied · 1 conflict ·
 * 1 rejected", and §1.3 is explicit that the UI may **never** collapse that
 * into "Done". So this bar renders the complete result VECTOR — every bucket,
 * with the rows in it named — and keeps it until it is dismissed.
 *
 * Which commands are offered is still `actions[]` and nothing else: a command
 * appears only if at least one selected row's surface sent it, and a selected
 * row that did not send it is reported as `not offered`, never silently
 * skipped. Selection never changes what anything counts — the bar sorts and
 * acts, it does not filter.
 */

export interface BulkOutcome {
  /** the command the operator asked for, across the frozen target set */
  command: DemoCommandKey;
  label: string;
  results: DemoCommandResult[];
  /** rows that were selected but never sent this command — reported, not hidden */
  notOffered: { id: string; title: string }[];
}

const BULK_COMMANDS: { command: DemoCommandKey; label: string; icon: typeof RotateCcw }[] = [
  { command: "retry", label: "Retry", icon: RotateCcw },
  { command: "bump", label: "Bump", icon: ChevronsUp },
  { command: "cancel", label: "Cancel", icon: Ban },
  { command: "hide", label: "Delete", icon: Trash2 },
];

const STATE_TONE: Record<DemoCommandResult["state"] | "not-offered", { word: string; cls: string; dot: string }> = {
  applied: { word: "applied", cls: "text-[color:var(--ds-success-fg)]", dot: "bg-[var(--ds-success-fg)]" },
  conflict: {
    word: "conflict",
    cls: "text-[color:var(--ds-status-waiting-fg)]",
    dot: "bg-[var(--ds-status-waiting-fg)]",
  },
  rejected: { word: "rejected", cls: "text-[color:var(--ds-danger)]", dot: "bg-[var(--ds-danger)]" },
  "not-offered": { word: "not offered", cls: "text-[color:var(--ds-fg-muted)]", dot: "bg-[var(--ds-fg-muted)]" },
};

export function runBulkCommand(rows: DemoRow[], command: DemoCommandKey, label: string, tick: number): BulkOutcome {
  const results: DemoCommandResult[] = [];
  const notOffered: { id: string; title: string }[] = [];
  for (const row of rows) {
    const action = actionsAt(row.actions, "footer").find((a) => a.command === command);
    if (!action) {
      notOffered.push({ id: row.id, title: row.displayName ?? row.title });
      continue;
    }
    results.push(submitDemoCommand(row, action, { knownVersion: action.expectedVersion, tick }));
  }
  return { command, label, results, notOffered };
}

/**
 * The one toggle shape on this bar — the same height as the Status Bar pills.
 * Exported because the shell's Workflow Panel toggle sits in the `leading` slot
 * of this same row, and two toggles a hairline apart must not drift.
 */
export const toolbarControl = (): string =>
  cn(
    "inline-flex shrink-0 cursor-pointer items-center border",
    "h-[var(--ds-h-sm)] gap-[var(--ds-space-snug)] px-[var(--ds-space-base)]",
    dsRadius.md,
    dsText.meta,
    dsFocus,
    dsMotion.fast,
    // The same press the `Button` primitive gives, because `Start a run` sits a
    // hairline from these two: one pressable that answers a press and one that
    // does not, side by side, is exactly the difference you feel and cannot name.
    "active:translate-y-px",
  );

export function DemoQueueToolbar({
  sort,
  onSort,
  selectMode,
  onSelectMode,
  selectedIds,
  visibleIds,
  onSelectAll,
  onClearSelection,
  onBulk,
  outcome,
  onDismissOutcome,
  onSelectRow,
  leading,
  runStart,
  filters,
}: {
  sort: DemoSortKey;
  onSort: (k: DemoSortKey) => void;
  selectMode: boolean;
  onSelectMode: (on: boolean) => void;
  selectedIds: ReadonlySet<string>;
  /** the top-level rows currently on screen — the only things Select all may take */
  visibleIds: string[];
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBulk: (command: DemoCommandKey, label: string) => void;
  outcome: BulkOutcome | null;
  onDismissOutcome: () => void;
  onSelectRow: (id: string) => void;
  /** shell-owned, far left: the Workflow Panel toggle, where its column began */
  leading?: ReactNode;
  /** shell-owned: the one Run Modal's primary control */
  runStart?: ReactNode;
  /** shell-owned: the status filter group, folded in from its own band */
  filters?: ReactNode;
}) {
  const selectedCount = selectedIds.size;
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const buckets = useMemo(() => {
    if (!outcome) return null;
    return {
      applied: outcome.results.filter((r) => r.state === "applied"),
      conflict: outcome.results.filter((r) => r.state === "conflict"),
      rejected: outcome.results.filter((r) => r.state === "rejected"),
    };
  }, [outcome]);

  return (
    <div className={cn("flex shrink-0 flex-col border-b", dsBorder.subtle)}>
      {/*
        ONE BAR, THREE GROUPS, and the grouping is by what a control DOES.

        It was two 36px bands, one hairline apart: a Status Bar of ten pills
        above a row of five unrelated control types at uniform spacing —
        a panel toggle, a primary button, a bare `⇅`, the sort select it
        belonged to, and a checkbox toggle — with the whole thing crammed left
        and the right half of the window empty. Nothing was grouped, nothing was
        anchored, and the two bands stacked into a thick undifferentiated band
        with no primary in it.

        Now: WHERE YOU ARE and WHAT YOU START on the left (the panel you are in,
        then the one primary action on the surface), WHAT YOU ARE LOOKING AT in
        the middle (the filters, which take the slack and scroll if a narrow
        window makes them), and HOW YOU ARE LOOKING AT IT on the right (sort,
        then select) — pushed into the dead space with `ml-auto`. Two hairlines,
        each separating a group from the next, rather than one every 8px.
      */}
      <div
        className={cn(
          "flex items-center",
          dsSize.hBar,
          "gap-[var(--ds-space-snug)] px-[var(--ds-space-base)]",
        )}
      >
        {leading}
        {runStart}
        {(leading || runStart) && <span aria-hidden className={cn("h-4 w-px shrink-0", "bg-[var(--ds-border)]")} />}

        <div className="flex min-w-0 flex-1 items-center">{filters}</div>

        <span aria-hidden className={cn("h-4 w-px shrink-0", "bg-[var(--ds-border)]")} />

        {/* Sort is ONE control. The `⇅` used to be a separate glyph sitting a
            gap away from the select it belonged to, so it read as a sixth
            control rather than as this one's icon. */}
        <span className="relative shrink-0">
          <ArrowUpDown
            aria-hidden
            className={cn(
              dsIcon.sm,
              "pointer-events-none absolute left-[var(--ds-space-snug)] top-1/2 -translate-y-1/2 text-[color:var(--ds-fg-muted)]",
            )}
          />
          <select
            aria-label="Sort the queue"
            value={sort}
            onChange={(e) => onSort(e.target.value as DemoSortKey)}
            title={DEMO_SORTS.find((s) => s.key === sort)?.note}
            className={cn(
              "cursor-pointer appearance-none border pl-[var(--ds-space-section)] pr-[var(--ds-space-base)]",
              "h-[var(--ds-h-sm)]",
              dsRadius.md,
              dsText.meta,
              dsFocus,
              dsMotion.fast,
              dsBorder.base,
              "bg-[var(--ds-surface-1)] text-[color:var(--ds-fg-secondary)] hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]",
            )}
          >
            {DEMO_SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </span>

        <button
          type="button"
          aria-pressed={selectMode}
          onClick={() => onSelectMode(!selectMode)}
          title="Act on several rows at once"
          className={cn(
            toolbarControl(),
            selectMode
              ? cn(dsBorder.loud, "bg-[var(--ds-surface-selected)] font-semibold text-[color:var(--ds-fg)]")
              : cn(dsBorder.base, "bg-[var(--ds-surface-1)] text-[color:var(--ds-fg-muted)] hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]"),
          )}
        >
          {selectMode ? <CheckSquare aria-hidden className={dsIcon.sm} /> : <Square aria-hidden className={dsIcon.sm} />}
          Select
        </button>
      </div>

      {/* SELECT MODE IS A MODE, so it gets its own band rather than six more
          controls shoved into a bar that is already carrying three groups.
          It exists only while the mode is on, so it costs nothing at rest —
          which is the difference between a second line and a second bar. */}
      {selectMode && (
        <div
          className={cn(
            "flex items-center border-t bg-[var(--ds-surface-2)]",
            dsSize.hBar,
            dsBorder.subtle,
            "gap-[var(--ds-space-snug)] px-[var(--ds-space-base)]",
          )}
        >
          <Button size="sm" variant="secondary" onClick={allSelected ? onClearSelection : onSelectAll}>
            {allSelected ? "Clear" : `Select all ${visibleIds.length} in view`}
          </Button>
          <span className={cn(dsText.meta, dsText.nums, "shrink-0 text-[color:var(--ds-fg-muted)]")}>
            {selectedCount} selected
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-[var(--ds-space-snug)]">
            {BULK_COMMANDS.map((c) => {
              const Icon = c.icon;
              return (
                <Button
                  key={c.command}
                  size="sm"
                  // Four peer commands, so four `outline`s — except Delete, the
                  // only irreversible one, which takes the surface's single
                  // danger slot. Two danger buttons on one surface is exactly
                  // what the ban exists to stop.
                  variant={c.command === "hide" ? "dangerGhost" : "outline"}
                  disabled={selectedCount === 0}
                  onClick={() => onBulk(c.command, c.label)}
                  title={`${c.label} every selected row that offers it`}
                  icon={<Icon aria-hidden className={dsIcon.sm} />}
                >
                  {c.label}
                </Button>
              );
            })}
          </span>
        </div>
      )}

      {outcome && buckets && (
        <div
          className={cn(
            "border-t bg-[var(--ds-surface-2)] px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]",
            dsBorder.subtle,
          )}
          aria-live="polite"
          data-demo-bulk-result=""
        >
          <div className="flex flex-wrap items-center gap-[var(--ds-space-base)]">
            <span className={cn(dsText.ui, "font-semibold text-[color:var(--ds-fg)]")}>{outcome.label} — partial result</span>
            {/* the whole vector, always. "2 applied" alone is the lie this
                surface exists to prevent. */}
            <span className={cn(dsText.meta, dsText.nums, "flex flex-wrap items-center gap-[var(--ds-space-base)]")}>
              <span className={STATE_TONE.applied.cls}>{buckets.applied.length} applied</span>
              <span aria-hidden className="text-[color:var(--ds-fg-faint)]">·</span>
              <span className={STATE_TONE.conflict.cls}>{buckets.conflict.length} conflict</span>
              <span aria-hidden className="text-[color:var(--ds-fg-faint)]">·</span>
              <span className={STATE_TONE.rejected.cls}>{buckets.rejected.length} rejected</span>
              {outcome.notOffered.length > 0 && (
                <>
                  <span aria-hidden className="text-[color:var(--ds-fg-faint)]">·</span>
                  <span className={STATE_TONE["not-offered"].cls}>{outcome.notOffered.length} not offered</span>
                </>
              )}
            </span>
            <IconButton
              size="sm"
              label="Dismiss the bulk result"
              onClick={onDismissOutcome}
              icon={<X aria-hidden className={dsIcon.sm} />}
              className="ml-auto"
            />
          </div>

          {/* The rows something HAPPENED to, in full and never truncated —
              capped in height so the queue behind stays usable. */}
          <div className="mt-[var(--ds-space-snug)] flex max-h-40 flex-col overflow-y-auto">
            {outcome.results.map((r) => {
              const tone = STATE_TONE[r.state];
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onSelectRow(r.rowId)}
                  className={cn(
                    "flex min-w-0 cursor-pointer items-center text-left",
                    "h-[var(--ds-h-sm)] gap-[var(--ds-space-base)] px-[var(--ds-space-tight)]",
                    dsRadius.sm,
                    dsText.meta,
                    dsFocus,
                    dsMotion.fast,
                    "hover:bg-[var(--ds-surface-3)]",
                  )}
                >
                  <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
                  <span className={cn(dsText.caps, "w-16 shrink-0", tone.cls)}>{tone.word}</span>
                  <span className="w-40 shrink-0 truncate text-[color:var(--ds-fg-secondary)]">{r.rowTitle}</span>
                  <span className="min-w-0 flex-1 truncate text-[color:var(--ds-fg-muted)]">{r.headline}</span>
                  {r.code && <span className={cn(dsText.micro, dsText.nums, "shrink-0 text-[color:var(--ds-danger)]")}>{r.code}</span>}
                  {r.state === "conflict" && (
                    <span className={cn(dsText.micro, dsText.nums, "shrink-0 text-[color:var(--ds-status-waiting-fg)]")}>
                      rev {r.expectedVersion} → {r.serverVersion}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Nothing was ATTEMPTED for these, so they are one line by default —
              still counted, still nameable, never silently dropped. */}
          {outcome.notOffered.length > 0 && (
            <details className="mt-[var(--ds-space-snug)]">
              <summary className={cn(dsText.meta, "cursor-pointer text-[color:var(--ds-fg-muted)]", dsFocus)}>
                <span className={dsText.nums}>{outcome.notOffered.length}</span> selected rows never offered{" "}
                {outcome.label.toLowerCase()} — nothing was attempted for them
              </summary>
              <div className="mt-[var(--ds-space-tight)] flex max-h-28 flex-col gap-[var(--ds-space-hair)] overflow-y-auto pl-[var(--ds-space-cozy)]">
                {outcome.notOffered.map((n) => (
                  <span key={n.id} className={cn(dsText.meta, "flex min-w-0 items-center gap-[var(--ds-space-base)]")}>
                    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATE_TONE["not-offered"].dot)} />
                    <span className="min-w-0 truncate text-[color:var(--ds-fg-muted)]">{n.title}</span>
                  </span>
                ))}
              </div>
            </details>
          )}

          <p
            className={cn(
              dsText.meta,
              "mt-[var(--ds-space-snug)] flex items-start gap-[var(--ds-space-snug)] leading-snug text-[color:var(--ds-fg-muted)]",
            )}
          >
            {buckets.conflict.length + buckets.rejected.length > 0 ? (
              <>
                <AlertTriangle aria-hidden className={cn(dsIcon.sm, "mt-px shrink-0 text-[color:var(--ds-status-waiting-fg)]")} />
                Nothing was applied for the conflicted or rejected rows. Open each one and look before you decide again — a conflict means
                the row changed under you.
              </>
            ) : (
              <>
                <CheckCircle2 aria-hidden className={cn(dsIcon.sm, "mt-px shrink-0 text-[color:var(--ds-success-fg)]")} />
                Every selected row that offered {outcome.label.toLowerCase()} accepted it.
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
