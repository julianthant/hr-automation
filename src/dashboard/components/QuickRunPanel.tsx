import { useState, type FormEvent } from "react";
import { Play, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { getQuickRunConfig } from "@/lib/quick-run-registry";
import { RunModal } from "./RunModal";

interface QuickRunPanelProps {
  workflow: string;
}

/**
 * QuickRunPanel — host-agnostic input + run cluster, mounted in the TopBar's
 * queue zone. Contains an input + an icon-only Run button.
 *
 * Visible only for workflows registered in
 * `src/dashboard/lib/quick-run-registry.ts`. Workflows without a quick-run
 * config (e.g. emergency-contact, which needs YAML input) render null so
 * the queue zone in TopBar stays blank for them.
 *
 * On submit: parses the text into typed inputs via the registry, POSTs
 * `/api/enqueue`, shows a sonner toast with the result. If no daemon is
 * alive for the target workflow, the backend spawns one — the operator
 * will see a Duo prompt in the freshly-launched browser.
 *
 * Retry-all is its own component (`RetryAllButton`) mounted independently
 * so it surfaces on every workflow when failed entries exist, not just on
 * workflows with a quick-run config.
 */
export function QuickRunPanel({ workflow }: QuickRunPanelProps) {
  const config = getQuickRunConfig(workflow);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  if (!config) return null;

  async function submit() {
    if (submitting) return;
    if (!config) return;
    if (value.trim().length === 0) {
      if (config.runEmptyAction) {
        setModalOpen(true);
      }
      return;
    }
    const parsed = config.parseInput(value);
    if (!parsed.ok) {
      toast.error("Invalid input", { description: parsed.error });
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
        toast.success(`Added ${n} ${n === 1 ? "item" : "items"} to ${workflow}`, {
          description:
            "If no worker was running, one is starting — approve Duo in the new browser window.",
          duration: 6000,
        });
        setValue("");
      } else {
        toast.error("Couldn't add to queue", {
          description: body.error ?? `HTTP ${res.status}`,
          duration: 8000,
        });
      }
    } catch (err) {
      toast.error("Couldn't add to queue", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  const runDisabled = submitting || (value.trim().length === 0 && !config.runEmptyAction);

  return (
    <form
      onSubmit={onSubmit}
      className="flex items-center gap-2 flex-1 min-w-0"
    >
      <div
        className={cn(
          "flex items-center gap-2 bg-secondary border border-border rounded-lg h-8 px-3 flex-1 min-w-0 transition-colors",
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
          className="flex-1 bg-transparent border-none outline-none text-foreground text-[13px] font-sans placeholder:text-muted-foreground min-w-0 disabled:cursor-not-allowed"
        />
      </div>
      <button
        type="submit"
        disabled={runDisabled}
        aria-label={`Run ${workflow}`}
        title={`Enqueue ${workflow} items`}
        className={cn(
          "flex-shrink-0 h-8 w-8 flex items-center justify-center rounded-lg transition-colors outline-none",
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
      </button>
      {config.runEmptyAction && (
        <RunModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          workflow={config.runEmptyAction.modalWorkflow}
          lockedFormType={config.runEmptyAction.lockedFormType}
        />
      )}
    </form>
  );
}
