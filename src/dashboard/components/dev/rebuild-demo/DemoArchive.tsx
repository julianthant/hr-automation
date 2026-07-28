import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AppWindow,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  ArrowUpRight,
  Archive,
  BadgeCheck,
  Camera,
  Download,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  ImageOff,
  Info,
  Lock,
  RotateCw,
  TriangleAlert,
  Workflow,
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
  dsRadius,
  dsText,
  useToasts,
} from "./demo-ui";
import {
  ARCHIVE_SORT_LABEL,
  BUMP_KIND_LABEL,
  BUMP_SCOPE_LABEL,
  DEMO_ARCHIVE,
  DEMO_CHANGE_RECORDS,
  EMPTY_ARCHIVE_QUERY,
  allTopLevelRows,
  archiveQueryIsFiltered,
  archivedCapture,
  archivedRunExportName,
  archivedRunTouchedTest,
  archivedVersionTag,
  changeRecordFor,
  bumpTargetLabel,
  deriveRelaunchPlan,
  deriveVersionRegistry,
  exportArchivedRunJson,
  flattenArchiveTable,
  groupArchiveByBump,
  queryArchive,
  relaunchFromArchive,
  type ArchiveQuery,
  type ArchiveSortDir,
  type ArchiveSortKey,
  type ArchiveTableItem,
  type ArchivedEvidenceWire,
  type ArchivedRunWire,
  type RelaunchResult,
} from "./demo-archive-wire";
import { captureAspect, CaptureLightbox, downloadDemoFile } from "./DemoEvidence";
import { DEMO_WORKFLOWS, fmtClock, plural, workflowVersionTag } from "./demo-wire";
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

  // Sections are the BUMPS that swept these runs, derived after the sort so the
  // two controls stay independent, and collapsible so a sweep of 400 costs one
  // row until you ask for it.
  const sections = useMemo(() => groupArchiveByBump(visible), [visible]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const items = useMemo(() => flattenArchiveTable(sections, collapsed), [sections, collapsed]);

  const setQueryPart = useCallback(<K extends keyof ArchiveQuery>(key: K, value: ArchiveQuery[K]) => {
    setQuery((prev) => ({ ...prev, [key]: value }));
  }, []);

  /**
   * Pressing a column head sorts by it; pressing the ACTIVE one flips the
   * direction. Every column opens on the direction that puts its most useful
   * end first — newest, longest and loudest-status at the top; names and ids
   * from A.
   */
  const toggleSort = useCallback((key: ArchiveSortKey) => {
    setQuery((prev) => {
      if (prev.sort === key) return { ...prev, dir: prev.dir === "asc" ? "desc" : "asc" };
      const opensDescending: ArchiveSortKey[] = ["when", "duration"];
      const dir: ArchiveSortDir = opensDescending.includes(key) ? "desc" : "asc";
      return { ...prev, sort: key, dir };
    });
  }, []);

  const toggleSection = useCallback((bumpId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(bumpId)) next.delete(bumpId);
      else next.add(bumpId);
      return next;
    });
  }, []);

  const filtered = archiveQueryIsFiltered(query);

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
            className="inline-flex items-center gap-[var(--ds-space-hair)] rounded-[var(--ds-radius-md)] border border-[color:var(--ds-recess-border)] bg-[var(--ds-recess-bg)] p-[var(--ds-space-hair)]"
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
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-[var(--ds-space-base)] p-[var(--ds-space-cozy)] min-[1180px]:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
          {/* ---- the table ---- */}
          <Panel className="min-h-0">
            <PanelHeader
              title="Archived runs"
              meta={`${visible.length.toLocaleString()} of ${DEMO_ARCHIVE.length.toLocaleString()}`}
              actions={
                <Popover>
                  <PopoverTrigger asChild>
                    <IconButton
                      size="sm"
                      label="Retention"
                      icon={<Info aria-hidden className={dsIcon.md} />}
                      className="text-[color:var(--ds-fg-faint)] hover:text-[color:var(--ds-fg)] data-[state=open]:text-[color:var(--ds-fg)]"
                    />
                  </PopoverTrigger>
                  {/* The retention policy used to be a paragraph on the panel's
                      footer, under a list it is true of on every run and every
                      day. It is a rule of the product, so it lives here. */}
                  <PopoverContent title="Retention" width="lg" align="end">
                    <BulletList
                      items={[
                        "An archived row is kept indefinitely — it is the audit copy.",
                        "Its evidence images are kept 90 days from the run's end and then purged; a purged pointer still names what it was of.",
                        "The write ledger is never archived and never pruned, which is why a run here still lists what it filed.",
                      ]}
                    />
                  </PopoverContent>
                </Popover>
              }
            />

            {/* ONE toolbar row. Four dropdowns stacked 2×2 ate the top third of
                the panel on a page whose entire job is showing rows. It scrolls
                sideways rather than wrapping, because a fixed-height bar that
                wraps silently clips its second line. */}
            <PanelToolbar label="Find an archived run" className="gap-[var(--ds-space-snug)] overflow-x-auto">
              <SearchInput
                aria-label="Search archived runs by name, EID, trace id or confirmation number"
                placeholder="Name, EID, trace, confirmation…"
                value={query.text}
                onChange={(event) => setQueryPart("text", event.target.value)}
                onClear={() => setQueryPart("text", "")}
                className="min-w-[200px] flex-1"
              />
              <Select
                aria-label="Workflow"
                value={query.workflowId}
                onChange={(event) => setQueryPart("workflowId", event.target.value)}
                className="w-auto shrink-0"
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
                className="w-auto shrink-0"
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
                className="w-auto shrink-0"
              >
                <option value="all">Any instance</option>
                <option value="prod">Production only</option>
                <option value="test">Touched a test instance</option>
              </Select>
              {filtered && (
                <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setQuery(EMPTY_ARCHIVE_QUERY)}>
                  Clear
                </Button>
              )}
            </PanelToolbar>

            <ArchiveTable
              items={items}
              sections={sections}
              sort={query.sort}
              dir={query.dir}
              onSort={toggleSort}
              collapsed={collapsed}
              onToggleSection={toggleSection}
              selectedId={selected?.runId}
              onSelect={setSelectedId}
              filtered={filtered}
              onClearFilters={() => setQuery(EMPTY_ARCHIVE_QUERY)}
            />
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

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * THE ARCHIVE AS A TABLE, and it has to hold at eight rows and at eight hundred.
 *
 * What was here: a list of cards with a status pill of varying width in front of
 * every name, so no two names started at the same x; four filter dropdowns
 * stacked 2×2 eating the top third; bump banners interleaved into one flat
 * scroll; and a retention paragraph pinned under it all. At eight rows that is
 * merely untidy. At eight hundred it is unusable, and the corpus now holds eight
 * hundred.
 *
 * **VIRTUALISED, NOT PAGINATED**, and the reason is what the operator does here.
 * They arrive with a question — *did we ever file something for this person?* —
 * and the narrowing tool for that is the search and the three filters, which are
 * already on the bar. Pagination is a SECOND narrowing mechanism stacked on top
 * of those: it splits a result set that has already been narrowed, forces a
 * decision ("is it on page 4?") that no fact on screen can answer, and breaks
 * the one motion a dense console is for — running your eye down a column until
 * something stops it. It would also have to interact with the bump sections,
 * because a page boundary landing inside a sweep either repeats its header or
 * orphans its rows. A window keeps one continuous list, keeps the section
 * headers where they belong, and costs the same at 800 rows as at 80.
 *
 * The three mechanics that make it work:
 *
 *  - **`table-fixed` + a `<colgroup>`.** An `auto` table measures the rows it
 *    currently has mounted, so a windowed body re-computes its column widths on
 *    every scroll and the whole grid shivers. Fixed widths also mean the status,
 *    trace and duration columns land on the same x on every row — which is the
 *    complaint that started this.
 *  - **Spacer rows, not transforms.** The window is bracketed by two `<tr>`s
 *    with a computed height, so the table stays a real table: native semantics,
 *    a sticky `<thead>`, and no absolutely-positioned rows to fight.
 *  - **Sections in the same flat list.** A header is an item like a run is, so
 *    collapsing a sweep of 400 costs one item and the virtualiser never builds
 *    the rows.
 */
