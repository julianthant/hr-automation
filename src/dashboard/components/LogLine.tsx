import { cn } from "@/lib/utils";
import {
  Pencil, MousePointer, ArrowDownToLine, Search, ListFilter,
  KeyRound, Download, Check, X, Hourglass, ArrowRight,
} from "lucide-react";
import type { LogCategory, RunEvent } from "./types";
import { getLogCategory } from "./types";
import type { CollapsedLogEntry } from "./hooks/useLogs";

const ICON_MAP: Record<LogCategory, { icon: typeof Check; color: string }> = {
  fill: { icon: Pencil, color: "text-cyan-400" },
  navigate: { icon: MousePointer, color: "text-slate-400" },
  extract: { icon: ArrowDownToLine, color: "text-amber-400" },
  search: { icon: Search, color: "text-blue-400" },
  select: { icon: ListFilter, color: "text-teal-400" },
  auth: { icon: KeyRound, color: "text-purple-400" },
  download: { icon: Download, color: "text-green-400" },
  success: { icon: Check, color: "text-[#4ade80]" },
  error: { icon: X, color: "text-destructive" },
  waiting: { icon: Hourglass, color: "text-[#fbbf24]" },
  step: { icon: ArrowRight, color: "text-blue-400" },
};

type LogLineEntry =
  | (CollapsedLogEntry & { kind?: "log" })
  | (RunEvent & { kind: "event"; count?: number });

interface LogLineProps {
  entry: LogLineEntry;
  isCurrent: boolean;
  onCopy: (text: string) => void;
}

export function LogLine({ entry, isCurrent, onCopy }: LogLineProps) {
  if (entry.kind === "event") {
    return <EventLine event={entry} />;
  }
  const category = getLogCategory(entry.level, entry.message);
  const { icon: Icon, color } = ICON_MAP[category];
  const ts = entry.ts
    ? new Date(entry.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "";

  return (
    <div
      className={cn(
        "group flex items-center gap-3.5 px-6 py-[3px] font-mono text-[13px] leading-relaxed cursor-pointer relative",
        "transition-colors hover:bg-foreground/[0.02]",
        isCurrent && "bg-primary/[0.05]",
      )}
      onClick={() => onCopy(`${ts} ${entry.message}`)}
    >
      <span className="text-muted-foreground text-xs whitespace-nowrap min-w-[72px]">{ts}</span>
      <Icon className={cn("w-[14px] h-[14px] flex-shrink-0", color)} />
      <span className={cn(
        "flex-1 break-words",
        category === "success" && "text-[#4ade80]",
        category === "error" && "text-destructive",
        isCurrent && "text-primary",
        category !== "success" && category !== "error" && !isCurrent && "text-secondary-foreground",
      )}>
        {entry.message}
      </span>
      {entry.count > 1 && (
        <span className="text-[11px] bg-accent text-accent-foreground px-1.5 py-px rounded font-semibold flex-shrink-0">
          x{entry.count}
        </span>
      )}
      <span className="absolute right-6 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity">
        Copy
      </span>
    </div>
  );
}

const EVENT_VISUAL: Record<RunEvent["type"], { glyph: string; color: string }> = {
  workflow_start:   { glyph: "▶", color: "#3b82f6" },
  workflow_end:     { glyph: "■", color: "#6b7280" },
  session_create:   { glyph: "◇", color: "#6b7280" },
  session_close:    { glyph: "◆", color: "#6b7280" },
  browser_launch:   { glyph: "⊞", color: "#8b5cf6" },
  browser_close:    { glyph: "⊟", color: "#6b7280" },
  auth_start:       { glyph: "⏵", color: "#f59e0b" },
  auth_complete:    { glyph: "✓", color: "#10b981" },
  auth_failed:      { glyph: "✗", color: "#ef4444" },
  duo_request:      { glyph: "⏸", color: "#f59e0b" },
  duo_start:        { glyph: "⏵", color: "#f59e0b" },
  duo_complete:     { glyph: "✓", color: "#10b981" },
  duo_timeout:      { glyph: "✗", color: "#ef4444" },
  item_start:       { glyph: "▦", color: "#e5e5e5" },
  item_complete:    { glyph: "▩", color: "#6b7280" },
  step_change:      { glyph: "→", color: "#6b7280" },
  cache_hit:        { glyph: "❄", color: "#3b82f6" },
};

function EventLine({ event }: { event: RunEvent }) {
  const v = EVENT_VISUAL[event.type];
  const time = new Date(event.timestamp).toISOString().slice(11, 19);
  const detail = event.system ?? event.step ?? event.currentStep ?? event.currentItemId ?? "";
  return (
    <div className="grid grid-cols-[72px_22px_1fr_auto] items-center gap-2.5 px-3.5 py-1.5 font-mono text-[11px]">
      <span className="text-muted-foreground">{time}</span>
      <span style={{ color: v.color, fontSize: "14px", textAlign: "center" }}>{v.glyph}</span>
      <span>
        <span style={{ color: v.color }}>{event.type}</span>
        {detail && <span className="text-muted-foreground"> {detail}</span>}
      </span>
      <span />
    </div>
  );
}
