import { useState } from "react";
import { Settings2, Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  AUTO_WORKERS,
  FULL_PRESET_ID,
  WORKER_CHOICES,
  workerChoiceDescription,
  workerChoiceLabel,
  type StepPreset,
  type WorkerChoice,
} from "@/lib/run-settings";

interface RunSettingsMenuProps {
  /** Currently selected Automation-workers choice (`"auto"` for the default). */
  workerChoice: WorkerChoice;
  onSelectWorker: (choice: WorkerChoice) => void;
  /** Workflow-declared run-mode presets (empty → the Run-mode section is hidden). */
  presets: StepPreset[];
  /** Selected preset id (`"full"` for the default). Ignored when `presets` is empty. */
  presetId: string;
  onSelectPreset: (presetId: string) => void;
  /** Workflow label for the trigger's tooltip. */
  workflowLabel: string;
}

/**
 * The input-run settings gear + popover. Consolidates two ephemeral run
 * settings into one control beside the Run button:
 *   - **Automation workers** (always shown) — how many browser workers to
 *     target for the run's downstream fan-out. See `src/lib/run-settings.ts`.
 *   - **Run mode** (shown only when the workflow declares presets) — the
 *     step-skip presets formerly owned by `StepPresetMenu`.
 *
 * Selection is per-page-load ephemeral; the parent (`InputRunPanel`) owns the
 * state. Any non-default choice (workers ≠ Auto OR preset ≠ Full) flips the
 * gear to a primary-accent style with a dot so the operator can't lose track.
 */
export function RunSettingsMenu({
  workerChoice,
  onSelectWorker,
  presets,
  presetId,
  onSelectPreset,
  workflowLabel,
}: RunSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const workersDefault = workerChoice === AUTO_WORKERS;
  const presetDefault = presetId === FULL_PRESET_ID;
  const isDefault = workersDefault && presetDefault;
  const selectedPreset = presetDefault ? null : presets.find((p) => p.id === presetId);

  const tooltip = [
    `Workers: ${workerChoiceLabel(workerChoice)}`,
    presets.length > 0 ? `Run mode: ${presetDefault ? "Full" : selectedPreset?.label ?? "(unknown)"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Run settings for ${workflowLabel}`}
          title={tooltip}
          className={cn(
            "relative shrink-0 h-8 w-8 flex items-center justify-center rounded-lg transition-colors outline-none",
            "border focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card",
            "cursor-pointer",
            isDefault
              ? "bg-secondary border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
              : "bg-primary/10 border-primary text-primary hover:bg-primary/20",
          )}
        >
          <Settings2 aria-hidden className="w-3.5 h-3.5" />
          {!isDefault && (
            <span
              aria-hidden
              className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary"
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-72 p-1.5">
        <div className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          Automation workers
        </div>
        <ul role="radiogroup" aria-label="Automation workers" className="flex flex-col">
          {WORKER_CHOICES.map((choice) => (
            <RadioRow
              key={choice}
              id={`workers-${choice}`}
              label={workerChoiceLabel(choice)}
              description={workerChoiceDescription(choice)}
              selected={choice === workerChoice}
              onSelect={() => {
                onSelectWorker(choice);
                setOpen(false);
              }}
            />
          ))}
        </ul>

        {presets.length > 0 && (
          <>
            <div className="my-1.5 border-t border-border/60" aria-hidden />
            <div className="px-2 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
              Run mode
            </div>
            <ul role="radiogroup" aria-label="Run mode" className="flex flex-col">
              <RadioRow
                id={FULL_PRESET_ID}
                label="Full"
                description="All steps run."
                selected={presetDefault}
                onSelect={() => {
                  onSelectPreset(FULL_PRESET_ID);
                  setOpen(false);
                }}
              />
              {presets.map((p) => (
                <RadioRow
                  key={p.id}
                  id={p.id}
                  label={p.label}
                  description={p.description ?? `Skips: ${p.skipSteps.join(", ")}`}
                  selected={p.id === presetId}
                  onSelect={() => {
                    onSelectPreset(p.id);
                    setOpen(false);
                  }}
                />
              ))}
            </ul>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

interface RadioRowProps {
  id: string;
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}

function RadioRow({ id, label, description, selected, onSelect }: RadioRowProps) {
  return (
    <li>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        data-choice-id={id}
        onClick={onSelect}
        className={cn(
          "w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left transition-colors outline-none cursor-pointer",
          "hover:bg-secondary focus-visible:bg-secondary",
          selected && "bg-primary/10",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "mt-0.5 shrink-0 w-4 h-4 flex items-center justify-center rounded-full border",
            selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-transparent",
          )}
        >
          {selected && <Check aria-hidden className="w-2.5 h-2.5" />}
        </span>
        <span className="flex flex-col min-w-0">
          <span className="text-[13px] font-medium text-foreground">{label}</span>
          <span className="text-[11px] text-muted-foreground leading-snug">{description}</span>
        </span>
      </button>
    </li>
  );
}
