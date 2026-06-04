import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AUTO_WORKERS,
  MAX_WORKERS,
  canDecWorkerChoice,
  canIncWorkerChoice,
  decWorkerChoice,
  incWorkerChoice,
  isAutoWorkers,
  workerChoiceLabel,
  workerChoiceToParam,
  workerChoiceValueText,
  type WorkerChoice,
} from "@/lib/run-settings";

interface WorkerStepperProps {
  value: WorkerChoice;
  onChange: (next: WorkerChoice) => void;
  disabled?: boolean;
  /** Group aria-label; the gear and footer pass the same default. */
  ariaLabel?: string;
  /**
   * `compact` — gear-popover row: h-8, rounded-lg, filled (bg-secondary).
   * `footer`  — modal action row: matches the Run/Cancel buttons (taller,
   *             transparent/outlined, rounded-[7px]) so the footer reads as one
   *             family.
   */
  variant?: "compact" | "footer";
  className?: string;
}

/** Run-modal footer row — stepper, Run, and Cancel share this height. */
export const MODAL_FOOTER_CONTROL_HEIGHT = "h-[38px]";

const VARIANTS = {
  compact: {
    container: "h-8 rounded-lg bg-secondary",
    button: "w-8",
    value: "min-w-[3.25rem] text-[13px]",
  },
  footer: {
    container: cn(MODAL_FOOTER_CONTROL_HEIGHT, "rounded-[7px] bg-transparent shrink-0"),
    button: "w-9",
    value: "min-w-[3.5rem] text-[12.5px]",
  },
} as const;

/**
 * Compact `[−] value [+]` stepper for the Automation-workers run setting.
 * Domain: Auto, 1 … {@link MAX_WORKERS}. `−` from 1 lands on Auto (the floor);
 * `+` stops at MAX. The value cell reads "Auto" or the integer.
 *
 * Built from the GENERIC theme tokens (`border`/`secondary`/`muted`/`foreground`/
 * `ring`) on purpose: `RunModal` remaps those to its `--capture-*` palette on the
 * dialog surface, so the same component adopts the modal's look there and the
 * standard dashboard look in the input-run gear — no per-surface variant beyond
 * the size/fill {@link WorkerStepperProps.variant}.
 *
 * A11y: a `spinbutton` value cell (arrow / Home / End keys, `aria-valuetext`)
 * plus two real `−`/`+` buttons (`aria-label`, disabled at the bounds). The
 * value cell is fixed-width so "Auto" ↔ single digits never shift layout.
 */
export function WorkerStepper({
  value,
  onChange,
  disabled = false,
  ariaLabel = "Automation workers",
  variant = "compact",
  className,
}: WorkerStepperProps) {
  const canDec = !disabled && canDecWorkerChoice(value);
  const canInc = !disabled && canIncWorkerChoice(value);
  const auto = isAutoWorkers(value);
  const v = VARIANTS[variant];

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    switch (e.key) {
      case "ArrowUp":
      case "ArrowRight":
        if (canInc) {
          e.preventDefault();
          onChange(incWorkerChoice(value));
        }
        break;
      case "ArrowDown":
      case "ArrowLeft":
        if (canDec) {
          e.preventDefault();
          onChange(decWorkerChoice(value));
        }
        break;
      case "Home":
        e.preventDefault();
        onChange(AUTO_WORKERS);
        break;
      case "End":
        e.preventDefault();
        onChange(String(MAX_WORKERS) as WorkerChoice);
        break;
    }
  };

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-stretch border border-border overflow-hidden divide-x divide-border",
        v.container,
        disabled && "opacity-60",
        className,
      )}
    >
      <StepperButton
        kind="dec"
        ariaLabel="Fewer workers"
        widthClass={v.button}
        disabled={!canDec}
        onClick={() => onChange(decWorkerChoice(value))}
      />
      <div
        role="spinbutton"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={MAX_WORKERS}
        aria-valuenow={workerChoiceToParam(value) ?? 0}
        aria-valuetext={workerChoiceValueText(value)}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={handleKeyDown}
        className={cn(
          "px-1.5 grid place-items-center select-none font-medium tabular-nums",
          "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          v.value,
          auto ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {workerChoiceLabel(value)}
      </div>
      <StepperButton
        kind="inc"
        ariaLabel="More workers"
        widthClass={v.button}
        disabled={!canInc}
        onClick={() => onChange(incWorkerChoice(value))}
      />
    </div>
  );
}

function StepperButton({
  kind,
  ariaLabel,
  widthClass,
  disabled,
  onClick,
}: {
  kind: "dec" | "inc";
  ariaLabel: string;
  widthClass: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = kind === "dec" ? Minus : Plus;
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid place-items-center text-muted-foreground transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        widthClass,
        disabled
          ? "opacity-40 cursor-not-allowed"
          : "cursor-pointer hover:text-foreground hover:bg-muted",
      )}
    >
      <Icon aria-hidden className="w-3.5 h-3.5" />
    </button>
  );
}
