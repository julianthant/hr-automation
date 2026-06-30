// Type model for the Workflow Graph Editor (n8n-style node canvas).
//
// Two node families ride the same React Flow graph:
//   • Config-backed nodes (row / step / delegation*) round-trip to the existing
//     `WorkflowOverride` via the pure projections in `graph-build.ts`. Their data
//     carries BOTH the effective part (for the live preview) AND the sparse
//     override slice it owns (so `graphToOverride` can reconstruct the override
//     faithfully, mirroring the spec's "config-backed node mirrors its slice").
//   • Design-intent nodes (custom / note / group) carry freeform intent that the
//     runtime schema can't express; they only feed the design scaffold (Phase 3).
//
// Node `data` shapes are `type` aliases (object literal types), which satisfy
// React Flow v12's `Record<string, unknown>` data constraint.

import type { Node, Edge } from "@xyflow/react";
import type {
  NamingPartTitle,
  NamingPartSubtitle,
  NamingPartTrace,
  StepDisplayRule,
} from "../../../../domain/workflow-presentation/types.js";
import type { DataBankOpKind } from "../../../../domain/workflow-design/data-bank.js";

// ── Node type names (the React Flow `type` discriminant + nodeTypes keys) ──────
export const NODE_ROW = "rowNode";
export const NODE_STEP = "stepNode";
export const NODE_DELEGATION_COORDINATOR = "delegationCoordinatorNode";
export const NODE_PREP = "prepNode";
export const NODE_MEMBER = "memberNode";
export const NODE_ACTION = "actionNode";
export const NODE_CUSTOM = "customNode";
export const NODE_NOTE = "noteNode";
export const NODE_GROUP = "groupNode";
/** A display-only lane for mined ops that map to NO presentation step (read-only,
 *  ignored by the override projection). Rare in practice; keeps "show every op" honest. */
export const NODE_OPS_LANE = "opsLaneNode";

/** The kind of annotation/intent node added from the palette. */
export type IntentNodeKind = typeof NODE_CUSTOM | typeof NODE_NOTE | typeof NODE_GROUP;

// ── Edge type names (semantics + styling) ──────────────────────────────────────
export const EDGE_SEQUENCE = "sequenceEdge";
export const EDGE_DELEGATION = "delegationEdge";
export const EDGE_FOLD = "foldEdge";
export const EDGE_CUSTOM = "customEdge";
/** A lane→lane data-flow link: a scrape's `{var}` feeds a later step's fill/select. */
export const EDGE_DATAFLOW = "dataFlowEdge";

export type GraphEdgeType =
  | typeof EDGE_SEQUENCE
  | typeof EDGE_DELEGATION
  | typeof EDGE_FOLD
  | typeof EDGE_CUSTOM
  | typeof EDGE_DATAFLOW;

export type SampleVars = Record<string, string>;

// ── Config-backed node data ────────────────────────────────────────────────────

/** The queue row: what this workflow's row reads (title / subtitle / trace). */
export type RowNodeData = {
  workflowLabel: string;
  /** Effective (draft ?? base ?? default) naming parts — drive the live preview. */
  title: NamingPartTitle;
  subtitle: NamingPartSubtitle;
  trace: NamingPartTrace;
  /** Sparse override slice this node owns (undefined → not overridden). */
  titleOverride?: NamingPartTitle;
  subtitleOverride?: NamingPartSubtitle;
  traceOverride?: NamingPartTrace;
  sampleVars: SampleVars;
};

/** One displayed pipeline step (config: hidden / label / foldInto). */
export type StepNodeData = {
  step: string;
  /** 0-based position in the displayed order (drives the "Step N" eyebrow). */
  stepIndex: number;
  /** Effective display label (rule.label ?? formatted). */
  label: string;
  hidden: boolean;
  foldInto?: string;
  /** Step ids folded into this chip (rendered as a +N pill). */
  foldedSteps: string[];
  /** Sparse override rule this node owns (undefined → no override rule). */
  overrideRule?: StepDisplayRule;
  /** The step's REAL mined automation ops (Data Bank), nested inside the lane.
   *  Presentation-only — merged in the canvas layer, never set by the pure
   *  `overrideToGraph` projection, and ignored by `graphToOverride`. */
  ops?: ActionNodeData[];
  /** Ops the operator DROPPED into this step from the Data Bank — design intent,
   *  rendered as editable/removable rows beneath the mined ops and serialized to
   *  the scaffold as action nodes parented to the step. Presentation-only (merged
   *  in the canvas layer), ignored by `graphToOverride`. */
  addedOps?: AddedLaneOp[];
  /** Data-bank step note (branches / gates / dry-run boundary / fan-out). */
  bankNote?: string;
  /** Data-bank step source file, e.g. "src/workflows/.../steps/foo.ts". */
  bankSourceRef?: string;
};

