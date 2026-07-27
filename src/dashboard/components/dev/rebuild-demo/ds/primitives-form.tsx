import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, ChevronDown, Lock, Minus, Pencil, Search, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { dsFocus, dsFocusWithin, dsIcon, dsMotion, dsRadius, dsText } from "./tokens";

/**
 * DEV-ONLY — form primitives.
 *
 * This product types EIDs, names and dates that become real HR transactions,
 * so the field contract is strict: every control has a visible label, an
 * optional description, and an error that is ANNOUNCED, not just coloured.
 * `Field` wires the ids — never hand-roll `aria-describedby`.
 */

interface FieldContextValue {
  inputId: string;
  descriptionId?: string;
  errorId?: string;
  invalid: boolean;
  disabled?: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** The props a control needs to be correctly described by its `Field`. */
export function useFieldControl(): {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  disabled?: boolean;
} {
  const ctx = useContext(FieldContext);
  if (!ctx) return {};
  const describedBy = [ctx.descriptionId, ctx.errorId].filter(Boolean).join(" ");
  return {
    id: ctx.inputId,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": ctx.invalid || undefined,
    disabled: ctx.disabled,
  };
}

/**
 * ```tsx
 * <Field label="Employee ID" description="9 digits, no dashes" error={err}>
 *   <Input placeholder="100844120" />
 * </Field>
 * ```
 * Renders label → control → description/error. The error REPLACES the
 * description so the operator never has to choose which line to believe.
 */
export function Field({
  label,
  description,
  error,
  required,
  hint,
  disabled,
  className,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  /** a string turns the field invalid and announces the message */
  error?: string | null;
  required?: boolean;
  /** right-aligned helper beside the label (a unit, a shortcut, a count) */
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const base = useId();
  const inputId = `${base}-control`;
  const descriptionId = description ? `${base}-description` : undefined;
  const errorId = error ? `${base}-error` : undefined;

  return (
    <FieldContext.Provider
      value={{ inputId, descriptionId, errorId, invalid: Boolean(error), disabled }}
    >
      <div className={cn("flex min-w-0 flex-col gap-[var(--ds-space-tight)]", className)}>
        <div className="flex items-baseline gap-[var(--ds-space-base)]">
          <label
            htmlFor={inputId}
            className={cn(dsText.meta, "font-medium text-[color:var(--ds-fg-secondary)]")}
          >
            {label}
            {required && (
              <span aria-hidden className="ml-0.5 text-[color:var(--ds-danger)]">
                *
              </span>
            )}
            {required && <span className="sr-only"> (required)</span>}
          </label>
          {hint && (
            <span className={cn(dsText.meta, "ml-auto text-[color:var(--ds-fg-faint)]")}>{hint}</span>
          )}
        </div>
        {children}
        {error ? (
          <p
            id={errorId}
            role="alert"
            className={cn(
              dsText.meta,
              "flex items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-danger)]",
            )}
          >
            <TriangleAlert aria-hidden className={dsIcon.sm} />
            {error}
          </p>
        ) : (
          description && (
            <p id={descriptionId} className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
              {description}
            </p>
          )
        )}
      </div>
    </FieldContext.Provider>
  );
}

const controlShell = cn(
  "w-full min-w-0 border bg-[var(--ds-surface-2)]",
  "border-[color:var(--ds-control-border)] text-[color:var(--ds-fg)]",
  "placeholder:text-[color:var(--ds-fg-faint)]",
  dsRadius.md,
  dsFocus,
  dsMotion.base,
  "hover:border-[color:var(--ds-border-loud)]",
  "aria-[invalid=true]:border-[color:var(--ds-danger)]",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    const field = useFieldControl();
    return (
      <input
        ref={ref}
        {...field}
        {...props}
        className={cn(
          controlShell,
          "h-[var(--ds-h-md)] px-[var(--ds-space-base)]",
          dsText.ui,
          className,
        )}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 4, ...props }, ref) {
    const field = useFieldControl();
    return (
      <textarea
        ref={ref}
        rows={rows}
        {...field}
        {...props}
        className={cn(controlShell, "resize-y p-[var(--ds-space-base)]", dsText.body, className)}
      />
    );
  },
);

/**
 * A native `<select>` — deliberately. The OS picker is keyboard-perfect, works
 * on a touch device, and never traps focus. Reach for a custom listbox only
 * when you need multi-select or per-option rendering, and say why.
 */
export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }
>(function Select({ className, children, ...props }, ref) {
  const field = useFieldControl();
  return (
    <span className="relative flex min-w-0 items-center">
      <select
        ref={ref}
        {...field}
        {...props}
        className={cn(
          controlShell,
          "h-[var(--ds-h-md)] cursor-pointer appearance-none pl-[var(--ds-space-base)] pr-[var(--ds-space-section)]",
          dsText.ui,
          className,
        )}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className={cn(
          dsIcon.sm,
          "pointer-events-none absolute right-[var(--ds-space-base)] text-[color:var(--ds-fg-muted)]",
        )}
      />
    </span>
  );
});

/**
 * Checkbox (Radix). Supports the indeterminate state a "select all" header
 * needs — pass `checked="indeterminate"`.
 */
