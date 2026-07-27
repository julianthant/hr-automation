import { useMemo, useState } from "react";
import { ArrowLeft, ChartNoAxesColumn, Download, Info, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  BulletList,
  Button,
  Card,
  CardBody,
  Chip,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  PanelToolbar,
  ProgressBar,
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
import { buildActivityReport, outstandingRows, REPORT_SPANS, MANUAL_MINUTES, MANUAL_MINUTES_PROVENANCE } from "./demo-report-wire";
import { effectiveStatus } from "./demo-data";
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
  const outstanding = useMemo(() => outstandingRows(span), [span]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-[var(--ds-space-base)] border-b border-[color:var(--ds-border)] px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]">
        <Button variant="ghost" size="sm" icon={<ArrowLeft aria-hidden className={dsIcon.md} />} onClick={onBack}>
          Back to the dashboard
        </Button>
        <span className="flex items-center gap-[var(--ds-space-snug)]">
          <ChartNoAxesColumn aria-hidden className={cn(dsIcon.lg, "text-[color:var(--ds-fg-muted)]")} />
          <span className={cn(dsText.section, "font-semibold text-[color:var(--ds-fg)]")}>Activity report</span>
        </span>
        <Button className="ml-auto" variant="ghost" size="sm" icon={<Settings aria-hidden className={dsIcon.md} />} onClick={onOpenSettings}>
          Settings
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-[var(--ds-space-cozy)]">
        <Panel>
          <PanelHeader
            title={`Automation activity — ${span.label}`}
            subtitle={`Generated ${report.generatedAt} by ${DEMO_OPERATOR} · app ${DEMO_APP_VERSION}`}
            meta={`${report.totals.runs} runs`}
            actions={
              <Button size="sm" variant="secondary" icon={<Download aria-hidden className={dsIcon.md} />}>
                Export
              </Button>
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
            {/* ---- headline tiles ---- */}
            <div className="grid grid-cols-2 gap-[var(--ds-space-base)] min-[900px]:grid-cols-4">
              <Tile label="Runs" value={String(report.totals.runs)} note={`${report.totals.people} distinct people touched`} />
              <Tile
                label="Finished"
                value={String(report.totals.verified + report.totals.warnings)}
                note={`${report.totals.verified} read back · ${report.totals.warnings} with warnings`}
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
                note="ESTIMATE — operator's per-workflow minutes × runs that finished"
                tone="estimate"
              />
            </div>

            {/* ---- the counterweight, not a footnote ---- */}
            <Banner
              tone={report.totals.outstanding > 0 ? "warning" : "success"}
              title={
                report.totals.outstanding > 0
                  ? `${report.totals.outstanding} runs in this span are still open`
                  : "Nothing in this span is still open"
              }
            >
              Outstanding work is reported beside finished work on purpose. None of it counts toward hours saved, and none of it
              counts in the error rate — a run that has not ended has not succeeded or failed yet.
            </Banner>

            {report.totals.outstanding > 0 && (
              <Card>
                <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
                  <SectionLabel>Still open</SectionLabel>
                  <div className="flex flex-wrap gap-[var(--ds-space-snug)]">
                    {outstanding.map((row) => (
                      <span key={row.id} className="flex items-center gap-[var(--ds-space-tight)]">
                        <StatusPill status={effectiveStatus(row)} size="sm" hideIcon />
                        <span className={cn(dsText.meta, "text-[color:var(--ds-fg-secondary)]")}>
                          {row.displayName ?? row.title}
                        </span>
                      </span>
                    ))}
                  </div>
                </CardBody>
              </Card>
            )}

            {/* ---- per workflow ---- */}
            <div className="min-w-0">
              <SectionLabel className="mb-[var(--ds-space-snug)]">By workflow</SectionLabel>
              <Table label="Activity by workflow">
                <THead>
                  <TR>
                    <TH>Workflow</TH>
                    <TH align="right">Runs</TH>
                    <TH align="right">Read back</TH>
                    <TH align="right">Warnings</TH>
                    <TH align="right">Failed</TH>
                    <TH align="right">Open</TH>
                    <TH align="right">Est. minutes saved</TH>
                    <TH>Share of runs</TH>
                  </TR>
                </THead>
                <TBody>
                  {report.byWorkflow.map((line) => (
                    <TR key={line.workflowId}>
                      <TD>
                        <span className="flex items-baseline gap-[var(--ds-space-snug)]">
                          <span className={cn(dsText.nums, dsText.micro, "text-[color:var(--ds-fg-muted)]")}>{line.code}</span>
                          <span className="text-[color:var(--ds-fg)]">{line.label}</span>
                        </span>
                      </TD>
                      <TD align="right" numeric>
                        {line.runs}
                      </TD>
                      <TD align="right" numeric>
                        {line.verified}
                      </TD>
                      <TD align="right" numeric>
                        {line.warnings}
                      </TD>
                      <TD
                        align="right"
                        numeric
                        className={line.failed > 0 ? "text-[color:var(--ds-status-failed-fg)]" : undefined}
                      >
                        {line.failed}
                      </TD>
                      <TD
                        align="right"
                        numeric
                        className={line.outstanding > 0 ? "text-[color:var(--ds-status-waiting-fg)]" : undefined}
                      >
                        {line.outstanding}
                      </TD>
                      <TD align="right" numeric title={`${MANUAL_MINUTES[line.workflowId]} min/run × ${line.verified + line.warnings} finished`}>
                        ≈ {line.minutesSaved}
                      </TD>
                      <TD>
                        <ProgressBar
                          label={`${line.label} share of runs`}
                          value={line.runs}
                          max={report.totals.runs}
                          className="w-[110px]"
                        />
                      </TD>
                    </TR>
                  ))}
                </TBody>
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

            {/* ---- how to read it ---- */}
            <Card>
              <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
                <span className="flex items-center gap-[var(--ds-space-snug)]">
                  <Info aria-hidden className={cn(dsIcon.md, "text-[color:var(--ds-fg-muted)]")} />
                  <SectionLabel>How to read this</SectionLabel>
                  <Badge tone="warning" className="ml-auto">
                    1 estimated figure
                  </Badge>
                </span>
                <BulletList items={report.caveats} className="max-w-[92ch]" />
              </CardBody>
            </Card>
          </PanelBody>
          <PanelFooter>
            <span className={cn(dsText.meta, "max-w-[110ch] text-[color:var(--ds-fg-muted)]")}>
              Every count here comes from the same projection the queue renders — the report and the dashboard cannot disagree.
              The only figure that is not measured is hours saved, which is {MANUAL_MINUTES_PROVENANCE}
            </span>
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
}: {
  label: string;
  value: string;
  note: string;
  tone?: "default" | "warning" | "estimate";
}) {
  return (
    <Card tone={tone === "warning" ? "attention" : "default"}>
      <CardBody className="flex flex-col gap-[var(--ds-space-hair)]">
        <span className="flex items-center gap-[var(--ds-space-snug)]">
          <SectionLabel>{label}</SectionLabel>
          {tone === "estimate" && <Badge tone="warning">estimate</Badge>}
        </span>
        <span className={cn(dsText.display, dsText.nums, "text-[color:var(--ds-fg)]")}>{value}</span>
        <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{note}</span>
      </CardBody>
    </Card>
  );
}
