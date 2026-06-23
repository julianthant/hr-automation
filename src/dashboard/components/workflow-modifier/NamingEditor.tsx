import type { NamingConfig, TitleSchemeId, SubtitleSchemeId, TraceSchemeId } from "../../../domain/workflow-presentation/types.js";
import type { WorkflowPresentationDetail, WorkflowOverride } from "./useWorkflowPresentation.js";
import { SchemePartSelect } from "./SchemePartSelect.js";

interface Props {
  data: WorkflowPresentationDetail;
  draft: WorkflowOverride;
  onChange: (next: WorkflowOverride) => void;
}

export function NamingEditor({ data, draft, onChange }: Props): JSX.Element {
  const lib = data.schemeLibrary;
  const naming: NamingConfig =
    draft.presentation?.naming ?? data.effective.presentation?.naming ?? {};

  const setPart = (
    part: "title" | "subtitle" | "trace",
    value: NamingConfig["title"] | NamingConfig["subtitle"] | NamingConfig["trace"],
  ) => {
    const next: NamingConfig = { ...naming, [part]: value };
    onChange({ ...draft, presentation: { ...(draft.presentation ?? {}), naming: next } });
  };

  return (
    <section className="rounded-md border border-border p-4">
      <h3 className="text-sm font-semibold mb-3">Naming</h3>

      <div className="mb-3">
        <SchemePartSelect
          id="naming-title"
          label="Title"
          options={lib.title}
          value={naming.title}
          allowUnset={false}
          placeholder="e.g. {name} ({emplId})"
          templateAriaLabel="title custom template"
          onChange={(next) =>
            setPart("title", next ? { scheme: next.scheme as TitleSchemeId, template: next.template } : undefined)
          }
        />
      </div>

      <div className="mb-3">
        <SchemePartSelect
          id="naming-subtitle"
          label="Subtitle"
          options={lib.subtitle}
          value={naming.subtitle}
          allowUnset={false}
          placeholder="e.g. Oath · {runId4}"
          templateAriaLabel="subtitle custom template"
          onChange={(next) =>
            setPart("subtitle", next ? { scheme: next.scheme as SubtitleSchemeId, template: next.template } : undefined)
          }
        />
      </div>

      <div className="mb-1">
        <SchemePartSelect
          id="naming-trace"
          label="Trace id"
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
      </div>
    </section>
  );
}
