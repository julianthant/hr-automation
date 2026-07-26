import { useMemo, useState } from "react";
import { Archive, ShieldAlert, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  SectionLabel,
  StatusPill,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  Well,
  dsIcon,
  dsText,
} from "./demo-ui";
import {
  allTopLevelRows,
  BUMP_SCOPE_LABEL,
  BUMP_SCOPE_NOTE,
  deriveBumpPlan,
  submitVersionBump,
  type BumpResult,
  type BumpScope,
} from "./demo-archive-wire";
import type { DemoWorkflowId } from "./demo-wire";

/**
 * DEV-ONLY — the VERSION BUMP flow, including its refusal.
 *
 * The interesting half of this surface is the refusal, so the primary button is
 * never disabled when there are blockers — pressing it returns the SERVER's
 * refusal, with the blocking runs named. A greyed-out button would have hidden
 * the one rule this flow exists to enforce:
 *
 *   **A bump cannot archive a non-terminal run.** Queued / running / waiting /
 *   parked runs must be terminalized or resolved first. An unresolved
 *   possible-submit is never buried in an archive.
 *
 * The blocker list is DERIVED from the same rows and the same `effectiveStatus`
 * the queue renders (`deriveBumpPlan`), so it cannot disagree with what the
 * operator is looking at, and `submitVersionBump` refuses on its own derived
 * output rather than on a flag a fixture set.
 */

export interface BumpTarget {
  scope: BumpScope;
  workflowIds: DemoWorkflowId[];
}

export function DemoVersionBumpDialog({
  target,
  onClose,
  onOpenArchive,
}: {
  target: BumpTarget | null;
  onClose: () => void;
  onOpenArchive: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {target && <BumpDialogBody target={target} onClose={onClose} onOpenArchive={onOpenArchive} />}
    </Dialog>
  );
}

