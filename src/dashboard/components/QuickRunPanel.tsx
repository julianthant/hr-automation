import { useState, type FormEvent } from "react";
import { Play, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { getQuickRunConfig } from "@/lib/quick-run-registry";

interface QuickRunPanelProps {
  workflow: string;
}

/**
 * QuickRunPanel — the text-box-plus-Run-button row above the QueuePanel's
 * search bar. Visible only for workflows registered in
 * `src/dashboard/lib/quick-run-registry.ts`; returns null otherwise so the
 * parent's layout stays clean for workflows that don't support quick
 * enqueue (e.g. emergency-contact, which needs YAML input).
 *
 * On submit: parses the text into typed inputs via the registry, POSTs
 * `/api/enqueue`, shows a sonner toast with the result. If no daemon is
 * alive for the target workflow, the backend spawns one — the operator
 * will see a Duo prompt in the freshly-launched browser.
 */
export function QuickRunPanel({ workflow }: QuickRunPanelProps) {
  const config = getQuickRunConfig(workflow);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!config) return null;

  async function submit() {
    if (submitting) return;
    if (!config) return;
    const parsed = config.parseInput(value);
    if (!parsed.ok) {
      toast.error("Can't enqueue", { description: parsed.error });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, inputs: parsed.inputs }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        enqueued?: number;
        error?: string;
      };
      if (res.status === 202 && body.ok) {
        const n = body.enqueued ?? parsed.inputs.length;
        toast.success(`Queued ${n} ${n === 1 ? "item" : "items"} for ${workflow}`, {
          description:
            "If no daemon was alive, a new one is spawning — approve Duo in the new browser window.",
          duration: 6000,
        });
        setValue("");
      } else {
        toast.error("Enqueue failed", {
          description: body.error ?? `HTTP ${res.status}`,
          duration: 8000,
        });
      }
    } catch (err) {
      toast.error("Enqueue failed", {
        description: err instanceof Error ? err.message : "Network error contacting the dashboard backend.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  const disabled = submitting || value.trim().length === 0;

  return (
    <form
      onSubmit={onSubmit}
      className="h-[60px] flex items-center gap-2 px-3 min-[1440px]:px-4 border-b border-border bg-card flex-shrink-0"
    >
      <div
        className={cn(
          "flex items-center gap-2 bg-secondary border border-border rounded-lg px-3 py-2 flex-1 min-w-0 transition-colors",
          submitting ? "opacity-60" : "focus-within:border-primary",
        )}
      >
        <input
          type="text"
          placeholder={config.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={submitting}
          aria-label={`Enqueue ${workflow}`}
          className="flex-1 bg-transparent border-none outline-none text-foreground text-sm font-sans placeholder:text-muted-foreground min-w-0 disabled:cursor-not-allowed"
        />
      </div>
      <button
        type="submit"
        disabled={disabled}
        aria-label={`Run ${workflow}`}
        title={`Enqueue ${workflow} items`}
        className={cn(
          "flex-shrink-0 h-9 flex items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors outline-none",
          "bg-primary text-primary-foreground border border-primary",
          "hover:bg-primary/90 hover:border-primary/90",
          "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card",
          "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
        )}
      >
        {submitting ? (
          <Loader2 aria-hidden className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Play aria-hidden className="w-3.5 h-3.5" />
        )}
        <span>Run</span>
      </button>
    </form>
  );
}
