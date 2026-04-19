import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LogLine } from "./LogLine";
import type { CollapsedLogEntry } from "./hooks/useLogs";
import type { LogCategory, RunEvent } from "./types";
import { getLogCategory } from "./types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface LogStreamProps {
  logs: CollapsedLogEntry[];
  events?: RunEvent[];
  loading: boolean;
}

const FILTER_TABS: {
  key: string;
  label: string;
  categories: LogCategory[];
  source?: "events";
}[] = [
  { key: "all", label: "All", categories: [] },
  { key: "errors", label: "Errors", categories: ["error"] },
  { key: "auth", label: "Auth", categories: ["auth"] },
  { key: "fill", label: "Fill", categories: ["fill"] },
  { key: "navigate", label: "Navigate", categories: ["navigate"] },
  { key: "extract", label: "Extract", categories: ["extract"] },
  { key: "events", label: "Events", categories: [], source: "events" },
];

type DisplayItem =
  | { kind: "log"; entry: CollapsedLogEntry }
  | { kind: "event"; entry: RunEvent };

export function LogStream({ logs, events = [], loading }: LogStreamProps) {
  const [filter, setFilter] = useState("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);

  const tab = FILTER_TABS.find((t) => t.key === filter);
  let displayed: DisplayItem[];

  if (tab?.source === "events") {
    displayed = events.map((e) => ({ kind: "event" as const, entry: e }));
  } else if (filter === "all") {
    displayed = [
      ...logs.map((l) => ({ kind: "log" as const, entry: l })),
      ...events.map((e) => ({ kind: "event" as const, entry: e })),
    ].sort((a, b) => {
      const ta = a.kind === "log" ? a.entry.ts : a.entry.timestamp;
      const tb = b.kind === "log" ? b.entry.ts : b.entry.timestamp;
      return ta.localeCompare(tb);
    });
  } else {
    displayed = logs
      .filter((l) => tab?.categories.includes(getLogCategory(l.level, l.message)))
      .map((l) => ({ kind: "log" as const, entry: l }));
  }

  const collapsedCount = logs.reduce((acc, l) => acc + (l.count > 1 ? l.count - 1 : 0), 0);

  // Snap to bottom before paint when logs first appear (no visible scroll)
  useLayoutEffect(() => {
    if (scrollRef.current && displayed.length > 0 && prevLenRef.current === 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [displayed.length]);

  // Auto-scroll on new entries
  useEffect(() => {
    if (autoScroll && scrollRef.current && displayed.length > prevLenRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLenRef.current = displayed.length;
  }, [displayed.length, autoScroll]);

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
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-3 border-b border-border">
        {loading && displayed.length === 0 ? (
          <div className="space-y-[6px] px-6 py-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3.5 py-[3px]">
                <div className="h-3 w-[72px] rounded bg-muted animate-pulse" />
                <div className="h-3.5 w-3.5 rounded bg-muted animate-pulse" />
                <div className="h-3 rounded bg-muted animate-pulse" style={{ width: `${100 + (i % 5) * 60}px` }} />
              </div>
            ))}
          </div>
        ) : displayed.length === 0 && !loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            No logs yet
          </div>
        ) : (
          displayed.map((item, i) =>
            item.kind === "log" ? (
              <LogLine
                key={`log-${item.entry.ts}-${i}`}
                entry={{ ...item.entry, kind: "log" }}
                isCurrent={
                  i === displayed.length - 1 && item.entry.level === "step"
                }
                onCopy={handleCopy}
              />
            ) : (
              <LogLine
                key={`evt-${item.entry.timestamp}-${i}`}
                entry={{ ...item.entry, kind: "event" }}
                isCurrent={false}
                onCopy={handleCopy}
              />
            ),
          )
        )}
      </div>

      {/* Footer — h-[41px] so its top border aligns with SelectorHealth
          header on the right rail across the column gap. */}
      <div className="h-[41px] flex items-center justify-between px-6 text-[12px] text-muted-foreground flex-shrink-0">
        <div className="flex items-center gap-2 leading-none">
          <span className="relative flex items-center justify-center w-[7px] h-[7px]">
            <span className="absolute inset-0 rounded-full bg-primary/50 animate-ping" />
            <span className="relative w-[7px] h-[7px] rounded-full bg-primary" />
          </span>
          <span className="font-medium">Streaming</span>
          <span className="text-border">•</span>
          <span className="font-mono tabular-nums">{displayed.length}</span>
          <span>entries</span>
          {collapsedCount > 0 && (
            <>
              <span className="text-border">•</span>
              <span className="font-mono tabular-nums">{collapsedCount}</span>
              <span>collapsed</span>
            </>
          )}
        </div>
        <button
          onClick={() => setAutoScroll((v) => !v)}
          aria-pressed={autoScroll}
          className={cn(
            "h-6 text-[11px] px-2.5 rounded-md border font-medium cursor-pointer transition-colors leading-none flex items-center gap-1.5",
            autoScroll
              ? "bg-primary/10 text-primary border-primary/40 hover:bg-primary/15"
              : "bg-secondary text-muted-foreground border-border hover:text-foreground hover:border-border/80",
          )}
        >
          <span aria-hidden>↧</span>
          Auto-scroll
        </button>
      </div>
    </>
  );
}
