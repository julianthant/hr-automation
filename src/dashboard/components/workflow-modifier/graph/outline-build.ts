// Pure outline model for the merged editor sidebar. The sidebar lives in the page
// (outside the keyed, remounting canvas), so it can't read the live React Flow
// nodes — instead it derives the same spine the OutlineRail used to show directly
// from the projection: `overrideToGraph` (row + steps + delegation) plus the mined
// `laneOps` (op counts per step + unmapped extra lanes). Mirrors GraphCanvas's
// `configModel`, so the sidebar outline matches the canvas lane-for-lane.

import { overrideToGraph } from "./graph-build.js";
import { NODE_STEP, NODE_DELEGATION_COORDINATOR, NODE_PREP, NODE_MEMBER, type StepGraphNode } from "./graph-types.js";
import type { WorkflowMetadata, WorkflowOverride } from "../useWorkflowPresentation.js";
import type { LaneOpsModel } from "./lane-build.js";

export interface OutlineEntry {
  id: string;
  label: string;
  /** 1-based step number (numbered chip). Absent for unmapped extra ops lanes. */
  num?: number;
  /** Trailing op count (pipeline lanes only). */
  meta?: string;
}

export interface OutlineModel {
  /** Pipeline lanes — presentation steps + any unmapped ops lanes, in order. */
  steps: OutlineEntry[];
  /** Delegation spine entries (coordinator / OCR prep / member). */
  delegation: OutlineEntry[];
  /** Lane ids (steps + extra lanes) — the collapsible set for "Collapse all". */
  laneIds: string[];
  stepCount: number;
  totalOps: number;
  systemCount: number;
}

const EMPTY: OutlineModel = { steps: [], delegation: [], laneIds: [], stepCount: 0, totalOps: 0, systemCount: 0 };

/** Build the sidebar outline for one workflow from its base metadata, the live
 *  draft override, and the mined lane ops. Returns an empty model when no base. */
export function buildOutlineModel(
  base: WorkflowMetadata | null | undefined,
  draft: WorkflowOverride,
  workflowName: string,
  laneOps: LaneOpsModel,
): OutlineModel {
  if (!base) return EMPTY;
  const projected = overrideToGraph(base, draft, workflowName);

  const steps: OutlineEntry[] = projected.nodes
    .filter((n): n is StepGraphNode => n.type === NODE_STEP)
    .sort((a, b) => a.data.stepIndex - b.data.stepIndex)
    .map((n) => ({
      id: n.id,
      label: n.data.label,
      num: n.data.stepIndex + 1,
      meta: String((laneOps.byStep[n.data.step] ?? []).length),
    }));
  for (const ex of laneOps.extraLanes) {
    steps.push({ id: ex.id, label: ex.label, meta: String(ex.ops.length) });
  }

  const delegation: OutlineEntry[] = [];
  for (const n of projected.nodes) {
    if (n.type === NODE_DELEGATION_COORDINATOR) delegation.push({ id: n.id, label: "Coordinator" });
    else if (n.type === NODE_PREP) delegation.push({ id: n.id, label: "OCR prep" });
    else if (n.type === NODE_MEMBER) delegation.push({ id: n.id, label: "Member" });
  }

  const systems = new Set<string>();
  let totalOps = 0;
  for (const ops of Object.values(laneOps.byStep)) {
    totalOps += ops.length;
    for (const o of ops) if (o.system) systems.add(o.system);
  }
  for (const ex of laneOps.extraLanes) {
    totalOps += ex.ops.length;
    for (const o of ex.ops) if (o.system) systems.add(o.system);
  }

  return {
    steps,
    delegation,
    laneIds: steps.map((s) => s.id),
    stepCount: steps.length,
    totalOps,
    systemCount: systems.size,
  };
}
