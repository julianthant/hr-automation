import { useMemo } from "react";
import { AlertTriangle, ArrowUpDown, Ban, CheckCircle2, CheckSquare, ChevronsUp, RotateCcw, Square, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { submitDemoCommand, type DemoCommandResult } from "./demo-commands";
import { actionsAt, type DemoCommandKey } from "./demo-wire";
import { DEMO_SORTS, type DemoRow, type DemoSortKey } from "./demo-data";
import { Button, IconButton, dsBorder, dsFocus, dsIcon, dsMotion, dsRadius, dsSize, dsText } from "./demo-ui";

/**
 * DEV-ONLY — the Status Bar's second row: SORT, SELECT, and BULK COMMANDS.
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

/** the one toggle shape on this bar — the same height as the Status Bar pills */
const toolbarControl = (): string =>
  cn(
    "inline-flex shrink-0 cursor-pointer items-center border",
    "h-[var(--ds-h-sm)] gap-[var(--ds-space-snug)] px-[var(--ds-space-base)]",
    dsRadius.md,
    dsText.meta,
    dsFocus,
    dsMotion.fast,
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
      <div
        className={cn(
          "flex flex-wrap items-center",
          dsSize.hBar,
          "gap-[var(--ds-space-snug)] px-[var(--ds-space-base)]",
        )}
      >
        <label className={cn(dsText.meta, "inline-flex items-center gap-[var(--ds-space-snug)] text-[color:var(--ds-fg-muted)]")}>
          <ArrowUpDown aria-hidden className={dsIcon.sm} />
          <span className="sr-only">Sort the queue</span>
          <select
            aria-label="Sort the queue"
            value={sort}
            onChange={(e) => onSort(e.target.value as DemoSortKey)}
            title={DEMO_SORTS.find((s) => s.key === sort)?.note}
            className={cn(
              "cursor-pointer border px-[var(--ds-space-snug)]",
              "h-[var(--ds-h-sm)]",
              dsRadius.md,
              dsText.meta,
              dsFocus,
              dsMotion.fast,
              dsBorder.strong,
              "bg-[var(--ds-control-bg)] text-[color:var(--ds-fg)] hover:bg-[var(--ds-control-bg-hover)]",
            )}
          >
            {DEMO_SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <span aria-hidden className="h-4 w-px shrink-0 bg-[var(--ds-border)]" />

        <button
          type="button"
          aria-pressed={selectMode}
          onClick={() => onSelectMode(!selectMode)}
          title="Select rows to act on several at once. Selection never changes a count — the badges and pills stay exactly as they are."
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

        {selectMode && (
          <>
            <Button size="sm" variant="secondary" onClick={allSelected ? onClearSelection : onSelectAll}>
              {allSelected ? "Clear" : `Select all ${visibleIds.length} in view`}
            </Button>
            <span className={cn(dsText.meta, dsText.nums, "shrink-0 text-[color:var(--ds-fg-muted)]")}>{selectedCount} selected</span>
            {BULK_COMMANDS.map((c) => {
              const Icon = c.icon;
              return (
                <Button
                  key={c.command}
                  size="sm"
                  // Four peer commands in a toolbar, so four `outline`s — except
                  // Delete, the only irreversible one, which takes the surface's
                  // single danger slot. Two danger buttons on one surface is
                  // exactly what the ban exists to stop.
                  variant={c.command === "hide" ? "dangerGhost" : "outline"}
                  disabled={selectedCount === 0}
                  onClick={() => onBulk(c.command, c.label)}
                  title={`${c.label} every selected row that offers it. Rows that do not are reported, never silently skipped.`}
                  icon={<Icon aria-hidden className={dsIcon.sm} />}
                >
                  {c.label}
                </Button>
              );
            })}
          </>
        )}
      </div>

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
                      v{r.expectedVersion} → v{r.serverVersion}
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
