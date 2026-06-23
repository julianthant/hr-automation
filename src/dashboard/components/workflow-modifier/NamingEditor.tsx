import type { NamingConfig, TitleSchemeId, SubtitleSchemeId, TraceSchemeId } from "../../../domain/workflow-presentation/types.js";
import type { WorkflowPresentationDetail, WorkflowOverride } from "./useWorkflowPresentation.js";

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

      {/* Title */}
      {(() => {
        const cur = naming.title ?? { scheme: lib.title[0].id as TitleSchemeId };
        return (
          <div className="mb-3">
            <label htmlFor="naming-title" className="block text-xs uppercase text-muted-foreground mb-1">
              Title
            </label>
            <select
              id="naming-title"
              value={cur.scheme}
              onChange={(e) =>
                setPart("title", {
                  scheme: e.target.value as TitleSchemeId,
                  template: cur.template,
                })
              }
              className="border border-border rounded px-2 py-1 w-full bg-background text-foreground"
            >
              {lib.title.map((s) => (
                <option key={s.id} value={s.id} title={s.description}>
                  {s.label}
                </option>
              ))}
            </select>
            {cur.scheme === "custom-template" && (
              <input
                aria-label="title custom template"
                value={cur.template ?? ""}
                placeholder="e.g. {name} ({emplId})"
                onChange={(e) =>
                  setPart("title", { scheme: "custom-template", template: e.target.value })
                }
                className="mt-1 border border-border rounded px-2 py-1 w-full font-mono text-sm bg-background text-foreground"
              />
            )}
          </div>
        );
      })()}

      {/* Subtitle */}
      {(() => {
        const cur = naming.subtitle ?? { scheme: lib.subtitle[0].id as SubtitleSchemeId };
        return (
          <div className="mb-3">
            <label htmlFor="naming-subtitle" className="block text-xs uppercase text-muted-foreground mb-1">
              Subtitle
            </label>
            <select
              id="naming-subtitle"
              value={cur.scheme}
              onChange={(e) =>
                setPart("subtitle", {
                  scheme: e.target.value as SubtitleSchemeId,
                  template: cur.template,
                })
              }
              className="border border-border rounded px-2 py-1 w-full bg-background text-foreground"
            >
              {lib.subtitle.map((s) => (
                <option key={s.id} value={s.id} title={s.description}>
                  {s.label}
                </option>
              ))}
            </select>
            {cur.scheme === "custom-template" && (
              <input
                aria-label="subtitle custom template"
                value={cur.template ?? ""}
                placeholder="e.g. Oath · {runId4}"
                onChange={(e) =>
                  setPart("subtitle", { scheme: "custom-template", template: e.target.value })
                }
                className="mt-1 border border-border rounded px-2 py-1 w-full font-mono text-sm bg-background text-foreground"
              />
            )}
          </div>
        );
      })()}

      {/* Trace */}
      {(() => {
        const cur = naming.trace ?? { scheme: lib.trace[0].id as TraceSchemeId };
        return (
          <div className="mb-1">
            <label htmlFor="naming-trace" className="block text-xs uppercase text-muted-foreground mb-1">
              Trace id
            </label>
            <select
              id="naming-trace"
              value={cur.scheme}
              onChange={(e) =>
                setPart("trace", {
                  scheme: e.target.value as TraceSchemeId,
                  template: cur.template,
                })
              }
              className="border border-border rounded px-2 py-1 w-full bg-background text-foreground"
            >
              {lib.trace.map((s) => (
                <option key={s.id} value={s.id} title={s.description}>
                  {s.label}
                </option>
              ))}
            </select>
            {cur.scheme === "custom-template" && (
              <>
                <input
                  aria-label="trace custom template"
                  value={cur.template ?? ""}
                  placeholder="e.g. {code}-{runId4}"
                  onChange={(e) =>
                    setPart("trace", { scheme: "custom-template", template: e.target.value })
                  }
                  className="mt-1 border border-border rounded px-2 py-1 w-full font-mono text-sm bg-background text-foreground"
                />
                <p className="mt-1 text-xs text-warning">
                  Only affects new runs; existing trace ids never change.
                </p>
              </>
            )}
          </div>
        );
      })()}
    </section>
  );
}
