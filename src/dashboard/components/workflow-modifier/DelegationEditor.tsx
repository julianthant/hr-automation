import type {
  DelegationDisplayConfig,
  NamingPartTitle,
  NamingPartSubtitle,
  TitleSchemeId,
  SubtitleSchemeId,
} from "../../../domain/workflow-presentation/types.js";
import type { WorkflowPresentationDetail, WorkflowOverride } from "./useWorkflowPresentation.js";

interface Props {
  data: WorkflowPresentationDetail;
  draft: WorkflowOverride;
  onChange: (next: WorkflowOverride) => void;
}

export function DelegationEditor({ data, draft, onChange }: Props): JSX.Element {
  const lib = data.schemeLibrary;
  const del: DelegationDisplayConfig =
    draft.presentation?.delegation ?? data.effective.presentation?.delegation ?? {};

  const setBlock = (value: DelegationDisplayConfig) =>
    onChange({ ...draft, presentation: { ...(draft.presentation ?? {}), delegation: value } });

  return (
    <section className="rounded-md border border-border p-4">
      <h3 className="text-sm font-semibold mb-3">Delegation Display</h3>

      {/* memberTitle */}
      {(() => {
        const cur: NamingPartTitle | undefined = del.memberTitle;
        return (
          <div className="mb-3">
            <label
              htmlFor="delegation-member-title"
              className="block text-xs uppercase text-muted-foreground mb-1"
            >
              Member title
            </label>
            <select
              id="delegation-member-title"
              value={cur?.scheme ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setBlock({
                  ...del,
                  memberTitle: v
                    ? { scheme: v as TitleSchemeId, template: cur?.template }
                    : undefined,
                });
              }}
              className="border border-border rounded px-2 py-1 w-full bg-background text-foreground"
            >
              <option value="">— Default (no override) —</option>
              {lib.title.map((s) => (
                <option key={s.id} value={s.id} title={s.description}>
                  {s.label}
                </option>
              ))}
            </select>
            {cur?.scheme === "custom-template" && (
              <input
                aria-label="member title custom template"
                value={cur.template ?? ""}
                placeholder="e.g. {name} ({emplId})"
                onChange={(e) =>
                  setBlock({
                    ...del,
                    memberTitle: { scheme: "custom-template", template: e.target.value },
                  })
                }
                className="mt-1 border border-border rounded px-2 py-1 w-full font-mono text-sm bg-background text-foreground"
              />
            )}
          </div>
        );
      })()}

      {/* memberSubtitle */}
      {(() => {
        const cur: NamingPartSubtitle | undefined = del.memberSubtitle;
        return (
          <div className="mb-3">
            <label
              htmlFor="delegation-member-subtitle"
              className="block text-xs uppercase text-muted-foreground mb-1"
            >
              Member subtitle
            </label>
            <select
              id="delegation-member-subtitle"
              value={cur?.scheme ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setBlock({
                  ...del,
                  memberSubtitle: v
                    ? { scheme: v as SubtitleSchemeId, template: cur?.template }
                    : undefined,
                });
              }}
              className="border border-border rounded px-2 py-1 w-full bg-background text-foreground"
            >
              <option value="">— Default (no override) —</option>
              {lib.subtitle.map((s) => (
                <option key={s.id} value={s.id} title={s.description}>
                  {s.label}
                </option>
              ))}
            </select>
            {cur?.scheme === "custom-template" && (
              <input
                aria-label="member subtitle custom template"
                value={cur.template ?? ""}
                placeholder="e.g. {eid} · {code}"
                onChange={(e) =>
                  setBlock({
                    ...del,
                    memberSubtitle: { scheme: "custom-template", template: e.target.value },
                  })
                }
                className="mt-1 border border-border rounded px-2 py-1 w-full font-mono text-sm bg-background text-foreground"
              />
            )}
          </div>
        );
      })()}

      {/* Hint: member naming requires both fields */}
      <p className="mb-3 text-xs text-muted-foreground">
        Member naming only takes effect when <em>both</em> Member title and Member subtitle are set.
      </p>

      {/* prepTitle */}
      {(() => {
        const cur: NamingPartTitle | undefined = del.prepTitle;
        return (
          <div className="mb-3">
            <label
              htmlFor="delegation-prep-title"
              className="block text-xs uppercase text-muted-foreground mb-1"
            >
              Prep title
            </label>
            <select
              id="delegation-prep-title"
              value={cur?.scheme ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setBlock({
                  ...del,
                  prepTitle: v
                    ? { scheme: v as TitleSchemeId, template: cur?.template }
                    : undefined,
                });
              }}
              className="border border-border rounded px-2 py-1 w-full bg-background text-foreground"
            >
              <option value="">— Default (no override) —</option>
              {lib.title.map((s) => (
                <option key={s.id} value={s.id} title={s.description}>
                  {s.label}
                </option>
              ))}
            </select>
            {cur?.scheme === "custom-template" && (
              <input
                aria-label="prep title custom template"
                value={cur.template ?? ""}
                placeholder="e.g. {name} — Prep"
                onChange={(e) =>
                  setBlock({
                    ...del,
                    prepTitle: { scheme: "custom-template", template: e.target.value },
                  })
                }
                className="mt-1 border border-border rounded px-2 py-1 w-full font-mono text-sm bg-background text-foreground"
              />
            )}
          </div>
        );
      })()}

      {/* coordinatorLabelSuffix */}
      <div className="mb-1">
        <label
          htmlFor="delegation-coordinator-suffix"
          className="block text-xs uppercase text-muted-foreground mb-1"
        >
          Coordinator label suffix
        </label>
        <input
          id="delegation-coordinator-suffix"
          type="text"
          value={del.coordinatorLabelSuffix ?? ""}
          placeholder="e.g. Operation"
          onChange={(e) =>
            setBlock({
              ...del,
              coordinatorLabelSuffix: e.target.value || undefined,
            })
          }
          className="border border-border rounded px-2 py-1 w-full bg-background text-foreground"
        />
      </div>
    </section>
  );
}
