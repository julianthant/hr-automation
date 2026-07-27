import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  ArrowUpRight,
  Archive,
  BadgeCheck,
  Camera,
  Download,
  FileClock,
  FlaskConical,
  ImageOff,
  Lock,
  RotateCw,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  BulletList,
  Button,
  Card,
  CardBody,
  Chip,
  ChipRow,
  CountBadge,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  EmptyState,
  Field,
  MetaLine,
  PageHeader,
  Panel,
  PanelBody,
  PanelFooter,
  PanelHeader,
  PanelToolbar,
  SearchInput,
  SectionLabel,
  Select,
  StatusPill,
  Tab,
  TabList,
  TabPanel,
  Table,
  Tabs,
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
  useToasts,
} from "./demo-ui";
import {
  ARCHIVE_RETENTION_NOTE,
  ARCHIVE_SORT_LABEL,
  BUMP_KIND_LABEL,
  BUMP_SCOPE_LABEL,
  DEMO_ARCHIVE,
  DEMO_CHANGE_RECORDS,
  EMPTY_ARCHIVE_QUERY,
  allTopLevelRows,
  archivedCapture,
  archivedRunExportName,
  archivedRunTouchedTest,
  archivedVersionTag,
  changeRecordFor,
  deriveRelaunchPlan,
  deriveVersionRegistry,
  exportArchivedRunJson,
  queryArchive,
  relaunchFromArchive,
  type ArchiveQuery,
  type ArchiveSortKey,
  type ArchivedEvidenceWire,
  type ArchivedRunWire,
  type RelaunchResult,
} from "./demo-archive-wire";
import { CaptureLightbox, downloadDemoFile } from "./DemoEvidence";
import { DEMO_WORKFLOWS, fmtClock, workflowVersionTag } from "./demo-wire";
import { PROPOSED_STATUS, type ProposedStatus } from "./demo-status";
import { DemoVersionBumpDialog, type BumpTarget } from "./DemoVersionBump";

/**
 * DEV-ONLY — the ARCHIVE: prior-version runs, read-only, and the version
 * registry that puts them there.
 *
 * The property that makes this page cheap forever: **every row here is a
 * self-contained snapshot.** Its final row, its receipt, its logs, its steps,
 * its members, its decisions, its data and its evidence pointers were written at
 * archive time, so this component renders an `ArchivedRunWire` and nothing else
 * — no version fallback, no compat shim, no re-projection through the code the
 * run actually executed. That is why an archived v3.1 run opens identically to
 * an archived v6.0 one.
 *
 * Three rules are stated on the surface because they are the ones that get
 * forgotten:
 *
 *  - **The write ledger is not archived.** Every run here still lists what it
 *    filed in a real HR system, because archiving is a display lifecycle and
 *    the ledger is an audit one.
 *  - **Relaunch is a FRESH run on the current version**, from the archived
 *    immutable input — never a resume. It now asks first, previews what it
 *    would create, and names what the archived run already filed, because at
 *    least one row here shows a real production UCPath write and a one-click
 *    relaunch beside it is the wrong default for a product whose thesis is
 *    "never duplicate a write".
 *  - **The version registry and the bump live HERE**, not in Settings. The
 *    archive is the consequence of a bump; a page called Settings should not be
 *    where you archive production runs.
 */

type ArchiveTab = "summary" | "logs" | "data" | "people" | "evidence";
type ArchiveView = "runs" | "versions";

