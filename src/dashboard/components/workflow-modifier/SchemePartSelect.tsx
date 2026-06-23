import type { SchemeMeta } from "../../../domain/workflow-presentation/schemes.js";

export interface SchemePartValue {
  scheme: string;
  template?: string;
}

export interface SchemePartSelectProps {
  id: string;
  label: string;
  options: SchemeMeta[];
  value: SchemePartValue | undefined;
  onChange: (next: SchemePartValue | undefined) => void;
  allowUnset?: boolean;
  warning?: string;
  placeholder?: string;
  templateAriaLabel?: string;
}

export function SchemePartSelect({
  id,
  label,
  options,
  value,
  onChange,
  allowUnset = false,
  warning,
  placeholder,
  templateAriaLabel,
}: SchemePartSelectProps): JSX.Element {
  const effective: SchemePartValue = allowUnset
    ? (value ?? { scheme: "" })
    : (value ?? { scheme: options[0].id });

  const currentTemplate = effective.template;

  return (
    <>
      <label htmlFor={id} className="block text-xs uppercase text-muted-foreground mb-1">
        {label}
      </label>
      <select
        id={id}
        value={allowUnset ? (value?.scheme ?? "") : effective.scheme}
        onChange={(e) => {
          const v = e.target.value;
          if (allowUnset && v === "") {
            onChange(undefined);
          } else {
            onChange({ scheme: v, template: currentTemplate });
          }
        }}
        className="border border-border rounded px-2 py-1 w-full bg-background text-foreground"
      >
        {allowUnset && <option value="">— Default (no override) —</option>}
        {options.map((s) => (
          <option key={s.id} value={s.id} title={s.description}>
            {s.label}
          </option>
        ))}
      </select>
      {effective.scheme === "custom-template" && (
        <>
          <input
            aria-label={templateAriaLabel}
            value={effective.template ?? ""}
            placeholder={placeholder}
            onChange={(e) => onChange({ scheme: "custom-template", template: e.target.value })}
            className="mt-1 border border-border rounded px-2 py-1 w-full font-mono text-sm bg-background text-foreground"
          />
          {warning && <p className="mt-1 text-xs text-warning">{warning}</p>}
        </>
      )}
    </>
  );
}
