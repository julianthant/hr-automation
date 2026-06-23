import type {
  DelegationDisplayConfig,
  TitleSchemeId,
  SubtitleSchemeId,
} from "../../../domain/workflow-presentation/types.js";
import type { WorkflowPresentationDetail, WorkflowOverride } from "./useWorkflowPresentation.js";
import { SchemePartSelect } from "./SchemePartSelect.js";

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

      <div className="mb-3">
        <SchemePartSelect
          id="delegation-member-title"
          label="Member title"
          options={lib.title}
          value={del.memberTitle}
          allowUnset={true}
          placeholder="e.g. {name} ({emplId})"
          templateAriaLabel="member title custom template"
          onChange={(next) =>
            setBlock({
              ...del,
              memberTitle: next ? { scheme: next.scheme as TitleSchemeId, template: next.template } : undefined,
            })
          }
        />
      </div>

      <div className="mb-3">
        <SchemePartSelect
          id="delegation-member-subtitle"
          label="Member subtitle"
          options={lib.subtitle}
          value={del.memberSubtitle}
          allowUnset={true}
          placeholder="e.g. {eid} · {code}"
          templateAriaLabel="member subtitle custom template"
          onChange={(next) =>
            setBlock({
              ...del,
              memberSubtitle: next ? { scheme: next.scheme as SubtitleSchemeId, template: next.template } : undefined,
            })
          }
        />
      </div>

      {/* Hint: member naming requires both fields */}
      <p className="mb-3 text-xs text-muted-foreground">
        Member naming only takes effect when <em>both</em> Member title and Member subtitle are set.
      </p>

      <div className="mb-3">
        <SchemePartSelect
          id="delegation-prep-title"
          label="Prep title"
          options={lib.title}
          value={del.prepTitle}
          allowUnset={true}
          placeholder="e.g. {name} — Prep"
          templateAriaLabel="prep title custom template"
          onChange={(next) =>
            setBlock({
              ...del,
              prepTitle: next ? { scheme: next.scheme as TitleSchemeId, template: next.template } : undefined,
            })
          }
        />
      </div>

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