const ARCHIVE_ROW_PX = 32;
const ARCHIVE_SECTION_PX = 52;

function ArchiveTable({
  items,
  sections,
  sort,
  dir,
  onSort,
  collapsed,
  onToggleSection,
  selectedId,
  onSelect,
  filtered,
  onClearFilters,
}: {
  items: ArchiveTableItem[];
  sections: { bumpId: string; runs: ArchivedRunWire[] }[];
  sort: ArchiveSortKey;
  dir: ArchiveSortDir;
  onSort: (key: ArchiveSortKey) => void;
  collapsed: ReadonlySet<string>;
  onToggleSection: (bumpId: string) => void;
  selectedId?: string;
  onSelect: (runId: string) => void;
  filtered: boolean;
  onClearFilters: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (items[index].kind === "section" ? ARCHIVE_SECTION_PX : ARCHIVE_ROW_PX),
    overscan: 12,
  });

  const windowed = virtualizer.getVirtualItems();
  const before = windowed.length > 0 ? windowed[0].start : 0;
  const after = windowed.length > 0 ? virtualizer.getTotalSize() - windowed[windowed.length - 1].end : 0;

  // The head's LABEL and its sort key come from the same map, so a column
  // cannot come to be headed one thing and sort by another.
  const head = (key: ArchiveSortKey) => ({
    sort: sort === key ? (dir === "asc" ? ("ascending" as const) : ("descending" as const)) : ("none" as const),
    onSort: () => onSort(key),
    children: ARCHIVE_SORT_LABEL[key],
  });

  if (items.length === 0) {
    return (
      <PanelBody>
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
              <Button size="sm" variant="secondary" onClick={onClearFilters}>
                Clear the search and filters
              </Button>
            ) : undefined
          }
        />
      </PanelBody>
    );
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
      <Table label="Archived runs" layout="fixed" className="min-w-[720px]">
        {/* The measured column widths. Every one of these except the name is a
            value of known shape — a status word, a trace id, a version tag, a
            clock, a duration — so they are fixed and the name takes the slack.
            That is what puts every name on the same x. */}
        <colgroup>
          <col className="w-[var(--ds-w-archive-status)]" />
          <col />
          <col className="w-[var(--ds-w-archive-trace)]" />
          <col className="w-[var(--ds-w-archive-workflow)]" />
          <col className="w-[var(--ds-w-archive-when)]" />
          <col className="w-[var(--ds-w-archive-duration)]" />
        </colgroup>
        <THead>
          <TR>
            <TH {...head("status")} />
            <TH {...head("name")} />
            <TH {...head("trace")} />
            <TH {...head("workflow")} />
            <TH {...head("when")} />
            <TH align="right" {...head("duration")} />
          </TR>
        </THead>
        <TBody>
          {before > 0 && (
            <tr aria-hidden style={{ height: before }}>
              <td colSpan={6} />
            </tr>
          )}
          {windowed.map((virtual) => {
            const item = items[virtual.index];
            if (item.kind === "section") {
              const section = sections.find((s) => s.bumpId === item.bumpId);
              return (
                <BumpSectionRow
                  key={`section-${item.bumpId}`}
                  bumpId={item.bumpId}
                  count={item.count}
                  collapsed={collapsed.has(item.bumpId)}
                  onToggle={() => onToggleSection(item.bumpId)}
                  hidden={section === undefined}
                />
              );
            }
            return (
              <ArchiveRow
                key={item.run.runId}
                run={item.run}
                selected={item.run.runId === selectedId}
                onSelect={() => onSelect(item.run.runId)}
              />
            );
          })}
          {after > 0 && (
            <tr aria-hidden style={{ height: after }}>
              <td colSpan={6} />
            </tr>
          )}
        </TBody>
      </Table>
    </div>
  );
}

