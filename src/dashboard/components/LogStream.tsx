import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LogLine } from "./LogLine";
import type { CollapsedLogEntry } from "./hooks/useLogs";
import type { LogCategory } from "./types";
import { getLogCategory } from "./types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface LogStreamProps {
  logs: CollapsedLogEntry[];
  loading: boolean;
}

const FILTER_TABS: { key: string; label: string; categories: LogCategory[] }[] = [
  { key: "all", label: "All", categories: [] },
  { key: "errors", label: "Errors", categories: ["error"] },
  { key: "auth", label: "Auth", categories: ["auth"] },
  { key: "fill", label: "Fill", categories: ["fill"] },
  { key: "navigate", label: "Navigate", categories: ["navigate"] },
  { key: "extract", label: "Extract", categories: ["extract"] },
];

export function LogStream({ logs, loading }: LogStreamProps) {
  const [filter, setFilter] = useState("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);

  const filtered = filter === "all"
    ? logs
    : logs.filter((l) => {
        const tab = FILTER_TABS.find((t) => t.key === filter);
        return tab?.categories.includes(getLogCategory(l.level, l.message));
      });

  const collapsedCount = logs.reduce((acc, l) => acc + (l.count > 1 ? l.count - 1 : 0), 0);

  // Snap to bottom before paint when logs first appear (no visible scroll)
  useLayoutEffect(() => {
    if (scrollRef.current && filtered.length > 0 && prevLenRef.current === 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filtered.length]);

  // Auto-scroll on new entries
  useEffect(() => {
    if (autoScroll && scrollRef.current && filtered.length > prevLenRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLenRef.current = filtered.length;
  }, [filtered.length, autoScroll]);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard", { duration: 1500 });
  };

  return (
    <>
      {/* Filter tabs */}
      <div className="flex items-center gap-0.5 px-6 py-2 border-b border-border flex-shrink-0">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={cn(
              "px-3 py-1 rounded-md text-xs font-medium transition-all cursor-pointer",
              "text-muted-foreground hover:text-foreground hover:bg-secondary",
              filter === tab.key && "text-foreground bg-accent",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Log lines */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-3">
        {loading && filtered.length === 0 ? (
          <div className="space-y-[6px] px-6 py-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3.5 py-[3px]">
                <div className="h-3 w-[72px] rounded bg-muted animate-pulse" />
                <div className="h-3.5 w-3.5 rounded bg-muted animate-pulse" />
                <div className="h-3 rounded bg-muted animate-pulse" style={{ width: `${100 + (i % 5) * 60}px` }} />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 && !loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            No logs yet
          </div>
        ) : (
          filtered.map((entry, i) => (
            <LogLine
              key={`${entry.ts}-${i}`}
              entry={entry}
              isCurrent={i === filtered.length - 1 && entry.level === "step"}
              onCopy={handleCopy}
            />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-6 py-2.5 border-t border-border text-[13px] text-muted-foreground flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-[7px] h-[7px] rounded-full bg-primary animate-pulse" />
          <span>Streaming</span>
          <span className="opacity-40">&middot;</span>
          <span>{filtered.length} entries</span>
          {collapsedCount > 0 && (
            <>
              <span className="opacity-40">&middot;</span>
              <span>{collapsedCount} collapsed</span>
            </>
          )}
        </div>
        <button
          onClick={() => setAutoScroll((v) => !v)}
          className={cn(
            "text-xs px-3 py-1 rounded-md border border-border font-medium cursor-pointer transition-all",
            "bg-secondary text-muted-foreground",
            autoScroll && "bg-accent text-accent-foreground border-primary",
          )}
        >
          ↧ Auto-scroll
        </button>
      </div>
    </>
  );
}
