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
  RadioGroup,
  Refusal,
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
  BUMP_KIND_LABEL,
  BUMP_KIND_NOTE,
  BUMP_SCOPE_LABEL,
  BUMP_SCOPE_NOTE,
  deriveBumpPlan,
  submitVersionBump,
  type BumpBlockerWire,
  type BumpKind,
  type BumpResult,
  type BumpScope,
} from "./demo-archive-wire";
import { plural } from "./demo-wire";
import type { DemoWorkflowId } from "./demo-wire";

/**
 * DEV-ONLY — the VERSION BUMP flow, its refusal, and its two arms.
 *
 * **The arms are the wave-12 change.** Every bump used to archive everything
 * terminal in scope, and the dialog asked *why* without doing anything with the
 * answer beyond requiring it non-empty. There is exactly one distinction that
 * changes what somebody does:
 *
 *  - **Major** — the run's shape moved. Runs started under the old descriptor
 *    cannot be rendered by the new one, so this ARCHIVES, and a non-terminal run
 *    blocks it.
 *  - **Minor** — presentation only. Nothing is archived, in-flight runs carry
 *    on, and old runs still render — so there is nothing a run could be doing
 *    that would block it, and the plan preview says so rather than showing an
 *    empty blocker table.
 *
 * The discipline that made the original surface worth having is unchanged: the
 * primary button is never disabled when there are blockers, because pressing it
 * returns the SERVER's refusal with the blocking runs named, and a greyed-out
 * button would have hidden the one rule this flow exists to enforce. There is
 * no force arm.
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
  const [kind, setKind] = useState<BumpKind>("major");
  const plan = useMemo(() => deriveBumpPlan(target.scope, target.workflowIds, allTopLevelRows(), kind), [target, kind]);
  const [what, setWhat] = useState("");
  const [why, setWhy] = useState("");
  const [result, setResult] = useState<BumpResult | null>(null);

  const title = plan.targets.length === 1 ? `Bump ${plan.targets[0].label}` : `Dashboard update — ${plural(plan.targets.length, "workflow")}`;
  const parked = plan.blockers.filter((blocker) => blocker.status === "parked");
  const isMajor = kind === "major";

  return (
    <DialogContent size="xl" title={title} description={`${BUMP_SCOPE_LABEL[plan.scope]} · ${BUMP_SCOPE_NOTE[plan.scope]}`}>
      <DialogBody className="flex flex-col gap-[var(--ds-space-cozy)]">
        {result &&
          (result.state === "applied" ? (
            <Banner
              tone="success"
              title={result.headline}
              action={
                plan.kind === "major" ? (
                  <Button size="sm" variant="secondary" icon={<Archive aria-hidden className={dsIcon.md} />} onClick={onOpenArchive}>
                    Open the archive
                  </Button>
                ) : undefined
              }
            >
              {result.detail}
            </Banner>
          ) : result.code ? (
            <Refusal
              title={result.headline}
              code={result.code}
              outcome={isMajor ? "nothing was archived and no version moved" : "no version moved"}
            >
              {result.detail}
            </Refusal>
          ) : (
            <Banner tone="danger" title={result.headline}>
              {result.detail} No version moved — but the server sent no refusal code, so there is nothing here to quote in a bug
              report.
            </Banner>
          ))}

        {/* ---- which kind, and what it costs ---- */}
        <RadioGroup<BumpKind>
          label="What kind of change is this?"
          name="bump-kind"
          value={kind}
          onValueChange={(next) => {
            setKind(next);
            setResult(null);
          }}
          options={[
            { value: "major", label: BUMP_KIND_LABEL.major, description: BUMP_KIND_NOTE.major },
            { value: "minor", label: BUMP_KIND_LABEL.minor, description: BUMP_KIND_NOTE.minor },
          ]}
        />

        {/* ---- targets ---- */}
        <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-tight)]">
          {plan.targets.map((entry) => (
            <Badge key={entry.workflowId} tone="info">
              {entry.label} {entry.from} → {entry.to}
            </Badge>
          ))}
        </div>

        {/* ---- the safety carve-out, which only a MAJOR bump has ---- */}
        {!isMajor ? (
          <Banner tone="success" title="Nothing can block a minor bump, because nothing is archived">
            Every run stays exactly where it is — in the queue, in the counts, in its filters — and every run already on disk
            still renders, because nothing a stored run depends on is changing.
            {plan.unaffected.length > 0 && (
              <>
                {" "}
                The <strong>{plan.unaffected.length}</strong> run{plan.unaffected.length === 1 ? "" : "s"} still in flight
                {plan.unaffected.length === 1 ? " carries" : " carry"} on untouched; under a major bump{" "}
                {plan.unaffected.length === 1 ? "it" : "they"} would have blocked this.
              </>
            )}
          </Banner>
        ) : plan.blockers.length > 0 ? (
          <Banner
            tone={parked.length > 0 ? "danger" : "warning"}
            title={`${plan.blockers.length} run${plan.blockers.length === 1 ? "" : "s"} must be resolved before this bump`}
            icon={<TriangleAlert aria-hidden className={dsIcon.lg} />}
          >
            A major bump moves every prior-version run out of the dashboard. These are not terminal, so archiving them would file
            a run mid-flight.
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
            Every listed run for {plan.targets.length === 1 ? "this workflow" : "these workflows"} has reached a terminal state,
            so all of them can be archived as self-contained snapshots.
          </Banner>
        )}

        {isMajor && plan.blockers.length > 0 && (
          <div className="min-w-0">
            <SectionLabel className="mb-[var(--ds-space-snug)]">Must be terminalized or resolved first</SectionLabel>
            <BlockerTable rows={plan.blockers} label="Runs blocking this version bump" resolutionHead="What has to happen" />
          </div>
        )}

        {!isMajor && plan.unaffected.length > 0 && (
          <div className="min-w-0">
            <SectionLabel className="mb-[var(--ds-space-snug)]">
              Still in flight — unaffected ({plan.unaffected.length})
            </SectionLabel>
            <BlockerTable
              rows={plan.unaffected}
              label="Runs that keep running through this minor bump"
              resolutionHead="What a MAJOR bump would have demanded"
            />
          </div>
        )}

        {/* ---- what would be archived ---- */}
        <div className="min-w-0">
          <SectionLabel className="mb-[var(--ds-space-snug)]">
            {isMajor ? `Would be archived — ${plan.archivable.length} run${plan.archivable.length === 1 ? "" : "s"}` : "Would be archived — nothing"}
          </SectionLabel>
          {!isMajor ? (
            <Well>
              <span className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>
                A minor bump archives no run at all. The archive is the consequence of a SHAPE change, and this is not one.
              </span>
            </Well>
          ) : plan.archivable.length === 0 ? (
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
                    <span className={cn(dsText.body, "min-w-0 flex-1 truncate text-[color:var(--ds-fg-secondary)]")}>{run.title}</span>
                    <span className={cn(dsText.micro, dsText.nums, "shrink-0 text-[color:var(--ds-fg-muted)]")}>
                      {run.workflowLabel} {run.versionTag}
                    </span>
                  </li>
                ))}
              </ul>
            </Well>
          )}
        </div>

        {/* ---- the change record ---- */}
        <div className="grid grid-cols-1 gap-[var(--ds-space-base)] min-[720px]:grid-cols-2">
          <Field label="What changed" description="Recorded beside the version, in the same store as fix records." required>
            <Input
              value={what}
              onChange={(event) => setWhat(event.target.value)}
              placeholder={isMajor ? "e.g. reads the relationship field instead of defaulting it" : "e.g. the row is titled by the person once Kuali has been read"}
            />
          </Field>
          <Field
            label={isMajor ? "Why the shape had to move" : "Why this is presentation only"}
            description="The record says which kind it was, and the archive's group header shows it."
            required
          >
            <Textarea
              value={why}
              onChange={(event) => setWhy(event.target.value)}
              rows={2}
              placeholder={isMajor ? "e.g. a defaulted value is a silent wrong value on a real record" : "e.g. the run does the same thing in the same order"}
            />
          </Field>
        </div>
      </DialogBody>

      <DialogFooter meta="There is no force arm. The refusal is the feature.">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant={isMajor && plan.blockers.length > 0 ? "danger" : "primary"}
          icon={isMajor && plan.blockers.length > 0 ? <ShieldAlert aria-hidden className={dsIcon.md} /> : undefined}
          onClick={() => setResult(submitVersionBump(plan, { what, why }))}
        >
          {isMajor
            ? `Bump and archive ${plan.archivable.length} run${plan.archivable.length === 1 ? "" : "s"}`
            : "Bump — archive nothing"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function BlockerTable({
  rows,
  label,
  resolutionHead,
}: {
  rows: BumpBlockerWire[];
  label: string;
  resolutionHead: string;
}) {
  return (
    <Table label={label}>
      <THead>
        <TR>
          <TH>Run</TH>
          <TH>Status</TH>
          <TH>Why</TH>
          <TH>{resolutionHead}</TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((row) => (
          <TR key={row.runId}>
            <TD>
              <span className="flex min-w-0 flex-col">
                <span className={cn(dsText.ui, "truncate text-[color:var(--ds-fg)]")}>{row.title}</span>
                <span className={cn(dsText.micro, dsText.nums, "text-[color:var(--ds-fg-muted)]")}>
                  {row.panel} · {row.day}
                </span>
              </span>
            </TD>
            <TD>
              <StatusPill status={row.status} size="sm" />
            </TD>
            <TD className="max-w-[260px]">{row.why}</TD>
            <TD className="max-w-[300px]">{row.requiredResolution}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
