import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Camera,
  FileSpreadsheet,
  FileText,
  Keyboard,
  Layers,
  Play,
  Search,
  SlidersHorizontal,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  Button,
  Card,
  Chip,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  EmptyState,
  Field,
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
  defaultChoiceValues,
  defaultFlagValues,
  effectiveChoiceValues,
  requireStartCapability,
  requireStartMethod,
  startContractToken,
  startWorkflowGroups,
  startableWorkflows,
  unstartableWorkflows,
  visibleChoices,
  visibleFlags,
  workflowVersionTag,
  type DemoWorkflowId,
  type DemoWorkflowRef,
  type StartMethodKind,
  type StartMethodWire,
} from "./demo-wire";
import {
  ACTIVE_STARTS,
  ENQUEUE_POLICY_LABEL,
  serverContractToken,
  UPLOAD_FILES,
  activeConflictFor,
  captureSessionsFor,
  deriveStartPlan,
  summarizeCaptureSession,
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
  PlanPreview,
  RunFlagChips,
  StartChoiceControl,
  StartFlagControl,
} from "./DemoRunStartKit";
import { DemoCapturePanel } from "./DemoCapture";
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
 *    EIDs, an uploaded packet or photographed pages; they are three tabs, not an
 *    empty box that secretly opens a different modal.
 *  - **The plan is shown before the commit, and it never counts people.** Before
 *    a review reads a document the backend knows PAGES. The preview says pages.
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
      variant="primary"
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
    <div className="flex w-[204px] shrink-0 flex-col border-r border-[color:var(--ds-border)]">
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

const METHOD_ICON: Record<StartMethodKind, ReactNode> = {
  typed: <Keyboard aria-hidden className={dsIcon.sm} />,
  upload: <Upload aria-hidden className={dsIcon.sm} />,
  capture: <Camera aria-hidden className={dsIcon.sm} />,
  spreadsheet: <FileSpreadsheet aria-hidden className={dsIcon.sm} />,
  bare: <Play aria-hidden className={dsIcon.sm} />,
};

