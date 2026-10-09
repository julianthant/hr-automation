import { type ReactNode } from "react";
import { Check, CheckCircle2, FlaskConical, GitBranch, Link2, Rows3, ScrollText, TriangleAlert, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  Checkbox,
  Chip,
  Field,
  KeyValueList,
  LockedValue,
  MetaLine,
  Refusal,
  SectionLabel,
  Select,
  StatusPill,
  Well,
  dsFg,
  dsIcon,
  dsText,
} from "./demo-ui";
import { hasRefusalCode } from "./demo-commands";
import { choiceOptionLabel, type DemoWorkflowRef, type StartChoiceWire, type StartFlagWire, type SystemKey } from "./demo-wire";
import {
  SYSTEM_LABEL,
  systemHasTestInstance,
  systemHost,
  testSystems,
  type DemoEnqueueResult,
  type EnqueuePlan,
  type EnqueuePlanRow,
  type InstanceChoice,
  type PlanRole,
  type SystemInstance,
} from "./demo-runstart-wire";

/**
 * DEV-ONLY — the pieces every run-START surface shares.
 *
 * The Run Modal, the Input Run Panel and the spreadsheet intake all have to
 * answer the same three questions before the operator commits, so those
 * answers live here once:
 *
 *   1. **Where will this write?** `InstanceSelector` — per-system production or
 *      test, with the resulting `test` badge stated up front (doc 11 §4).
 *   2. **What will this create?** `PlanPreview` — the server-derived
 *      `EnqueuePlan`, including the ratified decisions the shape obeys, so a
 *      packet can never be drawn as something it is not (D6).
 *   3. **What actually happened?** `EnqueueResultBanner` — `applied`,
 *      `conflict` or `rejected`, never collapsed into "Done".
 */

// ---------------------------------------------------------------------------
// Instance selector — production vs test, per system
// ---------------------------------------------------------------------------

export function InstanceSelector({
  workflow,
  value,
  onChange,
}: {
  workflow: DemoWorkflowRef;
  value: InstanceChoice;
  onChange: (next: InstanceChoice) => void;
}) {
  const test = testSystems(workflow, value);
  return (
    <div className="flex flex-col gap-[var(--ds-space-base)]">
      <div className="grid grid-cols-1 gap-[var(--ds-space-base)] min-[420px]:grid-cols-2">
        {workflow.systems.map((system) => {
          const hasTest = systemHasTestInstance(system);
          const instance: SystemInstance = hasTest ? (value[system] ?? "prod") : "prod";
          return (
            <Field
              key={system}
              label={SYSTEM_LABEL[system]}
              /* The HOST, not a reassurance. This is the one fact the retired
                 global System-URL overrides were hiding: which machine this run
                 is about to touch, at the moment the choice is made. */
              description={
                <span className={cn(dsText.nums, "break-all")}>
                  {systemHost(system, instance)}
                  {!hasTest && <span className={dsFg.faint}> · no test host provisioned</span>}
                </span>
              }
              disabled={!hasTest}
            >
              <Select
                value={instance}
                onChange={(e) => onChange({ ...value, [system]: e.target.value as SystemInstance })}
                disabled={!hasTest}
              >
                <option value="prod">Production</option>
                {hasTest && <option value="test">Test instance</option>}
              </Select>
            </Field>
          );
        })}
      </div>
      {test.length > 0 && (
        <Banner tone="info" title={`Targeting the TEST instance of ${test.map((s) => SYSTEM_LABEL[s]).join(", ")}`}>
          Every row this start creates carries a <strong>test</strong> badge for its whole life, and its ledger entries are
          filed under the test instance. Nothing reaches production {workflow.systems.length > test.length ? "on those systems" : ""}.
        </Banner>
      )}
    </div>
  );
}

