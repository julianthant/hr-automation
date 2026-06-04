import { cn } from "@/lib/utils";
import {
  AUTO_WORKERS,
  WORKER_CHOICES,
  workerChoiceLabel,
  type WorkerChoice,
} from "@/lib/run-settings";

interface AutomationWorkersFieldProps {
  value: WorkerChoice;
  onChange: (choice: WorkerChoice) => void;
  disabled?: boolean;
}

/**
 * The upload modal's "Automation workers" picker — a horizontal radio strip
 * (Auto / 1 / 2 / 4 / 6 / 8) plus a one-line explanation of the selected mode.
 * Presentational + stateless; `RunModal` owns the value and only appends
 * `parallelWorkers` to the upload when it isn't Auto. Shares its choice
 * vocabulary with the input-run gear (`RunSettingsMenu`) via
 * `src/dashboard/lib/run-settings.ts`.
 */
export function AutomationWorkersField({ value, onChange, disabled = false }: AutomationWorkersFieldProps) {
  return (
    <section>
      <div className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-2 text-muted-foreground">
        Automation workers
      </div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Automation workers">
        {WORKER_CHOICES.map((choice) => {
          const active = value === choice;
          return (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange(choice)}
              className={cn(
                "min-w-11 rounded-[7px] border px-3 py-1.5 text-[12.5px] font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border",
                "disabled:cursor-not-allowed disabled:opacity-60",
                disabled ? "" : "cursor-pointer hover:bg-muted/25",
              )}
              style={{
                borderColor: active ? "var(--capture-border-cta)" : "var(--capture-border-subtle)",
                backgroundColor: active ? "var(--capture-bg-raised)" : "transparent",
                color: active ? "var(--capture-fg-primary)" : "var(--capture-fg-muted)",
              }}
            >
              {workerChoiceLabel(choice)}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 text-[11px] leading-[1.45] text-muted-foreground">
        {value === AUTO_WORKERS
          ? "Reuse existing workers; start one if needed."
          : `Ensure at least ${value} worker${value === "1" ? "" : "s"} are running for the downstream fan-out.`}
      </div>
    </section>
  );
}
