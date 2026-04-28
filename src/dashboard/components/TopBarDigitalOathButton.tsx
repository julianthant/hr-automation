import { useState } from "react";
import { Database, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * "Digital lookup" CTA in the TopBar. Opens a small modal where the
 * operator pastes a list of EIDs (one per line). Calls
 * /api/oath-signature/digital-prepare which spawns a CRM session
 * (1 Duo) and pulls the oath-signature date from each EID's
 * "Show Onboarding History" page in CRM. The resulting prep row
 * renders in the QueuePanel via OathPreviewRow, same as paper mode.
 */
export function TopBarDigitalOathButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Digital oath lookup from CRM"
        title="Look up oath dates in CRM by EID"
        className={cn(
          "h-8 px-3 inline-flex items-center gap-1.5 rounded-lg",
          "text-sm font-medium",
          "bg-secondary text-foreground border border-border",
          "hover:bg-accent",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
          "transition-colors cursor-pointer",
        )}
      >
        <Database aria-hidden className="h-3.5 w-3.5" />
        <span>Digital</span>
      </button>
      <DigitalOathModal open={open} onOpenChange={setOpen} />
    </>
  );
}

function DigitalOathModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eids = parseEids(text);

  async function submit() {
    if (eids.length === 0 || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const resp = await fetch("/api/oath-signature/digital-prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emplIds: eids }),
      });
      const body = (await resp.json()) as { ok: boolean; parentRunId?: string; error?: string };
      if (!resp.ok || !body.ok) {
        setError(body.error ?? "Server error");
        setSubmitting(false);
        return;
      }
      toast.success("Digital lookup started", {
        description: `Looking up ${eids.length} EID${eids.length === 1 ? "" : "s"} in CRM (Duo on phone)`,
      });
      setText("");
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" aria-hidden />
            Digital oath lookup
          </DialogTitle>
          <DialogDescription>
            Paste EIDs (one per line). A CRM browser opens, you approve a Duo,
            and the workflow pulls each EID&apos;s
            <em> Witness Ceremony Oath New Hire Signed</em> date. The preview
            row renders in the queue when ready — review, edit, approve.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="10873611&#10;10873075&#10;..."
            spellCheck={false}
            className={cn(
              "h-40 w-full resize-none rounded-md border border-border bg-background p-2",
              "font-mono text-sm outline-none focus:border-primary",
            )}
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {eids.length === 0
                ? "Paste one EID per line"
                : `${eids.length} valid EID${eids.length === 1 ? "" : "s"}`}
            </span>
            {error && <span className="text-destructive">{error}</span>}
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className={cn(
              "h-9 rounded-md border border-border px-3 text-sm",
              "hover:bg-accent transition-colors disabled:opacity-50",
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || eids.length === 0}
            className={cn(
              "h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground",
              "border border-primary inline-flex items-center gap-1.5",
              "hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            {submitting && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
            Start lookup
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Pull `\d{5,}` lines from the textarea. Tolerates whitespace, commas,
 * and stray non-numeric characters (e.g. an EID followed by a name) —
 * we just match the first 5+ digit run on each line. Deduplicates.
 */
function parseEids(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/[\n,]/)) {
    const m = line.match(/\b(\d{5,})\b/);
    if (!m) continue;
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}