function MethodTabs({
  methods,
  value,
  onChange,
}: {
  methods: StartMethodWire[];
  value: StartMethodKind;
  onChange: (next: StartMethodKind) => void;
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
  method: Extract<StartMethodWire, { kind: "typed" }>;
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
      {method.examples && method.examples.length > 0 && (
        <div className="flex flex-wrap items-center gap-[var(--ds-space-snug)]">
          <SectionLabel>Examples</SectionLabel>
          {method.examples.map((example) => (
            <Button
              key={example.key}
              size="sm"
              variant="outline"
              title={example.note}
              onClick={() => onText(example.values.join(`${sep.char} `))}
            >
              {example.label}
            </Button>
          ))}
        </div>
      )}
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
          rows={4}
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
  const [workflowId, setWorkflowId] = useState<DemoWorkflowId>(() => firstStartableId(panelWorkflowLabel));
  const [method, setMethod] = useState<StartMethodKind>("typed");
  const [choiceValues, setChoiceValues] = useState<Record<string, string>>({});
  const [flagValues, setFlagValues] = useState<Record<string, boolean>>({});
  const [text, setText] = useState("");
  const [fileIds, setFileIds] = useState<string[]>([]);
  const [sheetId, setSheetId] = useState("");
  /** which of the workflow's open capture sessions this start is about */
  const [captureId, setCaptureId] = useState("");
  const [policy, setPolicy] = useState<EnqueuePolicy>("reject-active");
  const [priority, setPriority] = useState<"interactive" | "bulk">("interactive");
  const [instances, setInstances] = useState<InstanceChoice>({});
  const [result, setResult] = useState<DemoEnqueueResult | null>(null);
  /** the contract version this form was BUILT against — bumped by a reload */
  /* The START CONTRACT each open form was built against. It is a token, not a
     version: a minor (presentation-only) bump leaves every open form valid, so
     nothing here moves for one. */
  const [formContract, setFormContract] = useState<Partial<Record<DemoWorkflowId, string>>>({});

  const selectWorkflow = useCallback((next: DemoWorkflowId) => {
    const capability = requireStartCapability(DEMO_WORKFLOWS[next]);
    const choices = defaultChoiceValues(capability);
    setWorkflowId(next);
    setMethod(capability.methods[0].kind);
    setChoiceValues(choices);
    setFlagValues(defaultFlagValues(capability, choices));
    setText("");
    setFileIds([]);
    setSheetId(SOURCE_SHEETS.find((s) => s.workflow === next)?.id ?? "");
    // Reset rather than carry: a session id belongs to ONE workflow, so keeping
    // the old one would leave the form pointing at a session this start could
    // never use. A workflow with none is left holding "", which resolves to no
    // session — the honest answer, not a substituted one.
    setCaptureId(captureSessionsFor(next)[0]?.id ?? "");
    setResult(null);
  }, []);

  // Opening lands on the panel you are standing in, every time — including the
  // second time, which is why this keys on `open` rather than running once.
  useEffect(() => {
    if (open) selectWorkflow(firstStartableId(panelWorkflowLabel));
  }, [open, panelWorkflowLabel, selectWorkflow]);

  const workflow = DEMO_WORKFLOWS[workflowId];
  const capability = requireStartCapability(workflow);
  const methodWire = requireStartMethod(capability, method, choiceValues);
  const builtContract = formContract[workflowId] ?? startContractToken(workflow);

  const choices = visibleChoices(capability, method, choiceValues);
  const flags = visibleFlags(capability, method);
  const dryRun = flags.some((f) => f.key === "dryRun") && flagValues.dryRun === true;
  const duplicateCheck = flags.some((f) => f.key === "duplicateCheck") && flagValues.duplicateCheck === true;
  const crmCheck = flags.some((f) => f.key === "crmCheck") && flagValues.crmCheck === true;

  const entries = useMemo(
    () => (methodWire.kind === "typed" ? parseEntries(text, methodWire.accepts, methodWire.separator) : []),
    [methodWire, text],
  );
  const bad = entries.filter((e) => e.problem);
  const valid = entries.filter((e) => !e.problem);
  const files = useMemo(() => fileIds.map((id) => UPLOAD_FILES.find((f) => f.id === id)).filter((f): f is UploadFileFixture => Boolean(f)), [fileIds]);
  const captureSessions = useMemo(() => captureSessionsFor(workflowId), [workflowId]);
  const capture = captureSessions.find((s) => s.id === captureId);
  const sheets = useMemo(() => SOURCE_SHEETS.filter((s) => s.workflow === workflowId), [workflowId]);

  const plan = useMemo(
    () => deriveStartPlan({ workflow, method: methodWire, entries, files, capture }),
    [workflow, methodWire, entries, files, capture],
  );

  const test = testSystems(workflow, instances);
  const conflict = activeConflictFor(
    workflowId,
    methodWire.kind === "typed" ? valid.map((e) => e.value) : files.map((f) => f.fileName),
  );

  const scopeLabel =
    methodWire.kind === "typed"
      ? `${valid.length} typed value${valid.length === 1 ? "" : "s"}`
      : methodWire.kind === "upload"
        ? files.map((f) => `“${f.fileName}”`).join(", ")
        : methodWire.kind === "capture" && capture
          ? `capture session ${capture.id}`
          : workflow.label;

  const blockedReason =
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
        : methodWire.kind === "capture"
          ? !capture
            ? "No capture session is open for this workflow."
            : // The panel's own blockers, unchanged — the footer and the panel
              // cannot say different things about the same session.
              (summarizeCaptureSession(capture).blockers[0] ?? null)
          : methodWire.kind === "spreadsheet" && !sheetId
            ? "Pick a sheet."
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

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setResult(null); }}>
      <DialogContent
        size="xl"
        title="Start a run"
        description="Pick what to run. It declares what it takes, and the plan says exactly what will exist before anything is enqueued."
        className="h-[min(86vh,700px)]"
      >
        <div className="flex min-h-0 flex-1">
          <WorkflowPicker value={workflowId} onChange={selectWorkflow} />

          {/* `@container`, not a viewport query: the form column's width is set
              by the picker beside it, so a two-up grid has to key on the column
              it actually lives in. */}
          <DialogBody className="@container flex flex-1 flex-col gap-[var(--ds-space-loose)]">
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

            {/* What you are starting, and how — the two facts everything below
                is conditioned on, on one line each. */}
            <section className="flex flex-col gap-[var(--ds-space-snug)]">
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-base)]">
                <h3 className={cn(dsText.section, "min-w-0 font-semibold", dsFg.base)}>{workflow.label}</h3>
                <Chip label="group">{workflow.category}</Chip>
                <RunFlagChips dryRun={dryRun} test={test} priority={priority} />
              </div>
              <p className={cn(dsText.body, dsFg.secondary, "max-w-[74ch]")}>{capability.note}</p>
              {capability.methods.length > 1 && (
                <MethodTabs
                  methods={capability.methods}
                  value={method}
                  onChange={(next) => {
                    setMethod(next);
                    setResult(null);
                  }}
                />
              )}
              <p className={cn(dsText.meta, dsFg.muted, "max-w-[74ch]")}>{methodWire.note}</p>
            </section>

            {/* The input */}
            {methodWire.kind === "typed" && (
              <TypedInput
                method={methodWire}
                workflowId={workflowId}
                text={text}
                onText={(next) => { setText(next); setResult(null); }}
                problems={bad}
                validCount={valid.length}
              />
            )}

            {methodWire.kind === "upload" && (
              <UploadInput
                accepts={methodWire.accepts}
                multiFile={methodWire.multiFile}
                merge={methodWire.merge}
                fileIds={fileIds}
                onChange={(next) => { setFileIds(next); setResult(null); }}
              />
            )}

            {methodWire.kind === "capture" && (
              <DemoCapturePanel
                sessions={captureSessions}
                sessionId={captureId}
                onSessionId={(next) => {
                  setCaptureId(next);
                  setResult(null);
                }}
              />
            )}

            {methodWire.kind === "spreadsheet" && (
              <section className="flex flex-col gap-[var(--ds-space-snug)]">
                <Field label="Sheet" description="The intake owns the rest: a header row, a column mapping, then every row accepted or rejected by name.">
                  <Select value={sheetId} onChange={(e) => setSheetId(e.target.value)}>
                    {sheets.map((sheet) => (
                      <option key={sheet.id} value={sheet.id}>
                        {sheet.fileName} · {sheet.sizeLabel}
                      </option>
                    ))}
                  </Select>
                </Field>
              </section>
            )}

            {methodWire.kind === "bare" && (
              <Well className="flex flex-col gap-[var(--ds-space-tight)]">
                <span className={cn(dsText.ui, "font-semibold", dsFg.base)}>Nothing to fill in</span>
                <span className={cn(dsText.body, dsFg.secondary, "max-w-[74ch]")}>
                  This start takes no subject and offers no sub-selections. That is the honest shape of it, not a form that failed to load.
                </span>
              </Well>
            )}

            {/* Sub-selections — descriptor-driven, and absent when there are none */}
            {choices.length > 0 && (
              <section className="flex flex-col gap-[var(--ds-space-cozy)]">
                <SectionLabel>
                  <SlidersHorizontal aria-hidden className={cn(dsIcon.sm, "mr-[var(--ds-space-tight)] inline")} />
                  How this run is shaped
                </SectionLabel>
                <div className="grid grid-cols-1 gap-[var(--ds-space-cozy)] @min-[560px]:grid-cols-2">
                  {choices.map((choice) => (
                    <StartChoiceControl
                      key={choice.key}
                      choice={choice}
                      value={choiceValues[choice.key] ?? choice.defaultValue}
                      onChange={(next) => {
                        const nextChoices = { ...choiceValues, [choice.key]: next };
                        setChoiceValues(nextChoices);
                        setFlagValues((prev) => {
                          const defaults = defaultFlagValues(capability, nextChoices);
                          const changed = { ...prev };
                          for (const flag of capability.flags) {
                            if (flag.defaultWhen?.choice === choice.key) changed[flag.key] = defaults[flag.key];
                          }
                          return changed;
                        });
                        setResult(null);
                      }}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Run settings — the axes every start has, whatever it is */}
            {!isHandoff && (
              <section className="flex flex-col gap-[var(--ds-space-cozy)]">
                <SectionLabel>Run settings</SectionLabel>
                <div className="grid grid-cols-1 gap-[var(--ds-space-cozy)] @min-[560px]:grid-cols-2">
                  <Field
                    label="If one is already running"
                    description={conflict ? `${conflict.label} — ${conflict.note}.` : "Nothing is running for this subject."}
                  >
                    <Select value={policy} onChange={(e) => { setPolicy(e.target.value as EnqueuePolicy); setResult(null); }}>
                      {(Object.keys(ENQUEUE_POLICY_LABEL) as EnqueuePolicy[]).map((key) => (
                        <option key={key} value={key}>
                          {ENQUEUE_POLICY_LABEL[key]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Priority" description="bulk work yields the browser lane to anything interactive">
                    <Select value={priority} onChange={(e) => setPriority(e.target.value as "interactive" | "bulk")}>
                      <option value="interactive">interactive</option>
                      <option value="bulk">bulk</option>
                    </Select>
                  </Field>
                </div>
                {flags.length > 0 && (
                  <div className="flex flex-col gap-[var(--ds-space-base)]">
                    {flags.map((flag) => (
                      <StartFlagControl
                        key={flag.key}
                        flag={flag}
                        checked={flagValues[flag.key] ?? defaultFlagValues(capability, choiceValues)[flag.key]}
                        onChange={(next) => {
                          setFlagValues((prev) => ({ ...prev, [flag.key]: next }));
                          setResult(null);
                        }}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {!isHandoff && (
              <section className="flex flex-col gap-[var(--ds-space-snug)]">
                <SectionLabel>Instance — where this will write</SectionLabel>
                <InstanceSelector workflow={workflow} value={instances} onChange={(next) => { setInstances(next); setResult(null); }} />
              </section>
            )}

            {/* The plan */}
            <section className="flex flex-col gap-[var(--ds-space-snug)]">
              <SectionLabel>What this will create</SectionLabel>
              {isHandoff ? (
                <Well className="flex flex-col gap-[var(--ds-space-snug)]">
                  <span className={cn(dsText.ui, "font-semibold", dsFg.base)}>{plan.headline}</span>
                  {plan.decisions.map((decision) => (
                    <span key={decision} className={cn(dsText.body, dsFg.secondary, "max-w-[74ch]")}>
                      {decision}
                    </span>
                  ))}
                </Well>
              ) : plan.rows.length === 0 ? (
                // Bounded, not floating: this is the slot the plan will fill, so
                // it holds its shape rather than leaving a hole in a dense modal
                // the operator reads top to bottom.
                <Well>
                  <EmptyState
                    className="p-[var(--ds-space-base)]"
                    icon={<Layers aria-hidden className={dsIcon.lg} />}
                    title={plan.headline}
                    description="Fill in the input above and this fills in with the exact rows the start would create, which panel each one lands in, and the decisions that shape it."
                  />
                </Well>
              ) : (
                <PlanPreview plan={plan} dryRun={dryRun} test={test} />
              )}
            </section>
          </DialogBody>
        </div>

        {/* The footer says either why you cannot start or exactly what starting
            will make. The plan's cards live in the body where they belong, but
            its ANSWER — the row count — sits beside the verb, so the operator
            never has to scroll back down to check what they are about to press.
            An empty plan has nothing to promise, so it promises nothing. */}
        <DialogFooter
          meta={
            <MetaLine
              tone="faint"
              items={
                [
                  `${workflow.label} ${workflowVersionTag(workflow)}`,
                  blockedReason ?? (isHandoff || plan.rows.length === 0 ? undefined : plan.headline),
                ].filter(Boolean) as string[]
              }
            />
          }
        >
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {isHandoff ? (
            <Button
              variant="primary"
              icon={<FileSpreadsheet aria-hidden className={dsIcon.md} />}
              disabled={!sheetId}
              onClick={() => {
                onOpenChange(false);
                onOpenIntake(sheetId);
              }}
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
