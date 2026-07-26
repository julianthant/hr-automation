import { type ReactNode } from "react";
import { CheckCircle2, FlaskConical, GitBranch, Link2, Rows3, ScrollText, TriangleAlert, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  Button,
  Card,
  Chip,
  Field,
  KeyValueList,
  Select,
  StatusPill,
  Well,
  dsFg,
  dsIcon,
  dsText,
} from "./demo-ui";
import type { DemoWorkflowRef, SystemKey } from "./demo-wire";
import {
  SYSTEM_HAS_TEST,
  SYSTEM_LABEL,
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
      <div className="grid grid-cols-2 gap-[var(--ds-space-base)]">
        {workflow.systems.map((system) => {
          const hasTest = SYSTEM_HAS_TEST[system];
          return (
            <Field
              key={system}
              label={SYSTEM_LABEL[system]}
              description={hasTest ? undefined : "no test instance configured"}
              disabled={!hasTest}
            >
              <Select
                value={hasTest ? (value[system] ?? "prod") : "prod"}
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
      {priority && <Badge tone="neutral">{priority}</Badge>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Plan preview — what this start WILL create
// ---------------------------------------------------------------------------

const ROLE_META: Record<PlanRole, { label: string; icon: ReactNode }> = {
  group: { label: "Group Row", icon: <Rows3 aria-hidden className="size-3" /> },
  run: { label: "Run Row", icon: <ScrollText aria-hidden className="size-3" /> },
  review: { label: "Review Run Row", icon: <ScrollText aria-hidden className="size-3" /> },
  member: { label: "Member Rows", icon: <Users aria-hidden className="size-3" /> },
  linked: { label: "Linked runs", icon: <Link2 aria-hidden className="size-3" /> },
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
          <span className={cn(dsText.caps, dsFg.muted)}>Why it is shaped this way</span>
          <ul className="flex flex-col gap-[var(--ds-space-tight)]">
            {plan.decisions.map((decision) => (
              <li key={decision} className={cn(dsText.body, dsFg.secondary, "flex gap-[var(--ds-space-snug)]")}>
                <GitBranch aria-hidden className={cn(dsIcon.sm, "mt-0.5 shrink-0", dsFg.faint)} />
                <span>{decision}</span>
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
    <Card className="p-[var(--ds-space-base)]">
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
      <div className="mt-[var(--ds-space-tight)] flex flex-wrap items-center gap-[var(--ds-space-base)]">
        <span className={cn(dsText.meta, dsText.nums, dsFg.muted)}>{row.subtitle}</span>
        <Chip label="panel">{row.panel}</Chip>
        {row.containment && <Chip label="containment">{row.containment}</Chip>}
      </div>
      {row.note && <p className={cn(dsText.body, dsFg.secondary, "mt-[var(--ds-space-tight)]")}>{row.note}</p>}
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
          <span className={cn(dsText.meta, dsFg.muted)}>
            {result.clock} · requested by {result.requestedBy}
          </span>
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
              { key: "form built at", value: `v${result.expectedVersion}` },
              { key: "server serves", value: `v${result.serverVersion}`, tone: "warning" },
            ]}
          />
        </div>
      </Banner>
    );
  }

  return (
    <Banner
      tone="danger"
      title={result.headline}
      action={onDismiss ? <Button size="sm" variant="secondary" onClick={onDismiss}>Dismiss</Button> : undefined}
    >
      <div className="flex flex-col gap-[var(--ds-space-snug)]">
        <span>{result.detail}</span>
        <span className={cn(dsText.meta, dsText.nums, dsFg.muted)}>code: {result.code}</span>
      </div>
    </Banner>
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
  return (
    <nav aria-label="Intake stages" className="flex flex-wrap items-center gap-[var(--ds-space-tight)]">
      {stages.map((stage, index) => {
        const isCurrent = stage.key === current;
        const canGo = reachable.has(stage.key);
        return (
          <span key={stage.key} className="flex items-center gap-[var(--ds-space-tight)]">
            {index > 0 && <span aria-hidden className={cn(dsText.meta, dsFg.faint)}>›</span>}
            <Button
              size="sm"
              variant={isCurrent ? "primary" : canGo ? "outline" : "ghost"}
              disabled={!canGo && !isCurrent}
              aria-current={isCurrent ? "step" : undefined}
              onClick={() => onSelect(stage.key)}
            >
              <span className={cn(dsText.nums, "opacity-70")}>{index + 1}</span>
              {stage.label}
            </Button>
          </span>
        );
      })}
    </nav>
  );
}
