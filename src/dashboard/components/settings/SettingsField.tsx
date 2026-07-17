/**
 * Shared labeled-field primitives for the Settings page. Co-located in
 * `components/settings/` — not promoted to `shared/` because they are
 * tightly coupled to the Settings page's layout contract.
 */
import type { JSX } from "react";
import { cn } from "@/lib/utils";

// ── Text / number inputs ──────────────────────────────────────────────────────

interface InputFieldProps {
  id: string;
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  type?: "text" | "number";
  placeholder?: string;
  hint?: string;
  mono?: boolean;
  min?: number;
  step?: number;
  /** Shows an amber dot beside the label when this field differs from its saved value. */
  changed?: boolean;
  className?: string;
}

export function InputField({
  id,
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  hint,
  mono,
  min,
  step,
  changed,
  className,
}: InputFieldProps): JSX.Element {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
        {label}
        {changed && (
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" title="Changed" />
        )}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        min={min}
        step={step}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "h-9 w-full rounded-md border border-border bg-secondary px-3 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring",
          mono && "font-mono",
        )}
      />
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ── Toggle (role=switch) ─────────────────────────────────────────────────────

interface ToggleFieldProps {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Shows an amber dot beside the label when this field differs from its saved value. */
  changed?: boolean;
}

export function ToggleField({
  id,
  label,
  description,
  checked,
  onChange,
  changed,
}: ToggleFieldProps): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <label
          htmlFor={id}
          className="flex cursor-pointer select-none items-center gap-1.5 text-[13px] font-medium text-foreground"
        >
          {label}
          {changed && (
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" title="Changed" />
          )}
        </label>
        {description && (
          <p className="max-w-[44ch] text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
          checked ? "border-success/50 bg-success/40" : "border-border bg-accent",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute top-[2px] h-[14px] w-[14px] rounded-full transition-[left]",
            checked ? "left-[18px] bg-success" : "left-[2px] bg-foreground",
          )}
        />
      </button>
    </div>
  );
}

// ── Section heading with optional hairline ────────────────────────────────────

interface SectionHeadingProps {
  title: string;
  className?: string;
}

export function SectionHeading({ title, className }: SectionHeadingProps): JSX.Element {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <h3 className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
