import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shape of each row returned by `GET /api/selector-warnings`. Mirrored from
 * `SelectorWarningRow` on the backend so the frontend can render without a
 * shared types package.
 */
export interface SelectorWarningRow {
  label: string;
  count: number;
  firstTs: string;
  lastTs: string;
  workflows: string[];
}

interface Props {
  /** Window in days to fetch. Defaults to 7. */
  days?: number;
  /** Polling interval in ms. Defaults to 30_000 (30s) — this isn't hot data. */
  pollIntervalMs?: number;
}

function relativeTime(iso: string): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

/**
 * "Selector Health" panel — shows selector-fallback warnings scanned from
 * log JSONL across the last N days. When primary selectors start losing to
 * fallbacks repeatedly, this panel surfaces the drift BEFORE the primary
 * fully rots. Collapsible so it doesn't steal vertical space when quiet.
 */
export function SelectorWarningsPanel({ days = 7, pollIntervalMs = 30_000 }: Props) {
  const [rows, setRows] = useState<SelectorWarningRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchRows = async () => {
      try {
        const res = await fetch(`/api/selector-warnings?days=${days}`);
        if (!res.ok) return;
        const data = (await res.json()) as SelectorWarningRow[];
        if (!cancelled) {
          setRows(data);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };
    fetchRows();
    const interval = setInterval(fetchRows, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [days, pollIntervalMs]);

  const count = rows.length;
  const hasWarnings = count > 0;

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "w-full px-3 py-2 flex items-center justify-between gap-2 text-[11px] uppercase tracking-wider font-semibold",
          hasWarnings ? "text-[#fbbf24]" : "text-muted-foreground",
          "hover:bg-muted/40 transition-colors",
        )}
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" />
          Selector Health
          {hasWarnings && (
            <span className="ml-1 inline-flex items-center justify-center min-w-[16px] h-4 rounded-full bg-[#fbbf24]/20 text-[#fbbf24] text-[10px] font-mono px-1">
              {count}
            </span>
          )}
        </span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
      </button>
      {expanded && (
        <div className="px-2 pb-2">
          {loading ? (
            <div className="text-[11px] text-muted-foreground px-1.5 py-1">Loading…</div>
          ) : !hasWarnings ? (
            <div className="text-[11px] text-muted-foreground px-1.5 py-1">
              No selector fallback warnings in the last {days} days. Primary selectors
              are stable.
            </div>
          ) : (
            <table className="w-full text-[11px] font-mono">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="text-left px-1.5 py-1 font-normal">Selector</th>
                  <th className="text-right px-1 py-1 font-normal w-10">#</th>
                  <th className="text-left px-1.5 py-1 font-normal">Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.label}
                    className="border-t border-border/50"
                    title={`Workflows: ${r.workflows.join(", ") || "unknown"}`}
                  >
                    <td className="px-1.5 py-1 truncate max-w-[140px]" title={r.label}>
                      {r.label}
                    </td>
                    <td className="px-1 py-1 text-right text-[#fbbf24]">{r.count}</td>
                    <td className="px-1.5 py-1 text-muted-foreground">
                      {relativeTime(r.lastTs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
