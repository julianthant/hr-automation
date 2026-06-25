import { useState } from "react";
import { CircleDot, GitFork, RotateCcw, ScanText, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import type {
  TitleSchemeId,
  SubtitleSchemeId,
} from "../../../domain/workflow-presentation/types.js";
import type { WorkflowPresentationDetail, WorkflowOverride } from "./useWorkflowPresentation.js";
import { SchemeHotspot, type SchemeValue } from "./SchemeHotspot.js";
import {
  DEFAULT_MEMBER_TITLE_SCHEME,
  DEFAULT_MEMBER_SUBTITLE_SCHEME,
  DEFAULT_PREP_TITLE_SCHEME,
  previewTitle,
  previewSubtitle,
  schemeLabel,
  setDelegationField,
  buildSampleVars,
  buildSecondMemberVars,
  isDelegatingWorkflow,
  countDelegation,
} from "./blueprint-helpers.js";

interface Props {
  workflowName: string;
  data: WorkflowPresentationDetail;
  draft: WorkflowOverride;
  onChange: (next: WorkflowOverride) => void;
}

/**
 * Plate ③. The fan-out drawn as a real tree: a coordinator branching to a Prep
 * row and the member template. Non-delegating workflows get a quiet inert state
 * rather than a broken-looking empty tree.
 */
export function DelegationPlate({ workflowName, data, draft, onChange }: Props): JSX.Element {
  const lib = data.schemeLibrary;
  const del = draft.presentation?.delegation ?? {};
  const baseDel = data.base.presentation?.delegation ?? {};
  const label = data.effective.label ?? workflowName;
  const vars1 = buildSampleVars(label);
  const vars2 = buildSecondMemberVars(label);

  const editable = isDelegatingWorkflow(workflowName) || countDelegation(draft) > 0;
  if (!editable) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-dashed border-border bg-card/40 px-3.5 py-3">
        <GitFork aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          This workflow doesn't delegate. Coordinator and member naming apply only to
          workflows that fan out to child rows.
        </p>
      </div>
    );
  }

  const memberTitleSet = del.memberTitle !== undefined;
  const memberSubtitleSet = del.memberSubtitle !== undefined;
  const memberNeedsBoth = memberTitleSet !== memberSubtitleSet; // xor

  const memberTitleText = previewTitle(
    vars1,
    del.memberTitle ?? { scheme: DEFAULT_MEMBER_TITLE_SCHEME as TitleSchemeId },
  );
  const memberSubtitleText = previewSubtitle(
    vars1,
    del.memberSubtitle ?? { scheme: DEFAULT_MEMBER_SUBTITLE_SCHEME as SubtitleSchemeId },
  );
  const member2TitleText = previewTitle(
    vars2,
    del.memberTitle ?? { scheme: DEFAULT_MEMBER_TITLE_SCHEME as TitleSchemeId },
  );
  const member2SubtitleText = previewSubtitle(
    vars2,
    del.memberSubtitle ?? { scheme: DEFAULT_MEMBER_SUBTITLE_SCHEME as SubtitleSchemeId },
  );
  const prepTitleText = previewTitle(
    vars1,
    del.prepTitle ?? { scheme: DEFAULT_PREP_TITLE_SCHEME as TitleSchemeId },
  );

  return (
    <div className="space-y-1">
      <p className="mb-2 text-[11px] text-muted-foreground">
        How delegated child rows read when this workflow fans out.
      </p>

      {/* Coordinator */}
      <div className="rounded-lg border border-border bg-card px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[14px] font-semibold text-foreground">{label}</span>
          <SuffixEditor
            value={del.coordinatorLabelSuffix}
            modified={del.coordinatorLabelSuffix !== undefined}
            defaultHint={baseDel.coordinatorLabelSuffix ?? "None"}
            onChange={(text) =>
              onChange(setDelegationField(draft, "coordinatorLabelSuffix", text))
            }
            onReset={() => onChange(setDelegationField(draft, "coordinatorLabelSuffix", undefined))}
          />
          <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
            Coordinator
          </span>
        </div>
      </div>

      {/* Branches */}
      <div className="relative ml-3 space-y-2 border-l border-border pl-5 pt-2">
        {/* Prep row */}
        <div className="relative rounded-lg border border-border bg-card px-3.5 py-2.5">
          <span aria-hidden className="absolute -left-5 top-1/2 h-px w-5 bg-border" />
          <div className="flex items-center gap-2">
            <ScanText aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <SchemeHotspot
              id="delegation-prep-title"
              fieldLabel="prep title"
              displayText={prepTitleText}
              emptyLabel="(no prep title)"
              triggerClassName="text-[13px] font-medium"
              pool={lib.title}
              value={del.prepTitle}
              allowUnset
              modified={del.prepTitle !== undefined}
              defaultLabel={schemeLabel(baseDel.prepTitle?.scheme, lib.title, "Default (no override)")}
              placeholder="e.g. {name} — Prep"
              onChange={(v: SchemeValue | undefined) =>
                onChange(
                  setDelegationField(
                    draft,
                    "prepTitle",
                    v ? { scheme: v.scheme as TitleSchemeId, template: v.template } : undefined,
                  ),
                )
              }
              onReset={() => onChange(setDelegationField(draft, "prepTitle", undefined))}
            />
            <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
              Prep row
            </span>
          </div>
        </div>

        {/* Member template (stacked to imply "all members") */}
        <div className="relative">
          <span aria-hidden className="absolute -left-5 top-7 h-px w-5 bg-border" />
          {/* ghost card behind, showing the same config on a second person */}
          <div className="absolute inset-x-2 top-1.5 rounded-lg border border-border bg-card/40 px-3.5 py-2.5">
            <p className="truncate text-[13px] font-medium text-muted-foreground/70">
              {member2TitleText}
            </p>
            <p className="truncate text-[11px] text-muted-foreground/50">{member2SubtitleText}</p>
          </div>
          <div className="relative rounded-lg border border-border bg-card px-3.5 py-2.5">
            <div className="mb-1 flex items-center gap-2">
              <Users aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <SchemeHotspot
                id="delegation-member-title"
                fieldLabel="member title"
                displayText={memberTitleText}
                emptyLabel="(no member title)"
                triggerClassName="text-[13px] font-medium"
                pool={lib.title}
                value={del.memberTitle}
                allowUnset
                modified={memberTitleSet}
                defaultLabel={schemeLabel(baseDel.memberTitle?.scheme, lib.title, "Default (no override)")}
                placeholder="e.g. {name} ({emplId})"
                onChange={(v: SchemeValue | undefined) =>
                  onChange(
                    setDelegationField(
                      draft,
                      "memberTitle",
                      v ? { scheme: v.scheme as TitleSchemeId, template: v.template } : undefined,
                    ),
                  )
                }
                onReset={() => onChange(setDelegationField(draft, "memberTitle", undefined))}
              />
              <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">
                Each member
              </span>
            </div>
            <div className="ml-5">
              <SchemeHotspot
                id="delegation-member-subtitle"
                fieldLabel="member subtitle"
                displayText={memberSubtitleText}
                emptyLabel="(no member subtitle)"
                triggerClassName="text-[11px] text-muted-foreground"
                pool={lib.subtitle}
                value={del.memberSubtitle}
                allowUnset
                modified={memberSubtitleSet}
                defaultLabel={schemeLabel(baseDel.memberSubtitle?.scheme, lib.subtitle, "Default (no override)")}
                placeholder="e.g. {eid} · {code}"
                onChange={(v: SchemeValue | undefined) =>
                  onChange(
                    setDelegationField(
                      draft,
                      "memberSubtitle",
                      v ? { scheme: v.scheme as SubtitleSchemeId, template: v.template } : undefined,
                    ),
                  )
                }
                onReset={() => onChange(setDelegationField(draft, "memberSubtitle", undefined))}
              />
            </div>
          </div>
        </div>
      </div>

      <p
        className={cn(
          "ml-3 pt-8 text-[11px]",
          memberNeedsBoth ? "text-warning" : "text-muted-foreground",
        )}
      >
        Member naming applies only when both the title and subtitle are set.
      </p>
    </div>
  );
}

