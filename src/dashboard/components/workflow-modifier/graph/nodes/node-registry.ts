// Module-constant nodeTypes registry. MUST stay a stable reference (defined once
// at module scope, never recreated per render) — React Flow re-mounts every node
// if nodeTypes identity changes, which both kills perf and warns. Design-intent
// node kinds (custom / note / group) register here in Phase 3.

import type { NodeTypes } from "@xyflow/react";
import { RowNode } from "./RowNode.js";
import { StepNode } from "./StepNode.js";
import { DelegationCoordinatorNode, PrepNode, MemberNode } from "./DelegationNodes.js";
import { ActionNode } from "./ActionNode.js";
import { OpsLaneNode } from "./OpsLaneNode.js";
import { CustomNode, NoteNode, GroupNode } from "./IntentNodes.js";
import {
  NODE_ROW,
  NODE_STEP,
  NODE_DELEGATION_COORDINATOR,
  NODE_PREP,
  NODE_MEMBER,
  NODE_ACTION,
  NODE_OPS_LANE,
  NODE_CUSTOM,
  NODE_NOTE,
  NODE_GROUP,
} from "../graph-types.js";

export const nodeTypes: NodeTypes = {
  [NODE_ROW]: RowNode,
  [NODE_STEP]: StepNode,
  [NODE_DELEGATION_COORDINATOR]: DelegationCoordinatorNode,
  [NODE_PREP]: PrepNode,
  [NODE_MEMBER]: MemberNode,
  [NODE_ACTION]: ActionNode,
  [NODE_OPS_LANE]: OpsLaneNode,
  [NODE_CUSTOM]: CustomNode,
  [NODE_NOTE]: NoteNode,
  [NODE_GROUP]: GroupNode,
};