/** The operation coordinator row (label suffix + fan-out head). */
export type DelegationCoordinatorNodeData = {
  workflowLabel: string;
  /** Effective suffix (draft ?? base). */
  coordinatorLabelSuffix?: string;
  /** Whether the sparse override sets the suffix. */
  suffixOverridden: boolean;
};

/** The OCR prep row (title naming). */
export type PrepNodeData = {
  prepTitle: NamingPartTitle;
  prepTitleOverride?: NamingPartTitle;
  sampleVars: SampleVars;
};

/** A fanned-out member template (title + subtitle naming). */
export type MemberNodeData = {
  memberTitle: NamingPartTitle;
  memberSubtitle: NamingPartSubtitle;
  memberTitleOverride?: NamingPartTitle;
  memberSubtitleOverride?: NamingPartSubtitle;
  sampleVars: SampleVars;
};

// ── Action-primitive node data (the Data Bank) ──────────────────────────────────

/** A real automation primitive placed from the Data Bank palette — what gets
 *  clicked / located / filled / scraped. Carries the full op so the node renders
 *  detail and the scaffold can serialize it. Design-intent (no runtime override). */
export type ActionNodeData = {
  /** The data-bank op id, e.g. "kuali.separationForm.eid#fill". */
  opId: string;
  kind: DataBankOpKind;
  system: string;
  label: string;
  /** What it locates. */
  selectorFqn?: string;
  role?: string;
  accessibleName?: string;
  /** Data flow (workflow-specific when placed in a workflow's graph). */
  inputVar?: string;
  outputVar?: string;
  url?: string;
  note?: string;
};

/** An op the operator DROPPED into a step lane from the Data Bank: the action-op
 *  data plus a stable `addedId` for remove/edit. It rides per-step editor state
 *  (NOT a standalone React Flow node) — rendered as an extra row in the lane and
 *  serialized to the scaffold as an action node parented to the step. */
export type AddedLaneOp = ActionNodeData & { addedId: string };

/** A display-only lane of mined ops with no matching presentation step. */
export type OpsLaneNodeData = {
  /** The mined step id (descriptive slug, not a presentation step). */
  step: string;
  label: string;
  ops: ActionNodeData[];
  bankNote?: string;
  bankSourceRef?: string;
};

// ── Design-intent node data (Phase 3) ──────────────────────────────────────────

/** Freeform "design intent" the schema can't express — feeds the scaffold only. */
export type CustomNodeData = {
  label?: string;
  description?: string;
  look?: string;
  behavior?: string;
  references?: string[];
  exampleData?: Record<string, string>;
};

/** A sticky annotation anchored on the canvas. */
export type NoteNodeData = {
  text: string;
};

/** A labeled frame grouping nodes into a "section/screen" intent. */
export type GroupNodeData = {
  label: string;
};

// ── Concrete React Flow node unions ────────────────────────────────────────────
export type RowGraphNode = Node<RowNodeData, typeof NODE_ROW>;
export type StepGraphNode = Node<StepNodeData, typeof NODE_STEP>;
export type DelegationCoordinatorGraphNode = Node<
  DelegationCoordinatorNodeData,
  typeof NODE_DELEGATION_COORDINATOR
>;
export type PrepGraphNode = Node<PrepNodeData, typeof NODE_PREP>;
export type MemberGraphNode = Node<MemberNodeData, typeof NODE_MEMBER>;
export type ActionGraphNode = Node<ActionNodeData, typeof NODE_ACTION>;
export type OpsLaneGraphNode = Node<OpsLaneNodeData, typeof NODE_OPS_LANE>;
export type CustomGraphNode = Node<CustomNodeData, typeof NODE_CUSTOM>;
export type NoteGraphNode = Node<NoteNodeData, typeof NODE_NOTE>;
export type GroupGraphNode = Node<GroupNodeData, typeof NODE_GROUP>;

export type GraphNode =
  | RowGraphNode
  | StepGraphNode
  | DelegationCoordinatorGraphNode
  | PrepGraphNode
  | MemberGraphNode
  | ActionGraphNode
  | OpsLaneGraphNode
  | CustomGraphNode
  | NoteGraphNode
  | GroupGraphNode;

export type GraphEdge = Edge;

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
