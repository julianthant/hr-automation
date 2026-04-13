import { useState, useMemo } from "react";
import { Search, Inbox } from "lucide-react";
import { StatPills } from "./StatPills";
import { EntryItem } from "./EntryItem";
import { EmptyState } from "./EmptyState";
import type { TrackerEntry } from "./types";
import { getConfig } from "./types";

interface QueuePanelProps {
  entries: TrackerEntry[];
  workflow: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
}

export function QueuePanel({ entries, workflow, selectedId, onSelect, loading }: QueuePanelProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const cfg = getConfig(workflow);

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
        const name = (cfg.getName(e) || "").toLowerCase();
        return e.id.toLowerCase().includes(q) || name.includes(q);
      });
    }
    return result;
  }, [entries, statusFilter, search, cfg]);

  return (
    <div className="w-[320px] min-[1440px]:w-[400px] 2xl:w-[480px] flex-shrink-0 border-r border-border flex flex-col bg-background">
      {/* Search */}
      <div className="p-4 px-5 border-b border-border">
        <div className="flex items-center gap-2.5 bg-input border border-border rounded-lg px-3.5 py-2.5 focus-within:border-primary transition-colors">
          <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <input
            type="text"
            placeholder="Search by name, email, or ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent border-none outline-none text-foreground text-sm font-sans placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {/* Stats */}
      <StatPills entries={entries} activeFilter={statusFilter} onFilter={setStatusFilter} />

      {/* Entry list */}
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
              workflow={workflow}
              selected={selectedId === entry.id}
              onClick={() => onSelect(entry.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
