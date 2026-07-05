import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronsDown, Check, ChevronDown, Database, Eye, Image as ImageIcon, Maximize2, Minimize2, ScrollText, Search, SquarePen, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { LogLine } from "./LogLine";
import type { CollapsedLogEntry } from "@/components/hooks/useLogs";
import type { LogCategory, RunEvent } from "@/components/shared/types";
import { getLogCategory } from "@/components/shared/types";
import { isDebugLog } from "./log-display";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type LazySlot = ReactNode | (() => ReactNode);

interface LogStreamProps {
  logs: CollapsedLogEntry[];
  events?: RunEvent[];
  loading: boolean;
  /** Rendered in place of the log list when the Screenshots surface is active. */
  screenshotsSlot?: ReactNode;
  /**
   * Rendered in place of the log list when the Edit Data surface is active.
   * The surface only appears in the bar when this slot is provided
   * (see editDataAvailable below).
   */
  editDataSlot?: ReactNode;
  /** Whether the workflow has any editable fields — gates the Edit Data surface. */
  editDataAvailable?: boolean;
  /** Rendered in place of the log list when the View Data surface is active. */
  viewDataSlot?: ReactNode;
  /** Whether this run recorded ≥1 data point — gates the View Data surface. */
  viewDataAvailable?: boolean;
  /** Rendered in place of the log list when the Preview surface is active. */
  previewSlot?: LazySlot;
  /**
   * Sticky-style chrome directly under the surface bar when Preview is active
   * (e.g. OCR prep filename + actions). Scrollable preview content stays in
   * {@link previewSlot} below.
   */
  previewHeaderSlot?: LazySlot;
  /** Whether this row has a previewable payload — gates the Preview surface. */
  previewAvailable?: boolean;
  /** Notifies the parent when the Preview surface is actually visible. */
  onPreviewVisibleChange?: (visible: boolean) => void;
  /** Compact controls for run history and row actions, rendered in the footer. */
  runControlsSlot?: ReactNode;
  /** Delegation chip in the footer: "from <Parent Workflow>" when delegated. "Standalone" is suppressed (noise). */
  delegationLabel?: string;
  /** Run-level failure banner (reason + Retry), rendered under the surface bar when the run failed. */
  failureBanner?: ReactNode;
  /**
   * Optional per-log source label (e.g. "OCR" / "Operation" / "Member") shown
   * as a small prefix badge before the message. Used by the operation
   * coordinator panel, whose stream merges three lifecycle sources; returns
   * undefined for an unlabeled line. Non-log (event) lines never get a label.
   */
  sourceLabelOf?: (entry: CollapsedLogEntry) => string | undefined;
  /** Default-active when first mounted — used to deep-link into Preview from another row. */
  initialTab?: string;
  /**
   * Maximize state lifted to parent so LogPanel can hide the detail header
   * + step pipeline when the operator wants the tab content fullscreen.
   */
  maximized?: boolean;
  onToggleMaximize?: () => void;
}

// ---------------------------------------------------------------------------
// Filter taxonomy — two orthogonal axes:
//
//   SURFACE  = which content pane is shown (different data sources), rendered
//              as a segmented control: Logs · Screenshots · Preview · Edit Data
//   CATEGORY = which lens on the Logs stream (subsets of the SAME stream),
//              rendered as an `All ▾` dropdown that appears only under Logs:
//              All · Errors · Fill · Navigate · Extract · Debug · Events
//
// Events is a category (a lens on the timestamped stream), not a surface.
// ---------------------------------------------------------------------------

type Surface = "logs" | "screenshots" | "preview" | "view-data" | "edit-data";
type Category = "all" | "errors" | "fill" | "navigate" | "extract" | "debug" | "events";

/** Exported for testing surface-bar completeness assertions only. */
export const SURFACES: readonly { key: Surface; label: string; icon: LucideIcon }[] = [
  { key: "logs", label: "Logs", icon: ScrollText },
  { key: "screenshots", label: "Screenshots", icon: ImageIcon },
  { key: "preview", label: "Preview", icon: Eye },
  { key: "view-data", label: "View Data", icon: Database },
  { key: "edit-data", label: "Edit Data", icon: SquarePen },
];