export function DemoArchivePage({
  onBack,
  onOpenWorkflow,
}: {
  onBack: () => void;
  /** land in a workflow's queue panel — where a relaunched run appears */
  onOpenWorkflow: (workflowLabel: string) => void;
}) {
  const [view, setView] = useState<ArchiveView>("runs");
  const [query, setQuery] = useState<ArchiveQuery>(EMPTY_ARCHIVE_QUERY);
  const [selectedId, setSelectedId] = useState(DEMO_ARCHIVE[0]?.runId ?? "");
  /**
   * The relaunch result is keyed to the run it came from. Clearing it on a list
   * CLICK was not enough: search re-selects a run without one, so a result from
   * the previous run sat above a different run's detail claiming to be about it.
   */
  const [relaunch, setRelaunch] = useState<{ runId: string; result: RelaunchResult } | null>(null);
  const [confirming, setConfirming] = useState<ArchivedRunWire | null>(null);
  const [bump, setBump] = useState<BumpTarget | null>(null);

  const workflows = useMemo(() => {
    const seen = new Map<string, string>();
    for (const run of DEMO_ARCHIVE) seen.set(run.workflowId, run.workflowLabel);
    return [...seen.entries()];
  }, []);

  const statuses = useMemo(() => {
    const seen = new Set<ProposedStatus>();
    for (const run of DEMO_ARCHIVE) seen.add(run.finalStatus);
    return [...seen];
  }, []);

  const visible = useMemo(() => queryArchive(DEMO_ARCHIVE, query), [query]);

  /**
   * The selection resolves against the VISIBLE list, not the whole archive.
   * It used to resolve against the corpus, so filtering left the detail pane
   * showing a run that was no longer in the list with nothing highlighted.
   */
  const selected = visible.find((run) => run.runId === selectedId) ?? visible[0] ?? null;

  useEffect(() => {
    if (selected && selected.runId !== selectedId) setSelectedId(selected.runId);
  }, [selected, selectedId]);

  const byBump = useMemo(() => {
    const map = new Map<string, ArchivedRunWire[]>();
    for (const run of visible) map.set(run.bumpId, [...(map.get(run.bumpId) ?? []), run]);
    return [...map.entries()];
  }, [visible]);

  const setQueryPart = useCallback(<K extends keyof ArchiveQuery>(key: K, value: ArchiveQuery[K]) => {
    setQuery((prev) => ({ ...prev, [key]: value }));
  }, []);

  const filtered =
    query.text.trim() !== "" || query.workflowId !== "all" || query.status !== "all" || query.instance !== "all";

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
          <span
            role="group"
            aria-label="Archive view"
            className="inline-flex items-center gap-[var(--ds-space-hair)] rounded-[var(--ds-radius-md)] border border-[color:var(--ds-border)] bg-[var(--ds-surface-2)] p-[var(--ds-space-hair)]"
          >
            <Button size="sm" variant={view === "runs" ? "secondary" : "ghost"} aria-pressed={view === "runs"} onClick={() => setView("runs")}>
              Archived runs
            </Button>
            <Button
              size="sm"
              variant={view === "versions" ? "secondary" : "ghost"}
              aria-pressed={view === "versions"}
              onClick={() => setView("versions")}
            >
              Versions & bumps
            </Button>
          </span>
        }
      />

      {view === "versions" ? (
        <VersionsView onBump={setBump} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-[var(--ds-space-base)] p-[var(--ds-space-cozy)] min-[1100px]:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          {/* ---- the list, searchable, grouped by the bump that swept it ---- */}
          <Panel className="min-h-0">
            <PanelHeader
              title="Archived runs"
              subtitle="Prior-version runs — gone from the queue, the counts and every filter."
              meta={`${visible.length} of ${DEMO_ARCHIVE.length}`}
            />
            <PanelToolbar label="Find an archived run" className="flex-wrap py-[var(--ds-space-tight)]">
              {/* The single most plausible reason to open an archive is "did we
                  ever file something for this person?", and the only affordance
                  used to be a workflow chip row. */}
              <SearchInput
                aria-label="Search archived runs by name, EID, trace id or confirmation number"
                placeholder="Name, EID, trace id, confirmation…"
                value={query.text}
                onChange={(event) => setQueryPart("text", event.target.value)}
                onClear={() => setQueryPart("text", "")}
                className="min-w-[220px] flex-1"
              />
            </PanelToolbar>
            <PanelToolbar label="Filter and sort archived runs" className="flex-wrap gap-[var(--ds-space-snug)] py-[var(--ds-space-tight)]">
              <Select
                aria-label="Workflow"
                value={query.workflowId}
                onChange={(event) => setQueryPart("workflowId", event.target.value)}
                className="w-auto"
              >
                <option value="all">Every workflow</option>
                {workflows.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Final status"
                value={query.status}
                onChange={(event) => setQueryPart("status", event.target.value as ProposedStatus | "all")}
                className="w-auto"
              >
                <option value="all">Any outcome</option>
                {statuses.map((status) => (
                  <option key={status} value={status}>
                    {PROPOSED_STATUS[status].label}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Instance"
                value={query.instance}
                onChange={(event) => setQueryPart("instance", event.target.value as ArchiveQuery["instance"])}
                className="w-auto"
              >
                <option value="all">Any instance</option>
                <option value="prod">Production only</option>
                <option value="test">Touched a test instance</option>
              </Select>
              <Select
                aria-label="Sort"
                value={query.sort}
                onChange={(event) => setQueryPart("sort", event.target.value as ArchiveSortKey)}
                className="ml-auto w-auto"
              >
                {(Object.keys(ARCHIVE_SORT_LABEL) as ArchiveSortKey[]).map((key) => (
                  <option key={key} value={key}>
                    {ARCHIVE_SORT_LABEL[key]}
                  </option>
                ))}
              </Select>
            </PanelToolbar>
            <PanelBody>
              {byBump.length === 0 ? (
                <EmptyState
                  icon={<Archive aria-hidden className={dsIcon.lg} />}
                  title={filtered ? "Nothing in the archive matches" : "The archive is empty"}
                  description={
                    filtered
                      ? "Every archived run was excluded by the search or one of the filters. Clearing them shows all of them again."
                      : "A run reaches the archive only when its workflow's MAJOR version bumps. Nothing has bumped yet."
                  }
                  action={
                    filtered ? (
                      <Button size="sm" variant="secondary" onClick={() => setQuery(EMPTY_ARCHIVE_QUERY)}>
                        Clear the search and filters
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                byBump.map(([bumpId, runs]) => (
                  <div key={bumpId} className="border-b border-[color:var(--ds-border-subtle)] last:border-b-0">
                    <BumpGroupHeader bumpId={bumpId} count={runs.length} />
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
                                  {run.traceId} · {run.workflowLabel} {archivedVersionTag(run)}
                                </span>
                              </span>
                              {run.dryRun && (
                                <FlaskConical
                                  aria-label="dry run"
                                  className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-info-fg)]")}
                                />
                              )}
                              {archivedRunTouchedTest(run) && (
                                <TriangleAlert
                                  aria-label="touched a test instance"
                                  className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-status-waiting-fg)]")}
                                />
                              )}
                              <span className={cn(dsText.micro, dsText.nums, "shrink-0 text-[color:var(--ds-fg-faint)]")}>
                                {run.durationLabel}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))
              )}
            </PanelBody>
            <PanelFooter>
              <span className={cn(dsText.meta, "max-w-[104ch] text-[color:var(--ds-fg-muted)]")}>{ARCHIVE_RETENTION_NOTE}</span>
            </PanelFooter>
          </Panel>

          {/* ---- the self-contained snapshot ---- */}
          {selected ? (
            <ArchivedRunDetail
              run={selected}
              relaunch={relaunch?.runId === selected.runId ? relaunch.result : null}
              onRelaunch={() => setConfirming(selected)}
              onDismiss={() => setRelaunch(null)}
              onOpenWorkflow={onOpenWorkflow}
            />
          ) : (
            <Panel>
              <PanelBody>
                <EmptyState
                  title="Nothing selected"
                  description="Pick an archived run on the left to see its stored snapshot."
                />
              </PanelBody>
            </Panel>
          )}
        </div>
      )}

      <RelaunchConfirmDialog
        run={confirming}
        onCancel={() => setConfirming(null)}
        onConfirm={(run) => {
          setConfirming(null);
          setRelaunch({ runId: run.runId, result: relaunchFromArchive(run) });
        }}
      />

      <DemoVersionBumpDialog target={bump} onClose={() => setBump(null)} onOpenArchive={() => setView("runs")} />
    </div>
  );
}