function SuffixEditor({
  value,
  modified,
  defaultHint,
  onChange,
  onReset,
}: {
  value: string | undefined;
  modified: boolean;
  defaultHint: string;
  onChange: (next: string | undefined) => void;
  onReset: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Edit coordinator label suffix"
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs",
            "cursor-pointer outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
            value
              ? "bg-primary/15 text-primary"
              : "border border-dashed border-border text-muted-foreground hover:bg-accent/60",
          )}
        >
          {modified ? <CircleDot aria-hidden className="h-3 w-3 shrink-0 text-primary" /> : null}
          {value ? value : "add suffix"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <div className="mb-2 flex items-center gap-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Label suffix
          </p>
          {modified ? (
            <>
              <span className="ml-auto text-[11px] text-muted-foreground">Default: {defaultHint}</span>
              <button
                type="button"
                aria-label="Reset coordinator label suffix to default"
                onClick={() => {
                  onReset();
                  setOpen(false);
                }}
                className="rounded p-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RotateCcw aria-hidden className="h-3.5 w-3.5 shrink-0" />
              </button>
            </>
          ) : (
            <span className="ml-auto text-[11px] text-muted-foreground">Default: {defaultHint}</span>
          )}
        </div>
        <label
          htmlFor="delegation-coordinator-suffix"
          className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground"
        >
          Appended to the coordinator label
        </label>
        <input
          id="delegation-coordinator-suffix"
          type="text"
          value={value ?? ""}
          placeholder="e.g. Operation"
          onChange={(e) => onChange(e.target.value || undefined)}
          className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
        />
      </PopoverContent>
    </Popover>
  );
}
