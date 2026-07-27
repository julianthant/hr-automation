import { useMemo, useState } from "react";
import { ArrowLeft, Eye, Lock, ShieldAlert, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBase,
  CardBody,
  Chip,
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
  NODE_KIND_LABEL,
  overlayForRun,
  SEPARATIONS_GRAPH,
  type ExplorerNode,
  type OverlayNode,
  type OverlayState,
} from "./demo-explorer-wire";
import { allTopLevelRows } from "./demo-archive-wire";
import { effectiveStatus, fmtElapsed, type DemoRow } from "./demo-data";
import { DEMO_WORKFLOWS, fmtVersionTag } from "./demo-wire";

/**
 * DEV-ONLY — the EXPLORER: a workflow's descriptor graph with a run laid over
 * it. Read-only by ratification (Q14): there is no authoring mode, no node
 * creation, no DSL. Behaviour changes are code changes with a version bump.
 *
 * What the page is FOR: two questions the queue cannot answer.
 *
 *  1. **"Where does this workflow write?"** The dry-run boundary is drawn on
 *     the graph, and every node past it is marked. A dry run is safe precisely
 *     because it stops at that line — showing the line is how the operator
 *     learns to trust it.
 *  2. **"What did THIS run actually do on that graph?"** The overlay is derived
 *     from the row's own recorded steps, so a node's duration, attempt count and
 *     key log lines are the run's, and a node the run never reached says "not
 *     reached" rather than rendering as pending-and-fine.
 */

const OVERLAY_TONE: Record<OverlayState, { label: string; cls: string; dot: string }> = {
  done: { label: "done", cls: "text-[color:var(--ds-success-fg)]", dot: "bg-[var(--ds-success-fg)]" },
  current: { label: "running", cls: "text-[color:var(--ds-status-running-fg)]", dot: "bg-[var(--ds-status-running-fg)]" },
  waiting: { label: "waiting on you", cls: "text-[color:var(--ds-status-waiting-fg)]", dot: "bg-[var(--ds-status-waiting-fg)]" },
  failed: { label: "failed", cls: "text-[color:var(--ds-status-failed-fg)]", dot: "bg-[var(--ds-status-failed-fg)]" },
  skipped: { label: "skipped", cls: "text-[color:var(--ds-fg-faint)]", dot: "bg-[var(--ds-border-strong)]" },
  pending: { label: "not reached", cls: "text-[color:var(--ds-fg-faint)]", dot: "bg-[var(--ds-border-strong)]" },
  cancelled: { label: "cancelled", cls: "text-[color:var(--ds-fg-muted)]", dot: "bg-[var(--ds-border-strong)]" },
};

const KIND_TONE: Record<ExplorerNode["kind"], "neutral" | "info" | "warning" | "danger"> = {
  task: "neutral",
  gate: "warning",
  write: "danger",
  delegation: "info",
};