/** `categories` are the log levels a filter matches; `dot` is its accent token. */
const CATEGORIES: { key: Category; label: string; categories: LogCategory[]; dot: string }[] = [
  { key: "all", label: "All", categories: [], dot: "bg-muted-foreground" },
  { key: "errors", label: "Errors", categories: ["error"], dot: "bg-destructive" },
  { key: "fill", label: "Fill", categories: ["fill"], dot: "bg-log-teal" },
  { key: "navigate", label: "Navigate", categories: ["navigate"], dot: "bg-info" },
  { key: "extract", label: "Extract", categories: ["extract"], dot: "bg-log-cyan" },
  { key: "debug", label: "Debug", categories: ["debug"], dot: "bg-log-slate" },
  { key: "events", label: "Events", categories: [], dot: "bg-log-violet" },
];

const CATEGORY_KEYS = new Set<string>(CATEGORIES.map((c) => c.key));

/**
 * Map the parent's `initialTab` deep-link onto the (surface, category) pair.
 * Accepts both surface keys (preview/screenshots/edit-data) and category keys
 * (all/errors/…/events) so existing deep-links keep working.
 */
export function parseInitialTab(tab: string | undefined): { surface: Surface; category: Category } {
  if (tab === "screenshots" || tab === "preview" || tab === "view-data" || tab === "edit-data") {
    return { surface: tab, category: "all" };
  }
  if (tab && CATEGORY_KEYS.has(tab)) {
    return { surface: "logs", category: tab as Category };
  }
  return { surface: "logs", category: "all" };
}

type DisplayItem =
  | { kind: "log"; entry: CollapsedLogEntry }
  | { kind: "event"; entry: RunEvent };

export function emptyStreamMessage(source?: "events" | "screenshots" | "edit-data" | "preview"): string {
  return source === "events" ? "No run events for this row" : "No log entries for this row";
}

export function buildLogStreamItemKey(item: DisplayItem): string {
  if (item.kind === "log") {
    return [
      "log",
      item.entry.itemId ?? "noItem",
      item.entry.runId ?? "noRun",
      item.entry.ts,
      item.entry.count ?? 1,
    ].join("-");
  }

  return [
    "evt",
    item.entry.type,
    item.entry.runId ?? "noRun",
    item.entry.currentItemId ?? "noItem",
    item.entry.timestamp ?? item.entry.ts ?? "noTs",
    item.entry.screenshotKind ?? item.entry.step ?? item.entry.system ?? "noKind",
    item.entry.screenshotLabel ?? item.entry.currentStep ?? "noLabel",
  ].join("-");
}

function renderMaybeFactory(node: LazySlot | undefined): ReactNode {
  return typeof node === "function" ? node() : node;
}

function displayItemTimestamp(item: DisplayItem): string {
  if (item.kind === "log") return item.entry.ts ?? "";
  return item.entry.timestamp ?? (typeof item.entry.ts === "number" ? new Date(item.entry.ts).toISOString() : "");
}

/** Searchable text for the "Filter logs" box — the message for logs, the salient fields for events. */
function displayItemText(item: DisplayItem): string {
  if (item.kind === "log") return item.entry.message ?? "";
  const e = item.entry;
  return [e.type, e.system, e.step, e.currentStep, e.currentItemId, e.screenshotLabel]
    .filter(Boolean)
    .join(" ");
}

