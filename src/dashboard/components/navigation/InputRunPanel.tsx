import { useState, type FormEvent } from "react";
import { Play, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { getInputRunConfig } from "@/lib/input-run-registry";
import { RunModal } from "@/components/run-modal/RunModal";
import { useOptionalBatchQueueParentRunId } from "@/components/hooks/useBatchQueueContext";
import { useWorkflow } from "@/lib/workflows-context";
import { RunSettingsMenu } from "./RunSettingsMenu";
import { AUTO_WORKERS, FULL_PRESET_ID, workerChoiceToParam, type WorkerChoice } from "@/lib/run-settings";

interface InputRunPanelProps {
  workflow: string;
}

/**
 * InputRunPanel — workflow input-run text box + play button (mounted in
 * `QueuePanel`'s footer).
 *
 * Visible only for workflows registered in
 * `src/dashboard/lib/input-run-registry.ts`. Workflows without an input-run
 * config render null.
 *
 * On submit: parses the text into typed inputs via the registry, POSTs
 * `/api/enqueue`, shows a sonner toast with the result. If no daemon is
 * alive for the target workflow, the backend spawns one — the operator
 * will see a Duo prompt in the freshly-launched browser.
 *
 * Bulk retry/stop/delete buttons sit beside the queue sort control in the
 * panel header (`queueBulkActionsSlot` in `App`).
 */
export function InputRunPanel({ workflow }: InputRunPanelProps) {
  const config = getInputRunConfig(workflow);
  const workflowDef = useWorkflow(workflow);
  const presets = workflowDef?.presets ?? [];
  const batchQueueParentRunId = useOptionalBatchQueueParentRunId();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  // Per-page-load ephemeral preset selection — resets to "Full" on reload.
  const [presetId, setPresetId] = useState<string>(FULL_PRESET_ID);
  // Per-page-load ephemeral Automation-workers selection — resets to Auto.
  const [workerChoice, setWorkerChoice] = useState<WorkerChoice>(AUTO_WORKERS);

  if (!config) return null;

  const selectedPreset = presetId === FULL_PRESET_ID ? null : presets.find((p) => p.id === presetId);

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
      const parentRunId =
        batchQueueParentRunId;
      const parallelWorkers = workerChoiceToParam(workerChoice);
      const res = await fetch("/api/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          inputs: parsed.inputs,
          ...(parentRunId ? { parentRunId } : {}),
          ...(selectedPreset
            ? { skipSteps: selectedPreset.skipSteps, preset: selectedPreset.id }
            : {}),
          ...(parallelWorkers !== undefined ? { parallelWorkers } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        enqueued?: number;
        error?: string;
      };
      if (res.status === 202 && body.ok) {
        const n = body.enqueued ?? parsed.inputs.length;
        const description = selectedPreset
          ? `Run mode: ${selectedPreset.label}. If no session was running, one is starting — approve Duo in the new browser window.`
          : "If no session was running, one is starting — approve Duo in the new browser window.";
        toast.success(`Added ${n} ${n === 1 ? "item" : "items"} to ${workflow}`, {
          description,
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
          "shrink-0 h-8 w-8 flex items-center justify-center rounded-lg transition-colors outline-none",
          "bg-primary text-primary-foreground border border-primary",
          "hover:bg-primary/90 hover:border-primary/90",
          "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card",
          "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
        )}
      >
        {submitting ? (
          <Loader2 aria-hidden className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" />
        ) : (
          <Play aria-hidden className="w-3.5 h-3.5" />
        )}
      </button>
      <RunSettingsMenu
        workerChoice={workerChoice}
        onSelectWorker={setWorkerChoice}
        presets={presets}
        presetId={presetId}
        onSelectPreset={setPresetId}
        workflowLabel={workflowDef?.label ?? workflow}
      />
      {config.runEmptyAction && (
        <RunModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          workflow={config.runEmptyAction.modalWorkflow}
        />
      )}
    </form>
  );
}
