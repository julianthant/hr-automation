import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface SharePointDownloadOption {
  id: string;
  label: string;
  description?: string;
  envVar: string;
  configured: boolean;
}

/**
 * Workflow-agnostic SharePoint roster downloader. Renders an icon button
 * that opens a dropdown of registered spreadsheets. Used in two slots:
 * the TopBar quick-run cluster (mounted via QuickRunPanel) and the
 * QueuePanel header search row. Both copies hit the same
 * `/api/sharepoint-download/{list,run}` endpoints.
 */
export function SharePointDownloadButton({ size = "h-8 w-8" }: { size?: string }) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [options, setOptions] = useState<SharePointDownloadOption[] | null>(null);

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
        description: `Set ${option.envVar} in .env and restart the dashboard`,
      });
      return;
    }
    setDownloadingId(option.id);
    try {
      const res = await fetch("/api/sharepoint-download/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: option.id }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: "launched";
        error?: string;
      };
      if (res.status === 202 && body.ok) {
        toast.success(`${option.label} download started`, {
          description:
            "Approve Duo on your phone. Watch progress in the Sessions panel.",
          duration: 6000,
        });
      } else if (res.status === 409) {
        toast.warning("Download already in progress", {
          description:
            body.error ?? "A download is already running. Wait for it to finish.",
        });
      } else {
        toast.error(`${option.label} couldn't start`, {
          description: body.error ?? `HTTP ${res.status}`,
          duration: 8000,
        });
      }
    } catch (err) {
      toast.error(`${option.label} couldn't start`, {
        description:
          err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDownloadingId(null);
    }
  }

  const downloading = Boolean(downloadingId);
  const hasOptions = options && options.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Download a SharePoint spreadsheet"
        title="Download a SharePoint spreadsheet"
        disabled={downloading || !hasOptions}
        className={cn(
          "flex-shrink-0 flex items-center justify-center rounded-lg bg-secondary border border-border text-muted-foreground transition-colors outline-none",
          size,
          "hover:text-foreground hover:bg-accent hover:border-primary",
          "data-[state=open]:text-foreground data-[state=open]:bg-accent data-[state=open]:border-primary",
          "focus-visible:ring-2 focus-visible:ring-primary",
          "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
        )}
      >
        {downloading ? (
          <Loader2 aria-hidden className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Download aria-hidden className="w-3.5 h-3.5" />
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
  );
}
