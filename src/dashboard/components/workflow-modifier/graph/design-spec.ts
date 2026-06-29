// The graph ↔ design-scaffold projections (Phase 3). graphToDesignSpec captures
// the WHOLE graph — config-backed nodes mirror the override slice they own,
// design-intent nodes (custom/note/group) carry freeform intent — so a future
// session reads the full picture. designSpecToGraph rebuilds the intent nodes +
// a positions map to overlay onto the config nodes that overrideToGraph derives.

import type {
  WorkflowDesignSpec,
  DesignNode,
  DesignEdge,
  DesignNodeType,
  DesignActionOp,
} from "../../../../domain/workflow-design/types.js";
import { DESIGN_SCHEMA_VERSION } from "../../../../domain/workflow-design/types.js";
import type { DataBankOpKind } from "../../../../domain/workflow-design/data-bank.js";
import {
  NODE_ROW,
  NODE_STEP,
  NODE_DELEGATION_COORDINATOR,
  NODE_PREP,
  NODE_MEMBER,
  NODE_ACTION,
  NODE_CUSTOM,
  NODE_NOTE,
  NODE_GROUP,
  EDGE_SEQUENCE,
  EDGE_DELEGATION,
  EDGE_FOLD,
  EDGE_CUSTOM,
  type GraphModel,
  type GraphNode,
} from "./graph-types.js";

const NODE_TO_DESIGN: Record<string, DesignNodeType> = {
  [NODE_ROW]: "row",
  [NODE_STEP]: "step",
  [NODE_DELEGATION_COORDINATOR]: "delegationCoordinator",
  [NODE_PREP]: "prep",
  [NODE_MEMBER]: "member",
  [NODE_ACTION]: "action",
  [NODE_CUSTOM]: "custom",
  [NODE_NOTE]: "note",
  [NODE_GROUP]: "group",
};
const DESIGN_TO_NODE: Record<DesignNodeType, string> = {
  row: NODE_ROW,
  step: NODE_STEP,
  delegationCoordinator: NODE_DELEGATION_COORDINATOR,
  prep: NODE_PREP,
  member: NODE_MEMBER,
  action: NODE_ACTION,
  custom: NODE_CUSTOM,
  note: NODE_NOTE,
  group: NODE_GROUP,
};
const EDGE_TO_DESIGN: Record<string, DesignEdge["type"]> = {
  [EDGE_SEQUENCE]: "sequence",
  [EDGE_DELEGATION]: "delegation",
  [EDGE_FOLD]: "fold",
  [EDGE_CUSTOM]: "custom",
};

/** The override slice a config-backed node owns (omitted keys → not overridden). */
function configSlice(node: GraphNode): Record<string, unknown> | undefined {
  switch (node.type) {
    case NODE_ROW: {
      const c: Record<string, unknown> = {};
      if (node.data.titleOverride !== undefined) c.title = node.data.titleOverride;
      if (node.data.subtitleOverride !== undefined) c.subtitle = node.data.subtitleOverride;
      if (node.data.traceOverride !== undefined) c.trace = node.data.traceOverride;
      return Object.keys(c).length ? c : undefined;
    }
    case NODE_STEP:
      return node.data.overrideRule ? { ...node.data.overrideRule } : { step: node.data.step };
    case NODE_DELEGATION_COORDINATOR:
      return node.data.suffixOverridden
        ? { coordinatorLabelSuffix: node.data.coordinatorLabelSuffix }
        : undefined;
    case NODE_PREP:
      return node.data.prepTitleOverride !== undefined
        ? { prepTitle: node.data.prepTitleOverride }
        : undefined;
    case NODE_MEMBER: {
      const c: Record<string, unknown> = {};
      if (node.data.memberTitleOverride !== undefined) c.memberTitle = node.data.memberTitleOverride;
      if (node.data.memberSubtitleOverride !== undefined) c.memberSubtitle = node.data.memberSubtitleOverride;
      return Object.keys(c).length ? c : undefined;
    }
    default:
      return undefined;
  }
}

/** The intent block for an intent-only node (custom/note/group). */
function intentBlock(node: GraphNode): DesignNode["intent"] | undefined {
  if (node.type === NODE_CUSTOM) {
    const d = node.data;
    const intent: NonNullable<DesignNode["intent"]> = {};
    if (d.label) intent.label = d.label;
    if (d.description) intent.description = d.description;
    if (d.look) intent.look = d.look;
    if (d.behavior) intent.behavior = d.behavior;
    if (d.references?.length) intent.references = d.references;
    if (d.exampleData && Object.keys(d.exampleData).length) intent.exampleData = d.exampleData;
    return Object.keys(intent).length ? intent : undefined;
  }
  if (node.type === NODE_NOTE) {
    return node.data.text ? { description: node.data.text } : undefined;
  }
  if (node.type === NODE_GROUP) {
    return node.data.label ? { label: node.data.label } : undefined;
  }
  return undefined;
}