export function Checkbox({
  label,
  description,
  className,
  ...props
}: CheckboxPrimitive.CheckboxProps & { label: ReactNode; description?: ReactNode }) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-[var(--ds-space-base)]", className)}>
      <CheckboxPrimitive.Root
        id={id}
        {...props}
        className={cn(
          "mt-px inline-flex size-4 shrink-0 cursor-pointer items-center justify-center border",
          "border-[color:var(--ds-control-border)] bg-[var(--ds-surface-2)]",
          "data-[state=checked]:border-transparent data-[state=checked]:bg-[var(--ds-accent)]",
          "data-[state=indeterminate]:border-transparent data-[state=indeterminate]:bg-[var(--ds-accent)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          dsRadius.xs,
          dsFocus,
          dsMotion.fast,
        )}
      >
        <CheckboxPrimitive.Indicator className="flex items-center justify-center text-[color:var(--ds-accent-fg)]">
          {props.checked === "indeterminate" ? (
            <Minus aria-hidden className="size-3" strokeWidth={3} />
          ) : (
            <Check aria-hidden className="size-3" strokeWidth={3} />
          )}
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <label htmlFor={id} className="flex min-w-0 cursor-pointer flex-col">
        <span className={cn(dsText.ui, "text-[color:var(--ds-fg)]")}>{label}</span>
        {description && (
          <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{description}</span>
        )}
      </label>
    </div>
  );
}

/**
 * Radio group over native inputs — one tab stop, arrow keys between options,
 * for free, in every browser.
 */
export function RadioGroup<T extends string>({
  label,
  name,
  value,
  onValueChange,
  options,
  className,
}: {
  label: string;
  name: string;
  value: T;
  onValueChange: (value: T) => void;
  options: { value: T; label: ReactNode; description?: ReactNode; disabled?: boolean }[];
  className?: string;
}) {
  return (
    <fieldset className={cn("flex min-w-0 flex-col gap-[var(--ds-space-snug)]", className)}>
      <legend className={cn(dsText.meta, "mb-[var(--ds-space-tight)] font-medium text-[color:var(--ds-fg-secondary)]")}>
        {label}
      </legend>
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            "flex min-w-0 cursor-pointer items-start gap-[var(--ds-space-base)]",
            option.disabled && "cursor-not-allowed opacity-50",
          )}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={option.disabled}
            onChange={() => onValueChange(option.value)}
            className={cn(
              "mt-px size-4 shrink-0 cursor-pointer appearance-none rounded-full border",
              "border-[color:var(--ds-control-border)] bg-[var(--ds-surface-2)]",
              "checked:border-[length:var(--ds-border-w-emphasis)] checked:border-[color:var(--ds-accent)]",
              "checked:bg-[var(--ds-surface-page)]",
              dsFocus,
              dsMotion.fast,
            )}
          />
          <span className="flex min-w-0 flex-col">
            <span className={cn(dsText.ui, "text-[color:var(--ds-fg)]")}>{option.label}</span>
            {option.description && (
              <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
                {option.description}
              </span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * A binary setting that applies IMMEDIATELY. If the change needs a Save, use a
 * Checkbox instead — a switch that does nothing until you press Save is a lie.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-[var(--ds-space-base)]", className)}>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border",
          checked
            ? "border-transparent bg-[var(--ds-accent)]"
            : "border-[color:var(--ds-control-border)] bg-[var(--ds-surface-2)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          dsFocus,
          dsMotion.fast,
        )}
      >
        <span
          aria-hidden
          className={cn(
            "block size-3 rounded-full transition-transform duration-[var(--ds-dur-1)] ease-[var(--ds-ease-out)]",
            checked
              ? "translate-x-3.5 bg-[var(--ds-accent-fg)]"
              : "translate-x-0.5 bg-[var(--ds-fg-muted)]",
          )}
        />
      </button>
      <label htmlFor={id} className="flex min-w-0 cursor-pointer flex-col">
        <span className={cn(dsText.ui, "text-[color:var(--ds-fg)]")}>{label}</span>
        {description && (
          <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{description}</span>
        )}
      </label>
    </div>
  );
}

/** A search field with its icon and a clear control. Used by every list. */
export const SearchInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { onClear?: () => void; shortcut?: ReactNode }
>(function SearchInput({ className, onClear, shortcut, value, ...props }, ref) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-[var(--ds-space-snug)] border bg-[var(--ds-surface-2)]",
        "h-[var(--ds-h-md)] border-[color:var(--ds-control-border)] px-[var(--ds-space-base)]",
        dsRadius.md,
        dsFocusWithin,
        className,
      )}
    >
      <Search aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
      <input
        ref={ref}
        type="search"
        value={value}
        {...props}
        className={cn(
          "min-w-0 flex-1 bg-transparent outline-none",
          dsText.ui,
          "text-[color:var(--ds-fg)] placeholder:text-[color:var(--ds-fg-faint)]",
          "[&::-webkit-search-cancel-button]:hidden",
        )}
      />
      {value && onClear ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={onClear}
          className={cn("shrink-0 cursor-pointer text-[color:var(--ds-fg-muted)] hover:text-[color:var(--ds-fg)]", dsFocus)}
        >
          <X aria-hidden className={dsIcon.sm} />
        </button>
      ) : (
        shortcut
      )}
    </span>
  );
});

