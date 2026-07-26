import { useMemo } from "react";
import { AlertTriangle, ArrowUpDown, Ban, CheckCircle2, CheckSquare, ChevronsUp, RotateCcw, Square, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { submitDemoCommand, type DemoCommandResult } from "./demo-commands";
import { actionsAt, type DemoCommandKey } from "./demo-wire";
import { DEMO_SORTS, type DemoRow, type DemoSortKey } from "./demo-data";

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
  applied: { word: "applied", cls: "text-success", dot: "bg-success" },
  conflict: { word: "conflict", cls: "text-warning", dot: "bg-warning" },
  rejected: { word: "rejected", cls: "text-destructive", dot: "bg-destructive" },
  "not-offered": { word: "not offered", cls: "text-muted-foreground", dot: "bg-muted-foreground" },
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
    <div className="flex flex-col border-b border-border/60">
      <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
        <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ArrowUpDown aria-hidden className="size-3" />
          <span className="sr-only">Sort the queue</span>
          <select
            aria-label="Sort the queue"
            value={sort}
            onChange={(e) => onSort(e.target.value as DemoSortKey)}
            title={DEMO_SORTS.find((s) => s.key === sort)?.note}
            className="rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {DEMO_SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />

        <button
          type="button"
          aria-pressed={selectMode}
          onClick={() => onSelectMode(!selectMode)}
          title="Select rows to act on several at once. Selection never changes a count — the badges and pills stay exactly as they are."
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selectMode ? "border-primary/45 bg-primary/12 font-semibold text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground",
          )}
        >
          {selectMode ? <CheckSquare aria-hidden className="size-3" /> : <Square aria-hidden className="size-3" />}
          Select
        </button>

        {selectMode && (
          <>
            <button
              type="button"
              onClick={allSelected ? onClearSelection : onSelectAll}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] text-secondary-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              {allSelected ? "Clear" : `Select all ${visibleIds.length} in view`}
            </button>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{selectedCount} selected</span>
            {BULK_COMMANDS.map((c) => {
              const Icon = c.icon;
              return (
                <button
                  key={c.command}
                  type="button"
                  disabled={selectedCount === 0}
                  onClick={() => onBulk(c.command, c.label)}
                  title={`${c.label} every selected row that offers it. Rows that do not are reported, never silently skipped.`}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-secondary-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                >
                  <Icon aria-hidden className="size-3" />
                  {c.label}
                </button>
              );
            })}
          </>
        )}
      </div>

      {outcome && buckets && (
        <div className="border-t border-border/60 bg-secondary/20 px-3 py-2" aria-live="polite" data-demo-bulk-result="">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold text-foreground">{outcome.label} — partial result</span>
            {/* the whole vector, always. "2 applied" alone is the lie this
                surface exists to prevent. */}
            <span className="flex flex-wrap items-center gap-2 font-mono text-[11px] tabular-nums">
              <span className={STATE_TONE.applied.cls}>{buckets.applied.length} applied</span>
              <span aria-hidden className="text-muted-foreground">·</span>
              <span className={STATE_TONE.conflict.cls}>{buckets.conflict.length} conflict</span>
              <span aria-hidden className="text-muted-foreground">·</span>
              <span className={STATE_TONE.rejected.cls}>{buckets.rejected.length} rejected</span>
              {outcome.notOffered.length > 0 && (
                <>
                  <span aria-hidden className="text-muted-foreground">·</span>
                  <span className={STATE_TONE["not-offered"].cls}>{outcome.notOffered.length} not offered</span>
                </>
              )}
            </span>
            <button
              type="button"
              aria-label="Dismiss the bulk result"
              onClick={onDismissOutcome}
              className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden className="size-3" />
            </button>
          </div>

          {/* The rows something HAPPENED to, in full and never truncated —
              capped in height so the queue behind stays usable. */}
          <div className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-y-auto">
            {outcome.results.map((r) => {
              const tone = STATE_TONE[r.state];
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onSelectRow(r.rowId)}
                  className="flex min-w-0 items-center gap-2 rounded px-1 py-px text-left text-[11px] outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
                  <span className={cn("w-16 shrink-0 font-semibold uppercase tracking-wider text-[9.5px]", tone.cls)}>{tone.word}</span>
                  <span className="w-40 shrink-0 truncate text-secondary-foreground">{r.rowTitle}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{r.headline}</span>
                  {r.code && <span className="shrink-0 font-mono text-[9.5px] text-destructive">{r.code}</span>}
                  {r.state === "conflict" && (
                    <span className="shrink-0 font-mono text-[9.5px] text-warning">
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
            <details className="mt-1">
              <summary className="cursor-pointer text-[11px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="font-mono tabular-nums">{outcome.notOffered.length}</span> selected rows never offered{" "}
                {outcome.label.toLowerCase()} — nothing was attempted for them
              </summary>
              <div className="mt-0.5 flex max-h-28 flex-col gap-0.5 overflow-y-auto pl-3">
                {outcome.notOffered.map((n) => (
                  <span key={n.id} className="flex min-w-0 items-center gap-2 text-[11px]">
                    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATE_TONE["not-offered"].dot)} />
                    <span className="min-w-0 truncate text-muted-foreground">{n.title}</span>
                  </span>
                ))}
              </div>
            </details>
          )}

          <p className="mt-1 flex items-start gap-1.5 text-[10.5px] leading-snug text-muted-foreground">
            {buckets.conflict.length + buckets.rejected.length > 0 ? (
              <>
                <AlertTriangle aria-hidden className="mt-px size-3 shrink-0 text-warning" />
                Nothing was applied for the conflicted or rejected rows. Open each one and look before you decide again — a conflict means
                the row changed under you.
              </>
            ) : (
              <>
                <CheckCircle2 aria-hidden className="mt-px size-3 shrink-0 text-success" />
                Every selected row that offered {outcome.label.toLowerCase()} accepted it.
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
