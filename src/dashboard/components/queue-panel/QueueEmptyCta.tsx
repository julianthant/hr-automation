import { useState } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { RunModal } from "@/components/run-modal/RunModal";
import { SharePointDownloadButton } from "@/components/run-modal/SharePointDownloadButton";
import { isRunModalEnabled } from "@/lib/run-modal-registry";
import { getInputRunConfig } from "@/lib/input-run-registry";

/**
 * Call-to-action for the queue empty state. Starts are dashboard-only, so a
 * dead-end empty panel makes the operator hunt for the launcher — this puts the
 * relevant action right where they're looking:
 *   - upload workflows (RunModal-enabled) get an "Upload PDF" button that opens
 *     the same RunModal as the top-bar launcher;
 *   - input-run workflows already have the InputRunPanel bar in the footer, so
 *     this just points the operator down to it;
 *   - `sharepoint-download` starts from neither (its input is a URL the backend
 *     resolves from `.env`), so it gets the spreadsheet picker itself;
 *   - anything else renders nothing.
 */
export function QueueEmptyCta({ workflow }: { workflow: string }) {
  const [open, setOpen] = useState(false);

  if (workflow === "sharepoint-download") {
    return (
      <div className="flex flex-col items-center gap-2">
        <SharePointDownloadButton variant="labeled" />
        <p className="text-xs text-muted-foreground">
          Downloads land in the roster folder every roster-backed run reads.
        </p>
      </div>
    );
  }

  if (isRunModalEnabled(workflow)) {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-[13px] font-medium",
            "bg-primary text-primary-foreground border border-primary",
            "hover:bg-primary/90 hover:border-primary/90",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
            "transition-colors cursor-pointer",
          )}
        >
          <Upload aria-hidden className="h-3.5 w-3.5" />
          Upload PDF
        </button>
        <RunModal open={open} onOpenChange={setOpen} workflow={workflow} />
      </>
    );
  }

  if (getInputRunConfig(workflow)) {
    return (
      <p className="text-xs text-muted-foreground">
        Type IDs or names in the bar below to start a run.
      </p>
    );
  }

  return null;
}