/** The action op block for an action node (omits undefined fields to stay sparse). */
function actionBlock(node: GraphNode): DesignActionOp | undefined {
  if (node.type !== NODE_ACTION) return undefined;
  const d = node.data;
  const op: DesignActionOp = { opId: d.opId, kind: d.kind, system: d.system, label: d.label };
  if (d.selectorFqn !== undefined) op.selectorFqn = d.selectorFqn;
  if (d.role !== undefined) op.role = d.role;
  if (d.accessibleName !== undefined) op.accessibleName = d.accessibleName;
  if (d.inputVar !== undefined) op.inputVar = d.inputVar;
  if (d.outputVar !== undefined) op.outputVar = d.outputVar;
  if (d.url !== undefined) op.url = d.url;
  if (d.note !== undefined) op.note = d.note;
  return op;
}

export function graphToDesignSpec(
  model: GraphModel,
  workflow: string,
  generatedAt: string,
  extras?: { summary?: string; canvas?: { zoom: number; x: number; y: number } },
): WorkflowDesignSpec {
  const nodes: DesignNode[] = model.nodes.map((n) => {
    const type = NODE_TO_DESIGN[n.type ?? ""] ?? "custom";
    const node: DesignNode = { id: n.id, type, position: { x: n.position.x, y: n.position.y } };
    const config = configSlice(n);
    if (config) node.config = config;
    const intent = intentBlock(n);
    if (intent) node.intent = intent;
    const action = actionBlock(n);
    if (action) node.action = action;
    if (n.parentId) node.parentGroup = n.parentId;
    return node;
  });

  const edges: DesignEdge[] = model.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: EDGE_TO_DESIGN[e.type ?? ""] ?? "custom",
    ...(typeof e.label === "string" ? { label: e.label } : {}),
  }));

  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    workflow,
    generatedAt,
    ...(extras?.summary ? { summary: extras.summary } : {}),
    ...(extras?.canvas ? { canvas: extras.canvas } : {}),
    nodes,
    edges,
  };
}

export interface DesignOverlay {
  /** The intent-only nodes (custom/note/group) to append to the config graph. */
  intentNodes: GraphNode[];
  /** Saved positions keyed by node id — overlaid onto every node (config + intent). */
  positions: Record<string, { x: number; y: number }>;
}

/** Rebuild the intent nodes + the position overlay from a saved design spec. */
export function designSpecToGraph(spec: WorkflowDesignSpec): DesignOverlay {
  const positions: Record<string, { x: number; y: number }> = {};
  const intentNodes: GraphNode[] = [];
  for (const n of spec.nodes) {
    positions[n.id] = { x: n.position.x, y: n.position.y };
    if (n.type === "action" && n.action) {
      // Action nodes are placed back into intentNodes so GraphCanvas's seedOps gate
      // sees them and does NOT double-seed the mined ops.
      const a = n.action;
      intentNodes.push({
        id: n.id,
        type: NODE_ACTION,
        position: { ...n.position },
        data: {
          opId: a.opId,
          kind: a.kind as DataBankOpKind,
          system: a.system,
          label: a.label,
          ...(a.selectorFqn !== undefined ? { selectorFqn: a.selectorFqn } : {}),
          ...(a.role !== undefined ? { role: a.role } : {}),
          ...(a.accessibleName !== undefined ? { accessibleName: a.accessibleName } : {}),
          ...(a.inputVar !== undefined ? { inputVar: a.inputVar } : {}),
          ...(a.outputVar !== undefined ? { outputVar: a.outputVar } : {}),
          ...(a.url !== undefined ? { url: a.url } : {}),
          ...(a.note !== undefined ? { note: a.note } : {}),
        },
      });
    } else if (n.type === "custom") {
      intentNodes.push({
        id: n.id,
        type: NODE_CUSTOM,
        position: { ...n.position },
        data: {
          label: n.intent?.label,
          description: n.intent?.description,
          look: n.intent?.look,
          behavior: n.intent?.behavior,
          references: n.intent?.references,
          exampleData: n.intent?.exampleData,
        },
      });
    } else if (n.type === "note") {
      intentNodes.push({
        id: n.id,
        type: NODE_NOTE,
        position: { ...n.position },
        data: { text: n.intent?.description ?? "" },
      });
    } else if (n.type === "group") {
      intentNodes.push({
        id: n.id,
        type: NODE_GROUP,
        position: { ...n.position },
        data: { label: n.intent?.label ?? "Group" },
      });
    }
  }
  return { intentNodes, positions };
}

export { DESIGN_TO_NODE };
