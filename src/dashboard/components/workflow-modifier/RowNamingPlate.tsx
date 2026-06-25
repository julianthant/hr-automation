import { Circle, Clock } from "lucide-react";
import type {
  TitleSchemeId,
  SubtitleSchemeId,
  TraceSchemeId,
} from "../../../domain/workflow-presentation/types.js";
import type { WorkflowPresentationDetail, WorkflowOverride } from "./useWorkflowPresentation.js";
import { SchemeHotspot, type SchemeValue } from "./SchemeHotspot.js";
import {
  DEFAULT_TITLE_SCHEME,
  DEFAULT_SUBTITLE_SCHEME,
  DEFAULT_TRACE_SCHEME,
  previewTitle,
  previewSubtitle,
  previewTrace,
  schemeLabel,
  setNamingPart,
  buildSampleVars,
} from "./blueprint-helpers.js";

interface Props {
  data: WorkflowPresentationDetail;
  draft: WorkflowOverride;
  onChange: (next: WorkflowOverride) => void;
}

/**
 * Plate ①. A faithful queue-row card whose title / subtitle / trace are the live
 * editable hotspots. The card IS the preview — it resolves with the same domain
 * functions the server uses, so it updates the instant a scheme changes.
 */
export function RowNamingPlate({ data, draft, onChange }: Props): JSX.Element {
  const lib = data.schemeLibrary;
  const draftNaming = draft.presentation?.naming ?? {};
  const baseNaming = data.base.presentation?.naming ?? {};
  const vars = buildSampleVars(data.effective.label ?? "");

  const titlePart = draftNaming.title ??
    baseNaming.title ?? { scheme: DEFAULT_TITLE_SCHEME as TitleSchemeId };
  const subtitlePart = draftNaming.subtitle ??
    baseNaming.subtitle ?? { scheme: DEFAULT_SUBTITLE_SCHEME as SubtitleSchemeId };
  const tracePart = draftNaming.trace ??
    baseNaming.trace ?? { scheme: DEFAULT_TRACE_SCHEME as TraceSchemeId };

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        How this workflow's queue rows read. Click any value to change it.
      </p>

      {/* The live row card — mirrors the real EntryItem layout. */}
      <div className="rounded-lg border border-border bg-card px-3.5 py-3">
        {/* Title line */}
        <div className="flex items-center gap-2">
          <Circle aria-hidden className="h-3 w-3 shrink-0 fill-current text-success" />
          <SchemeHotspot
            id="naming-title"
            fieldLabel="title naming"
            displayText={previewTitle(vars, titlePart)}
            emptyLabel="(no title — count identifies the row)"
            triggerClassName="text-[14px] font-semibold"
            pool={lib.title}
            value={draftNaming.title ?? baseNaming.title}
            modified={draftNaming.title !== undefined}
            defaultLabel={schemeLabel(baseNaming.title?.scheme ?? DEFAULT_TITLE_SCHEME, lib.title)}
            placeholder="e.g. {name} ({emplId})"
            onChange={(v: SchemeValue | undefined) =>
              onChange(
                setNamingPart(
                  draft,
                  "title",
                  v ? { scheme: v.scheme as TitleSchemeId, template: v.template } : undefined,
                ),
              )
            }
            onReset={() => onChange(setNamingPart(draft, "title", undefined))}
          />
        </div>

        {/* Subtitle line */}
        <div className="ml-5 mt-1">
          <SchemeHotspot
            id="naming-subtitle"
            fieldLabel="subtitle naming"
            displayText={previewSubtitle(vars, subtitlePart)}
            emptyLabel="(no subtitle)"
            triggerClassName="text-xs text-muted-foreground"
            pool={lib.subtitle}
            value={draftNaming.subtitle ?? baseNaming.subtitle}
            modified={draftNaming.subtitle !== undefined}
            defaultLabel={schemeLabel(baseNaming.subtitle?.scheme ?? DEFAULT_SUBTITLE_SCHEME, lib.subtitle)}
            placeholder="e.g. {eid} · {code}"
            onChange={(v: SchemeValue | undefined) =>
              onChange(
                setNamingPart(
                  draft,
                  "subtitle",
                  v ? { scheme: v.scheme as SubtitleSchemeId, template: v.template } : undefined,
                ),
              )
            }
            onReset={() => onChange(setNamingPart(draft, "subtitle", undefined))}
          />
        </div>

        {/* Footer line: time · trace · run */}
        <div className="ml-5 mt-2 flex items-center gap-2 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-mono">
            <Clock aria-hidden className="h-3 w-3 shrink-0" />
            14:30
          </span>
          <span aria-hidden className="text-muted-foreground/40">·</span>
          <SchemeHotspot
            id="naming-trace"
            fieldLabel="trace id format"
            displayText={previewTrace(vars, tracePart)}
            emptyLabel="(no trace)"
            mono
            triggerClassName="text-[11px]"
            pool={lib.trace}
            value={draftNaming.trace ?? baseNaming.trace}
            modified={draftNaming.trace !== undefined}
            defaultLabel={schemeLabel(baseNaming.trace?.scheme ?? DEFAULT_TRACE_SCHEME, lib.trace)}
            placeholder="e.g. {code}-{runId4}"
            warning="Only affects new runs; existing trace ids never change."
            onChange={(v: SchemeValue | undefined) =>
              onChange(
                setNamingPart(
                  draft,
                  "trace",
                  v ? { scheme: v.scheme as TraceSchemeId, template: v.template } : undefined,
                ),
              )
            }
            onReset={() => onChange(setNamingPart(draft, "trace", undefined))}
          />
          <span aria-hidden className="ml-auto font-mono text-muted-foreground/70">#a3f1</span>
        </div>
      </div>
    </div>
  );
}