/**
 * One run, one row of six aligned cells.
 *
 * The whole `<tr>` is the click target and carries `aria-selected`; the name
 * cell holds the only real button, so a screen reader gets one command per row
 * rather than six. Dry-run and test-instance flags ride the name cell as icons
 * with their own labels — they are hazards, so they may not be columns that
 * scroll off, and they may not be hidden either.
 */
function ArchiveRow({ run, selected, onSelect }: { run: ArchivedRunWire; selected: boolean; onSelect: () => void }) {
  return (
    <TR interactive selected={selected} onClick={onSelect} className="cursor-pointer">
      <TD className="truncate">
        <StatusPill status={run.finalStatus} size="sm" hideIcon />
      </TD>
      <TD className="min-w-0">
        <span className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
            className={cn("min-w-0 flex-1 truncate text-left text-[color:var(--ds-fg)]", dsFocus)}
          >
            {run.displayName ?? run.title}
          </button>
          {run.dryRun && (
            <FlaskConical aria-label="dry run" className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-info-fg)]")} />
          )}
          {archivedRunTouchedTest(run) && (
            <TriangleAlert
              aria-label="touched a test instance"
              className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-status-waiting-fg)]")}
            />
          )}
        </span>
      </TD>
      <TD numeric className="truncate text-[color:var(--ds-fg-muted)]">
        {run.traceId}
      </TD>
      <TD className="truncate">
        <span className="flex min-w-0 items-baseline gap-[var(--ds-space-snug)]">
          <span className="min-w-0 truncate">{run.workflowLabel}</span>
          <span className={cn(dsText.micro, dsText.nums, "shrink-0 text-[color:var(--ds-fg-muted)]")}>
            {archivedVersionTag(run)}
          </span>
        </span>
      </TD>
      <TD numeric className="truncate text-[color:var(--ds-fg-muted)]">
        {run.endedAt}
      </TD>
      <TD align="right" numeric className="text-[color:var(--ds-fg-faint)]">
        {run.durationLabel}
      </TD>
    </TR>
  );
}