/* =========================================================================
 * ValueField / LockedValue — a recorded value the operator may or may not correct
 * ====================================================================== */

/**
 * A value the run OBSERVED, drawn so the operator can see it is correctable.
 *
 * WHY THIS EXISTS AS A PRIMITIVE (2026-07-27). Two surfaces independently grew
 * the same defect and the operator hit it twice: the Data ledger's read values
 * and the Review tab's extracted OCR fields were both real `<input>`s at rest,
 * both styled `border-transparent` on no background, and both therefore looked
 * exactly like the static text around them. Each only became visibly a field
 * once it had already been edited — or once the pointer happened to cross it —
 * which is backwards: hover is not an affordance, because a control you can
 * only discover by sweeping the pointer over the page is a control that does
 * not exist for anyone who did not sweep. Two surfaces had the need, a third
 * will, so the treatment lives here and not in either consumer.
 *
 * What it says, at rest and without interaction: a control-border outline (held
 * to 3:1 — a control's outline is what identifies it as a control), an inset
 * surface, and a pencil. Dirty is a fill and a border, never a text colour:
 * amber text on an amber fill is the one place this system routinely loses
 * contrast, and the amber shell already says it. Every consumer pairs the fill
 * with a WORD as well, because colour is never the only encoding.
 *
 * Label it one of two ways and never both: pass `id` and render your own
 * `<label htmlFor>` where the label is visible (an `aria-label` would silently
 * override that visible text), or pass `ariaLabel` where there is no label
 * element to pair with.
 */
export function ValueField({
  id,
  ariaLabel,
  value,
  onChange,
  dirty = false,
  title,
  className,
}: {
  /** pair with your own `<label htmlFor>` when the label is visible */
  id?: string;
  /** the accessible name when there is no label element to pair with */
  ariaLabel?: string;
  value: string;
  onChange: (next: string) => void;
  /** typed over and not yet committed — a fill and a border, never ink */
  dirty?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <span className={cn("relative flex min-w-0 items-center", className)}>
      <input
        id={id}
        aria-label={ariaLabel}
        title={title}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          // The right padding is the pencil's 12px plus its 4px offset plus 4px of
          // air, composed from tokens rather than guessed — at `loose` the value
          // ran straight into the glyph on a narrow column.
          "w-full min-w-0 border pl-[var(--ds-space-snug)] pr-[calc(var(--ds-space-loose)+var(--ds-space-tight))]",
          "h-[var(--ds-h-sm)] rounded-[var(--ds-radius-md)]",
          dsText.body,
          dsText.nums,
          dsFocus,
          dsMotion.fast,
          "text-[color:var(--ds-fg)]",
          dirty
            ? "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)]"
            : cn(
                "border-[color:var(--ds-control-border)] bg-[var(--ds-surface-2)]",
                "hover:border-[color:var(--ds-border-loud)] focus:border-[color:var(--ds-border-loud)]",
              ),
        )}
      />
      {/* Inside the field, not beside it — a value column is the one thing on
          these surfaces that cannot spare width, and the pencil is what says
          "this box takes typing" before anything is typed. */}
      <Pencil
        aria-hidden
        className={cn(dsIcon.sm, "pointer-events-none absolute right-[var(--ds-space-tight)] text-[color:var(--ds-fg-muted)]")}
      />
    </span>
  );
}

/**
 * A recorded value the operator may NOT correct — `ValueField`'s counterpart.
 *
 * The pair only works because the two are told apart by SHAPE: an editable
 * value is a box, a locked value is flat text with a lock and no box at all.
 * Making everything look like a field to be consistent would erase exactly the
 * distinction that matters here — "you may change this" against "you may not"
 * is load-bearing on a surface that files real HR transactions.
 *
 * `reason` is not optional in spirit. A greyed value with no explanation is how
 * an operator learns to distrust a screen; every consumer says why.
 */
export function LockedValue({
  value,
  reason,
  tone = "default",
  className,
}: {
  value: ReactNode;
  /** why it cannot be corrected — shown, never left to be guessed */
  reason?: string;
  tone?: "default" | "warning";
  className?: string;
}) {
  return (
    <span title={reason} className={cn("flex min-w-0 items-start gap-[var(--ds-space-tight)]", className)}>
      <Lock aria-hidden className={cn(dsIcon.sm, "mt-[var(--ds-space-hair)] shrink-0 text-[color:var(--ds-fg-muted)]")} />
      {/* It WRAPS rather than truncating: half a date is a guess, and a value
          is the one thing on these rows that cannot be recovered from
          anywhere else on the surface. */}
      <span
        className={cn(
          dsText.body,
          dsText.nums,
          "min-w-0 flex-1 break-words",
          tone === "warning" ? "text-[color:var(--ds-status-waiting-fg)]" : "text-[color:var(--ds-fg)]",
        )}
      >
        {value}
      </span>
    </span>
  );
}
