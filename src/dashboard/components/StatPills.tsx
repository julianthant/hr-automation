import { cn } from "@/lib/utils";
import type { TrackerEntry } from "./types";

interface StatPillsProps {
  entries: TrackerEntry[];
  activeFilter: string | null;
  onFilter: (status: string | null) => void;
}

/**
 * Status filter strip — operates as both a queue summary AND the queue's
 * status filter (clicking a pill filters; clicking the active pill clears).
 *
 * Designed to live INSIDE the QueuePanel's unified header — no own
 * border-b, no own background, no own outer padding. The QueuePanel
 * supplies the surrounding chrome so search + stats read as one cohesive
 * "filter rail" instead of two stacked components separated by a divider.
 *
 * Each pill uses semantic tint + colored text on the active state; counts
 * lead, label trails (mono digit gets the eye first, label confirms).
 */
const STATS = [
  { key: null,      label: "All",    color: "text-foreground",      tint: "bg-foreground/10",    ring: "ring-foreground/30" },
  { key: "done",    label: "Done",   color: "text-[#4ade80]",       tint: "bg-[#4ade80]/12",     ring: "ring-[#4ade80]/40" },
  { key: "running", label: "Active", color: "text-primary",         tint: "bg-primary/15",       ring: "ring-primary/40" },
  { key: "failed",  label: "Failed", color: "text-destructive",     tint: "bg-destructive/12",   ring: "ring-destructive/40" },
  { key: "pending", label: "Queue",  color: "text-[#fbbf24]",       tint: "bg-[#fbbf24]/12",     ring: "ring-[#fbbf24]/40" },
] as const;

export function StatPills({ entries, activeFilter, onFilter }: StatPillsProps) {
  const counts: Record<string, number> = { total: entries.length };
  for (const e of entries) {
    counts[e.status] = (counts[e.status] || 0) + 1;
  }

  return (
    <div role="group" aria-label="Filter queue by status" className="w-full grid grid-cols-5 gap-1.5 h-full items-center">
      {STATS.map((s) => {
        const count = s.key ? counts[s.key] || 0 : entries.length;
        const isActive = activeFilter === s.key;
        const dim = !isActive && count === 0;

        return (
          <button
            key={s.key ?? "all"}
            type="button"
            onClick={() => onFilter(isActive ? null : s.key)}
            aria-pressed={isActive}
            className={cn(
              "group flex flex-col items-center justify-center gap-1.5 rounded-lg px-1.5 py-2 cursor-pointer transition-all outline-none h-full",
              "border border-transparent",
              "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card",
              isActive
                ? cn(s.tint, "ring-1", s.ring)
                : "bg-secondary/40 hover:bg-secondary/80",
              dim && !isActive && "opacity-50 hover:opacity-100",
            )}
          >
            <span
              className={cn(
                "text-[16px] font-bold font-mono leading-none tabular-nums transition-colors",
                isActive ? s.color : count === 0 ? "text-muted-foreground" : s.color,
              )}
            >
              {count}
            </span>
            <span
              className={cn(
                "text-[10px] font-semibold uppercase tracking-[0.14em] leading-none transition-colors whitespace-nowrap",
                isActive ? s.color : "text-muted-foreground group-hover:text-foreground",
              )}
            >
              {s.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
