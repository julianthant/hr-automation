import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  TitleSchemeId,
  SubtitleSchemeId,
  TraceSchemeId,
} from "../../../../domain/workflow-presentation/types.js";
import type { WorkflowPresentationDetail, WorkflowOverride } from "../useWorkflowPresentation.js";
import { formatStepName } from "../../shared/types.js";
import { SchemeHotspot, type SchemeValue } from "../SchemeHotspot.js";
import {
  DEFAULT_TITLE_SCHEME,
  DEFAULT_SUBTITLE_SCHEME,
  DEFAULT_TRACE_SCHEME,
  previewTitle,
  previewSubtitle,
  previewTrace,
  schemeLabel,
  setNamingPart,
  setDelegationField,
  setStepOrder,
  updateStepRule,
  resetStepRule,
  moveInOrder,
  buildSampleVars,
} from "../blueprint-helpers.js";
import {
  NODE_ROW,
  NODE_STEP,
  NODE_DELEGATION_COORDINATOR,
  NODE_PREP,
  NODE_MEMBER,
  NODE_ACTION,
  NODE_OPS_LANE,
  NODE_CUSTOM,
  NODE_NOTE,
  NODE_GROUP,
  type GraphNode,
  type ActionNodeData,
  type AddedLaneOp,
} from "./graph-types.js";
import { opKindVisual } from "./op-kind-visuals.js";

interface NodeInspectorProps {
  node: GraphNode;
  data: WorkflowPresentationDetail;
  workflowName: string;
  draft: WorkflowOverride;
  onChange: (next: WorkflowOverride) => void;
  onClose: () => void;
  /** Patch an intent (custom/note/group) node's data. */
  onUpdateIntent: (id: string, patch: Record<string, unknown>) => void;
  /** Remove an intent node from the canvas. */
  onRemoveIntent: (id: string) => void;
  /** Edit a step lane's dropped op (data-flow vars / note). */
  onUpdateAddedOp: (step: string, addedId: string, patch: Partial<ActionNodeData>) => void;
  /** Remove a step lane's dropped op. */
  onRemoveAddedOp: (step: string, addedId: string) => void;
  /** `dialog` = centered modal (leaves the Data Bank sidebar visible). */
  presentation?: "overlay" | "dialog";
}

const INSPECTOR_TITLES: Record<string, string> = {
  [NODE_ROW]: "Queue row",
  [NODE_STEP]: "Step",
  [NODE_DELEGATION_COORDINATOR]: "Coordinator",
  [NODE_PREP]: "OCR prep row",
  [NODE_MEMBER]: "Member template",
  [NODE_ACTION]: "Action",
  [NODE_OPS_LANE]: "Ops lane",
  [NODE_CUSTOM]: "Design intent",
  [NODE_NOTE]: "Note",
  [NODE_GROUP]: "Group",
};

/**
 * Right-side editor panel for the selected node. It reuses the blueprint's
 * SchemeHotspot + sparse setters verbatim — editing here mutates the same draft
 * override the blueprint did, so the live preview + save path are unchanged.
 */
