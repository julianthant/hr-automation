import { cn } from "@/lib/utils";
import type { TrackerEntry } from "./types";

interface StatPillsProps {
  entries: TrackerEntry[];
  activeFilter: string | null;
  onFilter: (status: string | null) => void;
}

const STATS = [
  { key: null, label: "Total", color: "text-foreground" },
  { key: "done", label: "Done", color: "text-[#4ade80]" },
  { key: "running", label: "Active", color: "text-primary" },
  { key: "failed", label: "Failed", color: "text-destructive" },
  { key: "pending", label: "Queue", color: "text-[#fbbf24]" },
] as const;

export function StatPills({ entries, activeFilter, onFilter }: StatPillsProps) {
  const counts: Record<string, number> = { total: entries.length };
  for (const e of entries) {
    counts[e.status] = (counts[e.status] || 0) + 1;
  }

  return (
    <div className="flex gap-1.5 p-3.5 px-5 border-b border-border">
      {STATS.map((s) => {
        const count = s.key ? (counts[s.key] || 0) : entries.length;
        const isActive = activeFilter === s.key;
        return (
          <button
            key={s.key ?? "total"}
            onClick={() => onFilter(isActive ? null : s.key)}
            className={cn(
              "flex-1 text-center py-2.5 px-2 rounded-lg transition-all",
              "bg-secondary border border-transparent cursor-pointer",
              "hover:border-border",
              isActive && "bg-accent border-primary",
            )}
          >
            <div className={cn("text-xl font-bold font-mono leading-tight", s.color)}>
              {count}
            </div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground mt-0.5 font-medium">
              {s.label}
            </div>
          </button>
        );
      })}
    </div>
  );
}
