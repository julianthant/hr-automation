import type { NamingConfig, TitleSchemeId, SubtitleSchemeId, TraceSchemeId } from "../../../domain/workflow-presentation/types.js";
import type { WorkflowPresentationDetail, WorkflowOverride } from "./useWorkflowPresentation.js";
import { SchemePartSelect } from "./SchemePartSelect.js";
import { OverrideField } from "./OverrideField.js";

interface Props {
  data: WorkflowPresentationDetail;
  draft: WorkflowOverride;
  onChange: (next: WorkflowOverride) => void;
}

export function NamingEditor({ data, draft, onChange }: Props): JSX.Element {
  const lib = data.schemeLibrary;
  // Current displayed value = draft ?? effective (base ⊕ saved override)
  const naming: NamingConfig =
    draft.presentation?.naming ?? data.effective.presentation?.naming ?? {};
  // Base defaults (code defaults)
  const baseNaming: NamingConfig = data.base.presentation?.naming ?? {};

  const setPart = (
    part: "title" | "subtitle" | "trace",
    value: NamingConfig["title"] | NamingConfig["subtitle"] | NamingConfig["trace"],
  ) => {
    const next: NamingConfig = { ...naming, [part]: value };
    onChange({ ...draft, presentation: { ...(draft.presentation ?? {}), naming: next } });
  };

  const resetPart = (part: "title" | "subtitle" | "trace") => {
    const next: NamingConfig = { ...naming };
    delete next[part];
    const hasMeaningful = Object.keys(next).length > 0;
    const nextPresentation = { ...(draft.presentation ?? {}), naming: hasMeaningful ? next : undefined };
    onChange({ ...draft, presentation: nextPresentation });
  };

  // Modified ⟺ the leaf is present in draft
  const titleModified = draft.presentation?.naming?.title !== undefined;
  const subtitleModified = draft.presentation?.naming?.subtitle !== undefined;
  const traceModified = draft.presentation?.naming?.trace !== undefined;

  const schemeLabel = (scheme: string | undefined, pool: { id: string; label: string }[]): string | undefined => {
    if (!scheme) return undefined;
    return pool.find((s) => s.id === scheme)?.label ?? scheme;
  };

  return (
    <div className="space-y-5">
      <OverrideField
        label="Title"
        htmlFor="naming-title"
        modified={titleModified}
        defaultHint={schemeLabel(baseNaming.title?.scheme, lib.title)}
        onReset={() => resetPart("title")}
      >
        <SchemePartSelect
          id="naming-title"
          label=""
          options={lib.title}
          value={naming.title}
          allowUnset={false}
          placeholder="e.g. {name} ({emplId})"
          templateAriaLabel="title custom template"
          onChange={(next) =>
            setPart("title", next ? { scheme: next.scheme as TitleSchemeId, template: next.template } : undefined)
          }
        />
      </OverrideField>

      <OverrideField
        label="Subtitle"
        htmlFor="naming-subtitle"
        modified={subtitleModified}
        defaultHint={schemeLabel(baseNaming.subtitle?.scheme, lib.subtitle)}
        onReset={() => resetPart("subtitle")}
      >
        <SchemePartSelect
          id="naming-subtitle"
          label=""
          options={lib.subtitle}
          value={naming.subtitle}
          allowUnset={false}
          placeholder="e.g. Oath · {runId4}"
          templateAriaLabel="subtitle custom template"
          onChange={(next) =>
            setPart("subtitle", next ? { scheme: next.scheme as SubtitleSchemeId, template: next.template } : undefined)
          }
        />
      </OverrideField>

      <OverrideField
        label="Trace id"
        htmlFor="naming-trace"
        modified={traceModified}
        defaultHint={schemeLabel(baseNaming.trace?.scheme, lib.trace)}
        onReset={() => resetPart("trace")}
      >
        <SchemePartSelect
          id="naming-trace"
          label=""
          options={lib.trace}
          value={naming.trace}
          allowUnset={false}
          placeholder="e.g. {code}-{runId4}"
          templateAriaLabel="trace custom template"
          warning="Only affects new runs; existing trace ids never change."
          onChange={(next) =>
            setPart("trace", next ? { scheme: next.scheme as TraceSchemeId, template: next.template } : undefined)
          }
        />
      </OverrideField>
    </div>
  );
}