export function NodeInspector({
  node,
  data,
  workflowName,
  draft,
  onChange,
  onClose,
  onUpdateIntent,
  onRemoveIntent,
  onUpdateAddedOp,
  onRemoveAddedOp,
  presentation = "overlay",
}: NodeInspectorProps): JSX.Element {
  const title = INSPECTOR_TITLES[node.type ?? ""] ?? "Node";
  const inspectorContent: Partial<Record<string, JSX.Element>> = {
    [NODE_ROW]: <RowInspector data={data} draft={draft} onChange={onChange} />,
    [NODE_STEP]: (
      <StepInspector
        node={node}
        data={data}
        draft={draft}
        onChange={onChange}
        onUpdateAddedOp={onUpdateAddedOp}
        onRemoveAddedOp={onRemoveAddedOp}
      />
    ),
    [NODE_DELEGATION_COORDINATOR]: <CoordinatorInspector data={data} draft={draft} onChange={onChange} />,
    [NODE_PREP]: <PrepInspector data={data} draft={draft} onChange={onChange} />,
    [NODE_MEMBER]: <MemberInspector data={data} draft={draft} onChange={onChange} />,
    [NODE_ACTION]: <ActionInspector node={node} onUpdate={onUpdateIntent} onRemove={onRemoveIntent} />,
    [NODE_OPS_LANE]: <OpsLaneInspector node={node} />,
    [NODE_CUSTOM]: <IntentInspector node={node} onUpdate={onUpdateIntent} onRemove={onRemoveIntent} />,
    [NODE_NOTE]: <IntentInspector node={node} onUpdate={onUpdateIntent} onRemove={onRemoveIntent} />,
    [NODE_GROUP]: <IntentInspector node={node} onUpdate={onUpdateIntent} onRemove={onRemoveIntent} />,
  };

  const body = (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3.5">
      {inspectorContent[node.type ?? ""] ?? (
        <p className="text-xs text-muted-foreground">No editable config for this node.</p>
      )}
    </div>
  );

  if (presentation === "dialog") {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent size="lg" aria-label={`${title} inspector`}>
          <DialogHeader>
            <DialogTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {title}
            </DialogTitle>
          </DialogHeader>
          <DialogBody className="px-0" viewportClassName="px-3.5 pb-3.5">
            {body}
          </DialogBody>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <aside
      aria-label={`${title} inspector`}
      className="absolute right-3 top-3 bottom-3 z-10 flex w-[22rem] flex-col rounded-xl border border-border bg-card/95 shadow-lg backdrop-blur"
    >
      <header className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</span>
        <button
          type="button"
          aria-label="Close inspector"
          onClick={onClose}
          className="ml-auto rounded p-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden className="h-4 w-4 shrink-0" />
        </button>
      </header>
      {body}
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="space-y-1">
      <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────
function RowInspector({
  data,
  draft,
  onChange,
}: {
  data: WorkflowPresentationDetail;
  draft: WorkflowOverride;
  onChange: (next: WorkflowOverride) => void;
}): JSX.Element {
  const lib = data.schemeLibrary;
  const draftNaming = draft.presentation?.naming ?? {};
  const baseNaming = data.base.presentation?.naming ?? {};
  const vars = buildSampleVars(data.effective.label ?? "");

  const titlePart = draftNaming.title ?? baseNaming.title ?? { scheme: DEFAULT_TITLE_SCHEME as TitleSchemeId };
  const subtitlePart =
    draftNaming.subtitle ?? baseNaming.subtitle ?? { scheme: DEFAULT_SUBTITLE_SCHEME as SubtitleSchemeId };
  const tracePart = draftNaming.trace ?? baseNaming.trace ?? { scheme: DEFAULT_TRACE_SCHEME as TraceSchemeId };

  return (
    <>
      <Field label="Title">
        <SchemeHotspot
          id="insp-title"
          fieldLabel="title naming"
          displayText={previewTitle(vars, titlePart)}
          emptyLabel="(no title)"
          triggerClassName="text-sm font-medium"
          pool={lib.title}
          value={draftNaming.title ?? baseNaming.title}
          modified={draftNaming.title !== undefined}
          defaultLabel={schemeLabel(baseNaming.title?.scheme ?? DEFAULT_TITLE_SCHEME, lib.title)}
          placeholder="e.g. {name} ({emplId})"
          onChange={(v: SchemeValue | undefined) =>
            onChange(
              setNamingPart(draft, "title", v ? { scheme: v.scheme as TitleSchemeId, template: v.template } : undefined),
            )
          }
          onReset={() => onChange(setNamingPart(draft, "title", undefined))}
        />
      </Field>

      <Field label="Subtitle">
        <SchemeHotspot
          id="insp-subtitle"
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
      </Field>

      <Field label="Trace id">
        <SchemeHotspot
          id="insp-trace"
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
              setNamingPart(draft, "trace", v ? { scheme: v.scheme as TraceSchemeId, template: v.template } : undefined),
            )
          }
          onReset={() => onChange(setNamingPart(draft, "trace", undefined))}
        />
      </Field>
    </>
  );
}

