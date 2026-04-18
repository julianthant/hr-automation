/**
 * SchemaForm — schema-driven form renderer for the runner drawer.
 *
 * Reads a JSON Schema (from `/api/workflows/:name/schema`) and emits inputs
 * for the operator. Designed for the mission-control HUD aesthetic: bare
 * HTML inputs styled with the runner palette + Geist Mono, no HeroUI
 * primitives (their default tan/orange leaks into the field surfaces).
 *
 * Supported types:
 *   - string                       → text input (with `pattern` if set)
 *   - string + format=email        → email input
 *   - string + enum                → select dropdown
 *   - integer / number             → number input
 *   - boolean                      → toggle row
 *   - array<string>                → tag-style chips (Enter / comma to add)
 *   - object                       → nested fieldset (recurses)
 *   - File-path heuristic on key   → text input + native <input type="file"> hint
 *
 * Validation: HTML5 `required` + `pattern` cover most cases; backend's argv
 * mapper does the final validation and throws RunnerError(400) on bad input,
 * which the drawer surfaces as a toast.
 */

import { Fragment, useState } from "react";
import { X, Plus, Folder, ChevronDown } from "lucide-react";
import {
  defaultForSchema,
  humanizeKey,
  isFilePathKey,
  isRequired,
  primaryType,
  unwrapAnyOf,
  type JsonSchema,
} from "@/lib/schema-form-utils";
import { cn } from "@/lib/utils";

// ── Field rendering primitives ─────────────────────────────

interface FieldProps {
  schema: JsonSchema;
  value: unknown;
  onChange: (next: unknown) => void;
  required: boolean;
  label: string;
  /** Used to compute animation-delay for staggered reveals. */
  index: number;
}

