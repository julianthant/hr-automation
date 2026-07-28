import { useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpFromLine,
  Eye,
  Info,
  Lock,
  Pencil,
  ShieldAlert,
  Workflow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  Button,
  Chip,
  EmptyState,
  IconButton,
  MetaLine,
  PageHeader,
  Panel,
  PanelBody,
  PanelHeader,
  PanelToolbar,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SectionLabel,
  Select,
  StatusPill,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  dsClip,
  dsFocus,
  dsIcon,
  dsMotion,
  dsStatusText,
  dsText,
} from "./demo-ui";
import {
  EXPLORER_GRAPHS,
  NODE_KIND_LABEL,
  contractTotals,
  dryRunPosture,
  explorerRunOptions,
  graphFor,
  laneOf,
  overlayForRun,
  provenanceOfRow,
  recordedBeyondContract,
  recordedForContractRow,
  skippedAboveBoundary,
  systemsOf,
  type ExplorerContractRow,
  type ExplorerGraph,
  type ExplorerNode,
  type ExplorerOverlay,
  type OverlayNode,
  type OverlayRecorded,
  type OverlayState,
} from "./demo-explorer-wire";
import { allTopLevelRows } from "./demo-archive-wire";
import { effectiveStatus, fmtElapsed, type DemoRow } from "./demo-data";
import {
  buildWorkflowCategoryGroups,
  DEMO_WORKFLOWS,
  DEMO_WORKFLOW_LIST,
  fmtClock,
  fmtVersionTag,
  type DemoWorkflowRef,
} from "./demo-wire";

/**
 * DEV-ONLY — the EXPLORER: a workflow's descriptor graph with a run laid over
 * it. Read-only by ratification (Q14): there is no authoring mode, no node
 * creation, no DSL. Behaviour changes are code changes with a version bump.
 *
 * What the page is FOR — three questions no other surface answers:
 *
 *  1. **"What shape is this workflow?"** Every workflow in the registry serves
 *     a graph, so the page is about the product rather than about the two
 *     examples somebody wired into it first.
 *  2. **"Where does it write, and can I rehearse it?"** There are three
 *     answers and they are not degrees of each other — a boundary a dry run
 *     stops at, a write with NO rehearsal at all, and a workflow that changes
 *     no system of record. The third is served as a fact, never inferred from
 *     a line that did not get drawn.
 *  3. **"What did THIS run do on that graph?"** The overlay is derived from the
 *     row's own recorded steps and its data ledger, so a node's duration,
 *     attempts and the values it actually moved are the run's — and a node the
 *     run never reached says "not reached yet", which is a different sentence
 *     from "not on this run's path".
 *
 * The node panel is built around the CONTRACT, because that is the question an
 * operator has when they click a step: what does this read and write, and from
 * which system. Everything that was not an answer to a real question — the id
 * box, the separate editable box, the paragraph about data reuse — is either
 * folded into the contract table or lives behind the ⓘ.
 */

const OVERLAY_TONE: Record<OverlayState, { label: string; cls: string; dot: string }> = {
  done: { label: "done", cls: "text-[color:var(--ds-success-fg)]", dot: "bg-[var(--ds-success-fg)]" },
  current: { label: "running", cls: "text-[color:var(--ds-status-running-fg)]", dot: "bg-[var(--ds-status-running-fg)]" },
  waiting: { label: "waiting on you", cls: "text-[color:var(--ds-status-waiting-fg)]", dot: "bg-[var(--ds-status-waiting-fg)]" },
  failed: { label: "failed", cls: "text-[color:var(--ds-status-failed-fg)]", dot: "bg-[var(--ds-status-failed-fg)]" },
  skipped: { label: "off this path", cls: "text-[color:var(--ds-fg-faint)]", dot: "bg-[var(--ds-border-strong)]" },
  pending: { label: "not reached", cls: "text-[color:var(--ds-fg-faint)]", dot: "bg-[var(--ds-border-strong)]" },
  cancelled: { label: "cancelled", cls: "text-[color:var(--ds-fg-muted)]", dot: "bg-[var(--ds-border-strong)]" },
};

const ON_PATH: OverlayState[] = ["done", "current", "waiting", "failed", "cancelled"];

const KIND_TONE: Record<ExplorerNode["kind"], "neutral" | "info" | "warning" | "danger" | "success"> = {
  task: "neutral",
  branch: "neutral",
  gate: "warning",
  delegation: "info",
  fanout: "info",
  write: "danger",
  output: "success",
};

const DIR_INK = {
  read: "text-[color:var(--ds-read-fg)]",
  write: "text-[color:var(--ds-write-fg)]",
} as const;

const NO_RUN = "";

