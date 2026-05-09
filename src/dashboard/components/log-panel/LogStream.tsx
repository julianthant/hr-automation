import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ArrowDownToLine, Maximize2, Minimize2 } from "lucide-react";
import { LogLine } from "./LogLine";
import type { CollapsedLogEntry } from "@/components/hooks/useLogs";
import type { LogCategory, RunEvent } from "@/components/shared/types";
import { getLogCategory } from "@/components/shared/types";
import { isDebugLog } from "./log-display";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface LogStreamProps {
  logs: CollapsedLogEntry[];
  events?: RunEvent[];
  loading: boolean;
  /** Rendered in place of the log list when the Screenshots tab is active. */
  screenshotsSlot?: ReactNode;
  /**
   * Rendered in place of the log list when the Edit Data tab is active.
   * Tab itself only appears in the filter bar when this slot is provided
   * (see editDataAvailable below).
   */
  editDataSlot?: ReactNode;
  /** Whether the workflow has any editable fields — gates the Edit Data tab. */
  editDataAvailable?: boolean;
  /** Rendered in place of the log list when the Preview tab is active. */
  previewSlot?: ReactNode;
  /** Whether this row has a previewable payload — gates the Preview tab. */
  previewAvailable?: boolean;
  /** Compact controls for run history and row actions, rendered in the footer. */
  runControlsSlot?: ReactNode;
  /** Default-active when first mounted — used to deep-link into Preview from another row. */
  initialTab?: string;
  /**
   * Maximize state lifted to parent so LogPanel can hide the detail header
   * + step pipeline when the operator wants the tab content fullscreen.
   */
  maximized?: boolean;
  onToggleMaximize?: () => void;
}

const FILTER_TABS: {
  key: string;
  label: string;
  categories: LogCategory[];
  source?: "events" | "screenshots" | "edit-data" | "preview";
}[] = [
  { key: "all", label: "All", categories: [] },
  { key: "errors", label: "Errors", categories: ["error"] },
  { key: "fill", label: "Fill", categories: ["fill"] },
  { key: "navigate", label: "Navigate", categories: ["navigate"] },
  { key: "extract", label: "Extract", categories: ["extract"] },
  { key: "debug", label: "Debug", categories: ["debug"] },
  { key: "events", label: "Events", categories: [], source: "events" },
  { key: "screenshots", label: "Screenshots", categories: [], source: "screenshots" },
  { key: "preview", label: "Preview", categories: [], source: "preview" },
  { key: "edit-data", label: "Edit Data", categories: [], source: "edit-data" },
];

type DisplayItem =
  | { kind: "log"; entry: CollapsedLogEntry }
  | { kind: "event"; entry: RunEvent };

export function emptyStreamMessage(source?: "events" | "screenshots" | "edit-data" | "preview"): string {
  return source === "events" ? "No run events for this row" : "No log entries for this row";
}

