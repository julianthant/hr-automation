import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchResults } from "../SearchResults";
import type { SearchResultRow } from "../types";
import { COMMANDS, parseCommand, type CommandRunCtx } from "./commands";

const HISTORY_FETCH_DELAY_MS = 250;

export interface CommandPaletteProps {
  open: boolean;
  setOpen: (next: boolean) => void;
  onSelect: (row: SearchResultRow) => void;
  ctx: CommandRunCtx;
}

/**
 * Replaces the legacy SearchBar in TopBar. Three result tracks:
 *   - Commands (`> spawn 2 separations`, `> goto onboarding`, …)
 *   - History (existing /api/search dropdown)
 *   - (Workflow / date jumps surface as command suggestions for now.)
 *
 * ⌘K opens; Esc closes; ↑/↓ navigates; Enter triggers; click also triggers.
 */
export function CommandPalette({ open, setOpen, onSelect, ctx }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [historyRows, setHistoryRows] = useState<SearchResultRow[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus input when opened. Reset query when closed.
  useEffect(() => {
    if (open) inputRef.current?.focus();
    if (!open) setQuery("");
  }, [open]);

  // History fetch (debounced, only when query is non-command-mode).
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || trimmed.startsWith(">")) {
      setHistoryRows([]);
      return;
    }
    const id = setTimeout(() => {
      void fetch(`/api/search?q=${encodeURIComponent(trimmed)}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: SearchResultRow[]) => setHistoryRows(rows))
        .catch(() => setHistoryRows([]));
    }, HISTORY_FETCH_DELAY_MS);
    return () => clearTimeout(id);
  }, [query]);

  // Command suggestions for the current query.
  const cmdSuggestions = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed.startsWith(">")) return [];
    const parsed = parseCommand(trimmed);
    if (parsed) {
      return [{ kind: "ready" as const, cmd: parsed.cmd, args: parsed.args, raw: trimmed }];
    }
    // Otherwise list all commands that share the typed prefix.
    const stripped = trimmed.slice(1).trim().toLowerCase();
    return COMMANDS.filter((c) => c.token.startsWith(stripped) || stripped === "").map(
      (cmd) => ({ kind: "hint" as const, cmd, args: {}, raw: trimmed }),
    );
  }, [query]);

  const totalRows = cmdSuggestions.length + historyRows.length;

  // Reset activeIndex when results change.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, Math.max(0, totalRows - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (cmdSuggestions.length > 0 && activeIndex < cmdSuggestions.length) {
          const sug = cmdSuggestions[activeIndex];
          if (sug.kind === "ready") {
            void sug.cmd.run(sug.args, ctx).then((result) => {
              if (result.ok) {
                setOpen(false);
                setQuery("");
              }
            });
          }
          if (sug.kind === "hint") {
            setQuery(`> ${sug.cmd.token} `);
          }
        } else if (historyRows.length > 0) {
          const idx = activeIndex - cmdSuggestions.length;
          if (idx >= 0 && idx < historyRows.length) {
            onSelect(historyRows[idx]);
            setOpen(false);
            setQuery("");
          }
        }
      }
    },
    [activeIndex, totalRows, cmdSuggestions, historyRows, ctx, onSelect, setOpen],
  );

  return (
    <div className="relative w-[480px] max-w-full">
      <div
        className={cn(
          "h-8 flex items-center gap-2 px-3 rounded-lg border",
          "bg-secondary border-border",
          "focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20",
        )}
      >
        <Search className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search · jump · run command…"
          aria-label="Command palette"
          className={cn(
            "flex-1 bg-transparent outline-none text-sm font-mono",
            "placeholder:text-muted-foreground/60 text-foreground",
          )}
        />
        <kbd
          className={cn(
            "text-[10px] font-mono px-1.5 py-0.5 rounded border border-border",
            "bg-background text-muted-foreground",
          )}
        >
          ⌘K
        </kbd>
      </div>

      {open && (cmdSuggestions.length > 0 || historyRows.length > 0 || query.length > 0) && (
        <div
          className={cn(
            "absolute top-full left-0 right-0 mt-1.5 min-w-[440px]",
            "bg-popover border border-border rounded-lg shadow-md z-50 overflow-hidden",
          )}
        >
          {/* Command section */}
          {cmdSuggestions.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40 border-b border-border">
                Commands
              </div>
              {cmdSuggestions.map((sug, i) => (
                <button
                  key={sug.cmd.token + i}
                  type="button"
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => {
                    if (sug.kind === "ready") {
                      void sug.cmd.run(sug.args, ctx).then((result) => {
                        if (result.ok) {
                          setOpen(false);
                          setQuery("");
                        }
                      });
                    } else {
                      setQuery(`> ${sug.cmd.token} `);
                    }
                  }}
                  className={cn(
                    "w-full text-left px-3.5 py-2.5 cursor-pointer transition-colors",
                    "border-b border-border last:border-b-0 outline-none",
                    activeIndex === i ? "bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-mono text-foreground">
                      &gt; {sug.cmd.token}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {sug.kind === "ready" ? "press Enter" : "incomplete"}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {sug.cmd.description}
                  </div>
                </button>
              ))}
            </div>
          )}
          {/* History section */}
          {historyRows.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40 border-b border-border">
                History
              </div>
              <SearchResults
                rows={historyRows}
                query={query.trim()}
                embedded
                activeRowIndex={activeIndex - cmdSuggestions.length}
                onMouseEnterRow={(i) => setActiveIndex(cmdSuggestions.length + i)}
                onPick={(row) => {
                  onSelect(row);
                  setOpen(false);
                  setQuery("");
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
