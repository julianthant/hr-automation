import { useState } from "react";
import { Settings2, Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface StepPreset {
  id: string;
  label: string;
  skipSteps: string[];
  description?: string;
}

const FULL_PRESET_ID = "full";

interface StepPresetMenuProps {
  /** Workflow-declared presets (excludes the implicit "Full" entry, which this component synthesizes). */
  presets: StepPreset[];
  /** Currently selected preset id (`"full"` for the default). */
  selectedId: string;
  onSelect: (presetId: string) => void;
  /** Workflow label for the trigger's tooltip ("Run mode for separations"). */
  workflowLabel: string;
}

/**
 * Gear button + popover that picks a "Run mode" preset for the InputRunPanel.
 * Visible only for workflows whose registry entry declares `presets[]`. The
 * implicit `"full"` preset (no skips) is always shown at the top of the list.
 * Selection is per-click ephemeral — the parent (`InputRunPanel`) owns the
 * state via `useState`; no localStorage. Selecting a non-default preset
 * flips the trigger to a primary-accent style with a small dot so the
 * operator can't lose track of it.
 */
export function StepPresetMenu({ presets, selectedId, onSelect, workflowLabel }: StepPresetMenuProps) {
  const [open, setOpen] = useState(false);
  const isDefault = selectedId === FULL_PRESET_ID;
  const selected = isDefault ? null : presets.find((p) => p.id === selectedId);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Run mode for ${workflowLabel}`}
          title={`Run mode: ${isDefault ? "Full" : selected?.label ?? "(unknown)"}`}
          className={cn(
            "relative flex-shrink-0 h-8 w-8 flex items-center justify-center rounded-lg transition-colors outline-none",
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
          Run mode
        </div>
        <ul role="radiogroup" aria-label="Run mode" className="flex flex-col">
          <PresetItem
            id={FULL_PRESET_ID}
            label="Full"
            description={`All steps run.`}
            selected={isDefault}
            onSelect={() => {
              onSelect(FULL_PRESET_ID);
              setOpen(false);
            }}
          />
          {presets.map((p) => (
            <PresetItem
              key={p.id}
              id={p.id}
              label={p.label}
              description={p.description ?? `Skips: ${p.skipSteps.join(", ")}`}
              selected={p.id === selectedId}
              onSelect={() => {
                onSelect(p.id);
                setOpen(false);
              }}
            />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

interface PresetItemProps {
  id: string;
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}

function PresetItem({ id, label, description, selected, onSelect }: PresetItemProps) {
  return (
    <li>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        data-preset-id={id}
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
            "mt-0.5 flex-shrink-0 w-4 h-4 flex items-center justify-center rounded-full border",
            selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-transparent",
          )}
        >
          {selected && <Check aria-hidden className="w-2.5 h-2.5" />}
        </span>
        <span className="flex flex-col min-w-0">
          <span className={cn("text-[13px] font-medium", selected ? "text-foreground" : "text-foreground")}>
            {label}
          </span>
          <span className="text-[11px] text-muted-foreground leading-snug">{description}</span>
        </span>
      </button>
    </li>
  );
}

export { FULL_PRESET_ID };