export function DemoExplorerPage({ onBack, onOpenSettings }: { onBack: () => void; onOpenSettings: () => void }) {
  const graph = SEPARATIONS_GRAPH;

  // Every real run of this workflow the tracker holds — the run selector is not
  // a hand list, it is the corpus filtered to the graph's own workflow.
  const runs = useMemo(
    () => allTopLevelRows().filter((row) => row.workflow.id === graph.workflowId && row.steps.length > 0),
    [graph.workflowId],
  );
  const [runId, setRunId] = useState(runs[0]?.id ?? "");
  const run: DemoRow | undefined = runs.find((r) => r.id === runId) ?? runs[0];
  const overlay = useMemo(() => (run ? overlayForRun(graph, run) : null), [graph, run]);
  const [nodeId, setNodeId] = useState(graph.nodes[0].id);
  const node = graph.nodes.find((n) => n.id === nodeId) ?? graph.nodes[0];
  const nodeOverlay = overlay?.nodes.find((n) => n.nodeId === nodeId);

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

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-[var(--ds-space-base)] p-[var(--ds-space-cozy)] min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        {/* ---- the graph, with the run over it ---- */}
        <Panel className="min-h-0">
          <PanelHeader
            title={`${graph.label} ${fmtVersionTag({ major: graph.version, minor: graph.minorVersion })}`}
            subtitle={graph.summary}
            meta={`${graph.nodes.length} nodes · ${graph.edges.length} edges`}
          />
          <PanelToolbar label="Choose a run to lay over the graph">
            <span className={cn(dsText.meta, "shrink-0 text-[color:var(--ds-fg-muted)]")}>Run overlay:</span>
            {runs.map((candidate) => (
              <Chip key={candidate.id} selected={candidate.id === run?.id} onSelect={() => setRunId(candidate.id)}>
                {candidate.displayName ?? candidate.title}
              </Chip>
            ))}
          </PanelToolbar>
          <PanelBody className="p-[var(--ds-space-cozy)]">
            {run && overlay ? (
              <>
                <div className="mb-[var(--ds-space-cozy)] flex min-w-0 flex-wrap items-center gap-[var(--ds-space-snug)]">
                  <StatusPill status={effectiveStatus(run)} size="sm" />
                  <span className={cn(dsText.meta, dsText.nums, "text-[color:var(--ds-fg-muted)]")}>{overlay.traceId}</span>
                  <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
                    ran under {run.workflow.label} {fmtVersionTag({ major: run.workflowVersion, minor: run.workflowMinorVersion })}
                  </span>
                  {run.dryRun && <Chip tone="info">dry run — stopped at the boundary</Chip>}
                </div>

                {run.workflowVersion !== graph.version && (
                  <Banner tone="warning" title={`This run ran under ${fmtVersionTag({ major: run.workflowVersion, minor: run.workflowMinorVersion })}; the graph is ${fmtVersionTag({ major: graph.version, minor: graph.minorVersion })}`} className="mb-[var(--ds-space-cozy)]">
                    Nodes that do not line up are the version difference, not a missing step. A run is only ever comparable with the
                    descriptor it executed — which is exactly why a version bump moves prior runs into the archive.
                  </Banner>
                )}

                <ol className="flex flex-col">
                  {graph.nodes.map((graphNode, index) => {
                    const state = overlay.nodes.find((n) => n.nodeId === graphNode.id);
                    const boundaryStartsHere = graph.dryRunBoundaryNodeId === graphNode.id;
                    return (
                      <li key={graphNode.id} className="flex flex-col">
                        {boundaryStartsHere && <DryRunBoundary />}
                        <GraphNodeRow
                          node={graphNode}
                          overlay={state}
                          selected={graphNode.id === nodeId}
                          onSelect={() => setNodeId(graphNode.id)}
                        />
                        {index < graph.nodes.length - 1 && <Connector graph={graph} fromId={graphNode.id} />}
                      </li>
                    );
                  })}
                </ol>
              </>
            ) : (
              <Well>
                <span className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>
                  No {graph.label} run in the corpus records steps, so there is nothing to lay over the graph.
                </span>
              </Well>
            )}
          </PanelBody>
          <PanelFooter>
            <span className={cn(dsText.meta, "max-w-[104ch] text-[color:var(--ds-fg-muted)]")}>
              The graph is the descriptor; the overlay is this run's own recorded steps. Neither is editable here — read-only was
              ratified first, and an authoring surface would have to bump a version to mean anything.
            </span>
          </PanelFooter>
        </Panel>

        {/* ---- the node's contract ---- */}
        <NodeDetail node={node} overlay={nodeOverlay} runTitle={overlay?.title} reuse={overlay?.reuse ?? []} />
      </div>
    </div>
  );
}

