import { useState, useMemo } from "react";
import { Search, Inbox, X } from "lucide-react";
import { StatPills } from "./StatPills";
import { EntryItem } from "./EntryItem";
import { EmptyState } from "./EmptyState";
import type { TrackerEntry } from "./types";
import { resolveEntryName } from "./entry-display";

interface QueuePanelProps {
  entries: TrackerEntry[];
  workflow: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
}

/**
 * QueuePanel
 *  - Header card (one cohesive unit, no internal divider): search input on
 *    top, status filter strip below.
 *  - Entry-count divider row: "N entries" — visually matches the LogPanel's
 *    StepPipeline row across the gap so horizontal dividers align.
 *  - Scrollable entry list.
 *
 * Header height is sized to make its bottom border land at the same Y as the
 * LogPanel's StepPipeline border on the right, so the two halves of the
 * dashboard read as one continuous grid.
 */
export function QueuePanel({ entries, workflow, selectedId, onSelect, loading }: QueuePanelProps) {
  void workflow;
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = entries;
    if (statusFilter) {
      result = result.filter((e) =>
        statusFilter === "pending" ? e.status === "pending" || e.status === "skipped" : e.status === statusFilter,
      );
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((e) => {
        const name = resolveEntryName(e).toLowerCase();
        return e.id.toLowerCase().includes(q) || name.includes(q);
      });
    }
    return result;
  }, [entries, statusFilter, search]);

  return (
    <div className="w-[300px] min-[1440px]:w-[380px] 2xl:w-[460px] flex-shrink-0 border-r border-border flex flex-col bg-background">
      {/* ── Search row — h-[60px] matches the LogPanel header height so
            the divider below the search lands at the same Y as the divider
            below the LogPanel header ("name + status badge" row). The
            quick-run input + SharePoint download dropdown both live in the
            TopBar's queue zone (mounted by App.tsx via QuickRunPanel), so
            this row is search-only. ── */}
      <div className="h-[60px] flex items-center gap-2 px-3 border-b border-border bg-card flex-shrink-0">
        <div className="flex items-center gap-2 bg-secondary border border-border rounded-lg h-8 px-3 flex-1 min-w-0 focus-within:border-primary transition-colors">
          <Search aria-hidden className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          <input
            type="text"
            placeholder="Search by name, email, or ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search queue"
            className="flex-1 bg-transparent border-none outline-none text-foreground text-[13px] font-sans placeholder:text-muted-foreground min-w-0"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* ── Status filter strip — h-[69.5px] makes the section's bottom
            border land exactly at the LogPanel's email-row border across
            the column gap (search 60 + pills 69.5 = panel-top + 129.5). ── */}
      <div className="h-[69.5px] flex items-center px-3 min-[1440px]:px-4 py-2 border-b border-border bg-card/60 flex-shrink-0">
        <StatPills entries={entries} activeFilter={statusFilter} onFilter={setStatusFilter} />
      </div>

      {/* ── Entry list ── */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-0">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="px-5 py-3.5 border-b border-border">
                <div className="flex justify-between mb-2">
                  <div className="h-4 w-32 rounded bg-muted animate-pulse" />
                  <div className="h-4 w-16 rounded bg-muted animate-pulse" />
                </div>
                <div className="h-3 w-48 rounded bg-muted animate-pulse mt-1" />
                <div className="h-3 w-24 rounded bg-muted animate-pulse mt-2" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No entries yet"
            description="Data will appear here as workflows run"
          />
        ) : (
          filtered.map((entry) => (
            <EntryItem
              key={entry.id}
              entry={entry}
              selected={selectedId === entry.id}
              onClick={() => onSelect(entry.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
