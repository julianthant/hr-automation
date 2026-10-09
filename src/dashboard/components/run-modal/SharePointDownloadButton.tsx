import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "@/lib/notify";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface SharePointDownloadOption {
  id: string;
  label: string;
  description?: string;
  envVar: string;
  configured: boolean;
}

/**
 * Workflow-agnostic SharePoint roster downloader — the ONLY way to start a
 * `sharepoint-download` run from the dashboard (the workflow takes a URL the
 * backend resolves from `.env`, so it has neither a typed input-run box nor a
 * file-upload modal). Two slots, both hitting
 * `/api/sharepoint-download/{list,run}`:
 *
 *   - `icon` (default) — the TopBar utility cluster: always reachable, whatever
 *     workflow is selected, because every roster-backed run reads whatever this
 *     leaves behind.
 *   - `labeled` — the SharePoint Download panel's own empty state, where an
 *     icon-only control in a different part of the screen is not an answer to
 *     "how do I run this?".
 *
 * Mounted 2026-09-16. Before that this component had ZERO importers: the
 * workflow existed, its endpoints worked, and nothing in the dashboard could
 * start it (operator: "the sharepoint download have no run modal to download
 * the onboarding roster").
 */
export function SharePointDownloadButton({
  size = "h-8 w-8",
  variant = "icon",
}: {
  size?: string;
  variant?: "icon" | "labeled";
}) {
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
        status?: "launched" | "queued";
        error?: string;
      };
      if (res.status === 202 && body.ok) {
        toast.success(
          body.status === "queued"
            ? `${option.label} download queued`
            : `${option.label} download started`,
          {
          description:
            body.status === "queued"
              ? "It will start after the current SharePoint download finishes."
              : "Approve Duo on your phone. Watch progress in the Sessions panel.",
          duration: 6000,
          },
        );
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

  const labeled = variant === "labeled";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Download a SharePoint spreadsheet"
        title="Download a SharePoint spreadsheet"
        disabled={downloading || !hasOptions}
        className={cn(
          "shrink-0 flex items-center justify-center rounded-lg transition-colors outline-none",
          "focus-visible:ring-2 focus-visible:ring-primary",
          "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
          labeled
            ? [
                "h-9 gap-2 px-3.5 text-[13px] font-medium",
                "bg-primary text-primary-foreground border border-primary",
                "hover:bg-primary/90 hover:border-primary/90",
              ]
            : [
                size,
                "bg-secondary border border-border text-muted-foreground",
                "hover:text-foreground hover:bg-accent hover:border-primary",
                "data-[state=open]:text-foreground data-[state=open]:bg-accent data-[state=open]:border-primary",
              ],
        )}
      >
        {downloading ? (
          <Loader2 aria-hidden className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" />
        ) : (
          <Download aria-hidden className="w-3.5 h-3.5" />
        )}
        {labeled ? "Download spreadsheet" : null}
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
                  void handleDownload(opt);
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
                  <Loader2 aria-hidden className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none text-primary" />
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
