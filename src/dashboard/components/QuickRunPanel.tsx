import { useState, type FormEvent } from "react";
import { Play, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { getQuickRunConfig } from "@/lib/quick-run-registry";
import { SharePointDownloadButton } from "./SharePointDownloadButton";

interface QuickRunPanelProps {
  workflow: string;
  failedIds: string[];
}

/**
 * QuickRunPanel — host-agnostic input + run + retry-all cluster, mounted in
 * the TopBar's queue zone. Contains an input + an icon-only Run button + an
 * icon-only Retry-all button (only visible when ≥1 failed entry exists for
 * the current workflow + date).
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
 * Retry-all: POSTs `/api/retry-bulk` with every failed entry ID for the
 * current workflow + date. Per-id error breakdown surfaces in a sonner toast.
 */
export function QuickRunPanel({ workflow, failedIds }: QuickRunPanelProps) {
  const config = getQuickRunConfig(workflow);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);

  if (!config) return null;

  async function submit() {
    if (submitting) return;
    if (!config) return;
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

  async function retryAll() {
    if (retrying || failedIds.length === 0) return;
    setRetrying(true);
    const t = toast.loading(`Retrying ${failedIds.length} failed items…`);
    try {
      const res = await fetch("/api/retry-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, ids: failedIds }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        count: number;
        errors: Array<{ id: string; error: string }>;
      };
      if (body.errors.length === 0) {
        toast.success(`Retry scheduled`, {
          id: t,
          description: `${body.count} of ${failedIds.length} items re-added to queue`,
        });
      } else {
        toast.warning(`Some retries failed`, {
          id: t,
          description: `${body.count} succeeded · ${body.errors.length} failed (${body.errors[0].error})`,
        });
      }
    } catch (err) {
      toast.error(`Couldn't retry failed items`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRetrying(false);
    }
  }

  const runDisabled = submitting || value.trim().length === 0;
  const failedCount = failedIds.length;

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
      {failedCount > 0 && (
        <button
          type="button"
          onClick={retryAll}
          disabled={retrying}
          aria-label={`Retry all ${failedCount} failed entries`}
          title={`Retry ${failedCount} failed ${failedCount === 1 ? "entry" : "entries"}`}
          className={cn(
            "flex-shrink-0 h-8 w-8 flex items-center justify-center rounded-lg transition-colors outline-none",
            "bg-destructive/10 text-destructive border border-destructive/40",
            "hover:bg-destructive/20 hover:border-destructive/60",
            "focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-1 focus-visible:ring-offset-card",
            "disabled:opacity-50 disabled:cursor-wait cursor-pointer",
          )}
        >
          {retrying ? (
            <Loader2 aria-hidden className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RotateCcw aria-hidden className="w-3.5 h-3.5" />
          )}
        </button>
      )}
      <SharePointDownloadButton />
    </form>
  );
}
