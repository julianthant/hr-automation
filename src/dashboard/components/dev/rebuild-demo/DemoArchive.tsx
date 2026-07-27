import { useMemo, useState } from "react";
import { ArrowLeft, Archive, FileClock, Lock, RotateCw, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  Chip,
  EmptyState,
  PageHeader,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  PanelToolbar,
  SectionLabel,
  StatusPill,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Well,
  dsFocus,
  dsIcon,
  dsMotion,
  dsText,
} from "./demo-ui";
import {
  DEMO_ARCHIVE,
  DEMO_CHANGE_RECORDS,
  BUMP_SCOPE_LABEL,
  relaunchFromArchive,
  type ArchivedRunWire,
  type RelaunchResult,
} from "./demo-archive-wire";
import { DEMO_WORKFLOWS } from "./demo-wire";

/**
 * DEV-ONLY — the ARCHIVE: prior-version runs, read-only.
 *
 * The property that makes this page cheap forever: **every row here is a
 * self-contained snapshot.** Its final projected row, its receipt and its
 * evidence pointers were written at archive time, so this component renders an
 * `ArchivedRunWire` and nothing else — no version fallback, no compat shim, no
 * re-projection through the code the run actually executed. That is why an
 * archived v3 run opens identically to an archived v6 one.
 *
 * Two rules are stated on the surface because they are the ones that get
 * forgotten:
 *
 *  - **The write ledger is not archived.** Every run here still lists what it
 *    filed in a real HR system, because archiving is a display lifecycle and
 *    the ledger is an audit one.
 *  - **Relaunch is a FRESH run on the current version**, from the archived
 *    immutable input. It is never a resume — resuming across a version change
 *    would replay checkpoints that describe code which no longer exists.
 */