// ── Step ────────────────────────────────────────────────────────────────────
function StepInspector({
  node,
  data,
  draft,
  onChange,
  onUpdateAddedOp,
  onRemoveAddedOp,
}: {
  node: GraphNode;
  data: WorkflowPresentationDetail;
  draft: WorkflowOverride;
  onChange: (next: WorkflowOverride) => void;
  onUpdateAddedOp: (step: string, addedId: string, patch: Partial<ActionNodeData>) => void;
  onRemoveAddedOp: (step: string, addedId: string) => void;
}): JSX.Element {
  const step = node.type === NODE_STEP ? node.data.step : "";
  const ops = node.type === NODE_STEP ? node.data.ops ?? [] : [];
  const addedOps = node.type === NODE_STEP ? node.data.addedOps ?? [] : [];
  const bankNote = node.type === NODE_STEP ? node.data.bankNote : undefined;
  const bankSourceRef = node.type === NODE_STEP ? node.data.bankSourceRef : undefined;
  const order = draft.presentation?.steps?.order ?? [...data.base.steps];
  const draftRules = draft.presentation?.steps?.rules ?? [];
  const baseRules = data.base.presentation?.steps?.rules ?? [];
  const ruleFor = (s: string) => draftRules.find((r) => r.step === s) ?? baseRules.find((r) => r.step === s) ?? { step: s };
  const labelFor = (s: string) => ruleFor(s).label ?? formatStepName(s);

  const idx = order.indexOf(step);
  const rule = ruleFor(step);
  const hidden = rule.hidden ?? false;
  const modified = draftRules.some((r) => r.step === step);
  const renameId = `insp-step-rename-${step}`;
  const foldId = `insp-step-fold-${step}`;
  const foldTargets = order.filter((s) => s !== step).map((s) => ({ id: s, label: labelFor(s) }));
  const total = order.length;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {idx >= 0 ? `Step ${idx + 1} of ${total}` : `Step (unmapped) · ${step}`}
          </span>
          {modified ? (
            <button
              type="button"
              aria-label={`Reset step ${formatStepName(step)} to default`}
              onClick={() => onChange(resetStepRule(draft, step))}
              className="ml-auto inline-flex items-center gap-1 rounded p-0.5 text-[11px] text-primary outline-none transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCcw aria-hidden className="h-3 w-3 shrink-0" />
              Reset
            </button>
          ) : null}
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">{step}</p>
      </header>

      <StepReviewDetail ops={ops} bankNote={bankNote} bankSourceRef={bankSourceRef} />

      {addedOps.length ? (
        <section className="space-y-2.5 border-t border-border pt-4">
          <SectionLabel hint="Ops you dropped into this step from the Data Bank — design intent captured in the scaffold, not the runtime.">
            Added operations ({addedOps.length})
          </SectionLabel>
          {addedOps.map((op) => (
            <AddedOpEditor
              key={op.addedId}
              op={op}
              onUpdate={(patch) => onUpdateAddedOp(step, op.addedId, patch)}
              onRemove={() => onRemoveAddedOp(step, op.addedId)}
            />
          ))}
        </section>
      ) : null}

      <section className="space-y-3 border-t border-border pt-4">
        <SectionLabel hint="How this step shows in the dashboard queue — does not touch the automation.">
          Presentation
        </SectionLabel>

        <Field label="Label">
          <input
            id={renameId}
            type="text"
            value={rule.label ?? ""}
            placeholder={formatStepName(step)}
            aria-label={`Label for step ${formatStepName(step)}`}
            onChange={(e) => onChange(updateStepRule(draft, step, { label: e.target.value || undefined }))}
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
          />
        </Field>

        <Field label="Fold into">
          <select
            id={foldId}
            value={rule.foldInto ?? ""}
            aria-label={`Fold step ${formatStepName(step)} into another step`}
            onChange={(e) => onChange(updateStepRule(draft, step, { foldInto: e.target.value || undefined }))}
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">— Keep separate —</option>
            {foldTargets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Visibility & order">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-pressed={hidden}
              aria-label={hidden ? `Show step ${formatStepName(step)}` : `Hide step ${formatStepName(step)}`}
              onClick={() => onChange(updateStepRule(draft, step, { hidden: !hidden }))}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-2 py-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {hidden ? <EyeOff aria-hidden className="h-3.5 w-3.5 shrink-0" /> : <Eye aria-hidden className="h-3.5 w-3.5 shrink-0" />}
              {hidden ? "Hidden" : "Visible"}
            </button>
            <button
              type="button"
              aria-label={`Move ${formatStepName(step)} earlier`}
              disabled={idx <= 0}
              onClick={() => onChange(setStepOrder(draft, moveInOrder(order, idx, idx - 1)))}
              className="ml-auto rounded-md border border-border bg-secondary p-1 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronLeft aria-hidden className="h-3.5 w-3.5 shrink-0" />
            </button>
            <button
              type="button"
              aria-label={`Move ${formatStepName(step)} later`}
              disabled={idx < 0 || idx >= order.length - 1}
              onClick={() => onChange(setStepOrder(draft, moveInOrder(order, idx, idx + 1)))}
              className="rounded-md border border-border bg-secondary p-1 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0" />
            </button>
          </div>
        </Field>
      </section>
    </div>
  );
}

