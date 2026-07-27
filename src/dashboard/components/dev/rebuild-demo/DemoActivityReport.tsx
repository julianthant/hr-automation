import { useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ChartNoAxesColumn, Download, Info, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  BulletList,
  Button,
  Card,
  CardBase,
  CardBody,
  Chip,
  IconButton,
  MetaLine,
  PageHeader,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  PanelToolbar,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SectionLabel,
  StatusPill,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Well,
  dsIcon,
  dsText,
} from "./demo-ui";
import {
  buildActivityReport,
  outstandingBuckets,
  REPORT_SPANS,
  MANUAL_MINUTES,
  MANUAL_MINUTES_PROVENANCE,
  type CategoryBlock,
  type OutstandingBucket,
  type WorkflowLine,
} from "./demo-report-wire";
import { fmtClock, DEMO_NOW, DEMO_APP_VERSION, DEMO_OPERATOR } from "./demo-wire";

/**
 * DEV-ONLY — the ACTIVITY REPORT: the one artifact in this product that leaves
 * the operator's screen and lands in front of a supervisor.
 *
 * That is exactly why it is the easiest surface to lie with, and why this one
 * is built the opposite way round: the honest counterweights come FIRST and are
 * not collapsible. Outstanding work sits beside finished work, the error rate
 * states its denominator, and hours-saved is labelled an operator estimate
 * everywhere it appears — including in the headline tile, not only in a
 * footnote nobody reads.
 *
 * Every number is derived from the same corpus and the same `effectiveStatus`
 * the queue renders, so the report and the dashboard cannot disagree.
 */

