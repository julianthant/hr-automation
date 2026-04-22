import { useState, useMemo, useEffect } from "react";
import { Search, Inbox, X, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { StatPills } from "./StatPills";
import { EntryItem } from "./EntryItem";
import { EmptyState } from "./EmptyState";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "./types";
import { resolveEntryName } from "./entry-display";

interface QueuePanelProps {
  entries: TrackerEntry[];
  workflow: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
}

/**
 * Row returned by `GET /api/sharepoint-download/list`. Mirrors
 * `SharePointDownloadListItem` in `src/workflows/sharepoint-download/handler.ts`.
 * Duplicated here (not imported) because the dashboard SPA is bundled
 * separately from the backend and there's no shared types package.
 */
interface SharePointDownloadOption {
  id: string;
  label: string;
  description?: string;
  envVar: string;
  configured: boolean;
}

/**
 * QueuePanel
 *  - Header card (one cohesive unit, no internal divider): search input on
 *    top, status filter strip below.
 *  - Entry-count divider row: "N entries" — visually matches the LogPanel's
 *    StepPipeline row across the gap so horizontal dividers align.
 *  - Scrollable entry list.
 *
 * Header height is sized to make its bottom border land at the same Y as the
 * LogPanel's StepPipeline border on the right, so the two halves of the
 * dashboard read as one continuous grid.
 */
export function QueuePanel({ entries, workflow, selectedId, onSelect, loading }: QueuePanelProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [options, setOptions] = useState<SharePointDownloadOption[] | null>(null);

  // Fetch the SharePoint-download registry once on mount. Small payload; no
  // need to defer to dropdown open — we want the registry cached before the
  // user clicks so the menu renders instantly.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/sharepoint-download/list")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((list: SharePointDownloadOption[]) => {
        if (!cancelled) setOptions(list);
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleDownload(option: SharePointDownloadOption) {
    if (downloadingId) return;
    if (!option.configured) {
      toast.warning(`${option.label} not configured`, {
        description: `Set ${option.envVar} in .env and restart the dashboard.`,
      });
      return;
    }
    setDownloadingId(option.id);
    const pending = toast.loading(`Downloading ${option.label}…`, {
      description: "Approve Duo on your phone when prompted.",
    });
    try {
      const res = await fetch("/api/sharepoint-download/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: option.id }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        path?: string;
        filename?: string;
        error?: string;
      };
      toast.dismiss(pending);
      if (res.ok && body.ok) {
        toast.success(`${option.label} downloaded`, {
          description: body.path ?? body.filename ?? "Saved to src/data/",
          duration: 6000,
        });
      } else if (res.status === 409) {
        toast.warning("Already downloading", {
          description:
            body.error ?? "A SharePoint download is already in progress.",
        });
      } else {
        toast.error(`${option.label} download failed`, {
          description: body.error ?? `HTTP ${res.status}`,
          duration: 8000,
        });
      }
    } catch (err) {
      toast.dismiss(pending);
      toast.error(`${option.label} download failed`, {
        description:
          err instanceof Error ? err.message : "Network error contacting the dashboard backend.",
      });
    } finally {
      setDownloadingId(null);
    }
  }

  const downloading = Boolean(downloadingId);
  const hasOptions = options && options.length > 0;

  const filtered = useMemo(() => {
    let result = entries;
    if (statusFilter) {
      result = result.filter((e) =>
        statusFilter === "pending" ? e.status === "pending" || e.status === "skipped" : e.status === statusFilter,
      );
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((e) => {
        const name = resolveEntryName(e).toLowerCase();
        return e.id.toLowerCase().includes(q) || name.includes(q);
      });
    }
    return result;
  }, [entries, statusFilter, search]);

  return (
    <div className="w-[320px] min-[1440px]:w-[400px] 2xl:w-[480px] flex-shrink-0 border-r border-border flex flex-col bg-background">
      {/* ── Search row — h-[60px] matches the LogPanel header height across
            the gap so the first horizontal divider aligns. A "download from
            SharePoint" dropdown sits to the right of the search input —
            always visible; each menu item is a registered spreadsheet (see
            src/workflows/sharepoint-download/registry.ts). The button is
            workflow-agnostic — downloads land in src/data/ regardless of
            which queue the operator is looking at. ── */}
      <div className="h-[60px] flex items-center gap-2 px-3 min-[1440px]:px-4 border-b border-border bg-card flex-shrink-0">
        <div className="flex items-center gap-2 bg-secondary border border-border rounded-lg px-3 py-2 flex-1 min-w-0 focus-within:border-primary transition-colors">
          <Search aria-hidden className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          <input
            type="text"
            placeholder="Search by name, email, or ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search queue"
            className="flex-1 bg-transparent border-none outline-none text-foreground text-sm font-sans placeholder:text-muted-foreground min-w-0"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Download a SharePoint spreadsheet"
            title="Download a SharePoint spreadsheet"
            disabled={downloading || !hasOptions}
            className={cn(
              "flex-shrink-0 h-9 w-9 flex items-center justify-center rounded-lg bg-secondary border border-border text-muted-foreground transition-colors outline-none",
              "hover:text-foreground hover:bg-accent hover:border-primary",
              "data-[state=open]:text-foreground data-[state=open]:bg-accent data-[state=open]:border-primary",
              "focus-visible:ring-2 focus-visible:ring-primary",
              "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
            )}
          >
            {downloading ? (
              <Loader2 aria-hidden className="w-4 h-4 animate-spin" />
            ) : (
              <Download aria-hidden className="w-4 h-4" />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-0 w-auto">
            {!options ? (
              <div className="px-3 py-2 text-[12px] text-muted-foreground">Loading…</div>
            ) : options.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-muted-foreground">
                No downloads registered.
              </div>
            ) : (
              options.map((opt) => {
                const isRunning = downloadingId === opt.id;
                const disabled = downloading || !opt.configured;
                return (
                  <DropdownMenuItem
                    key={opt.id}
                    disabled={disabled}
                    onSelect={(event) => {
                      event.preventDefault();
                      handleDownload(opt);
                    }}
                    className={cn(
                      "justify-between gap-2 cursor-pointer",
                      !opt.configured && "opacity-60",
                    )}
                    title={
                      !opt.configured
                        ? `Set ${opt.envVar} in .env to enable`
                        : undefined
                    }
                  >
                    <span className="font-medium text-[13px]">{opt.label}</span>
                    {isRunning ? (
                      <Loader2 aria-hidden className="w-3.5 h-3.5 animate-spin text-primary" />
                    ) : !opt.configured ? (
                      <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">
                        unset
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* ── Status filter strip — h-[69.5px] makes the section's bottom
            border land exactly at the LogPanel's email-row border across
            the column gap (search 60 + pills 69.5 = panel-top + 129.5). ── */}
      <div className="h-[69.5px] flex items-center px-3 min-[1440px]:px-4 py-2 border-b border-border bg-card/60 flex-shrink-0">
        <StatPills entries={entries} activeFilter={statusFilter} onFilter={setStatusFilter} />
      </div>

      {/* ── Entry list ── */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-0">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="px-5 py-3.5 border-b border-border">
                <div className="flex justify-between mb-2">
                  <div className="h-4 w-32 rounded bg-muted animate-pulse" />
                  <div className="h-4 w-16 rounded bg-muted animate-pulse" />
                </div>
                <div className="h-3 w-48 rounded bg-muted animate-pulse mt-1" />
                <div className="h-3 w-24 rounded bg-muted animate-pulse mt-2" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No entries yet"
            description="Data will appear here as workflows run"
          />
        ) : (
          filtered.map((entry) => (
            <EntryItem
              key={entry.id}
              entry={entry}
              selected={selectedId === entry.id}
              onClick={() => onSelect(entry.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