function DryRunBoundary() {
  return (
    <div className="my-[var(--ds-space-snug)] flex items-center gap-[var(--ds-space-snug)]">
      <span aria-hidden className="h-px flex-1 border-t border-dashed border-[color:var(--ds-danger-border)]" />
      <span className={cn(dsText.caps, "flex items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-danger)]")}>
        <ShieldAlert aria-hidden className={dsIcon.sm} />
        dry-run boundary — everything below can change a real system
      </span>
      <span aria-hidden className="h-px flex-1 border-t border-dashed border-[color:var(--ds-danger-border)]" />
    </div>
  );
}

function Connector({ graph, fromId }: { graph: typeof SEPARATIONS_GRAPH; fromId: string }) {
  const outs = graph.edges.filter((edge) => edge.from === fromId);
  const conditional = outs.filter((edge) => edge.condition);
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
  selected,
  onSelect,
}: {
  node: ExplorerNode;
  overlay?: OverlayNode;
  selected: boolean;
  onSelect: () => void;
}) {
  const tone = OVERLAY_TONE[overlay?.state ?? "pending"];
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
      )}
    >
      <span aria-hidden className={cn("mt-1 size-2 shrink-0 rounded-full", tone.dot)} />
      <span className="flex min-w-0 flex-1 flex-col gap-[var(--ds-space-hair)]">
        <span className="flex min-w-0 flex-wrap items-center gap-[var(--ds-space-snug)]">
          <span className={cn(dsText.ui, "font-semibold text-[color:var(--ds-fg)]")}>{node.id}</span>
          <Badge tone={KIND_TONE[node.kind]}>{NODE_KIND_LABEL[node.kind]}</Badge>
          {node.system && <Chip label="system">{node.system}</Chip>}
          {node.afterDryRunBoundary && <Chip tone="danger">writes</Chip>}
          <span className={cn(dsText.meta, "ml-auto shrink-0", tone.cls)}>{tone.label}</span>
        </span>
        {node.when && (
          <span className={cn(dsText.micro, "text-[color:var(--ds-fg-muted)]")}>runs when {node.when}</span>
        )}
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
          {overlay?.hasEvidence && <span className={cn(dsText.micro, "text-[color:var(--ds-fg-muted)]")}>evidence captured</span>}
          {overlay?.skippedBecause && (
            <span className={cn(dsText.micro, "text-[color:var(--ds-fg-faint)]")}>{overlay.skippedBecause}</span>
          )}
        </span>
        {overlay?.childNote && (
          <span className={cn(dsText.micro, "text-[color:var(--ds-info-fg)]")}>{overlay.childNote}</span>
        )}
      </span>
    </button>
  );
}