export function mergeDisplayItems(logs: CollapsedLogEntry[], events: RunEvent[]): DisplayItem[] {
  const logItems = logs.map((entry) => ({ kind: "log" as const, entry }));
  // Drop `step_change` events from the merged "all" view: every `ctx.step`
  // transition already shows here as the richer `Phase: X` / `Phase done: X`
  // log line (level "step"), so rendering the bare `step_change` event line
  // too would double up each transition. The events still flow to session
  // state (they drive the session card's `currentStep`) and remain visible in
  // the dedicated Events category, which renders `events` directly and bypasses
  // this merge. This is the render-time replacement for the old emit-time
  // dedup that used to suppress the event entirely (and broke `currentStep`).
  //
  // Drop `daemon_phase` events too: they fire on a ~1–2s heartbeat (one per
  // daemon lifecycle tick) and carry no per-run detail. 102 daemon_phase events
  // vs 67 item_start events in a typical session means they are the single
  // noisiest non-step event class. They remain visible in the Events category
  // and continue to drive session-card daemonPhase state — only the merged
  // Logs/"all" view suppresses them to reduce noise.
  //
  // Drop `idle_signal` too: it is a daemon-level keep-warm heartbeat (the
  // per-system idle-refresh ring touches ucpath/i9/kronos pages so the SSO
  // session never expires while the daemon waits for work). It carries no
  // per-run activity and, firing once per system per cycle, dominates the
  // merged timeline (it was the bulk of the wall of lines operators saw). It
  // stays in the dedicated Events category for debugging.
  const MERGE_DROPPED_EVENTS = new Set<string>(["step_change", "daemon_phase", "idle_signal"]);
  const eventItems = events
    .filter((entry) => !MERGE_DROPPED_EVENTS.has(entry.type))
    .map((entry) => ({ kind: "event" as const, entry }));
  const result: DisplayItem[] = [];
  let i = 0;
  let j = 0;

  while (i < logItems.length && j < eventItems.length) {
    if (displayItemTimestamp(logItems[i]) <= displayItemTimestamp(eventItems[j])) {
      result.push(logItems[i++]);
    } else {
      result.push(eventItems[j++]);
    }
  }
  while (i < logItems.length) result.push(logItems[i++]);
  while (j < eventItems.length) result.push(eventItems[j++]);
  return result;
}

