import { memo } from "react";
import { cn } from "@/lib/utils";
import {
  Pencil, MousePointer, ArrowDownToLine, Search, ListFilter,
  KeyRound, Download, Check, X, Hourglass, ArrowRight, ChevronRight,
  Play, Square, Plus, Minus, Monitor, Power, Pause, Camera, Activity,
  Dot,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { LogCategory, RunEvent } from "@/components/shared/types";
import { resolveRunEventTimestamp } from "@/components/shared/types";
import { getLogCategory } from "@/components/shared/types";
import type { CollapsedLogEntry } from "@/components/hooks/useLogs";
import { formatLogMessageForDisplay } from "./log-display";

const ICON_MAP: Record<LogCategory, { icon: typeof Check; color: string }> = {
  fill: { icon: Pencil, color: "text-log-cyan" },
  navigate: { icon: MousePointer, color: "text-log-slate" },
  extract: { icon: ArrowDownToLine, color: "text-warning" },
  search: { icon: Search, color: "text-info" },
  select: { icon: ListFilter, color: "text-log-teal" },
  auth: { icon: KeyRound, color: "text-log-violet" },
  download: { icon: Download, color: "text-success" },
  success: { icon: Check, color: "text-[#4ade80]" },
  error: { icon: X, color: "text-destructive" },
  waiting: { icon: Hourglass, color: "text-[#fbbf24]" },
  step: { icon: ArrowRight, color: "text-info" },
  debug: { icon: ChevronRight, color: "text-muted-foreground/40" },
};

type LogLineProps = {
  isCurrent: boolean;
  onCopy: (text: string) => void;
  /**
   * Optional source-stream label (e.g. "OCR" / "Operation" / "Member"),
   * rendered as a small prefix badge. Only used by the operation coordinator
   * panel's merged timeline; absent for ordinary single-source rows.
   */
  sourceLabel?: string;
} & (
  | { kind: "log"; entry: CollapsedLogEntry }
  | { kind: "event"; entry: RunEvent }
);

function LogLineImpl({ entry, kind, isCurrent, onCopy, sourceLabel }: LogLineProps) {
  if (kind === "event") {
    return <EventLine event={entry} />;
  }
  const category = getLogCategory(entry.level, entry.message);
  const { icon: Icon, color } = ICON_MAP[category];
  const ts = entry.ts
    ? new Date(entry.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";
  const message = formatLogMessageForDisplay(entry.message);

  return (
    <div
      className={cn(
        "group flex items-start gap-3.5 px-6 py-[3px] font-mono text-[13px] leading-relaxed cursor-pointer relative",
        "transition-colors hover:bg-foreground/[0.02]",
        isCurrent && "bg-primary/[0.05]",
      )}
      role="button"
      tabIndex={0}
      onClick={() => onCopy(`${ts} ${message}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onCopy(`${ts} ${message}`);
        }
      }}
    >
      <span className="text-muted-foreground text-xs whitespace-nowrap min-w-[72px] mt-[3px]">{ts}</span>
      <Icon className={cn("w-[14px] h-[14px] shrink-0 mt-[3px]", color)} aria-hidden />
      {sourceLabel && (
        <span className="mt-[2px] shrink-0 rounded bg-secondary px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border border-border/60">
          {sourceLabel}
        </span>
      )}
      <span className={cn(
        "flex-1 min-w-0 break-words",
        category === "success" && "text-[#4ade80]",
        category === "error" && "text-destructive",
        category === "debug" && "text-muted-foreground/60",
        isCurrent && "text-primary",
        category !== "success" && category !== "error" && category !== "debug" && !isCurrent && "text-secondary-foreground",
      )}>
        {message}
      </span>
      {entry.count > 1 && (
        <span className="text-[11px] bg-accent text-accent-foreground px-1.5 py-px rounded font-semibold shrink-0">
          x{entry.count}
        </span>
      )}
      <span className="absolute right-6 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity">
        Copy
      </span>
    </div>
  );
}

export const LogLine = memo(LogLineImpl);

const EVENT_VISUAL: Record<RunEvent["type"], { icon: LucideIcon; colorClass: string }> = {
  workflow_start:     { icon: Play,       colorClass: "text-info" },
  workflow_end:       { icon: Square,     colorClass: "text-muted-foreground" },
  session_create:     { icon: Plus,       colorClass: "text-muted-foreground" },
  session_close:      { icon: Minus,      colorClass: "text-muted-foreground" },
  browser_launch:     { icon: Monitor,    colorClass: "text-log-violet" },
  browser_close:      { icon: Power,      colorClass: "text-muted-foreground" },
  auth_start:         { icon: KeyRound,   colorClass: "text-warning" },
  auth_complete:      { icon: Check,      colorClass: "text-success" },
  auth_failed:        { icon: X,          colorClass: "text-destructive" },
  duo_request:        { icon: Pause,      colorClass: "text-warning" },
  duo_start:          { icon: KeyRound,   colorClass: "text-warning" },
  duo_complete:       { icon: Check,      colorClass: "text-success" },
  duo_timeout:        { icon: X,          colorClass: "text-destructive" },
  item_start:         { icon: Activity,   colorClass: "text-foreground" },
  item_complete:      { icon: Check,      colorClass: "text-muted-foreground" },
  step_change:        { icon: ArrowRight, colorClass: "text-muted-foreground" },
  screenshot:         { icon: Camera,     colorClass: "text-log-violet" },
  idle_signal:        { icon: Hourglass,  colorClass: "text-success" },
  daemon_phase:       { icon: Activity,   colorClass: "text-log-slate" },
};

// Fallback for any event type the backend ships before the frontend registers
// it — must not crash the LogPanel. Backend session-event types are a moving
// target, and a runtime undefined-lookup unmounts the whole tree because
// EventLine has no error boundary above it.
const UNKNOWN_EVENT_VISUAL: { icon: LucideIcon; colorClass: string } = { icon: Dot, colorClass: "text-muted-foreground" };

function EventLine({ event }: { event: RunEvent }) {
  const v = EVENT_VISUAL[event.type] ?? UNKNOWN_EVENT_VISUAL;
  const Icon = v.icon;
  // Match LogLine's timestamp format + column geometry so Events + regular
  // log lines line up vertically in the stream (same px-6, min-w-[72px],
  // 14px icon, gap-3.5, font-mono text-[13px]).
  const eventDate = resolveRunEventTimestamp(event);
  const time = Number.isNaN(eventDate.getTime())
    ? "—"
    : eventDate.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
  const detail = event.system ?? event.step ?? event.currentStep ?? event.currentItemId ?? "";
  const label = event.type === "screenshot"
    ? [
        "screenshot",
        event.screenshotKind,
        event.screenshotLabel,
        event.screenshotFileCount != null ? `${event.screenshotFileCount}p` : null,
      ].filter(Boolean).join(" — ")
    : event.type;
  const suffix = event.type !== "screenshot" && detail ? ` ${detail}` : "";
  return (
    <div className="flex items-start gap-3.5 px-6 py-[3px] font-mono text-[13px] leading-relaxed">
      <span className="text-muted-foreground text-xs whitespace-nowrap min-w-[72px] mt-[3px]">{time}</span>
      <Icon className={cn("w-[14px] h-[14px] shrink-0 mt-[3px]", v.colorClass)} aria-hidden />
      <span className="flex-1 min-w-0 break-words text-secondary-foreground">
        <span className={v.colorClass}>{label}</span>
        {suffix && <span className="text-muted-foreground">{suffix}</span>}
      </span>
    </div>
  );
}