function FieldShell({
  label,
  required,
  hint,
  index,
  children,
}: {
  label: string;
  required: boolean;
  hint?: string;
  index: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="runner-field flex flex-col gap-1.5"
      style={{ animationDelay: `${40 * index}ms` }}
    >
      <div className="flex items-baseline justify-between">
        <label className="font-runner-mono text-[10px] tracking-[0.18em] text-runner-fg-muted uppercase">
          {label}
          {required && <span className="text-runner-accent ml-1">*</span>}
        </label>
        {hint && (
          <span className="font-runner-mono text-[10px] text-runner-fg-muted/60 italic">
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

const inputBaseClass = cn(
  "w-full",
  "bg-[#0F1116] border border-[#1F2229]",
  "px-3 py-2.5 rounded-[2px]",
  "font-runner-mono text-[13px] text-runner-fg",
  "placeholder:text-runner-fg-muted/40",
  "outline-none transition-colors duration-150",
  "hover:border-[#2A2F38]",
  "focus:border-runner-accent focus:bg-[#13151A]",
  "focus:shadow-[0_0_0_1px_rgba(245,158,11,0.4)]",
  "invalid:border-[#7F1D1D]",
);

function StringField({ schema, value, onChange, required, label, index }: FieldProps) {
  const s = unwrapAnyOf(schema);
  const isEmail = s.format === "email";
  const enumValues = Array.isArray(s.enum) ? s.enum.map(String) : null;

  if (enumValues) {
    return (
      <FieldShell label={label} required={required} index={index}>
        <div className="relative">
          <select
            className={cn(inputBaseClass, "appearance-none pr-9")}
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            required={required}
          >
            {!required && <option value="">—</option>}
            {enumValues.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-runner-fg-muted pointer-events-none" />
        </div>
      </FieldShell>
    );
  }

  return (
    <FieldShell
      label={label}
      required={required}
      index={index}
      hint={s.pattern ? `match ${s.pattern}` : undefined}
    >
      <input
        type={isEmail ? "email" : "text"}
        className={inputBaseClass}
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        pattern={s.pattern}
        minLength={s.minLength}
        maxLength={s.maxLength}
        autoComplete="off"
        spellCheck={false}
      />
    </FieldShell>
  );
}

function NumberField({ schema, value, onChange, required, label, index }: FieldProps) {
  const s = unwrapAnyOf(schema);
  const isInteger = primaryType(s) === "integer";
  return (
    <FieldShell label={label} required={required} index={index}>
      <input
        type="number"
        className={inputBaseClass}
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        min={s.minimum}
        max={s.maximum}
        step={isInteger ? 1 : "any"}
      />
    </FieldShell>
  );
}

function BooleanField({ value, onChange, label, required, index }: FieldProps) {
  return (
    <FieldShell label={label} required={required} index={index}>
      <button
        type="button"
        role="switch"
        aria-checked={Boolean(value)}
        onClick={() => onChange(!value)}
        className={cn(
          "h-7 w-12 rounded-full border transition-colors flex items-center px-0.5",
          "focus:outline-none focus:ring-2 focus:ring-runner-accent/40",
          value
            ? "bg-runner-accent/20 border-runner-accent/60 justify-end"
            : "bg-[#0F1116] border-[#1F2229] justify-start",
        )}
      >
        <span
          className={cn(
            "h-5 w-5 rounded-full transition-colors",
            value ? "bg-runner-accent" : "bg-[#3F4350]",
          )}
        />
      </button>
    </FieldShell>
  );
}

function FilePathField({ schema, value, onChange, label, required, index }: FieldProps) {
  // The browser can't surface absolute paths from <input type="file"> for
  // security reasons. We expose the picker as a hint — clicking it sets the
  // file's name (which the operator usually pastes the full path into).
  return (
    <FieldShell
      label={label}
      required={required}
      index={index}
      hint="absolute path"
    >
      <div className="flex gap-2">
        <input
          type="text"
          className={inputBaseClass}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          pattern={schema.pattern}
          autoComplete="off"
          spellCheck={false}
          placeholder="/path/to/file.yml"
        />
        <label
          className={cn(
            "shrink-0 flex items-center gap-2 px-3 py-2.5 cursor-pointer",
            "bg-[#0F1116] border border-[#1F2229] rounded-[2px]",
            "font-runner-mono text-[11px] tracking-[0.1em] text-runner-fg-muted uppercase",
            "hover:border-[#2A2F38] hover:text-runner-fg transition-colors",
          )}
        >
          <Folder className="w-3.5 h-3.5" />
          File
          <input
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onChange(f.name);
            }}
          />
        </label>
      </div>
    </FieldShell>
  );
}

function ArrayOfStringsField({ schema, value, onChange, label, required, index }: FieldProps) {
  const s = unwrapAnyOf(schema);
  const items: string[] = Array.isArray(value) ? value.map(String) : [];
  const [draft, setDraft] = useState("");

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    // Support comma-separated paste: split on comma, push each.
    const parts = trimmed.split(",").map((p) => p.trim()).filter(Boolean);
    onChange([...items, ...parts]);
    setDraft("");
  };

  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));

  return (
    <FieldShell
      label={label}
      required={required}
      index={index}
      hint={s.minItems ? `min ${s.minItems}` : "press enter or ,"}
    >
      <div
        className={cn(
          "flex flex-wrap gap-1.5 p-2 min-h-[42px]",
          "bg-[#0F1116] border border-[#1F2229] rounded-[2px]",
          "focus-within:border-runner-accent focus-within:shadow-[0_0_0_1px_rgba(245,158,11,0.4)]",
          "transition-colors",
        )}
      >
        {items.map((item, i) => (
          <span
            key={`${item}-${i}`}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded-[2px]",
              "bg-runner-accent/10 border border-runner-accent/30",
              "font-runner-mono text-[11px] text-runner-fg",
            )}
          >
            {item}
            <button
              type="button"
              onClick={() => remove(i)}
              className="text-runner-fg-muted hover:text-runner-accent transition-colors"
              aria-label={`Remove ${item}`}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <input
          type="text"
          className={cn(
            "flex-1 min-w-[140px] bg-transparent outline-none",
            "font-runner-mono text-[12px] text-runner-fg",
            "placeholder:text-runner-fg-muted/40",
          )}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && !draft && items.length > 0) {
              remove(items.length - 1);
            }
          }}
          onBlur={commit}
          placeholder={items.length === 0 ? "add value…" : ""}
        />
        {draft && (
          <button
            type="button"
            onClick={commit}
            className="self-center text-runner-fg-muted hover:text-runner-accent transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </FieldShell>
  );
}