/**
 * A BUMP, as a collapsible section head — laid on the TABLE'S OWN COLUMNS.
 *
 * Operator: *"this bar is too crowded. you need to find somewhere else to put
 * those… label which workflow changed or if the app changed properly in an
 * aligned and organized manner between rows."*
 *
 * It was a flex row first, then a `colSpan={6}` cell holding a SECOND grid of
 * six hand-picked tracks. The second grid was self-consistent — every section
 * head lined up with every other — and it lined up with NOTHING in the table it
 * sat inside: its own padding, its own gaps and the ⓘ parked outside its
 * `flex-1` pushed the sweep's date 42px left of the `When` column it was
 * supposed to sit over. Two grids cannot be made to agree by choosing better
 * numbers; there is one grid now, and it is the table's `<colgroup>`.
 *
 * So the head is six real `<td>`s, and every fact went to the column it rhymes
 * with: the sweep's own id lands in the trace column, what it changed lands in
 * the workflow column, when it ran lands over the runs' own clocks, and how many
 * it swept lands right-aligned where their durations are. Change a `<col>` and
 * the head follows, because it has no widths of its own to keep in sync.
 *
 * THE DESCRIPTION IS IN THE ⓘ. It was the one variable-length thing in the row
 * and it was doing two jobs badly: crowding the facts out of the bar, and
 * repeating the version pair printed two tracks to its left. Both halves fixed
 * — the pair is gone from the sentence at the FIXTURE (see `demo-archive-wire`)
 * and the sentence itself, with the reasoning, the author, the commit and the
 * archived count, is one press away.
 *
 * When no change record matches the `bumpId` the gap is NAMED. This is the one
 * case where the archive loses the reason it exists, and it used to degrade to
 * a raw id in the slot a version pair belongs.
 *
 * The disclosure stays a real `<button>` in the first cell — a row is a row to
 * assistive tech, and turning it into one big `role="button"` would cost the
 * table its structure. Pointer users still press anywhere on the head; the ⓘ
 * stops the press so opening the record cannot collapse the section under it.
 */
