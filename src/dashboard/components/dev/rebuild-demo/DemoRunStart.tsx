import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  FileSpreadsheet,
  FileText,
  Keyboard,
  LockKeyhole,
  Play,
  Search,
  Settings,
  Upload,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  Field,
  IconButton,
  Input,
  KeyValueList,
  MetaLine,
  SectionLabel,
  Select,
  Textarea,
  Well,
  dsElev,
  dsFg,
  dsFocus,
  dsIcon,
  dsMotion,
  dsRadius,
  dsText,
} from "./demo-ui";
import {
  DEMO_WORKFLOWS,
  START_SEPARATOR,
  START_VALUE_NOUN,
  choiceOptionLabel,
  defaultChoiceValues,
  defaultFlagValues,
  effectiveChoiceValues,
  launcherStartMethods,
  requireStartCapability,
  requireLauncherStartMethod,
  startContractToken,
  startWorkflowGroups,
  startableWorkflows,
  unstartableWorkflows,
  visibleChoices,
  visibleFlags,
  workflowVersionTag,
  type DemoWorkflowId,
  type DemoWorkflowRef,
  type LauncherStartMethodKind,
  type LauncherStartMethodWire,
  type StartReplacementInputWire,
  type StartTimelineWire,
} from "./demo-wire";
import {
  ACTIVE_STARTS,
  ENQUEUE_POLICY_LABEL,
  serverContractToken,
  UPLOAD_FILES,
  activeConflictFor,
  deriveStartPlan,
  parseEntries,
  submitDemoEnqueue,
  testSystems,
  type DemoEnqueueResult,
  type EnqueuePolicy,
  type InstanceChoice,
  type UploadFileFixture,
} from "./demo-runstart-wire";
import {
  EnqueueResultBanner,
  InstanceSelector,
  RunFlagChips,
  StartChoiceControl,
  StartFlagControl,
} from "./DemoRunStartKit";
import {
  adjacentRunStartStage,
  defaultSelectedSteps,
  missingReplacementInputs,
  reconcileRunStartStage,
  replacementInputsForSelection,
  runStartCustomizationSections,
  runStartStages,
  type RunStartStage,
} from "./demo-runstart-timeline";
import { DemoIntakeDialog } from "./DemoIntake";
import { SOURCE_SHEETS } from "./demo-data-intake";

/**
 * DEV-ONLY — **the** Run Modal. One surface, every workflow.
 *
 * Production splits run-starting across two surfaces by HOW you start: a
 * file-upload `RunModal` and a typed `InputRunPanel`. That is an implementation
 * detail wearing a UI, and it leaks: `oath-signature` lives in both, so its
 * typed box has to open the *other* modal when you press Run on an empty line.
 *
 * This modal splits by WHAT you are running instead. Pick a workflow → it
 * declares what it accepts → you get its inputs, its sub-selections, its
 * settings, and a plan of exactly what will exist afterwards.
 *
 * Four things are deliberate:
 *
 *  - **Nothing here knows a workflow.** Every input kind, sub-selection, flag
 *    and coordinator shape is read off `DemoWorkflowRef.start` (`demo-wire.ts`).
 *    There is no `workflow === "onbase"` anywhere in this file, so a workflow
 *    registered tomorrow gets a correct modal for free — and one that declares
 *    no start capability is not offered rather than offered and broken.
 *  - **More than one input kind is a PEER CHOICE.** `oath-signature` takes typed
 *    EIDs or an uploaded packet; they are peer tabs. Phone capture has its own
 *    intake surface and is not a launcher mode.
 *  - **The ordinary path is Input → Confirm.** Defaults stay out of the way;
 *    the gear opts into custom steps or options, skipped-step values appear
 *    only when required, and only Confirm carries the consequential command.
 *  - **Starting is a COMMAND**, so it returns `applied | conflict | rejected`.
 *    All three are reachable by clicking.
 */

// ---------------------------------------------------------------------------
// The launcher
// ---------------------------------------------------------------------------

/** the queue toolbar's one primary control — the modal itself lives at the root */
export function DemoRunStartButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Button
      size="toolbar"
      variant="brand"
      onClick={onOpen}
      icon={<Play aria-hidden className={dsIcon.sm} />}
      // No `r` hint on the face of it. A shortcut badge on a control the
      // operator presses with the pointer is a permanent reminder of a key
      // they either already know or are not going to learn from a 10px chip —
      // and it sits on the ONE primary in the toolbar, where the verb should
      // end the eye's travel. The binding is unchanged and still discoverable
      // where every other one is: the keyboard page.
      title="Start a run — any workflow, from anywhere (r)"
    >
      Start a run
    </Button>
  );
}

// ---------------------------------------------------------------------------
// The workflow picker — the real rail categories, inside the modal
// ---------------------------------------------------------------------------

function matchesQuery(workflow: DemoWorkflowRef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return workflow.label.toLowerCase().includes(q) || workflow.code.includes(q) || workflow.category.toLowerCase().includes(q);
}

