import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
} from "@xyflow/react";
import type { WorkflowPresentationDetail, WorkflowOverride } from "../useWorkflowPresentation.js";
import { overrideToGraph, parseStepNodeId } from "./graph-build.js";
import { STEP_X0, STEP_DX, STEP_Y } from "./graph-build.js";
import { FlaskConical, Split, Ban } from "lucide-react";
import { groupLaneOps, buildDataFlowEdges } from "./lane-build.js";
import { deriveWorkflowDryRunDiff } from "../../../../domain/workflow-design/dry-run-diff.js";
import { nodeTypes } from "./nodes/node-registry.js";
import { edgeTypes } from "./edges/edge-registry.js";
import { NodeInspector } from "./NodeInspector.js";
import { LaneInteractionContext } from "./lane-interaction.js";
import { DATA_BANK_DRAG_MIME, parseOpDragPayload, opToActionData } from "./data-bank-dnd.js";
import type { IntentNodeKind } from "./graph-types.js";
import { DataBankPalette } from "./DataBankPalette.js";
import type { DataBank, DataBankOperation } from "../../../../domain/workflow-design/data-bank.js";
import type { DesignOverlay } from "./design-spec.js";
import {
  NODE_ROW,
  NODE_STEP,
  NODE_OPS_LANE,
  NODE_DELEGATION_COORDINATOR,
  NODE_PREP,
  NODE_MEMBER,
  NODE_ACTION,
  NODE_CUSTOM,
  NODE_NOTE,
  EDGE_CUSTOM,
  type GraphNode,
  type GraphEdge,
  type GraphModel,
  type StepGraphNode,
  type OpsLaneGraphNode,
  type ActionNodeData,
  type AddedLaneOp,
} from "./graph-types.js";

/** The bare step under a drag/drop, via the React Flow node DOM wrapper's
 *  `data-id` — null when the event isn't over a step lane (empty pane, a palette,
 *  the row/coordinator). */
function stepNodeIdAtTarget(target: EventTarget | null): string | null {
  const el = target instanceof HTMLElement ? target.closest(".react-flow__node") : null;
  const id = el?.getAttribute("data-id");
  return id ? parseStepNodeId(id) : null;
}

/** The lifted, page-owned view controller — focus / collapse / data-flow / fit /
 *  palette state shared between the merged sidebar and the canvas. */
export interface CanvasViewState {
  bank: DataBank | null;
  paletteOpen: boolean;
  onClosePalette: () => void;
  dataFlowOn: boolean;
  /** Dry-run overlay: annotate where a dry run diverges from a live run. */
  dryRunOn: boolean;
  collapsedIds: Set<string>;
  onToggleCollapsed: (id: string) => void;
  /** The lane to focus + a monotonic nonce so re-focusing the same lane re-centers. */
  focusTarget: { id: string; n: number } | null;
  onClearFocus: () => void;
  /** Monotonic counter; a bump fits the whole graph to view. */
  fitNonce: number;
}

interface GraphCanvasProps extends CanvasViewState {
  data: WorkflowPresentationDetail;
  workflowName: string;
  draft: WorkflowOverride;
  onDraftChange: (next: WorkflowOverride) => void;
  /** Intent nodes + positions from the saved design spec (null = none/loading done). */
  designOverlay: DesignOverlay | null;
  /** Lifts the live nodes+edges up so the page's "Generate scaffold" can read them. */
  onGraphChange: (model: GraphModel) => void;
  /** Ops the operator dropped into step lanes, keyed by bare step (page-owned). */
  addedOps: Record<string, AddedLaneOp[]>;
  /** Drop a Data Bank op into a step lane. */
  onAddOpToStep: (step: string, op: DataBankOperation) => void;
  /** Remove a dropped op from a step lane. */
  onRemoveAddedOp: (step: string, addedId: string) => void;
  /** Edit a dropped op's data-flow vars / note. */
  onUpdateAddedOp: (step: string, addedId: string, patch: Partial<ActionNodeData>) => void;
}

/** Lanes + the presentation spine round-trip to the override; ops lanes are display. */
function isConfigType(t?: string): boolean {
  return (
    t === NODE_ROW ||
    t === NODE_STEP ||
    t === NODE_OPS_LANE ||
    t === NODE_DELEGATION_COORDINATOR ||
    t === NODE_PREP ||
    t === NODE_MEMBER
  );
}

function isLaneType(t?: string): boolean {
  return t === NODE_STEP || t === NODE_OPS_LANE;
}

