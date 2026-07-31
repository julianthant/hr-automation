import { useEffect, useState, type FormEvent } from "react";
import { Play, Loader2 } from "lucide-react";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { applyInputRunOptions, getInputRunConfig } from "@/lib/input-run-registry";
import { RunModal } from "@/components/run-modal/RunModal";
import { useOptionalOperationQueueParentRunId } from "@/components/hooks/useOperationQueueContext";
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
  const operationQueueParentRunId = useOptionalOperationQueueParentRunId();
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  // Per-page-load ephemeral preset selection — resets to "Full" on reload.
  const [presetId, setPresetId] = useState<string>(FULL_PRESET_ID);
  // Per-page-load ephemeral Automation-workers selection — resets to Auto.
  const [workerChoice, setWorkerChoice] = useState<WorkerChoice>(AUTO_WORKERS);
  // Per-page-load ephemeral dry-run toggle — resets to off (live) on reload.
  // Only meaningful for workflows whose registry entry sets `supportsDryRun`.
  const [dryRun, setDryRun] = useState(false);
  const [modeKey, setModeKey] = useState(config?.modes?.[0]?.key ?? "");
  const [crmCheck, setCrmCheck] = useState(
    config?.modes?.[0]?.crmCheckDefault ?? false,
  );

  useEffect(() => {
    const defaultMode = config?.modes?.[0];
    setModeKey(defaultMode?.key ?? "");
    setCrmCheck(defaultMode?.crmCheckDefault ?? false);
  }, [config, workflow]);

  if (!config) return null;

  const selectedMode = config.modes?.find((mode) => mode.key === modeKey) ?? config.modes?.[0];
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
    const parsed = (selectedMode?.parseInput ?? config.parseInput)(value);
    if (!parsed.ok) {
      toast.error("Invalid input", { description: parsed.error });
      return;
    }
    setSubmitting(true);
    try {
      const parentRunId =
        operationQueueParentRunId;
      const parallelWorkers = workerChoiceToParam(workerChoice);
      // Dry-run rides `input_json` as a schema field (not the runtimeOptions
      // channel) — fold it onto each parsed input when the toggle is on.
      const inputs = applyInputRunOptions(parsed.inputs, {
        ...(selectedMode ? { mode: selectedMode.key } : {}),
        ...(config.supportsCrmCheck ? { crmCheck } : {}),
        ...(config.supportsDryRun && dryRun ? { dryRun: true } : {}),
      });
      const res = await fetch("/api/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          inputs,
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
      className="flex flex-col gap-1.5 flex-1 min-w-0"
    >
      {config.modes && config.modes.length > 0 && (
        <div className="flex items-center gap-2 min-w-0">
          <div
            role="radiogroup"
            aria-label={`${workflowDef?.label ?? workflow} mode`}
            className="inline-flex shrink-0 rounded-lg border border-border bg-secondary/40 p-0.5"
          >
            {config.modes.map((mode) => {
              const selected = mode.key === selectedMode?.key;
              return (
                <button
                  key={mode.key}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    setModeKey(mode.key);
                    setCrmCheck(mode.crmCheckDefault ?? false);
                    setValue("");
                  }}
                  className={cn(
                    "h-6 rounded-md px-2.5 text-[12px] font-medium transition-colors outline-none",
                    "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card",
                    selected
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {mode.label}
                </button>
              );
            })}
          </div>
          {selectedMode?.note && (
            <span className="truncate text-[11px] text-muted-foreground" title={selectedMode.note}>
              {selectedMode.note}
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 min-w-0">
        <div
          className={cn(
            "flex items-center gap-2 bg-secondary border border-border rounded-lg h-8 px-3 flex-1 min-w-0 transition-colors",
            submitting ? "opacity-60" : "focus-within:border-primary",
          )}
        >
          <input
            type="text"
            placeholder={selectedMode?.placeholder ?? config.placeholder}
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
          supportsDryRun={config.supportsDryRun ?? false}
          dryRun={dryRun}
          onToggleDryRun={setDryRun}
          supportsCrmCheck={config.supportsCrmCheck ?? false}
          crmCheck={crmCheck}
          crmCheckDefault={selectedMode?.crmCheckDefault ?? false}
          onToggleCrmCheck={setCrmCheck}
          workflowLabel={workflowDef?.label ?? workflow}
        />
      </div>
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
