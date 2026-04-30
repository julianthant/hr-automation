import { useState } from "react";
import { Cpu, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Digital-mode oath signature kickoff. Opens a dialog with a textarea;
 * the operator pastes one EID per line, clicks Enqueue, and the
 * backend hits CRM (1 Duo) + the oath-signature daemon (1 more Duo,
 * if no daemon is alive yet).
 *
 * As of 2026-04-29 (P4.1) digital mode skips the prep-row pattern —
 * each EID becomes a child kernel queue row immediately, no review
 * pane involved. Mismatched / not-found EIDs still enqueue without a
 * date so the kernel today-prefills.
 */
export function TopBarDigitalOathButton() {
  const [open, setOpen] = useState(false);
  const [eidsRaw, setEidsRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(): Promise<void> {
    const emplIds = eidsRaw
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{5,}$/.test(s));
    if (emplIds.length === 0) {
      toast.error("Paste at least one valid EID (5+ digits per line)");
      return;
    }
    setSubmitting(true);
    try {
      const resp = await fetch("/api/oath-signature/digital-prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emplIds }),
      });
      const body = (await resp.json()) as {
        ok?: boolean;
        enqueued?: number;
        lookupFailures?: number;
        error?: string;
      };
      if (!resp.ok || body.ok === false) {
        toast.error("Digital lookup failed", {
          description: body.error ?? "Server error",
        });
        return;
      }
      const enqueued = body.enqueued ?? 0;
      const failures = body.lookupFailures ?? 0;
      toast.success(
        `Enqueued ${enqueued} oath signature${enqueued === 1 ? "" : "s"}`,
        {
          description:
            failures > 0
              ? `${failures} CRM lookup${failures === 1 ? "" : "s"} failed (enqueued without a date — kernel will today-prefill)`
              : undefined,
        },
      );
      setOpen(false);
      setEidsRaw("");
    } catch (err) {
      toast.error("Digital lookup failed", {
        description: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            "h-7 inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-3",
            "text-xs font-medium text-foreground hover:bg-muted",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "cursor-pointer",
          )}
          title="Look up oath signature dates from CRM by EID and enqueue"
        >
          <Cpu className="h-3 w-3" aria-hidden />
          Digital
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Digital oath signature lookup</DialogTitle>
          <DialogDescription>
            Paste EIDs (one per line). Each is looked up in CRM onboarding
            history and enqueued as a child oath-signature row. EIDs whose CRM
            history doesn't show "Witness Ceremony Oath New Hire Signed" still
            enqueue — the kernel today-prefills so you can review on the per-EID
            detail page.
          </DialogDescription>
        </DialogHeader>
        <textarea
          value={eidsRaw}
          onChange={(e) => setEidsRaw(e.target.value)}
          placeholder={"10873611\n10873075"}
          rows={10}
          className={cn(
            "w-full resize-none rounded-md border border-border bg-secondary p-2 font-mono text-sm text-foreground",
            "outline-none focus:border-primary",
          )}
          disabled={submitting}
        />
        <DialogFooter>
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={submitting}
            className={cn(
              "h-8 px-3 inline-flex items-center justify-center rounded-md text-sm font-medium",
              "text-muted-foreground hover:bg-muted hover:text-foreground",
              "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className={cn(
              "h-8 px-3 inline-flex items-center gap-1.5 rounded-md text-sm font-semibold",
              "bg-primary text-primary-foreground border border-primary hover:bg-primary/90",
              "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
            )}
          >
            {submitting && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
            Enqueue
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