/** MiniMap dot color by node family — token vars only (no raw color). */
function miniMapNodeColor(node: GraphNode): string {
  if (node.type === NODE_OPS_LANE) return "var(--log-violet)";
  if (node.type === NODE_ACTION) return "var(--log-cyan)";
  if (node.type === NODE_CUSTOM) return "var(--log-violet)";
  if (node.type === NODE_NOTE) return "var(--muted-foreground)";
  if (
    node.type === NODE_DELEGATION_COORDINATOR ||
    node.type === NODE_PREP ||
    node.type === NODE_MEMBER
  ) {
    return "var(--info)";
  }
  return "var(--muted-foreground)";
}

/** Seed: config nodes (positions overlaid from the saved spec) + saved intent nodes. */
function buildInitial(configNodes: GraphNode[], overlay: DesignOverlay | null): GraphNode[] {
  const pos = overlay?.positions ?? {};
  const config = configNodes.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n));
  return [...config, ...(overlay?.intentNodes ?? [])];
}

/** Seed: derived config edges + the saved operator-drawn (custom) edges. The
 *  re-sync effect preserves the custom edges thereafter (it partitions on
 *  `EDGE_CUSTOM`), so seeding them here is what makes drawn edges survive a reload. */
function buildInitialEdges(configEdges: GraphEdge[], overlay: DesignOverlay | null): GraphEdge[] {
  return overlay?.customEdges?.length ? [...configEdges, ...overlay.customEdges] : configEdges;
}

/** Re-sync config-node data from a fresh projection; preserve intent nodes +
 *  selection + manual positions (lanes follow layout so reorder visibly moves). */
