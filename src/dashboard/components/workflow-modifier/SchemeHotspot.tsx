import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, CircleDot, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import type { SchemeMeta } from "../../../domain/workflow-presentation/schemes.js";
import { TokenTemplateInput } from "./TokenTemplateInput.js";

export interface SchemeValue {
  scheme: string;
  template?: string;
}

interface SchemeHotspotProps {
  /** Stable id for label/aria wiring. */
  id: string;
  /** What the control edits, spoken to assistive tech. e.g. "title naming". */
  fieldLabel: string;
  /** Resolved text rendered in the artifact (the live preview value). */
  displayText: string;
  /** Shown muted+italic when displayText is empty (e.g. batch-anchor title). */
  emptyLabel?: string;
  /** Render the trigger value in IBM Plex Mono (trace ids, templates). */
  mono?: boolean;
  /** Size/weight of the trigger text so it matches its host line. */
  triggerClassName?: string;
  pool: SchemeMeta[];
  value: SchemeValue | undefined;
  /** When true, a "Default (no override)" choice is offered (delegation parts). */
  allowUnset?: boolean;
  modified: boolean;
  /** Human label of the default scheme, for the "Default: …" line. */
  defaultLabel: string;
  placeholder?: string;
  /** Extra caution shown under the template editor (e.g. trace warning). */
  warning?: string;
  onChange: (next: SchemeValue | undefined) => void;
  onReset: () => void;
}

/**
 * A hotspot is editable text living directly inside the artifact. Reading it
 * shows the live value; clicking it opens a scheme picker anchored to that exact
 * text. Modified state reads at a glance — a filled dot + a solid primary
 * underline — while the popover carries the "Default: …" line and Reset.
 */
export function SchemeHotspot({
  id,
  fieldLabel,
  displayText,
  emptyLabel = "(none)",
  mono = false,
  triggerClassName,
  pool,
  value,
  allowUnset = false,
  modified,
  defaultLabel,
  placeholder,
  warning,
  onChange,
  onReset,
}: SchemeHotspotProps): JSX.Element {
  const [open, setOpen] = useState(false);

  const effectiveScheme = value?.scheme ?? (allowUnset ? "" : pool[0]?.id ?? "");
  const isCustom = effectiveScheme === "custom-template";

  // ~200ms monochrome pulse when the resolved value changes, so the eye catches
  // the edit. Pure transition utilities (no CSS animation) — token-only tint.
  const [pulsing, setPulsing] = useState(false);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setPulsing(true);
    const t = setTimeout(() => setPulsing(false), 220);
    return () => clearTimeout(t);
  }, [displayText]);

  const selectScheme = (schemeId: string) => {
    if (allowUnset && schemeId === "") {
      onChange(undefined);
      setOpen(false);
      return;
    }
    if (schemeId === "custom-template") {
      onChange({ scheme: "custom-template", template: value?.template ?? "" });
      // Stay open — the operator still needs to type the template.
      return;
    }
    onChange({ scheme: schemeId });
    setOpen(false);
  };

  const handleReset = () => {
    onReset();
    setOpen(false);
  };

  const optionActive = (schemeId: string): boolean =>
    allowUnset && schemeId === "" ? value === undefined : effectiveScheme === schemeId;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Edit ${fieldLabel}`}
          className={cn(
            "group inline-flex max-w-full items-center gap-1 rounded px-1 -mx-1 text-left align-baseline",
            "underline decoration-dashed decoration-muted-foreground/40 underline-offset-4",
            "cursor-pointer transition-colors duration-200",
            "hover:bg-accent/60 hover:decoration-foreground",
            "outline-none focus-visible:ring-2 focus-visible:ring-ring",
            modified && "decoration-solid decoration-primary text-foreground",
            pulsing && "motion-safe:bg-primary/15",
            triggerClassName,
          )}
        >
          {modified ? (
            <CircleDot aria-hidden className="h-3 w-3 shrink-0 text-primary" />
          ) : null}
          {displayText ? (
            <span className={cn("truncate", mono && "font-mono")}>{displayText}</span>
          ) : (
            <span className="truncate italic text-muted-foreground">{emptyLabel}</span>
          )}
          <ChevronDown
            aria-hidden
            className="h-3 w-3 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="border-b border-border px-3 py-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {fieldLabel}
          </p>
          {modified ? (
            <div className="mt-1 flex items-center gap-1.5">
              <CircleDot aria-hidden className="h-3 w-3 shrink-0 text-primary" />
              <span className="text-xs font-medium text-primary">Modified</span>
              <span className="ml-auto text-[11px] text-muted-foreground">
                Default: {defaultLabel}
              </span>
              <button
                type="button"
                aria-label={`Reset ${fieldLabel} to default`}
                onClick={handleReset}
                className="rounded p-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RotateCcw aria-hidden className="h-3.5 w-3.5 shrink-0" />
              </button>
            </div>
          ) : (
            <p className="mt-0.5 text-[11px] text-muted-foreground">Default: {defaultLabel}</p>
          )}
        </div>

        <div role="listbox" aria-label={`${fieldLabel} schemes`} className="max-h-72 overflow-y-auto p-1">
          {allowUnset ? (
            <SchemeOption
              label="Default (no override)"
              description="Inherit the workflow's built-in naming"
              active={optionActive("")}
              onSelect={() => selectScheme("")}
            />
          ) : null}
          {pool.map((opt) => (
            <SchemeOption
              key={opt.id}
              label={opt.label}
              description={opt.description}
              active={optionActive(opt.id)}
              onSelect={() => selectScheme(opt.id)}
            />
          ))}
        </div>

        {isCustom ? (
          <div className="border-t border-border p-3">
            <label
              htmlFor={`${id}-template`}
              className="mb-1.5 block text-[11px] uppercase tracking-wide text-muted-foreground"
            >
              Template
            </label>
            <TokenTemplateInput
              id={`${id}-template`}
              value={value?.template ?? ""}
              placeholder={placeholder}
              ariaLabel={`${fieldLabel} custom template`}
              onChange={(tpl) => onChange({ scheme: "custom-template", template: tpl })}
            />
            {warning ? (
              <p className="mt-2 text-[11px] text-warning">{warning}</p>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function SchemeOption({
  label,
  description,
  active,
  onSelect,
}: {
  label: string;
  description?: string;
  active: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left",
        "cursor-pointer transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <Check
        aria-hidden
        className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", active ? "text-primary" : "text-transparent")}
      />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm", active ? "font-medium text-foreground" : "text-foreground")}>
          {label}
        </span>
        {description ? (
          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
    </button>
  );
}