/**
 * The group header. When no change record matches the `bumpId` it used to
 * degrade to the raw id in the slot a version pair belongs — the one case where
 * the archive silently lost the reason it exists. Now the gap is NAMED.
 */
function BumpGroupHeader({ bumpId, count }: { bumpId: string; count: number }) {
  const record = changeRecordFor(bumpId);
  return (
    <div className="flex min-w-0 flex-col gap-[var(--ds-space-hair)] bg-[var(--ds-surface-2)] px-[var(--ds-space-cozy)] py-[var(--ds-space-snug)]">
      <span className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
        <FileClock aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
        {record ? (
          <>
            <span className={cn(dsText.meta, dsText.nums, "text-[color:var(--ds-fg)]")}>
              {record.fromVersion} → {record.toVersion}
            </span>
            <Badge tone={record.kind === "major" ? "warning" : "neutral"} title={BUMP_KIND_LABEL[record.kind]}>
              {record.kind}
            </Badge>
            <Badge tone={record.scope === "dashboard" ? "warning" : "info"}>{BUMP_SCOPE_LABEL[record.scope]}</Badge>
            <span className={cn(dsText.micro, "ml-auto shrink-0 text-[color:var(--ds-fg-muted)]")}>{record.at}</span>
          </>
        ) : (
          <>
            <span className={cn(dsText.meta, "text-[color:var(--ds-danger)]")}>Change record missing</span>
            <Badge tone="danger">
              <ShieldAlert aria-hidden className={dsIcon.sm} />
              no reason on record
            </Badge>
            <CountBadge value={count} className="ml-auto" />
          </>
        )}
      </span>
      {record ? (
        <span className={cn(dsText.micro, "truncate text-[color:var(--ds-fg-muted)]")} title={record.why}>
          {record.what}
        </span>
      ) : (
        <span className={cn(dsText.micro, "text-[color:var(--ds-fg-muted)]")}>
          Swept by <span className={dsText.nums}>{bumpId}</span>, which the change-record store does not hold. The runs are
          intact; what is missing is why they were archived.
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The detail
// ---------------------------------------------------------------------------

function ArchivedRunDetail({
  run,
  relaunch,
  onRelaunch,
  onDismiss,
  onOpenWorkflow,
}: {
  run: ArchivedRunWire;
  relaunch: RelaunchResult | null;
  onRelaunch: () => void;
  onDismiss: () => void;
  onOpenWorkflow: (workflowLabel: string) => void;
}) {
  const [tab, setTab] = useState<ArchiveTab>("summary");
  const [openCapture, setOpenCapture] = useState<number | null>(null);
  const { toast } = useToasts();

  useEffect(() => {
    setTab("summary");
    setOpenCapture(null);
  }, [run.runId]);

  const workflow = DEMO_WORKFLOWS[run.workflowId];
  const olderMajor = run.workflowVersion < workflow.version;
  const retained = run.evidence.filter((item) => item.retention === "retained");

  const exportRun = () => {
    downloadDemoFile(archivedRunExportName(run), exportArchivedRunJson(run), "application/json");
    toast({ tone: "success", title: "Archived run exported", description: archivedRunExportName(run) });
  };

  return (
    <Panel className="min-h-0">
      <PanelHeader
        title={run.displayName ?? run.title}
        subtitle={`${run.subtitle} · archived ${run.archivedAt} by ${run.provenance.archivedBy}`}
        meta={<StatusPill status={run.finalStatus} size="sm" />}
        actions={
          <Button size="sm" variant="ghost" icon={<Download aria-hidden className={dsIcon.md} />} onClick={exportRun}>
            Export
          </Button>
        }
      />

      {/* The command that produces this is in the panel FOOTER, which is
          visible from every tab — so its answer is mounted above the tab set
          rather than inside one of them. It landed in the Summary panel first,
          and pressing Relaunch from the Evidence tab showed nothing at all. */}
      {relaunch && <div className="px-[var(--ds-space-cozy)] pt-[var(--ds-space-cozy)]">
        
          <Banner
            tone="success"
            title={relaunch.headline}
            action={
              <span className="flex items-center gap-[var(--ds-space-tight)]">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<ArrowUpRight aria-hidden className={dsIcon.md} />}
                  onClick={() => onOpenWorkflow(relaunch.created.panel)}
                >
                  Open {relaunch.created.panel}
                </Button>
                <Button size="sm" variant="ghost" onClick={onDismiss}>
                  Dismiss
                </Button>
              </span>
            }
          >
            <span className="flex flex-col gap-[var(--ds-space-tight)]">
              <span>{relaunch.detail}</span>
              <MetaLine items={[`new run ${relaunch.created.traceId}`, `lands in ${relaunch.created.panel}`]} />
            </span>
          </Banner>
      </div>}

      <Tabs value={tab} onValueChange={(next) => setTab(next as ArchiveTab)} className="min-h-0 flex-1">
        <TabList label="Archived run detail">
          <Tab value="summary">Summary</Tab>
          <Tab value="logs" count={run.logs.length}>
            Logs
          </Tab>
          <Tab value="data" count={run.data.length}>
            Data
          </Tab>
          {run.members.length > 0 && (
            <Tab value="people" count={run.members.length}>
              People
            </Tab>
          )}
          <Tab value="evidence" count={run.evidence.length}>
            Evidence
          </Tab>
        </TabList>

        <TabPanel value="summary" className="flex flex-col gap-[var(--ds-space-cozy)] p-[var(--ds-space-cozy)]">
          {/* Identity. Without dryRun / instance / priority an archived
              rehearsal is indistinguishable from an archived filing. */}
          <ChipRow>
            <Chip label="version">{archivedVersionTag(run)}</Chip>
            <Chip label="app">{run.appVersion}</Chip>
            <Chip label="trace">{run.traceId}</Chip>
            <Chip label="by">{run.requestedBy}</Chip>
            <Chip label="priority" tone={run.priority === "bulk" ? "neutral" : "info"}>
              {run.priority}
            </Chip>
            {run.preset && <Chip label="preset">{run.preset}</Chip>}
            {run.dryRun && (
              <Chip tone="info" icon={<FlaskConical aria-hidden className={dsIcon.sm} />}>
                dry run — wrote nothing
              </Chip>
            )}
            {archivedRunTouchedTest(run) && (
              <Chip tone="warning" icon={<TriangleAlert aria-hidden className={dsIcon.sm} />}>
                test instance
              </Chip>
            )}
            {olderMajor && <Chip tone="warning">shape moved · {workflowVersionTag(workflow)}</Chip>}
          </ChipRow>

          <MetaLine
            items={[
              run.workflowLabel,
              `code ${run.workflowCode}`,
              `enqueued ${run.enqueuedAt}`,
              `ended ${run.endedAt}`,
              `ran ${run.durationLabel}`,
              ...Object.entries(run.resolvedInstance).map(([system, instance]) => `${system} ${instance}`),
            ]}
          />

          <BumpRecordCard bumpId={run.bumpId} />

          {run.failure && (
            <Card tone="danger">
              <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
                <SectionLabel>Failure record</SectionLabel>
                <p className={cn(dsText.ui, "text-[color:var(--ds-fg)]")}>{run.failure.headline}</p>
                <Well>
                  <SectionLabel className="mb-[var(--ds-space-tight)]">What this run left behind</SectionLabel>
                  <p className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>{run.failure.writeState}</p>
                </Well>
                <MetaLine items={[run.failure.classification]} />
                <p className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>{run.failure.cause}</p>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
              <div className="flex items-center gap-[var(--ds-space-snug)]">
                <SectionLabel>Receipt — stored, not re-derived</SectionLabel>
                <Badge
                  tone={run.receipt.confidence === "verified" ? "success" : run.receipt.confidence === "partial" ? "warning" : "neutral"}
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

          <Card>
            <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
              <SectionLabel>Step timeline</SectionLabel>
              <ul className="flex flex-col">
                {run.steps.map((step) => (
                  <li
                    key={step.label}
                    className="flex min-w-0 items-center gap-[var(--ds-space-snug)] border-b border-[color:var(--ds-border-subtle)] py-[var(--ds-space-tight)] last:border-b-0"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        step.state === "done" && "bg-[var(--ds-status-verified-mark)]",
                        step.state === "failed" && "bg-[var(--ds-status-failed-mark)]",
                        step.state === "cancelled" && "bg-[var(--ds-status-cancelled-mark)]",
                        step.state === "skipped" && "bg-[var(--ds-fg-faint)]",
                      )}
                    />
                    <span className={cn(dsText.body, "min-w-0 flex-1 truncate text-[color:var(--ds-fg)]")}>{step.label}</span>
                    <span className={cn(dsText.meta, "shrink-0 text-[color:var(--ds-fg-muted)]")}>{step.state}</span>
                    <span className={cn(dsText.meta, dsText.nums, "w-[70px] shrink-0 text-right text-[color:var(--ds-fg-faint)]")}>
                      {step.durationLabel ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          <div className="grid grid-cols-1 gap-[var(--ds-space-base)] min-[900px]:grid-cols-2">
            <Card>
              <CardBody grow className="flex flex-col gap-[var(--ds-space-snug)]">
                <SectionLabel>Immutable input — what a relaunch replays</SectionLabel>
                {run.input.map((item) => (
                  <div key={item.label} className="flex min-w-0 items-baseline gap-[var(--ds-space-snug)]">
                    <span className={cn(dsText.meta, "w-[110px] shrink-0 text-[color:var(--ds-fg-muted)]")}>{item.label}</span>
                    <span className={cn(dsText.body, dsText.nums, "min-w-0 truncate text-[color:var(--ds-fg)]")}>{item.value}</span>
                  </div>
                ))}
              </CardBody>
            </Card>

            <Card>
              <CardBody grow className="flex flex-col gap-[var(--ds-space-snug)]">
                <SectionLabel>Attempts</SectionLabel>
                {run.attempts.map((attempt) => (
                  <div key={attempt.ordinal} className="flex min-w-0 flex-col gap-[var(--ds-space-hair)]">
                    <span className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
                      <span className={cn(dsText.meta, dsText.nums, "shrink-0 text-[color:var(--ds-fg-muted)]")}>
                        #{attempt.ordinal}
                      </span>
                      <StatusPill status={attempt.outcome} size="sm" hideIcon />
                      <span className={cn(dsText.meta, dsText.nums, "min-w-0 truncate text-[color:var(--ds-fg)]")}>
                        {attempt.traceId}
                      </span>
                      <span className={cn(dsText.micro, "ml-auto shrink-0 text-[color:var(--ds-fg-faint)]")}>{attempt.at}</span>
                    </span>
                    <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{attempt.note}</span>
                  </div>
                ))}
              </CardBody>
            </Card>
          </div>

          {run.decisions.length > 0 && (
            <Card>
              <CardBody className="flex flex-col gap-[var(--ds-space-base)]">
                <SectionLabel>Decisions</SectionLabel>
                {run.decisions.map((decision) => (
                  <div key={`${decision.at}-${decision.kind}`} className="flex min-w-0 flex-col gap-[var(--ds-space-hair)]">
                    <span className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
                      <Badge tone="neutral">{decision.kind}</Badge>
                      <span className={cn(dsText.micro, dsText.nums, "ml-auto shrink-0 text-[color:var(--ds-fg-faint)]")}>
                        {decision.at} · {decision.by}
                      </span>
                    </span>
                    <span className={cn(dsText.body, "text-[color:var(--ds-fg)]")}>{decision.question}</span>
                    <span className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>{decision.answer}</span>
                  </div>
                ))}
              </CardBody>
            </Card>
          )}

          <Card>
            <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
              <SectionLabel>Write ledger — never archived</SectionLabel>
              {run.ledger.length === 0 ? (
                <Well>
                  <span className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>
                    This run filed nothing, so it has no ledger entry. An absent entry is itself the answer to “did this
                    write?”.
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
            </CardBody>
          </Card>

          {/* The page's whole claim rests on trusting this row, and nothing was
              checking the row. */}
          <Card>
            <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
              <SectionLabel>Snapshot provenance & retention</SectionLabel>
              <MetaLine
                items={[
                  `archived by ${run.provenance.archivedBy}`,
                  `schema ${run.provenance.schema}`,
                  run.provenance.snapshotHash,
                  `integrity verified ${run.provenance.snapshotVerifiedAt}`,
                ]}
              />
              <BulletList
                items={[
                  `Row — ${run.retention.rowPurgeAt}.`,
                  `Evidence images — ${run.retention.evidencePurgeAt} (${retained.length} of ${run.evidence.length} still retained).`,
                  run.retention.policy,
                ]}
              />
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="logs" className="p-[var(--ds-space-cozy)]">
          <ul className="flex flex-col">
            {run.logs.map((line, index) => (
              <li
                key={`${line.at}-${index}`}
                className="flex min-w-0 items-start gap-[var(--ds-space-snug)] border-b border-[color:var(--ds-border-subtle)] py-[var(--ds-space-tight)] last:border-b-0"
              >
                <span className={cn(dsText.meta, dsText.nums, "w-[76px] shrink-0 pt-px text-[color:var(--ds-fg-faint)]")}>
                  {line.at}
                </span>
                <span className={cn(dsText.caps, "w-[46px] shrink-0 pt-px", LOG_LEVEL_CLASS[line.level])}>{line.level}</span>
                <span className={cn(dsText.body, "min-w-0 flex-1 break-words text-[color:var(--ds-fg)]")}>{line.text}</span>
                {line.system && (
                  <span className={cn(dsText.caps, "shrink-0 pt-px text-[color:var(--ds-fg-muted)]")}>{line.system}</span>
                )}
              </li>
            ))}
          </ul>
        </TabPanel>

        <TabPanel value="data" className="p-[var(--ds-space-cozy)]">
          <ul className="flex flex-col">
            {run.data.map((point, index) => (
              <li
                key={`${point.field}-${index}`}
                className="flex min-w-0 flex-col gap-[var(--ds-space-hair)] border-b border-[color:var(--ds-border-subtle)] py-[var(--ds-space-snug)] last:border-b-0"
              >
                <span className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
                  {point.direction === "read" ? (
                    <ArrowDownToLine aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-read-fg)]")} />
                  ) : (
                    <ArrowUpFromLine aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-write-fg)]")} />
                  )}
                  <span className={cn(dsText.meta, "min-w-0 truncate text-[color:var(--ds-fg-muted)]")}>{point.field}</span>
                  {point.correctedFrom && (
                    <Badge tone="warning" title={`The machine read “${point.correctedFrom}”. It is kept beside the value.`}>
                      corrected
                    </Badge>
                  )}
                  {point.system && (
                    <span className={cn(dsText.caps, "shrink-0 text-[color:var(--ds-fg-muted)]")}>{point.system}</span>
                  )}
                  <span className={cn(dsText.micro, dsText.nums, "ml-auto shrink-0 text-[color:var(--ds-fg-faint)]")}>
                    {point.at ?? ""}
                  </span>
                </span>
                <span className={cn(dsText.body, dsText.nums, "break-words text-[color:var(--ds-fg)]")}>{point.value}</span>
                {point.correctedFrom && (
                  <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
                    read as <span className={dsText.nums}>{point.correctedFrom}</span> · corrected by {point.correctedBy}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </TabPanel>

        {run.members.length > 0 && (
          <TabPanel value="people" className="p-[var(--ds-space-cozy)]">
            <Table label="People this run covered">
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>EID</TH>
                  <TH>Outcome</TH>
                  <TH>Detail</TH>
                </TR>
              </THead>
              <TBody>
                {run.members.map((member) => (
                  <TR key={member.id}>
                    <TD>{member.name}</TD>
                    <TD numeric>{member.eid ?? "—"}</TD>
                    <TD>
                      <Badge tone={member.tone === "danger" ? "danger" : member.tone === "warning" ? "warning" : "neutral"}>
                        {member.outcome}
                      </Badge>
                    </TD>
                    <TD className="max-w-[360px]">{member.detail}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TabPanel>
        )}

        <TabPanel value="evidence" className="flex flex-col gap-[var(--ds-space-base)] p-[var(--ds-space-cozy)]">
          {run.evidence.length === 0 ? (
            <EmptyState
              icon={<Camera aria-hidden className={dsIcon.lg} />}
              title="No evidence was captured"
              description="This run filed no capture. There is nothing to purge and nothing to open."
            />
          ) : (
            run.evidence.map((item, index) => (
              <EvidenceTile key={item.id} item={item} onOpen={() => setOpenCapture(index)} />
            ))
          )}
        </TabPanel>
      </Tabs>

      <PanelFooter>
        <span className={cn(dsText.meta, "max-w-[80ch] text-[color:var(--ds-fg-muted)]")}>
          Read-only. There is no retry, cancel or edit here — the code this run executed is not the code that is loaded.
        </span>
        <Button
          className="ml-auto"
          variant="primary"
          size="sm"
          icon={<RotateCw aria-hidden className={dsIcon.md} />}
          onClick={onRelaunch}
        >
          Relaunch on {workflowVersionTag(workflow)}…
        </Button>
      </PanelFooter>

      {openCapture !== null && (
        <CaptureLightbox
          captures={run.evidence.map(archivedCapture)}
          index={openCapture}
          onIndex={setOpenCapture}
          onClose={() => setOpenCapture(null)}
          subject={{ label: run.displayName ?? run.title, trace: run.traceId }}
        />
      )}
    </Panel>
  );
}

const LOG_LEVEL_CLASS: Record<"info" | "warn" | "error" | "read" | "write", string> = {
  info: "text-[color:var(--ds-fg-muted)]",
  warn: "text-[color:var(--ds-status-waiting-fg)]",
  error: "text-[color:var(--ds-danger)]",
  read: "text-[color:var(--ds-read-fg)]",
  write: "text-[color:var(--ds-write-fg)]",
};

/**
 * Which bump swept this run, in the DETAIL. The scope badge used to live only
 * in the list's group header and vanished the moment you opened a run.
 */
function BumpRecordCard({ bumpId }: { bumpId: string }) {
  const record = changeRecordFor(bumpId);
  if (!record) {
    return (
      <Banner tone="warning" title="Archived by a sweep with no change record">
        This run was swept by <span className={dsText.nums}>{bumpId}</span>, and the change-record store does not hold it. The
        snapshot is intact and verifiable; what is missing is the stated reason it left the dashboard.
      </Banner>
    );
  }
  return (
    <Card>
      <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
        <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-snug)]">
          <SectionLabel>Archived by</SectionLabel>
          <Badge tone={record.kind === "major" ? "warning" : "neutral"}>{BUMP_KIND_LABEL[record.kind]}</Badge>
          <Badge tone={record.scope === "dashboard" ? "warning" : "info"}>{BUMP_SCOPE_LABEL[record.scope]}</Badge>
          <span className={cn(dsText.meta, dsText.nums, "ml-auto text-[color:var(--ds-fg)]")}>
            {record.fromVersion} → {record.toVersion}
          </span>
        </div>
        <p className={cn(dsText.body, "text-[color:var(--ds-fg)]")}>{record.what}</p>
        <p className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>{record.why}</p>
        <MetaLine items={[record.at, record.by, record.commit, `${record.archivedRuns} archived`]} />
      </CardBody>
    </Card>
  );
}

function EvidenceTile({ item, onOpen }: { item: ArchivedEvidenceWire; onOpen: () => void }) {
  const purged = item.retention === "purged";
  return (
    <Card>
      <CardBody className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-base)]">
        <Badge tone={item.kind === "error" ? "danger" : item.kind === "confirmation" ? "success" : "neutral"}>{item.kind}</Badge>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn(dsText.ui, "truncate text-[color:var(--ds-fg)]")}>{item.label}</span>
          <MetaLine items={[item.step, item.system?.toUpperCase(), item.capturedAt ? fmtClock(item.capturedAt) : undefined, item.ref]} />
        </span>
        {/* Whether the BYTES are still there. A content ref with no retention
            state is a link the operator cannot tell from a dead one. */}
        {purged ? (
          <span className={cn(dsText.meta, "flex shrink-0 items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-fg-muted)]")}>
            <ImageOff aria-hidden className={dsIcon.sm} />
            {item.retentionAt}
          </span>
        ) : (
          <span className={cn(dsText.meta, "shrink-0 text-[color:var(--ds-fg-muted)]")}>{item.retentionAt}</span>
        )}
        <Button size="sm" variant={purged ? "outline" : "secondary"} icon={<Camera aria-hidden className={dsIcon.md} />} onClick={onOpen}>
          {purged ? "What it was" : "Open"}
        </Button>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Relaunch — it asks, it previews, and it links what it made
// ---------------------------------------------------------------------------

function RelaunchConfirmDialog({
  run,
  onCancel,
  onConfirm,
}: {
  run: ArchivedRunWire | null;
  onCancel: () => void;
  onConfirm: (run: ArchivedRunWire) => void;
}) {
  return (
    <Dialog open={run !== null} onOpenChange={(open) => !open && onCancel()}>
      {run && <RelaunchConfirmBody run={run} onCancel={onCancel} onConfirm={onConfirm} />}
    </Dialog>
  );
}

function RelaunchConfirmBody({
  run,
  onCancel,
  onConfirm,
}: {
  run: ArchivedRunWire;
  onCancel: () => void;
  onConfirm: (run: ArchivedRunWire) => void;
}) {
  const plan = useMemo(() => deriveRelaunchPlan(run), [run]);
  return (
    <DialogContent
      size="lg"
      title={`Relaunch ${run.displayName ?? run.title} on ${plan.versionTag}?`}
      description={`A fresh ${plan.workflowLabel} run from the archived input — never a resume of ${run.traceId}.`}
    >
      <DialogBody className="flex flex-col gap-[var(--ds-space-cozy)]">
        {plan.alreadyFiled.length > 0 && (
          <Banner
            tone="danger"
            title={`This run already filed ${plan.alreadyFiled.length} record${plan.alreadyFiled.length === 1 ? "" : "s"} in a real system`}
            icon={<TriangleAlert aria-hidden className={dsIcon.lg} />}
          >
            <span className="flex flex-col gap-[var(--ds-space-snug)]">
              <span>
                A relaunch does not know about them. If the work still stands, this files it a second time.
              </span>
              <Well>
                <ul className="flex flex-col gap-[var(--ds-space-hair)]">
                  {plan.alreadyFiled.map((entry) => (
                    <li key={entry.confirmation} className={cn(dsText.body, "flex min-w-0 items-baseline gap-[var(--ds-space-snug)]")}>
                      <span className={cn(dsText.caps, "w-[80px] shrink-0 text-[color:var(--ds-fg-muted)]")}>{entry.system}</span>
                      <span className="min-w-0 flex-1 truncate text-[color:var(--ds-fg)]">{entry.action}</span>
                      <span className={cn(dsText.nums, "shrink-0 text-[color:var(--ds-fg-muted)]")}>{entry.confirmation}</span>
                    </li>
                  ))}
                </ul>
              </Well>
            </span>
          </Banner>
        )}

        <Field label="What this would create">
          <Well>
            <div className="flex min-w-0 flex-col gap-[var(--ds-space-snug)]">
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-snug)]">
                <BadgeCheck aria-hidden className={cn(dsIcon.md, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
                <span className={cn(dsText.ui, "text-[color:var(--ds-fg)]")}>
                  1 {plan.workflowLabel} run on {plan.versionTag}
                </span>
                <Badge tone="neutral" className="ml-auto">
                  lands in {plan.panel}
                </Badge>
              </div>
              <MetaLine
                items={[
                  "trace id assigned at enqueue",
                  `archived run ran ${plan.archivedVersionTag}`,
                  `drives ${plan.systems.join(", ")}`,
                ]}
              />
            </div>
          </Well>
        </Field>

        <Field label="Input it replays — unchanged from the archive">
          <Well>
            <ul className="flex flex-col gap-[var(--ds-space-hair)]">
              {plan.input.map((item) => (
                <li key={item.label} className="flex min-w-0 items-baseline gap-[var(--ds-space-snug)]">
                  <span className={cn(dsText.meta, "w-[110px] shrink-0 text-[color:var(--ds-fg-muted)]")}>{item.label}</span>
                  <span className={cn(dsText.body, dsText.nums, "min-w-0 truncate text-[color:var(--ds-fg)]")}>{item.value}</span>
                </li>
              ))}
            </ul>
          </Well>
        </Field>

        {plan.cautions.length > 0 && (
          <div className="min-w-0">
            <SectionLabel className="mb-[var(--ds-space-snug)]">Decide these, rather than discover them</SectionLabel>
            <BulletList items={plan.cautions} />
          </div>
        )}
      </DialogBody>

      <DialogFooter meta={`Archived run ${run.traceId} stays exactly as it ended.`}>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" icon={<RotateCw aria-hidden className={dsIcon.md} />} onClick={() => onConfirm(run)}>
          Enqueue a new run
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// ---------------------------------------------------------------------------
// Versions & bumps — moved out of Settings
// ---------------------------------------------------------------------------

function VersionsView({ onBump }: { onBump: (target: BumpTarget) => void }) {
  const rows = useMemo(() => allTopLevelRows(), []);
  const registry = useMemo(() => deriveVersionRegistry(rows), [rows]);
  const blocked = registry.filter((entry) => entry.nonTerminal > 0).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col p-[var(--ds-space-cozy)]">
      <Panel className="min-h-0 flex-1">
        <PanelHeader
          title="Versions & bumps"
          subtitle="Every workflow's current descriptor version, the runs stamped with it, and the two bump arms."
          icon={<BadgeCheck aria-hidden className={dsIcon.lg} />}
          meta={`app ${registry[0]?.appVersion ?? ""}`}
        />
        <PanelBody>
          <Banner
            tone={blocked > 0 ? "warning" : "info"}
            title={
              blocked > 0
                ? `${blocked} workflows have runs that are not terminal — a MAJOR bump on those is refused`
                : "Every listed run is terminal — a major bump can proceed anywhere"
            }
            className="m-[var(--ds-space-cozy)]"
            action={
              <Button size="sm" variant="secondary" onClick={() => onBump({ scope: "dashboard", workflowIds: [] })}>
                Dashboard update…
              </Button>
            }
          >
            A <strong>major</strong> bump moves every prior-version run out of the dashboard into the read-only archive, and it{" "}
            <strong>cannot</strong> archive a run that is still queued, running, waiting on you or parked — the bump flow lists
            them by name. A <strong>minor</strong> bump is presentation only: nothing archives, so nothing can block it.
          </Banner>
          <Table label="Workflow version registry">
            <THead>
              <TR>
                <TH>Workflow</TH>
                <TH align="right">Version</TH>
                <TH align="right">At current</TH>
                <TH align="right">Older major</TH>
                <TH align="right">Not terminal</TH>
                <TH align="right">Archived</TH>
                <TH align="right">Bump</TH>
              </TR>
            </THead>
            <TBody>
              {registry.map((entry) => (
                <TR key={entry.workflowId}>
                  <TD>
                    <span className="flex items-baseline gap-[var(--ds-space-snug)]">
                      <span className={cn(dsText.nums, dsText.micro, "text-[color:var(--ds-fg-muted)]")}>{entry.code}</span>
                      <span className={cn(dsText.ui, "text-[color:var(--ds-fg)]")}>{entry.label}</span>
                    </span>
                  </TD>
                  <TD align="right" numeric>
                    v{entry.currentVersion}
                  </TD>
                  <TD align="right" numeric>
                    {entry.atCurrentVersion}
                  </TD>
                  <TD
                    align="right"
                    numeric
                    className={entry.atPriorVersion > 0 ? "text-[color:var(--ds-status-waiting-fg)]" : undefined}
                  >
                    {entry.atPriorVersion}
                  </TD>
                  <TD align="right">
                    <CountBadge value={entry.nonTerminal} tone={entry.nonTerminal > 0 ? "warning" : "neutral"} />
                  </TD>
                  <TD align="right" numeric>
                    {entry.archived}
                  </TD>
                  <TD align="right">
                    <Button size="sm" variant="outline" onClick={() => onBump({ scope: "workflow", workflowIds: [entry.workflowId] })}>
                      Bump…
                    </Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>

          <div className="p-[var(--ds-space-cozy)]">
            <SectionLabel className="mb-[var(--ds-space-snug)]">Change records</SectionLabel>
            <div className="flex flex-col gap-[var(--ds-space-base)]">
              {DEMO_CHANGE_RECORDS.map((record) => (
                <Card key={record.id}>
                  <CardBody className="flex min-w-0 flex-col gap-[var(--ds-space-tight)]">
                    <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-snug)]">
                      <Badge tone={record.kind === "major" ? "warning" : "neutral"}>{record.kind}</Badge>
                      <Badge tone={record.scope === "dashboard" ? "warning" : "info"}>{BUMP_SCOPE_LABEL[record.scope]}</Badge>
                      <span className={cn(dsText.nums, dsText.meta, "text-[color:var(--ds-fg)]")}>
                        {record.fromVersion} → {record.toVersion}
                      </span>
                      <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{record.at}</span>
                      <span className={cn(dsText.nums, dsText.micro, "ml-auto text-[color:var(--ds-fg-faint)]")}>
                        {record.commit} · {record.archivedRuns} archived
                      </span>
                    </div>
                    <p className={cn(dsText.body, "text-[color:var(--ds-fg)]")}>{record.what}</p>
                    <p className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>{record.why}</p>
                  </CardBody>
                </Card>
              ))}
            </div>
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}