function BumpDialogBody({
  target,
  onClose,
  onOpenArchive,
}: {
  target: BumpTarget;
  onClose: () => void;
  onOpenArchive: () => void;
}) {
  const plan = useMemo(() => deriveBumpPlan(target.scope, target.workflowIds, allTopLevelRows()), [target]);
  const [what, setWhat] = useState("");
  const [why, setWhy] = useState("");
  const [result, setResult] = useState<BumpResult | null>(null);

  const title =
    plan.targets.length === 1
      ? `Bump ${plan.targets[0].label} to v${plan.targets[0].to}`
      : `Dashboard update — bump ${plan.targets.length} workflows`;

  const parked = plan.blockers.filter((blocker) => blocker.status === "parked");

  return (
    <DialogContent
      size="xl"
      title={title}
      description={`${BUMP_SCOPE_LABEL[plan.scope]} · ${BUMP_SCOPE_NOTE[plan.scope]}`}
    >
      <DialogBody className="flex flex-col gap-[var(--ds-space-cozy)]">
        {result && (
          <Banner
            tone={result.state === "applied" ? "success" : "danger"}
            title={result.headline}
            action={
              result.state === "applied" ? (
                <Button size="sm" variant="secondary" icon={<Archive aria-hidden className={dsIcon.md} />} onClick={onOpenArchive}>
                  Open the archive
                </Button>
              ) : undefined
            }
          >
            {result.detail}
            {result.code && (
              <span className={cn(dsText.meta, dsText.nums, "ml-[var(--ds-space-snug)] text-[color:var(--ds-fg-muted)]")}>
                code {result.code}
              </span>
            )}
          </Banner>
        )}

        {/* ---- targets ---- */}
        <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-tight)]">
          {plan.targets.map((entry) => (
            <Badge key={entry.workflowId} tone="info">
              {entry.label} v{entry.from} → v{entry.to}
            </Badge>
          ))}
        </div>

        {/* ---- the safety carve-out ---- */}
        {plan.blockers.length > 0 ? (
          <Banner
            tone={parked.length > 0 ? "danger" : "warning"}
            title={`${plan.blockers.length} run${plan.blockers.length === 1 ? "" : "s"} must be resolved before this bump`}
            icon={<TriangleAlert aria-hidden className={dsIcon.lg} />}
          >
            A bump moves every prior-version run out of the dashboard. These are not terminal, so archiving them would file a run
            mid-flight.
            {parked.length > 0 && (
              <>
                {" "}
                <strong>
                  {parked.length} {parked.length === 1 ? "is" : "are"} a parked write
                </strong>{" "}
                — a write whose outcome is unknown may never be buried in an archive.
              </>
            )}
          </Banner>
        ) : (
          <Banner tone="success" title="Nothing is blocking this bump">
            Every listed run for {plan.targets.length === 1 ? "this workflow" : "these workflows"} has reached a terminal state, so
            all of them can be archived as self-contained snapshots.
          </Banner>
        )}

        {plan.blockers.length > 0 && (
          <div className="min-w-0">
            <SectionLabel className="mb-[var(--ds-space-snug)]">Must be terminalized or resolved first</SectionLabel>
            <Table label="Runs blocking this version bump">
              <THead>
                <TR>
                  <TH>Run</TH>
                  <TH>Status</TH>
                  <TH>Why it blocks</TH>
                  <TH>What has to happen</TH>
                </TR>
              </THead>
              <TBody>
                {plan.blockers.map((blocker) => (
                  <TR key={blocker.runId}>
                    <TD>
                      <span className="flex min-w-0 flex-col">
                        <span className={cn(dsText.ui, "truncate text-[color:var(--ds-fg)]")}>{blocker.title}</span>
                        <span className={cn(dsText.micro, dsText.nums, "text-[color:var(--ds-fg-muted)]")}>
                          {blocker.panel} · {blocker.day}
                        </span>
                      </span>
                    </TD>
                    <TD>
                      <StatusPill status={blocker.status} size="sm" />
                    </TD>
                    <TD className="max-w-[260px]">{blocker.why}</TD>
                    <TD className="max-w-[300px]">{blocker.requiredResolution}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}

        {/* ---- what would be archived ---- */}
        <div className="min-w-0">
          <SectionLabel className="mb-[var(--ds-space-snug)]">
            Would be archived — {plan.archivable.length} run{plan.archivable.length === 1 ? "" : "s"}
          </SectionLabel>
          {plan.archivable.length === 0 ? (
            <Well>
              <span className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>
                No terminal runs are listed for this scope, so this bump would move the version and archive nothing.
              </span>
            </Well>
          ) : (
            <Well className="max-h-[190px] overflow-y-auto">
              <ul className="flex flex-col gap-[var(--ds-space-hair)]">
                {plan.archivable.map((run) => (
                  <li key={run.runId} className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
                    <StatusPill status={run.status} size="sm" hideIcon />
                    <span className={cn(dsText.body, "min-w-0 flex-1 truncate text-[color:var(--ds-fg-secondary)]")}>
                      {run.title}
                    </span>
                    <span className={cn(dsText.micro, dsText.nums, "shrink-0 text-[color:var(--ds-fg-muted)]")}>
                      {run.workflowLabel} v{run.workflowVersion}
                    </span>
                  </li>
                ))}
              </ul>
            </Well>
          )}
          <p className={cn(dsText.meta, "mt-[var(--ds-space-snug)] text-[color:var(--ds-fg-muted)]")}>
            Each one is stored as its final projected row plus its receipt and evidence pointers, so opening it later needs zero
            old-version code. The write ledger is untouched — what was filed in a real HR system stays on record either way.
          </p>
        </div>

        {/* ---- the change record ---- */}
        <div className="grid grid-cols-1 gap-[var(--ds-space-base)] min-[720px]:grid-cols-2">
          <Field label="What changed" description="Recorded beside the version, in the same store as fix records." required>
            <Input value={what} onChange={(event) => setWhat(event.target.value)} placeholder="e.g. reads the relationship field instead of defaulting it" />
          </Field>
          <Field label="Why it needed a bump" description="A behaviour change is what forces the version — say what behaviour." required>
            <Textarea value={why} onChange={(event) => setWhy(event.target.value)} rows={2} placeholder="e.g. a defaulted value is a silent wrong value on a real record" />
          </Field>
        </div>
      </DialogBody>

      <DialogFooter>
        <span className={cn(dsText.meta, "mr-auto text-[color:var(--ds-fg-muted)]")}>
          There is no force arm. The refusal is the feature.
        </span>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
        <Button
          variant={plan.blockers.length > 0 ? "danger" : "primary"}
          icon={plan.blockers.length > 0 ? <ShieldAlert aria-hidden className={dsIcon.md} /> : undefined}
          onClick={() => setResult(submitVersionBump(plan, { what, why }))}
        >
          Bump and archive {plan.archivable.length} run{plan.archivable.length === 1 ? "" : "s"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