export function DemoActivityReportPage({ onBack, onOpenSettings }: { onBack: () => void; onOpenSettings: () => void }) {
  const [spanKey, setSpanKey] = useState(REPORT_SPANS[REPORT_SPANS.length - 1].key);
  const span = REPORT_SPANS.find((entry) => entry.key === spanKey) ?? REPORT_SPANS[0];
  const report = useMemo(() => buildActivityReport(span, fmtClock(DEMO_NOW)), [span]);
  const outstanding = useMemo(() => outstandingBuckets(span), [span]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Activity report"
        icon={<ChartNoAxesColumn aria-hidden className={dsIcon.lg} />}
        back={
          <Button variant="ghost" size="sm" icon={<ArrowLeft aria-hidden className={dsIcon.md} />} onClick={onBack}>
            Back to the dashboard
          </Button>
        }
        actions={
          <Button variant="ghost" size="sm" icon={<Settings aria-hidden className={dsIcon.md} />} onClick={onOpenSettings}>
            Settings
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-[var(--ds-space-cozy)]">
        <Panel>
          <PanelHeader
            title={`Automation activity — ${span.label}`}
            subtitle={span.label}
            meta={`${report.totals.runs} runs · ${report.totals.people} people`}
            actions={
              <span className="flex items-center gap-[var(--ds-space-snug)]">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="ghost" icon={<Info aria-hidden className={dsIcon.md} />}>
                      How it is counted
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent title="How this report is counted" width="lg" align="end">
                    <BulletList items={report.caveats} />
                  </PopoverContent>
                </Popover>
                <Button size="sm" variant="secondary" icon={<Download aria-hidden className={dsIcon.md} />}>
                  Export
                </Button>
              </span>
            }
          />
          <PanelToolbar label="Report span">
            {REPORT_SPANS.map((entry) => (
              <Chip key={entry.key} selected={entry.key === span.key} onSelect={() => setSpanKey(entry.key)}>
                {entry.label}
              </Chip>
            ))}
          </PanelToolbar>
          <PanelBody className="flex flex-col gap-[var(--ds-space-cozy)] p-[var(--ds-space-cozy)]">
            {/* ---- headline tiles. Counterweights first: OUTSTANDING sits in
                     the row, not under it, so finished work is never read
                     without the work that is not. ---- */}
            <div className="grid grid-cols-2 gap-[var(--ds-space-base)] min-[1080px]:grid-cols-5">
              <Tile label="Runs" value={String(report.totals.runs)} note={`${report.totals.people} distinct people touched`} />
              <Tile
                label="Finished"
                value={String(report.totals.verified + report.totals.warnings)}
                note={`${report.totals.verified} read back · ${report.totals.warnings} with warnings`}
              />
              {/* The four-line amber paragraph is GONE. What it was carrying is
                  a NUMBER — how much is still open — and a reason, which is the
                  same on every report and therefore belongs in the ⓘ. */}
              <Tile
                label="Still open"
                value={String(report.totals.outstanding)}
                note={
                  report.totals.outstanding > 0
                    ? "counted in neither the error rate nor hours saved"
                    : "nothing in this span is still open"
                }
                tone={report.totals.outstanding > 0 ? "warning" : "default"}
                info={
                  <BulletList
                    items={[
                      "A run that has not ended has not succeeded or failed, so it is excluded from the error rate rather than counted as either.",
                      "It contributes nothing to hours saved either — the estimate multiplies the operator's per-workflow minutes by the runs that actually FINISHED.",
                      "It is reported here, beside finished work, so a busy span cannot read as a finished one.",
                    ]}
                  />
                }
              />
              <Tile
                label="Error rate"
                value={`${report.errorRatePct}%`}
                note={`${report.totals.failed} failed of ${report.totals.verified + report.totals.warnings + report.totals.failed + report.totals.cancelled} terminal runs`}
                tone={report.errorRatePct > 15 ? "warning" : "default"}
              />
              <Tile
                label="Hours saved"
                value={`≈ ${report.hoursSaved}`}
                note="operator's per-workflow minutes × runs that finished"
                tone="estimate"
                info={<BulletList items={[`Hours saved is an ESTIMATE — ${MANUAL_MINUTES_PROVENANCE}`]} />}
              />
            </div>

            {/* ---- what is still open, and what it is waiting ON ---- */}
            {outstanding.length > 0 && (
              <div className="min-w-0">
                <SectionLabel className="mb-[var(--ds-space-snug)]">Still open — by what it is waiting on</SectionLabel>
                <Table label="Outstanding runs by what they are waiting on">
                  <THead>
                    <TR>
                      <TH>State</TH>
                      <TH align="right">Runs</TH>
                      <TH>Who</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {outstanding.map((bucket) => (
                      <OutstandingRow key={bucket.key} bucket={bucket} />
                    ))}
                  </TBody>
                </Table>
              </div>
            )}

            {/* ---- per workflow, grouped by the RAIL's own categories ---- */}
            <div className="min-w-0">
              <SectionLabel className="mb-[var(--ds-space-snug)]">By workflow</SectionLabel>
              <Table label="Activity by workflow, grouped by category">
                <THead>
                  <TR>
                    <TH>Workflow</TH>
                    <TH align="right">Runs</TH>
                    <TH align="right">Share</TH>
                    <TH align="right">Read back</TH>
                    <TH align="right">Warnings</TH>
                    <TH align="right">Failed</TH>
                    <TH align="right">Open</TH>
                    <TH align="right">Est. min saved</TH>
                  </TR>
                </THead>
                {report.byCategory.map((block) => (
                  <CategoryBody key={block.label} block={block} total={report.totals.runs} />
                ))}
              </Table>
            </div>

            {/* ---- ledger ---- */}
            <div className="min-w-0">
              <SectionLabel className="mb-[var(--ds-space-snug)]">Write ledger — what was actually filed</SectionLabel>
              {report.ledger.length === 0 ? (
                <Well>
                  <span className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>
                    No ledger entries. Nothing in this report's reach filed anything into a real HR system.
                  </span>
                </Well>
              ) : (
                <Table label="Write ledger by system">
                  <THead>
                    <TR>
                      <TH>System</TH>
                      <TH align="right">Entries</TH>
                      <TH align="right">Production</TH>
                      <TH align="right">Test instance</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {report.ledger.map((line) => (
                      <TR key={line.system}>
                        <TD>{line.system}</TD>
                        <TD align="right" numeric>
                          {line.entries}
                        </TD>
                        <TD align="right" numeric>
                          {line.prod}
                        </TD>
                        <TD align="right" numeric className={line.test > 0 ? "text-[color:var(--ds-status-waiting-fg)]" : undefined}>
                          {line.test}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </div>

          </PanelBody>
          {/* PROVENANCE, not a defence of the design. The five-bullet "How to
              read this" card and the footer sentence asserting the report could
              not disagree with the dashboard are both gone: one was teaching
              that costs a card on every report, the other was the product
              claiming its own correctness, which is a test's job. The caveats
              are one press away in the header's ⓘ — this is the artifact that
              leaves the operator's screen, so they have to be reachable from it
              — and the footer states who made it, when, and out of what. */}
          <PanelFooter>
            <MetaLine
              items={[
                `generated ${report.generatedAt}`,
                DEMO_OPERATOR,
                `app ${DEMO_APP_VERSION}`,
                span.label,
                `${report.totals.runs} runs`,
              ]}
            />
          </PanelFooter>
        </Panel>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  note,
  tone = "default",
  info,
}: {
  label: string;
  value: string;
  note: string;
  tone?: "default" | "warning" | "estimate";
  /** the REASONING behind the number — a rule of the report, so it lives here */
  info?: ReactNode;
}) {
  return (
    <Card tone={tone === "warning" ? "attention" : "default"}>
      <CardBody grow className="flex flex-col gap-[var(--ds-space-hair)]">
        {/* The header row is RESERVED at the badge's own height on every tile.
            Only `Hours saved` carries a 20px `estimate` badge beside a 13px
            caps label, and without the reservation that one tile's header grew
            — dropping its big number, and the note under it, about 7px below
            its siblings' on the row the eye reads straight across. */}
        <span className="flex min-h-[var(--ds-h-xs)] items-center gap-[var(--ds-space-snug)]">
          <SectionLabel className="min-w-0 truncate">{label}</SectionLabel>
          {tone === "estimate" && <Badge tone="warning">estimate</Badge>}
          {info && (
            <Popover>
              <PopoverTrigger asChild>
                <IconButton
                  size="xs"
                  label={`How ${label.toLowerCase()} is counted`}
                  icon={<Info aria-hidden className={dsIcon.sm} />}
                  className="ml-auto text-[color:var(--ds-fg-faint)] hover:text-[color:var(--ds-fg)] data-[state=open]:text-[color:var(--ds-fg)]"
                />
              </PopoverTrigger>
              <PopoverContent title={label} width="lg" align="end">
                {info}
              </PopoverContent>
            </Popover>
          )}
        </span>
        <span className={cn(dsText.display, dsText.nums, "text-[color:var(--ds-fg)]")}>{value}</span>
        {/* The notes run one and two lines. Pinned, they end on one baseline
            across the row instead of each stopping wherever its own copy did. */}
        <CardBase className="pt-[var(--ds-space-hair)]">
          <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{note}</span>
        </CardBase>
      </CardBody>
    </Card>
  );
}

/**
 * One outstanding STATE, its count, and its people one press away.
 *
 * The wall this replaced was seventeen status-pill-plus-name chips wrapping
 * across three lines. It said nothing a supervisor could act on and nothing an
 * operator could count. The state is the question ("how many are waiting on
 * me"), the count is the answer, and the names stay reachable — a Popover
 * rather than a spray, because they are a list you consult, not a list you scan.
 */
function OutstandingRow({ bucket }: { bucket: OutstandingBucket }) {
  const first = bucket.rows[0];
  return (
    <TR>
      <TD>
        <StatusPill status={bucket.key} size="sm" />
      </TD>
      <TD align="right" numeric>
        {bucket.rows.length}
      </TD>
      <TD>
        <span className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
          <span className={cn(dsText.meta, "min-w-0 truncate text-[color:var(--ds-fg-secondary)]")}>
            {first.displayName ?? first.title}
            {bucket.rows.length > 1 && ` +${bucket.rows.length - 1}`}
          </span>
          {bucket.rows.length > 1 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="ghost" className="ml-auto shrink-0">
                  All {bucket.rows.length}
                </Button>
              </PopoverTrigger>
              <PopoverContent title={bucket.label} description={`${bucket.rows.length} runs`} width="lg" align="end">
                <ul className="flex flex-col gap-[var(--ds-space-tight)]">
                  {bucket.rows.map((row) => (
                    <li key={row.id} className="flex min-w-0 items-baseline gap-[var(--ds-space-snug)]">
                      <span className={cn(dsText.body, "min-w-0 flex-1 truncate text-[color:var(--ds-fg)]")}>
                        {row.displayName ?? row.title}
                      </span>
                      <span className={cn(dsText.meta, "shrink-0 text-[color:var(--ds-fg-muted)]")}>{row.wfLabel}</span>
                      <span className={cn(dsText.meta, dsText.nums, "shrink-0 text-[color:var(--ds-fg-faint)]")}>{row.trace}</span>
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          )}
        </span>
      </TD>
    </TR>
  );
}

/**
 * One CATEGORY block of the per-workflow table: a heading row, its workflows,
 * then its own subtotal — so Onboarding reads as a block against Separations
 * instead of both being scattered through fifteen rows in run-count order.
 *
 * It is its own `<tbody>`, which is what lets a heading and a subtotal live
 * inside one table without breaking the column alignment the whole point rests
 * on. The grouping comes from `buildWorkflowCategoryGroups` — the same
 * projection the rail reads — so the report cannot bin a workflow under a
 * heading the product does not use.
 */
function CategoryBody({ block, total }: { block: CategoryBlock; total: number }) {
  return (
    <TBody>
      <TR className="h-auto">
        <TD colSpan={8} className="bg-[var(--ds-surface-2)] py-[var(--ds-space-tight)]">
          <span className="flex min-w-0 items-baseline gap-[var(--ds-space-snug)]">
            <SectionLabel>{block.label}</SectionLabel>
            <span className={cn(dsText.micro, dsText.nums, "text-[color:var(--ds-fg-muted)]")}>
              {block.lines.length} workflow{block.lines.length === 1 ? "" : "s"}
            </span>
          </span>
        </TD>
      </TR>
      {block.lines.map((line) => (
        <WorkflowRow key={line.workflowId} line={line} total={total} />
      ))}
      <WorkflowRow line={block.subtotal} total={total} subtotal />
    </TBody>
  );
}

function WorkflowRow({ line, total, subtotal }: { line: WorkflowLine; total: number; subtotal?: boolean }) {
  // SHARE AS A NUMBER. It was a 110px ProgressBar per row — mostly empty track
  // with a 4px stub, which compares nothing legibly and, once the table is
  // grouped, compares a workflow against a total that is no longer the block it
  // sits in. A tabular percentage in a right-aligned column is a comparison the
  // eye can actually run down.
  const share = total === 0 ? 0 : Math.round((line.runs / total) * 1000) / 10;
  const cell = subtotal ? "font-semibold text-[color:var(--ds-fg)]" : undefined;
  return (
    <TR className={subtotal ? "bg-[var(--ds-surface-2)]" : undefined}>
      <TD className={cell}>
        <span className="flex items-baseline gap-[var(--ds-space-snug)]">
          {!subtotal && <span className={cn(dsText.nums, dsText.micro, "text-[color:var(--ds-fg-muted)]")}>{line.code}</span>}
          <span className={subtotal ? undefined : "text-[color:var(--ds-fg)]"}>
            {subtotal ? `${line.label} — subtotal` : line.label}
          </span>
        </span>
      </TD>
      <TD align="right" numeric className={cell}>
        {line.runs}
      </TD>
      <TD align="right" numeric className={cn(cell, "text-[color:var(--ds-fg-muted)]")}>
        {share}%
      </TD>
      <TD align="right" numeric className={cell}>
        {line.verified}
      </TD>
      <TD align="right" numeric className={cell}>
        {line.warnings}
      </TD>
      <TD align="right" numeric className={cn(cell, line.failed > 0 && "text-[color:var(--ds-status-failed-fg)]")}>
        {line.failed}
      </TD>
      <TD align="right" numeric className={cn(cell, line.outstanding > 0 && "text-[color:var(--ds-status-waiting-fg)]")}>
        {line.outstanding}
      </TD>
      <TD
        align="right"
        numeric
        className={cell}
        title={subtotal ? undefined : `${MANUAL_MINUTES[line.workflowId]} min/run × ${line.verified + line.warnings} finished`}
      >
        ≈ {line.minutesSaved}
      </TD>
    </TR>
  );
}
