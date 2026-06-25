// Type model for the Workflow Graph Editor (n8n-style node canvas).
//
// Two node families ride the same React Flow graph:
//   • Config-backed nodes (row / step / delegation*) round-trip to the existing
//     `WorkflowOverride` via the pure projections in `graph-build.ts`.
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
} from "../../../../domain/workflow-presentation/types.js";

// ── Node type names (the React Flow `type` discriminant + nodeTypes keys) ──────
export const NODE_ROW = "rowNode";
export const NODE_STEP = "stepNode";
export const NODE_DELEGATION_COORDINATOR = "delegationCoordinatorNode";
export const NODE_PREP = "prepNode";
export const NODE_MEMBER = "memberNode";
export const NODE_CUSTOM = "customNode";
export const NODE_NOTE = "noteNode";
export const NODE_GROUP = "groupNode";

// ── Edge type names (semantics + styling) ──────────────────────────────────────
export const EDGE_SEQUENCE = "sequenceEdge";
export const EDGE_DELEGATION = "delegationEdge";
export const EDGE_FOLD = "foldEdge";
export const EDGE_CUSTOM = "customEdge";

export type GraphEdgeType =
  | typeof EDGE_SEQUENCE
  | typeof EDGE_DELEGATION
  | typeof EDGE_FOLD
  | typeof EDGE_CUSTOM;

export type SampleVars = Record<string, string>;

// ── Config-backed node data ────────────────────────────────────────────────────

/** The queue row: what this workflow's row reads (title / subtitle / trace). */
export type RowNodeData = {
  workflowLabel: string;
  /** Effective (merged) naming parts; undefined → resolved against the default scheme. */
  title?: NamingPartTitle;
  subtitle?: NamingPartSubtitle;
  trace?: NamingPartTrace;
  /** Whether the sparse override sets this part (drives the modified-rail treatment). */
  titleModified: boolean;
  subtitleModified: boolean;
  traceModified: boolean;
  sampleVars: SampleVars;
};

/** One displayed pipeline step (config: hidden / label / foldInto). */
export type StepNodeData = {
  step: string;
  label: string;
  /** Step ids folded into this chip (rendered as a +N pill). */
  foldedSteps: string[];
  /** Whether the sparse override carries a rule / order touching this step. */
  modified: boolean;
};

/** The operation coordinator row (label suffix + fan-out head). */
export type DelegationCoordinatorNodeData = {
  workflowLabel: string;
  coordinatorLabelSuffix?: string;
  modified: boolean;
};

/** The OCR prep row (title naming). */
export type PrepNodeData = {
  prepTitle?: NamingPartTitle;
  modified: boolean;
  sampleVars: SampleVars;
};

/** A fanned-out member template (title + subtitle naming). */
export type MemberNodeData = {
  memberTitle?: NamingPartTitle;
  memberSubtitle?: NamingPartSubtitle;
  titleModified: boolean;
  subtitleModified: boolean;
  sampleVars: SampleVars;
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
export type CustomGraphNode = Node<CustomNodeData, typeof NODE_CUSTOM>;
export type NoteGraphNode = Node<NoteNodeData, typeof NODE_NOTE>;
export type GroupGraphNode = Node<GroupNodeData, typeof NODE_GROUP>;

export type GraphNode =
  | RowGraphNode
  | StepGraphNode
  | DelegationCoordinatorGraphNode
  | PrepGraphNode
  | MemberGraphNode
  | CustomGraphNode
  | NoteGraphNode
  | GroupGraphNode;

export type GraphEdge = Edge;

export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