function ObjectField({ schema, value, onChange, label, index }: FieldProps) {
  const s = unwrapAnyOf(schema);
  const obj = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return (
    <div
      className="runner-field"
      style={{ animationDelay: `${40 * index}ms` }}
    >
      <div className="font-runner-mono text-[10px] tracking-[0.18em] text-runner-accent/70 uppercase mb-3 flex items-center gap-2">
        <span className="h-px flex-1 bg-runner-accent/20" />
        <span>{label}</span>
        <span className="h-px flex-1 bg-runner-accent/20" />
      </div>
      <div className="flex flex-col gap-3 pl-3 border-l border-runner-accent/15">
        {Object.entries(s.properties ?? {}).map(([k, childSchema], i) => (
          <Field
            key={k}
            schema={childSchema}
            value={obj[k]}
            onChange={(next) => onChange({ ...obj, [k]: next })}
            required={isRequired(s, k)}
            label={humanizeKey(k)}
            index={i}
            propKey={k}
          />
        ))}
      </div>
    </div>
  );
}

interface DispatchProps extends FieldProps {
  /** Original property key — needed for file-path heuristic. */
  propKey?: string;
}

function Field({ schema, value, onChange, required, label, index, propKey }: DispatchProps) {
  const s = unwrapAnyOf(schema);
  const t = primaryType(s);

  if (t === "object" && s.properties) {
    return (
      <ObjectField
        schema={s}
        value={value}
        onChange={onChange}
        required={required}
        label={label}
        index={index}
      />
    );
  }
  if (t === "array" && s.items) {
    const itemType = primaryType(unwrapAnyOf(s.items));
    if (itemType === "string" || itemType === "integer" || itemType === "number") {
      return (
        <ArrayOfStringsField
          schema={s}
          value={value}
          onChange={onChange}
          required={required}
          label={label}
          index={index}
        />
      );
    }
    // Fallback for arrays of objects (e.g. emergency-contact records) —
    // we treat them as advanced and ask the operator to use the YAML path
    // instead. This is rendered as a read-only note.
    return (
      <FieldShell label={label} required={required} index={index}>
        <div className="font-runner-mono text-[11px] text-runner-fg-muted italic px-3 py-2 bg-[#0F1116] border border-[#1F2229] rounded-[2px]">
          Complex array — provide via YAML path instead.
        </div>
      </FieldShell>
    );
  }
  if (t === "boolean") {
    return (
      <BooleanField
        schema={s}
        value={value}
        onChange={onChange}
        required={required}
        label={label}
        index={index}
      />
    );
  }
  if (t === "integer" || t === "number") {
    return (
      <NumberField
        schema={s}
        value={value}
        onChange={onChange}
        required={required}
        label={label}
        index={index}
      />
    );
  }
  // string is the default. File-path heuristic upgrades the input.
  if (propKey && isFilePathKey(propKey)) {
    return (
      <FilePathField
        schema={s}
        value={value}
        onChange={onChange}
        required={required}
        label={label}
        index={index}
      />
    );
  }
  return (
    <StringField
      schema={s}
      value={value}
      onChange={onChange}
      required={required}
      label={label}
      index={index}
    />
  );
}

// ── SchemaForm public component ──────────────────────────

export interface SchemaFormProps {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

/**
 * Top-level form renderer. Iterates the schema's `properties` and emits one
 * Field per top-level property, in declaration order. Required fields come
 * first in source order — JSON Schema doesn't guarantee property ordering
 * but Node's JSON.parse preserves insertion order so we just trust it.
 */
export function SchemaForm({ schema, value, onChange }: SchemaFormProps) {
  const root = unwrapAnyOf(schema);
  const properties = root.properties ?? {};

  // Sort: required fields first, then optional. Within each group keep
  // insertion order so the schema's intent shines through.
  const entries = Object.entries(properties);
  const required = entries.filter(([k]) => isRequired(root, k));
  const optional = entries.filter(([k]) => !isRequired(root, k));
  const ordered = [...required, ...optional];

  return (
    <Fragment>
      {ordered.map(([k, childSchema], i) => (
        <Field
          key={k}
          schema={childSchema}
          value={value[k]}
          onChange={(next) => onChange({ ...value, [k]: next })}
          required={isRequired(root, k)}
          label={humanizeKey(k)}
          index={i}
          propKey={k}
        />
      ))}
    </Fragment>
  );
}

/** Build initial form state from a schema (all defaults). */
export function buildInitialFormValue(schema: JsonSchema): Record<string, unknown> {
  const root = unwrapAnyOf(schema);
  return defaultForSchema(root) as Record<string, unknown>;
}