export function DemoArchivePage({ onBack, onOpenSettings }: { onBack: () => void; onOpenSettings: () => void }) {
  const [selectedId, setSelectedId] = useState(DEMO_ARCHIVE[0]?.runId ?? "");
  const [workflowFilter, setWorkflowFilter] = useState<string>("all");
  const [relaunch, setRelaunch] = useState<RelaunchResult | null>(null);

  const workflows = useMemo(() => {
    const seen = new Map<string, string>();
    for (const run of DEMO_ARCHIVE) seen.set(run.workflowId, run.workflowLabel);
    return [...seen.entries()];
  }, []);

  const visible = useMemo(
    () => (workflowFilter === "all" ? DEMO_ARCHIVE : DEMO_ARCHIVE.filter((run) => run.workflowId === workflowFilter)),
    [workflowFilter],
  );

  const byBump = useMemo(() => {
    const map = new Map<string, ArchivedRunWire[]>();
    for (const run of visible) map.set(run.bumpId, [...(map.get(run.bumpId) ?? []), run]);
    return [...map.entries()];
  }, [visible]);

  const selected = DEMO_ARCHIVE.find((run) => run.runId === selectedId) ?? visible[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Archive"
        icon={<Archive aria-hidden className={dsIcon.lg} />}
        badge={
          <Badge tone="neutral">
            <Lock aria-hidden className={dsIcon.sm} />
            read-only
          </Badge>
        }
        back={
          <Button variant="ghost" size="sm" icon={<ArrowLeft aria-hidden className={dsIcon.md} />} onClick={onBack}>
            Back to the dashboard
          </Button>
        }
        actions={
          <Button variant="ghost" size="sm" icon={<Settings aria-hidden className={dsIcon.md} />} onClick={onOpenSettings}>
            Version registry
          </Button>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-[var(--ds-space-base)] p-[var(--ds-space-cozy)] min-[1100px]:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        {/* ---- the list, grouped by the bump that swept it ---- */}
        <Panel className="min-h-0">
          <PanelHeader
            title="Archived runs"
            subtitle="Prior-version runs — gone from the queue, the counts and every filter."
            meta={`${visible.length} of ${DEMO_ARCHIVE.length}`}
          />
          <PanelToolbar label="Filter archived runs by workflow">
            <Chip selected={workflowFilter === "all"} onSelect={() => setWorkflowFilter("all")}>
              All
            </Chip>
            {workflows.map(([id, label]) => (
              <Chip key={id} selected={workflowFilter === id} onSelect={() => setWorkflowFilter(id)}>
                {label}
              </Chip>
            ))}
          </PanelToolbar>
          <PanelBody>
            {byBump.length === 0 ? (
              <EmptyState
                icon={<Archive aria-hidden className={dsIcon.lg} />}
                title="No archived runs for this workflow"
                description="A run reaches the archive only when its workflow's version bumps. Nothing has bumped this one yet."
                action={
                  <Button size="sm" variant="secondary" onClick={() => setWorkflowFilter("all")}>
                    Show every workflow
                  </Button>
                }
              />
            ) : (
              byBump.map(([bumpId, runs]) => {
                const record = DEMO_CHANGE_RECORDS.find((entry) => entry.id === bumpId);
                return (
                  <div key={bumpId} className="border-b border-[color:var(--ds-border-subtle)] last:border-b-0">
                    <div className="flex min-w-0 flex-col gap-[var(--ds-space-hair)] bg-[var(--ds-surface-2)] px-[var(--ds-space-cozy)] py-[var(--ds-space-snug)]">
                      <span className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
                        <FileClock aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
                        <span className={cn(dsText.meta, dsText.nums, "text-[color:var(--ds-fg)]")}>
                          {record ? `${record.fromVersion} → ${record.toVersion}` : bumpId}
                        </span>
                        {record && <Badge tone={record.scope === "dashboard" ? "warning" : "info"}>{BUMP_SCOPE_LABEL[record.scope]}</Badge>}
                        <span className={cn(dsText.micro, "ml-auto shrink-0 text-[color:var(--ds-fg-muted)]")}>{record?.at}</span>
                      </span>
                      {record && (
                        <span className={cn(dsText.micro, "truncate text-[color:var(--ds-fg-muted)]")} title={record.why}>
                          {record.what}
                        </span>
                      )}
                    </div>
                    <ul>
                      {runs.map((run) => {
                        const active = selected?.runId === run.runId;
                        return (
                          <li key={run.runId}>
                            <button
                              type="button"
                              aria-current={active ? "true" : undefined}
                              onClick={() => {
                                setSelectedId(run.runId);
                                setRelaunch(null);
                              }}
                              className={cn(
                                "flex w-full min-w-0 items-center gap-[var(--ds-space-base)] px-[var(--ds-space-cozy)] py-[var(--ds-space-snug)] text-left",
                                dsFocus,
                                dsMotion.base,
                                active ? "bg-[var(--ds-surface-selected)]" : "hover:bg-[var(--ds-surface-3)]",
                              )}
                            >
                              <StatusPill status={run.finalStatus} size="sm" hideIcon />
                              <span className="flex min-w-0 flex-1 flex-col">
                                <span className={cn(dsText.ui, "truncate text-[color:var(--ds-fg)]")}>
                                  {run.displayName ?? run.title}
                                </span>
                                <span className={cn(dsText.micro, dsText.nums, "truncate text-[color:var(--ds-fg-muted)]")}>
                                  {run.traceId} · {run.workflowLabel} v{run.workflowVersion}
                                </span>
                              </span>
                              <span className={cn(dsText.micro, dsText.nums, "shrink-0 text-[color:var(--ds-fg-faint)]")}>
                                {run.durationLabel}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })
            )}
          </PanelBody>
          <PanelFooter>
            <span className={cn(dsText.meta, "max-w-[104ch] text-[color:var(--ds-fg-muted)]")}>
              Archived runs never appear in a count, a rail badge or a Status Bar pill — active surfaces hold current-version runs
              only.
            </span>
          </PanelFooter>
        </Panel>

        {/* ---- the self-contained snapshot ---- */}
        {selected ? (
          <ArchivedRunDetail
            run={selected}
            relaunch={relaunch}
            onRelaunch={() => setRelaunch(relaunchFromArchive(selected))}
            onDismiss={() => setRelaunch(null)}
          />
        ) : (
          <Panel>
            <PanelBody>
              <EmptyState title="Nothing selected" description="Pick an archived run on the left to see its stored snapshot." />
            </PanelBody>
          </Panel>
        )}
      </div>
    </div>
  );
}

function ArchivedRunDetail({
  run,
  relaunch,
  onRelaunch,
  onDismiss,
}: {
  run: ArchivedRunWire;
  relaunch: RelaunchResult | null;
  onRelaunch: () => void;
  onDismiss: () => void;
}) {
  const currentVersion = DEMO_WORKFLOWS[run.workflowId].version;
  return (
    <Panel className="min-h-0">
      <PanelHeader
        title={run.displayName ?? run.title}
        subtitle={`${run.subtitle} · archived ${run.archivedAt}`}
        meta={
          <span className="flex items-center gap-[var(--ds-space-tight)]">
            <StatusPill status={run.finalStatus} size="sm" />
          </span>
        }
      />
      <PanelBody className="flex flex-col gap-[var(--ds-space-cozy)] p-[var(--ds-space-cozy)]">
        {relaunch && (
          <Banner
            tone="success"
            title={relaunch.headline}
            action={
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                Dismiss
              </Button>
            }
          >
            {relaunch.detail}
          </Banner>
        )}

        <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-tight)]">
          <Chip label="ran on">
            {run.workflowLabel} v{run.workflowVersion}
          </Chip>
          <Chip label="app">{run.appVersion}</Chip>
          <Chip label="trace">{run.traceId}</Chip>
          <Chip label="by">{run.requestedBy}</Chip>
          {run.workflowVersion < currentVersion && (
            <Chip tone="warning">
              current is v{currentVersion} — not comparable
            </Chip>
          )}
        </div>

        <Card>
          <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
            <div className="flex items-center gap-[var(--ds-space-snug)]">
              <SectionLabel>Receipt — stored, not re-derived</SectionLabel>
              <Badge
                tone={
                  run.receipt.confidence === "verified" ? "success" : run.receipt.confidence === "partial" ? "warning" : "neutral"
                }
                className="ml-auto"
              >
                {run.receipt.confidence}
              </Badge>
            </div>
            <p className={cn(dsText.ui, "text-[color:var(--ds-fg)]")}>{run.receipt.headline}</p>
            <Table label="Archived receipt lines">
              <TBody>
                {run.receipt.lines.map((line) => (
                  <TR key={line.label}>
                    <TD className="w-[180px] text-[color:var(--ds-fg-muted)]">{line.label}</TD>
                    <TD numeric>{line.value}</TD>
                    <TD align="right" className="w-[90px]">
                      {line.verified ? (
                        <span className={cn(dsText.micro, "text-[color:var(--ds-success-fg)]")}>read back</span>
                      ) : (
                        <span className={cn(dsText.micro, "text-[color:var(--ds-fg-faint)]")}>—</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardBody>
        </Card>

        <div className="grid grid-cols-1 gap-[var(--ds-space-base)] min-[900px]:grid-cols-2">
          <Card>
            <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
              <SectionLabel>Evidence pointers</SectionLabel>
              {run.evidence.length === 0 ? (
                <p className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>
                  No evidence was captured for this run.
                </p>
              ) : (
                run.evidence.map((item) => (
                  <div key={item.ref} className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
                    <Badge tone={item.kind === "error" ? "danger" : item.kind === "confirmation" ? "success" : "neutral"}>
                      {item.kind}
                    </Badge>
                    <span className={cn(dsText.body, "min-w-0 flex-1 truncate text-[color:var(--ds-fg-secondary)]")}>
                      {item.label}
                    </span>
                    <span className={cn(dsText.micro, dsText.nums, "shrink-0 text-[color:var(--ds-fg-faint)]")}>{item.ref}</span>
                  </div>
                ))
              )}
              <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
                Content-addressed. The archive stores the pointer; the image lives in the evidence store until it is purged.
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
              <SectionLabel>Immutable input — what a relaunch replays</SectionLabel>
              {run.input.map((item) => (
                <div key={item.label} className="flex min-w-0 items-baseline gap-[var(--ds-space-snug)]">
                  <span className={cn(dsText.meta, "w-[110px] shrink-0 text-[color:var(--ds-fg-muted)]")}>{item.label}</span>
                  <span className={cn(dsText.body, dsText.nums, "min-w-0 truncate text-[color:var(--ds-fg)]")}>{item.value}</span>
                </div>
              ))}
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
            <SectionLabel>Write ledger — never archived</SectionLabel>
            {run.ledger.length === 0 ? (
              <Well>
                <span className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>
                  This run filed nothing, so it has no ledger entry. An absent entry is itself the answer to “did this write?”.
                </span>
              </Well>
            ) : (
              <Table label="Ledger entries filed by this run">
                <THead>
                  <TR>
                    <TH>System</TH>
                    <TH>Action</TH>
                    <TH>Confirmation</TH>
                    <TH>Instance</TH>
                  </TR>
                </THead>
                <TBody>
                  {run.ledger.map((entry) => (
                    <TR key={entry.confirmation}>
                      <TD>{entry.system}</TD>
                      <TD>{entry.action}</TD>
                      <TD numeric>{entry.confirmation}</TD>
                      <TD>
                        <Chip tone={entry.instance === "test" ? "warning" : "neutral"}>{entry.instance}</Chip>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
            <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
              What was filed in a real HR system stays on record forever, whatever happens to the run's row.
            </p>
          </CardBody>
        </Card>
      </PanelBody>

      <PanelFooter>
        <span className={cn(dsText.meta, "max-w-[104ch] text-[color:var(--ds-fg-muted)]")}>
          Read-only. There is no retry, cancel or edit here — the code this run executed is not the code that is loaded.
        </span>
        <Button
          className="ml-auto"
          variant="primary"
          size="sm"
          icon={<RotateCw aria-hidden className={dsIcon.md} />}
          onClick={onRelaunch}
        >
          Relaunch on v{currentVersion}
        </Button>
      </PanelFooter>
    </Panel>
  );
}