export function DemoExplorerPage({ onBack, onOpenSettings }: { onBack: () => void; onOpenSettings: () => void }) {
  // THREE PANELS: what you are looking at · its shape · one part of that shape
  // in detail. Grouped by each descriptor's own `category`, exactly like the
  // rail, so there is no second taxonomy to drift.
  const [workflowId, setWorkflowId] = useState(EXPLORER_GRAPHS[0].workflowId);
  const graph = graphFor(workflowId);

  // The run list is not a hand list — it is the corpus filtered to this graph's
  // own workflow, each entry carrying how much of THIS graph it covers.
  const runs = useMemo(() => (graph ? explorerRunOptions(graph, allTopLevelRows()) : []), [graph]);
  // `null` is "you have not chosen" and lands on the best-covered run, so the
  // page is useful the moment it opens. `NO_RUN` is the operator CHOOSING the
  // descriptor with nothing over it, which is a different thing and has to
  // survive being selected.
  const [runChoice, setRunChoice] = useState<string | null>(null);
  const run: DemoRow | undefined =
    runChoice === null ? runs[0]?.row : runs.find((option) => option.row.id === runChoice)?.row;
  const overlay = useMemo(() => (graph && run ? overlayForRun(graph, run) : null), [graph, run]);

  const [nodeId, setNodeId] = useState("");
  // Until the operator picks one, the panel opens on the node the run is
  // ACTUALLY sitting on — where it stopped, else the last node it got to. The
  // first node of the array is where a graph starts, not where the run is, and
  // on a fan-out graph it is a lane this run never entered.
  const node = graph ? (graph.nodes.find((n) => n.id === nodeId) ?? defaultNode(graph, overlay)) : undefined;
  const nodeOverlay = overlay?.nodes.find((n) => n.nodeId === node?.id);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Explorer"
        icon={<Workflow aria-hidden className={dsIcon.lg} />}
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
          <Button variant="ghost" size="sm" icon={<Eye aria-hidden className={dsIcon.md} />} onClick={onOpenSettings}>
            Version registry
          </Button>
        }
      />

      {/* The two thresholds are the same idea the detail region uses — the list
          splits off first because it is the cheapest column, and the node
          contract splits off second because it is the one that needs width for
          a table. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-[var(--ds-space-base)] p-[var(--ds-space-cozy)] min-[900px]:grid-cols-[minmax(0,232px)_minmax(0,1fr)] min-[1280px]:grid-cols-[minmax(0,232px)_minmax(0,1fr)_minmax(0,420px)]">
        <WorkflowListPanel
          selected={workflowId}
          onSelect={(id) => {
            setWorkflowId(id);
            // A new workflow is a new shape: the run and the node belonged to
            // the old one, so they are dropped rather than carried onto a graph
            // that has no such node. Both fall back to "the first one".
            setRunChoice(null);
            setNodeId("");
          }}
        />

        {!graph || !node ? (
          <Panel className="min-h-0 min-[1280px]:col-span-2">
            <PanelBody>
              <EmptyState
                icon={<Workflow aria-hidden className={dsIcon.lg} />}
                title="No descriptor graph is served for this workflow"
                description="It is listed rather than hidden — a list that silently omits a workflow teaches you the product has never heard of it."
              />
            </PanelBody>
          </Panel>
        ) : (
          <>
            <GraphPanel
              graph={graph}
              runs={runs}
              run={run}
              overlay={overlay}
              onSelectRun={setRunChoice}
              selectedNodeId={node.id}
              onSelectNode={setNodeId}
            />
            <NodeDetail graph={graph} node={node} overlay={nodeOverlay} runOverlay={overlay} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Which node the panel opens on before the operator picks one.
 *
 * With a run over the graph it is the node the run is on — `stoppedAtNodeId`
 * when it is waiting, failed, cancelled or running, else the last node it
 * reached. Without a run it is the graph's first node, because then the
 * question really is "what shape is this".
 */
export function defaultNode(graph: ExplorerGraph, overlay: ExplorerOverlay | null): ExplorerNode {
  if (!overlay) return graph.nodes[0];
  if (overlay.stoppedAtNodeId) {
    const stopped = graph.nodes.find((node) => node.id === overlay.stoppedAtNodeId);
    if (stopped) return stopped;
  }
  const reached = [...overlay.nodes].reverse().find((node) => ON_PATH.includes(node.state));
  return graph.nodes.find((node) => node.id === reached?.nodeId) ?? graph.nodes[0];
}

/* =========================================================================
 * PANEL ONE — the registry
 * ====================================================================== */

/**
 * Every workflow the registry serves, grouped by its OWN category.
 *
 * The grouping is `buildWorkflowCategoryGroups`, the same projection the rail
 * reads, so the Explorer cannot bin a workflow under a heading the product does
 * not use.
 *
 * **The two-character codes are gone.** They are the trace id's first
 * component and they mean something there; in a list whose every row already
 * carries the full unambiguous label, `se`/`ob`/`ec` was a column of noise in
 * the narrowest panel on the page.
 */
function WorkflowListPanel({
  selected,
  onSelect,
}: {
  selected: DemoWorkflowRef["id"];
  onSelect: (id: DemoWorkflowRef["id"]) => void;
}) {
  const groups = useMemo(() => buildWorkflowCategoryGroups(), []);
  const drawn = EXPLORER_GRAPHS.length;
  const total = DEMO_WORKFLOW_LIST.length;
  return (
    <Panel className="min-h-0">
      <PanelHeader title="Workflows" meta={drawn === total ? `${total}` : `${drawn} of ${total} drawn`} />
      <PanelBody>
        {groups.map((group) => (
          <div key={group.label} className="border-b border-[color:var(--ds-border-subtle)] last:border-b-0">
            <SectionLabel className="block px-[var(--ds-space-cozy)] py-[var(--ds-space-snug)]">
              {group.label}
            </SectionLabel>
            <ul>
              {group.workflows.map((workflow) => {
                const graph = graphFor(workflow.id);
                const active = workflow.id === selected;
                return (
                  <li key={workflow.id}>
                    <button
                      type="button"
                      disabled={!graph}
                      aria-current={active ? "true" : undefined}
                      onClick={() => onSelect(workflow.id)}
                      title={
                        graph
                          ? `${workflow.label} ${fmtVersionTag({ major: graph.version, minor: graph.minorVersion })} — ${graph.nodes.length} nodes`
                          : `${workflow.label} serves no descriptor graph yet, so there is nothing to draw.`
                      }
                      className={cn(
                        "flex w-full min-w-0 items-center gap-[var(--ds-space-snug)] px-[var(--ds-space-cozy)] py-[var(--ds-space-snug)] text-left",
                        dsText.ui,
                        dsFocus,
                        dsMotion.base,
                        graph ? "cursor-pointer" : "cursor-default",
                        active
                          ? "bg-[var(--ds-surface-selected)] font-semibold text-[color:var(--ds-fg)]"
                          : graph
                            ? "text-[color:var(--ds-fg-secondary)] hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]"
                            : "text-[color:var(--ds-fg-faint)]",
                      )}
                    >
                      <span className={cn("min-w-0 flex-1", dsClip.text)}>{workflow.label}</span>
                      <span
                        className={cn(
                          dsText.micro,
                          dsText.nums,
                          "shrink-0",
                          graph ? "text-[color:var(--ds-fg-muted)]" : "text-[color:var(--ds-fg-faint)]",
                        )}
                      >
                        {graph ? graph.nodes.length : "—"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </PanelBody>
    </Panel>
  );
}

/* =========================================================================
 * PANEL TWO — the graph, with a run laid over it
 * ====================================================================== */

/**
 * The run overlay was KEPT, and rebuilt.
 *
 * It was a row of seven chips truncated to `Victor Ama…`, with nothing saying
 * what picking one did — which is a fair thing for an operator to ask about. It
 * survives because laying a real run over the descriptor is the one thing this
 * page can do that no other surface can, and because the failure was the
 * control, not the idea. What replaced it:
 *
 *  - a real **select**, one line, each option naming the run, what it ended as
 *    and when — plus a `Descriptor only` option, because reading the shape
 *    without a run over it is a legitimate thing to want;
 *  - the overlaid run stated **once** beside it — status, coverage, and the
 *    node it stopped on;
 *  - a graph that shows the PATH: which nodes it reached, which it skipped,
 *    where it stopped, and — in the node panel — the values it actually moved.
 */
function GraphPanel({
  graph,
  runs,
  run,
  overlay,
  onSelectRun,
  selectedNodeId,
  onSelectNode,
}: {
  graph: ExplorerGraph;
  runs: ReturnType<typeof explorerRunOptions>;
  run?: DemoRow;
  overlay: ExplorerOverlay | null;
  onSelectRun: (id: string) => void;
  selectedNodeId: string;
  onSelectNode: (id: string) => void;
}) {
  const posture = dryRunPosture(graph);
  const totals = contractTotals(graph);
  // A dry run skips a SET of nodes, not a suffix. The ones above the line get
  // their own mark, because the line alone would claim they run.
  const earlySkips = skippedAboveBoundary(graph);
  let lane = "";

  return (
    <Panel className="min-h-0">
      <PanelHeader
        title={`${graph.label} ${fmtVersionTag({ major: graph.version, minor: graph.minorVersion })}`}
        meta={[
          `${graph.nodes.length} nodes`,
          `${totals.reads} read`,
          totals.writes > 0 ? `${totals.writes} write` : undefined,
          totals.files > 0 ? `${totals.files} file` : undefined,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={<GraphInfo graph={graph} posture={posture} />}
      />

      <PanelToolbar label="Lay a run over the graph">
        <span className={cn(dsText.meta, "shrink-0 text-[color:var(--ds-fg-muted)]")}>Run</span>
        {/* The width lives on the WRAPPER, not on the `<select>`: the primitive's
            own shell is `flex min-w-0`, so a width set on the control alone
            overflows a shell that is free to shrink — and the pill beside it
            ends up sitting on top of the run's name. */}
        <span className="w-[36ch] shrink-0">
          <Select
            aria-label="Run to lay over the graph"
            value={run ? run.id : NO_RUN}
            disabled={runs.length === 0}
            onChange={(event) => onSelectRun(event.target.value)}
            className="w-full"
          >
            {runs.length === 0 ? (
              <option value={NO_RUN}>No run in the corpus</option>
            ) : (
              <>
                <option value={NO_RUN}>Descriptor only — no run</option>
                {runs.map((option) => (
                  <option key={option.row.id} value={option.row.id}>
                    {runOptionLabel(option)}
                  </option>
                ))}
              </>
            )}
          </Select>
        </span>
        {run && overlay && (
          <>
            <StatusPill status={effectiveStatus(run)} size="sm" />
            {/* The trace id, and nothing else. Coverage is already in the
                option the operator is reading, and WHERE the run stopped is on
                the graph three inches below — both restated here would only be
                a bar that truncates the one fact nothing else carries. */}
            <MetaLine className="min-w-0 shrink truncate" items={[overlay.traceId]} />
            {run.dryRun && <Chip tone="info">dry run</Chip>}
          </>
        )}
      </PanelToolbar>

      <PanelBody className="flex flex-col gap-[var(--ds-space-cozy)] p-[var(--ds-space-cozy)]">
        {/* A HAZARD, not teaching: this workflow changes a system of record and
            has no rehearsal, so there is no safe way to try it. */}
        {posture === "no-rehearsal" && (
          <Banner
            tone="warning"
            title={`${graph.label} writes to ${writeSystems(graph)} and honours no dry run — there is no rehearsal of this workflow.`}
          />
        )}

        {/* A FACT about this graph. The absence of a boundary line has to be
            readable as an answer rather than as a rendering that did not
            happen. */}
        {posture === "no-system-write" && (
          <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-snug)]">
            <Chip label="changes">no system of record</Chip>
            <Chip label="dry run">nothing to stop short of</Chip>
          </div>
        )}

        {run && overlay && run.workflowVersion !== graph.version && (
          <Banner
            tone="warning"
            title={`This run ran under ${fmtVersionTag({ major: run.workflowVersion, minor: run.workflowMinorVersion })}; the graph is ${fmtVersionTag({ major: graph.version, minor: graph.minorVersion })} — nodes that do not line up are the version difference, not a missing step.`}
          />
        )}

        <ol className="flex flex-col">
          {graph.nodes.map((graphNode, index) => {
            const state = overlay?.nodes.find((n) => n.nodeId === graphNode.id);
            const boundaryStartsHere = graph.dryRunBoundaryNodeId === graphNode.id;
            const nodeLane = laneOf(graphNode);
            const laneStartsHere = nodeLane !== lane;
            lane = nodeLane;
            return (
              <li key={graphNode.id} className="flex flex-col">
                {laneStartsHere && nodeLane !== "" && <LaneDivider label={nodeLane} first={index === 0} />}
                {boundaryStartsHere && <DryRunBoundary />}
                <GraphNodeRow
                  node={graphNode}
                  overlay={state}
                  hasRun={Boolean(overlay)}
                  earlySkip={earlySkips.includes(graphNode.id)}
                  selected={graphNode.id === selectedNodeId}
                  onSelect={() => onSelectNode(graphNode.id)}
                />
                {index < graph.nodes.length - 1 && laneOf(graph.nodes[index + 1]) === nodeLane && (
                  <Connector graph={graph} fromId={graphNode.id} />
                )}
              </li>
            );
          })}
        </ol>
      </PanelBody>
    </Panel>
  );
}

/**
 * `Maria Lopez-Garcia · Waiting on you · 5/7 · 2:02 PM` — a selectable line,
 * not a truncated chip.
 *
 * The status word is `dsStatusText`, the SAME label the pill beside it renders.
 * Reaching for the raw key instead put `doneWarnings` in a control an operator
 * reads — the one place a status vocabulary must never leak.
 */
export function runOptionLabel(option: { row: DemoRow; reached: number; total: number; offGraph: boolean }): string {
  const name = option.row.displayName ?? option.row.title;
  const when = option.row.startedAt ? fmtClock(option.row.startedAt) : fmtClock(option.row.enqueuedAt);
  const shape = option.offGraph ? "off this shape" : `${option.reached}/${option.total}`;
  return `${name} · ${dsStatusText(effectiveStatus(option.row))} · ${shape} · ${when}`;
}

function writeSystems(graph: ExplorerGraph): string {
  const systems = graph.nodes
    .filter((node) => node.kind === "write")
    .flatMap((node) => node.contract.filter((row) => row.dir === "write").map((row) => row.system));
  return [...new Set(systems)].join(", ") || "a system of record";
}

function LaneDivider({ label, first }: { label: string; first: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-[var(--ds-space-snug)]",
        first ? "pb-[var(--ds-space-snug)]" : "pb-[var(--ds-space-snug)] pt-[var(--ds-space-loose)]",
      )}
    >
      <SectionLabel>{label}</SectionLabel>
      <span aria-hidden className="h-px flex-1 bg-[var(--ds-border-subtle)]" />
    </div>
  );
}

function DryRunBoundary() {
  return (
    <div className="my-[var(--ds-space-snug)] flex items-center gap-[var(--ds-space-snug)]">
      <span aria-hidden className="h-px flex-1 border-t border-dashed border-[color:var(--ds-danger-border)]" />
      <span className={cn(dsText.caps, "flex items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-danger)]")}>
        <ShieldAlert aria-hidden className={dsIcon.sm} />
        a dry run stops here
      </span>
      <span aria-hidden className="h-px flex-1 border-t border-dashed border-[color:var(--ds-danger-border)]" />
    </div>
  );
}

function Connector({ graph, fromId }: { graph: ExplorerGraph; fromId: string }) {
  const conditional = graph.edges.filter((edge) => edge.from === fromId && edge.condition);
  return (
    <div className="ml-[18px] flex flex-col gap-[var(--ds-space-hair)] border-l border-[color:var(--ds-border-strong)] py-[var(--ds-space-tight)] pl-[var(--ds-space-cozy)]">
      {conditional.length === 0 ? (
        <span className={cn(dsText.micro, "text-[color:var(--ds-fg-faint)]")}>always</span>
      ) : (
        conditional.map((edge) => (
          <span key={`${edge.from}-${edge.to}`} className={cn(dsText.micro, "text-[color:var(--ds-fg-muted)]")}>
            → {edge.to}: <span className="text-[color:var(--ds-fg-faint)]">{edge.condition}</span>
          </span>
        ))
      )}
    </div>
  );
}

function GraphNodeRow({
  node,
  overlay,
  hasRun,
  earlySkip,
  selected,
  onSelect,
}: {
  node: ExplorerNode;
  overlay?: OverlayNode;
  hasRun: boolean;
  /** a dry run skips this node even though it sits above the boundary line */
  earlySkip: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const state = overlay?.state ?? "pending";
  const tone = OVERLAY_TONE[state];
  const onPath = ON_PATH.includes(state);
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 items-start gap-[var(--ds-space-base)] rounded-[var(--ds-radius-md)] border p-[var(--ds-space-base)] text-left",
        dsFocus,
        dsMotion.base,
        selected
          ? "border-[color:var(--ds-border-loud)] bg-[var(--ds-surface-selected)]"
          : "border-[color:var(--ds-border)] bg-[var(--ds-surface-1)] hover:bg-[var(--ds-surface-2)]",
        // The run's path, drawn on the row itself: a node it reached keeps the
        // full ink, a node it did not recedes. Never colour alone — the state
        // word on the right says the same thing.
        hasRun && !onPath && "border-dashed",
      )}
    >
      <span
        aria-hidden
        className={cn("mt-1 size-2 shrink-0 rounded-full", onPath || !hasRun ? tone.dot : "bg-transparent ring-1 ring-[var(--ds-border-strong)]")}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-[var(--ds-space-hair)]">
        <span className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-snug)]">
          <span
            className={cn(
              dsText.ui,
              "font-semibold",
              hasRun && !onPath ? "text-[color:var(--ds-fg-muted)]" : "text-[color:var(--ds-fg)]",
            )}
          >
            {node.id}
          </span>
          <Badge tone={KIND_TONE[node.kind]}>{NODE_KIND_LABEL[node.kind]}</Badge>
          {node.system && <Chip label="system">{node.system}</Chip>}
          {node.delegatesTo && (
            <Chip tone="info" label="to">
              {DEMO_WORKFLOWS[node.delegatesTo].label}
            </Chip>
          )}
          {earlySkip && <Chip tone="danger">a dry run skips this</Chip>}
          {hasRun && <span className={cn(dsText.meta, "ml-auto shrink-0", tone.cls)}>{tone.label}</span>}
        </span>
        {node.when && <span className={cn(dsText.micro, "text-[color:var(--ds-fg-muted)]")}>runs when {node.when}</span>}
        <span className="flex flex-wrap items-center gap-[var(--ds-space-snug)]">
          {overlay?.durationSec !== undefined && (
            <span className={cn(dsText.micro, dsText.nums, "text-[color:var(--ds-fg-muted)]")}>
              {fmtElapsed(overlay.durationSec)}
            </span>
          )}
          {overlay?.attempts !== undefined && overlay.attempts > 1 && (
            <span className={cn(dsText.micro, dsText.nums, "text-[color:var(--ds-status-waiting-fg)]")}>
              {overlay.attempts} attempts
            </span>
          )}
          {overlay && overlay.recorded.length > 0 && (
            <span className={cn(dsText.micro, dsText.nums, "text-[color:var(--ds-fg-muted)]")}>
              {overlay.recorded.length === 1 ? "1 value" : `${overlay.recorded.length} values`}
            </span>
          )}
          {overlay?.hasEvidence && (
            <span className={cn(dsText.micro, "text-[color:var(--ds-fg-muted)]")}>evidence captured</span>
          )}
          {overlay?.skippedBecause && (
            <span className={cn(dsText.micro, "text-[color:var(--ds-fg-faint)]")}>{overlay.skippedBecause}</span>
          )}
        </span>
        {overlay?.childNote && <span className={cn(dsText.micro, "text-[color:var(--ds-info-fg)]")}>{overlay.childNote}</span>}
      </span>
    </button>
  );
}

/* =========================================================================
 * PANEL THREE — the node's contract
 * ====================================================================== */

/**
 * The node panel, rebuilt around the ONE question an operator has when they
 * click a step: *what does this read and write, and from where*.
 *
 * The contract is the spine. What used to sit around it and does not any more:
 *
 *  - the **prose sentence** describing the node — it is the descriptor's own
 *    words about the node, not a fact about the run in front of you, so it
 *    moved into the ⓘ;
 *  - the **`UI IDS` box** — semantic ids are developer detail an operator never
 *    types. Also the ⓘ;
 *  - the **`EDITABLE AT A CHECKPOINT` box** — editability is a property of a
 *    FIELD, so it is a mark on the field's own row;
 *  - the **`DATA REUSE ON THIS RUN` block and its paragraph** — "was this value
 *    read live or replayed" is a real question with real consequences, so it
 *    survives as a mark on the rows it is true of plus one meta line, not as a
 *    card with an explanation in it;
 *  - the two **banners** — "this node writes" and "this node delegates" are
 *    facts, and a fact is a chip.
 *
 * What was ADDED is the half that makes the contract worth being the spine: the
 * value the run actually recorded for each row, joined off the row's own data
 * ledger. The descriptor promises `Last day worked` out of Kuali; the run says
 * it was `07/15/2026`. One table now holds both.
 */
function NodeDetail({
  graph,
  node,
  overlay,
  runOverlay,
}: {
  graph: ExplorerGraph;
  node: ExplorerNode;
  overlay?: OverlayNode;
  runOverlay: ExplorerOverlay | null;
}) {
  const tone = OVERLAY_TONE[overlay?.state ?? "pending"];
  const recorded = overlay?.recorded ?? [];
  const reads = node.contract.filter((row) => row.dir === "read");
  const writes = node.contract.filter((row) => row.dir === "write");
  const extraReads = recordedBeyondContract(recorded, node.contract).filter((entry) => entry.dir === "read");
  const extraWrites = recordedBeyondContract(recorded, node.contract).filter((entry) => entry.dir === "write");
  const hasContract = node.contract.length > 0 || recorded.length > 0;

  return (
    <Panel className="min-h-0">
      <PanelHeader
        title={node.id}
        meta={overlay ? <span className={tone.cls}>{tone.label}</span> : undefined}
        actions={<NodeInfo graph={graph} node={node} />}
      />
      <PanelBody className="flex flex-col gap-[var(--ds-space-cozy)] p-[var(--ds-space-cozy)]">
        {/* Facts about the node, as chips. Each of these used to be a banner or
            a card of its own. */}
        <div className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-snug)]">
          <Badge tone={KIND_TONE[node.kind]}>{NODE_KIND_LABEL[node.kind]}</Badge>
          {node.system && <Chip label="system">{node.system}</Chip>}
          {node.delegatesTo && (
            <Chip tone="info" label="delegates to">
              {DEMO_WORKFLOWS[node.delegatesTo].label}
            </Chip>
          )}
          {node.kind === "write" && <Chip tone="danger">changes a system of record</Chip>}
          {node.skippedInDryRun && <Chip tone="info">a dry run skips this</Chip>}
        </div>
        {node.when && (
          <MetaLine items={[`runs when ${node.when}`]} />
        )}

        {hasContract ? (
          <Table label={`${node.id} contract`} layout="fixed">
            <colgroup>
              <col className="w-[44%]" />
              <col className="w-[20%]" />
              <col />
            </colgroup>
            <THead>
              <TR>
                <TH>Field</TH>
                <TH>System</TH>
                <TH>Recorded</TH>
              </TR>
            </THead>
            <TBody>
              {(reads.length > 0 || extraReads.length > 0) && <DirHeaderRow dir="read" />}
              {reads.map((row) => (
                <ContractRow
                  key={`r-${row.field}`}
                  row={row}
                  recorded={recordedForContractRow(recorded, row)}
                  provenance={provenanceOfRow(runOverlay?.provenance, row)}
                />
              ))}
              {extraReads.map((entry) => (
                <RecordedOnlyRow key={`xr-${entry.field}`} entry={entry} />
              ))}
              {(writes.length > 0 || extraWrites.length > 0) && <DirHeaderRow dir="write" />}
              {writes.map((row) => (
                <ContractRow
                  key={`w-${row.field}`}
                  row={row}
                  recorded={recordedForContractRow(recorded, row)}
                  provenance={provenanceOfRow(runOverlay?.provenance, row)}
                />
              ))}
              {extraWrites.map((entry) => (
                <RecordedOnlyRow key={`xw-${entry.field}`} entry={entry} />
              ))}
            </TBody>
          </Table>
        ) : (
          <MetaLine tone="faint" items={["no value moves here"]} />
        )}

        {/* Provenance as a FACT, not a paragraph. It only prints when this run
            replayed or corrected something — an attempt that read everything
            live has nothing to say here and says nothing. */}
        {runOverlay && (runOverlay.provenance.replayed.length > 0 || runOverlay.provenance.corrected.length > 0) && (
          <MetaLine
            items={[
              `attempt ${runOverlay.provenance.attempt}`,
              runOverlay.provenance.replayed.length > 0
                ? `${runOverlay.provenance.replayed.length} replayed from a checkpoint`
                : undefined,
              runOverlay.provenance.corrected.length > 0
                ? `${runOverlay.provenance.corrected.length} corrected by you`
                : undefined,
            ]}
          />
        )}

        {/* The heading is the run's NAME. It used to be
            `WHAT THIS RUN RECORDED HERE — MARIA LOPEZ-GARCIA`, which announced
            in caps what the two lines under it already said. */}
        {overlay?.keyLines && overlay.keyLines.length > 0 && runOverlay && (
          <div className="flex min-w-0 flex-col gap-[var(--ds-space-tight)]">
            <span className={cn(dsText.ui, dsClip.text, "font-semibold text-[color:var(--ds-fg)]")}>
              {runOverlay.title}
            </span>
            {overlay.keyLines.map((line) => (
              <span key={line} className={cn(dsText.body, dsText.nums, "text-[color:var(--ds-fg-secondary)]")}>
                {line}
              </span>
            ))}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

/** the read / write band inside the contract table — the direction axis, once */
function DirHeaderRow({ dir }: { dir: "read" | "write" }) {
  const Icon = dir === "read" ? ArrowDownToLine : ArrowUpFromLine;
  return (
    <TR className="h-auto">
      <TD colSpan={3} className="bg-[var(--ds-surface-2)] py-[var(--ds-space-tight)]">
        <span className={cn(dsText.caps, "flex items-center gap-[var(--ds-space-tight)]", DIR_INK[dir])}>
          <Icon aria-hidden className={dsIcon.sm} />
          {dir === "read" ? "Reads" : "Writes"}
        </span>
      </TD>
    </TR>
  );
}

function ContractRow({
  row,
  recorded,
  provenance,
}: {
  row: ExplorerContractRow;
  recorded?: OverlayRecorded;
  provenance?: "replayed" | "corrected";
}) {
  return (
    <TR className="h-auto align-top">
      <TD className="py-[var(--ds-space-snug)]">
        <span className="flex min-w-0 items-center gap-[var(--ds-space-tight)]">
          <span className={cn(dsText.body, dsClip.text, "text-[color:var(--ds-fg)]")}>{row.field}</span>
          {row.editable && (
            <Pencil
              aria-label="correctable at a checkpoint"
              className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-muted)]")}
            />
          )}
        </span>
        {row.when && (
          <span className={cn(dsText.micro, "block text-[color:var(--ds-fg-faint)]")}>only when {row.when}</span>
        )}
      </TD>
      <TD className="py-[var(--ds-space-snug)]">
        <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{row.system}</span>
      </TD>
      <TD className="py-[var(--ds-space-snug)]">
        <RecordedCell row={row} recorded={recorded} provenance={provenance} />
      </TD>
    </TR>
  );
}

function RecordedCell({
  row,
  recorded,
  provenance,
}: {
  row: ExplorerContractRow;
  recorded?: OverlayRecorded;
  provenance?: "replayed" | "corrected";
}) {
  return (
    <span className="flex min-w-0 flex-col gap-[var(--ds-space-hair)]">
      <span className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-tight)]">
        {recorded ? (
          <span
            className={cn(dsText.body, dsText.nums, dsClip.text, "text-[color:var(--ds-fg)]")}
            title={recorded.value}
          >
            {recorded.value}
          </span>
        ) : (
          <span className={cn(dsText.body, "text-[color:var(--ds-fg-faint)]")}>—</span>
        )}
        {/* Nothing may claim an outcome it did not achieve: a staged value was
            filled and not submitted, an unconfirmed one was submitted and never
            read back. Both are the difference between a safe retry and a
            duplicate. */}
        {recorded?.staged && <Chip tone="warning">staged</Chip>}
        {recorded?.unconfirmed && <Chip tone="warning">not read back</Chip>}
        {provenance === "replayed" && <Chip tone="warning">replayed</Chip>}
        {provenance === "corrected" && <Chip tone="info">corrected</Chip>}
      </span>
      {row.proof && (
        <span className={cn(dsText.micro, "text-[color:var(--ds-fg-faint)]")}>proved by {row.proof}</span>
      )}
    </span>
  );
}

/**
 * A value the run recorded that the descriptor does not list. It is shown
 * rather than dropped — a ledger the panel silently filtered would be a panel
 * that can hide a write — and its field reads muted, because the contract did
 * not promise it.
 */
function RecordedOnlyRow({ entry }: { entry: OverlayRecorded }) {
  return (
    <TR className="h-auto align-top">
      <TD className="py-[var(--ds-space-snug)]">
        <span className={cn(dsText.body, dsClip.text, "block text-[color:var(--ds-fg-muted)]")}>{entry.field}</span>
      </TD>
      <TD className="py-[var(--ds-space-snug)]">
        <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{entry.system}</span>
      </TD>
      <TD className="py-[var(--ds-space-snug)]">
        <span className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-tight)]">
          <span className={cn(dsText.body, dsText.nums, dsClip.text, "text-[color:var(--ds-fg)]")} title={entry.value}>
            {entry.value}
          </span>
          {entry.staged && <Chip tone="warning">staged</Chip>}
          {entry.unconfirmed && <Chip tone="warning">not read back</Chip>}
        </span>
      </TD>
    </TR>
  );
}

