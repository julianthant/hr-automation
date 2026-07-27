import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, FileSpreadsheet, FileText, Keyboard, Play, Upload } from "lucide-react";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
  SectionLabel,
  Select,
  Switch,
  Textarea,
  Well,
  dsFg,
  dsFocus,
  dsIcon,
  dsMotion,
  dsRadius,
  dsText,
} from "./demo-ui";
import { DEMO_WORKFLOWS, type DemoWorkflowId } from "./demo-wire";
import {
  ENQUEUE_POLICY_LABEL,
  INPUT_RUN_SPECS,
  SERVER_WORKFLOW_VERSION,
  UPLOAD_FILES,
  UPLOAD_RUN_SPECS,
  deriveInputPlan,
  deriveUploadPlan,
  parseEntries,
  submitDemoEnqueue,
  testSystems,
  titlePhases,
  type DemoEnqueueResult,
  type EnqueuePolicy,
  type InstanceChoice,
  type UploadFileFixture,
} from "./demo-runstart-wire";
import { EnqueueResultBanner, InstanceSelector, PlanPreview, RunFlagChips } from "./DemoRunStartKit";
import { DemoIntakeDialog } from "./DemoIntake";

/**
 * DEV-ONLY — the run-START half of the product: the **Run Modal** (upload run)
 * and the **Input Run Panel** (typed run), plus the launcher that reaches them.
 *
 * The demo could show every state a run reaches and offered no way to create
 * one, which meant the two decisions that actually cost an operator money —
 * *what will this create?* and *where will it write?* — had no surface at all.
 *
 * Three things are deliberate here:
 *
 *  - **The plan is shown BEFORE the commit.** `deriveUploadPlan` /
 *    `deriveInputPlan` are the mock server answering "what rows will exist";
 *    the modal renders that answer. A packet is a Group Row + a delegated
 *    review; oath-upload is ONE Run Row whose signers are `linked` in another
 *    panel (D6). Neither is a UI branch — both come off the descriptor.
 *  - **Starting a run is a COMMAND**, so it returns `applied | conflict |
 *    rejected` like every other command. All three are reachable by clicking.
 *  - **Entry validation is loud and per line.** A bad EID names the line, the
 *    value and the rule, and nothing is enqueued until it is fixed or removed.
 */

const NO_FILE = "";

// ---------------------------------------------------------------------------
// Launcher — the operator's way into all three start surfaces
// ---------------------------------------------------------------------------

/** One door in the menu: what it starts, and what kind of input it takes. */
function StartRunOption({
  icon,
  label,
  note,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  note: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer flex-col items-start text-left",
        "gap-[var(--ds-space-hair)] px-[var(--ds-space-base)] py-[var(--ds-space-snug)]",
        dsRadius.md,
        dsFocus,
        dsMotion.fast,
        "hover:bg-[var(--ds-surface-3)]",
      )}
    >
      <span className={cn(dsText.ui, "inline-flex items-center gap-[var(--ds-space-snug)] font-semibold text-[color:var(--ds-fg)]")}>
        {icon}
        {label}
      </span>
      <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{note}</span>
    </button>
  );
}

/**
 * ONE primary control, three doors behind it.
 *
 * This used to be a band of its own: a caps "START A RUN" label, three
 * `…`-suffixed buttons and a faint sentence promising the plan comes first —
 * 37px of vertical, every row of it, for something an operator touches a
 * handful of times a day. The three doors are all still here, each named and
 * each explaining what it takes; the promise moved into the menu, where it is
 * read at the moment it matters rather than skimmed past forever.
 */