function WorkflowPicker({ value, onChange }: { value: DemoWorkflowId; onChange: (next: DemoWorkflowId) => void }) {
  const [query, setQuery] = useState("");
  const [showBlocked, setShowBlocked] = useState(false);
  const groups = useMemo(
    () =>
      startWorkflowGroups()
        .map((group) => ({ ...group, workflows: group.workflows.filter((w) => matchesQuery(w, query)) }))
        .filter((group) => group.workflows.length > 0),
    [query],
  );
  const blocked = useMemo(() => unstartableWorkflows(), []);

  return (
    <div className="hidden w-[204px] shrink-0 flex-col border-r border-[color:var(--ds-border)] min-[768px]:flex">
      <div className="shrink-0 border-b border-[color:var(--ds-border)] p-[var(--ds-space-base)]">
        {/* A plain labelled input rather than SearchInput: this filters a list
            of fourteen, so a clear affordance would cost a control for a state
            one keystroke undoes. */}
        <label className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
          <Search aria-hidden className={cn(dsIcon.sm, "shrink-0", dsFg.muted)} />
          <span className="sr-only">Filter workflows</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter"
            className={cn(
              "min-w-0 flex-1 border-none bg-transparent outline-none",
              dsText.ui,
              "text-[color:var(--ds-fg)] placeholder:text-[color:var(--ds-fg-faint)]",
            )}
          />
        </label>
      </div>

      <nav aria-label="Workflow" className="min-h-0 flex-1 overflow-y-auto p-[var(--ds-space-base)]">
        {groups.length === 0 ? (
          <p className={cn(dsText.meta, dsFg.muted)}>No workflow matches “{query}”.</p>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="mb-[var(--ds-space-cozy)] flex flex-col gap-[var(--ds-space-hair)]">
              <SectionLabel className="px-[var(--ds-space-snug)]">{group.label}</SectionLabel>
              {group.workflows.map((workflow) => {
                const selected = workflow.id === value;
                return (
                  <button
                    key={workflow.id}
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onChange(workflow.id)}
                    className={cn(
                      "flex w-full min-w-0 cursor-pointer items-center gap-[var(--ds-space-snug)] text-left",
                      "h-[var(--ds-h-row)] px-[var(--ds-space-snug)]",
                      dsRadius.md,
                      dsText.ui,
                      dsFocus,
                      dsMotion.fast,
                      selected
                        ? cn("bg-[var(--ds-surface-3)] font-semibold", dsFg.base)
                        : cn("hover:bg-[var(--ds-surface-2)]", dsFg.secondary),
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{workflow.label}</span>
                    <span className={cn(dsText.micro, dsText.nums, selected ? dsFg.muted : dsFg.faint)}>{workflow.code}</span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </nav>

      {/* Not offered, and it says why. A workflow that simply vanishes from a
          picker teaches the operator the list is arbitrary.

          A DISCLOSURE, not a Popover: `dsLayer.menu` is z-20 and a Dialog is
          z-40, so a popover opened from inside a modal renders BEHIND it — the
          a11y tree says it opened and the screen says nothing happened. Anything
          disclosed from inside a dialog stays inside the dialog. */}
      <div className="shrink-0 border-t border-[color:var(--ds-border)] p-[var(--ds-space-base)]">
        {showBlocked && (
          <dl className="mb-[var(--ds-space-snug)] flex max-h-[11rem] flex-col gap-[var(--ds-space-base)] overflow-y-auto">
            {blocked.map(({ workflow, reason }) => (
              <div key={workflow.id} className="flex flex-col gap-[var(--ds-space-hair)]">
                <dt className={cn(dsText.meta, "font-semibold", dsFg.base)}>{workflow.label}</dt>
                <dd className={cn(dsText.meta, dsFg.muted)}>{reason}</dd>
              </div>
            ))}
          </dl>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-start"
          aria-expanded={showBlocked}
          onClick={() => setShowBlocked((v) => !v)}
        >
          {blocked.length} not startable
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The peer methods — how you are starting it
// ---------------------------------------------------------------------------

const METHOD_ICON: Record<LauncherStartMethodKind, ReactNode> = {
  typed: <Keyboard aria-hidden className={dsIcon.sm} />,
  upload: <Upload aria-hidden className={dsIcon.sm} />,
  spreadsheet: <FileSpreadsheet aria-hidden className={dsIcon.sm} />,
  bare: <Play aria-hidden className={dsIcon.sm} />,
};

function MethodTabs({
  methods,
  value,
  onChange,
}: {
  methods: LauncherStartMethodWire[];
  value: LauncherStartMethodKind;
  onChange: (next: LauncherStartMethodKind) => void;
}) {
  const peerMethods = methods.filter(
    (method, index) => methods.findIndex((candidate) => candidate.kind === method.kind) === index,
  );
  return (
    <div
      role="tablist"
      aria-label="How to start this run"
      className={cn("inline-flex items-center gap-[var(--ds-space-hair)] p-[var(--ds-space-hair)]", dsRadius.md, "bg-[var(--ds-surface-2)]")}
    >
      {peerMethods.map((method) => {
        const selected = method.kind === value;
        return (
          <button
            key={method.kind}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(method.kind)}
            className={cn(
              "inline-flex cursor-pointer items-center gap-[var(--ds-space-snug)]",
              "h-[var(--ds-h-md)] px-[var(--ds-space-cozy)]",
              dsRadius.sm,
              dsText.ui,
              dsFocus,
              dsMotion.fast,
              "active:translate-y-px",
              selected
                ? cn("bg-[var(--ds-surface-overlay)] font-semibold", dsFg.base, dsElev.low)
                : cn(dsFg.muted, "hover:text-[color:var(--ds-fg)]"),
            )}
          >
            {METHOD_ICON[method.kind]}
            {method.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The input surfaces, one per method kind
// ---------------------------------------------------------------------------

function FileChoice({
  file,
  selected,
  multi,
  onToggle,
}: {
  file: UploadFileFixture;
  selected: boolean;
  multi: boolean;
  onToggle: () => void;
}) {
  const active = ACTIVE_STARTS.find((a) => a.subject === file.fileName);
  return (
    <Card
      interactive
      selected={selected}
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      className="min-h-[var(--ds-h-lg)] flex-row items-center gap-[var(--ds-space-base)] px-[var(--ds-space-base)] py-[var(--ds-space-snug)]"
    >
      <FileText aria-hidden className={cn(dsIcon.md, "shrink-0", dsFg.muted)} />
      <span className={cn(dsText.ui, "min-w-0 flex-1 truncate", dsFg.base)}>{file.fileName}</span>
      <MetaLine className="shrink-0" items={[file.sizeLabel, `${file.pageCount} page${file.pageCount === 1 ? "" : "s"}`]} />
      {active && <Badge tone="warning">already running</Badge>}
    </Card>
  );
}

function UploadInput({
  accepts,
  multiFile,
  merge,
  fileIds,
  onChange,
}: {
  accepts: readonly string[];
  multiFile: boolean;
  merge: boolean;
  fileIds: string[];
  onChange: (next: string[]) => void;
}) {
  const files = UPLOAD_FILES.filter((f) => accepts.includes(f.kind));
  const picked = fileIds.length;
  return (
    <div className="flex flex-col gap-[var(--ds-space-snug)]">
      <div className="flex flex-wrap items-baseline gap-[var(--ds-space-base)]">
        <SectionLabel>Document</SectionLabel>
        <span className={cn(dsText.meta, dsFg.muted)}>
          {multiFile
            ? merge
              ? `${picked} picked — several files merge into ONE document`
              : `${picked} picked — each file is its own run`
            : "one file"}
        </span>
      </div>
      {/* A plain list, deliberately: putting `role="group"` on the `<ul>`
          overrides the list role and leaves every `<li>` an orphaned listitem.
          The cards carry the checkbox/radio semantics themselves. */}
      <ul aria-label="Document" className="flex flex-col gap-[var(--ds-space-tight)]">
        {files.map((file) => (
          <li key={file.id}>
            <FileChoice
              file={file}
              multi={multiFile}
              selected={fileIds.includes(file.id)}
              onToggle={() => {
                if (!multiFile) return onChange([file.id]);
                onChange(fileIds.includes(file.id) ? fileIds.filter((id) => id !== file.id) : [...fileIds, file.id]);
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function TypedInput({
  method,
  workflowId,
  text,
  onText,
  problems,
  validCount,
}: {
  method: Extract<LauncherStartMethodWire, { kind: "typed" }>;
  workflowId: DemoWorkflowId;
  text: string;
  onText: (next: string) => void;
  problems: { position: number; raw: string; problem?: { code: string; message: string } }[];
  validCount: number;
}) {
  const nouns = method.accepts.map((k) => START_VALUE_NOUN[k].many);
  const label = nouns.length === 1 ? nouns[0] : `${nouns.slice(0, -1).join(", ")} or ${nouns[nouns.length - 1]}`;
  const sep = START_SEPARATOR[method.separator];
  return (
    <div className="flex flex-col gap-[var(--ds-space-snug)]">
      <Field
        label={`${label} — ${sep.label}`}
        hint={`${validCount} valid · ${problems.length} refused`}
        error={problems.length > 0 ? `${problems.length} value${problems.length === 1 ? "" : "s"} will not be enqueued — see below.` : null}
        description={method.parserLabel}
      >
        <Textarea
          // Re-keyed per workflow so switching one puts the caret back in the
          // box the operator is about to type into, rather than leaving focus
          // parked on the rail entry they just clicked.
          key={workflowId}
          autoFocus
          rows={method.accepts.includes("personMatch") ? 4 : 2}
          value={text}
          placeholder={method.placeholder}
          onChange={(e) => onText(e.target.value)}
        />
      </Field>
      {problems.length > 0 && (
        <ul className="flex flex-col gap-[var(--ds-space-snug)]">
          {problems.map((entry) => (
            <li key={`${entry.position}-${entry.raw}`}>
              <Banner tone="danger" title={`Value ${entry.position} — ${entry.problem?.code}`}>
                {entry.problem?.message} Nothing on this value is enqueued, and nothing is guessed from it.
              </Banner>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

function firstStartableId(label: string): DemoWorkflowId {
  const byLabel = startableWorkflows().find((w) => w.label === label);
  // The panel you are on is the default; a panel whose workflow cannot be
  // started falls to the first that can, rather than opening on nothing.
  return (byLabel ?? startableWorkflows()[0]).id;
}

function WorkflowTimeline({
  timeline,
  selectedSteps,
  onToggle,
}: {
  timeline: StartTimelineWire;
  selectedSteps: readonly string[];
  onToggle: (key: string) => void;
}) {
  const selected = new Set(selectedSteps);
  return (
    <section aria-label="Workflow steps">
      <ol className="divide-y divide-[color:var(--ds-border-subtle)] border-y border-[color:var(--ds-border)]">
        {timeline.steps.map((step, index) => {
          const isSelected = selected.has(step.key);
          const disabled = Boolean(step.locked);
          return (
            <li key={step.key}>
              <button
                type="button"
                aria-pressed={isSelected}
                aria-label={`${isSelected ? "Skip" : "Include"} ${step.label}`}
                disabled={disabled}
                onClick={() => onToggle(step.key)}
                className={cn(
                  "group flex min-h-[var(--ds-h-bar)] w-full items-center gap-[var(--ds-space-cozy)] px-[var(--ds-space-base)] py-[var(--ds-space-base)] text-left",
                  dsFocus,
                  dsMotion.fast,
                  !disabled && "cursor-pointer hover:bg-[var(--ds-surface-2)]",
                  !isSelected && "bg-[var(--ds-recess-bg)]",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-[var(--ds-h-sm)] shrink-0 items-center justify-center border",
                    dsRadius.pill,
                    isSelected
                      ? "border-transparent bg-[var(--ds-accent)] text-[color:var(--ds-accent-fg)]"
                      : "border-[color:var(--ds-control-border)] text-[color:var(--ds-fg-faint)]",
                  )}
                >
                  {isSelected ? <Check className={dsIcon.sm} /> : <span className={cn(dsText.micro, dsText.nums)}>{index + 1}</span>}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-[var(--ds-space-hair)]">
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-[var(--ds-space-base)]">
                    <span className={cn(dsText.ui, "font-semibold", isSelected ? dsFg.base : dsFg.muted)}>{step.label}</span>
                    <span className={cn(dsText.meta, dsFg.muted)}>{step.system}</span>
                  </span>
                  <span className={cn(dsText.meta, isSelected ? dsFg.secondary : dsFg.faint)}>
                    {isSelected ? step.outcome : "Skipped. Supply its downstream values manually"}
                  </span>
                </span>
                {step.locked ? (
                  <span title={step.lockedReason} className={cn("flex shrink-0 items-center gap-[var(--ds-space-tight)]", dsText.meta, dsFg.muted)}>
                    <LockKeyhole aria-hidden className={dsIcon.sm} />
                    required gate
                  </span>
                ) : (
                  <span className={cn(dsText.meta, isSelected ? dsFg.muted : dsFg.secondary)}>{isSelected ? "On" : "Off"}</span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ReplacementInputs({
  inputs,
  values,
  onChange,
}: {
  inputs: readonly StartReplacementInputWire[];
  values: Readonly<Record<string, string>>;
  onChange: (key: string, value: string) => void;
}) {
  if (inputs.length === 0) return null;
  return (
    <div className="flex flex-col gap-[var(--ds-space-cozy)]">
      <div className="grid grid-cols-1 gap-[var(--ds-space-cozy)] @min-[560px]:grid-cols-2">
        {inputs.map((input) => (
          <Field key={input.key} label={input.label}>
            {input.inputKind === "select" ? (
              <Select value={values[input.key] ?? ""} onChange={(event) => onChange(input.key, event.target.value)}>
                <option value="">{input.placeholder}</option>
                {input.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            ) : (
              <Input
                value={values[input.key] ?? ""}
                placeholder={input.placeholder}
                inputMode={input.inputKind === "id" ? "numeric" : undefined}
                onChange={(event) => onChange(input.key, event.target.value)}
              />
            )}
          </Field>
        ))}
      </div>
    </div>
  );
}

export function DemoRunModal({
  open,
  onOpenChange,
  panelWorkflowLabel,
  onOpenIntake,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the Workflow Panel the operator is standing in — the modal's default */
  panelWorkflowLabel: string;
  onOpenIntake: (sheetId: string) => void;
}) {
  const initialWorkflowId = firstStartableId(panelWorkflowLabel);
  const initialCapability = requireStartCapability(DEMO_WORKFLOWS[initialWorkflowId]);
  const initialMethod = launcherStartMethods(initialCapability)[0];
  const [workflowId, setWorkflowId] = useState<DemoWorkflowId>(() => firstStartableId(panelWorkflowLabel));
  const [method, setMethod] = useState<LauncherStartMethodKind>(() => initialMethod.kind);
  const [choiceValues, setChoiceValues] = useState<Record<string, string>>(() => defaultChoiceValues(initialCapability));
  const [flagValues, setFlagValues] = useState<Record<string, boolean>>(() =>
    defaultFlagValues(initialCapability, defaultChoiceValues(initialCapability)),
  );
  const [text, setText] = useState("");
  const [fileIds, setFileIds] = useState<string[]>([]);
  const [sheetId, setSheetId] = useState("");
  const [policy, setPolicy] = useState<EnqueuePolicy>("reject-active");
  const [priority, setPriority] = useState<"interactive" | "bulk">("interactive");
  const [instances, setInstances] = useState<InstanceChoice>({});
  const [result, setResult] = useState<DemoEnqueueResult | null>(null);
  const [selectedSteps, setSelectedSteps] = useState<string[]>(() =>
    defaultSelectedSteps(initialCapability.timeline),
  );
  const [replacementValues, setReplacementValues] = useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [defaultSteps, setDefaultSteps] = useState(true);
  const [defaultOptions, setDefaultOptions] = useState(true);
  const [currentStage, setCurrentStage] = useState<RunStartStage["label"]>("Input");
  /** the contract version this form was BUILT against — bumped by a reload */
  /* The START CONTRACT each open form was built against. It is a token, not a
     version: a minor (presentation-only) bump leaves every open form valid, so
     nothing here moves for one. */
  const [formContract, setFormContract] = useState<Partial<Record<DemoWorkflowId, string>>>({});

  const selectWorkflow = useCallback((next: DemoWorkflowId) => {
    const capability = requireStartCapability(DEMO_WORKFLOWS[next]);
    const choices = defaultChoiceValues(capability);
    const methods = launcherStartMethods(capability);
    setWorkflowId(next);
    setMethod(methods[0].kind);
    setChoiceValues(choices);
    setFlagValues(defaultFlagValues(capability, choices));
    setText("");
    setFileIds([]);
    setSheetId(SOURCE_SHEETS.find((s) => s.workflow === next)?.id ?? "");
    setSelectedSteps(defaultSelectedSteps(capability.timeline));
    setReplacementValues({});
    setSettingsOpen(false);
    setDefaultSteps(true);
    setDefaultOptions(true);
    setCurrentStage("Input");
    setPolicy("reject-active");
    setPriority("interactive");
    setInstances({});
    setResult(null);
  }, []);

  // Opening lands on the panel you are standing in, every time — including the
  // second time, which is why this keys on `open` rather than running once.
  useEffect(() => {
    if (open) selectWorkflow(firstStartableId(panelWorkflowLabel));
  }, [open, panelWorkflowLabel, selectWorkflow]);

  const workflow = DEMO_WORKFLOWS[workflowId];
  const capability = requireStartCapability(workflow);
  const methodWire = requireLauncherStartMethod(capability, method, choiceValues);
  const builtContract = formContract[workflowId] ?? startContractToken(workflow);

  const choices = visibleChoices(capability, method, choiceValues).filter(
    (choice) => !(capability.timeline && choice.key === "preset"),
  );
  const flags = visibleFlags(capability, method);
  const dryRun = flags.some((f) => f.key === "dryRun") && flagValues.dryRun === true;
  const duplicateCheck = flags.some((f) => f.key === "duplicateCheck") && flagValues.duplicateCheck === true;
  const crmCheck = flags.some((f) => f.key === "crmCheck") && flagValues.crmCheck === true;
  const replacementInputs = useMemo(
    () => replacementInputsForSelection(capability.timeline, selectedSteps),
    [capability.timeline, selectedSteps],
  );
  const missingReplacement = useMemo(
    () => missingReplacementInputs(replacementInputs, replacementValues),
    [replacementInputs, replacementValues],
  );
  const customizationSections = useMemo(
    () => runStartCustomizationSections({
      timeline: capability.timeline,
      defaultSteps,
      defaultOptions,
      selectedSteps,
    }),
    [capability.timeline, defaultSteps, defaultOptions, selectedSteps],
  );
  const launchStages = useMemo(() => runStartStages(customizationSections), [customizationSections]);

  useEffect(() => {
    setCurrentStage((current) => reconcileRunStartStage(launchStages, current));
  }, [launchStages]);

  const entries = useMemo(
    () => (methodWire.kind === "typed" ? parseEntries(text, methodWire.accepts, methodWire.separator) : []),
    [methodWire, text],
  );
  const bad = entries.filter((e) => e.problem);
  const valid = entries.filter((e) => !e.problem);
  const files = useMemo(() => fileIds.map((id) => UPLOAD_FILES.find((f) => f.id === id)).filter((f): f is UploadFileFixture => Boolean(f)), [fileIds]);
  const sheets = useMemo(() => SOURCE_SHEETS.filter((s) => s.workflow === workflowId), [workflowId]);

  const plan = useMemo(
    () => deriveStartPlan({ workflow, method: methodWire, entries, files }),
    [workflow, methodWire, entries, files],
  );

  const conflict = activeConflictFor(
    workflowId,
    methodWire.kind === "typed" ? valid.map((e) => e.value) : files.map((f) => f.fileName),
  );

  const scopeLabel =
    methodWire.kind === "typed"
      ? `${valid.length} typed value${valid.length === 1 ? "" : "s"}`
      : methodWire.kind === "upload"
        ? files.map((f) => `“${f.fileName}”`).join(", ")
        : workflow.label;

  const methodBlockedReason =
    methodWire.kind === "typed"
      ? valid.length === 0
        ? "Type at least one value."
        : bad.length > 0
          ? "Fix or remove the refused values first."
          : null
      : methodWire.kind === "upload"
        ? files.length === 0
          ? "Pick at least one document."
          : null
        : methodWire.kind === "spreadsheet" && !sheetId
            ? "Pick a sheet."
            : null;
  const blockedReason =
    methodBlockedReason ??
    (missingReplacement.length > 0
      ? `Fill ${missingReplacement.map((input) => input.label).join(", ")} for the steps you turned off.`
      : null);

  const previousStage = adjacentRunStartStage(launchStages, currentStage, "previous");
  const nextStage = adjacentRunStartStage(launchStages, currentStage, "next");
  const stageBlockedReason =
    currentStage === "Input"
      ? methodBlockedReason
      : currentStage === "Values" && missingReplacement.length > 0
        ? `Fill ${missingReplacement.map((input) => input.label).join(", ")}.`
        : currentStage === "Confirm"
          ? blockedReason
          : null;

  const start = useCallback(() => {
    setResult(
      submitDemoEnqueue({
        workflow: workflowId,
        expectedContract: builtContract,
        method,
        plan,
        policy,
        dryRun,
        duplicateCheck,
        crmCheck,
        instances,
        choices: effectiveChoiceValues(capability, method, choiceValues),
        scopeLabel,
        activeConflictSubject: conflict?.label,
      }),
    );
  }, [workflowId, builtContract, method, plan, policy, dryRun, duplicateCheck, crmCheck, instances, capability, choiceValues, scopeLabel, conflict]);

  const isHandoff = methodWire.kind === "spreadsheet";
  const changeDefaultSteps = (next: boolean) => {
    setDefaultSteps(next);
    if (next) {
      setSelectedSteps(defaultSelectedSteps(capability.timeline));
    } else if (currentStage === "Confirm") {
      setCurrentStage("Steps");
    }
    setResult(null);
  };
  const changeDefaultOptions = (next: boolean) => {
    setDefaultOptions(next);
    if (next) {
      const defaults = defaultChoiceValues(capability);
      setChoiceValues(defaults);
      setFlagValues(defaultFlagValues(capability, defaults));
      setPolicy("reject-active");
      setPriority("interactive");
      setInstances({});
    } else if (currentStage === "Confirm") {
      setCurrentStage("Options");
    }
    setResult(null);
  };

  const skippedSteps = capability.timeline?.steps.filter((step) => !selectedSteps.includes(step.key)) ?? [];
  const lockedGateCount = capability.timeline?.steps.filter((step) => step.locked).length ?? 0;
  const replacementSummary = replacementInputs.map((input) => {
    const value = replacementValues[input.key]?.trim() ?? "";
    const optionLabel = input.options?.find((option) => option.value === value)?.label;
    return `${input.label}: ${optionLabel ?? value}`;
  });
  const flagDefaults = defaultFlagValues(capability, choiceValues);
  const optionChanges = [
    ...choices
      .filter((choice) => (choiceValues[choice.key] ?? choice.defaultValue) !== choice.defaultValue)
      .map((choice) => `${choice.label}: ${choiceOptionLabel(choice, choiceValues[choice.key] ?? choice.defaultValue)}`),
    ...flags
      .filter((flag) => (flagValues[flag.key] ?? flagDefaults[flag.key]) !== flagDefaults[flag.key])
      .map((flag) => `${flag.label}: ${(flagValues[flag.key] ?? flagDefaults[flag.key]) ? "On" : "Off"}`),
    ...(policy !== "reject-active" ? [`Active-run policy: ${ENQUEUE_POLICY_LABEL[policy]}`] : []),
    ...(priority !== "interactive" ? ["Priority: Bulk"] : []),
  ];
  const inputSummary =
    methodWire.kind === "typed"
      ? valid.map((entry) => entry.value).join(", ")
      : methodWire.kind === "upload"
        ? files.map((file) => file.fileName).join(", ")
        : methodWire.kind === "spreadsheet"
          ? sheets.find((sheet) => sheet.id === sheetId)?.fileName ?? "No sheet selected"
          : "No input required";
  const targetTestSystems = testSystems(workflow, instances);

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setResult(null); }}>
      <DialogContent
        size="lg"
        title="Start a run"
        className="h-[min(86dvh,720px)]"
      >
        <div className="flex min-h-0 flex-1">
          <WorkflowPicker value={workflowId} onChange={selectWorkflow} />

          <DialogBody className="@container flex flex-1 flex-col gap-[var(--ds-space-section)]">
            <Field label="Workflow" className="min-[768px]:hidden">
              <Select value={workflowId} onChange={(event) => selectWorkflow(event.target.value as DemoWorkflowId)}>
                {startableWorkflows().map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
              </Select>
            </Field>
            {result && (
              <EnqueueResultBanner
                result={result}
                onDismiss={() => setResult(null)}
                onReload={() => {
                  // The ONLY cure for a stale contract: rebuild the form on the
                  // version the server actually serves, then look again.
                  setFormContract((prev) => ({ ...prev, [workflowId]: serverContractToken(workflow) }));
                  setResult(null);
                }}
              />
            )}

            <ol
              aria-label="Run configuration path"
              className="flex flex-wrap items-center gap-[var(--ds-space-base)] border-b border-[color:var(--ds-border)] pb-[var(--ds-space-cozy)]"
            >
              {launchStages.map((stage, index) => (
                <li
                  key={stage.label}
                  aria-current={stage.label === currentStage ? "step" : undefined}
                  className="flex items-center gap-[var(--ds-space-base)]"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-[var(--ds-h-sm)] shrink-0 items-center justify-center",
                      dsRadius.pill,
                      dsText.micro,
                      dsText.nums,
                      stage.label === currentStage
                        ? "bg-[var(--ds-accent)] text-[color:var(--ds-accent-fg)]"
                        : "bg-[var(--ds-surface-3)]",
                      stage.label !== currentStage && dsFg.muted,
                    )}
                  >
                    {stage.number}
                  </span>
                  <span className={cn(dsText.ui, stage.label === currentStage ? "font-semibold" : dsFg.muted)}>
                    {stage.label}
                  </span>
                  {index < launchStages.length - 1 && <ArrowRight aria-hidden className={cn(dsIcon.sm, dsFg.faint)} />}
                </li>
              ))}
            </ol>

            <section className="flex flex-col gap-[var(--ds-space-snug)]">
              <div className="flex min-w-0 items-start gap-[var(--ds-space-base)]">
                <h3 className={cn(dsText.section, "min-w-0 flex-1 font-semibold", dsFg.base)}>{workflow.label}</h3>
                <DropdownMenu modal={false} open={settingsOpen} onOpenChange={setSettingsOpen}>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      label="Run settings"
                      size="md"
                      variant="outline"
                      icon={<Settings aria-hidden className={dsIcon.md} />}
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    {capability.timeline && (
                      <DropdownMenuCheckboxItem
                        checked={defaultSteps}
                        onCheckedChange={(next) => changeDefaultSteps(next === true)}
                        onSelect={(event) => event.preventDefault()}
                      >
                        Default steps
                      </DropdownMenuCheckboxItem>
                    )}
                    <DropdownMenuCheckboxItem
                      checked={defaultOptions}
                      onCheckedChange={(next) => changeDefaultOptions(next === true)}
                      onSelect={(event) => event.preventDefault()}
                    >
                      Default options
                    </DropdownMenuCheckboxItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </section>

            <div className="flex min-w-0 flex-col gap-[var(--ds-space-loose)]">
              {currentStage === "Input" && (
                <section aria-labelledby="run-start-input" className="flex flex-col gap-[var(--ds-space-loose)]">
                  <h4 id="run-start-input" className={cn(dsText.title, "font-semibold", dsFg.base)}>Input</h4>
                  {launcherStartMethods(capability).length > 1 && (
                    <MethodTabs
                      methods={launcherStartMethods(capability)}
                      value={method}
                      onChange={(next) => { setMethod(next); setResult(null); }}
                    />
                  )}
                  {methodWire.kind === "typed" && (
                    <TypedInput method={methodWire} workflowId={workflowId} text={text} onText={(next) => { setText(next); setResult(null); }} problems={bad} validCount={valid.length} />
                  )}
                  {methodWire.kind === "upload" && (
                    <UploadInput accepts={methodWire.accepts} multiFile={methodWire.multiFile} merge={methodWire.merge} fileIds={fileIds} onChange={(next) => { setFileIds(next); setResult(null); }} />
                  )}
                  {methodWire.kind === "spreadsheet" && (
                    <Field label="Sheet">
                      <Select value={sheetId} onChange={(event) => { setSheetId(event.target.value); setResult(null); }}>
                        {sheets.map((sheet) => <option key={sheet.id} value={sheet.id}>{sheet.fileName} · {sheet.sizeLabel}</option>)}
                      </Select>
                    </Field>
                  )}
                  {methodWire.kind === "bare" && <Well><span className={cn(dsText.ui, "font-semibold", dsFg.base)}>Nothing to fill in</span></Well>}
                </section>
              )}

              {currentStage === "Steps" && capability.timeline && (
                <section aria-labelledby="run-start-steps" className="flex flex-col gap-[var(--ds-space-cozy)]">
                  <div className="flex flex-wrap items-baseline justify-between gap-[var(--ds-space-base)]">
                    <h4 id="run-start-steps" className={cn(dsText.title, "font-semibold", dsFg.base)}>Steps</h4>
                    <span className={cn(dsText.meta, dsText.nums, dsFg.muted)}>
                      {selectedSteps.length} of {capability.timeline.steps.length} included
                    </span>
                  </div>
                  <WorkflowTimeline
                    timeline={capability.timeline}
                    selectedSteps={selectedSteps}
                    onToggle={(key) => {
                      const next = selectedSteps.includes(key)
                        ? selectedSteps.filter((step) => step !== key)
                        : [...selectedSteps, key];
                      setSelectedSteps(next);
                      setResult(null);
                    }}
                  />
                </section>
              )}

              {currentStage === "Values" && (
                <section aria-labelledby="run-start-values" className="flex flex-col gap-[var(--ds-space-cozy)]">
                  <div className="flex flex-wrap items-baseline justify-between gap-[var(--ds-space-base)]">
                    <h4 id="run-start-values" className={cn(dsText.title, "font-semibold", dsFg.base)}>Values</h4>
                    <span className={cn(dsText.meta, dsText.nums, dsFg.muted)}>{replacementInputs.length} required</span>
                  </div>
                  <ReplacementInputs
                    inputs={replacementInputs}
                    values={replacementValues}
                    onChange={(key, value) => { setReplacementValues((current) => ({ ...current, [key]: value })); setResult(null); }}
                  />
                </section>
              )}

              {currentStage === "Options" && (
                <section aria-labelledby="run-start-options" className="flex flex-col gap-[var(--ds-space-cozy)]">
                  <h4 id="run-start-options" className={cn(dsText.title, "font-semibold", dsFg.base)}>Options</h4>
                  <div className="flex flex-col gap-[var(--ds-space-loose)]">
                    {choices.length > 0 && (
                      <div className="grid grid-cols-1 gap-[var(--ds-space-cozy)] @min-[560px]:grid-cols-2">
                        {choices.map((choice) => (
                          <StartChoiceControl key={choice.key} choice={choice} value={choiceValues[choice.key] ?? choice.defaultValue} onChange={(next) => {
                            const nextChoices = { ...choiceValues, [choice.key]: next };
                            setChoiceValues(nextChoices);
                            setFlagValues((previous) => {
                              const defaults = defaultFlagValues(capability, nextChoices);
                              const changed = { ...previous };
                              for (const flag of capability.flags) if (flag.defaultWhen?.choice === choice.key) changed[flag.key] = defaults[flag.key];
                              return changed;
                            });
                            setResult(null);
                          }} />
                        ))}
                      </div>
                    )}
                    {!isHandoff && (
                      <div className="grid grid-cols-1 gap-[var(--ds-space-cozy)] @min-[560px]:grid-cols-2">
                        <Field label="Active-run policy" description={conflict ? `${conflict.label} — ${conflict.note}.` : undefined}>
                          <Select value={policy} onChange={(event) => { setPolicy(event.target.value as EnqueuePolicy); setResult(null); }}>
                            {(Object.keys(ENQUEUE_POLICY_LABEL) as EnqueuePolicy[]).map((key) => <option key={key} value={key}>{ENQUEUE_POLICY_LABEL[key]}</option>)}
                          </Select>
                        </Field>
                        <Field label="Priority">
                          <Select value={priority} onChange={(event) => setPriority(event.target.value as "interactive" | "bulk")}>
                            <option value="interactive">Interactive</option>
                            <option value="bulk">Bulk</option>
                          </Select>
                        </Field>
                      </div>
                    )}
                    {flags.map((flag) => (
                      <StartFlagControl key={flag.key} flag={flag} checked={flagValues[flag.key] ?? defaultFlagValues(capability, choiceValues)[flag.key]} onChange={(next) => { setFlagValues((previous) => ({ ...previous, [flag.key]: next })); setResult(null); }} />
                    ))}
                    {!isHandoff && <InstanceSelector workflow={workflow} value={instances} onChange={(next) => { setInstances(next); setResult(null); }} />}
                  </div>
                </section>
              )}

              {currentStage === "Confirm" && (
                <section aria-labelledby="run-start-confirm" className="flex flex-col gap-[var(--ds-space-cozy)]">
                  <div className="flex flex-wrap items-center justify-between gap-[var(--ds-space-base)]">
                    <h4 id="run-start-confirm" className={cn(dsText.title, "font-semibold", dsFg.base)}>Confirm</h4>
                    <RunFlagChips dryRun={dryRun} test={targetTestSystems} priority={priority} />
                  </div>
                  <Well className="p-[var(--ds-space-cozy)]">
                    <KeyValueList
                      className="grid-cols-[max-content_minmax(0,1fr)] [&_dd]:overflow-visible [&_dd]:whitespace-normal [&_dd]:break-words [&_dd]:text-clip"
                      items={[
                        { key: "Workflow", value: workflow.label },
                        { key: "Input", value: inputSummary },
                        { key: "Creates", value: plan.headline },
                        {
                          key: "Steps",
                          value: skippedSteps.length > 0
                            ? `Skip ${skippedSteps.map((step) => step.label).join(", ")}`
                            : "Default workflow",
                        },
                        {
                          key: "Values",
                          value: replacementSummary.length > 0 ? replacementSummary.join(" · ") : "No manual values",
                        },
                        {
                          key: "Options",
                          value: optionChanges.length > 0 ? optionChanges.join(" · ") : "Defaults retained",
                        },
                        {
                          key: "Safety",
                          value: `${lockedGateCount} required gate${lockedGateCount === 1 ? "" : "s"} · ${ENQUEUE_POLICY_LABEL[policy]}`,
                        },
                      ]}
                    />
                  </Well>
                  {conflict && (
                    <Banner tone="warning" title={`Active run found for ${conflict.label}`}>
                      {conflict.note}. The selected policy is {ENQUEUE_POLICY_LABEL[policy].toLowerCase()}.
                    </Banner>
                  )}
                  {plan.warnings.map((warning) => (
                    <Banner key={warning} tone="warning" title="Check before starting">{warning}</Banner>
                  ))}
                </section>
              )}
            </div>
          </DialogBody>
        </div>

        <DialogFooter
          meta={
            <MetaLine
              tone="faint"
              items={
                [
                  `${workflow.label} ${workflowVersionTag(workflow)}`,
                  stageBlockedReason ?? (currentStage === "Confirm" && !isHandoff && plan.rows.length > 0 ? plan.headline : undefined),
                ].filter(Boolean) as string[]
              }
            />
          }
        >
          {previousStage && (
            <Button variant="secondary" onClick={() => setCurrentStage(previousStage)}>Back</Button>
          )}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          {currentStage !== "Confirm" ? (
            <Button
              variant="primary"
              disabled={Boolean(stageBlockedReason) || nextStage === null}
              onClick={() => { if (nextStage) setCurrentStage(nextStage); }}
            >
              Next
            </Button>
          ) : isHandoff ? (
            <Button
              variant="primary"
              icon={<FileSpreadsheet aria-hidden className={dsIcon.md} />}
              disabled={!sheetId}
              onClick={() => { onOpenChange(false); onOpenIntake(sheetId); }}
            >
              Open the intake…
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Play aria-hidden className={dsIcon.md} />}
              disabled={Boolean(blockedReason) || result?.state === "applied"}
              onClick={start}
            >
              {dryRun ? "Start dry run" : "Start run"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The modal plus the one surface it hands off to. Mounted at the shell's ROOT,
 * not inside the queue toolbar, because "reachable from anywhere" has to be
 * true on the Settings, Archive, Explorer and Report takeovers too — none of
 * which draw a toolbar.
 */
export function DemoRunStartSurfaces({
  open,
  onOpenChange,
  panelWorkflowLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  panelWorkflowLabel: string;
}) {
  const [intakeSheetId, setIntakeSheetId] = useState<string | null>(null);
  return (
    <>
      <DemoRunModal
        open={open}
        onOpenChange={onOpenChange}
        panelWorkflowLabel={panelWorkflowLabel}
        onOpenIntake={(sheetId) => setIntakeSheetId(sheetId)}
      />
      <DemoIntakeDialog
        open={intakeSheetId !== null}
        initialSheetId={intakeSheetId}
        onOpenChange={(next) => { if (!next) setIntakeSheetId(null); }}
      />
    </>
  );
}