export function LogStream({
  logs,
  events = [],
  loading,
  screenshotsSlot,
  editDataSlot,
  editDataAvailable,
  previewSlot,
  previewAvailable,
  runControlsSlot,
  initialTab,
  maximized,
  onToggleMaximize,
}: LogStreamProps) {
  const [filter, setFilter] = useState(initialTab ?? "all");
  // When parent flips initialTab (e.g. opening review from a queue-row click),
  // adopt the new tab. Operator can still switch away after.
  useEffect(() => {
    if (initialTab) setFilter(initialTab);
  }, [initialTab]);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);

  const tab = FILTER_TABS.find((t) => t.key === filter);
  const nonDebugLogs = useMemo(() => logs.filter((l) => !isDebugLog(l)), [logs]);
  const debugLogs = useMemo(() => logs.filter(isDebugLog), [logs]);

  const displayed = useMemo<DisplayItem[]>(() => {
    if (tab?.source === "events") {
      return events.map((e) => ({ kind: "event" as const, entry: e }));
    }
    if (filter === "debug") {
      return debugLogs.map((l) => ({ kind: "log" as const, entry: l }));
    }
    if (filter === "all") {
      const merged: DisplayItem[] = [
        ...nonDebugLogs.map((l) => ({ kind: "log" as const, entry: l })),
        ...events.map((e) => ({ kind: "event" as const, entry: e })),
      ];
      merged.sort((a, b) => {
        const ta = a.kind === "log"
          ? a.entry.ts
          : (a.entry.timestamp ?? (typeof a.entry.ts === "number" ? new Date(a.entry.ts).toISOString() : ""));
        const tb = b.kind === "log"
          ? b.entry.ts
          : (b.entry.timestamp ?? (typeof b.entry.ts === "number" ? new Date(b.entry.ts).toISOString() : ""));
        const sa = ta ?? "";
        const sb = tb ?? "";
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
      return merged;
    }
    return nonDebugLogs
      .filter((l) => tab?.categories.includes(getLogCategory(l.level, l.message)))
      .map((l) => ({ kind: "log" as const, entry: l }));
  }, [filter, tab, nonDebugLogs, debugLogs, events]);

  const collapsedCount = nonDebugLogs.reduce((acc, l) => acc + (l.count > 1 ? l.count - 1 : 0), 0);

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

  const handleCopy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard", { duration: 1500 });
  }, []);

  const visibleTabs = FILTER_TABS.filter(
    (t) =>
      (t.key !== "edit-data" || editDataAvailable) &&
      (t.key !== "preview" || previewAvailable),
  );

  return (
    <>
      {/* Filter tabs + maximize toggle */}
      <div className="flex items-center gap-0.5 px-6 py-2 border-b border-border flex-shrink-0">
        {visibleTabs.map((tab) => (
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
        {onToggleMaximize && (
          <button
            type="button"
            onClick={onToggleMaximize}
            aria-pressed={maximized}
            title={maximized ? "Exit fullscreen" : "Maximize tab content"}
            className={cn(
              "ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md cursor-pointer transition-colors",
              "text-muted-foreground hover:text-foreground hover:bg-secondary",
              maximized && "text-foreground bg-accent",
            )}
          >
            {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {/* Preview slot — shown when Preview tab is active */}
      {tab?.source === "preview" && (
        <div className="flex-1 overflow-y-auto border-b border-border">
          {previewSlot ?? (
            <div className="px-6 py-4 text-sm text-muted-foreground">
              Preview is unavailable for this row.
            </div>
          )}
        </div>
      )}

      {/* Screenshots slot — shown when Screenshots tab is active */}
      {tab?.source === "screenshots" && (
        <div className="flex-1 overflow-y-auto border-b border-border">
          {screenshotsSlot ?? (
            <div className="px-6 py-4 text-sm text-muted-foreground">
              No screenshots captured for this run yet.
            </div>
          )}
        </div>
      )}

      {/* Edit Data slot — shown when Edit Data tab is active and the workflow opts in */}
      {tab?.source === "edit-data" && (
        <div className="flex-1 overflow-y-auto border-b border-border flex">
          {editDataSlot ?? (
            <div className="flex-1 px-6 py-4 text-sm text-muted-foreground">
              Edit Data is unavailable for this run.
            </div>
          )}
        </div>
      )}

      {/* Log lines — hidden when Screenshots or Edit Data tab is active */}
      <div ref={scrollRef} className={cn("flex-1 overflow-y-auto py-3 border-b border-border", (tab?.source === "screenshots" || tab?.source === "edit-data" || tab?.source === "preview") && "hidden")}>
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
            {emptyStreamMessage(tab?.source)}
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
                key={`evt-${item.entry.timestamp ?? item.entry.ts ?? "noTs"}-${i}`}
                entry={{ ...item.entry, kind: "event" }}
                isCurrent={false}
                onCopy={handleCopy}
              />
            ),
          )
        )}
      </div>

      {/* Footer — h-12 matches QueuePanel's run-controls footer height so
          the two panels' bottom edges tile cleanly across the column gap.
          Streaming/auto-scroll affordances hide when a non-log slot owns
          the panel, but run controls stay available after the header is
          removed. */}
      <div className="h-12 flex items-center justify-between gap-3 px-6 text-[12px] text-muted-foreground flex-shrink-0">
        {tab?.source === "screenshots" || tab?.source === "edit-data" || tab?.source === "preview" ? (
          <div />
        ) : (
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
        )}
        <div className="ml-auto flex items-center gap-1">
          {runControlsSlot}
          {(tab?.source !== "screenshots" && tab?.source !== "edit-data" && tab?.source !== "preview") && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setAutoScroll((v) => !v)}
                  aria-label={autoScroll ? "Disable auto-scroll" : "Enable auto-scroll"}
                  aria-pressed={autoScroll}
                  className={cn(
                    "h-8 w-8 inline-flex items-center justify-center rounded-md border cursor-pointer transition-colors outline-none",
                    "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card",
                    autoScroll
                      ? "bg-primary/10 text-primary border-primary/40 hover:bg-primary/15"
                      : "bg-secondary text-muted-foreground border-border hover:text-foreground hover:border-border/80",
                  )}
                >
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {autoScroll ? "Auto-scroll on" : "Auto-scroll off"}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </>
  );
}
