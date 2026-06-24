import type {
  DelegationDisplayConfig,
  TitleSchemeId,
  SubtitleSchemeId,
} from "../../../domain/workflow-presentation/types.js";
import type { WorkflowPresentationDetail, WorkflowOverride } from "./useWorkflowPresentation.js";
import { SchemePartSelect } from "./SchemePartSelect.js";
import { OverrideField } from "./OverrideField.js";

interface Props {
  data: WorkflowPresentationDetail;
  draft: WorkflowOverride;
  onChange: (next: WorkflowOverride) => void;
}

export function DelegationEditor({ data, draft, onChange }: Props): JSX.Element {
  const lib = data.schemeLibrary;
  const del: DelegationDisplayConfig =
    draft.presentation?.delegation ?? data.effective.presentation?.delegation ?? {};
  const baseDel: DelegationDisplayConfig =
    data.base.presentation?.delegation ?? {};

  const setBlock = (value: DelegationDisplayConfig) =>
    onChange({ ...draft, presentation: { ...(draft.presentation ?? {}), delegation: value } });

  const resetField = (field: keyof DelegationDisplayConfig) => {
    const next = { ...del };
    delete next[field];
    setBlock(next);
  };

  const schemeLabel = (scheme: string | undefined, pool: { id: string; label: string }[]): string | undefined => {
    if (!scheme) return undefined;
    return pool.find((s) => s.id === scheme)?.label ?? scheme;
  };

  // Modified ⟺ the field is present in draft.presentation.delegation
  const draftDel = draft.presentation?.delegation;
  const memberTitleModified = draftDel?.memberTitle !== undefined;
  const memberSubtitleModified = draftDel?.memberSubtitle !== undefined;
  const prepTitleModified = draftDel?.prepTitle !== undefined;
  const coordinatorSuffixModified = draftDel?.coordinatorLabelSuffix !== undefined;

  return (
    <div className="space-y-5">
      <OverrideField
        label="Member title"
        htmlFor="delegation-member-title"
        modified={memberTitleModified}
        defaultHint={schemeLabel(baseDel.memberTitle?.scheme, lib.title) ?? "Default (no override)"}
        onReset={() => resetField("memberTitle")}
      >
        <SchemePartSelect
          id="delegation-member-title"
          label=""
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
      </OverrideField>

      <OverrideField
        label="Member subtitle"
        htmlFor="delegation-member-subtitle"
        modified={memberSubtitleModified}
        defaultHint={schemeLabel(baseDel.memberSubtitle?.scheme, lib.subtitle) ?? "Default (no override)"}
        onReset={() => resetField("memberSubtitle")}
      >
        <SchemePartSelect
          id="delegation-member-subtitle"
          label=""
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
      </OverrideField>

      {/* Hint: member naming requires both fields */}
      <p className="text-xs text-muted-foreground -mt-2">
        Member naming only takes effect when <em>both</em> Member title and Member subtitle are set.
      </p>

      <OverrideField
        label="Prep title"
        htmlFor="delegation-prep-title"
        modified={prepTitleModified}
        defaultHint={schemeLabel(baseDel.prepTitle?.scheme, lib.title) ?? "Default (no override)"}
        onReset={() => resetField("prepTitle")}
      >
        <SchemePartSelect
          id="delegation-prep-title"
          label=""
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
      </OverrideField>

      {/* coordinatorLabelSuffix */}
      <OverrideField
        label="Coordinator label suffix"
        htmlFor="delegation-coordinator-suffix"
        modified={coordinatorSuffixModified}
        defaultHint={baseDel.coordinatorLabelSuffix ?? "None"}
        onReset={() => resetField("coordinatorLabelSuffix")}
      >
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
          className="border border-border rounded px-2 py-1 w-full bg-background text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </OverrideField>
    </div>
  );
}