function NodeDetail({
  node,
  overlay,
  runTitle,
  reuse,
}: {
  node: ExplorerNode;
  overlay?: OverlayNode;
  runTitle?: string;
  reuse: { kind: string; label: string; note: string }[];
}) {
  const tone = OVERLAY_TONE[overlay?.state ?? "pending"];
  return (
    <Panel className="min-h-0">
      <PanelHeader
        title={node.id}
        subtitle={`${NODE_KIND_LABEL[node.kind]}${node.system ? ` · ${node.system}` : ""}`}
        meta={<span className={tone.cls}>{tone.label}</span>}
      />
      <PanelBody className="flex flex-col gap-[var(--ds-space-cozy)] p-[var(--ds-space-cozy)]">
        <p className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>{node.purpose}</p>

        {node.afterDryRunBoundary && (
          <Banner tone="danger" title="Past the dry-run boundary">
            This node can change a real HR system. A dry run of {SEPARATIONS_GRAPH.label} stops before it, which is the entire
            safety boundary of a rehearsal — not gated access.
          </Banner>
        )}

        {node.delegatesTo && (
          <Banner tone="info" title={`Delegates to ${DEMO_WORKFLOWS[node.delegatesTo].label}`}>
            The child keeps its own Queue Row in its own panel and is linked from here — it is never nested under this run, and it
            is never counted twice.
          </Banner>
        )}

        {overlay?.keyLines && overlay.keyLines.length > 0 && (
          <Card>
            <CardBody className="flex flex-col gap-[var(--ds-space-tight)]">
              <SectionLabel>What this run recorded here{runTitle ? ` — ${runTitle}` : ""}</SectionLabel>
              {overlay.keyLines.map((line) => (
                <span key={line} className={cn(dsText.body, dsText.nums, "text-[color:var(--ds-fg-secondary)]")}>
                  {line}
                </span>
              ))}
            </CardBody>
          </Card>
        )}

        <Card>
          <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
            <SectionLabel>Contract</SectionLabel>
            {node.contract.reads.length === 0 && node.contract.writes.length === 0 ? (
              <span className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>
                This node reads and writes nothing — it is a decision point, not work.
              </span>
            ) : (
              <Table label={`${node.id} contract`}>
                <THead>
                  <TR>
                    <TH>Direction</TH>
                    <TH>Field</TH>
                    <TH>System</TH>
                    <TH>Proof</TH>
                  </TR>
                </THead>
                <TBody>
                  {node.contract.reads.map((item) => (
                    <TR key={`r-${item.field}`}>
                      <TD>read</TD>
                      <TD numeric>{item.field}</TD>
                      <TD>{item.system}</TD>
                      <TD className="text-[color:var(--ds-fg-faint)]">—</TD>
                    </TR>
                  ))}
                  {node.contract.writes.map((item) => (
                    <TR key={`w-${item.field}`}>
                      <TD className="text-[color:var(--ds-danger)]">write</TD>
                      <TD numeric>{item.field}</TD>
                      <TD>{item.system}</TD>
                      <TD className="max-w-[200px]">{item.proof}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>

        <div className="grid grid-cols-1 gap-[var(--ds-space-base)] min-[520px]:grid-cols-2">
          <Card>
            <CardBody grow className="flex flex-col gap-[var(--ds-space-tight)]">
              <SectionLabel>UI ids</SectionLabel>
              {node.contract.uiIds.length === 0 ? (
                <span className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>None — this node drives no page.</span>
              ) : (
                node.contract.uiIds.map((id) => (
                  <span key={id} className={cn(dsText.meta, dsText.nums, "truncate text-[color:var(--ds-fg-secondary)]")}>
                    {id}
                  </span>
                ))
              )}
              {/* A standing caveat about the card, not the next item in the
                  list. It sits on the card's base so it cannot float in the
                  middle of a card whose neighbour lists more fields. */}
              <CardBase className="pt-[var(--ds-space-snug)]">
                <span className={cn(dsText.micro, "text-[color:var(--ds-fg-faint)]")}>
                  Semantic ids, never raw selectors — a selector in a descriptor breaks every time a page moves a div.
                </span>
              </CardBase>
            </CardBody>
          </Card>
          <Card>
            <CardBody grow className="flex flex-col gap-[var(--ds-space-tight)]">
              <SectionLabel>Editable at a checkpoint</SectionLabel>
              {node.contract.editableFields.length === 0 ? (
                <span className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>
                  Nothing. Identity, input, idempotency, proof and provenance are structurally read-only.
                </span>
              ) : (
                node.contract.editableFields.map((field) => (
                  <Chip key={field} label="editable">
                    {field}
                  </Chip>
                ))
              )}
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardBody className="flex flex-col gap-[var(--ds-space-snug)]">
            <SectionLabel>Data reuse on this run</SectionLabel>
            {reuse.map((entry) => (
              <div key={entry.label} className="flex min-w-0 flex-col gap-[var(--ds-space-hair)]">
                <span className="flex items-center gap-[var(--ds-space-snug)]">
                  <Badge tone={entry.kind === "fresh-live" ? "success" : "warning"}>{entry.kind}</Badge>
                  <span className={cn(dsText.body, "min-w-0 text-[color:var(--ds-fg)]")}>{entry.label}</span>
                </span>
                <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{entry.note}</span>
              </div>
            ))}
          </CardBody>
        </Card>
      </PanelBody>
    </Panel>
  );
}