/* =========================================================================
 * The ⓘs — where everything this page has to TEACH lives
 * ====================================================================== */

const POSTURE_NOTE: Record<ReturnType<typeof dryRunPosture>, string> = {
  boundary:
    "A dry run executes every node above the dashed line and stops there. That line, not gated access, is the whole safety boundary of a rehearsal.",
  "no-rehearsal":
    "This workflow changes a system of record and honours no dry run, so there is no way to rehearse it. Every start of it is the real thing.",
  "no-system-write":
    "This workflow changes no system of record, so it has no dry-run boundary — every run of it is already a rehearsal. Anything it writes lands in a file, not in an HR record.",
};

function GraphInfo({ graph, posture }: { graph: ExplorerGraph; posture: ReturnType<typeof dryRunPosture> }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          size="xs"
          label={`What is this graph? — ${graph.label}`}
          icon={<Info aria-hidden className={dsIcon.sm} />}
          className="text-[color:var(--ds-fg-faint)] hover:text-[color:var(--ds-fg)] data-[state=open]:text-[color:var(--ds-fg)]"
        />
      </PopoverTrigger>
      <PopoverContent title={graph.label} side="bottom" align="end" width="lg">
        <div className="flex flex-col gap-[var(--ds-space-base)]">
          <p className={cn(dsText.body, "leading-relaxed text-[color:var(--ds-fg)]")}>{graph.summary}</p>
          <p className={cn(dsText.body, "leading-relaxed text-[color:var(--ds-fg-secondary)]")}>{POSTURE_NOTE[posture]}</p>
          <p
            className={cn(
              dsText.body,
              "border-l pl-[var(--ds-space-base)] leading-relaxed",
              "border-[color:var(--ds-border-loud)] text-[color:var(--ds-fg-secondary)]",
            )}
          >
            The graph is the descriptor; the overlay is one run&apos;s own recorded steps. Neither is editable here —
            read-only was ratified first, and an authoring surface would have to bump a version to mean anything.
          </p>
          <MetaLine
            tone="faint"
            items={[
              fmtVersionTag({ major: graph.version, minor: graph.minorVersion }),
              `${graph.nodes.length} nodes`,
              `${graph.edges.length} edges`,
              systemsOf(graph).join(", ") || "no system",
            ]}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NodeInfo({ graph, node }: { graph: ExplorerGraph; node: ExplorerNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          size="xs"
          label={`What is this node? — ${node.id}`}
          icon={<Info aria-hidden className={dsIcon.sm} />}
          className="text-[color:var(--ds-fg-faint)] hover:text-[color:var(--ds-fg)] data-[state=open]:text-[color:var(--ds-fg)]"
        />
      </PopoverTrigger>
      <PopoverContent title={node.id} side="bottom" align="end" width="lg">
        <div className="flex flex-col gap-[var(--ds-space-base)]">
          <p className={cn(dsText.body, "leading-relaxed text-[color:var(--ds-fg)]")}>{node.purpose}</p>
          {node.delegatesTo && (
            <p className={cn(dsText.body, "leading-relaxed text-[color:var(--ds-fg-secondary)]")}>
              The child keeps its own Queue Row in its own panel and is linked from here — it is never nested under this
              run, and it is never counted twice.
            </p>
          )}
          {node.kind === "write" && (
            <p className={cn(dsText.body, "leading-relaxed text-[color:var(--ds-fg-secondary)]")}>
              {node.skippedInDryRun
                ? `A dry run of ${graph.label} does not execute this node.`
                : `A dry run of ${graph.label} executes this node too — it is a real write on a rehearsal.`}
            </p>
          )}
          <p className={cn(dsText.body, "leading-relaxed text-[color:var(--ds-fg-secondary)]")}>
            A pencil on a field means the descriptor allows you to correct it at a checkpoint. Identity, input,
            idempotency, proof and provenance are structurally read-only and carry none.
          </p>
          {node.uiIds.length > 0 && (
            <div className="flex flex-col gap-[var(--ds-space-hair)]">
              <SectionLabel>UI ids</SectionLabel>
              {node.uiIds.map((id) => (
                <span key={id} className={cn(dsText.meta, dsText.nums, dsClip.text, "text-[color:var(--ds-fg-secondary)]")}>
                  {id}
                </span>
              ))}
              <span className={cn(dsText.micro, "text-[color:var(--ds-fg-faint)]")}>
                Semantic ids, never raw selectors — a selector in a descriptor breaks every time a page moves a div.
              </span>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