function syncNodes(curr: GraphNode[], nextConfig: GraphNode[]): GraphNode[] {
  const currIntent = curr.filter((n) => !isConfigType(n.type));
  const byId = new Map(curr.map((n) => [n.id, n]));
  const mergedConfig = nextConfig.map((n) => {
    const prev = byId.get(n.id);
    if (!prev) return n;
    const dataSame = JSON.stringify(prev.data) === JSON.stringify(n.data);
    const keepPosition = !isLaneType(n.type);
    return {
      ...n,
      position: keepPosition ? prev.position : n.position,
      selected: prev.selected,
      data: dataSame ? prev.data : n.data,
    } as GraphNode;
  });
  return [...mergedConfig, ...currIntent];
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(m.matches);
    const onChange = (): void => setReduced(m.matches);
    m.addEventListener?.("change", onChange);
    return () => m.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

interface GraphCanvasInnerProps extends GraphCanvasProps {
  wrapperRef: RefObject<HTMLDivElement>;
}

function GraphCanvasInner({
  data,
  workflowName,
  draft,
  onDraftChange,
  designOverlay,
  onGraphChange,
  wrapperRef,
  bank,
  paletteOpen,
  onClosePalette,
  dataFlowOn,
  dryRunOn,
  collapsedIds,
  onToggleCollapsed,
  focusTarget,
  onClearFocus,
  fitNonce,
  addedOps,
  onAddOpToStep,
  onRemoveAddedOp,
  onUpdateAddedOp,
}: GraphCanvasInnerProps): JSX.Element {
  const reducedMotion = usePrefersReducedMotion();
  const { screenToFlowPosition, fitView, getNode, setCenter } = useReactFlow();
  const [dropTargetStep, setDropTargetStep] = useState<string | null>(null);

  // The workflow's REAL mined automation, grouped by presentation step.
  const workflowBank = useMemo(
    () => bank?.workflows.find((w) => w.workflow === workflowName),
    [bank, workflowName],
  );
  const laneOps = useMemo(
    () => groupLaneOps(workflowBank, data.base.steps),
    [workflowBank, data.base.steps],
  );

  // Where a dry run diverges from a live run (gate / skipped steps + the verbatim
  // boundary), derived from the same mined bank. Drives the "Dry run" overlay.
  const dryRunDiff = useMemo(() => deriveWorkflowDryRunDiff(workflowBank), [workflowBank]);

  // Per-step data-bank metadata (note / source file) for the inspector detail.
  const stepMeta = useMemo(() => {
    const m = new Map<string, { note?: string; sourceRef?: string }>();
    for (const s of workflowBank?.steps ?? []) m.set(s.step, { note: s.note, sourceRef: s.sourceRef });
    return m;
  }, [workflowBank]);

  // Project the config + nest each step's mined ops into its lane; append any
  // unmapped mined step as a read-only ops lane to the right of the pipeline.
  const configModel = useMemo<GraphModel>(() => {
    const projected = overrideToGraph(data.base, draft, workflowName);
    // Config nodes (the pipeline spine) are NOT deletable — only operator-placed
    // action/intent nodes + drawn edges can be removed with the Delete key.
    const nodes: GraphNode[] = projected.nodes.map((n) =>
      n.type === NODE_STEP
        ? ({
            ...n,
            deletable: false,
            data: {
              ...n.data,
              ops: laneOps.byStep[n.data.step] ?? [],
              addedOps: addedOps[n.data.step] ?? [],
              bankNote: stepMeta.get(n.data.step)?.note,
              bankSourceRef: stepMeta.get(n.data.step)?.sourceRef,
            },
          } as GraphNode)
        : ({ ...n, deletable: false } as GraphNode),
    );
    const stepCount = nodes.filter((n) => n.type === NODE_STEP).length;
    laneOps.extraLanes.forEach((ex, i) => {
      nodes.push({
        id: ex.id,
        type: NODE_OPS_LANE,
        position: { x: STEP_X0 + (stepCount + i) * STEP_DX, y: STEP_Y },
        deletable: false,
        data: { step: ex.step, label: ex.label, ops: ex.ops, bankNote: ex.note, bankSourceRef: ex.sourceRef },
      } as GraphNode);
    });
    return { nodes, edges: projected.edges };
  }, [data.base, draft, workflowName, laneOps, stepMeta, addedOps]);

  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>(
    buildInitial(configModel.nodes, designOverlay),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<GraphEdge>(
    buildInitialEdges(configModel.edges, designOverlay),
  );
  const dropCount = useRef(0);

  // Keep config nodes in sync with the projected model (driven by the draft).
  // Operator-drawn custom edges are NOT derived from the config, so preserve them
  // across the re-sync (a draft keystroke must not wipe a hand-drawn link).
  useEffect(() => {
    setNodes((curr) => syncNodes(curr, configModel.nodes));
    setEdges((curr) => [...configModel.edges, ...curr.filter((e) => e.type === EDGE_CUSTOM)]);
  }, [configModel, setNodes, setEdges]);

  // Hand-drawn connections become custom (design-intent) edges.
  const onConnect = useCallback(
    (c: Connection) => {
      setEdges((eds) =>
        addEdge(
          { ...c, type: EDGE_CUSTOM, id: `custom:${crypto.randomUUID().slice(0, 8)}`, deletable: true },
          eds,
        ),
      );
    },
    [setEdges],
  );

  // Lift the live model up for the scaffold generator (ops lanes are display-only).
  useEffect(() => {
    onGraphChange({ nodes: nodes.filter((n) => n.type !== NODE_OPS_LANE), edges });
  }, [nodes, edges, onGraphChange]);

  const focusedId = focusTarget?.id ?? null;

  // ── Focus (sidebar → frame a lane, dim the rest) ───────────────────────────────
  // Focusing also SELECTS the node, which opens the right inspector (an overlay on
  // the canvas's right edge). So we center the node in the area LEFT of the
  // inspector — `setCenter` puts a flow point at the true viewport centre, and we
  // push the target right by half the inspector's footprint so the node lands in
  // the visible middle, not under the panel. (Keep INSPECTOR_FOOTPRINT in sync with
  // NodeInspector's `w-[22rem]` + right gap.)
  const INSPECTOR_FOOTPRINT = 372;
  const focusNode = useCallback(
    (id: string) => {
      setNodes((curr) => curr.map((n) => ({ ...n, selected: n.id === id })));
      const node = getNode(id);
      const duration = reducedMotion ? 0 : 420;
      if (!node) {
        void fitView({ nodes: [{ id }], duration, padding: 0.45, maxZoom: 1.1 });
        return;
      }
      const w = node.measured?.width ?? 320;
      const h = node.measured?.height ?? 240;
      const vh = wrapperRef.current?.clientHeight ?? 800;
      const zoom = Math.min(1.1, Math.max(0.55, (vh * 0.82) / h));
      const cx = node.position.x + w / 2 + INSPECTOR_FOOTPRINT / 2 / zoom;
      const cy = node.position.y + h / 2;
      void setCenter(cx, cy, { zoom, duration });
    },
    [getNode, setCenter, fitView, setNodes, reducedMotion, wrapperRef],
  );

  // Run focus imperatively when the page bumps the focus target (nonce-guarded so a
  // re-focus of the same lane still re-centers).
  const lastFocusNonce = useRef(-1);
  useEffect(() => {
    if (focusTarget && focusTarget.n !== lastFocusNonce.current) {
      lastFocusNonce.current = focusTarget.n;
      focusNode(focusTarget.id);
    }
  }, [focusTarget, focusNode]);

  // Fit on demand (skip the mount tick — React Flow's `fitView` prop handles that).
  const fitMounted = useRef(false);
  useEffect(() => {
    if (!fitMounted.current) {
      fitMounted.current = true;
      return;
    }
    void fitView({ duration: reducedMotion ? 0 : 420, padding: 0.3, maxZoom: 1 });
  }, [fitNonce, fitView, reducedMotion]);

  // ── Data-flow overlay (lane→lane var links; toggled from the sidebar) ───────────
  const dataFlowEdges = useMemo(() => {
    const lanes: { nodeId: string; ops: ActionNodeData[] }[] = [];
    const steps = configModel.nodes.filter((n): n is StepGraphNode => n.type === NODE_STEP);
    steps.sort((a, b) => a.data.stepIndex - b.data.stepIndex);
    for (const n of steps) lanes.push({ nodeId: n.id, ops: n.data.ops ?? [] });
    for (const n of configModel.nodes) {
      if (n.type === NODE_OPS_LANE) lanes.push({ nodeId: n.id, ops: (n as OpsLaneGraphNode).data.ops });
    }
    return buildDataFlowEdges(lanes);
  }, [configModel]);

  const displayNodes = useMemo(() => {
    if (!focusedId) return nodes;
    return nodes.map((n) =>
      n.id === focusedId ? n : ({ ...n, style: { ...n.style, opacity: 0.4 } } as GraphNode),
    );
  }, [nodes, focusedId]);
  const displayEdges = useMemo(
    () => (dataFlowOn ? [...edges, ...dataFlowEdges] : edges),
    [edges, dataFlowOn, dataFlowEdges],
  );

  // ── Inspector (single-selection) ──────────────────────────────────────────────
  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : null;
  const closeInspector = useCallback(() => {
    setNodes((curr) => curr.map((n) => (n.selected ? { ...n, selected: false } : n)));
    onClearFocus();
  }, [setNodes, onClearFocus]);

  const nextDropPosition = useCallback((): { x: number; y: number } => {
    const i = dropCount.current++;
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return { x: 120 + (i % 4) * 70, y: 880 + Math.floor(i / 4) * 50 };
    return screenToFlowPosition({
      x: rect.left + 360 + (i % 4) * 20,
      y: rect.top + rect.height * 0.5 + Math.floor(i / 4) * 20,
    });
  }, [screenToFlowPosition, wrapperRef]);

  const addIntentNode = useCallback(
    (kind: IntentNodeKind) => {
      const id = `${kind}-${crypto.randomUUID().slice(0, 8)}`;
      const position = nextDropPosition();
      const node: GraphNode =
        kind === NODE_CUSTOM
          ? { id, type: NODE_CUSTOM, position, data: {} }
          : kind === NODE_NOTE
            ? { id, type: NODE_NOTE, position, data: { text: "" } }
            : { id, type: kind, position, data: { label: "Section" } };
      setNodes((curr) => [...curr.map((n) => ({ ...n, selected: false })), { ...node, selected: true }]);
    },
    [setNodes, nextDropPosition],
  );

  const addActionNode = useCallback(
    (op: DataBankOperation, position?: { x: number; y: number }) => {
      const id = `action-${crypto.randomUUID().slice(0, 8)}`;
      const node: GraphNode = {
        id,
        type: NODE_ACTION,
        position: position ?? nextDropPosition(),
        data: opToActionData(op),
      };
      setNodes((curr) => [...curr.map((n) => ({ ...n, selected: false })), { ...node, selected: true }]);
    },
    [setNodes, nextDropPosition],
  );

  // ── Drag-and-drop from the Data Bank palette ───────────────────────────────────
  // Drop ON a step lane → the op joins that step (an "added" row); drop on empty
  // canvas → a standalone, connectable action node at the cursor.
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DATA_BANK_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropTargetStep(stepNodeIdAtTarget(e.target));
  }, []);

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      const next = e.relatedTarget;
      if (!(next instanceof Node) || !wrapperRef.current?.contains(next)) setDropTargetStep(null);
    },
    [wrapperRef],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const op = parseOpDragPayload(e.dataTransfer.getData(DATA_BANK_DRAG_MIME));
      setDropTargetStep(null);
      if (!op) return;
      e.preventDefault();
      const step = stepNodeIdAtTarget(e.target);
      if (step) onAddOpToStep(step, op);
      else addActionNode(op, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [onAddOpToStep, addActionNode, screenToFlowPosition],
  );

  const updateIntentNode = useCallback(
    (id: string, patch: Record<string, unknown>) => {
      setNodes((curr) =>
        curr.map((n) => (n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as GraphNode) : n)),
      );
    },
    [setNodes],
  );
  const removeIntentNode = useCallback(
    (id: string) => setNodes((curr) => curr.filter((n) => n.id !== id)),
    [setNodes],
  );

  const laneInteraction = useMemo(
    () => ({
      isCollapsed: (id: string) => collapsedIds.has(id),
      toggleCollapsed: onToggleCollapsed,
      focusedId,
      dryRun: { on: dryRunOn, forStep: (step: string) => dryRunDiff.steps[step] },
      removeAddedOp: onRemoveAddedOp,
      dropTargetStep,
    }),
    [collapsedIds, onToggleCollapsed, focusedId, dryRunOn, dryRunDiff, onRemoveAddedOp, dropTargetStep],
  );

  return (
    <LaneInteractionContext.Provider value={laneInteraction}>
      <div
        ref={wrapperRef}
        className="relative h-full w-full"
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={onDragLeave}
      >
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onClearFocus}
          onPaneClick={onClearFocus}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={1.75}
          nodesConnectable
          deleteKeyCode={["Backspace", "Delete"]}
          elevateNodesOnSelect
          multiSelectionKeyCode="Shift"
          selectionKeyCode="Shift"
          selectionOnDrag={false}
          selectNodesOnDrag={false}
          proOptions={{ hideAttribution: false }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--border)" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            ariaLabel="Workflow graph minimap"
            nodeColor={miniMapNodeColor}
            maskColor="color-mix(in srgb, var(--background) 70%, transparent)"
            style={{ backgroundColor: "var(--popover)" }}
          />
          {paletteOpen ? (
            <Panel position="top-left">
              <DataBankPalette
                bank={bank}
                onAddOp={addActionNode}
                onAddAnnotation={addIntentNode}
                onClose={onClosePalette}
              />
            </Panel>
          ) : null}

          {dryRunOn ? (
            <Panel position="top-center">
              <section
                aria-label="Dry run overlay"
                className="max-w-md rounded-xl border border-border bg-popover/95 px-3.5 py-3 shadow-lg backdrop-blur-sm"
              >
                <div className="flex items-center gap-1.5">
                  <FlaskConical aria-hidden className="h-4 w-4 shrink-0 text-info" />
                  <h2 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-foreground">
                    Dry run
                  </h2>
                </div>
                {dryRunDiff.hasDryRun ? (
                  <>
                    <p className="mt-1.5 text-[12px] leading-snug text-muted-foreground">
                      {dryRunDiff.boundary ?? "Marks where this run differs from a live run."}
                    </p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/70 pt-2 text-[11px]">
                      <span className="inline-flex items-center gap-1 text-info">
                        <Split aria-hidden className="h-3 w-3 shrink-0" />
                        Dry-run gate
                      </span>
                      <span className="inline-flex items-center gap-1 text-warning">
                        <Ban aria-hidden className="h-3 w-3 shrink-0" />
                        Skipped in dry run
                      </span>
                    </div>
                  </>
                ) : (
                  <p className="mt-1.5 text-[12px] leading-snug text-muted-foreground">
                    This workflow has no dry-run mode — every run executes the same path.
                  </p>
                )}
              </section>
            </Panel>
          ) : null}
        </ReactFlow>

        {selectedNode ? (
          <NodeInspector
            node={selectedNode}
            data={data}
            workflowName={workflowName}
            draft={draft}
            onChange={onDraftChange}
            onClose={closeInspector}
            onUpdateIntent={updateIntentNode}
            onRemoveIntent={removeIntentNode}
            onUpdateAddedOp={onUpdateAddedOp}
            onRemoveAddedOp={onRemoveAddedOp}
          />
        ) : null}
      </div>
    </LaneInteractionContext.Provider>
  );
}

/**
 * The step-lane canvas for one workflow. The presentation spine (row → step lanes
 * → delegation) is the editable object; each lane NESTS the step's real mined ops
 * as collapsible rows, and lane→lane data-flow links can be toggled on. The merged
 * sidebar (in the page) navigates + focuses and owns the view controller; the
 * inspector edits the selected node; config edits flow through the sparse `draft`
 * override (live preview). The parent keys this by workflow + design-loaded so it
 * mounts once with the saved overlay applied.
 */
export function GraphCanvas(props: GraphCanvasProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} wrapperRef={wrapperRef} />
    </ReactFlowProvider>
  );
}