function BumpSectionRow({
  bumpId,
  count,
  collapsed,
  onToggle,
  hidden,
}: {
  bumpId: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  hidden: boolean;
}) {
  const record = changeRecordFor(bumpId);
  if (hidden) return null;
  const target = record ? bumpTargetLabel(record) : undefined;
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const cell = "bg-[var(--ds-surface-2)] border-b border-[color:var(--ds-border)]";
  const summary = record
    ? `${record.fromVersion} to ${record.toVersion}, ${record.kind} bump${target ? ` — ${target.text}` : ""}, ${plural(count, "run")}`
    : `${bumpId} — change record missing, ${plural(count, "run")}`;

  return (
    <TR interactive onClick={onToggle} className={cn("h-auto", dsMotion.fast)}>
      <TD className={cn(cell, "align-middle")}>
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={(event) => {
            // the row already toggles; without this the press counts twice
            event.stopPropagation();
            onToggle();
          }}
          className={cn(
            "flex min-w-0 cursor-pointer items-center gap-[var(--ds-space-snug)] text-left",
            dsFocus,
            dsRadius.sm,
          )}
        >
          <Chevron aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
          <span className="sr-only">{summary}</span>
          {record ? (
            <Badge tone={record.kind === "major" ? "warning" : "neutral"} title={BUMP_KIND_LABEL[record.kind]}>
              {record.kind}
            </Badge>
          ) : (
            <span aria-hidden className={cn(dsText.meta, "text-[color:var(--ds-danger)]")}>
              no record
            </span>
          )}
        </button>
      </TD>

      {/* the NAME column — the sweep's own name is the version it moved to */}
      <TD className={cn(cell, "min-w-0")}>
        {record ? (
          <span className={cn(dsText.meta, dsText.nums, "block min-w-0 truncate font-semibold text-[color:var(--ds-fg)]")}>
            {record.fromVersion} → {record.toVersion}
          </span>
        ) : (
          <span className={cn(dsText.meta, "block min-w-0 truncate text-[color:var(--ds-danger)]")}>
            Change record missing
          </span>
        )}
      </TD>

      {/* the TRACE column — a sweep's id is an id, and it belongs where the ids are */}
      <TD numeric className={cn(cell, "truncate text-[color:var(--ds-fg-muted)]")}>
        {bumpId}
      </TD>

      {/* the WORKFLOW column — what changed, over the workflows it changed */}
      <TD className={cn(cell, "truncate")}>
        {target ? (
          <span
            className="flex min-w-0 items-center gap-[var(--ds-space-tight)]"
            title={record ? `${BUMP_SCOPE_LABEL[record.scope]} — ${target.full}` : undefined}
          >
            {target.appUpdate ? (
              <AppWindow aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
            ) : (
              <Workflow aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
            )}
            <span className="min-w-0 truncate text-[color:var(--ds-fg-secondary)]">{target.text}</span>
          </span>
        ) : null}
      </TD>

      {/* the WHEN column — a sweep's date directly over the dates it swept */}
      <TD numeric className={cn(cell, "truncate text-[color:var(--ds-fg-muted)]")}>
        {record?.at}
      </TD>

      {/* the DURATION column — how many runs this sweep took, and the record */}
      <TD align="right" className={cn(cell, "whitespace-nowrap")}>
        <span className="inline-flex items-center gap-[var(--ds-space-tight)]">
          <CountBadge value={count} />
          <Popover>
            <PopoverTrigger asChild>
              <IconButton
                size="xs"
                onClick={(event) => event.stopPropagation()}
                label={record ? `About this bump — ${record.fromVersion} → ${record.toVersion}` : `About ${bumpId}`}
                icon={<Info aria-hidden className={dsIcon.sm} />}
                className="shrink-0 data-[state=open]:bg-[var(--ds-surface-3)] data-[state=open]:text-[color:var(--ds-fg)]"
              />
            </PopoverTrigger>
            <PopoverContent
              title={record ? `${record.fromVersion} → ${record.toVersion}` : "Change record missing"}
              description={record ? BUMP_KIND_LABEL[record.kind] : undefined}
              width="lg"
              align="end"
            >
              {record && target ? (
                <div className="flex flex-col gap-[var(--ds-space-base)]">
                  <p className={cn(dsText.body, "text-[color:var(--ds-fg)]")}>{record.what}</p>
                  <p className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>{record.why}</p>
                  <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{target.full}</p>
                  <MetaLine items={[record.by, record.commit, record.at, `${plural(record.archivedRuns, "run")} archived`]} />
                </div>
              ) : (
                <p className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>
                  Swept by <span className={dsText.nums}>{bumpId}</span>, which the change-record store does not hold. The runs
                  are intact; what is missing is why they were archived.
                </p>
              )}
            </PopoverContent>
          </Popover>
        </span>
      </TD>
    </TR>
  );
}

// ---------------------------------------------------------------------------
// The detail
// ---------------------------------------------------------------------------// ---------------------------------------------------------------------------
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
        {/* The pointer's own SHAPE, at the shared thumbnail height — a portrait
            document page and a landscape browser viewport read as different
            things before either is opened, which is the one true thing a
            byte-less placeholder can offer. */}
        <span
          aria-hidden
          style={{ aspectRatio: captureAspect(archivedCapture(item)) }}
          className={cn(
            "flex h-[var(--ds-h-evidence-thumb)] shrink-0 items-center justify-center border bg-[var(--ds-surface-1)] rounded-[var(--ds-radius-sm)]",
            purged ? "border-dashed border-[color:var(--ds-border-strong)]" : "border-[color:var(--ds-border-subtle)]",
          )}
        >
          <Camera className={cn(dsIcon.md, "text-[color:var(--ds-fg-muted)]")} />
        </span>
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
            title={`This run already filed ${plural(plan.alreadyFiled.length, "record")} in a real system`}
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
                ? `${plural(blocked, "workflow")} ${blocked === 1 ? "has" : "have"} runs that are not terminal — a MAJOR bump on those is refused`
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