// ── Rich review detail (shared by step + ops lanes) ────────────────────────────
function SectionLabel({ children, hint }: { children: React.ReactNode; hint?: string }): JSX.Element {
  return (
    <div className="space-y-0.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">{children}</h3>
      {hint ? <p className="text-[10px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** The "what this step actually does" block: stats, data flow, every op in full, notes, source. */
function StepReviewDetail({
  ops,
  bankNote,
  bankSourceRef,
}: {
  ops: ActionNodeData[];
  bankNote?: string;
  bankSourceRef?: string;
}): JSX.Element {
  const reads = ops.filter((o) => o.inputVar);
  const writes = ops.filter((o) => o.outputVar);
  const hasDetail = reads.length || writes.length || bankNote || bankSourceRef;

  return (
    <div className="space-y-4">
      {/* Data flow — the consolidated vars crossing this step's boundary. The card
          already lists the ops (with per-op pills); this is the rollup view. */}
      {reads.length || writes.length ? (
        <section className="space-y-2">
          <SectionLabel>Data flow</SectionLabel>
          {reads.map((o, i) => (
            <DataFlowRow key={`r${i}`} dir="in" varName={o.inputVar ?? ""} label={o.label} />
          ))}
          {writes.map((o, i) => (
            <DataFlowRow key={`w${i}`} dir="out" varName={o.outputVar ?? ""} label={o.label} />
          ))}
        </section>
      ) : null}

      {bankNote ? (
        <section className="space-y-1.5">
          <SectionLabel>Notes</SectionLabel>
          <p className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-[11px] leading-snug text-foreground">
            {bankNote}
          </p>
        </section>
      ) : null}

      {bankSourceRef ? (
        <section className="space-y-1">
          <SectionLabel>Source</SectionLabel>
          <p className="break-all font-mono text-[10px] text-muted-foreground" title={bankSourceRef}>
            {bankSourceRef}
          </p>
        </section>
      ) : null}

      {!hasDetail ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          The step’s operations are on its card. No data flow, notes, or source recorded.
        </p>
      ) : null}
    </div>
  );
}

function DataFlowRow({ dir, varName, label }: { dir: "in" | "out"; varName: string; label: string }): JSX.Element {
  const Icon = dir === "in" ? ArrowDownToLine : ArrowUpFromLine;
  const tone = dir === "in" ? "text-log-teal" : "text-log-cyan";
  return (
    <div className="flex items-center gap-1.5">
      <Icon aria-hidden className={cn("h-3 w-3 shrink-0", tone)} />
      <span className={cn("shrink-0 rounded-sm px-1 py-px font-mono text-[10px]", dir === "in" ? "bg-log-teal/12 text-log-teal" : "bg-log-cyan/12 text-log-cyan")}>
        {varName}
      </span>
      <span className="text-[10px] text-muted-foreground/70">{dir === "in" ? "from" : "into"}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={label}>
        {label}
      </span>
    </div>
  );
}

// ── Ops lane (display-only mined step with no presentation step) ────────────────
function OpsLaneInspector({ node }: { node: GraphNode }): JSX.Element | null {
  if (node.type !== NODE_OPS_LANE) return null;
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Ops lane
        </span>
        <p className="text-sm font-medium text-foreground">{node.data.label}</p>
        <p className="font-mono text-[11px] text-muted-foreground">{node.data.step}</p>
        <p className="text-[11px] text-muted-foreground">
          Mined operations with no matching presentation step — review only.
        </p>
      </header>
      <StepReviewDetail ops={node.data.ops} bankNote={node.data.bankNote} bankSourceRef={node.data.bankSourceRef} />
    </div>
  );
}

// ── Coordinator ───────────────────────────────────────────────────────────────
function CoordinatorInspector({
  data,
  draft,
  onChange,
}: {
  data: WorkflowPresentationDetail;
  draft: WorkflowOverride;
  onChange: (next: WorkflowOverride) => void;
}): JSX.Element {
  const del = draft.presentation?.delegation ?? {};
  const baseDel = data.base.presentation?.delegation ?? {};
  const modified = del.coordinatorLabelSuffix !== undefined;
  return (
    <Field label="Label suffix">
      <input
        id="insp-coord-suffix"
        type="text"
        value={del.coordinatorLabelSuffix ?? ""}
        placeholder={baseDel.coordinatorLabelSuffix ?? "e.g. Operation"}
        aria-label="Coordinator label suffix"
        onChange={(e) =>
          onChange(setDelegationField(draft, "coordinatorLabelSuffix", e.target.value || undefined))
        }
        className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
      />
      {modified ? (
        <button
          type="button"
          onClick={() => onChange(setDelegationField(draft, "coordinatorLabelSuffix", undefined))}
          className="inline-flex items-center gap-1 rounded text-[11px] text-primary outline-none transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RotateCcw aria-hidden className="h-3 w-3 shrink-0" />
          Reset to default
        </button>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          Appended to the coordinator label (e.g. “{data.effective.label} Operation”).
        </p>
      )}
    </Field>
  );
}

// ── Prep ────────────────────────────────────────────────────────────────────
function PrepInspector({
  data,
  draft,
  onChange,
}: {
  data: WorkflowPresentationDetail;
  draft: WorkflowOverride;
  onChange: (next: WorkflowOverride) => void;
}): JSX.Element {
  const lib = data.schemeLibrary;
  const del = draft.presentation?.delegation ?? {};
  const baseDel = data.base.presentation?.delegation ?? {};
  const vars = buildSampleVars(data.effective.label ?? "");
  const part = del.prepTitle ?? baseDel.prepTitle ?? { scheme: DEFAULT_TITLE_SCHEME as TitleSchemeId };
  return (
    <Field label="Prep title">
      <SchemeHotspot
        id="insp-prep-title"
        fieldLabel="prep title"
        displayText={previewTitle(vars, part)}
        emptyLabel="(no prep title)"
        triggerClassName="text-sm font-medium"
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
    </Field>
  );
}

// ── Member ──────────────────────────────────────────────────────────────────
function MemberInspector({
  data,
  draft,
  onChange,
}: {
  data: WorkflowPresentationDetail;
  draft: WorkflowOverride;
  onChange: (next: WorkflowOverride) => void;
}): JSX.Element {
  const lib = data.schemeLibrary;
  const del = draft.presentation?.delegation ?? {};
  const baseDel = data.base.presentation?.delegation ?? {};
  const vars = buildSampleVars(data.effective.label ?? "");
  const titlePart = del.memberTitle ?? baseDel.memberTitle ?? { scheme: DEFAULT_TITLE_SCHEME as TitleSchemeId };
  const subtitlePart =
    del.memberSubtitle ?? baseDel.memberSubtitle ?? { scheme: DEFAULT_SUBTITLE_SCHEME as SubtitleSchemeId };
  const xor = (del.memberTitle !== undefined) !== (del.memberSubtitle !== undefined);
  return (
    <>
      <Field label="Member title">
        <SchemeHotspot
          id="insp-member-title"
          fieldLabel="member title"
          displayText={previewTitle(vars, titlePart)}
          emptyLabel="(no member title)"
          triggerClassName="text-sm font-medium"
          pool={lib.title}
          value={del.memberTitle}
          allowUnset
          modified={del.memberTitle !== undefined}
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
      </Field>

      <Field label="Member subtitle">
        <SchemeHotspot
          id="insp-member-subtitle"
          fieldLabel="member subtitle"
          displayText={previewSubtitle(vars, subtitlePart)}
          emptyLabel="(no member subtitle)"
          triggerClassName="text-xs text-muted-foreground"
          pool={lib.subtitle}
          value={del.memberSubtitle}
          allowUnset
          modified={del.memberSubtitle !== undefined}
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
      </Field>

      <p className={cn("text-[11px]", xor ? "text-warning" : "text-muted-foreground")}>
        Member naming applies only when both the title and subtitle are set.
      </p>
    </>
  );
}

// ── Action primitive (from the Data Bank) ─────────────────────────────────────
function ActionInspector({
  node,
  onUpdate,
  onRemove,
}: {
  node: GraphNode;
  onUpdate: (id: string, patch: Record<string, unknown>) => void;
  onRemove: (id: string) => void;
}): JSX.Element | null {
  if (node.type !== NODE_ACTION) return null;
  const d = node.data;
  const v = opKindVisual(d.kind);
  return (
    <>
      <div className="flex items-center gap-1.5">
        <v.icon aria-hidden className={cn("h-3.5 w-3.5 shrink-0", v.accent)} />
        <span className="text-xs font-medium text-foreground">{v.verb}</span>
        <span className="ml-auto rounded-sm border border-border bg-secondary/60 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
          {d.system}
        </span>
      </div>

      <Field label="Operation">
        <p className="text-sm font-medium text-foreground">{d.label}</p>
      </Field>

      {d.selectorFqn || d.role || d.accessibleName || d.url ? (
        <Field label="Locates">
          {d.selectorFqn ? <p className="break-all font-mono text-[11px] text-muted-foreground">{d.selectorFqn}</p> : null}
          {d.role || d.accessibleName ? (
            <p className="text-[11px] text-muted-foreground">
              {[d.role, d.accessibleName].filter(Boolean).join(" · ")}
            </p>
          ) : null}
          {d.url ? <p className="break-all font-mono text-[11px] text-muted-foreground">{d.url}</p> : null}
        </Field>
      ) : null}

      <Field label="Fills from (variable)">
        <input
          type="text"
          value={d.inputVar ?? ""}
          placeholder="e.g. {eid}"
          aria-label="Fills from variable"
          onChange={(e) => onUpdate(node.id, { inputVar: e.target.value || undefined })}
          className={TEXT_INPUT_CLASS}
        />
      </Field>

      <Field label="Scrapes into (variable)">
        <input
          type="text"
          value={d.outputVar ?? ""}
          placeholder="e.g. {department}"
          aria-label="Scrapes into variable"
          onChange={(e) => onUpdate(node.id, { outputVar: e.target.value || undefined })}
          className={TEXT_INPUT_CLASS}
        />
      </Field>

      <Field label="Note">
        <textarea
          value={d.note ?? ""}
          rows={2}
          placeholder="A gotcha / caveat for this op"
          aria-label="Operation note"
          onChange={(e) => onUpdate(node.id, { note: e.target.value || undefined })}
          className={`${TEXT_INPUT_CLASS} resize-y`}
        />
      </Field>

      <button
        type="button"
        onClick={() => onRemove(node.id)}
        className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive outline-none transition-colors hover:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Trash2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
        Remove node
      </button>
    </>
  );
}

// ── Design-intent nodes (custom / note / group) ───────────────────────────────
const TEXT_INPUT_CLASS =
  "w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

// ── A dropped-in op, edited inline from its step's inspector ───────────────────
function AddedOpEditor({
  op,
  onUpdate,
  onRemove,
}: {
  op: AddedLaneOp;
  onUpdate: (patch: Partial<ActionNodeData>) => void;
  onRemove: () => void;
}): JSX.Element {
  const v = opKindVisual(op.kind);
  return (
    <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/[0.06] p-2.5">
      <div className="flex items-center gap-1.5">
        <v.icon aria-hidden className={cn("h-3.5 w-3.5 shrink-0", v.accent)} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={op.label}>
          {op.label}
        </span>
        <span className="shrink-0 rounded-sm border border-border bg-secondary/60 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
          {op.system}
        </span>
        <button
          type="button"
          aria-label={`Remove ${op.label}`}
          onClick={onRemove}
          className="shrink-0 rounded p-0.5 text-muted-foreground outline-none transition-colors hover:bg-destructive/15 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Trash2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-0.5">
          <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">Fills from</span>
          <input
            type="text"
            value={op.inputVar ?? ""}
            placeholder="{var}"
            aria-label={`Fills from variable for ${op.label}`}
            onChange={(e) => onUpdate({ inputVar: e.target.value || undefined })}
            className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="space-y-0.5">
          <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">Scrapes into</span>
          <input
            type="text"
            value={op.outputVar ?? ""}
            placeholder="{var}"
            aria-label={`Scrapes into variable for ${op.label}`}
            onChange={(e) => onUpdate({ outputVar: e.target.value || undefined })}
            className="w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      </div>
      <label className="space-y-0.5">
        <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">Note</span>
        <textarea
          value={op.note ?? ""}
          rows={2}
          placeholder="Why this op belongs here / a gotcha"
          aria-label={`Note for ${op.label}`}
          onChange={(e) => onUpdate({ note: e.target.value || undefined })}
          className={`${TEXT_INPUT_CLASS} resize-y text-[12px]`}
        />
      </label>
    </div>
  );
}

function IntentInspector({
  node,
  onUpdate,
  onRemove,
}: {
  node: GraphNode;
  onUpdate: (id: string, patch: Record<string, unknown>) => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  const id = node.id;
  return (
    <>
      <p className="text-[11px] text-muted-foreground">
        Intent-only — feeds the design scaffold, never the runtime override.
      </p>

      {node.type === NODE_CUSTOM ? (
        <CustomIntentFields data={node.data} onUpdate={(p) => onUpdate(id, p)} />
      ) : node.type === NODE_NOTE ? (
        <Field label="Note text">
          <textarea
            value={node.data.text}
            aria-label="Note text"
            rows={4}
            onChange={(e) => onUpdate(id, { text: e.target.value })}
            className={`${TEXT_INPUT_CLASS} resize-y`}
          />
        </Field>
      ) : node.type === NODE_GROUP ? (
        <Field label="Section label">
          <input
            type="text"
            value={node.data.label}
            aria-label="Section label"
            onChange={(e) => onUpdate(id, { label: e.target.value })}
            className={TEXT_INPUT_CLASS}
          />
        </Field>
      ) : null}

      <button
        type="button"
        onClick={() => onRemove(id)}
        className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive outline-none transition-colors hover:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Trash2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
        Remove node
      </button>
    </>
  );
}

function CustomIntentFields({
  data,
  onUpdate,
}: {
  data: { label?: string; description?: string; look?: string; behavior?: string; references?: string[]; exampleData?: Record<string, string> };
  onUpdate: (patch: Record<string, unknown>) => void;
}): JSX.Element {
  const refsText = (data.references ?? []).join(", ");
  const exampleText = Object.entries(data.exampleData ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return (
    <>
      <Field label="Name">
        <input
          type="text"
          value={data.label ?? ""}
          aria-label="Element name"
          placeholder="e.g. Member status chip"
          onChange={(e) => onUpdate({ label: e.target.value || undefined })}
          className={TEXT_INPUT_CLASS}
        />
      </Field>
      <Field label="Description (what it should do)">
        <textarea
          value={data.description ?? ""}
          aria-label="Description"
          rows={3}
          placeholder="Plain-words behavior + purpose"
          onChange={(e) => onUpdate({ description: e.target.value || undefined })}
          className={`${TEXT_INPUT_CLASS} resize-y`}
        />
      </Field>
      <Field label="Look (visual direction)">
        <input
          type="text"
          value={data.look ?? ""}
          aria-label="Look"
          placeholder="e.g. compact card, status dot left, mono id"
          onChange={(e) => onUpdate({ look: e.target.value || undefined })}
          className={TEXT_INPUT_CLASS}
        />
      </Field>
      <Field label="Behavior (interactions)">
        <input
          type="text"
          value={data.behavior ?? ""}
          aria-label="Behavior"
          placeholder="e.g. click expands members"
          onChange={(e) => onUpdate({ behavior: e.target.value || undefined })}
          className={TEXT_INPUT_CLASS}
        />
      </Field>
      <Field label="References (comma-separated)">
        <input
          type="text"
          value={refsText}
          aria-label="References"
          placeholder="e.g. EntryItem.tsx, group-row-base.tsx"
          onChange={(e) => {
            const refs = e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            onUpdate({ references: refs.length ? refs : undefined });
          }}
          className={TEXT_INPUT_CLASS}
        />
      </Field>
      <Field label="Example data (key=value per line)">
        <textarea
          value={exampleText}
          aria-label="Example data"
          rows={3}
          placeholder={"name=Jane Doe\neid=10012345"}
          onChange={(e) => {
            const out: Record<string, string> = {};
            for (const line of e.target.value.split("\n")) {
              const idx = line.indexOf("=");
              if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
            }
            onUpdate({ exampleData: Object.keys(out).length ? out : undefined });
          }}
          className={`${TEXT_INPUT_CLASS} font-mono resize-y`}
        />
      </Field>
    </>
  );
}