export function LogStream({
  logs,
  events = [],
  loading,
  screenshotsSlot,
  editDataSlot,
  editDataAvailable,
  viewDataSlot,
  viewDataAvailable,
  previewSlot,
  previewHeaderSlot,
  previewAvailable,
  onPreviewVisibleChange,
  runControlsSlot,
  delegationLabel,
  failureBanner,
  sourceLabelOf,
  initialTab,
  maximized,
  onToggleMaximize,
}: LogStreamProps) {
  const initialFilter = useMemo(() => parseInitialTab(initialTab), [initialTab]);
  const [surface, setSurface] = useState<Surface>(initialFilter.surface);
  const [category, setCategory] = useState<Category>(initialFilter.category);
  // When parent flips initialTab (e.g. opening review from a queue-row click),
  // adopt the new surface/category. Operator can still switch away after.
  useEffect(() => {
    const next = parseInitialTab(initialTab);
    setSurface(next.surface);
    setCategory(next.category);
  }, [initialTab]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filterText, setFilterText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);

  // Surfaces visible in the bar: Edit Data / View Data / Preview only when the
  // row opts in.
  const visibleSurfaces = useMemo(
    () =>
      SURFACES.filter(
        (s) =>
          (s.key !== "edit-data" || editDataAvailable) &&
          (s.key !== "view-data" || viewDataAvailable) &&
          (s.key !== "preview" || previewAvailable),
      ),
    [editDataAvailable, previewAvailable, viewDataAvailable],
  );

  // If the active surface stops being available (e.g. previewAvailable flips
  // false while Preview is open), fall back to Logs so the panel never strands
  // on a hidden surface.
  useEffect(() => {
    if (!visibleSurfaces.some((s) => s.key === surface)) setSurface("logs");
  }, [visibleSurfaces, surface]);

  const isLogs = surface === "logs";
  const previewVisible = surface === "preview";
  const nonDebugLogs = useMemo(() => logs.filter((l) => !isDebugLog(l)), [logs]);
  const debugLogs = useMemo(() => logs.filter(isDebugLog), [logs]);

  const displayed = useMemo<DisplayItem[]>(() => {
    if (!isLogs) return [];
    if (category === "events") {
      return events.map((e) => ({ kind: "event" as const, entry: e }));
    }
    if (category === "debug") {
      return debugLogs.map((l) => ({ kind: "log" as const, entry: l }));
    }
    if (category === "all") {
      return mergeDisplayItems(nonDebugLogs, events);
    }
    const cats = CATEGORIES.find((c) => c.key === category)?.categories ?? [];
    return nonDebugLogs
      .filter((l) => cats.includes(getLogCategory(l.level, l.message)))
      .map((l) => ({ kind: "log" as const, entry: l }));
  }, [isLogs, category, nonDebugLogs, debugLogs, events]);

  // Free-text filter on top of the category lens — case-insensitive substring
  // over each line's message (logs) / salient fields (events).
  const visible = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return displayed;
    return displayed.filter((it) => displayItemText(it).toLowerCase().includes(q));
  }, [displayed, filterText]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30,
    overscan: 20,
  });
  const virtualItems = virtualizer.getVirtualItems();

  // Snap to bottom before paint when logs first appear (no visible scroll)
  useLayoutEffect(() => {
    if (visible.length > 0 && prevLenRef.current === 0) {
      virtualizer.scrollToIndex(visible.length - 1, { align: "end" });
    }
  }, [visible.length, virtualizer]);

  // Auto-scroll on new entries — coalesced via rAF to avoid mid-paint thrash
  useEffect(() => {
    if (!autoScroll || visible.length <= prevLenRef.current) {
      prevLenRef.current = visible.length;
      return;
    }
    prevLenRef.current = visible.length;
    const rafId = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(visible.length - 1, { align: "end" });
    });
    return () => cancelAnimationFrame(rafId);
  }, [visible.length, autoScroll, virtualizer]);

  const handleCopy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard", { duration: 1500 });
  }, []);

  useEffect(() => {
    onPreviewVisibleChange?.(previewVisible);
  }, [onPreviewVisibleChange, previewVisible]);

  const previewHeader = previewVisible ? renderMaybeFactory(previewHeaderSlot) : undefined;
  const previewBody = previewVisible ? renderMaybeFactory(previewSlot) : undefined;

  const activeCategory = CATEGORIES.find((c) => c.key === category) ?? CATEGORIES[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Row 1 — segmented surface control + category dropdown; resize toggle on the far right. */}
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-2 shrink-0">
        <div
          role="tablist"
          aria-label="Log panel surface"
          className="inline-flex h-8 items-center gap-0.5 rounded-lg border border-border bg-secondary/30 p-0.5"
        >
          {visibleSurfaces.map((s) => {
            const Icon = s.icon;
            const active = surface === s.key;
            return (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSurface(s.key)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-medium outline-none transition-colors cursor-pointer",
                  "focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-accent text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon aria-hidden className="h-3.5 w-3.5 shrink-0 opacity-90" />
                <span>{s.label}</span>
              </button>
            );
          })}
        </div>

        {/* Category dropdown — shown only under Logs; hidden on other surfaces. */}
        {isLogs && (
          <DropdownMenu>
            <DropdownMenuTrigger
              type="button"
              aria-label={`Log category: ${activeCategory.label}. Open menu.`}
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-md border border-border bg-secondary px-2.5 text-xs font-medium text-foreground outline-none transition-colors cursor-pointer",
                "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                "data-[state=open]:border-border data-[state=open]:bg-muted",
              )}
            >
              <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", activeCategory.dot)} />
              <span>{activeCategory.label}</span>
              <ChevronDown aria-hidden className="h-3 w-3 shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[10rem]">
              {CATEGORIES.map((c) => (
                <DropdownMenuItem
                  key={c.key}
                  onClick={() => setCategory(c.key)}
                  className={cn("gap-2", c.key === category && "bg-accent")}
                >
                  <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", c.dot)} />
                  <span>{c.label}</span>
                  {c.key === category && <Check aria-hidden className="ml-auto h-3.5 w-3.5" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {onToggleMaximize && (
          <button
            type="button"
            onClick={onToggleMaximize}
            aria-pressed={maximized}
            title={maximized ? "Exit fullscreen" : "Maximize tab content"}
            className={cn(
              "ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md outline-none transition-colors cursor-pointer",
              "focus-visible:ring-2 focus-visible:ring-ring",
              "text-muted-foreground hover:bg-secondary hover:text-foreground",
              maximized && "bg-accent text-foreground",
            )}
          >
            {maximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {/* Run-level failure banner — reason + Retry, surfaced above all surfaces. */}
      {failureBanner && (
        <div className="shrink-0 border-b border-border px-4 py-2.5">{failureBanner}</div>
      )}

      {/* Free-text log filter — only under Logs (a lens on the stream, like categories). */}
      {isLogs && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-1.5 shrink-0">
          <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Filter logs…"
            aria-label="Filter log lines"
            className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          {filterText && (
            <button
              type="button"
              onClick={() => setFilterText("")}
              aria-label="Clear log filter"
              className="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* Preview: optional header chrome + scroll body (two-column content lives in previewSlot). */}
      {previewVisible && (
        <>
          {previewHeader ? (
            <div className="shrink-0 border-b border-border bg-card/95 px-6 py-4 backdrop-blur">
              {previewHeader}
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-b border-border bg-secondary/30">
            {previewBody ?? (
              <div className="px-6 py-4 text-sm text-muted-foreground">
                Preview is unavailable for this row.
              </div>
            )}
          </div>
        </>
      )}

      {/* Screenshots slot — shown when Screenshots surface is active */}
      {surface === "screenshots" && (
        <div className="flex-1 overflow-y-auto border-b border-border">
          {screenshotsSlot ?? (
            <div className="px-6 py-4 text-sm text-muted-foreground">
              No screenshots captured for this run yet.
            </div>
          )}
        </div>
      )}

      {/* View Data slot — shown when View Data surface is active and the run has data points */}
      {surface === "view-data" && (
        <div className="flex flex-1 overflow-y-auto border-b border-border">
          {viewDataSlot ?? (
            <div className="flex-1 px-6 py-4 text-sm text-muted-foreground">
              View Data is unavailable for this run.
            </div>
          )}
        </div>
      )}

      {/* Edit Data slot — shown when Edit Data surface is active and the workflow opts in */}
      {surface === "edit-data" && (
        <div className="flex flex-1 overflow-y-auto border-b border-border">
          {editDataSlot ?? (
            <div className="flex-1 px-6 py-4 text-sm text-muted-foreground">
              Edit Data is unavailable for this run.
            </div>
          )}
        </div>
      )}

      {/* Log lines — hidden when a non-log surface owns the pane */}
      <div
        ref={scrollRef}
        className={cn("flex-1 overflow-y-auto border-b border-border py-3", !isLogs && "hidden")}
      >
        {loading && visible.length === 0 ? (
          <div className="space-y-[6px] px-6 py-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3.5 py-[3px]">
                <div className="h-3 w-[72px] rounded bg-muted motion-safe:animate-pulse" />
                <div className="h-3.5 w-3.5 rounded bg-muted motion-safe:animate-pulse" />
                <div className="h-3 rounded bg-muted motion-safe:animate-pulse" style={{ width: `${100 + (i % 5) * 60}px` }} />
              </div>
            ))}
          </div>
        ) : visible.length === 0 && !loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            {filterText.trim()
              ? `No lines match “${filterText.trim()}”`
              : emptyStreamMessage(category === "events" ? "events" : undefined)}
          </div>
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
            }}
          >
            {virtualItems.map((virtualRow) => {
              const item = visible[virtualRow.index];
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {item.kind === "log" ? (
                    <LogLine
                      entry={item.entry}
                      kind="log"
                      sourceLabel={sourceLabelOf?.(item.entry)}
                      isCurrent={
                        virtualRow.index === visible.length - 1 && item.entry.level === "step"
                      }
                      onCopy={handleCopy}
                    />
                  ) : (
                    <LogLine
                      entry={item.entry}
                      kind="event"
                      isCurrent={false}
                      onCopy={handleCopy}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer — h-12 matches QueuePanel's run-controls footer height so
          the two panels' bottom edges tile cleanly across the column gap.
          Streaming/auto-scroll affordances hide when a non-log surface owns
          the pane, but run controls stay available. */}
      <div className="h-12 flex items-center justify-between gap-3 px-6 text-[12px] text-muted-foreground shrink-0">
        {!isLogs ? (
          <div />
        ) : (
          // Minimal live cue — the noisy "Streaming · N entries · collapsed"
          // text was dropped; the count stays screen-reader-only.
          <div className="flex items-center leading-none">
            <span aria-hidden className="relative flex items-center justify-center w-[7px] h-[7px]">
              <span className="absolute inset-0 rounded-full bg-primary/50 motion-safe:animate-ping" />
              <span className="relative w-[7px] h-[7px] rounded-full bg-primary" />
            </span>
            <span className="sr-only" aria-live="polite">{visible.length} log entries streaming</span>
          </div>
        )}
        {/* Delegation provenance only when it adds info — "from <Parent>". "Standalone" is suppressed as noise. */}
        {delegationLabel && delegationLabel !== "Standalone" && (
          <span className="px-2 py-0.5 rounded-md bg-secondary text-[11px] font-mono text-muted-foreground border border-border/60 whitespace-nowrap shrink-0">
            {delegationLabel}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {runControlsSlot}
          {isLogs && (
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
                  <ChevronsDown className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {autoScroll ? "Auto-scroll on" : "Auto-scroll off"}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}
