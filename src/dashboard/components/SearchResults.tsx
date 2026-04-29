import { cn } from "@/lib/utils";
import { useWorkflows, autoLabel } from "../workflows-context";
import type { SearchResultRow } from "./types";
import { statusBadgeClass } from "./status-styles";

interface SearchResultsProps {
  rows: SearchResultRow[];
  query: string;
  onPick: (row: SearchResultRow) => void;
  /**
   * When true, drops the `absolute top-full … z-50` wrapper so the component
   * can be embedded inside a parent popover (e.g. CommandPalette) without
   * double-wrapping. Defaults to false (standalone / SearchBar usage).
   */
  embedded?: boolean;
  /** Which row index is currently keyboard-active. Applies `bg-accent` to that row. */
  activeRowIndex?: number;
  /** Called when the user hovers a row, with the row's index. */
  onMouseEnterRow?: (rowIndex: number) => void;
}

/** Compact date — matches the TopBar calendar-popover formatting. */
function shortDate(date: string): string {
  try {
    return new Date(date + "T00:00:00").toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return date;
  }
}

/** Short relative time since the last event on this run. */
function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/**
 * Dropdown of search matches, docked directly under the SearchBar input.
 * Surfaces the workflow label, status pill, summary line, and timestamp —
 * all in the same type scale the queue panel uses (sm for names, mono for
 * IDs / timestamps).
 */
export function SearchResults({ rows, query, onPick, embedded = false, activeRowIndex, onMouseEnterRow }: SearchResultsProps) {
  const registered = useWorkflows();
  const labelFor = (wf: string): string =>
    registered.find((r) => r.name === wf)?.label ?? autoLabel(wf);

  const wrapperClass = embedded
    ? "overflow-hidden"
    : "absolute top-full left-0 right-0 mt-1.5 min-w-[440px] bg-popover border border-border rounded-lg shadow-md z-50 overflow-hidden";

  if (rows.length === 0) {
    return (
      <div className={wrapperClass}>
        <div className="px-4 py-6 text-center">
          <div className="text-sm text-foreground font-medium">No matches</div>
          <div className="text-xs text-muted-foreground mt-1">
            No tracker entries matched{" "}
            <span className="font-mono">&quot;{query}&quot;</span> in the last 30 days.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={wrapperClass}>
      <div className="max-h-[380px] overflow-y-auto">
        {rows.map((row, i) => (
          <button
            key={`${row.workflow}::${row.id}::${row.runId}`}
            type="button"
            onClick={() => onPick(row)}
            onMouseEnter={() => onMouseEnterRow?.(i)}
            className={cn(
              "w-full text-left px-3.5 py-2.5 cursor-pointer transition-colors border-b border-border last:border-b-0",
              "hover:bg-accent focus-visible:bg-accent outline-none",
              i === activeRowIndex && "bg-accent",
            )}
          >
            {/* Row 1: workflow label + status pill */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold truncate">
                {labelFor(row.workflow)}
              </span>
              <span
                className={cn(
                  "text-[10px] font-semibold px-2 py-0.5 rounded-xl uppercase tracking-wide font-mono flex-shrink-0",
                  statusBadgeClass(row.status) || "bg-secondary text-muted-foreground",
                )}
              >
                {row.status}
              </span>
            </div>

            {/* Row 2: summary (e.g. name), truncated */}
            <div className="mt-1 text-sm font-semibold text-foreground truncate">
              {row.summary}
            </div>

            {/* Row 3: id (mono) + date/time (mono, muted) */}
            <div className="flex items-center justify-between mt-0.5 gap-2">
              <span className="text-[12px] font-mono text-muted-foreground truncate">
                {row.id}
              </span>
              <span className="text-[11px] font-mono text-muted-foreground flex-shrink-0 flex items-center gap-2">
                <span>{shortDate(row.date)}</span>
                <span className="w-px h-3 bg-border" />
                <span>{shortTime(row.lastTs)}</span>
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
