import { useEffect, useRef, useState } from "react";
import { Search, Loader2, X } from "lucide-react";
import { SearchResults } from "./SearchResults";
import type { SearchResultRow } from "./types";

interface SearchBarProps {
  /**
   * Fired when the operator picks a result. The parent navigates the
   * dashboard to the target (workflow, date, id) combo.
   */
  onSelect: (row: SearchResultRow) => void;
}

/**
 * Debounced cross-workflow search box. Hits `/api/search` 300ms after typing
 * stops (or immediately on Enter). Results render in a popover panel docked
 * to the input — clicking a row closes the panel and fires `onSelect`.
 *
 * The component matches the dashboard's existing search-input treatment
 * (IBM Plex Sans, bg-input, rounded-lg, muted icons) rather than the runner's
 * amber HUD styling — search is a dashboard chrome primitive, not a runner
 * affordance.
 */
export function SearchBar({ onSelect }: SearchBarProps) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SearchResultRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the most recent in-flight request — stale responses get discarded.
  const reqIdRef = useRef(0);

  // Run the actual fetch. Sequenced via reqIdRef so out-of-order responses
  // can't clobber a newer result set.
  const runSearch = (query: string) => {
    const id = ++reqIdRef.current;
    if (!query.trim()) {
      setRows(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch(`/api/search?q=${encodeURIComponent(query)}&limit=10`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: SearchResultRow[]) => {
        if (id !== reqIdRef.current) return; // a newer search has kicked off
        setRows(Array.isArray(data) ? data : []);
        setLoading(false);
        setOpen(true);
      })
      .catch(() => {
        if (id !== reqIdRef.current) return;
        setRows([]);
        setLoading(false);
        setOpen(true);
      });
  };

  // Debounce typing. Enter bypasses the debounce.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(q), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape — matches the rest of the dashboard's keyboard idiom.
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    } else if (e.key === "Enter") {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      runSearch(q);
    }
  };

  const handlePick = (row: SearchResultRow) => {
    setOpen(false);
    setQ("");
    setRows(null);
    onSelect(row);
  };

  const clearQuery = () => {
    setQ("");
    setRows(null);
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div ref={boxRef} className="relative">
      <div
        className="flex items-center gap-2 bg-secondary border border-border rounded-lg px-3 py-1.5 w-full focus-within:border-primary transition-colors"
      >
        <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search history (email, emplId, docId, name)..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => rows && setOpen(true)}
          onKeyDown={onKey}
          className="flex-1 bg-transparent border-none outline-none text-foreground text-xs font-sans placeholder:text-muted-foreground min-w-0"
        />
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin flex-shrink-0" />
        ) : q ? (
          <button
            type="button"
            onClick={clearQuery}
            className="flex-shrink-0 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors p-0.5"
            aria-label="Clear search"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : null}
      </div>
      {open && rows && (
        <SearchResults rows={rows} onPick={handlePick} query={q} />
      )}
    </div>
  );
}