/** the badge a started row will carry — shown in the preview, then on the row */
export function RunFlagChips({
  dryRun,
  test,
  priority,
}: {
  dryRun: boolean;
  test: SystemKey[];
  priority?: "interactive" | "bulk";
}) {
  return (
    <span className="flex flex-wrap items-center gap-[var(--ds-space-tight)]">
      {dryRun && (
        <Badge tone="info">
          <FlaskConical aria-hidden className={dsIcon.sm} />
          dry run
        </Badge>
      )}
      {test.length > 0 && (
        <Badge tone="warning">
          <TriangleAlert aria-hidden className={dsIcon.sm} />
          test · {test.map((s) => SYSTEM_LABEL[s]).join(", ")}
        </Badge>
      )}
      {/* Only when it is NOT the default. A chip that is always there is a chip
          the eye stops reading — and it would say the same thing as the Priority
          control two rows below it. */}
      {priority === "bulk" && <Badge tone="neutral">bulk</Badge>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sub-selections — ONE control, every workflow, driven by the descriptor
// ---------------------------------------------------------------------------

/**
 * One sub-selection, rendered the same way for every workflow that declares
 * one. This is the whole reason wave 10 moved start capability onto the
 * descriptor: OCR's form type, OnBase's document type, Oath Upload's mode, the
 * roster pair and the worker count used to be five bespoke blocks in two
 * different modals, and a sixth workflow needed a sixth block. They are one
 * component now, and a workflow that declares none renders nothing at all.
 *
 * Two rules the control keeps:
 *
 *  - **A locked choice is a different SHAPE, not a one-option select.** It draws
 *    as a `LockedValue` with the reason on the line beneath, so "the target
 *    fixes this" is legible without clicking it to find out (wave 8).
 *  - **An unavailable option is offered, disabled, with its reason.** Hiding the
 *    23 OnBase document types that exist in OnBase but are not wired here would
 *    teach the operator the product has never heard of them.
 */
export function StartChoiceControl({
  choice,
  value,
  onChange,
}: {
  choice: StartChoiceWire;
  value: string;
  onChange: (next: string) => void;
}) {
  if (choice.locked) {
    return (
      <div className="flex min-w-0 flex-col gap-[var(--ds-space-tight)]">
        <span className={cn(dsText.meta, "font-medium", dsFg.secondary)}>{choice.label}</span>
        <LockedValue value={choiceOptionLabel(choice, choice.defaultValue)} reason={choice.lockedReason} />
        {choice.lockedReason && <p className={cn(dsText.meta, dsFg.muted)}>{choice.lockedReason}</p>}
      </div>
    );
  }

  const selected = choice.options.find((o) => o.value === value);
  const unavailable = choice.options.filter((o) => o.unavailable).length;
  // The description tracks the CHOICE the operator made, because the specific
  // consequence of this option is more use than a standing line about the
  // control. The control's own note is the fallback for an option that has
  // nothing extra to say.
  const description = selected?.unavailable ?? selected?.note ?? choice.note;

  return (
    <Field
      label={choice.label}
      description={description}
      hint={unavailable > 0 ? `${unavailable} not wired` : undefined}
    >
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {choice.options.map((option) => (
          <option key={option.value} value={option.value} disabled={Boolean(option.unavailable)}>
            {option.label}
            {option.unavailable ? " — not wired" : ""}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/**
 * A run flag. A `Checkbox`, deliberately, and not a `Switch`: nothing here takes
 * effect until the primary action is pressed, and the switch primitive's own
 * contract is that it applies immediately.
 */
export function StartFlagControl({
  flag,
  checked,
  onChange,
}: {
  flag: StartFlagWire;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return <Checkbox checked={checked} onCheckedChange={(next) => onChange(next === true)} label={flag.label} description={flag.note} />;
}

// ---------------------------------------------------------------------------
// Plan preview — what this start WILL create
// ---------------------------------------------------------------------------

const ROLE_META: Record<PlanRole, { label: string; icon: ReactNode }> = {
  group: { label: "Group Row", icon: <Rows3 aria-hidden className={dsIcon.sm} /> },
  run: { label: "Run Row", icon: <ScrollText aria-hidden className={dsIcon.sm} /> },
  review: { label: "Review Run Row", icon: <ScrollText aria-hidden className={dsIcon.sm} /> },
  member: { label: "Member Row", icon: <Users aria-hidden className={dsIcon.sm} /> },
  linked: { label: "Linked runs", icon: <Link2 aria-hidden className={dsIcon.sm} /> },
};

export function PlanPreview({
  plan,
  dryRun,
  test,
  className,
}: {
  plan: EnqueuePlan;
  dryRun: boolean;
  test: SystemKey[];
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-[var(--ds-space-base)]", className)}>
      <div className="flex flex-wrap items-center gap-[var(--ds-space-base)]">
        <span className={cn(dsText.ui, "font-semibold", dsFg.base)}>{plan.headline}</span>
        <RunFlagChips dryRun={dryRun} test={test} />
      </div>

      {plan.rows.length === 0 ? (
        <Well>
          <span className={dsFg.muted}>Nothing to create yet — no valid entry has been typed.</span>
        </Well>
      ) : (
        <ul className="flex flex-col gap-[var(--ds-space-snug)]">
          {plan.rows.map((row) => (
            <li key={row.key}>
              <PlanRowCard row={row} />
            </li>
          ))}
        </ul>
      )}

      {plan.warnings.map((warning) => (
        <Banner key={warning} tone="warning" title={warning} />
      ))}

      {plan.decisions.length > 0 && (
        <Well className="flex flex-col gap-[var(--ds-space-snug)]">
          <SectionLabel>Why it is shaped this way</SectionLabel>
          <ul className="flex flex-col gap-[var(--ds-space-tight)]">
            {plan.decisions.map((decision) => (
              <li key={decision} className={cn(dsText.body, dsFg.secondary, "flex gap-[var(--ds-space-snug)]")}>
                <GitBranch aria-hidden className={cn(dsIcon.sm, "mt-0.5 shrink-0", dsFg.faint)} />
                <span className="max-w-[74ch]">{decision}</span>
              </li>
            ))}
          </ul>
        </Well>
      )}
    </section>
  );
}

function PlanRowCard({ row }: { row: EnqueuePlanRow }) {
  const meta = ROLE_META[row.role];
  return (
    <Card>
      <CardBody className="flex flex-col gap-[var(--ds-space-tight)] py-[var(--ds-space-snug)]">
        <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-base)]">
          <Badge tone={row.containment === "linked" ? "info" : "neutral"}>
            {meta.icon}
            {meta.label}
          </Badge>
          <span className={cn(dsText.ui, "min-w-0 flex-1 truncate font-medium", dsFg.base)}>{row.title}</span>
          {row.bornAs === "not yet created" ? (
            <span className={cn(dsText.meta, dsFg.faint)}>not yet created</span>
          ) : (
            <StatusPill status={row.bornAs} size="sm" />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-[var(--ds-space-base)]">
          <MetaLine items={[row.subtitle]} />
          <Chip label="panel">{row.panel}</Chip>
          {row.containment && <Chip label="containment">{row.containment}</Chip>}
        </div>
        {row.note && <p className={cn(dsText.body, dsFg.secondary, "max-w-[74ch]")}>{row.note}</p>}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The result — applied | conflict | rejected
// ---------------------------------------------------------------------------

export function EnqueueResultBanner({
  result,
  onReload,
  onDismiss,
}: {
  result: DemoEnqueueResult;
  /** conflict only — the ONLY cure is rebuilding the form on the new contract */
  onReload?: () => void;
  onDismiss?: () => void;
}) {
  if (result.state === "applied") {
    return (
      <Banner
        tone="success"
        title={result.headline}
        icon={<CheckCircle2 aria-hidden className={dsIcon.lg} />}
        action={onDismiss ? <Button size="sm" variant="secondary" onClick={onDismiss}>Close</Button> : undefined}
      >
        <div className="flex flex-col gap-[var(--ds-space-snug)]">
          <span>{result.detail}</span>
          {result.created && result.created.length > 0 && (
            <KeyValueList
              items={result.created.map((row) => ({
                key: ROLE_META[row.role].label,
                value: `${row.title} → ${row.panel}`,
              }))}
            />
          )}
          <MetaLine items={[result.clock, `requested by ${result.requestedBy}`]} />
        </div>
      </Banner>
    );
  }

  if (result.state === "conflict") {
    return (
      <Banner
        tone="warning"
        title={result.headline}
        action={onReload ? <Button size="sm" variant="primary" onClick={onReload}>Reload the form</Button> : undefined}
      >
        <div className="flex flex-col gap-[var(--ds-space-snug)]">
          <span>{result.detail}</span>
          <KeyValueList
            items={[
              { key: "form built against contract", value: result.expectedContract ?? "—" },
              { key: "server serves contract", value: result.serverContract ?? "—", tone: "warning" },
            ]}
          />
        </div>
      </Banner>
    );
  }

  const dismiss = onDismiss ? (
    <Button size="sm" variant="secondary" onClick={onDismiss}>
      Dismiss
    </Button>
  ) : undefined;

  if (!hasRefusalCode(result)) {
    // The mock server broke its own contract. Say that, rather than print a
    // refusal with a code nobody can look up.
    return (
      <Banner tone="danger" title="Rejected — but no refusal code was served" action={dismiss}>
        {result.detail} Every rejection is supposed to carry a typed code; this one did not, so there is
        nothing here to quote in a bug report.
      </Banner>
    );
  }

  return (
    <Refusal title={result.headline} code={result.code} outcome="nothing is enqueued" action={dismiss}>
      {result.detail}
    </Refusal>
  );
}

// ---------------------------------------------------------------------------
// Stage rail — the intake's multi-step spine
// ---------------------------------------------------------------------------

export interface StageSpec {
  key: string;
  label: string;
}

/**
 * A linear stage rail. Completed stages are re-enterable (going back is how a
 * mis-mapped column gets fixed); stages ahead of the current one are not — the
 * pipeline refuses to skip validation.
 *
 * A settled stage swaps its number for a check. That is information, not
 * decoration: in a six-stage pipeline where every stage is a place a silent
 * substitution could enter, "how much of this is answered" is the thing the
 * operator is actually tracking. A disabled ghost button was nearly invisible
 * against the dialog, so the stages still to come now read as pending rather
 * than as absent.
 *
 * The rail is a `<nav>` of buttons, so the whole pipeline is one tab stop group
 * and the current stage carries `aria-current="step"`.
 */
export function StageRail({
  stages,
  current,
  reachable,
  onSelect,
}: {
  stages: StageSpec[];
  current: string;
  reachable: ReadonlySet<string>;
  onSelect: (key: string) => void;
}) {
  const currentIndex = stages.findIndex((stage) => stage.key === current);
  return (
    <nav
      aria-label={`Intake stages — step ${currentIndex + 1} of ${stages.length}`}
      className="flex flex-wrap items-center gap-[var(--ds-space-tight)]"
    >
      {stages.map((stage, index) => {
        const isCurrent = stage.key === current;
        const canGo = reachable.has(stage.key);
        const settled = canGo && index < currentIndex;
        return (
          <span key={stage.key} className="flex items-center gap-[var(--ds-space-tight)]">
            {index > 0 && (
              <span
                aria-hidden
                className={cn(dsText.meta, index <= currentIndex ? dsFg.muted : dsFg.faint)}
              >
                ›
              </span>
            )}
            <Button
              size="sm"
              variant={isCurrent ? "primary" : canGo ? "outline" : "ghost"}
              disabled={!canGo && !isCurrent}
              aria-current={isCurrent ? "step" : undefined}
              onClick={() => onSelect(stage.key)}
            >
              {settled ? (
                <Check aria-hidden className={cn(dsIcon.sm, "text-[color:var(--ds-success-fg)]")} />
              ) : (
                <span className={cn(dsText.nums, isCurrent ? "opacity-80" : "opacity-60")}>{index + 1}</span>
              )}
              {stage.label}
            </Button>
          </span>
        );
      })}
    </nav>
  );
}