export function DemoRunStartControls() {
  const [surface, setSurface] = useState<"none" | "upload" | "input" | "intake">("none");
  const [intakeSheetId, setIntakeSheetId] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);

  const openIntake = useCallback((sheetId: string | null) => {
    setMenu(false);
    setIntakeSheetId(sheetId);
    setSurface("intake");
  }, []);
  const open = useCallback((next: "upload" | "input") => {
    setMenu(false);
    setSurface(next);
  }, []);

  return (
    <>
      <Popover open={menu} onOpenChange={setMenu}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="primary"
            icon={<Play aria-hidden className={dsIcon.sm} />}
            iconAfter={<ChevronDown aria-hidden className={dsIcon.sm} />}
          >
            Start a run
          </Button>
        </PopoverTrigger>
        <PopoverContent
          title="Start a run"
          description="Every start shows what it will create before it commits."
          width="lg"
          align="start"
        >
          <div className="flex flex-col gap-[var(--ds-space-hair)]">
            <StartRunOption
              icon={<Upload aria-hidden className={dsIcon.md} />}
              label="Upload a document…"
              note="A PDF packet or a single form. The plan names every row it will create."
              onClick={() => open("upload")}
            />
            <StartRunOption
              icon={<Keyboard aria-hidden className={dsIcon.md} />}
              label="Type a list…"
              note="Names or EIDs, one per line. Each line is validated on its own."
              onClick={() => open("input")}
            />
            <StartRunOption
              icon={<FileSpreadsheet aria-hidden className={dsIcon.md} />}
              label="Import a spreadsheet…"
              note="Bind the columns once, then read every rejected cell before anything runs."
              onClick={() => openIntake(null)}
            />
          </div>
        </PopoverContent>
      </Popover>

      <DemoRunModal open={surface === "upload"} onOpenChange={(o) => setSurface(o ? "upload" : "none")} onOpenIntake={openIntake} />
      <DemoInputRunPanel open={surface === "input"} onOpenChange={(o) => setSurface(o ? "input" : "none")} />
      <DemoIntakeDialog
        open={surface === "intake"}
        initialSheetId={intakeSheetId}
        onOpenChange={(o) => setSurface(o ? "intake" : "none")}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// A. The Run Modal — a document, a target, and what that combination creates
// ---------------------------------------------------------------------------

export function DemoRunModal({
  open,
  onOpenChange,
  onOpenIntake,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenIntake: (sheetId: string) => void;
}) {
  const [fileId, setFileId] = useState(NO_FILE);
  const [target, setTarget] = useState<DemoWorkflowId>("oath-signature");
  const [policy, setPolicy] = useState<EnqueuePolicy>("reject-active");
  const [dryRun, setDryRun] = useState(false);
  const [priority, setPriority] = useState<"interactive" | "bulk">("interactive");
  const [instances, setInstances] = useState<InstanceChoice>({});
  const [result, setResult] = useState<DemoEnqueueResult | null>(null);
  /** the contract version this form was BUILT against — bumped by a reload */
  const [formVersion, setFormVersion] = useState<Partial<Record<DemoWorkflowId, number>>>({});

  const file = UPLOAD_FILES.find((f) => f.id === fileId) ?? null;
  const spec = UPLOAD_RUN_SPECS.find((s) => s.workflow === target) ?? UPLOAD_RUN_SPECS[0];
  const workflow = DEMO_WORKFLOWS[spec.workflow];
  const builtVersion = formVersion[spec.workflow] ?? workflow.version;

  const plan = useMemo(
    () => (file ? deriveUploadPlan(spec, file.fileName, file.pageCount) : null),
    [file, spec],
  );
  const test = testSystems(workflow, instances);
  const activeConflict = file?.activeRun?.workflow === spec.workflow ? file.fileName : undefined;

  const reset = useCallback(() => {
    setResult(null);
  }, []);

  const start = useCallback(() => {
    if (!file || !plan) return;
    setResult(
      submitDemoEnqueue({
        workflow: spec.workflow,
        expectedWorkflowVersion: builtVersion,
        plan,
        policy,
        dryRun,
        instances,
        fileName: file.fileName,
        activeConflictSubject: activeConflict,
      }),
    );
  }, [file, plan, spec.workflow, builtVersion, policy, dryRun, instances, activeConflict]);

  const targets = UPLOAD_RUN_SPECS.filter((s) => !file || s.accepts.includes(file.kind));

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) reset(); }}>
      <DialogContent
        size="lg"
        title="Run Modal — start from a document"
        description="Pick the file, pick what should happen to it, and read what that will create before anything is enqueued."
      >
        <DialogBody className="flex flex-col gap-[var(--ds-space-loose)]">
          {result && (
            <EnqueueResultBanner
              result={result}
              onDismiss={() => setResult(null)}
              onReload={() => {
                // The ONLY cure for a stale contract: rebuild the form on the
                // version the server actually serves, then look again.
                setFormVersion((prev) => ({ ...prev, [spec.workflow]: SERVER_WORKFLOW_VERSION[spec.workflow] ?? workflow.version }));
                setResult(null);
              }}
            />
          )}

          <section className="flex flex-col gap-[var(--ds-space-snug)]">
            <SectionLabel>Document</SectionLabel>
            <ul className="flex flex-col gap-[var(--ds-space-tight)]">
              {UPLOAD_FILES.map((item) => (
                <li key={item.id}>
                  <FileChoice
                    file={item}
                    selected={item.id === fileId}
                    onSelect={() => {
                      setFileId(item.id);
                      setResult(null);
                      if (item.kind === "spreadsheet") return;
                      const first = UPLOAD_RUN_SPECS.find((s) => s.accepts.includes(item.kind));
                      if (first && !UPLOAD_RUN_SPECS.find((s) => s.workflow === target)?.accepts.includes(item.kind)) {
                        setTarget(first.workflow);
                      }
                    }}
                  />
                </li>
              ))}
            </ul>
          </section>

          {file?.intakeSheetId ? (
            <Banner
              tone="info"
              title="A spreadsheet is not started here"
              action={
                <Button size="sm" variant="primary" onClick={() => { onOpenChange(false); onOpenIntake(file.intakeSheetId ?? ""); }}>
                  Open the intake
                </Button>
              }
            >
              A sheet has to be given a header row and a column mapping before it means anything, and every row has to be coerced and
              accepted or rejected by name. That is the intake pipeline, not an upload run.
            </Banner>
          ) : (
            <>
              <section className="grid grid-cols-1 gap-[var(--ds-space-cozy)] min-[560px]:grid-cols-2">
                <Field label="What should happen to it" description={spec.note}>
                  <Select value={target} onChange={(e) => { setTarget(e.target.value as DemoWorkflowId); setResult(null); }}>
                    {targets.map((s) => (
                      <option key={s.workflow} value={s.workflow}>
                        {DEMO_WORKFLOWS[s.workflow].label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="If one is already running"
                  description={activeConflict ? `${activeConflict} already has an active ${workflow.label} run.` : "Nothing is running for this document."}
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
                {/* The switch pairs with the Selects beside it, so it lines up
                    with the CONTROL row — not with the bottom of a cell that a
                    neighbour's description line made taller, which is what
                    `items-end` was doing and why it read as dropped. It mirrors
                    `Field`'s label row as an aria-hidden spacer in the same type
                    class, so the reservation is exact instead of a guessed
                    height; the switch's own label then lands on the Selects'
                    line and its description on theirs. */}
                <div className="flex flex-col gap-[var(--ds-space-tight)]">
                  <span aria-hidden className={cn(dsText.meta, "invisible font-medium")}>
                    Dry run
                  </span>
                  <Switch
                    checked={dryRun}
                    onCheckedChange={(next) => { setDryRun(next); setResult(null); }}
                    label="Dry run"
                    description="Reads everything for real. Writes nothing, anywhere."
                  />
                </div>
              </section>

              <section className="flex flex-col gap-[var(--ds-space-snug)]">
                <SectionLabel>Instance — where this will write</SectionLabel>
                <InstanceSelector workflow={workflow} value={instances} onChange={(next) => { setInstances(next); setResult(null); }} />
              </section>

              <section className="flex flex-col gap-[var(--ds-space-snug)]">
                <SectionLabel>What this will create</SectionLabel>
                {plan ? (
                  <PlanPreview plan={plan} dryRun={dryRun} test={test} />
                ) : (
                  // Bounded, not floating: this is the slot the plan will fill,
                  // so it holds its shape instead of leaving a hole in a dense
                  // modal the operator reads top to bottom.
                  <Well>
                    <EmptyState
                      className="p-[var(--ds-space-base)]"
                      icon={<FileText aria-hidden className={dsIcon.lg} />}
                      title="No document picked yet"
                      description="Pick a file above and this fills in with the exact rows the start would create, which panel each one lands in, and the decisions that shape it."
                    />
                  </Well>
                )}
              </section>
            </>
          )}
        </DialogBody>

        <DialogFooter meta={<MetaLine tone="faint" items={[`${workflow.label} v${builtVersion}`]} />}>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Play aria-hidden className={dsIcon.md} />}
            disabled={!file || Boolean(file.intakeSheetId) || result?.state === "applied"}
            onClick={start}
          >
            {dryRun ? "Start dry run" : "Start run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FileChoice({ file, selected, onSelect }: { file: UploadFileFixture; selected: boolean; onSelect: () => void }) {
  const Icon = file.kind === "spreadsheet" ? FileSpreadsheet : FileText;
  return (
    <Card
      interactive
      selected={selected}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className="min-h-[var(--ds-h-lg)] flex-row items-center gap-[var(--ds-space-base)] px-[var(--ds-space-base)] py-[var(--ds-space-snug)]"
    >
      <Icon aria-hidden className={cn(dsIcon.md, "shrink-0", dsFg.muted)} />
      <span className={cn(dsText.ui, "min-w-0 flex-1 truncate", dsFg.base)}>{file.fileName}</span>
      <MetaLine
        className="shrink-0"
        items={[file.sizeLabel, `${file.pageCount} page${file.pageCount === 1 ? "" : "s"}`]}
      />
      {file.activeRun && <Badge tone="warning">already running</Badge>}
      {file.intakeSheetId && <Badge tone="info">spreadsheet</Badge>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// B. The Input Run Panel — N typed values become one Group Row
// ---------------------------------------------------------------------------

export function DemoInputRunPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [workflowId, setWorkflowId] = useState<DemoWorkflowId>("separations");
  const [text, setText] = useState("");
  const [dryRun, setDryRun] = useState(false);
  const [policy, setPolicy] = useState<EnqueuePolicy>("reject-active");
  const [instances, setInstances] = useState<InstanceChoice>({});
  const [phase, setPhase] = useState<"pending" | "resolved">("pending");
  const [result, setResult] = useState<DemoEnqueueResult | null>(null);

  const spec = INPUT_RUN_SPECS.find((s) => s.workflow === workflowId) ?? INPUT_RUN_SPECS[0];
  const workflow = DEMO_WORKFLOWS[spec.workflow];
  const entries = useMemo(() => parseEntries(text, spec.subject), [text, spec.subject]);
  const bad = entries.filter((e) => e.problem);
  const valid = entries.filter((e) => !e.problem);
  const plan = useMemo(() => deriveInputPlan(spec, entries), [spec, entries]);
  const test = testSystems(workflow, instances);
  /** an EID the server already has a live run for — the reject path */
  const activeConflict = valid.find((e) => e.value === "10055501")?.value;

  const start = useCallback(() => {
    setResult(
      submitDemoEnqueue({
        workflow: spec.workflow,
        expectedWorkflowVersion: workflow.version,
        plan,
        policy,
        dryRun,
        instances,
        activeConflictSubject: activeConflict ? `EID ${activeConflict}` : undefined,
      }),
    );
  }, [spec.workflow, workflow.version, plan, policy, dryRun, instances, activeConflict]);

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setResult(null); }}>
      <DialogContent
        size="lg"
        title="Input Run Panel — start from typed values"
        description="One value per line. More than one mints a Group Row; each value becomes a member under it."
      >
        <DialogBody className="flex flex-col gap-[var(--ds-space-loose)]">
          {result && <EnqueueResultBanner result={result} onDismiss={() => setResult(null)} />}

          <section className="grid grid-cols-1 gap-[var(--ds-space-cozy)] min-[560px]:grid-cols-2">
            <Field label="Workflow" description={spec.parserLabel}>
              <Select
                value={workflowId}
                onChange={(e) => {
                  setWorkflowId(e.target.value as DemoWorkflowId);
                  setText("");
                  setResult(null);
                }}
              >
                {INPUT_RUN_SPECS.map((s) => (
                  <option key={s.workflow} value={s.workflow}>
                    {DEMO_WORKFLOWS[s.workflow].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="If one is already running" description="a second parallel run against the same person is how one gets filed twice">
              <Select value={policy} onChange={(e) => { setPolicy(e.target.value as EnqueuePolicy); setResult(null); }}>
                {(Object.keys(ENQUEUE_POLICY_LABEL) as EnqueuePolicy[]).map((key) => (
                  <option key={key} value={key}>
                    {ENQUEUE_POLICY_LABEL[key]}
                  </option>
                ))}
              </Select>
            </Field>
          </section>

          <div className="flex flex-wrap items-center gap-[var(--ds-space-snug)]">
            <SectionLabel>Presets</SectionLabel>
            {spec.presets.map((preset) => (
              <Button key={preset.key} size="sm" variant="outline" title={preset.note} onClick={() => { setText(preset.values.join("\n")); setResult(null); }}>
                {preset.label}
              </Button>
            ))}
          </div>

          <Field
            label={`${spec.subject === "eid" ? "EIDs" : spec.subject === "email" ? "Emails" : "Names"} — one per line`}
            hint={`${valid.length} valid · ${bad.length} refused`}
            error={bad.length > 0 ? `${bad.length} line${bad.length === 1 ? "" : "s"} will not be enqueued — see the list below.` : null}
            description={spec.emptyOpensUpload ? "Leaving this empty opens the upload modal instead of erroring." : undefined}
          >
            <Textarea
              rows={6}
              value={text}
              placeholder={`${spec.placeholder}\n${spec.placeholder}`}
              onChange={(e) => { setText(e.target.value); setResult(null); }}
            />
          </Field>

          {bad.length > 0 && (
            <ul className="flex flex-col gap-[var(--ds-space-snug)]">
              {bad.map((entry) => (
                <li key={`${entry.line}-${entry.raw}`}>
                  <Banner tone="danger" title={`Line ${entry.line} — ${entry.problem?.code}`}>
                    {entry.problem?.message} Nothing on this line is enqueued, and nothing is guessed from it.
                  </Banner>
                </li>
              ))}
            </ul>
          )}

          {valid.length > 0 && (
            <section className="flex flex-col gap-[var(--ds-space-snug)]">
              <div className="flex flex-wrap items-center gap-[var(--ds-space-base)]">
                <SectionLabel>Row titles</SectionLabel>
                <div className="inline-flex gap-[var(--ds-space-tight)]">
                  <Button size="sm" variant={phase === "pending" ? "primary" : "outline"} onClick={() => setPhase("pending")}>
                    As enqueued
                  </Button>
                  <Button size="sm" variant={phase === "resolved" ? "primary" : "outline"} onClick={() => setPhase("resolved")}>
                    After resolution
                  </Button>
                </div>
              </div>
              <Well className="flex flex-col gap-[var(--ds-space-snug)]">
                <span className={cn(dsText.body, dsFg.secondary)}>
                  {phase === "pending"
                    ? "A row is born titled with exactly what you typed — nobody has looked the person up yet, so nothing else would be true."
                    : "Once the subject is resolved the title becomes the person's name and the subtitle becomes their EID. A subject nobody could resolve stays as typed — it is never replaced with a guess."}
                </span>
                <ul className="flex flex-col gap-[var(--ds-space-tight)]">
                  {valid.map((entry) => {
                    const phases = titlePhases(entry, spec.subject);
                    const shown = phase === "resolved" ? (phases.resolved ?? phases.pending) : phases.pending;
                    const stillPending = phase === "resolved" && !phases.resolved;
                    return (
                      <li key={entry.line} className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-base)]">
                        <span className={cn(dsText.ui, "min-w-0 truncate", dsFg.base)}>{shown.title}</span>
                        <span className={cn(dsText.meta, dsText.nums, dsFg.muted)}>{shown.subtitle}</span>
                        {stillPending && <Chip tone="warning">unresolved — stays as typed</Chip>}
                      </li>
                    );
                  })}
                </ul>
              </Well>
            </section>
          )}

          <section className="grid grid-cols-1 gap-[var(--ds-space-cozy)] min-[560px]:grid-cols-2">
            <div className="flex flex-col gap-[var(--ds-space-snug)]">
              <SectionLabel>Instance</SectionLabel>
              <InstanceSelector workflow={workflow} value={instances} onChange={setInstances} />
            </div>
            <div className="flex flex-col gap-[var(--ds-space-base)]">
              {spec.supportsDryRun ? (
                <Switch checked={dryRun} onCheckedChange={setDryRun} label="Dry run" description="Reads everything for real. Writes nothing, anywhere." />
              ) : (
                <Banner tone="info" title="This workflow has no dry run">
                  {workflow.label} only reads — there is nothing a dry run would suppress, so the toggle is not offered rather than offered and ignored.
                </Banner>
              )}
              <RunFlagChips dryRun={dryRun && spec.supportsDryRun} test={test} priority="interactive" />
            </div>
          </section>

          <section className="flex flex-col gap-[var(--ds-space-snug)]">
            <SectionLabel>What this will create</SectionLabel>
            {entries.length === 0 ? (
              <Well>
                <EmptyState
                  className="p-[var(--ds-space-base)]"
                  title="Nothing typed yet"
                  description={
                    spec.emptyOpensUpload
                      ? "Type one value per line, or leave this empty and use the upload modal — an empty typed run is not an error, it is a different surface."
                      : "Type one value per line. This fills in with the exact rows the start would create."
                  }
                />
              </Well>
            ) : (
              <PlanPreview plan={plan} dryRun={dryRun && spec.supportsDryRun} test={test} />
            )}
          </section>
        </DialogBody>

        <DialogFooter meta={<MetaLine tone="faint" items={[`${workflow.label} v${workflow.version}`]} />}>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Play aria-hidden className={dsIcon.md} />}
            disabled={valid.length === 0 || bad.length > 0 || result?.state === "applied"}
            onClick={start}
          >
            {valid.length > 1 ? `Start ${valid.length} runs` : "Start run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
