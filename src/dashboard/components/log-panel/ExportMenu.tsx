import { Download } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { TrackerEntry, RunEvent } from "@/components/shared/types";
import type { CollapsedLogEntry } from "@/components/hooks/useLogs";

interface ExportMenuProps {
  entry: TrackerEntry;
  logs: CollapsedLogEntry[];
  events: RunEvent[];
  workflow: string;
  runId: string | null;
  date: string;
}

function downloadFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Footer export menu — pulls the selected run's already-streamed logs + events
 * out as a .txt / .json file, or copies its trace id. Purely client-side; no
 * backend call.
 */
export function ExportMenu({ entry, logs, events, workflow, runId, date }: ExportMenuProps) {
  const data = entry.data as Record<string, unknown> | undefined;
  const traceId = typeof data?.__traceId === "string" ? data.__traceId : undefined;
  const slug = (traceId || runId || entry.id || "run").replace(/[^a-z0-9_-]/gi, "_");
  const base = `${workflow}-${slug}`;

  const exportLogs = () => {
    const text = logs
      .map((l) => {
        const ts = l.ts
          ? new Date(l.ts).toLocaleTimeString("en-US", { hour12: false })
          : "";
        return `${ts}  ${l.message}`;
      })
      .join("\n");
    downloadFile(`${base}-logs.txt`, text || "(no log lines)", "text/plain");
    toast.success("Logs exported", { description: `${base}-logs.txt` });
  };

  const exportRun = () => {
    const payload = {
      workflow,
      date,
      id: entry.id,
      runId,
      traceId,
      status: entry.status,
      step: entry.step,
      error: entry.error,
      data: entry.data,
      logs,
      events,
    };
    downloadFile(`${base}.json`, JSON.stringify(payload, null, 2), "application/json");
    toast.success("Run exported", { description: `${base}.json` });
  };

  const copyTrace = () => {
    if (!traceId) {
      toast.message("No trace id for this run");
      return;
    }
    void navigator.clipboard.writeText(traceId);
    toast.success("Trace id copied", { description: traceId });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        aria-label="Export this run"
        title="Export logs / run"
        className={cn(
          "h-8 w-8 inline-flex items-center justify-center rounded-md border cursor-pointer transition-colors outline-none",
          "bg-secondary text-muted-foreground border-border hover:text-foreground hover:border-border/80",
          "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card",
          "data-[state=open]:bg-accent data-[state=open]:text-foreground",
        )}
      >
        <Download className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[10rem]">
        <DropdownMenuItem onClick={exportLogs}>Logs (.txt)</DropdownMenuItem>
        <DropdownMenuItem onClick={exportRun}>Run (.json)</DropdownMenuItem>
        <DropdownMenuItem onClick={copyTrace}>Copy trace id</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
